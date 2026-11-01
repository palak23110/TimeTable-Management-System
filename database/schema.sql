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
  UNIQUE KEY uq_teacher_profiles_teacher_id (teacher_id),
  CONSTRAINT fk_teacher_profiles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS subjects (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  subject_code VARCHAR(40) NULL,
  subject_name VARCHAR(160) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_subjects_code (subject_code),
  UNIQUE KEY uq_subjects_name (subject_name)
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
USE bmu_ttms;

SELECT * FROM users;

DESCRIBE users;

SELECT id, name, login_id, email, password_hash, role, is_active
FROM users;
