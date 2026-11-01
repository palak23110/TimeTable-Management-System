require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const assert = require('node:assert/strict');
const { test } = require('node:test');
const app = require('../app');
const pool = require('../database/pool');

test('student intake, academic configuration, semester calculation and admin access', {
  timeout: 60000,
}, async () => {
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
  let profileId;
  let testOptionId;
  let testSectionId;
  let testYearId;
  let testTermIds = [];
  const suffix = Date.now();
  const email = `tc-student-${suffix}@example.invalid`;
  const studentId = `TC-${String(suffix).slice(-12)}`;

  try {
    const login = await post('/api/auth/login', { identifier: 'admin', password: 'admin001' });
    assert.equal(login.status, 200);
    adminCookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(adminCookie);

    const structureResponse = await get('/api/admin/academic-structure', adminCookie);
    assert.equal(structureResponse.status, 200);
    const structure = await structureResponse.json();
    const btech = structure.programmes.find((item) => item.code === 'BTECH');
    const bcom = structure.programmes.find((item) => item.code === 'BCOM_HONS');
    const cse = structure.options.find((item) => item.code === 'BTECH-CSE');
    const cseDsa = structure.options.find((item) => item.code === 'CSE-DSAI');
    const bba = structure.programmes.find((item) => item.code === 'BBA');
    assert.ok(btech && bcom && bba && cse && cseDsa);
    const cseSections = structure.sections.filter((item) => Number(item.branchOptionId) === Number(cse.id));
    const bbaSections = structure.sections.filter((item) => Number(item.programmeId) === Number(bba.id));
    assert.equal(cseSections.length, 8, 'the requested CSE1–CSE8 sections are configured');
    assert.deepEqual(bbaSections.map((item) => item.name).sort(), ['BBA1', 'BBA2', 'BBA3', 'BBA4', 'BBA5']);
    assert.equal(structure.semesters.length, 10, 'semester levels 1–10 are configured');
    assert.ok(structure.activeCalendar, 'an active academic year and term exist');
    assert.ok(!structure.programmes.some((item) => ['MBA', 'MA Public Policy', 'PhD'].includes(item.name)));

    const existingStudentPage = await get('/admin/students', adminCookie);
    assert.equal(existingStudentPage.status, 200);
    assert.match(await existingStudentPage.text(), /Student management/);
    const academicPage = await get('/admin/academic-structure', adminCookie);
    assert.equal(academicPage.status, 200);
    assert.match(await academicPage.text(), /Branches, majors and specialisations/);
    assert.equal((await get('/api/admin/students/stats')).status, 302, 'student APIs remain administrator-only');

    const activeStartYear = Number(structure.activeCalendar.startYear);
    const enrolledYear = activeStartYear - 2;
    const expectedGraduationYear = enrolledYear + 4;
    const semesterNumber = (activeStartYear - enrolledYear) * 2
      + (structure.activeCalendar.termKey === 'odd' ? 1 : 2);
    const semester = structure.semesters.find((item) => Number(item.semesterNumber) === semesterNumber);
    const firstSection = cseSections.find((section) => section.name === 'CSE1');
    const secondSection = cseSections.find((section) => section.name === 'CSE2');
    assert.ok(semester && firstSection && secondSection);

    const blank = await post('/api/admin/students', { name: 'Missing fields' }, adminCookie);
    assert.equal(blank.status, 400);
    const invalidEmail = await post('/api/admin/students', {
      name: 'Invalid Email Student', studentId: `${studentId}-BAD`, email: 'not-an-email',
      contactNumber: '+1 555 010 1212',
    }, adminCookie);
    assert.equal(invalidEmail.status, 400);

    const studentPayload = {
      name: 'TC Student Fixture',
      studentId,
      email,
      contactNumber: '+1 555 010 1212',
      programmeId: btech.id,
      branchOptionId: cse.id,
      specialisationOptionId: cseDsa.id,
      enrolledYear,
      expectedGraduationYear,
      sectionId: firstSection.id,
    };
    const created = await post('/api/admin/students', studentPayload, adminCookie);
    assert.equal(created.status, 201, await created.clone().text());
    const createdData = await created.json();
    profileId = createdData.student.id;
    assert.equal(createdData.student.studentId, studentId);

    const [stored] = await pool.execute(`
      SELECT sp.user_id AS userId, sp.student_id AS studentId,
        sp.current_semester_id AS semesterId, s.semester_number AS semesterNumber,
        sp.section_id AS sectionId
      FROM student_profiles sp
      LEFT JOIN academic_semesters s ON s.id = sp.current_semester_id
      WHERE sp.id = ?
    `, [profileId]);
    assert.equal(stored[0].userId, null, 'student invitation/login account is intentionally out of scope');
    assert.equal(Number(stored[0].semesterId), Number(semester.id));
    assert.equal(Number(stored[0].semesterNumber), semesterNumber);
    assert.equal(Number(stored[0].sectionId), Number(firstSection.id));

    const duplicateStudent = await post('/api/admin/students', studentPayload, adminCookie);
    assert.equal(duplicateStudent.status, 409);
    const invalidGraduation = await post('/api/admin/students', {
      ...studentPayload,
      studentId: `${studentId}-DUR`,
      email: `duration-${suffix}@example.invalid`,
      expectedGraduationYear: enrolledYear + 6,
    }, adminCookie);
    assert.equal(invalidGraduation.status, 400);

    const list = await get(`/api/admin/students?search=${encodeURIComponent(studentId)}&page=1`, adminCookie);
    assert.equal(list.status, 200);
    const listed = await list.json();
    assert.equal(listed.total, 1);
    assert.equal(listed.students[0].semesterName, semester.label);
    assert.equal(listed.students[0].sectionName, 'CSE1');

    const editPlacement = await fetch(`${base}/api/admin/students/${profileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ sectionId: secondSection.id }),
      redirect: 'manual',
    });
    assert.equal(editPlacement.status, 200, await editPlacement.clone().text());
    const details = await (await get(`/api/admin/students/${profileId}`, adminCookie)).json();
    assert.equal(details.student.sectionName, 'CSE2', 'academic placement changes persist');
    assert.equal(details.student.semesterNumber, semesterNumber);

    const bcomMajor = await post('/api/admin/academic-structure/options', {
      programmeId: bcom.id,
      type: 'major',
      name: `TC Major ${suffix}`,
    }, adminCookie);
    assert.equal(bcomMajor.status, 201, await bcomMajor.clone().text());
    testOptionId = (await bcomMajor.json()).id;
    const bcomSection = await post('/api/admin/academic-structure/sections', {
      programmeId: bcom.id,
      branchOptionId: testOptionId,
      name: `TC${String(suffix).slice(-6)}`,
    }, adminCookie);
    assert.equal(bcomSection.status, 201, await bcomSection.clone().text());
    testSectionId = (await bcomSection.json()).id;
    const duplicateSection = await post('/api/admin/academic-structure/sections', {
      programmeId: bcom.id,
      branchOptionId: testOptionId,
      name: `TC${String(suffix).slice(-6)}`,
    }, adminCookie);
    assert.equal(duplicateSection.status, 409);

    const [years] = await pool.execute('SELECT MAX(start_year) AS maxStart FROM academic_years');
    const yearStart = Number(years[0].maxStart) + 1;
    const newYear = await post('/api/admin/academic-structure/years', { startYear: yearStart }, adminCookie);
    assert.equal(newYear.status, 201, await newYear.clone().text());
    testYearId = (await newYear.json()).id;
    const [terms] = await pool.execute('SELECT id FROM academic_terms WHERE academic_year_id = ?', [testYearId]);
    testTermIds = terms.map((term) => term.id);
    assert.equal(testTermIds.length, 2);

    const duplicateYear = await post('/api/admin/academic-structure/years', { startYear: yearStart }, adminCookie);
    assert.equal(duplicateYear.status, 409);
    const duplicateSemester = await post('/api/admin/academic-structure/semesters', {
      semesterNumber: semesterNumber,
    }, adminCookie);
    assert.equal(duplicateSemester.status, 409);

    const wrongProgramBranch = await post('/api/admin/students', {
      ...studentPayload,
      studentId: `${studentId}-WRONG`,
      email: `wrong-branch-${suffix}@example.invalid`,
      programmeId: bcom.id,
      branchOptionId: cse.id,
      specialisationOptionId: null,
      sectionId: testSectionId,
    }, adminCookie);
    assert.equal(wrongProgramBranch.status, 400);

    const stats = await (await get('/api/admin/students/stats', adminCookie)).json();
    assert.ok(stats.stats.total >= 1);
  } finally {
    if (profileId) await pool.execute('DELETE FROM student_profiles WHERE id = ?', [profileId]);
    if (testSectionId) await pool.execute('DELETE FROM academic_sections WHERE id = ?', [testSectionId]);
    if (testOptionId) await pool.execute('DELETE FROM academic_options WHERE id = ?', [testOptionId]);
    if (testTermIds.length) {
      const placeholders = testTermIds.map(() => '?').join(', ');
      await pool.execute(`DELETE FROM academic_terms WHERE id IN (${placeholders})`, testTermIds);
    }
    if (testYearId) await pool.execute('DELETE FROM academic_years WHERE id = ?', [testYearId]);
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
