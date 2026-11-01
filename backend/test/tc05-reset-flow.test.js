require('dotenv').config({
  path: require('node:path').resolve(__dirname, '../../.env'),
});

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const bcrypt = require('bcrypt');

// Use the real Express routes and MySQL store while capturing, not sending, mail.
const mail = require('../services/mail');
let mailedToken;
mail.sendPasswordResetEmail = async (_email, token) => {
  mailedToken = token;
};

const app = require('../app');
const pool = require('../database/pool');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const genericResponse = {
  message: 'If an account matches that email, a reset link will be sent shortly.',
};

test('TC05 reset tokens, password update, session revocation and teacher login', {
  timeout: 30000,
}, async () => {
  const suffix = randomUUID();
  const email = `tc05-${suffix}@example.invalid`;
  const oldPassword = 'InitialPass123';
  const newPassword = 'NewPass8';
  let userId;
  let server;

  try {
    const initialHash = await bcrypt.hash(oldPassword, 4);
    const [insert] = await pool.execute(`
      INSERT INTO users (
        name, login_id, email, password_hash, role, is_active, must_change_password
      )
      VALUES (?, ?, ?, ?, 'teacher', TRUE, TRUE)
    `, ['TC05 integration fixture', email, email, initialHash]);
    userId = insert.insertId;

    await pool.execute(`
      INSERT INTO teacher_profiles (user_id, teacher_id, invitation_pending)
      VALUES (?, ?, TRUE)
    `, [userId, `TC05-${suffix.slice(0, 12)}`]);

    server = app.listen(0);
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body, headers = {}) => fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'manual',
    });

    const loginBefore = await post('/api/auth/login', {
      identifier: email,
      password: oldPassword,
    });
    assert.equal(loginBefore.status, 200, 'fixture teacher can log in before reset');
    assert.deepEqual(await loginBefore.json(), { redirectTo: '/change-password' });

    const cookie = loginBefore.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'login establishes a session cookie');
    const sessionBefore = await fetch(`${base}/api/auth/me`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(sessionBefore.status, 200, 'the pre-reset session is valid');

    mailedToken = undefined;
    const forgotRegistered = await post('/api/auth/forgot-password', { email });
    const registeredResponse = await forgotRegistered.json();
    assert.equal(forgotRegistered.status, 200);
    assert.deepEqual(registeredResponse, genericResponse);

    const expiredToken = mailedToken;
    assert.ok(expiredToken, 'registered account invokes the reset mail service');
    assert.equal(expiredToken.length, 43, 'reset token has 256 bits of random input');

    const [storedFirst] = await pool.execute(`
      SELECT token_hash, expires_at, used_at
      FROM password_reset_tokens
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 1
    `, [userId]);
    assert.equal(storedFirst[0].token_hash, hash(expiredToken));
    assert.notEqual(storedFirst[0].token_hash, expiredToken);

    const forgotUnknown = await post('/api/auth/forgot-password', {
      email: `missing-${suffix}@example.invalid`,
    });
    assert.equal(forgotUnknown.status, forgotRegistered.status);
    assert.deepEqual(await forgotUnknown.json(), registeredResponse);

    await pool.execute(`
      UPDATE password_reset_tokens
      SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)
      WHERE token_hash = ?
    `, [hash(expiredToken)]);
    const expiredResponse = await post('/api/auth/reset-password', {
      token: expiredToken,
      password: newPassword,
      confirmPassword: newPassword,
    });
    assert.equal(expiredResponse.status, 400, 'expired token is rejected');

    mailedToken = undefined;
    const secondForgot = await post('/api/auth/forgot-password', { email });
    assert.deepEqual(await secondForgot.json(), genericResponse);
    const validToken = mailedToken;
    assert.ok(validToken && validToken !== expiredToken);

    const [storedSecond] = await pool.execute(`
      SELECT token_hash, expires_at
      FROM password_reset_tokens
      WHERE token_hash = ?
    `, [hash(validToken)]);
    assert.equal(storedSecond.length, 1);
    const expiresIn = new Date(storedSecond[0].expires_at).getTime() - Date.now();
    assert.ok(expiresIn > 29 * 60 * 1000 && expiresIn <= 30 * 60 * 1000);

    const resetPage = await fetch(
      `${base}/reset-password?token=${encodeURIComponent(validToken)}`,
    );
    assert.equal(resetPage.status, 200);
    assert.match(await resetPage.text(), /id="reset-form"/);

    const tooShort = await post('/api/auth/reset-password', {
      token: validToken,
      password: 'Short7!',
      confirmPassword: 'Short7!',
    });
    assert.equal(tooShort.status, 400);

    const mismatch = await post('/api/auth/reset-password', {
      token: validToken,
      password: newPassword,
      confirmPassword: 'Different8',
    });
    assert.equal(mismatch.status, 400);

    const reset = await post('/api/auth/reset-password', {
      token: validToken,
      password: newPassword,
      confirmPassword: newPassword,
    });
    assert.equal(reset.status, 200, 'an eight-character password is accepted');

    const replay = await post('/api/auth/reset-password', {
      token: validToken,
      password: newPassword,
      confirmPassword: newPassword,
    });
    assert.equal(replay.status, 400, 'used token cannot be replayed');

    const [userRows] = await pool.execute(`
      SELECT password_hash, must_change_password
      FROM users
      WHERE id = ?
    `, [userId]);
    assert.notEqual(userRows[0].password_hash, newPassword);
    assert.equal(await bcrypt.compare(newPassword, userRows[0].password_hash), true);
    assert.equal(Number(userRows[0].must_change_password), 0);

    const [profileRows] = await pool.execute(`
      SELECT invitation_pending
      FROM teacher_profiles
      WHERE user_id = ?
    `, [userId]);
    assert.equal(Number(profileRows[0].invitation_pending), 0);

    const [sessions] = await pool.execute(`
      SELECT COUNT(*) AS count
      FROM sessions
      WHERE user_id = ? AND revoked_at IS NOT NULL
    `, [userId]);
    assert.ok(sessions[0].count >= 1, 'existing session was revoked');

    const sessionAfter = await fetch(`${base}/api/auth/me`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(sessionAfter.status, 302, 'old session cannot access authenticated API');

    const oldLogin = await post('/api/auth/login', {
      identifier: email,
      password: oldPassword,
    });
    assert.equal(oldLogin.status, 401);

    const smtpKeys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'];
    const smtpValues = Object.fromEntries(smtpKeys.map((key) => [key, process.env[key]]));
    smtpKeys.forEach((key) => delete process.env[key]);
    const newLogin = await post('/api/auth/login', {
      identifier: email,
      password: newPassword,
    });
    for (const [key, value] of Object.entries(smtpValues)) {
      if (value !== undefined) process.env[key] = value;
    }
    assert.equal(newLogin.status, 200);
    assert.deepEqual(await newLogin.json(), { redirectTo: '/teacher/dashboard' });

    const deliveryLogs = [];
    const originalLogger = app.locals.logger;
    const originalSender = app.locals.sendPasswordResetEmail;
    app.locals.logger = { error: (...parts) => deliveryLogs.push(parts.join(' ')) };
    app.locals.sendPasswordResetEmail = async () => {
      throw new Error('fake sensitive test error');
    };

    const smtpFailure = await post('/api/auth/forgot-password', { email });
    assert.deepEqual(await smtpFailure.json(), genericResponse);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(deliveryLogs, ['Password reset email delivery failed.']);

    app.locals.sendPasswordResetEmail = originalSender;
    app.locals.logger = originalLogger;
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (userId) await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
    await pool.end();
  }
});
