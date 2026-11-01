CREATE DATABASE IF NOT EXISTS bmu_ttms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE bmu_ttms;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  login_id VARCHAR(254) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('administrator','teacher','student') NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_login_id (login_id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS teacher_profiles (
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
  updated_by_user_id BIGINT UNSIGNED NULL,
  updated_by_role ENUM('administrator','teacher') NULL,
  UNIQUE KEY uq_teacher_profiles_teacher_id (teacher_id),
  CONSTRAINT fk_teacher_profiles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_teacher_profiles_updated_by FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS subjects (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  subject_code VARCHAR(60) NULL,
  subject_name VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_subjects_code (subject_code),
  KEY ix_subjects_name (subject_name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS teacher_subjects (
  teacher_user_id BIGINT UNSIGNED NOT NULL,
  subject_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (teacher_user_id, subject_id),
  KEY ix_teacher_subjects_subject (subject_id),
  CONSTRAINT fk_teacher_subjects_teacher FOREIGN KEY (teacher_user_id) REFERENCES teacher_profiles(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_teacher_subjects_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NULL,
  session_token_hash CHAR(64) NOT NULL,
  session_data JSON NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME NULL,
  UNIQUE KEY uq_sessions_token_hash (session_token_hash),
  KEY ix_sessions_user_expiry (user_id, expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reset_token_hash (token_hash),
  KEY ix_reset_user_created (user_id, created_at),
  CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS academic_programmes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(180) NOT NULL,
  min_duration_years TINYINT UNSIGNED NOT NULL,
  max_duration_years TINYINT UNSIGNED NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_academic_programmes_code (code),
  UNIQUE KEY uq_academic_programmes_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS academic_options (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  programme_id BIGINT UNSIGNED NOT NULL,
  parent_option_id BIGINT UNSIGNED NULL,
  code VARCHAR(60) NOT NULL,
  name VARCHAR(180) NOT NULL,
  option_type ENUM('branch','major','specialisation') NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_academic_options_code (programme_id, code),
  KEY ix_academic_options_program_parent (programme_id, parent_option_id, is_active),
  CONSTRAINT fk_academic_options_programme FOREIGN KEY (programme_id) REFERENCES academic_programmes(id) ON DELETE RESTRICT,
  CONSTRAINT fk_academic_options_parent FOREIGN KEY (parent_option_id) REFERENCES academic_options(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS academic_years (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  label VARCHAR(24) NOT NULL,
  start_year SMALLINT UNSIGNED NOT NULL,
  end_year SMALLINT UNSIGNED NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_academic_years_label (label),
  UNIQUE KEY uq_academic_years_start (start_year)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS academic_terms (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  academic_year_id BIGINT UNSIGNED NOT NULL,
  term_key ENUM('odd','even') NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_academic_terms_year_key (academic_year_id, term_key),
  KEY ix_academic_terms_active (is_active),
  CONSTRAINT fk_academic_terms_year FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS academic_semesters (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  semester_number TINYINT UNSIGNED NOT NULL,
  label VARCHAR(40) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_academic_semesters_number (semester_number),
  UNIQUE KEY uq_academic_semesters_label (label),
  CONSTRAINT chk_academic_semesters_number CHECK (semester_number BETWEEN 1 AND 10)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS academic_sections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  programme_id BIGINT UNSIGNED NOT NULL,
  branch_option_id BIGINT UNSIGNED NULL,
  section_name VARCHAR(40) NOT NULL,
  option_group_id BIGINT UNSIGNED GENERATED ALWAYS AS (COALESCE(branch_option_id, 0)) STORED,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_academic_sections_group_name (programme_id, option_group_id, section_name),
  KEY ix_academic_sections_program_option (programme_id, branch_option_id, is_active),
  CONSTRAINT fk_academic_sections_programme FOREIGN KEY (programme_id) REFERENCES academic_programmes(id) ON DELETE RESTRICT,
  CONSTRAINT fk_academic_sections_option FOREIGN KEY (branch_option_id) REFERENCES academic_options(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS student_profiles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NULL,
  student_id VARCHAR(32) NOT NULL,
  name VARCHAR(160) NOT NULL,
  email VARCHAR(254) NOT NULL,
  contact_number VARCHAR(32) NULL,
  programme_id BIGINT UNSIGNED NULL,
  branch_option_id BIGINT UNSIGNED NULL,
  specialisation_option_id BIGINT UNSIGNED NULL,
  enrolled_year SMALLINT UNSIGNED NULL,
  expected_graduation_year SMALLINT UNSIGNED NULL,
  current_semester_id BIGINT UNSIGNED NULL,
  section_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_student_profiles_user (user_id),
  UNIQUE KEY uq_student_profiles_student_id (student_id),
  UNIQUE KEY uq_student_profiles_email (email),
  KEY ix_student_profiles_academic (programme_id, branch_option_id, current_semester_id, section_id),
  CONSTRAINT fk_student_profiles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_student_profiles_programme FOREIGN KEY (programme_id) REFERENCES academic_programmes(id) ON DELETE RESTRICT,
  CONSTRAINT fk_student_profiles_branch FOREIGN KEY (branch_option_id) REFERENCES academic_options(id) ON DELETE RESTRICT,
  CONSTRAINT fk_student_profiles_specialisation FOREIGN KEY (specialisation_option_id) REFERENCES academic_options(id) ON DELETE RESTRICT,
  CONSTRAINT fk_student_profiles_semester FOREIGN KEY (current_semester_id) REFERENCES academic_semesters(id) ON DELETE RESTRICT,
  CONSTRAINT fk_student_profiles_section FOREIGN KEY (section_id) REFERENCES academic_sections(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS curriculum_subjects (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS class_course_assignments (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS teacher_course_assignments (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS student_course_assignments (
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
) ENGINE=InnoDB;
USE bmu_ttms;

SELECT * FROM users;

DESCRIBE users;

SELECT id, name, login_id, email, password_hash, role, is_active
FROM users;
