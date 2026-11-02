require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const assert = require('node:assert/strict');
const { test } = require('node:test');
const bcrypt = require('bcrypt');
const app = require('../app');
const pool = require('../database/pool');

test('administrator teacher flow covers account creation, invitation, resend and first login', {
  timeout: 60000,
}, async () => {
  const originalMailer = app.locals.sendTeacherInvitationEmail;
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
  let createdId;
  let subjectId;
  let secondSubjectId;
  let studentCookie;
  let shouldFailDelivery = false;
  const deliveredInvitations = [];
  const email = `tc-teacher-${Date.now()}@example.invalid`;
  const teacherId = `TCH-${String(Date.now()).slice(-8)}`;

  app.locals.sendTeacherInvitationEmail = async (invitation) => {
    assert.equal(invitation.email, email);
    if (shouldFailDelivery) throw new Error('Mock SMTP failure');
    deliveredInvitations.push({ token: invitation.invitationToken, temporaryPassword: invitation.temporaryPassword });
  };

  try {
    const adminLogin = await post('/api/auth/login', {
      identifier: 'admin',
      password: 'admin001',
    });
    assert.equal(adminLogin.status, 200, 'administrator test login succeeds');
    adminCookie = adminLogin.headers.get('set-cookie')?.split(';')[0];
    assert.ok(adminCookie);
    assert.equal((await get('/api/admin/teachers/stats')).status, 302);

    const dashboardResponse = await get('/admin/dashboard', adminCookie);
    assert.equal(dashboardResponse.status, 200);
    const dashboardHtml = await dashboardResponse.text();
    assert.match(dashboardHtml, /<h1>Dashboard<\/h1>/);
    assert.match(dashboardHtml, /Manage academic resources, faculty information, and institutional scheduling activities\./);
    assert.equal((dashboardHtml.match(/class="stat-card"/g) || []).length, 8);
    assert.doesNotMatch(dashboardHtml, /DEMO DATA|Loading profile|Weekly Activity|Upcoming classes/i);
    assert.match(dashboardHtml, /Conflict alerts/);
    assert.match(dashboardHtml, /Common actions/);

    const teachersPage = await get('/admin/teachers', adminCookie);
    assert.equal(teachersPage.status, 200, 'Teachers navigation destination is protected and available');
    assert.match(await teachersPage.text(), /Add new teacher/);

    const invalid = await post('/api/admin/teachers', {
      name: '',
      teacherId: '',
      email: 'invalid',
      contactNumber: 'abc',
    }, adminCookie);
    assert.equal(invalid.status, 400, 'required fields are validated');

    const missingTeacherId = await post('/api/admin/teachers', {
      name: 'Missing ID Teacher',
      email: `missing-id-${Date.now()}@example.invalid`,
      contactNumber: '+1 555 010 1111',
    }, adminCookie);
    assert.equal(missingTeacherId.status, 400, 'Teacher ID is required');

    for (const [index, fields] of [
      { name: '', teacherId: `TCH-BLANK-${Date.now()}`, email: `blank-name-${Date.now()}@example.invalid` },
      { name: 'Missing Email Teacher', teacherId: `TCH-MAIL-${Date.now()}`, email: '' },
    ].entries()) {
      const response = await post('/api/admin/teachers', {
        ...fields,
        contactNumber: '+1 555 010 1111',
      }, adminCookie);
      assert.equal(response.status, 400, `blank required field case ${index + 1} is rejected`);
    }

    const invalidEmail = await post('/api/admin/teachers', {
      name: 'Invalid Email Teacher',
      teacherId: `TCH-BAD-${String(Date.now()).slice(-4)}`,
      email: 'not-an-email',
      contactNumber: '+1 555 010 1111',
    }, adminCookie);
    assert.equal(invalidEmail.status, 400, 'invalid email format is rejected');
    const [invalidEmailCount] = await pool.execute(
      'SELECT COUNT(*) AS count FROM users WHERE email = ?',
      ['not-an-email'],
    );
    assert.equal(Number(invalidEmailCount[0].count), 0, 'invalid email does not create an account');

    shouldFailDelivery = true;
    const createResponse = await post('/api/admin/teachers', {
      name: 'TC Test Teacher',
      teacherId,
      email,
      contactNumber: '+1 555 010 1234',
    }, adminCookie);
    assert.equal(createResponse.status, 201, await createResponse.clone().text());
    const created = await createResponse.json();
    createdId = created.teacher.id;
    assert.equal(created.invitationSent, false);
    assert.equal(created.temporaryPassword, undefined);
    assert.equal(created.teacher.status, 'delivery_failed');

    const [failedCreateAccounts] = await pool.execute(
      'SELECT id, is_active AS isActive, password_hash AS passwordHash FROM users WHERE id = ?',
      [createdId],
    );
    assert.equal(failedCreateAccounts.length, 1, 'SMTP failure does not delete the new account');
    assert.equal(Number(failedCreateAccounts[0].isActive), 1);
    assert.equal(await bcrypt.getRounds(failedCreateAccounts[0].passwordHash), 12);

    shouldFailDelivery = false;
    const firstResend = await post(
      `/api/admin/teachers/${createdId}/resend-invitation`,
      {},
      adminCookie,
    );
    assert.equal(firstResend.status, 200);
    assert.equal((await firstResend.json()).invitationSent, true);

    const firstInvitation = deliveredInvitations.at(-1);
    const firstInvitationToken = firstInvitation.token;
    assert.match(firstInvitationToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(created.temporaryPassword, undefined);

    const [accounts] = await pool.execute(`
      SELECT id, login_id AS loginId, email, password_hash AS passwordHash,
        role, is_active AS isActive, must_change_password AS mustChangePassword
      FROM users
      WHERE id = ?
    `, [createdId]);
    let account = accounts[0];
    assert.equal(account.loginId, email);
    assert.equal(account.email, email);
    assert.equal(account.role, 'teacher');
    assert.equal(Number(account.isActive), 1);
    assert.equal(Number(account.mustChangePassword), 1);
    assert.equal(await bcrypt.getRounds(account.passwordHash), 12);
    assert.equal(await bcrypt.compare(firstInvitation.temporaryPassword, account.passwordHash), true);
    assert.equal(await bcrypt.compare(firstInvitationToken, account.passwordHash), false);

    const [profiles] = await pool.execute(`
      SELECT teacher_id AS teacherId, contact_number AS contactNumber,
        department, designation, highest_qualification AS qualification
      FROM teacher_profiles
      WHERE user_id = ?
    `, [createdId]);
    assert.equal(profiles[0].teacherId, teacherId);
    assert.equal(profiles[0].contactNumber, '+1 555 010 1234');
    assert.equal(profiles[0].department, null);
    assert.equal(profiles[0].designation, null);
    assert.equal(profiles[0].qualification, null);

    const partialEdit = await fetch(`${base}/api/admin/teachers/${createdId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        name: 'TC Updated Teacher',
        contactNumber: '+1 555 010 5678',
        department: 'Computer Science',
        highestQualification: 'MSc',
      }),
      redirect: 'manual',
    });
    assert.equal(partialEdit.status, 200, await partialEdit.clone().text());
    const edited = await partialEdit.json();
    assert.equal(edited.teacher.name, 'TC Updated Teacher');
    assert.equal(edited.teacher.contactNumber, '+1 555 010 5678');
    assert.equal(edited.teacher.department, 'Computer Science');

    const duplicateTeacherId = await fetch(`${base}/api/admin/teachers/${createdId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ teacherId: 'TCH-0002' }),
      redirect: 'manual',
    });
    assert.equal(duplicateTeacherId.status, 409, 'duplicate Teacher ID update is rejected');

    const partialProfileEdit = await fetch(`${base}/api/admin/teachers/${createdId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ professionalSummary: 'Experienced systems educator.' }),
      redirect: 'manual',
    });
    assert.equal(partialProfileEdit.status, 200);
    const adminProfileSave = await partialProfileEdit.json();
    assert.equal(adminProfileSave.teacher.updatedByRole, 'administrator');
    assert.ok(adminProfileSave.teacher.updatedByUserId);
    assert.ok(adminProfileSave.teacher.updatedAt);

    const persistedTeacher = await (await get(
      `/api/admin/teachers/${createdId}`,
      adminCookie,
    )).json();
    assert.equal(persistedTeacher.teacher.name, 'TC Updated Teacher');
    assert.equal(persistedTeacher.teacher.contact_number, '+1 555 010 5678');
    assert.equal(persistedTeacher.teacher.department, 'Computer Science', 'partial update preserves omitted profile fields');
    assert.equal(persistedTeacher.teacher.highest_qualification, 'MSc');
    assert.equal(persistedTeacher.teacher.professional_summary, 'Experienced systems educator.');

    const duplicateEmailUpdate = await fetch(`${base}/api/admin/teachers/${createdId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ email: (await pool.execute(
        'SELECT email FROM users WHERE login_id = ?',
        ['admin'],
      ))[0][0].email }),
      redirect: 'manual',
    });
    assert.equal(duplicateEmailUpdate.status, 409, 'duplicate email update is rejected');

    const deactivate = await fetch(`${base}/api/admin/teachers/${createdId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ status: 'inactive' }),
      redirect: 'manual',
    });
    assert.equal(deactivate.status, 200);
    assert.equal(Number((await deactivate.json()).teacher.isActive), 0);
    const reactivate = await fetch(`${base}/api/admin/teachers/${createdId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ status: 'active' }),
      redirect: 'manual',
    });
    assert.equal(reactivate.status, 200);

    const [subjectInsert] = await pool.execute(
      'INSERT INTO subjects (subject_name, is_active) VALUES (?, TRUE)',
      [`TC Subject ${Date.now()}`],
    );
    subjectId = subjectInsert.insertId;
    const [secondSubjectInsert] = await pool.execute(
      'INSERT INTO subjects (subject_name, is_active) VALUES (?, TRUE)',
      [`TC Second Subject ${Date.now()}`],
    );
    secondSubjectId = secondSubjectInsert.insertId;

    const firstAssignment = await fetch(`${base}/api/admin/teachers/${createdId}/subjects`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ subjectIds: [subjectId, secondSubjectId] }),
      redirect: 'manual',
    });
    assert.equal(firstAssignment.status, 200, await firstAssignment.clone().text());
    assert.equal((await firstAssignment.json()).subjects.length, 2);

    const assignedSubjects = await (await get(
      `/api/admin/teachers/${createdId}/subjects`,
      adminCookie,
    )).json();
    assert.equal(assignedSubjects.subjects.length, 2, 'multiple subjects persist for the teacher');

    const updatedAssignment = await fetch(`${base}/api/admin/teachers/${createdId}/subjects`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ subjectIds: [secondSubjectId] }),
      redirect: 'manual',
    });
    assert.equal(updatedAssignment.status, 200);
    assert.equal((await updatedAssignment.json()).subjects.length, 1);

    const removedSubjects = await (await get(
      `/api/admin/teachers/${createdId}/subjects`,
      adminCookie,
    )).json();
    assert.deepEqual(removedSubjects.subjects.map((item) => Number(item.id)), [Number(secondSubjectId)]);

    const filtered = await (await get(
      `/api/admin/teachers?subject=${secondSubjectId}`,
      adminCookie,
    )).json();
    assert.equal(filtered.total, 1, 'subject filter finds an assigned teacher');
    assert.equal(filtered.teachers[0].subjectNames.length, 1);

    const duplicate = await post('/api/admin/teachers', {
      name: 'Duplicate',
      teacherId: `TCH-DUP-${String(Date.now()).slice(-4)}`,
      email,
      contactNumber: '+1 555 010 1234',
    }, adminCookie);
    assert.equal(duplicate.status, 409, 'duplicate email is rejected');
    const [duplicateCount] = await pool.execute(
      'SELECT COUNT(*) AS count FROM users WHERE email = ?',
      [email],
    );
    assert.equal(Number(duplicateCount[0].count), 1);

    const list = await (await get(
      `/api/admin/teachers?search=${encodeURIComponent(email)}`,
      adminCookie,
    )).json();
    assert.equal(list.total, 1);
    assert.equal(list.teachers[0].email, email);

    const emptyList = await (await get(
      `/api/admin/teachers?search=${encodeURIComponent(`missing-${Date.now()}`)}`,
      adminCookie,
    )).json();
    assert.equal(emptyList.total, 0, 'search with no match returns the database-backed empty state');

    shouldFailDelivery = true;
    const failedResend = await post(
      `/api/admin/teachers/${createdId}/resend-invitation`,
      {},
      adminCookie,
    );
    assert.equal(failedResend.status, 200);
    const failedResult = await failedResend.json();
    assert.equal(failedResult.invitationSent, false);
    assert.equal(failedResult.temporaryPassword, undefined);

    const failedList = await (await get(
      `/api/admin/teachers?status=delivery_failed&search=${encodeURIComponent(email)}`,
      adminCookie,
    )).json();
    assert.equal(failedList.total, 1, 'failed delivery is not displayed as sent');
    assert.equal(failedList.teachers[0].status, 'delivery_failed');
    const [failedProfile] = await pool.execute(
      'SELECT invitation_pending FROM teacher_profiles WHERE user_id = ?',
      [createdId],
    );
    assert.equal(Number(failedProfile[0].invitation_pending), 0);
    const [afterFailedResend] = await pool.execute(
      'SELECT password_hash AS passwordHash FROM users WHERE id = ?',
      [createdId],
    );
    assert.equal(await bcrypt.compare(firstInvitation.temporaryPassword, afterFailedResend[0].passwordHash), true);

    shouldFailDelivery = false;
    const successfulResend = await post(
      `/api/admin/teachers/${createdId}/resend-invitation`,
      {},
      adminCookie,
    );
    assert.equal(successfulResend.status, 200);
    assert.equal((await successfulResend.json()).invitationSent, true);
    const currentInvitation = deliveredInvitations.at(-1);
    const currentInvitationToken = currentInvitation.token;
    assert.notEqual(currentInvitationToken, firstInvitationToken);

    const invalidInvitation = await post('/api/auth/accept-invitation', {
      token: 'invalid-token', password: 'NewPass123', confirmPassword: 'NewPass123',
    });
    assert.equal(invalidInvitation.status, 400, 'invalid invitation token is rejected');
    await pool.execute('UPDATE user_invitation_tokens SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE user_id = ? AND accepted_at IS NULL', [createdId]);
    const expiredInvitation = await post('/api/auth/accept-invitation', {
      token: currentInvitationToken, password: 'NewPass123', confirmPassword: 'NewPass123',
    });
    assert.equal(expiredInvitation.status, 400, 'expired invitation token is rejected');
    const replacementInvitation = await post(`/api/admin/teachers/${createdId}/resend-invitation`, {}, adminCookie);
    assert.equal(replacementInvitation.status, 200);
    assert.equal((await replacementInvitation.json()).invitationSent, true);
    const validInvitation = deliveredInvitations.at(-1);
    const validInvitationToken = validInvitation.token;

    const [resentAccounts] = await pool.execute(`
      SELECT password_hash AS passwordHash
      FROM users
      WHERE id = ?
    `, [createdId]);
    account = resentAccounts[0];
    assert.equal(await bcrypt.getRounds(account.passwordHash), 12);
    assert.equal(await bcrypt.compare(currentInvitationToken, account.passwordHash), false);

    const stats = await (await get('/api/admin/teachers/stats', adminCookie)).json();
    assert.ok(stats.stats.total >= 1);

    const invitationPage = await get(`/accept-invitation?token=${encodeURIComponent(validInvitationToken)}`);
    assert.equal(invitationPage.status, 200);
    const accepted = await post('/api/auth/accept-invitation', { token: validInvitationToken });
    assert.equal(accepted.status, 200, await accepted.clone().text());
    assert.equal((await accepted.json()).redirectTo, '/login?invitation=accepted');
    assert.equal(accepted.headers.get('set-cookie'), null, 'invitation acceptance leaves sign-in to the existing login form');
    const teacherLogin = await post('/api/auth/login', { identifier: email, password: validInvitation.temporaryPassword });
    assert.equal(teacherLogin.status, 200);
    assert.equal((await teacherLogin.json()).redirectTo, '/teacher/dashboard');
    teacherCookie = teacherLogin.headers.get('set-cookie')?.split(';')[0];
    assert.ok(teacherCookie, 'normal sign-in after invitation creates the authenticated session');
    assert.equal((await get('/teacher/dashboard', teacherCookie)).status, 200);
    assert.equal((await get('/api/teacher/profile', teacherCookie)).status, 200);
    assert.equal((await get('/teacher/dashboard', teacherCookie)).status, 200, 'dashboard refresh keeps the invitation session');
    const replay = await post('/api/auth/accept-invitation', { token: validInvitationToken });
    assert.equal(replay.status, 400, 'accepted invitation cannot be replayed');

    const [updatedRows] = await pool.execute(`
      SELECT password_hash AS passwordHash, must_change_password AS mustChangePassword
      FROM users
      WHERE id = ?
    `, [createdId]);
    assert.equal(Number(updatedRows[0].mustChangePassword), 0);
    assert.equal(await bcrypt.compare(validInvitation.temporaryPassword, updatedRows[0].passwordHash), true);
    const normalLogin = await post('/api/auth/login', {
      identifier: email,
      password: validInvitation.temporaryPassword,
    });
    assert.equal(normalLogin.status, 200);
    assert.equal((await normalLogin.json()).redirectTo, '/teacher/dashboard');
    assert.equal((await post('/api/auth/login', {
      identifier: email,
      password: validInvitationToken,
    })).status, 401);

    const teacherProfilePage = await get('/teacher/profile', teacherCookie);
    assert.equal(teacherProfilePage.status, 200);
    assert.match(await teacherProfilePage.text(), /My profile/);
    const teacherDashboard = await get('/teacher/dashboard', teacherCookie);
    assert.equal(teacherDashboard.status, 200);
    const teacherDashboardHtml = await teacherDashboard.text();
    assert.match(teacherDashboardHtml, /data-greeting/);
    assert.match(teacherDashboardHtml, /Assigned subjects/);
    assert.match(teacherDashboardHtml, /Timetable entries are not available yet/);
    assert.match(teacherDashboardHtml, /href="\/teacher\/profile"/);
    const teacherProfileResponse = await get('/api/teacher/profile', teacherCookie);
    assert.equal(teacherProfileResponse.status, 200);
    const teacherProfile = (await teacherProfileResponse.json()).profile;
    assert.equal(teacherProfile.name, 'TC Updated Teacher');
    assert.equal(teacherProfile.department, 'Computer Science');
    assert.equal(teacherProfile.professionalSummary, 'Experienced systems educator.');

    const teacherProfileSave = await fetch(`${base}/api/teacher/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
      body: JSON.stringify({ contactNumber: '+1 555 010 9876', department: 'Information Systems' }),
      redirect: 'manual',
    });
    assert.equal(teacherProfileSave.status, 200, await teacherProfileSave.clone().text());
    const teacherProfileSaved = (await teacherProfileSave.json()).profile;
    assert.equal(teacherProfileSaved.contactNumber, '+1 555 010 9876');
    assert.equal(teacherProfileSaved.department, 'Information Systems');
    assert.equal(teacherProfileSaved.updatedByRole, 'teacher');
    assert.equal(Number(teacherProfileSaved.updatedByUserId), Number(createdId));
    assert.ok(teacherProfileSaved.updatedAt);

    for (const protectedField of [
      { teacherId: 'TCH-CHANGED' },
      { email: 'new-login@example.invalid' },
      { role: 'administrator' },
      { status: 'inactive' },
    ]) {
      const protectedUpdate = await fetch(`${base}/api/teacher/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
        body: JSON.stringify(protectedField),
        redirect: 'manual',
      });
      assert.equal(protectedUpdate.status, 400, 'teacher cannot change administrator-controlled account fields');
    }

    const adminSeesTeacherEdit = await (await get(`/api/admin/teachers/${createdId}`, adminCookie)).json();
    assert.equal(adminSeesTeacherEdit.teacher.department, 'Information Systems');
    assert.equal(adminSeesTeacherEdit.teacher.updated_by_role, 'teacher');

    const studentLogin = await post('/api/auth/login', {
      identifier: 'Student',
      password: 'student123',
    });
    assert.equal(studentLogin.status, 200);
    studentCookie = studentLogin.headers.get('set-cookie')?.split(';')[0];
    assert.equal((await get('/api/teacher/profile', studentCookie)).status, 403);
    assert.equal((await get('/api/teacher/profile', adminCookie)).status, 403);

    for (const [role, cookie] of [['teacher', teacherCookie], ['student', studentCookie]]) {
      const forbiddenEdit = await fetch(`${base}/api/admin/teachers/${createdId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'Unauthorized Edit' }),
        redirect: 'manual',
      });
      assert.equal(forbiddenEdit.status, 302, `${role} role cannot edit teacher records`);

      const forbiddenAssignments = await fetch(`${base}/api/admin/teachers/${createdId}/subjects`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ subjectIds: [] }),
        redirect: 'manual',
      });
      assert.equal(forbiddenAssignments.status, 302, `${role} role cannot update subject assignments`);
    }
  } finally {
    app.locals.sendTeacherInvitationEmail = originalMailer;
    if (createdId) await pool.execute('DELETE FROM users WHERE id = ?', [createdId]);
    if (subjectId) await pool.execute('DELETE FROM subjects WHERE id = ?', [subjectId]);
    if (secondSubjectId) await pool.execute('DELETE FROM subjects WHERE id = ?', [secondSubjectId]);
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
