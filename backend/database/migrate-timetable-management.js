'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const pool = require('./pool');

async function migrate() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS timetable_entries (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      section_id BIGINT UNSIGNED NOT NULL,
      subject_id BIGINT UNSIGNED NOT NULL,
      teacher_user_id BIGINT UNSIGNED NOT NULL,
      room_id BIGINT UNSIGNED NOT NULL,
      weekday_id TINYINT UNSIGNED NOT NULL,
      time_slot_id BIGINT UNSIGNED NOT NULL,
      academic_year_id BIGINT UNSIGNED NULL,
      semester_id BIGINT UNSIGNED NULL,
      created_by_user_id BIGINT UNSIGNED NULL,
      updated_by_user_id BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_timetable_exact_entry (section_id, subject_id, teacher_user_id, weekday_id, time_slot_id),
      KEY ix_timetable_section_day (section_id, weekday_id),
      KEY ix_timetable_teacher_day (teacher_user_id, weekday_id),
      KEY ix_timetable_room_day (room_id, weekday_id),
      KEY ix_timetable_slot_day (time_slot_id, weekday_id),
      CONSTRAINT fk_timetable_section FOREIGN KEY (section_id) REFERENCES academic_sections(id) ON DELETE CASCADE,
      CONSTRAINT fk_timetable_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
      CONSTRAINT fk_timetable_teacher FOREIGN KEY (teacher_user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_timetable_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      CONSTRAINT fk_timetable_weekday FOREIGN KEY (weekday_id) REFERENCES working_weekdays(id) ON DELETE RESTRICT,
      CONSTRAINT fk_timetable_time_slot FOREIGN KEY (time_slot_id) REFERENCES time_slots(id) ON DELETE CASCADE,
      CONSTRAINT fk_timetable_year FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE SET NULL,
      CONSTRAINT fk_timetable_semester FOREIGN KEY (semester_id) REFERENCES academic_semesters(id) ON DELETE SET NULL,
      CONSTRAINT fk_timetable_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_timetable_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);

  console.log('Timetable entries table is ready.');
}

migrate()
  .catch((error) => {
    console.error(`Timetable migration failed (${error.code || error.message}).`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

