const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const pool = require('./pool');

async function columnExists(table, column) {
  const [rows] = await pool.execute(`
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
    LIMIT 1
  `, [table, column]);
  return rows.length > 0;
}

async function migrate() {
  if (!(await columnExists('teacher_profiles', 'updated_at'))) {
    await pool.execute(`
      ALTER TABLE teacher_profiles
      ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    `);
  }
  if (!(await columnExists('teacher_profiles', 'updated_by_user_id'))) {
    await pool.execute(`
      ALTER TABLE teacher_profiles
      ADD COLUMN updated_by_user_id BIGINT UNSIGNED NULL
    `);
  }
  if (!(await columnExists('teacher_profiles', 'updated_by_role'))) {
    await pool.execute(`
      ALTER TABLE teacher_profiles
      ADD COLUMN updated_by_role ENUM('administrator','teacher') NULL
    `);
  }

  const [constraints] = await pool.execute(`
    SELECT CONSTRAINT_NAME
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'teacher_profiles'
      AND COLUMN_NAME = 'updated_by_user_id'
      AND REFERENCED_TABLE_NAME = 'users'
    LIMIT 1
  `);
  if (!constraints.length) {
    await pool.execute(`
      ALTER TABLE teacher_profiles
      ADD CONSTRAINT fk_teacher_profiles_updated_by
      FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    `);
  }

  console.log('Teacher profile audit metadata is ready.');
}

migrate()
  .catch((error) => {
    console.error(`Teacher profile audit migration failed (${error.code || 'database error'}).`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
