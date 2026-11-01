'use strict';

require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const assert = require('node:assert/strict');
const { test } = require('node:test');
const app = require('../app');
const pool = require('../database/pool');

test('Module 10: Notification and Rescheduling (TC45–TC49)', { timeout: 60000 }, async () => {
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

  const createdEntryIds = [];
  const modifiedPermissionsTeacherIds = [];
  let originalStudentSectionId = null;
  let testStudentUserId = null;

  try {
    // 1. Authenticate as Administrator
    const adminLogin = await request('/api/auth/login', {
      method: 'POST',
      body: { identifier: 'admin', password: 'admin001' },
    });
    assert.equal(adminLogin.status, 200);
    const adminCookie = adminLogin.headers.get('set-cookie')?.split(';')[0];
    assert.ok(adminCookie);

    // 2. Fetch options
    const optionsRes = await request('/api/admin/timetable/options', { cookie: adminCookie });
    assert.equal(optionsRes.status, 200);
    const options = await optionsRes.json();

    const secA = options.sections[0];
    const secB = options.sections[1] || options.sections[0];
    const teacherA = options.teachers.find(t => t.id === 2) || options.teachers[0]; // user id 2 has login 'Teacher'
    const teacherB = options.teachers.find(t => t.id !== teacherA.id) || options.teachers[1];
    const roomA = options.rooms[0];
    const roomB = options.rooms[1] || options.rooms[0];
    const subjectA = options.subjects[0];
    const subjectB = options.subjects[1] || options.subjects[0];

    // Pick days & slots for testing
    const [workingWeekdays] = await pool.execute('SELECT * FROM working_weekdays WHERE is_working = 1 ORDER BY day_order');
    const dayWed = workingWeekdays.find(w => w.day_key === 'wednesday') || workingWeekdays[1];
    const dayThu = workingWeekdays.find(w => w.day_key === 'thursday') || workingWeekdays[2];
    const dayFri = workingWeekdays.find(w => w.day_key === 'friday') || workingWeekdays[3];

    const [inactiveWeekdays] = await pool.execute('SELECT * FROM working_weekdays WHERE is_working = 0 LIMIT 1');
    const nonWorkingDay = inactiveWeekdays[0] || { id: 6, day_label: 'Saturday' };

    const slotTS02 = options.timeSlots.find(s => s.slotCode === 'TS-02') || options.timeSlots[1];
    const slotTS03 = options.timeSlots.find(s => s.slotCode === 'TS-03') || options.timeSlots[2];
    const slotTS04 = options.timeSlots.find(s => s.slotCode === 'TS-04') || options.timeSlots[3];

    // 3. Authenticate Teacher A
    const teacherLogin = await request('/api/auth/login', {
      method: 'POST',
      body: { identifier: 'Teacher', password: 'teacher123' },
    });
    assert.equal(teacherLogin.status, 200, 'Teacher A login should succeed');
    const teacherCookie = teacherLogin.headers.get('set-cookie')?.split(';')[0];
    assert.ok(teacherCookie);

    // 4. Authenticate Student
    const [students] = await pool.execute("SELECT u.id, u.login_id FROM users u WHERE u.role = 'student' LIMIT 1");
    assert.ok(students.length > 0, 'Student user must exist');
    testStudentUserId = students[0].id;

    const [studentProfile] = await pool.execute('SELECT section_id FROM student_profiles WHERE user_id = ?', [testStudentUserId]);
    originalStudentSectionId = studentProfile[0]?.section_id || null;

    // Place student in secA for verification
    await pool.execute('UPDATE student_profiles SET section_id = ? WHERE user_id = ?', [secA.id, testStudentUserId]);

    const studentLogin = await request('/api/auth/login', {
      method: 'POST',
      body: { identifier: students[0].login_id, password: students[0].login_id === 'Nikhil' ? 'nik001' : 'student123' },
    });
    assert.equal(studentLogin.status, 200);
    const studentCookie = studentLogin.headers.get('set-cookie')?.split(';')[0];
    assert.ok(studentCookie);

    // Seed Initial Base Entry: Teacher A, Section A, Subject A, Room A on Wednesday TS-02
    const baseEntryRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        sectionId: secA.id,
        subjectId: subjectA.id,
        teacherUserId: teacherA.id,
        roomId: roomA.id,
        weekdayId: dayWed.id,
        timeSlotId: slotTS02.id,
      },
    });
    assert.equal(baseEntryRes.status, 201, 'Base timetable entry creation should succeed');
    const baseEntryData = await baseEntryRes.json();
    const entryId = baseEntryData.id;
    createdEntryIds.push(entryId);

    // =========================================================================
    // TC45: Administrator Rescheduling
    // =========================================================================
    // Admin reschedules class: change Day (Wed -> Thu), Slot (TS-02 -> TS-03), and Room (Room A -> Room B)
    const adminRescheduleRes = await request(`/api/admin/timetable/${entryId}/reschedule`, {
      method: 'PUT',
      cookie: adminCookie,
      body: {
        sectionId: secA.id,
        subjectId: subjectA.id,
        teacherUserId: teacherA.id,
        roomId: roomB.id,
        weekdayId: dayThu.id,
        timeSlotId: slotTS03.id,
        reason: 'Laboratory upgrade and room maintenance',
      },
    });
    assert.equal(adminRescheduleRes.status, 200, 'Admin rescheduling should return 200 OK');
    const adminRescheduleData = await adminRescheduleRes.json();
    assert.match(adminRescheduleData.message, /Updated timetable details are saved/i);

    // Verify database record has updated values
    const [updatedRows] = await pool.execute('SELECT weekday_id, time_slot_id, room_id FROM timetable_entries WHERE id = ?', [entryId]);
    assert.equal(updatedRows[0].weekday_id, dayThu.id, 'Entry day should be updated to Thursday');
    assert.equal(updatedRows[0].time_slot_id, slotTS03.id, 'Entry time slot should be updated to TS-03');
    assert.equal(updatedRows[0].room_id, roomB.id, 'Entry room should be updated to Room B');

    // =========================================================================
    // TC46: Authorized Teacher Rescheduling
    // =========================================================================
    // Step A: Teacher A is currently UNAUTHORIZED by default
    await pool.execute('DELETE FROM teacher_rescheduling_authorizations WHERE user_id = ?', [teacherA.id]);

    const unauthorizedTeacherRes = await request(`/api/teacher/timetable/${entryId}/reschedule`, {
      method: 'PUT',
      cookie: teacherCookie,
      body: {
        weekdayId: dayFri.id,
        timeSlotId: slotTS04.id,
        roomId: roomA.id,
        reason: 'Unauthorized attempt',
      },
    });
    assert.equal(
      unauthorizedTeacherRes.status,
      403,
      'Unauthorized teacher rescheduling attempt must return 403 Forbidden'
    );
    const unauthData = await unauthorizedTeacherRes.json();
    assert.match(unauthData.error, /do not have permission/i);

    // Step B: Admin explicitly grants rescheduling authorization to Teacher A
    const grantPermRes = await request(`/api/admin/timetable/permissions/teachers/${teacherA.id}`, {
      method: 'POST',
      cookie: adminCookie,
      body: { isAuthorized: true, notes: 'Granted for semester project coordination' },
    });
    assert.equal(grantPermRes.status, 200);
    modifiedPermissionsTeacherIds.push(teacherA.id);

    // Verify teacher permission endpoint confirms authorization
    const teacherPermRes = await request('/api/teacher/timetable/rescheduling-permission', {
      cookie: teacherCookie,
    });
    assert.equal(teacherPermRes.status, 200);
    const permData = await teacherPermRes.json();
    assert.equal(permData.isAuthorized, true);

    // Step C: Authorized Teacher A successfully reschedules their own class
    const teacherRescheduleRes = await request(`/api/teacher/timetable/${entryId}/reschedule`, {
      method: 'PUT',
      cookie: teacherCookie,
      body: {
        weekdayId: dayFri.id,
        timeSlotId: slotTS04.id,
        roomId: roomA.id,
        reason: 'Shifted to Friday for hands-on programming workshop',
      },
    });
    assert.equal(teacherRescheduleRes.status, 200, 'Authorized teacher should successfully reschedule their own class');
    const teacherResData = await teacherRescheduleRes.json();
    assert.match(teacherResData.message, /rescheduled successfully/i);

    // Verify in database that Teacher A's update was committed
    const [teacherUpdatedRows] = await pool.execute('SELECT weekday_id, time_slot_id, room_id FROM timetable_entries WHERE id = ?', [entryId]);
    assert.equal(teacherUpdatedRows[0].weekday_id, dayFri.id);
    assert.equal(teacherUpdatedRows[0].time_slot_id, slotTS04.id);
    assert.equal(teacherUpdatedRows[0].room_id, roomA.id);

    // Step D: Teacher attempts to reschedule another teacher's class
    // Seed entry belonging to Teacher B
    const teacherBEntryRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        sectionId: secB.id,
        subjectId: subjectB.id,
        teacherUserId: teacherB.id,
        roomId: roomB.id,
        weekdayId: dayFri.id,
        timeSlotId: slotTS02.id,
      },
    });
    assert.equal(teacherBEntryRes.status, 201);
    const teacherBEntryData = await teacherBEntryRes.json();
    createdEntryIds.push(teacherBEntryData.id);

    // Teacher A tries to reschedule Teacher B's class
    const tamperClassRes = await request(`/api/teacher/timetable/${teacherBEntryData.id}/reschedule`, {
      method: 'PUT',
      cookie: teacherCookie,
      body: {
        weekdayId: dayFri.id,
        timeSlotId: slotTS03.id,
      },
    });
    assert.equal(
      tamperClassRes.status,
      403,
      'Teacher attempting to modify another teacher class must return 403 Forbidden'
    );
    const tamperData = await tamperClassRes.json();
    assert.match(tamperData.error, /only reschedule your own assigned classes/i);

    // =========================================================================
    // TC47: Conflict Detection During Rescheduling
    // =========================================================================
    // 1. Rescheduling creates a Teacher conflict
    // Attempt to reschedule Teacher A's class to overlap with another hypothetical booking
    // Let's seed a second class for Teacher A on Wednesday TS-03
    const teacherAWedRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        sectionId: secB.id,
        subjectId: subjectB.id,
        teacherUserId: teacherA.id,
        roomId: roomB.id,
        weekdayId: dayWed.id,
        timeSlotId: slotTS03.id,
      },
    });
    assert.equal(teacherAWedRes.status, 201);
    const teacherAWedData = await teacherAWedRes.json();
    createdEntryIds.push(teacherAWedData.id);

    // Now try to reschedule base entry (entryId) to Wednesday TS-03 -> Must trigger Teacher Conflict!
    const conflictTeacherRes = await request(`/api/teacher/timetable/${entryId}/reschedule`, {
      method: 'PUT',
      cookie: teacherCookie,
      body: {
        weekdayId: dayWed.id,
        timeSlotId: slotTS03.id,
        roomId: roomA.id,
      },
    });
    assert.equal(conflictTeacherRes.status, 409, 'Teacher conflict must return 409 Conflict');
    const conflictTeacherData = await conflictTeacherRes.json();
    assert.match(conflictTeacherData.error, /Teacher conflict/i);

    // 2. Rescheduling creates a Room conflict
    // Teacher B is using Room B on Friday TS-02. Try to reschedule base entry to Room B on Friday TS-02 -> Must trigger Room Conflict!
    const conflictRoomRes = await request(`/api/teacher/timetable/${entryId}/reschedule`, {
      method: 'PUT',
      cookie: teacherCookie,
      body: {
        weekdayId: dayFri.id,
        timeSlotId: slotTS02.id,
        roomId: roomB.id,
      },
    });
    assert.equal(conflictRoomRes.status, 409, 'Room conflict must return 409 Conflict');
    const conflictRoomData = await conflictRoomRes.json();
    assert.match(conflictRoomData.error, /Room allocation conflict/i);

    // 3. Rescheduling creates a Section conflict
    // Base entry is for Section A. Let's create another entry for Section A on Thursday TS-02.
    const secAThuRes = await request('/api/admin/timetable', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        sectionId: secA.id,
        subjectId: subjectB.id,
        teacherUserId: teacherB.id,
        roomId: roomA.id,
        weekdayId: dayThu.id,
        timeSlotId: slotTS02.id,
      },
    });
    assert.equal(secAThuRes.status, 201);
    const secAThuData = await secAThuRes.json();
    createdEntryIds.push(secAThuData.id);

    // Try to reschedule base entry to Thursday TS-02 -> Must trigger Section Conflict!
    const conflictSectionRes = await request(`/api/teacher/timetable/${entryId}/reschedule`, {
      method: 'PUT',
      cookie: teacherCookie,
      body: {
        weekdayId: dayThu.id,
        timeSlotId: slotTS02.id,
        roomId: roomB.id,
      },
    });
    assert.equal(conflictSectionRes.status, 409, 'Section conflict must return 409 Conflict');
    const conflictSectionData = await conflictSectionRes.json();
    assert.match(conflictSectionData.error, /Section conflict/i);

    // 4. Rescheduling to a non-working day (TC39)
    const nonWorkingRescheduleRes = await request(`/api/admin/timetable/${entryId}/reschedule`, {
      method: 'PUT',
      cookie: adminCookie,
      body: {
        sectionId: secA.id,
        subjectId: subjectA.id,
        teacherUserId: teacherA.id,
        roomId: roomA.id,
        weekdayId: nonWorkingDay.id,
        timeSlotId: slotTS02.id,
      },
    });
    assert.equal(nonWorkingRescheduleRes.status, 400, 'Non-working day reschedule must return 400 Bad Request');
    const nonWorkingData = await nonWorkingRescheduleRes.json();
    assert.match(nonWorkingData.error, /Non-working day error/i);

    // 5. Verify failed rescheduling preserves original timetable entry
    const [preservedRows] = await pool.execute('SELECT weekday_id, time_slot_id, room_id FROM timetable_entries WHERE id = ?', [entryId]);
    assert.equal(preservedRows[0].weekday_id, dayFri.id, 'Original timetable day must remain unchanged after rejected attempts');
    assert.equal(preservedRows[0].time_slot_id, slotTS04.id, 'Original time slot must remain unchanged');
    assert.equal(preservedRows[0].room_id, roomA.id, 'Original room must remain unchanged');

    // =========================================================================
    // TC48: Notifications & Rescheduling History (Change Logs)
    // =========================================================================
    // Verify change log table recorded the previous successful reschedules
    const [changeLogs] = await pool.execute(
      'SELECT * FROM timetable_change_logs WHERE timetable_entry_id = ? ORDER BY id DESC',
      [entryId]
    );
    assert.ok(changeLogs.length >= 2, 'Timetable change logs must record every successful reschedule');

    const latestLog = changeLogs[0];
    assert.equal(latestLog.action_type, 'reschedule');
    assert.equal(latestLog.new_weekday_id, dayFri.id);
    assert.equal(latestLog.new_time_slot_id, slotTS04.id);
    assert.equal(latestLog.new_room_id, roomA.id);
    assert.match(latestLog.reason, /hands-on programming workshop/i);

    // Check API endpoint for change logs
    const adminLogsRes = await request(`/api/admin/timetable/change-logs?entryId=${entryId}`, {
      cookie: adminCookie,
    });
    assert.equal(adminLogsRes.status, 200);
    const adminLogsData = await adminLogsRes.json();
    assert.ok(adminLogsData.logs.length >= 2);
    assert.equal(adminLogsData.logs[0].timetableEntryId, entryId);

    // =========================================================================
    // TC49: Download and Print Updated Timetable Across All Dashboards
    // =========================================================================
    // 1. Updated schedule appears in Admin timetable API
    const adminCheckRes = await request(`/api/admin/timetable?teacherId=${teacherA.id}&weekdayId=${dayFri.id}`, {
      cookie: adminCookie,
    });
    assert.equal(adminCheckRes.status, 200);
    const adminCheckData = await adminCheckRes.json();
    const adminFound = adminCheckData.entries.find(e => e.id === entryId);
    assert.ok(adminFound, 'Updated schedule must be immediately visible to Administrator');
    assert.equal(adminFound.weekdayId, dayFri.id);
    assert.equal(adminFound.timeSlotId, slotTS04.id);

    // 2. Updated schedule appears in Teacher timetable API
    const teacherCheckRes = await request(`/api/teacher/timetable?weekdayId=${dayFri.id}`, {
      cookie: teacherCookie,
    });
    assert.equal(teacherCheckRes.status, 200);
    const teacherCheckData = await teacherCheckRes.json();
    const teacherFound = teacherCheckData.entries.find(e => e.id === entryId);
    assert.ok(teacherFound, 'Updated schedule must be immediately visible to Teacher');
    assert.equal(teacherFound.weekdayId, dayFri.id);

    // 3. Updated schedule appears in Student timetable API
    const studentCheckRes = await request('/api/student/timetable', {
      cookie: studentCookie,
    });
    assert.equal(studentCheckRes.status, 200);
    const studentCheckData = await studentCheckRes.json();
    const studentFound = studentCheckData.entries.find(e => e.id === entryId);
    assert.ok(studentFound, 'Updated schedule must be immediately visible to enrolled Students in Section A');
    assert.equal(studentFound.weekdayId, dayFri.id);

    // 4. CSV Exports reflect updated schedule
    const adminCsvRes = await request(`/api/admin/timetable/export?teacherId=${teacherA.id}`, {
      cookie: adminCookie,
    });
    assert.equal(adminCsvRes.status, 200);
    const adminCsv = await adminCsvRes.text();
    assert.match(adminCsv, /Friday/i, 'Admin CSV export must include Friday after reschedule');

    const teacherCsvRes = await request('/api/teacher/timetable/export', {
      cookie: teacherCookie,
    });
    assert.equal(teacherCsvRes.status, 200);
    const teacherCsv = await teacherCsvRes.text();
    assert.match(teacherCsv, /Friday/i, 'Teacher CSV export must include Friday after reschedule');

    const studentCsvRes = await request('/api/student/timetable/export', {
      cookie: studentCookie,
    });
    assert.equal(studentCsvRes.status, 200);
    const studentCsv = await studentCsvRes.text();
    assert.match(studentCsv, /Friday/i, 'Student CSV export must include Friday after reschedule');

  } finally {
    // Clean up created timetable entries
    if (createdEntryIds.length) {
      await pool.execute(
        `DELETE FROM timetable_entries WHERE id IN (${createdEntryIds.map(() => '?').join(',')})`,
        createdEntryIds
      );
    }

    // Clean up modified permissions
    if (modifiedPermissionsTeacherIds.length) {
      await pool.execute(
        `DELETE FROM teacher_rescheduling_authorizations WHERE user_id IN (${modifiedPermissionsTeacherIds.map(() => '?').join(',')})`,
        modifiedPermissionsTeacherIds
      );
    }

    // Restore student profile section
    if (testStudentUserId) {
      await pool.execute(
        'UPDATE student_profiles SET section_id = ? WHERE user_id = ?',
        [originalStudentSectionId, testStudentUserId]
      );
    }

    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});

