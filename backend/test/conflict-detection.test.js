'use strict';

require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const assert = require('node:assert/strict');
const { test } = require('node:test');
const app = require('../app');
const pool = require('../database/pool');

test('Module 8: Conflict Detection (TC36-TC39)', { timeout: 60000 }, async () => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const request = (route, { method = 'GET', body, cookie } = {}) => fetch(`${base}${route}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });

  let cookie;
  const createdEntryIds = [];
  let temporarySlotId = null;
  let concSlotId = null;

  try {
    // 1. Authenticate as Administrator
    const login = await request('/api/auth/login', {
      method: 'POST',
      body: { identifier: 'admin', password: 'admin001' },
    });
    assert.equal(login.status, 200, 'Admin login should succeed');
    cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'Session cookie should be issued');

    // 2. Fetch options for reference data
    const optionsRes = await request('/api/admin/timetable/options', { cookie });
    assert.equal(optionsRes.status, 200);
    const options = await optionsRes.json();

    assert.ok(options.sections.length >= 2, 'At least 2 sections needed for conflict testing');
    assert.ok(options.teachers.length >= 2, 'At least 2 teachers needed for conflict testing');
    assert.ok(options.rooms.length >= 2, 'At least 2 rooms needed for conflict testing');
    assert.ok(options.subjects.length >= 2, 'At least 2 subjects needed for conflict testing');
    assert.ok(options.timeSlots.length >= 2, 'At least 2 time slots needed for conflict testing');

    const secA = options.sections[0];
    const secB = options.sections[1];
    const teacherA = options.teachers[0];
    const teacherB = options.teachers[1];
    const roomA = options.rooms[0];
    const roomB = options.rooms[1];
    const subjectA = options.subjects[0];
    const subjectB = options.subjects[1];

    // Allocate dedicated active working days per test category to guarantee zero cross-case interference
    const dayForTeacher = options.weekdays.find(w => w.id === 2) || options.weekdays[0]; // Tuesday
    const dayForSection = options.weekdays.find(w => w.id === 3) || options.weekdays[1]; // Wednesday
    const dayForRoom = options.weekdays.find(w => w.id === 4) || options.weekdays[2];    // Thursday
    const dayForMisc = options.weekdays.find(w => w.id === 5) || options.weekdays[3];    // Friday

    const slotTS01 = options.timeSlots[0]; // 08:30 - 09:30
    const slotTS02 = options.timeSlots[1]; // 09:35 - 10:35 (non-overlapping)

    // Find non-working day (is_working = 0, e.g. Saturday or Sunday)
    const [nonWorkingDays] = await pool.execute(
      'SELECT id, day_label AS dayLabel FROM working_weekdays WHERE is_working = 0 LIMIT 1'
    );
    assert.ok(nonWorkingDays.length > 0, 'At least one non-working day must exist in working_weekdays');
    const inactiveDay = nonWorkingDays[0];

    // Create a temporary partially-overlapping time slot: 09:00 - 10:00 (overlaps with TS-01 08:30-09:30)
    const [insertedSlot] = await pool.execute(`
      INSERT INTO time_slots (slot_code, start_time, end_time, status)
      VALUES (?, '09:00:00', '10:00:00', 'active')
    `, [`TS-PART-${Date.now().toString().slice(-4)}`]);
    temporarySlotId = insertedSlot.insertId;

    // =========================================================================
    // TC36: Teacher Scheduling Conflict (tested on dayForTeacher)
    // =========================================================================
    // Base entry for TC36: Teacher A on dayForTeacher at TS-01 with Sec A in Room A
    const tc36BaseRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: {
        sectionId: secA.id,
        subjectId: subjectA.id,
        teacherUserId: teacherA.id,
        roomId: roomA.id,
        weekdayId: dayForTeacher.id,
        timeSlotId: slotTS01.id,
      },
    });
    assert.equal(tc36BaseRes.status, 201, 'TC36: Base entry creation should succeed');
    const tc36BaseData = await tc36BaseRes.json();
    createdEntryIds.push(tc36BaseData.id);

    // Scenario 1: Same teacher, different section, same day, IDENTICAL time slot -> 409
    const tc36IdenticalRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: {
        sectionId: secB.id,
        subjectId: subjectB.id,
        teacherUserId: teacherA.id, // SAME teacher
        roomId: roomB.id,          // Different room
        weekdayId: dayForTeacher.id,
        timeSlotId: slotTS01.id,   // IDENTICAL time slot
      },
    });
    assert.equal(tc36IdenticalRes.status, 409, 'TC36: Identical slot teacher conflict must return 409');
    const tc36IdenticalData = await tc36IdenticalRes.json();
    assert.match(tc36IdenticalData.error, /Teacher conflict/i, 'Error message must identify teacher conflict');
    assert.match(tc36IdenticalData.error, new RegExp(teacherA.name, 'i'), 'Error message must contain teacher name');

    // Scenario 2: Same teacher, PARTIALLY OVERLAPPING time slot -> 409
    const tc36PartialRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: {
        sectionId: secB.id,
        subjectId: subjectB.id,
        teacherUserId: teacherA.id, // SAME teacher
        roomId: roomB.id,          // Different room
        weekdayId: dayForTeacher.id,
        timeSlotId: temporarySlotId, // PARTIALLY OVERLAPPING time slot
      },
    });
    assert.equal(tc36PartialRes.status, 409, 'TC36: Partial overlap teacher conflict must return 409');
    const tc36PartialData = await tc36PartialRes.json();
    assert.match(tc36PartialData.error, /Teacher conflict/i, 'Error message must identify teacher conflict');

    // Scenario 3: DIFFERENT teacher at same time slot -> 201
    const tc36NoConflictRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: {
        sectionId: secB.id,
        subjectId: subjectB.id,
        teacherUserId: teacherB.id, // DIFFERENT teacher
        roomId: roomB.id,          // DIFFERENT room
        weekdayId: dayForTeacher.id,
        timeSlotId: slotTS01.id,   // SAME time slot
      },
    });
    assert.equal(tc36NoConflictRes.status, 201, 'TC36: Different teacher with different section and room should succeed');
    const tc36NoConflictData = await tc36NoConflictRes.json();
    createdEntryIds.push(tc36NoConflictData.id);

    // =========================================================================
    // TC37: Class / Section Scheduling Conflict (tested on dayForSection)
    // =========================================================================
    // Base entry for TC37: Sec A on dayForSection at TS-01 with Teacher A in Room A
    const tc37BaseRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: {
        sectionId: secA.id,
        subjectId: subjectA.id,
        teacherUserId: teacherA.id,
        roomId: roomA.id,
        weekdayId: dayForSection.id,
        timeSlotId: slotTS01.id,
      },
    });
    assert.equal(tc37BaseRes.status, 201, 'TC37: Base entry creation should succeed');
    const tc37BaseData = await tc37BaseRes.json();
    createdEntryIds.push(tc37BaseData.id);

    // Scenario 1: Same section (Sec A), different subject, different teacher (Teacher B), different room (Room B), OVERLAPPING slot -> 409
    const tc37ConflictRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: {
        sectionId: secA.id,        // SAME section
        subjectId: subjectB.id,    // Different subject
        teacherUserId: teacherB.id, // Free teacher on dayForSection
        roomId: roomB.id,          // Free room on dayForSection
        weekdayId: dayForSection.id,
        timeSlotId: slotTS01.id,   // OVERLAPPING slot
      },
    });
    assert.equal(tc37ConflictRes.status, 409, 'TC37: Section conflict must return 409');
    const tc37ConflictData = await tc37ConflictRes.json();
    assert.match(tc37ConflictData.error, /Section conflict/i, 'Error message must identify section conflict');
    assert.match(tc37ConflictData.error, new RegExp(secA.sectionName, 'i'), 'Error message must contain section name');

    // Scenario 2: Same section (Sec A) with NON-OVERLAPPING time slot (TS-02) -> 201
    const tc37NoConflictRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: {
        sectionId: secA.id,        // SAME section
        subjectId: subjectB.id,    // Different subject
        teacherUserId: teacherB.id, // Teacher B
        roomId: roomA.id,          // Room A
        weekdayId: dayForSection.id,
        timeSlotId: slotTS02.id,   // NON-OVERLAPPING slot (TS-02)
      },
    });
    assert.equal(tc37NoConflictRes.status, 201, 'TC37: Same section with non-overlapping time slot should succeed');
    const tc37NoConflictData = await tc37NoConflictRes.json();
    createdEntryIds.push(tc37NoConflictData.id);

    // =========================================================================
    // TC38: Classroom / Lab Allocation Conflict (tested on dayForRoom)
    // =========================================================================
    // Base entry for TC38: Room A allocated on dayForRoom at TS-01 with Sec A & Teacher A
    const tc38BaseRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: {
        sectionId: secA.id,
        subjectId: subjectA.id,
        teacherUserId: teacherA.id,
        roomId: roomA.id,
        weekdayId: dayForRoom.id,
        timeSlotId: slotTS01.id,
      },
    });
    assert.equal(tc38BaseRes.status, 201, 'TC38: Base entry creation should succeed');
    const tc38BaseData = await tc38BaseRes.json();
    createdEntryIds.push(tc38BaseData.id);

    // Scenario 1: Same room (Room A) allocated to different section (Sec B) with different teacher (Teacher B) during TS-01 -> 409
    const tc38ConflictRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: {
        sectionId: secB.id,        // Free section
        subjectId: subjectB.id,
        teacherUserId: teacherB.id, // Free teacher
        roomId: roomA.id,          // SAME room
        weekdayId: dayForRoom.id,
        timeSlotId: slotTS01.id,   // SAME slot
      },
    });
    assert.equal(tc38ConflictRes.status, 409, 'TC38: Room allocation conflict must return 409');
    const tc38ConflictData = await tc38ConflictRes.json();
    assert.match(tc38ConflictData.error, /Room allocation conflict/i, 'Error message must identify room conflict');
    assert.match(tc38ConflictData.error, new RegExp(roomA.roomNumber, 'i'), 'Error message must contain room number');

    // Scenario 2: Different room allocated without conflict -> 201
    const tc38NoConflictRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: {
        sectionId: secB.id,
        subjectId: subjectB.id,
        teacherUserId: teacherB.id,
        roomId: roomB.id,          // DIFFERENT room
        weekdayId: dayForRoom.id,
        timeSlotId: slotTS01.id,   // TS-01
      },
    });
    assert.equal(tc38NoConflictRes.status, 201, 'TC38: Different room without conflict should succeed');
    const tc38NoConflictData = await tc38NoConflictRes.json();
    createdEntryIds.push(tc38NoConflictData.id);

    // =========================================================================
    // TC39: Non-Working Day Validation
    // =========================================================================
    // Scenario 1: Reject scheduling on an inactive day (is_working = 0) -> 400
    const tc39InactiveRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: {
        sectionId: secA.id,
        subjectId: subjectA.id,
        teacherUserId: teacherA.id,
        roomId: roomA.id,
        weekdayId: inactiveDay.id, // INACTIVE day
        timeSlotId: slotTS01.id,
      },
    });
    assert.equal(tc39InactiveRes.status, 400, 'TC39: Inactive day must return 400 Bad Request');
    const tc39InactiveData = await tc39InactiveRes.json();
    assert.match(tc39InactiveData.error, /Non-working day error/i, 'Error message must identify non-working day');
    assert.match(tc39InactiveData.error, new RegExp(inactiveDay.dayLabel, 'i'), 'Error message must contain day label');

    // Scenario 2: Scheduling on an active working day succeeds -> 201
    assert.ok(tc36BaseData.id, 'TC39: Scheduling on active working day succeeded in base entry');

    // =========================================================================
    // Edit / Update Tests (tested on dayForMisc)
    // =========================================================================
    const miscBaseRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: {
        sectionId: secA.id,
        subjectId: subjectA.id,
        teacherUserId: teacherA.id,
        roomId: roomA.id,
        weekdayId: dayForMisc.id,
        timeSlotId: slotTS01.id,
      },
    });
    assert.equal(miscBaseRes.status, 201);
    const miscBaseData = await miscBaseRes.json();
    createdEntryIds.push(miscBaseData.id);

    // Scenario 1: Editing existing entry without modifying slot/teacher/room (excludes self) -> 200
    const editSelfRes = await request(`/api/admin/timetable/${miscBaseData.id}`, {
      method: 'PUT',
      cookie,
      body: {
        sectionId: secA.id,
        subjectId: subjectB.id, // Only changing subject
        teacherUserId: teacherA.id,
        roomId: roomA.id,
        weekdayId: dayForMisc.id,
        timeSlotId: slotTS01.id,
      },
    });
    assert.equal(editSelfRes.status, 200, 'Editing existing entry should not trigger false conflict with itself');

    // Scenario 2: Create a second entry on dayForMisc at TS-02, then edit it to collide with TS-01 -> 409
    const secondEntryRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: {
        sectionId: secB.id,
        subjectId: subjectB.id,
        teacherUserId: teacherB.id,
        roomId: roomB.id,
        weekdayId: dayForMisc.id,
        timeSlotId: slotTS02.id,
      },
    });
    assert.equal(secondEntryRes.status, 201);
    const secondEntryData = await secondEntryRes.json();
    createdEntryIds.push(secondEntryData.id);

    const editConflictRes = await request(`/api/admin/timetable/${secondEntryData.id}`, {
      method: 'PUT',
      cookie,
      body: {
        sectionId: secB.id,
        subjectId: subjectB.id,
        teacherUserId: teacherA.id, // Collides with miscBase (teacherA already on dayForMisc TS-01)
        roomId: roomB.id,
        weekdayId: dayForMisc.id,
        timeSlotId: slotTS01.id,   // Collides with miscBase TS-01
      },
    });
    assert.equal(editConflictRes.status, 409, 'Editing to collide with another entry must return 409');
    const editConflictData = await editConflictRes.json();
    assert.match(editConflictData.error, /Teacher conflict/i);

    // =========================================================================
    // Concurrency & Simultaneous Scheduling Requests Test:
    // Fire two simultaneous POST requests trying to book the same teacher
    // at the same time slot concurrently.
    // Exactly one must succeed (201) and the other must be rejected (409).
    // =========================================================================
    const [concurrentSlot] = await pool.execute(`
      INSERT INTO time_slots (slot_code, start_time, end_time, status)
      VALUES (?, '17:00:00', '18:00:00', 'active')
    `, [`TS-CONC-${Date.now().toString().slice(-4)}`]);
    concSlotId = concurrentSlot.insertId;

    const req1 = request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: {
        sectionId: secA.id,
        subjectId: subjectA.id,
        teacherUserId: teacherA.id,
        roomId: roomA.id,
        weekdayId: dayForMisc.id,
        timeSlotId: concSlotId,
      },
    });

    const req2 = request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: {
        sectionId: secB.id,
        subjectId: subjectB.id,
        teacherUserId: teacherA.id, // Same teacher simultaneously
        roomId: roomB.id,
        weekdayId: dayForMisc.id,
        timeSlotId: concSlotId,
      },
    });

    const [res1, res2] = await Promise.all([req1, req2]);
    const d1 = await res1.json().catch(() => ({}));
    const d2 = await res2.json().catch(() => ({}));
    if (d1.id) createdEntryIds.push(d1.id);
    if (d2.id) createdEntryIds.push(d2.id);

    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(statuses, [201, 409], 'Concurrent requests must serialize: exactly one 201, one 409');

  } finally {
    // Clean up created timetable entries
    if (createdEntryIds.length > 0) {
      await pool.execute(
        `DELETE FROM timetable_entries WHERE id IN (${createdEntryIds.map(() => '?').join(',')})`,
        createdEntryIds
      );
    }
    // Clean up temporary time slots
    if (temporarySlotId) {
      await pool.execute('DELETE FROM time_slots WHERE id = ?', [temporarySlotId]);
    }
    if (concSlotId) {
      await pool.execute('DELETE FROM time_slots WHERE id = ?', [concSlotId]);
    }
    await pool.execute("DELETE FROM time_slots WHERE slot_code LIKE 'TS-CONC%' OR slot_code LIKE 'TS-PART%'");

    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
