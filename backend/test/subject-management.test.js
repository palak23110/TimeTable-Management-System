'use strict';

require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const assert = require('node:assert/strict');
const { test } = require('node:test');
const app = require('../app');
const pool = require('../database/pool');

test('administrator subject catalogue, assignment workspace and import preview', { timeout: 60000 }, async () => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, cookie) => fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  const get = (route, cookie) => fetch(`${base}${route}`, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: 'manual',
  });

  let adminCookie;
  let teacherCookie;
  let curriculumId;
  let subjectId;
  let studentProfileId;
  let teacherUserId;
  let originalTeacherSubjectIds = [];
  const suffix = Date.now();
  const courseCode = `TC-${String(suffix).slice(-10)}`;
  const studentId = `TCS-${String(suffix).slice(-10)}`;

  try {
    const adminLogin = await post('/api/auth/login', { identifier: 'admin', password: 'admin001' });
    assert.equal(adminLogin.status, 200);
    adminCookie = adminLogin.headers.get('set-cookie')?.split(';')[0];
    assert.ok(adminCookie);

    const page = await get('/admin/subjects', adminCookie);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Course Assignment Workspace/);
    const preview = await get('/api/admin/subjects/import/preview', adminCookie);
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).totals.curriculumRows, 243);

    const denied = await get('/api/admin/subjects/stats');
    assert.equal(denied.status, 302, 'subject APIs require administrator authentication');

    const optionResponse = await get('/api/admin/subjects/options', adminCookie);
    assert.equal(optionResponse.status, 200);
    const optionData = await optionResponse.json();
    const programme = optionData.programmes.find((item) => item.code === 'BTECH');
    const cse = optionData.branches.find((item) => item.code === 'BTECH-CSE');
    const semester = optionData.semesters.find((item) => Number(item.isActive));
    const section = optionData.sections.find((item) => item.name === 'CSE1' && Number(item.branchOptionId) === Number(cse.id));
    const teacher = optionData.teachers[0];
    const academicYear = optionData.academicYears[0];
    teacherUserId = teacher?.userId;
    assert.ok(programme && cse && semester && section && teacher && academicYear, 'configured database options are available without frontend dummy data');
    const [originalMappings] = await pool.execute('SELECT subject_id AS subjectId FROM teacher_subjects WHERE teacher_user_id = ?', [teacherUserId]);
    originalTeacherSubjectIds = originalMappings.map((item) => Number(item.subjectId));

    const invalid = await post('/api/admin/subjects', { courseName: 'Missing Code', credits: 3 }, adminCookie);
    assert.equal(invalid.status, 400);
    const created = await post('/api/admin/subjects', {
      courseName: `TC Subject ${suffix}`,
      courseCode,
      credits: 4,
      programmeId: programme.id,
      branchOptionId: cse.id,
      semesterId: semester.id,
      sectionId: section.id,
    }, adminCookie);
    assert.equal(created.status, 201, await created.clone().text());
    const createdData = await created.json();
    curriculumId = createdData.id;
    const [ids] = await pool.execute('SELECT subject_id AS subjectId FROM curriculum_subjects WHERE id = ?', [curriculumId]);
    subjectId = ids[0].subjectId;

    const unmappedAllocation = await post('/api/admin/subjects/assignments/teacher', {
      teacherUserId, sectionId: section.id, semesterId: semester.id, academicYearId: academicYear.id,
      curriculumSubjectIds: [curriculumId],
    }, adminCookie);
    assert.equal(unmappedAllocation.status, 409, 'actual teaching allocations require a teacher-subject mapping');
    const mapping = await fetch(`${base}/api/admin/teachers/${teacherUserId}/subjects`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ subjectIds: [...originalTeacherSubjectIds, Number(subjectId)] }), redirect: 'manual',
    });
    assert.equal(mapping.status, 200);
    const allocation = await post('/api/admin/subjects/assignments/teacher', {
      teacherUserId, sectionId: section.id, semesterId: semester.id, academicYearId: academicYear.id,
      curriculumSubjectIds: [curriculumId],
    }, adminCookie);
    assert.equal(allocation.status, 201, await allocation.clone().text());

    const duplicate = await post('/api/admin/subjects', {
      courseName: `Duplicate ${suffix}`,
      courseCode,
      credits: 3,
      programmeId: programme.id,
      branchOptionId: cse.id,
      semesterId: semester.id,
    }, adminCookie);
    assert.equal(duplicate.status, 409, 'duplicate course codes within the same curriculum placement are rejected');

    const search = await get(`/api/admin/subjects?search=${encodeURIComponent(courseCode)}`, adminCookie);
    assert.equal(search.status, 200);
    const searchData = await search.json();
    assert.equal(searchData.total, 1);
    assert.equal(searchData.subjects[0].courseCode, courseCode);

    const classDuplicate = await post('/api/admin/subjects/assignments/class', {
      sectionId: section.id,
      semesterId: semester.id,
      curriculumSubjectIds: [curriculumId],
    }, adminCookie);
    assert.equal(classDuplicate.status, 409, 'duplicate class assignments are rejected');

    const teacherAssignments = await get('/api/admin/subjects/assignments?type=teacher', adminCookie);
    assert.equal(teacherAssignments.status, 200);
    assert.ok((await teacherAssignments.json()).assignments.some((item) => Number(item.curriculumSubjectId) === Number(curriculumId)));

    const structureResponse = await get('/api/admin/academic-structure', adminCookie);
    const structure = await structureResponse.json();
    const activeCalendar = structure.activeCalendar;
    const currentSemesterNumber = (Number(activeCalendar.startYear) - (Number(activeCalendar.startYear) - 2)) * 2
      + (activeCalendar.termKey === 'odd' ? 1 : 2);
    const studentSemester = structure.semesters.find((item) => Number(item.semesterNumber) === currentSemesterNumber);
    const student = await post('/api/admin/students', {
      name: 'TC Subject Assignment Student',
      studentId,
      email: `subject-${suffix}@example.invalid`,
      contactNumber: '+1 555 011 1234',
      programmeId: programme.id,
      branchOptionId: cse.id,
      enrolledYear: Number(activeCalendar.startYear) - 2,
      expectedGraduationYear: Number(activeCalendar.startYear) + 2,
      sectionId: section.id,
    }, adminCookie);
    assert.equal(student.status, 201, await student.clone().text());
    studentProfileId = (await student.json()).student.id;

    // A matching course-semester assignment is needed for individual student enrolment.
    if (Number(semester.semesterNumber) !== currentSemesterNumber) {
      await pool.execute('UPDATE curriculum_subjects SET semester_id = ? WHERE id = ?', [studentSemester.id, curriculumId]);
    }
    const [linkedSemester] = await pool.execute('SELECT semester_id AS semesterId FROM curriculum_subjects WHERE id = ?', [curriculumId]);
    const assignedStudent = await post('/api/admin/subjects/assignments/student', {
      studentProfileId,
      curriculumSubjectId: curriculumId,
    }, adminCookie);
    if (Number(linkedSemester[0].semesterId) === currentSemesterNumber || Number(linkedSemester[0].semesterId) === Number(studentSemester.id)) {
      assert.equal(assignedStudent.status, 201, await assignedStudent.clone().text());
      const effective = await get(`/api/admin/subjects/assignments/effective/${studentProfileId}`, adminCookie);
      assert.equal(effective.status, 200);
      assert.equal((await effective.json()).subjects.filter((item) => Number(item.curriculumSubjectId) === Number(curriculumId)).length, 1);
      const studentAssignments = await get('/api/admin/subjects/assignments?type=student', adminCookie);
      const assignment = (await studentAssignments.json()).assignments.find((item) => Number(item.curriculumSubjectId) === Number(curriculumId));
      assert.ok(assignment);
      const exclude = await fetch(`${base}/api/admin/subjects/assignments/student/${assignment.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ action: 'exclude' }), redirect: 'manual',
      });
      assert.equal(exclude.status, 200);
      const restoredClassSubject = await get(`/api/admin/subjects/assignments/effective/${studentProfileId}`, adminCookie);
      assert.equal((await restoredClassSubject.json()).subjects.length, 0, 'student exclusion overrides inherited class courses');
      await fetch(`${base}/api/admin/subjects/assignments/student/${assignment.id}`, {
        method: 'DELETE', headers: { Cookie: adminCookie }, redirect: 'manual',
      });
      const inherited = await get(`/api/admin/subjects/assignments/effective/${studentProfileId}`, adminCookie);
      assert.equal((await inherited.json()).subjects.length, 1, 'removing the override restores class-assigned courses');
    }

    const edit = await fetch(`${base}/api/admin/subjects/${curriculumId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ courseName: `TC Subject Updated ${suffix}` }),
      redirect: 'manual',
    });
    assert.equal(edit.status, 200);
    const detail = await get(`/api/admin/subjects/${curriculumId}`, adminCookie);
    assert.equal((await detail.json()).subject.courseName, `TC Subject Updated ${suffix}`);

    const teacherLogin = await post('/api/auth/login', { identifier: 'Teacher', password: 'teacher123' });
    assert.equal(teacherLogin.status, 200);
    teacherCookie = teacherLogin.headers.get('set-cookie')?.split(';')[0];
    const teacherDenied = await get('/api/admin/subjects/options', teacherCookie);
    assert.equal(teacherDenied.status, 302, 'teacher role cannot access administrator subject APIs');

    const deactivated = await fetch(`${base}/api/admin/subjects/${curriculumId}`, {
      method: 'DELETE', headers: { Cookie: adminCookie }, redirect: 'manual',
    });
    assert.equal(deactivated.status, 200);
  } finally {
    if (studentProfileId) await pool.execute('DELETE FROM student_profiles WHERE id = ?', [studentProfileId]);
    if (curriculumId) {
      await pool.execute('DELETE FROM class_course_assignments WHERE curriculum_subject_id = ?', [curriculumId]);
      await pool.execute('DELETE FROM teacher_course_assignments WHERE curriculum_subject_id = ?', [curriculumId]);
      await pool.execute('DELETE FROM curriculum_subjects WHERE id = ?', [curriculumId]);
    }
    if (teacherUserId) {
      await pool.execute('DELETE FROM teacher_subjects WHERE teacher_user_id = ?', [teacherUserId]);
      if (originalTeacherSubjectIds.length) {
        await pool.query(`INSERT INTO teacher_subjects (teacher_user_id, subject_id) VALUES ${originalTeacherSubjectIds.map(() => '(?, ?)').join(', ')}`,
          originalTeacherSubjectIds.flatMap((id) => [teacherUserId, id]));
      }
    }
    if (subjectId) await pool.execute('DELETE FROM subjects WHERE id = ?', [subjectId]);
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
