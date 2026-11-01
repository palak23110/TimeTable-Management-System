'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const pool = require('./pool');

async function createTables() {
  const [subjectIndexes] = await pool.execute(`
    SELECT index_name AS indexName, non_unique AS nonUnique
    FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'subjects'
  `);
  const indexNames = new Set(subjectIndexes.map((row) => row.indexName));
  if (indexNames.has('uq_subjects_code')) await pool.execute('ALTER TABLE subjects DROP INDEX uq_subjects_code');
  if (indexNames.has('uq_subjects_name')) await pool.execute('ALTER TABLE subjects DROP INDEX uq_subjects_name');
  if (!indexNames.has('ix_subjects_code')) await pool.execute('CREATE INDEX ix_subjects_code ON subjects (subject_code)');
  if (!indexNames.has('ix_subjects_name')) await pool.execute('CREATE INDEX ix_subjects_name ON subjects (subject_name)');
  await pool.execute('ALTER TABLE subjects MODIFY subject_code VARCHAR(60) NULL, MODIFY subject_name VARCHAR(255) NOT NULL');

  await pool.execute(`CREATE TABLE IF NOT EXISTS curriculum_subjects (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    subject_id BIGINT UNSIGNED NULL,
    programme_id BIGINT UNSIGNED NULL,
    branch_option_id BIGINT UNSIGNED NULL,
    semester_id BIGINT UNSIGNED NULL,
    course_name VARCHAR(255) NOT NULL,
    course_code VARCHAR(60) NULL,
    semester_label VARCHAR(80) NULL,
    course_year VARCHAR(40) NULL,
    credits DECIMAL(5,2) NULL,
    credits_raw VARCHAR(40) NULL,
    category VARCHAR(120) NULL,
    record_status ENUM('published','choice_required','conditional','area_only','needs_review','partial','manual') NOT NULL DEFAULT 'manual',
    source_data_status VARCHAR(100) NULL,
    source_worksheet VARCHAR(120) NULL,
    source_row INT UNSIGNED NULL,
    source_url VARCHAR(600) NULL,
    notes TEXT NULL,
    mapping_hash CHAR(64) NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_curriculum_subjects_mapping_hash (mapping_hash),
    KEY ix_curriculum_subjects_filters (programme_id, branch_option_id, semester_id, record_status, is_active),
    KEY ix_curriculum_subjects_course_code (course_code),
    CONSTRAINT fk_curriculum_subjects_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL,
    CONSTRAINT fk_curriculum_subjects_programme FOREIGN KEY (programme_id) REFERENCES academic_programmes(id) ON DELETE RESTRICT,
    CONSTRAINT fk_curriculum_subjects_option FOREIGN KEY (branch_option_id) REFERENCES academic_options(id) ON DELETE RESTRICT,
    CONSTRAINT fk_curriculum_subjects_semester FOREIGN KEY (semester_id) REFERENCES academic_semesters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_curriculum_subjects_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);

  const [curriculumColumns] = await pool.execute(`
    SELECT column_name AS columnName FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'curriculum_subjects'
  `);
  if (!curriculumColumns.some((column) => column.columnName === 'source_data_status')) {
    await pool.execute('ALTER TABLE curriculum_subjects ADD COLUMN source_data_status VARCHAR(100) NULL AFTER record_status');
  }

  await pool.execute(`CREATE TABLE IF NOT EXISTS class_course_assignments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    section_id BIGINT UNSIGNED NOT NULL,
    curriculum_subject_id BIGINT UNSIGNED NOT NULL,
    created_by_user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_class_course_assignment (section_id, curriculum_subject_id),
    CONSTRAINT fk_class_course_section FOREIGN KEY (section_id) REFERENCES academic_sections(id) ON DELETE CASCADE,
    CONSTRAINT fk_class_course_curriculum FOREIGN KEY (curriculum_subject_id) REFERENCES curriculum_subjects(id) ON DELETE CASCADE,
    CONSTRAINT fk_class_course_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);

  await pool.execute(`CREATE TABLE IF NOT EXISTS teacher_course_assignments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    teacher_user_id BIGINT UNSIGNED NOT NULL,
    section_id BIGINT UNSIGNED NOT NULL,
    curriculum_subject_id BIGINT UNSIGNED NOT NULL,
    created_by_user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_teacher_course_assignment (teacher_user_id, section_id, curriculum_subject_id),
    CONSTRAINT fk_teacher_course_teacher FOREIGN KEY (teacher_user_id) REFERENCES teacher_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_teacher_course_section FOREIGN KEY (section_id) REFERENCES academic_sections(id) ON DELETE CASCADE,
    CONSTRAINT fk_teacher_course_curriculum FOREIGN KEY (curriculum_subject_id) REFERENCES curriculum_subjects(id) ON DELETE CASCADE,
    CONSTRAINT fk_teacher_course_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);

  await pool.execute(`CREATE TABLE IF NOT EXISTS student_course_assignments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    student_profile_id BIGINT UNSIGNED NOT NULL,
    curriculum_subject_id BIGINT UNSIGNED NOT NULL,
    assignment_action ENUM('include','exclude') NOT NULL DEFAULT 'include',
    created_by_user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_student_course_assignment (student_profile_id, curriculum_subject_id),
    CONSTRAINT fk_student_course_student FOREIGN KEY (student_profile_id) REFERENCES student_profiles(id) ON DELETE CASCADE,
    CONSTRAINT fk_student_course_curriculum FOREIGN KEY (curriculum_subject_id) REFERENCES curriculum_subjects(id) ON DELETE CASCADE,
    CONSTRAINT fk_student_course_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);

  await pool.execute(`
    INSERT IGNORE INTO curriculum_subjects (
      subject_id, course_name, course_code, record_status, mapping_hash
    )
    SELECT id, subject_name, subject_code, 'manual', SHA2(CONCAT('legacy-subject:', id), 256)
    FROM subjects
  `);
}

async function migrate() {
  await createTables();
  console.log('Subject and course-assignment tables are ready. No curriculum rows were imported.');
}

migrate()
  .catch((error) => {
    console.error(`Subject-management migration failed (${error.code || 'database error'}).`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
