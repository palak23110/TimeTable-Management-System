'use strict';

require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const assert = require('node:assert/strict');
const { test } = require('node:test');
const app = require('../app');
const pool = require('../database/pool');

test('Module 7: Timetable creation, editing, database verification, validation, and duplicate prevention (TC31-TC35)', { timeout: 60000 }, async () => {
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
  let temporarySubjectId = null;

  try {
    // 1. Authenticate as Administrator
    const login = await request('/api/auth/login', {
      method: 'POST',
      body: { identifier: 'admin', password: 'admin001' },
    });
    assert.equal(login.status, 200, 'Admin login should succeed');
    cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'Session cookie should be issued');

    // 2. Unauthenticated access check to /admin/timetable
    const unauth = await request('/admin/timetable');
    assert.equal(unauth.status, 302, 'Unauthenticated timetable access must redirect to /login');
    assert.equal(unauth.headers.get('location'), '/login');

    // 3. Authenticated page access check
    const page = await request('/admin/timetable', { cookie });
    assert.equal(page.status, 200, '/admin/timetable HTML must load with 200 OK');
    const html = await page.text();
    assert.match(html, /Timetable Management/);
    assert.match(html, /data-open-timetable/);
    assert.match(html, /data-timetable-rows/);

    // 4. Ensure at least one test subject exists
    const [existingSubjects] = await pool.execute('SELECT id, subject_code AS code, subject_name AS name FROM subjects WHERE is_active = 1 LIMIT 1');
    let validSubject;
    if (existingSubjects.length > 0) {
      validSubject = existingSubjects[0];
    } else {
      const [insertedSub] = await pool.execute(
        'INSERT INTO subjects (subject_code, subject_name, is_active) VALUES (?, ?, 1)',
        [`TC-SUB-${Date.now().toString().slice(-6)}`, 'Data Structures & Algorithms']
      );
      temporarySubjectId = insertedSub.insertId;
      validSubject = { id: insertedSub.insertId, code: 'DSA101', name: 'Data Structures & Algorithms' };
    }

    // 5. Fetch options to get valid scheduling references
    const optionsRes = await request('/api/admin/timetable/options', { cookie });
    assert.equal(optionsRes.status, 200);
    const options = await optionsRes.json();
    assert.ok(options.sections.length > 0, 'Sections must exist');
    assert.ok(options.subjects.length > 0, 'Subjects must exist in options');
    assert.ok(options.teachers.length > 0, 'Teachers must exist');
    assert.ok(options.rooms.length > 0, 'Rooms must exist');
    assert.ok(options.weekdays.length > 0, 'Working weekdays must exist');
    assert.ok(options.timeSlots.length > 0, 'Time slots must exist');

    const validSection = options.sections[0];
    const validTeacher = options.teachers[0];
    const validRoom = options.rooms[0];
    const validDay = options.weekdays.find(w => w.dayKey === 'friday') || options.weekdays[4] || options.weekdays[0];
    const validSlot = options.timeSlots.find(s => s.slotCode === 'TS-03') || options.timeSlots[2] || options.timeSlots[0];
    const secondSlot = options.timeSlots.find(s => s.slotCode === 'TS-04') || options.timeSlots[3] || options.timeSlots[1];

    // =========================================================================
    // TC31: Create a timetable
    // Input: Valid details (Class, Section, Subject, Teacher, Room, Day and Time Slot)
    // Expected Output: Timetable is created and saved successfully (201 Created)
    // =========================================================================
    const tc31Input = {
      sectionId: validSection.id,
      subjectId: validSubject.id,
      teacherUserId: validTeacher.id,
      roomId: validRoom.id,
      weekdayId: validDay.id,
      timeSlotId: validSlot.id,
    };

    const tc31Response = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: tc31Input,
    });
    assert.equal(tc31Response.status, 201, 'TC31: Should return 201 Created for valid timetable details');
    const tc31Data = await tc31Response.json();
    assert.ok(tc31Data.id, 'TC31: Response should include created record ID');
    assert.match(tc31Data.message, /created and saved successfully/i, 'TC31: Response message should confirm success');
    createdEntryIds.push(tc31Data.id);

    // Verify record is retrievable via GET /api/admin/timetable/:id
    const fetchCreated = await request(`/api/admin/timetable/${tc31Data.id}`, { cookie });
    assert.equal(fetchCreated.status, 200, 'TC31: Created record should be retrievable');
    const fetchCreatedData = await fetchCreated.json();
    assert.equal(fetchCreatedData.entry.sectionId, validSection.id);
    assert.equal(fetchCreatedData.entry.subjectId, validSubject.id);
    assert.equal(fetchCreatedData.entry.teacherUserId, validTeacher.id);
    assert.equal(fetchCreatedData.entry.roomId, validRoom.id);
    assert.equal(fetchCreatedData.entry.weekdayId, validDay.id);
    assert.equal(fetchCreatedData.entry.timeSlotId, validSlot.id);

    // =========================================================================
    // TC32: Edit and update an existing timetable
    // Input: Existing timetable record and modified scheduling details
    // Expected Output: Updated timetable details are saved and displayed successfully (200 OK)
    // =========================================================================
    const modifiedInput = {
      sectionId: validSection.id,
      subjectId: validSubject.id,
      teacherUserId: validTeacher.id,
      roomId: validRoom.id,
      weekdayId: validDay.id,
      timeSlotId: secondSlot.id, // Changed time slot
    };

    const tc32Response = await request(`/api/admin/timetable/${tc31Data.id}`, {
      method: 'PUT',
      cookie,
      body: modifiedInput,
    });
    assert.equal(tc32Response.status, 200, 'TC32: Should return 200 OK for valid modified scheduling details');
    const tc32Data = await tc32Response.json();
    assert.match(tc32Data.message, /updated timetable details are saved and displayed successfully/i);

    // =========================================================================
    // TC33: Verify updated timetable is stored in the database
    // Input: Existing timetable record with modified scheduling details
    // Expected Output: Updated timetable is saved in the central database and the previous details are replaced
    // =========================================================================
    const [dbRows] = await pool.execute(
      'SELECT id, section_id AS sectionId, subject_id AS subjectId, teacher_user_id AS teacherUserId, room_id AS roomId, weekday_id AS weekdayId, time_slot_id AS timeSlotId FROM timetable_entries WHERE id = ?',
      [tc31Data.id]
    );
    assert.equal(dbRows.length, 1, 'TC33: Exactly one record should exist in the database');
    const stored = dbRows[0];
    assert.equal(stored.sectionId, validSection.id);
    assert.equal(stored.timeSlotId, secondSlot.id, 'TC33: Previous details must be replaced by new details in the database');

    // =========================================================================
    // TC34: Validate incomplete or invalid timetable details
    // Input: Missing required fields or invalid scheduling information
    // Expected Output: Timetable is not saved and an appropriate error message is displayed (400 Bad Request)
    // =========================================================================
    // Case 1: Missing sectionId
    const missingSection = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: { ...tc31Input, sectionId: '' },
    });
    assert.equal(missingSection.status, 400, 'TC34: Missing section must return 400');
    assert.match((await missingSection.json()).error, /select a valid class\/section/i);

    // Case 2: Missing subjectId
    const missingSubject = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: { ...tc31Input, subjectId: null },
    });
    assert.equal(missingSubject.status, 400, 'TC34: Missing subject must return 400');
    assert.match((await missingSubject.json()).error, /select a valid subject/i);

    // Case 3: Missing teacherUserId
    const missingTeacher = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: { ...tc31Input, teacherUserId: undefined },
    });
    assert.equal(missingTeacher.status, 400, 'TC34: Missing teacher must return 400');
    assert.match((await missingTeacher.json()).error, /select a valid teacher/i);

    // Case 4: Non-existent / invalid room ID
    const invalidRoom = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: { ...tc31Input, roomId: 99999999 },
    });
    assert.equal(invalidRoom.status, 400, 'TC34: Non-existent room must return 400');
    assert.match((await invalidRoom.json()).error, /selected room is invalid or unavailable/i);

    // =========================================================================
    // TC35: Prevent duplicate timetable entries
    // Input: Existing timetable entry with the same Class, Section, Subject, Teacher, Day and Time Slot
    // Expected Output: Duplicate timetable entry is rejected and an appropriate error message is displayed (409 Conflict)
    // =========================================================================
    // Currently in DB, record tc31Data.id has:
    // sectionId = validSection.id, subjectId = validSubject.id, teacherUserId = validTeacher.id, weekdayId = validDay.id, timeSlotId = secondSlot.id
    const duplicateInput = {
      sectionId: validSection.id,
      subjectId: validSubject.id,
      teacherUserId: validTeacher.id,
      roomId: validRoom.id,
      weekdayId: validDay.id,
      timeSlotId: secondSlot.id,
    };

    const tc35Response = await request('/api/admin/timetable', {
      method: 'POST',
      cookie,
      body: duplicateInput,
    });
    assert.equal(tc35Response.status, 409, 'TC35: Duplicate entry must be rejected with HTTP 409 Conflict');
    const tc35Data = await tc35Response.json();
    assert.match(
      tc35Data.error,
      /duplicate timetable entry already exists with the same Class, Section, Subject, Teacher, Day and Time Slot/i,
      'TC35: Should display appropriate duplicate error message'
    );
  } finally {
    // Clean up created test entries and temporary subject
    if (createdEntryIds.length) {
      await pool.execute(
        `DELETE FROM timetable_entries WHERE id IN (${createdEntryIds.map(() => '?').join(',')})`,
        createdEntryIds
      );
    }
    if (temporarySubjectId) {
      await pool.execute('DELETE FROM subjects WHERE id = ?', [temporarySubjectId]);
    }
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
