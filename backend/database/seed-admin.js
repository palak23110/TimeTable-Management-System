require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('./pool');
async function seed() {
  const { ADMIN_NAME, ADMIN_LOGIN_ID, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_NAME || !ADMIN_LOGIN_ID || !ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) throw new Error('Set ADMIN_NAME, ADMIN_LOGIN_ID, ADMIN_EMAIL and ADMIN_PASSWORD (minimum 8 characters) in .env');
  const [admins] = await pool.execute("SELECT id FROM users WHERE role = 'administrator' LIMIT 1");
  if (admins.length) throw new Error('An administrator already exists; refusing to create a duplicate.');
  const [duplicates] = await pool.execute('SELECT id FROM users WHERE login_id = ? OR email = ? LIMIT 1', [ADMIN_LOGIN_ID, ADMIN_EMAIL]);
  if (duplicates.length) throw new Error('The configured administrator login ID or email is already in use.');
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await pool.execute("INSERT INTO users (name, login_id, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, 'administrator', TRUE)", [ADMIN_NAME, ADMIN_LOGIN_ID, ADMIN_EMAIL, passwordHash]);
  console.log(`Created administrator account for ${ADMIN_EMAIL}.`);
}
seed().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
