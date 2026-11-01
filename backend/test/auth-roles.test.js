require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const assert = require('node:assert/strict');
const { test } = require('node:test');
const bcrypt = require('bcrypt');
const app = require('../app');
const pool = require('../database/pool');

test('administrator, teacher, and student test credentials and route roles', { timeout: 30000 }, async () => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
    redirect: 'manual'
  });
  const login = async (identifier, password) => {
    const response = await post('/api/auth/login', { identifier, password });
    return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };

  try {
    const unauthenticatedDashboard = await fetch(`${base}/admin/dashboard`, { redirect: 'manual' });
    assert.equal(unauthenticatedDashboard.status, 302, 'unauthenticated dashboard access is redirected');
    assert.equal(unauthenticatedDashboard.headers.get('location'), '/login');

    const cases = [
      { loginId: 'admin', password: 'admin001', role: 'administrator', dashboard: '/admin/dashboard', blocked: [] },
      { loginId: 'Teacher', password: 'teacher123', role: 'teacher', dashboard: '/teacher/dashboard', blocked: ['/admin/dashboard'] },
      { loginId: 'Nikhil', password: 'nik001', role: 'student', dashboard: '/student/dashboard', blocked: ['/teacher/dashboard', '/admin/dashboard'] },
      { loginId: 'Student', password: 'student123', role: 'student', dashboard: '/student/dashboard', blocked: ['/teacher/dashboard', '/admin/dashboard'] }
    ];

    for (const account of cases) {
      const [accountRows] = await pool.execute(
        'SELECT login_id AS loginId, role, is_active AS active, password_hash AS passwordHash FROM users WHERE login_id = ?',
        [account.loginId]
      );
      assert.equal(accountRows.length, 1, `${account.loginId} has exactly one matching account`);
      assert.equal(accountRows[0].loginId, account.loginId, 'login ID case is preserved');
      assert.equal(accountRows[0].role, account.role, 'stored role is unchanged');
      assert.equal(!!accountRows[0].active, true, 'account is active');
      assert.equal(bcrypt.getRounds(accountRows[0].passwordHash), 12, 'password is stored as a bcrypt hash with 12 rounds');
      assert.equal(await bcrypt.compare(account.password, accountRows[0].passwordHash), true, 'stored bcrypt hash matches the documented password');

      const { response, cookie } = await login(account.loginId, account.password);
      assert.equal(response.status, 200, `${account.role} test login succeeds`);
      assert.ok(cookie, `${account.role} receives a session cookie`);
      assert.deepEqual(await response.json(), { redirectTo: account.dashboard });
      const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie }, redirect: 'manual' });
      assert.equal(me.status, 200);
      assert.equal((await me.json()).user.role, account.role);
      const ownDashboard = await fetch(`${base}${account.dashboard}`, { headers: { Cookie: cookie }, redirect: 'manual' });
      assert.equal(ownDashboard.status, 200, `${account.role} can open their dashboard`);
      for (const blockedPath of account.blocked) {
        const blocked = await fetch(`${base}${blockedPath}`, { headers: { Cookie: cookie }, redirect: 'manual' });
        assert.equal(blocked.status, 302, `${account.role} is redirected away from ${blockedPath}`);
        assert.equal(blocked.headers.get('location'), account.dashboard);
      }
      if (account.role === 'administrator') {
        const logout = await post('/api/auth/logout', {}, cookie);
        assert.equal(logout.status, 200, 'existing logout API works');
        const afterLogout = await fetch(`${base}/admin/dashboard`, { headers: { Cookie: cookie }, redirect: 'manual' });
        assert.equal(afterLogout.status, 302, 'logged-out admin cannot reopen protected dashboard');
        assert.equal(afterLogout.headers.get('location'), '/login');
      }
    }

    assert.equal((await login('admin', 'wrong-password')).response.status, 401, 'wrong password is rejected');
    assert.equal((await login('unregistered-test-id', 'password123')).response.status, 401, 'unknown login is rejected');
    assert.equal((await post('/api/auth/login', { identifier: '', password: '' })).status, 400, 'blank credentials are rejected');

    const [students] = await pool.execute("SELECT id, is_active AS active FROM users WHERE login_id = 'Student' AND role = 'student' LIMIT 1");
    assert.equal(students.length, 1);
    try {
      await pool.execute('UPDATE users SET is_active = FALSE WHERE id = ?', [students[0].id]);
      assert.equal((await login('Student', 'student123')).response.status, 401, 'inactive account is rejected');
    } finally {
      await pool.execute('UPDATE users SET is_active = ? WHERE id = ?', [students[0].active, students[0].id]);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
});
