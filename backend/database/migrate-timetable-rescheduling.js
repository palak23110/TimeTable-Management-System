'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const pool = require('./pool');

async function migrate() {
  // 1. Teacher Rescheduling Authorizations Table
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS teacher_rescheduling_authorizations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      is_authorized TINYINT(1) NOT NULL DEFAULT 1,
      notes VARCHAR(255) NULL,
      granted_by_user_id BIGINT UNSIGNED NULL,
      granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tra_user (user_id),
      CONSTRAINT fk_tra_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT fk_tra_granter FOREIGN KEY (granted_by_user_id) REFERENCES users (id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 2. Timetable Change Logs Table
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS timetable_change_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      timetable_entry_id BIGINT UNSIGNED NOT NULL,
      action_type ENUM('reschedule', 'update', 'cancel') NOT NULL DEFAULT 'reschedule',
      previous_section_id BIGINT UNSIGNED NULL,
      previous_subject_id BIGINT UNSIGNED NULL,
      previous_teacher_user_id BIGINT UNSIGNED NULL,
      previous_room_id BIGINT UNSIGNED NULL,
      previous_weekday_id TINYINT UNSIGNED NULL,
      previous_time_slot_id BIGINT UNSIGNED NULL,
      new_section_id BIGINT UNSIGNED NULL,
      new_subject_id BIGINT UNSIGNED NULL,
      new_teacher_user_id BIGINT UNSIGNED NULL,
      new_room_id BIGINT UNSIGNED NULL,
      new_weekday_id TINYINT UNSIGNED NULL,
      new_time_slot_id BIGINT UNSIGNED NULL,
      reason VARCHAR(500) NULL,
      changed_by_user_id BIGINT UNSIGNED NOT NULL,
      changed_by_role ENUM('administrator', 'teacher') NOT NULL,
      notification_sent TINYINT(1) NOT NULL DEFAULT 0,
      notification_recipient_count INT NOT NULL DEFAULT 0,
      notification_error TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tcl_entry (timetable_entry_id),
      INDEX idx_tcl_changed_by (changed_by_user_id),
      INDEX idx_tcl_created_at (created_at),
      CONSTRAINT fk_tcl_entry FOREIGN KEY (timetable_entry_id) REFERENCES timetable_entries (id) ON DELETE CASCADE,
      CONSTRAINT fk_tcl_user FOREIGN KEY (changed_by_user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  console.log('Timetable rescheduling and change logs tables are ready.');
}

migrate()
  .catch((error) => {
    console.error(`Rescheduling migration failed (${error.code || error.message}).`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

