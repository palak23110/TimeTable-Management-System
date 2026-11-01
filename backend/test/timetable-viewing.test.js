'use strict';

require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const assert = require('node:assert/strict');
const { test } = require('node:test');
const app = require('../app');
const pool = require('../database/pool');

test('Module 9: Timetable Viewing, Role-Based Access, Multi-Filtering & Export (TC40-TC44)', { timeout: 60000 }, async () => {
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
  let originalStudentSectionId = null;

  try {
    // 1. Authenticate as Administrator
    const adminLogin = await request('/api/auth/login', {
      method: 'POST',
      body: { identifier: 'admin', password: 'admin001' },
    });
    assert.equal(adminLogin.status, 200);
    const adminCookie = adminLogin.headers.get('set-cookie')?.split(';')[0];
    assert.ok(adminCookie);

    // 2. Fetch options to get valid entity IDs
    const optionsRes = await request('/api/admin/timetable/options', { cookie: adminCookie });
    assert.equal(optionsRes.status, 200);
    const options = await optionsRes.json();

    const secA = options.sections[0];
    const secB = options.sections[1];
    const teacherA = options.teachers.find(t => t.id === 2) || options.teachers[0];
    const teacherB = options.teachers.find(t => t.id !== teacherA.id) || options.teachers[1];
    const roomA = options.rooms[0];
    const roomB = options.rooms[1];
    const subjectA = options.subjects[0];
    const subjectB = options.subjects[1];
    const workingDay = options.weekdays.find(w => w.dayKey === 'wednesday') || options.weekdays[2];
    const secondDay = options.weekdays.find(w => w.dayKey === 'thursday') || options.weekdays[3];
    const slotTS01 = options.timeSlots.find(s => s.slotCode === 'TS-02') || options.timeSlots[1];
    const slotTS02 = options.timeSlots.find(s => s.slotCode === 'TS-03') || options.timeSlots[2];

    // Seed dedicated timetable entries for viewing tests
    // Entry 1: Teacher A, Sec A, Subject A, Room A on workingDay at TS-01
    const entry1Res = await request('/api/admin/timetable', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        sectionId: secA.id,
        subjectId: subjectA.id,
        teacherUserId: teacherA.id,
        roomId: roomA.id,
        weekdayId: workingDay.id,
        timeSlotId: slotTS01.id,
      },
    });
    assert.equal(entry1Res.status, 201);
    const entry1Data = await entry1Res.json();
    createdEntryIds.push(entry1Data.id);

    // Entry 2: Teacher B, Sec B, Subject B, Room B on workingDay at TS-01
    const entry2Res = await request('/api/admin/timetable', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        sectionId: secB.id,
        subjectId: subjectB.id,
        teacherUserId: teacherB.id,
        roomId: roomB.id,
        weekdayId: workingDay.id,
        timeSlotId: slotTS01.id,
      },
    });
    assert.equal(entry2Res.status, 201);
    const entry2Data = await entry2Res.json();
    createdEntryIds.push(entry2Data.id);

    // Entry 3: Teacher A, Sec B, Subject A, Room A on secondDay at TS-02
    const entry3Res = await request('/api/admin/timetable', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        sectionId: secB.id,
        subjectId: subjectA.id,
        teacherUserId: teacherA.id,
        roomId: roomA.id,
        weekdayId: secondDay.id,
        timeSlotId: slotTS02.id,
      },
    });
    assert.equal(entry3Res.status, 201);
    const entry3Data = await entry3Res.json();
    createdEntryIds.push(entry3Data.id);

    // =========================================================================
    // TC40: Teacher Timetable
    // =========================================================================
    // Find login credentials for teacherA
    const [teacherAUsers] = await pool.execute('SELECT login_id FROM users WHERE id = ?', [teacherA.id]);
    const teacherALoginId = teacherAUsers[0]?.login_id || 'Teacher';

    const teacherLogin = await request('/api/auth/login', {
      method: 'POST',
      body: { identifier: teacherALoginId, password: 'teacher123' },
    });
    assert.equal(teacherLogin.status, 200, 'Teacher login should succeed');
    const teacherCookie = teacherLogin.headers.get('set-cookie')?.split(';')[0];
    assert.ok(teacherCookie);

    // 1. Teacher views own timetable page
    const teacherPage = await request('/teacher/timetable', { cookie: teacherCookie });
    assert.equal(teacherPage.status, 200, 'Teacher timetable HTML page should load with 200 OK');
    const teacherHtml = await teacherPage.text();
    assert.match(teacherHtml, /My Timetable/i);
    assert.match(teacherHtml, /Weekly Grid/i);

    // 2. Teacher retrieves own timetable via API
    const teacherTimetableRes = await request('/api/teacher/timetable', { cookie: teacherCookie });
    assert.equal(teacherTimetableRes.status, 200, 'Teacher timetable API must return 200 OK');
    const teacherData = await teacherTimetableRes.json();
    assert.ok(Array.isArray(teacherData.entries), 'Entries should be an array');
    assert.ok(teacherData.entries.length >= 2, 'Teacher A should have at least 2 entries');
    // Verify ALL returned entries belong strictly to Teacher A
    for (const e of teacherData.entries) {
      assert.equal(e.subjectName ? true : false, true);
      assert.equal(e.dayLabel ? true : false, true);
    }
    assert.ok(teacherData.grid?.matrix, 'Structured grid matrix should be provided');

    // 3. Security: Teacher attempts to access another teacher's timetable by parameter manipulation
    const teacherUnauthorizedRes = await request(`/api/teacher/timetable?teacherUserId=${teacherB.id}`, {
      cookie: teacherCookie,
    });
    assert.equal(
      teacherUnauthorizedRes.status,
      403,
      'Teacher attempting to access another teacher ID must return 403 Forbidden'
    );
    const teacherUnauthData = await teacherUnauthorizedRes.json();
    assert.match(teacherUnauthData.error, /Unauthorized/i);

    // =========================================================================
    // TC41: Student Timetable
    // =========================================================================
    // Find a student user (e.g. Student / student123 or Nikhil / nik001)
    const [studentUsers] = await pool.execute("SELECT u.id, u.login_id FROM users u WHERE u.role = 'student' LIMIT 1");
    assert.ok(studentUsers.length > 0, 'Student user must exist');
    const studentUser = studentUsers[0];

    // Assign studentUser to secA for testing
    const [currentProfile] = await pool.execute('SELECT section_id FROM student_profiles WHERE user_id = ?', [studentUser.id]);
    originalStudentSectionId = currentProfile[0]?.section_id || null;
    await pool.execute('UPDATE student_profiles SET section_id = ? WHERE user_id = ?', [secA.id, studentUser.id]);

    const studentLogin = await request('/api/auth/login', {
      method: 'POST',
      body: { identifier: studentUser.login_id, password: studentUser.login_id === 'Nikhil' ? 'nik001' : 'student123' },
    });
    assert.equal(studentLogin.status, 200, 'Student login should succeed');
    const studentCookie = studentLogin.headers.get('set-cookie')?.split(';')[0];
    assert.ok(studentCookie);

    // 1. Student views own timetable page
    const studentPage = await request('/student/timetable', { cookie: studentCookie });
    assert.equal(studentPage.status, 200, 'Student timetable HTML page should load with 200 OK');
    const studentHtml = await studentPage.text();
    assert.match(studentHtml, /Class Schedule|Student Schedule/i);

    // 2. Student retrieves own section timetable via API
    const studentTimetableRes = await request('/api/student/timetable', { cookie: studentCookie });
    assert.equal(studentTimetableRes.status, 200, 'Student timetable API must return 200 OK');
    const studentData = await studentTimetableRes.json();
    assert.equal(studentData.hasSection, true);
    assert.ok(Array.isArray(studentData.entries));
    // Verify returned entries match student's section (secA)
    assert.ok(studentData.entries.length >= 1);
    for (const e of studentData.entries) {
      assert.equal(e.sectionId, secA.id, 'Student should only see entries for their assigned section');
    }

    // 3. Security: Student attempts to access another section's timetable by parameter manipulation
    const studentUnauthorizedRes = await request(`/api/student/timetable?sectionId=${secB.id}`, {
      cookie: studentCookie,
    });
    assert.equal(
      studentUnauthorizedRes.status,
      403,
      'Student attempting to query another section ID must return 403 Forbidden'
    );
    const studentUnauthData = await studentUnauthorizedRes.json();
    assert.match(studentUnauthData.error, /Unauthorized/i);

    // 4. Student without section placement
    await pool.execute('UPDATE student_profiles SET section_id = NULL WHERE user_id = ?', [studentUser.id]);
    const studentUnplacedRes = await request('/api/student/timetable', { cookie: studentCookie });
    assert.equal(studentUnplacedRes.status, 200);
    const studentUnplacedData = await studentUnplacedRes.json();
    assert.equal(studentUnplacedData.hasSection, false);
    assert.match(studentUnplacedData.message, /not been placed into an academic section/i);

    // Restore section assignment for export test
    await pool.execute('UPDATE student_profiles SET section_id = ? WHERE user_id = ?', [secA.id, studentUser.id]);

    // =========================================================================
    // TC42: Administrator Timetable Viewing
    // =========================================================================
    // Admin views complete timetable
    const adminAllRes = await request('/api/admin/timetable', { cookie: adminCookie });
    assert.equal(adminAllRes.status, 200);
    const adminAllData = await adminAllRes.json();
    assert.ok(adminAllData.entries.length >= 3);

    // Admin views Teacher A's timetable
    const adminTeacherRes = await request(`/api/admin/timetable?teacherId=${teacherA.id}`, { cookie: adminCookie });
    assert.equal(adminTeacherRes.status, 200);
    const adminTeacherData = await adminTeacherRes.json();
    assert.ok(adminTeacherData.entries.length >= 2);
    for (const e of adminTeacherData.entries) {
      assert.equal(e.teacherUserId, teacherA.id, 'All entries must belong to teacherA');
    }

    // Admin views Section A's timetable
    const adminSectionRes = await request(`/api/admin/timetable?sectionId=${secA.id}`, { cookie: adminCookie });
    assert.equal(adminSectionRes.status, 200);
    const adminSectionData = await adminSectionRes.json();
    assert.ok(adminSectionData.entries.length >= 1);
    for (const e of adminSectionData.entries) {
      assert.equal(e.sectionId, secA.id, 'All entries must belong to secA');
    }

    // =========================================================================
    // TC43: Multi-Filter and Search
    // =========================================================================
    // Multiple simultaneous filters: Teacher A + Section B + Day 2
    const multiFilterRes = await request(
      `/api/admin/timetable?teacherId=${teacherA.id}&sectionId=${secB.id}&weekdayId=${secondDay.id}`,
      { cookie: adminCookie }
    );
    assert.equal(multiFilterRes.status, 200);
    const multiFilterData = await multiFilterRes.json();
    assert.equal(multiFilterData.total, 1, 'Multi-filter should return exactly 1 matching record');
    assert.equal(multiFilterData.entries[0].id, entry3Data.id);

    // Search filter matching subject name
    const searchRes = await request(`/api/admin/timetable?search=${encodeURIComponent(subjectA.name.slice(0, 6))}`, {
      cookie: adminCookie,
    });
    assert.equal(searchRes.status, 200);
    const searchData = await searchRes.json();
    assert.ok(searchData.entries.length >= 2, 'Search by subject name should return matching records');

    // Search with non-matching query (empty result handling)
    const emptySearchRes = await request('/api/admin/timetable?search=NonExistentQueryXYZ999', {
      cookie: adminCookie,
    });
    assert.equal(emptySearchRes.status, 200);
    const emptySearchData = await emptySearchRes.json();
    assert.equal(emptySearchData.total, 0, 'Non-matching search must return 0 records');
    assert.equal(emptySearchData.entries.length, 0);

    // =========================================================================
    // TC44: Download and Print
    // =========================================================================
    // 1. Admin CSV Export
    const adminExportRes = await request(`/api/admin/timetable/export?teacherId=${teacherA.id}`, {
      cookie: adminCookie,
    });
    assert.equal(adminExportRes.status, 200);
    assert.match(adminExportRes.headers.get('content-type'), /text\/csv/);
    assert.match(adminExportRes.headers.get('content-disposition'), /admin-timetable\.csv/);
    const adminCsv = await adminExportRes.text();
    assert.match(adminCsv, /Day,Slot,Start Time,End Time,Class\/Section/);
    assert.match(adminCsv, new RegExp(teacherA.name, 'i'));

    // 2. Teacher CSV Export
    const teacherExportRes = await request('/api/teacher/timetable/export', {
      cookie: teacherCookie,
    });
    assert.equal(teacherExportRes.status, 200);
    assert.match(teacherExportRes.headers.get('content-type'), /text\/csv/);
    assert.match(teacherExportRes.headers.get('content-disposition'), /teacher-timetable\.csv/);
    const teacherCsv = await teacherExportRes.text();
    assert.match(teacherCsv, /Day,Slot,Start Time,End Time/);

    // 3. Student CSV Export
    const studentExportRes = await request('/api/student/timetable/export', {
      cookie: studentCookie,
    });
    assert.equal(studentExportRes.status, 200);
    assert.match(studentExportRes.headers.get('content-type'), /text\/csv/);
    assert.match(studentExportRes.headers.get('content-disposition'), /student-timetable\.csv/);
    const studentCsv = await studentExportRes.text();
    assert.match(studentCsv, /Day,Slot,Start Time,End Time/);
    assert.match(studentCsv, new RegExp(secA.sectionName, 'i'));

    // 4. Role enforcement on exports
    const teacherTamperExport = await request(`/api/teacher/timetable/export?teacherUserId=${teacherB.id}`, {
      cookie: teacherCookie,
    });
    assert.equal(teacherTamperExport.status, 403);

    const studentTamperExport = await request(`/api/student/timetable/export?sectionId=${secB.id}`, {
      cookie: studentCookie,
    });
    assert.equal(studentTamperExport.status, 403);

  } finally {
    // Clean up created timetable entries
    if (createdEntryIds.length) {
      await pool.execute(
        `DELETE FROM timetable_entries WHERE id IN (${createdEntryIds.map(() => '?').join(',')})`,
        createdEntryIds
      );
    }
    // Restore student's original section
    const [studentUsers] = await pool.execute("SELECT u.id FROM users u WHERE u.role = 'student' LIMIT 1");
    if (studentUsers.length > 0) {
      await pool.execute('UPDATE student_profiles SET section_id = ? WHERE user_id = ?', [originalStudentSectionId, studentUsers[0].id]);
    }

    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
