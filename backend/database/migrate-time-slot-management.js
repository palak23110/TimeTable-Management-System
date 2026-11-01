'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const pool = require('./pool');

const weekdays = [
  ['monday', 'Monday', 1, true], ['tuesday', 'Tuesday', 2, true],
  ['wednesday', 'Wednesday', 3, true], ['thursday', 'Thursday', 4, true],
  ['friday', 'Friday', 5, true], ['saturday', 'Saturday', 6, false],
  ['sunday', 'Sunday', 7, false],
];
const initialSlots = [
  ['TS-01', '08:30:00', '09:30:00', 'active'],
  ['TS-02', '09:35:00', '10:35:00', 'active'],
  ['TS-03', '10:50:00', '11:50:00', 'active'],
  ['TS-04', '12:30:00', '13:30:00', 'active'],
  ['TS-05', '13:35:00', '14:35:00', 'draft'],
];

async function migrate() {
  await pool.execute(`CREATE TABLE IF NOT EXISTS working_weekdays (
    id TINYINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    day_key ENUM('monday','tuesday','wednesday','thursday','friday','saturday','sunday') NOT NULL,
    day_label VARCHAR(12) NOT NULL,
    day_order TINYINT UNSIGNED NOT NULL,
    is_working BOOLEAN NOT NULL DEFAULT FALSE,
    start_time TIME NULL,
    end_time TIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_working_weekdays_key (day_key),
    UNIQUE KEY uq_working_weekdays_order (day_order)
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS time_slots (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    slot_code VARCHAR(24) NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    status ENUM('draft','active','inactive') NOT NULL DEFAULT 'draft',
    deleted_at TIMESTAMP NULL DEFAULT NULL,
    created_by_user_id BIGINT UNSIGNED NULL,
    updated_by_user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_time_slots_code (slot_code),
    KEY ix_time_slots_status_time (status, deleted_at, start_time, end_time),
    CONSTRAINT fk_time_slots_created_by FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_time_slots_updated_by FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS time_slot_weekdays (
    time_slot_id BIGINT UNSIGNED NOT NULL,
    weekday_id TINYINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (time_slot_id, weekday_id),
    KEY ix_time_slot_weekdays_day (weekday_id, time_slot_id),
    CONSTRAINT fk_time_slot_weekdays_slot FOREIGN KEY (time_slot_id) REFERENCES time_slots(id) ON DELETE CASCADE,
    CONSTRAINT fk_time_slot_weekdays_day FOREIGN KEY (weekday_id) REFERENCES working_weekdays(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS academic_calendar_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    event_name VARCHAR(180) NOT NULL,
    event_date DATE NOT NULL,
    description TEXT NULL,
    event_type ENUM('holiday','special_working_day') NOT NULL,
    source ENUM('manual','google_calendar') NOT NULL DEFAULT 'manual',
    approval_status ENUM('approved','pending_review','needs_review') NOT NULL DEFAULT 'approved',
    start_time TIME NULL,
    end_time TIME NULL,
    source_event_id VARCHAR(255) NULL,
    created_by_user_id BIGINT UNSIGNED NULL,
    updated_by_user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_calendar_source_event (source, source_event_id),
    KEY ix_calendar_date_approval (event_date, approval_status, event_type),
    KEY ix_calendar_type_date (event_type, event_date),
    CONSTRAINT fk_calendar_created_by FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_calendar_updated_by FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS google_calendar_sync_state (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    calendar_id VARCHAR(255) NULL,
    account_email VARCHAR(254) NULL,
    connection_status ENUM('not_configured','not_connected','connected') NOT NULL DEFAULT 'not_configured',
    last_successful_sync DATETIME NULL,
    last_sync_status ENUM('never','success','error') NOT NULL DEFAULT 'never',
    last_sync_message VARCHAR(500) NULL,
    imported_event_count INT UNSIGNED NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_google_calendar_singleton CHECK (id = 1)
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS google_calendar_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    google_event_id VARCHAR(255) NOT NULL,
    event_title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    event_date DATE NOT NULL,
    starts_at DATETIME NULL,
    ends_at DATETIME NULL,
    source_updated_at DATETIME NULL,
    source_etag VARCHAR(255) NULL,
    source_status ENUM('current','deleted') NOT NULL DEFAULT 'current',
    review_status ENUM('pending_review','approved_holiday','approved_special_working_day','ignored','needs_review') NOT NULL DEFAULT 'pending_review',
    approved_calendar_event_id BIGINT UNSIGNED NULL,
    imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_google_calendar_event_id (google_event_id),
    KEY ix_google_calendar_review (review_status, event_date),
    CONSTRAINT fk_google_approved_calendar_event FOREIGN KEY (approved_calendar_event_id) REFERENCES academic_calendar_events(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);

  const connection = await pool.getConnection();
  const summary = { weekdaysInserted: 0, weekdaysMatched: 0, seededSlots: 0, slotDayLinks: 0 };
  try {
    await connection.beginTransaction();
    for (const [dayKey, dayLabel, dayOrder, isWorking] of weekdays) {
      const [result] = await connection.execute(`INSERT IGNORE INTO working_weekdays
        (day_key, day_label, day_order, is_working, start_time, end_time)
        VALUES (?, ?, ?, ?, ?, ?)`, [dayKey, dayLabel, dayOrder, isWorking,
        isWorking ? '08:30:00' : null, isWorking ? '14:35:00' : null]);
      summary.weekdaysInserted += result.affectedRows;
      summary.weekdaysMatched += result.affectedRows ? 0 : 1;
    }
    for (let index = 0; index < initialSlots.length; index += 1) {
      const [slotCode, startTime, endTime, status] = initialSlots[index];
      const [result] = await connection.execute(`INSERT IGNORE INTO time_slots
        (id, slot_code, start_time, end_time, status) VALUES (?, ?, ?, ?, ?)`, [index + 1, slotCode, startTime, endTime, status]);
      summary.seededSlots += result.affectedRows;
      const [slotRows] = await connection.execute('SELECT id FROM time_slots WHERE slot_code = ? LIMIT 1', [slotCode]);
      if (!slotRows.length) continue;
      const [days] = await connection.execute('SELECT id FROM working_weekdays WHERE day_order BETWEEN 1 AND 5 ORDER BY day_order');
      for (const day of days) {
        const [linked] = await connection.execute('INSERT IGNORE INTO time_slot_weekdays (time_slot_id, weekday_id) VALUES (?, ?)', [slotRows[0].id, day.id]);
        summary.slotDayLinks += linked.affectedRows;
      }
    }
    await connection.execute(`INSERT IGNORE INTO google_calendar_sync_state (id, connection_status, last_sync_status) VALUES (1, 'not_configured', 'never')`);
    await connection.commit();
    const [[counts]] = await connection.query(`SELECT
      (SELECT COUNT(*) FROM working_weekdays) AS weekdays,
      (SELECT COUNT(*) FROM time_slots WHERE deleted_at IS NULL) AS slots,
      (SELECT COUNT(*) FROM time_slot_weekdays) AS slotDayLinks,
      (SELECT COUNT(*) FROM academic_calendar_events) AS calendarEvents`);
    console.log(JSON.stringify({ ...summary, totals: Object.fromEntries(Object.entries(counts).map(([k,v]) => [k, Number(v)])) }));
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

migrate().catch((error) => {
  console.error(`Time slot management migration failed (${error.code || error.message}).`);
  process.exitCode = 1;
}).finally(() => pool.end());
