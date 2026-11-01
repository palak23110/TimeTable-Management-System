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
  let shouldFailDelivery = false;
  const deliveredPasswords = [];
  const email = `tc-teacher-${Date.now()}@example.invalid`;

  app.locals.sendTeacherInvitationEmail = async (invitation) => {
    assert.equal(invitation.email, email);
    if (shouldFailDelivery) throw new Error('Mock SMTP failure');
    deliveredPasswords.push(invitation.temporaryPassword);
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
      email: 'invalid',
      contactNumber: 'abc',
    }, adminCookie);
    assert.equal(invalid.status, 400, 'required fields are validated');

    shouldFailDelivery = true;
    const createResponse = await post('/api/admin/teachers', {
      name: 'TC Test Teacher',
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

    const firstTemporaryPassword = deliveredPasswords.at(-1);
    assert.match(firstTemporaryPassword, new RegExp(`^${email.slice(0, 4)}\\d{4}$`));
    assert.equal(firstTemporaryPassword.length, 8);
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
    assert.equal(await bcrypt.compare(firstTemporaryPassword, account.passwordHash), true);
    assert.notEqual(account.passwordHash, firstTemporaryPassword);

    const [profiles] = await pool.execute(`
      SELECT teacher_id AS teacherId, contact_number AS contactNumber,
        department, designation, highest_qualification AS qualification
      FROM teacher_profiles
      WHERE user_id = ?
    `, [createdId]);
    assert.match(profiles[0].teacherId, /^TCH-\d+$/);
    assert.equal(profiles[0].contactNumber, '+1 555 010 1234');
    assert.equal(profiles[0].department, null);
    assert.equal(profiles[0].designation, null);
    assert.equal(profiles[0].qualification, null);

    const [subjectInsert] = await pool.execute(
      'INSERT INTO subjects (subject_name, is_active) VALUES (?, TRUE)',
      [`TC Subject ${Date.now()}`],
    );
    subjectId = subjectInsert.insertId;
    await pool.execute(
      'INSERT INTO teacher_subjects (teacher_user_id, subject_id) VALUES (?, ?)',
      [createdId, subjectId],
    );

    const filtered = await (await get(
      `/api/admin/teachers?subject=${subjectId}`,
      adminCookie,
    )).json();
    assert.equal(filtered.total, 1, 'subject filter finds an assigned teacher');
    assert.equal(filtered.teachers[0].subjectNames.length, 1);

    const duplicate = await post('/api/admin/teachers', {
      name: 'Duplicate',
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
    assert.equal(
      await bcrypt.compare(firstTemporaryPassword, afterFailedResend[0].passwordHash),
      true,
      'failed resend keeps the last delivered temporary password valid',
    );

    shouldFailDelivery = false;
    const successfulResend = await post(
      `/api/admin/teachers/${createdId}/resend-invitation`,
      {},
      adminCookie,
    );
    assert.equal(successfulResend.status, 200);
    assert.equal((await successfulResend.json()).invitationSent, true);
    const currentTemporaryPassword = deliveredPasswords.at(-1);
    assert.notEqual(currentTemporaryPassword, firstTemporaryPassword);

    const [resentAccounts] = await pool.execute(`
      SELECT password_hash AS passwordHash
      FROM users
      WHERE id = ?
    `, [createdId]);
    account = resentAccounts[0];
    assert.equal(await bcrypt.getRounds(account.passwordHash), 12);
    assert.equal(await bcrypt.compare(currentTemporaryPassword, account.passwordHash), true);

    const stats = await (await get('/api/admin/teachers/stats', adminCookie)).json();
    assert.ok(stats.stats.total >= 1);

    const teacherLogin = await post('/api/auth/login', {
      identifier: email,
      password: currentTemporaryPassword,
    });
    assert.equal(teacherLogin.status, 200);
    assert.equal((await teacherLogin.json()).redirectTo, '/change-password');
    teacherCookie = teacherLogin.headers.get('set-cookie')?.split(';')[0];
    assert.equal((await get('/teacher/dashboard', teacherCookie)).status, 302);
    assert.equal((await get('/change-password', teacherCookie)).status, 200);

    const invalidChange = await post('/api/auth/change-password', {
      password: 'short',
      confirmPassword: 'short',
    }, teacherCookie);
    assert.equal(invalidChange.status, 400);

    const unchangedPassword = await post('/api/auth/change-password', {
      password: currentTemporaryPassword,
      confirmPassword: currentTemporaryPassword,
    }, teacherCookie);
    assert.equal(unchangedPassword.status, 400);

    const changedPassword = await post('/api/auth/change-password', {
      password: 'NewPass123',
      confirmPassword: 'NewPass123',
    }, teacherCookie);
    assert.equal(changedPassword.status, 200, await changedPassword.clone().text());
    assert.equal((await changedPassword.json()).redirectTo, '/teacher/dashboard');

    const [updatedRows] = await pool.execute(`
      SELECT password_hash AS passwordHash, must_change_password AS mustChangePassword
      FROM users
      WHERE id = ?
    `, [createdId]);
    assert.equal(Number(updatedRows[0].mustChangePassword), 0);
    assert.equal(await bcrypt.compare('NewPass123', updatedRows[0].passwordHash), true);
    assert.equal((await post('/api/auth/login', {
      identifier: email,
      password: 'NewPass123',
    })).status, 200);
    assert.equal((await post('/api/auth/login', {
      identifier: email,
      password: currentTemporaryPassword,
    })).status, 401);
  } finally {
    app.locals.sendTeacherInvitationEmail = originalMailer;
    if (createdId) await pool.execute('DELETE FROM users WHERE id = ?', [createdId]);
    if (subjectId) await pool.execute('DELETE FROM subjects WHERE id = ?', [subjectId]);
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
