const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const pool = require('./pool');

async function migrate() {
  const [columns] = await pool.execute(
    "SELECT COLUMN_NAME, CHARACTER_MAXIMUM_LENGTH FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND COLUMN_NAME IN ('login_id','must_change_password')"
  );
  const loginColumn = columns.find(column => column.COLUMN_NAME === 'login_id');
  if (!loginColumn) throw new Error('users.login_id is missing; migration stopped.');
  if (Number(loginColumn.CHARACTER_MAXIMUM_LENGTH) < 254) {
    await pool.execute('ALTER TABLE users MODIFY login_id VARCHAR(254) NOT NULL');
  }
  if (!columns.some(column => column.COLUMN_NAME === 'must_change_password')) {
    await pool.execute('ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE AFTER is_active');
  }

  await pool.execute(`CREATE TABLE IF NOT EXISTS teacher_profiles (
    user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    teacher_id VARCHAR(24) NOT NULL,
    contact_number VARCHAR(32) NULL,
    department VARCHAR(160) NULL,
    designation VARCHAR(160) NULL,
    highest_qualification VARCHAR(180) NULL,
    university_institution VARCHAR(180) NULL,
    specialization VARCHAR(180) NULL,
    years_of_experience DECIMAL(5,2) NULL,
    previous_organization VARCHAR(180) NULL,
    previous_job_role VARCHAR(160) NULL,
    previous_job_responsibilities TEXT NULL,
    skills_areas_of_expertise TEXT NULL,
    professional_summary TEXT NULL,
    invitation_pending BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_teacher_profiles_teacher_id (teacher_id),
    CONSTRAINT fk_teacher_profiles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS subjects (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    subject_code VARCHAR(40) NULL,
    subject_name VARCHAR(160) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_subjects_code (subject_code),
    UNIQUE KEY uq_subjects_name (subject_name)
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS teacher_subjects (
    teacher_user_id BIGINT UNSIGNED NOT NULL,
    subject_id BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (teacher_user_id, subject_id),
    KEY ix_teacher_subjects_subject (subject_id),
    CONSTRAINT fk_teacher_subjects_teacher FOREIGN KEY (teacher_user_id) REFERENCES teacher_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_teacher_subjects_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);

  await pool.execute(`INSERT IGNORE INTO teacher_profiles (user_id, teacher_id, contact_number, invitation_pending)
    SELECT id, CONCAT('TCH-', LPAD(id, 4, '0')), NULL, FALSE FROM users WHERE role = 'teacher'`);
  console.log('Teacher-management schema is ready; existing teachers received empty profile rows.');
}

migrate().catch(error => {
  console.error(`Teacher-management migration failed (${error.code || 'database error'}).`);
  process.exitCode = 1;
}).finally(() => pool.end());
