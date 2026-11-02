'use strict';

require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const app = require('../app');
const pool = require('../database/pool');
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

test('live teacher invitation acceptance, rejection and login flow', { timeout: 60000 }, async () => {
  const liveBase = process.env.INVITATION_E2E_URL || 'http://localhost:3000';
  const originalMailer = app.locals.sendTeacherInvitationEmail;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const mailByEmail = new Map();
  const teacherFixtures = [];
  const setupServer = app.listen(0);
  await new Promise((resolve, reject) => {
    setupServer.once('listening', resolve);
    setupServer.once('error', reject);
  });
  const setupBase = `http://127.0.0.1:${setupServer.address().port}`;

  const post = (base, route, body, cookie) => fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  const get = (route, cookie) => fetch(`${liveBase}${route}`, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: 'manual',
  });

  app.locals.sendTeacherInvitationEmail = async (invitation) => {
    mailByEmail.set(invitation.email, invitation);
  };

  async function createTeacher(adminCookie, label) {
    const email = `invite-${label}-${suffix}@example.invalid`;
    const teacherId = `I-${label}-${suffix}`;
    const response = await post(setupBase, '/api/admin/teachers', {
      name: `Invitation ${label} ${suffix}`, teacherId, email, contactNumber: '+1 555 010 1212',
    }, adminCookie);
    assert.equal(response.status, 201, await response.clone().text());
    const data = await response.json();
    teacherFixtures.push(data.teacher.id);
    const mail = mailByEmail.get(email);
    assert.ok(mail?.invitationToken, 'mocked invitation email received a one-time token');
    assert.ok(mail?.temporaryPassword, 'mocked invitation email received the initial credential');
    assert.equal(data.temporaryPassword, undefined, 'temporary credentials are not returned by the API');
    return { ...mail, userId: data.teacher.id };
  }

  try {
    const adminLogin = await post(setupBase, '/api/auth/login', { identifier: 'admin', password: 'admin001' });
    assert.equal(adminLogin.status, 200);
    const adminCookie = adminLogin.headers.get('set-cookie')?.split(';')[0];
    assert.ok(adminCookie);

    const invited = await createTeacher(adminCookie, 'Accept');
    const invitationPage = await get(`/accept-invitation?token=${encodeURIComponent(invited.invitationToken)}`);
    assert.equal(invitationPage.status, 200, 'the email link opens the invitation screen');
    const pageText = await invitationPage.text();
    assert.match(pageText, /Accept Invitation/);
    assert.match(pageText, /Reject Invitation/);
    assert.doesNotMatch(pageText, /type="password"/);
    const invitationScript = await get('/js/invitation.js');
    assert.equal(invitationScript.status, 200);
    const invitationScriptText = await invitationScript.text();
    assert.match(invitationScriptText, /submit\('accept'\)/);
    assert.match(invitationScriptText, /window\.confirm/);

    const invalid = await post(liveBase, '/api/auth/accept-invitation', {
      token: 'invalid-token',
    });
    assert.equal(invalid.status, 400, 'invalid invitation token is rejected');
    const expiredHash = tokenHash(invited.invitationToken);
    await pool.execute('UPDATE user_invitation_tokens SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE token_hash = ?', [expiredHash]);
    const expired = await post(liveBase, '/api/auth/accept-invitation', { token: invited.invitationToken });
    assert.equal(expired.status, 400, 'expired invitation token is rejected');
    await pool.execute('UPDATE user_invitation_tokens SET expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR) WHERE token_hash = ?', [expiredHash]);

    const preAcceptanceLogin = await post(liveBase, '/api/auth/login', {
      identifier: invited.email, password: invited.temporaryPassword,
    });
    assert.equal(preAcceptanceLogin.status, 401, 'teacher cannot sign in before accepting the invitation');

    const acceptResponse = await post(liveBase, '/api/auth/accept-invitation', { token: invited.invitationToken });
    assert.equal(acceptResponse.status, 200, await acceptResponse.clone().text());
    assert.deepEqual(await acceptResponse.json(), {
      message: 'Invitation accepted. Sign in with the credentials in your invitation email.',
      redirectTo: '/login?invitation=accepted',
    });
    assert.equal(acceptResponse.headers.get('set-cookie'), null, 'acceptance itself does not create a login session');

    const acceptedReplay = await post(liveBase, '/api/auth/accept-invitation', { token: invited.invitationToken });
    assert.equal(acceptedReplay.status, 400, 'accepted token cannot be reused');
    const loginPage = await get('/login?invitation=accepted');
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /Sign in securely/);
    const normalLogin = await post(liveBase, '/api/auth/login', {
      identifier: invited.email, password: invited.temporaryPassword,
    });
    assert.equal(normalLogin.status, 200);
    assert.equal((await normalLogin.json()).redirectTo, '/teacher/dashboard');
    const setCookie = normalLogin.headers.get('set-cookie') || '';
    assert.match(setCookie, /bmu_ttms_session=/);
    assert.match(setCookie, /Path=\//i);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.doesNotMatch(setCookie, /Secure/i, 'local development uses an HTTP-compatible cookie');
    const teacherCookie = setCookie.split(';')[0];
    assert.equal((await get('/api/auth/me', teacherCookie)).status, 200);
    const authData = await (await get('/api/auth/me', teacherCookie)).json();
    assert.equal(authData.user.role, 'teacher');
    assert.equal(Number(authData.user.mustChangePassword), 0);
    assert.equal((await get('/teacher/dashboard', teacherCookie)).status, 200);
    assert.equal((await get('/api/teacher/profile', teacherCookie)).status, 200);
    assert.equal((await get('/api/teacher/timetable', teacherCookie)).status, 200);
    assert.equal((await get('/teacher/dashboard', teacherCookie)).status, 200, 'refresh retains the authenticated session');
    const changePassword = await get('/change-password', teacherCookie);
    assert.equal(changePassword.status, 302);
    assert.equal(changePassword.headers.get('location'), '/teacher/dashboard');

    const [acceptedRows] = await pool.execute(`
      SELECT u.is_active AS isActive, u.must_change_password AS mustChangePassword,
        p.invitation_setup_required AS setupRequired, t.accepted_at AS acceptedAt
      FROM users u JOIN teacher_profiles p ON p.user_id = u.id
      JOIN user_invitation_tokens t ON t.user_id = u.id WHERE u.id = ?
    `, [invited.userId]);
    assert.equal(Number(acceptedRows[0].isActive), 1);
    assert.equal(Number(acceptedRows[0].mustChangePassword), 0);
    assert.equal(Number(acceptedRows[0].setupRequired), 0);
    assert.ok(acceptedRows[0].acceptedAt);

    const rejected = await createTeacher(adminCookie, 'Reject');
    const rejectResponse = await post(liveBase, '/api/auth/reject-invitation', { token: rejected.invitationToken });
    assert.equal(rejectResponse.status, 200);
    assert.match((await rejectResponse.json()).message, /invitation has been rejected/i);
    const rejectedAgain = await post(liveBase, '/api/auth/accept-invitation', { token: rejected.invitationToken });
    assert.equal(rejectedAgain.status, 400, 'rejected token cannot be accepted');
    const rejectedLogin = await post(liveBase, '/api/auth/login', {
      identifier: rejected.email, password: rejected.temporaryPassword,
    });
    assert.equal(rejectedLogin.status, 401);
    const [rejectedRows] = await pool.execute(`
      SELECT u.is_active AS isActive, t.rejected_at AS rejectedAt
      FROM users u JOIN user_invitation_tokens t ON t.user_id = u.id WHERE u.id = ?
    `, [rejected.userId]);
    assert.equal(Number(rejectedRows[0].isActive), 0);
    assert.ok(rejectedRows[0].rejectedAt);

    const [forcedHash] = await pool.execute('SELECT password_hash AS passwordHash FROM users WHERE id = ?', [invited.userId]);
    const forcedFlag = await pool.execute('UPDATE users SET must_change_password = TRUE WHERE id = ?', [invited.userId]);
    assert.equal(forcedFlag[0].affectedRows, 1);
    const forcedLogin = await post(liveBase, '/api/auth/login', {
      identifier: invited.email, password: invited.temporaryPassword,
    });
    assert.equal(forcedLogin.status, 200);
    assert.equal((await forcedLogin.json()).redirectTo, '/change-password', 'genuine forced changes remain enforced');
    await pool.execute('UPDATE users SET must_change_password = FALSE WHERE id = ?', [invited.userId]);
    assert.ok(forcedHash[0].passwordHash);
  } finally {
    app.locals.sendTeacherInvitationEmail = originalMailer;
    await new Promise((resolve) => setupServer.close(resolve));
    for (const userId of teacherFixtures) await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
    await pool.end();
  }
});
