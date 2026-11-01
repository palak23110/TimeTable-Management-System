const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const bcrypt = require('bcrypt');
const pool = require('./pool');

// Development-only credentials mirror the local TEST_CREDENTIALS.md reference.
const accounts = [
  { loginId: 'admin', password: 'admin001', role: 'administrator' },
  { loginId: 'Teacher', password: 'teacher123', role: 'teacher' },
  { loginId: 'Nikhil', password: 'nik001', role: 'student' },
  { loginId: 'Student', password: 'student123', role: 'student' }
];

async function seedTestAccounts() {
  if (process.env.NODE_ENV !== 'development' || process.env.SEED_TEST_ACCOUNTS !== 'true') {
    throw new Error('Refusing to seed: set NODE_ENV=development and explicitly set SEED_TEST_ACCOUNTS=true.');
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const resolved = [];
    for (const account of accounts) {
      const [rows] = await connection.execute(
        'SELECT id, login_id AS loginId, role, is_active AS active FROM users WHERE login_id = ? FOR UPDATE',
        [account.loginId]
      );
      const row = rows.find(candidate => candidate.loginId === account.loginId);
      if (rows.length !== 1 || !row) throw new Error(`Expected exactly one account with the exact login ID ${account.loginId}; no users were changed.`);
      if (row.role !== account.role) throw new Error(`Role mismatch for login ID ${account.loginId}; no users were changed.`);
      if (!row.active) throw new Error(`Account ${account.loginId} is inactive; no users were changed.`);
      resolved.push({ id: row.id, account });
    }

    const hashes = await Promise.all(resolved.map(({ account }) => bcrypt.hash(account.password, 12)));
    if (hashes.some(passwordHash => bcrypt.getRounds(passwordHash) !== 12)) {
      throw new Error('bcrypt cost verification failed; no users were changed.');
    }
    for (let index = 0; index < resolved.length; index += 1) {
      await connection.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hashes[index], resolved[index].id]);
    }
    await connection.commit();
    console.log('Updated bcrypt password hashes for the four verified active development accounts.');
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

seedTestAccounts().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
