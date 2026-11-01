'use strict';

const express = require('express');
const pool = require('../database/pool');
const { validIsoDate } = require('../services/time-slot-rules');

const router = express.Router();
const pad = (value) => String(value).padStart(2, '0');
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
function id(value) { return /^\d+$/.test(String(value ?? '')) && Number(value) > 0 ? Number(value) : null; }
function fail(res, error, status = 400, extra = {}) { return res.status(status).json({ error, ...extra }); }
function sqlTime(value) { return value ? `${value}:00` : null; }
function displayTime(value) { return value == null ? null : String(value).slice(0, 5); }
function normalizeDays(values) {
  if (!Array.isArray(values)) return null;
  const normalized = values.map(id);
  if (!normalized.length || normalized.some((value) => !value) || new Set(normalized).size !== normalized.length) return null;
  return normalized;
}
function safeString(value, max, required = false) {
  if (typeof value !== 'string') return required ? null : '';
  const result = value.trim();
  if (required && !result) return null;
  return result.length <= max ? result : null;
}
function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    && process.env.GOOGLE_REDIRECT_URI && process.env.GOOGLE_CALENDAR_ID);
}

router.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return fail(res, 'Send time-slot changes as JSON.', 415);
  }
  next();
});

router.get('/settings', async (req, res, next) => {
  try {
    const [weekdays] = await pool.execute(`SELECT id, day_key AS dayKey, day_label AS dayLabel,
      day_order AS dayOrder, is_working AS isWorking,
      TIME_FORMAT(start_time, '%H:%i') AS startTime, TIME_FORMAT(end_time, '%H:%i') AS endTime
      FROM working_weekdays ORDER BY day_order`);
    const [[slotStats]] = await pool.execute(`SELECT COUNT(*) AS total,
      SUM(status = 'active' AND deleted_at IS NULL) AS active,
      SUM(status = 'draft' AND deleted_at IS NULL) AS draft,
      SUM(status = 'inactive' AND deleted_at IS NULL) AS inactive
      FROM time_slots WHERE deleted_at IS NULL`);
    res.json({ weekdays: weekdays.map((day) => ({ ...day, id: Number(day.id), dayOrder: Number(day.dayOrder), isWorking: Boolean(day.isWorking) })),
      slotStats: Object.fromEntries(Object.entries(slotStats).map(([key, value]) => [key, Number(value || 0)])),
      timetableEntriesAvailable: false });
  } catch (error) { next(error); }
});

router.put('/weekdays/:dayKey', async (req, res, next) => {
  const dayKey = req.params.dayKey;
  const isWorking = req.body?.isWorking;
  if (!/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.test(dayKey) || typeof isWorking !== 'boolean') {
    return fail(res, 'Select a valid weekday and working-day status.');
  }
  const startTime = req.body?.startTime;
  const endTime = req.body?.endTime;
  if (isWorking && (!timePattern.test(startTime || '') || !timePattern.test(endTime || '') || endTime <= startTime)) {
    return fail(res, 'For a working day, enter valid hours with the end time later than the start time.');
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT id FROM working_weekdays WHERE day_key = ? FOR UPDATE', [dayKey]);
    if (!rows.length) { await connection.rollback(); return fail(res, 'Weekday configuration not found. Run the migration.', 404); }
    const [affectedSlots] = await connection.execute(`SELECT s.id, s.slot_code AS slotId,
      TIME_FORMAT(s.start_time, '%H:%i') AS startTime, TIME_FORMAT(s.end_time, '%H:%i') AS endTime,
      s.status FROM time_slots s JOIN time_slot_weekdays sw ON sw.time_slot_id = s.id
      WHERE sw.weekday_id = ? AND s.deleted_at IS NULL AND
       (? = 0 OR s.start_time < ? OR s.end_time > ?)
      ORDER BY s.start_time`, [rows[0].id, isWorking ? 1 : 0, sqlTime(startTime), sqlTime(endTime)]);
    if (affectedSlots.length && req.body?.confirmAffectedSlots !== true) {
      await connection.rollback();
      return fail(res, 'This change affects configured time slots. Review and confirm; those slots will remain unchanged.', 409,
        { affectedSlots, willModifySlots: false });
    }
    await connection.execute(`UPDATE working_weekdays SET is_working = ?, start_time = ?, end_time = ? WHERE id = ?`,
      [isWorking, isWorking ? sqlTime(startTime) : null, isWorking ? sqlTime(endTime) : null, rows[0].id]);
    await connection.commit();
    res.json({ message: 'Working day configuration saved. Time slots were not changed.', affectedSlots });
  } catch (error) { await connection.rollback(); next(error); }
  finally { connection.release(); }
});

async function validateSlot(connection, { days, startTime, endTime, ignoreId = null }) {
  if (!days) return { error: 'Select at least one working day.' };
  if (!timePattern.test(startTime || '') || !timePattern.test(endTime || '')) return { error: 'Enter valid start and end times.' };
  if (endTime <= startTime) return { error: 'End time must be later than start time.' };
  const placeholders = days.map(() => '?').join(',');
  const [selectedDays] = await connection.execute(`SELECT id, day_label AS dayLabel, is_working AS isWorking,
    TIME_FORMAT(start_time, '%H:%i') AS opensAt, TIME_FORMAT(end_time, '%H:%i') AS closesAt
    FROM working_weekdays WHERE id IN (${placeholders}) ORDER BY day_order FOR UPDATE`, days);
  if (selectedDays.length !== days.length) return { error: 'Select valid working days.' };
  const inactive = selectedDays.find((day) => !day.isWorking);
  if (inactive) return { error: `${inactive.dayLabel} is currently non-working. Activate it before assigning a regular time slot.` };
  for (const day of selectedDays) {
    if (!day.opensAt || !day.closesAt || startTime < day.opensAt || endTime > day.closesAt) {
      return { error: `The slot must fit within ${day.dayLabel}'s configured working hours (${day.opensAt || 'not set'}–${day.closesAt || 'not set'}).` };
    }
  }
  const whereDays = days.map(() => '?').join(',');
  const [conflicts] = await connection.execute(`SELECT DISTINCT s.slot_code AS slotId, w.day_label AS dayLabel, w.day_order AS dayOrder,
      TIME_FORMAT(s.start_time, '%H:%i') AS startTime, TIME_FORMAT(s.end_time, '%H:%i') AS endTime
    FROM time_slot_weekdays sw JOIN time_slots s ON s.id = sw.time_slot_id
    JOIN working_weekdays w ON w.id = sw.weekday_id
    WHERE sw.weekday_id IN (${whereDays}) AND s.deleted_at IS NULL
      AND (? IS NULL OR s.id <> ?) AND s.start_time < ? AND s.end_time > ?
    ORDER BY w.day_order`, [...days, ignoreId, ignoreId, sqlTime(endTime), sqlTime(startTime)]);
  if (conflicts.length) {
    const first = conflicts[0];
    const exact = conflicts.some((row) => row.startTime === startTime && row.endTime === endTime);
    return { error: exact
      ? `A slot already exists for ${first.dayLabel} at ${first.startTime}–${first.endTime}.`
      : `This time overlaps ${first.slotId} on ${first.dayLabel} (${first.startTime}–${first.endTime}).`, conflicts };
  }
  return { valid: true };
}

router.get('/slots', async (req, res, next) => {
  const status = req.query.status || '';
  const dayKey = req.query.day || '';
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 50) : '';
  if (status && !['draft', 'active', 'inactive'].includes(status)) return fail(res, 'Select a valid time-slot status.');
  if (dayKey && !/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.test(dayKey)) return fail(res, 'Select a valid weekday.');
  try {
    const [slots] = await pool.execute(`SELECT s.id, s.slot_code AS slotId,
        TIME_FORMAT(s.start_time, '%H:%i') AS startTime, TIME_FORMAT(s.end_time, '%H:%i') AS endTime,
        TIMESTAMPDIFF(MINUTE, CONCAT('2000-01-01 ', s.start_time), CONCAT('2000-01-01 ', s.end_time)) AS durationMinutes,
        s.status, GROUP_CONCAT(DISTINCT w.day_key ORDER BY w.day_order) AS dayKeys,
        GROUP_CONCAT(DISTINCT w.day_label ORDER BY w.day_order SEPARATOR ', ') AS workingDays,
        SUM(w.is_working = 0 OR s.start_time < w.start_time OR s.end_time > w.end_time) AS invalidDayCount
      FROM time_slots s JOIN time_slot_weekdays sw ON sw.time_slot_id = s.id
      JOIN working_weekdays w ON w.id = sw.weekday_id
      WHERE s.deleted_at IS NULL AND (? = '' OR s.status = ?) AND (? = '' OR s.slot_code LIKE ?)
        AND (? = '' OR w.day_key = ?)
      GROUP BY s.id, s.slot_code, s.start_time, s.end_time, s.status
      ORDER BY s.start_time, s.id`, [status, status, search, `%${search}%`, dayKey, dayKey]);
    res.json({ slots: slots.map((slot) => ({ ...slot, id: Number(slot.id), durationMinutes: Number(slot.durationMinutes), invalidDayCount: Number(slot.invalidDayCount), dayKeys: (slot.dayKeys || '').split(',').filter(Boolean) })) });
  } catch (error) { next(error); }
});

router.post('/slots', async (req, res, next) => {
  const days = normalizeDays(req.body?.weekdayIds);
  const startTime = req.body?.startTime;
  const endTime = req.body?.endTime;
  const status = req.body?.status;
  if (!['draft', 'active', 'inactive'].includes(status)) return fail(res, 'Choose Draft, Active, or Inactive status.');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const validation = await validateSlot(connection, { days, startTime, endTime });
    if (!validation.valid) { await connection.rollback(); return fail(res, validation.error, 409, { conflicts: validation.conflicts || [] }); }
    const [created] = await connection.execute(`INSERT INTO time_slots
      (slot_code, start_time, end_time, status, created_by_user_id, updated_by_user_id)
      VALUES (NULL, ?, ?, ?, ?, ?)`, [sqlTime(startTime), sqlTime(endTime), status, req.user.id, req.user.id]);
    const slotId = `TS-${pad(created.insertId)}`;
    await connection.execute('UPDATE time_slots SET slot_code = ? WHERE id = ?', [slotId, created.insertId]);
    for (const weekdayId of days) await connection.execute('INSERT INTO time_slot_weekdays (time_slot_id, weekday_id) VALUES (?, ?)', [created.insertId, weekdayId]);
    await connection.commit();
    res.status(201).json({ id: created.insertId, slotId, message: 'Time slot created.' });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return fail(res, 'That time slot already exists.', 409);
    next(error);
  } finally { connection.release(); }
});

router.get('/slots/:slotId', async (req, res, next) => {
  const slotPk = id(req.params.slotId);
  if (!slotPk) return fail(res, 'Time slot not found.', 404);
  try {
    const [slots] = await pool.execute(`SELECT id, slot_code AS slotId,
      TIME_FORMAT(start_time, '%H:%i') AS startTime, TIME_FORMAT(end_time, '%H:%i') AS endTime, status
      FROM time_slots WHERE id = ? AND deleted_at IS NULL LIMIT 1`, [slotPk]);
    if (!slots.length) return fail(res, 'Time slot not found.', 404);
    const [days] = await pool.execute('SELECT weekday_id AS weekdayId FROM time_slot_weekdays WHERE time_slot_id = ? ORDER BY weekday_id', [slotPk]);
    res.json({ slot: { ...slots[0], weekdayIds: days.map((day) => Number(day.weekdayId)) } });
  } catch (error) { next(error); }
});

router.put('/slots/:slotId', async (req, res, next) => {
  const slotPk = id(req.params.slotId);
  const days = normalizeDays(req.body?.weekdayIds);
  const { startTime, endTime, status } = req.body || {};
  if (!slotPk) return fail(res, 'Time slot not found.', 404);
  if (!['draft', 'active', 'inactive'].includes(status)) return fail(res, 'Choose Draft, Active, or Inactive status.');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.execute('SELECT id FROM time_slots WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [slotPk]);
    if (!existing.length) { await connection.rollback(); return fail(res, 'Time slot not found.', 404); }
    const validation = await validateSlot(connection, { days, startTime, endTime, ignoreId: slotPk });
    if (!validation.valid) { await connection.rollback(); return fail(res, validation.error, 409, { conflicts: validation.conflicts || [] }); }
    await connection.execute(`UPDATE time_slots SET start_time = ?, end_time = ?, status = ?, updated_by_user_id = ? WHERE id = ?`, [sqlTime(startTime), sqlTime(endTime), status, req.user.id, slotPk]);
    await connection.execute('DELETE FROM time_slot_weekdays WHERE time_slot_id = ?', [slotPk]);
    for (const weekdayId of days) await connection.execute('INSERT INTO time_slot_weekdays (time_slot_id, weekday_id) VALUES (?, ?)', [slotPk, weekdayId]);
    await connection.commit();
    res.json({ message: 'Time slot updated.' });
  } catch (error) { await connection.rollback(); next(error); }
  finally { connection.release(); }
});

router.patch('/slots/:slotId/status', async (req, res, next) => {
  const slotPk = id(req.params.slotId);
  const status = req.body?.status;
  if (!slotPk || !['draft', 'active', 'inactive'].includes(status)) return fail(res, 'Choose Draft, Active, or Inactive status.');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [slots] = await connection.execute(`SELECT id, TIME_FORMAT(start_time, '%H:%i') AS startTime,
      TIME_FORMAT(end_time, '%H:%i') AS endTime FROM time_slots WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [slotPk]);
    if (!slots.length) { await connection.rollback(); return fail(res, 'Time slot not found.', 404); }
    if (status === 'active') {
      const [days] = await connection.execute('SELECT weekday_id AS weekdayId FROM time_slot_weekdays WHERE time_slot_id = ?', [slotPk]);
      const validation = await validateSlot(connection, { days: days.map((day) => Number(day.weekdayId)), startTime: slots[0].startTime, endTime: slots[0].endTime, ignoreId: slotPk });
      if (!validation.valid) { await connection.rollback(); return fail(res, validation.error, 409, { conflicts: validation.conflicts || [] }); }
    }
    await connection.execute('UPDATE time_slots SET status = ?, updated_by_user_id = ? WHERE id = ?', [status, req.user.id, slotPk]);
    await connection.commit();
    res.json({ message: `Time slot marked ${status}.` });
  } catch (error) { await connection.rollback(); next(error); }
  finally { connection.release(); }
});

router.delete('/slots/:slotId', async (req, res, next) => {
  const slotPk = id(req.params.slotId);
  if (!slotPk) return fail(res, 'Time slot not found.', 404);
  try {
    const [result] = await pool.execute('UPDATE time_slots SET deleted_at = CURRENT_TIMESTAMP, updated_by_user_id = ? WHERE id = ? AND deleted_at IS NULL', [req.user.id, slotPk]);
    if (!result.affectedRows) return fail(res, 'Time slot not found.', 404);
    res.json({ message: 'Time slot archived. Its generated ID will not be reused.', timetableEntries: 0, timetableDataAvailable: false });
  } catch (error) { next(error); }
});

function parseCalendarRecord(body) {
  const eventName = safeString(body?.eventName, 180, true);
  const eventDate = body?.eventDate;
  const description = safeString(body?.description ?? '', 5000);
  const eventType = body?.eventType;
  if (!eventName || !validIsoDate(eventDate) || !['holiday', 'special_working_day'].includes(eventType)) return { error: 'Enter an event name, valid date, and event type.' };
  const startTime = body?.startTime || '';
  const endTime = body?.endTime || '';
  if (eventType === 'special_working_day' && ((startTime || endTime) && (!timePattern.test(startTime) || !timePattern.test(endTime) || endTime <= startTime))) {
    return { error: 'Enter valid special working-day hours with the end time later than the start time.' };
  }
  return { eventName, eventDate, description, eventType, startTime: eventType === 'special_working_day' && startTime ? sqlTime(startTime) : null,
    endTime: eventType === 'special_working_day' && endTime ? sqlTime(endTime) : null };
}

async function validateSpecialDayHours(connection, record) {
  if (record.eventType !== 'special_working_day') return null;
  const [[weekday]] = await connection.execute(`SELECT is_working AS isWorking,
    TIME_FORMAT(start_time, '%H:%i') AS opensAt, TIME_FORMAT(end_time, '%H:%i') AS closesAt
    FROM working_weekdays WHERE day_order = ?`, [require('../services/time-slot-rules').weekdayOrder(record.eventDate)]);
  if (!record.startTime && (!weekday?.isWorking || !weekday.opensAt || !weekday.closesAt)) return 'A special working day on a normally non-working weekday needs its own start and end hours.';
  const opensAt = displayTime(record.startTime) || weekday?.opensAt;
  const closesAt = displayTime(record.endTime) || weekday?.closesAt;
  if (!opensAt || !closesAt || closesAt <= opensAt) return 'Valid working hours are required for a special working day.';
  if (weekday?.isWorking && (opensAt < weekday.opensAt || closesAt > weekday.closesAt)) return `Special-day hours must fit within the weekday's configured hours (${weekday.opensAt}–${weekday.closesAt}).`;
  return null;
}

async function findCalendarDateConflict(connection, eventDate, ignoreId = null) {
  const [rows] = await connection.execute(`SELECT id, event_name AS eventName, event_type AS eventType
    FROM academic_calendar_events WHERE event_date = ? AND approval_status = 'approved'
    AND (? IS NULL OR id <> ?) LIMIT 1`, [eventDate, ignoreId, ignoreId]);
  return rows[0] || null;
}

router.get('/calendar', async (req, res, next) => {
  const type = req.query.type || '';
  const period = req.query.period || '';
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  if (type && !['holiday', 'special_working_day'].includes(type)) return fail(res, 'Select a valid calendar event type.');
  if (period && !['upcoming', 'past'].includes(period)) return fail(res, 'Select upcoming or past calendar entries.');
  try {
    const [events] = await pool.execute(`SELECT id, event_name AS eventName, DATE_FORMAT(event_date, '%Y-%m-%d') AS eventDate,
      DATE_FORMAT(event_date, '%W') AS dayName, description, event_type AS eventType,
      source, approval_status AS approvalStatus,
      TIME_FORMAT(start_time, '%H:%i') AS startTime, TIME_FORMAT(end_time, '%H:%i') AS endTime
      FROM academic_calendar_events
      WHERE (? = '' OR event_type = ?) AND (? = '' OR event_name LIKE ? OR description LIKE ?)
        AND (? = '' OR (? = 'upcoming' AND event_date >= CURRENT_DATE) OR (? = 'past' AND event_date < CURRENT_DATE))
      ORDER BY event_date, event_name`, [type, type, search, `%${search}%`, `%${search}%`, period, period, period]);
    const [[counts]] = await pool.execute(`SELECT COUNT(*) AS total,
      SUM(event_type = 'holiday') AS holidays, SUM(event_type = 'special_working_day') AS specialDays,
      SUM(event_date >= CURRENT_DATE) AS upcoming
      FROM academic_calendar_events WHERE approval_status = 'approved'`);
    res.json({ events, counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value || 0)])), timetableEntriesAvailable: false });
  } catch (error) { next(error); }
});

router.post('/calendar', async (req, res, next) => {
  const record = parseCalendarRecord(req.body);
  if (record.error) return fail(res, record.error);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const hoursError = await validateSpecialDayHours(connection, record);
    if (hoursError) { await connection.rollback(); return fail(res, hoursError, 409); }
    const conflict = await findCalendarDateConflict(connection, record.eventDate);
    if (conflict) { await connection.rollback(); return fail(res, `An approved calendar entry already exists on this date: ${conflict.eventName}.`, 409, { conflict }); }
    const [created] = await connection.execute(`INSERT INTO academic_calendar_events
      (event_name, event_date, description, event_type, source, approval_status, start_time, end_time, created_by_user_id, updated_by_user_id)
      VALUES (?, ?, ?, ?, 'manual', 'approved', ?, ?, ?, ?)`, [record.eventName, record.eventDate, record.description || null, record.eventType, record.startTime, record.endTime, req.user.id, req.user.id]);
    await connection.commit();
    res.status(201).json({ id: created.insertId, message: 'Academic calendar entry added.' });
  } catch (error) { await connection.rollback(); if (error.code === 'ER_DUP_ENTRY') return fail(res, 'A calendar entry with that source identifier already exists.', 409); next(error); }
  finally { connection.release(); }
});

router.get('/calendar/:eventId', async (req, res, next) => {
  const eventId = id(req.params.eventId);
  if (!eventId) return fail(res, 'Calendar entry not found.', 404);
  try {
    const [events] = await pool.execute(`SELECT id, event_name AS eventName, DATE_FORMAT(event_date, '%Y-%m-%d') AS eventDate,
      description, event_type AS eventType, source, approval_status AS approvalStatus,
      TIME_FORMAT(start_time, '%H:%i') AS startTime, TIME_FORMAT(end_time, '%H:%i') AS endTime
      FROM academic_calendar_events WHERE id = ? LIMIT 1`, [eventId]);
    if (!events.length) return fail(res, 'Calendar entry not found.', 404);
    res.json({ event: events[0] });
  } catch (error) { next(error); }
});

router.put('/calendar/:eventId', async (req, res, next) => {
  const eventId = id(req.params.eventId);
  const record = parseCalendarRecord(req.body);
  if (!eventId) return fail(res, 'Calendar entry not found.', 404);
  if (record.error) return fail(res, record.error);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.execute('SELECT source FROM academic_calendar_events WHERE id = ? FOR UPDATE', [eventId]);
    if (!existing.length) { await connection.rollback(); return fail(res, 'Calendar entry not found.', 404); }
    if (existing[0].source !== 'manual') { await connection.rollback(); return fail(res, 'Imported Google events must be changed through the review workflow.', 409); }
    const hoursError = await validateSpecialDayHours(connection, record);
    if (hoursError) { await connection.rollback(); return fail(res, hoursError, 409); }
    const conflict = await findCalendarDateConflict(connection, record.eventDate, eventId);
    if (conflict) { await connection.rollback(); return fail(res, `An approved calendar entry already exists on this date: ${conflict.eventName}.`, 409, { conflict }); }
    await connection.execute(`UPDATE academic_calendar_events SET event_name = ?, event_date = ?, description = ?,
      event_type = ?, start_time = ?, end_time = ?, updated_by_user_id = ? WHERE id = ?`,
    [record.eventName, record.eventDate, record.description || null, record.eventType, record.startTime, record.endTime, req.user.id, eventId]);
    await connection.commit();
    res.json({ message: 'Academic calendar entry updated.' });
  } catch (error) { await connection.rollback(); next(error); }
  finally { connection.release(); }
});

router.delete('/calendar/:eventId', async (req, res, next) => {
  const eventId = id(req.params.eventId);
  if (!eventId) return fail(res, 'Calendar entry not found.', 404);
  try {
    const [rows] = await pool.execute('SELECT id, source FROM academic_calendar_events WHERE id = ? LIMIT 1', [eventId]);
    if (!rows.length) return fail(res, 'Calendar entry not found.', 404);
    if (rows[0].source !== 'manual') return fail(res, 'Imported entries must be managed through Google Calendar review.', 409);
    const [result] = await pool.execute('DELETE FROM academic_calendar_events WHERE id = ?', [eventId]);
    if (!result.affectedRows) return fail(res, 'Calendar entry not found.', 404);
    res.json({ message: 'Calendar entry deleted.', affectedTimetableEntries: 0, timetableDataAvailable: false });
  } catch (error) { next(error); }
});

router.get('/calendar-eligibility/:date', async (req, res, next) => {
  if (!validIsoDate(req.params.date)) return fail(res, 'Enter a real date in YYYY-MM-DD format.');
  const connection = await pool.getConnection();
  try {
    const { getSchedulingContext } = require('../services/time-slot-rules');
    res.json(await getSchedulingContext(connection, req.params.date));
  } catch (error) { next(error); }
  finally { connection.release(); }
});

router.get('/google/status', async (req, res, next) => {
  try {
    const [[state]] = await pool.execute(`SELECT calendar_id AS calendarId, account_email AS accountEmail,
      last_successful_sync AS lastSuccessfulSync, last_sync_status AS lastSyncStatus,
      last_sync_message AS lastSyncMessage, imported_event_count AS importedEventCount
      FROM google_calendar_sync_state WHERE id = 1`);
    const [[pending]] = await pool.execute(`SELECT COUNT(*) AS pendingReviewCount FROM google_calendar_events WHERE review_status IN ('pending_review','needs_review')`);
    res.json({ configured: googleConfigured(), connectionStatus: state?.accountEmail ? 'connected' : googleConfigured() ? 'not_connected' : 'not_configured',
      accountEmail: state?.accountEmail || null, lastSuccessfulSync: state?.lastSuccessfulSync || null,
      lastSyncStatus: state?.lastSyncStatus || 'never', lastSyncMessage: state?.lastSyncMessage || null,
      importedEventCount: Number(state?.importedEventCount || 0), pendingReviewCount: Number(pending.pendingReviewCount) });
  } catch (error) { next(error); }
});

router.get('/google/events', async (req, res, next) => {
  const reviewStatus = req.query.status || '';
  if (reviewStatus && !['pending_review', 'needs_review', 'approved_holiday', 'approved_special_working_day', 'ignored'].includes(reviewStatus)) return fail(res, 'Select a valid Google event status.');
  try {
    const [events] = await pool.execute(`SELECT id, google_event_id AS googleEventId,
      event_title AS title, description, DATE_FORMAT(event_date, '%Y-%m-%d') AS eventDate, source_status AS sourceStatus,
      review_status AS reviewStatus, approved_calendar_event_id AS approvedCalendarEventId
      FROM google_calendar_events WHERE (? = '' OR review_status = ?) ORDER BY event_date, event_title`, [reviewStatus, reviewStatus]);
    res.json({ events });
  } catch (error) { next(error); }
});

router.post('/google/sync', async (req, res) => {
  if (!googleConfigured()) return fail(res, 'Google Calendar is not configured. Add the required OAuth environment variables to enable connection and read-only sync.', 503, { connectionStatus: 'not_configured' });
  return fail(res, 'Google OAuth connection has not been completed.', 409, { connectionStatus: 'not_connected' });
});

router.patch('/google/events/:eventId/review', async (req, res, next) => {
  const eventId = id(req.params.eventId);
  const classification = req.body?.classification;
  const allowed = ['holiday', 'special_working_day', 'ignore'];
  if (!eventId || !allowed.includes(classification)) return fail(res, 'Choose Holiday, Special Working Day, or Ignore.');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(`SELECT id, event_title AS title, description,
      DATE_FORMAT(event_date, '%Y-%m-%d') AS eventDate, source_status AS sourceStatus, approved_calendar_event_id AS calendarEventId
      FROM google_calendar_events WHERE id = ? FOR UPDATE`, [eventId]);
    if (!rows.length) { await connection.rollback(); return fail(res, 'Imported event not found.', 404); }
    const event = rows[0];
    if (event.sourceStatus === 'deleted') { await connection.rollback(); return fail(res, 'This source event was deleted in Google Calendar and cannot be approved.', 409); }
    if (classification === 'ignore') {
      if (event.calendarEventId) await connection.execute('DELETE FROM academic_calendar_events WHERE id = ?', [event.calendarEventId]);
      await connection.execute(`UPDATE google_calendar_events SET review_status = 'ignored', approved_calendar_event_id = NULL WHERE id = ?`, [eventId]);
      await connection.commit();
      return res.json({ message: 'Google Calendar event ignored; it does not affect scheduling.' });
    }
    const eventType = classification;
    const [[weekday]] = await connection.execute(`SELECT is_working AS isWorking,
      TIME_FORMAT(start_time, '%H:%i') AS opensAt, TIME_FORMAT(end_time, '%H:%i') AS closesAt
      FROM working_weekdays WHERE day_order = ?`, [require('../services/time-slot-rules').weekdayOrder(String(event.eventDate).slice(0, 10))]);
    const startTime = req.body?.startTime || weekday?.opensAt;
    const endTime = req.body?.endTime || weekday?.closesAt;
    if (eventType === 'special_working_day' && !weekday?.isWorking && (!timePattern.test(startTime || '') || !timePattern.test(endTime || '') || endTime <= startTime)) {
      await connection.rollback(); return fail(res, 'Enter special working-day hours for this normally non-working weekday.');
    }
    if (eventType === 'special_working_day' && weekday?.isWorking && (!timePattern.test(startTime || '') || !timePattern.test(endTime || '') || startTime < weekday.opensAt || endTime > weekday.closesAt || endTime <= startTime)) {
      await connection.rollback(); return fail(res, `Special-day hours must fit within ${weekday.opensAt}–${weekday.closesAt}.`);
    }
    const conflict = await findCalendarDateConflict(connection, String(event.eventDate).slice(0, 10), event.calendarEventId);
    if (conflict) { await connection.rollback(); return fail(res, `Another approved calendar entry already exists on this date: ${conflict.eventName}.`, 409); }
    let calendarEventId = event.calendarEventId;
    if (calendarEventId) {
      await connection.execute(`UPDATE academic_calendar_events SET event_name = ?, description = ?, event_type = ?, approval_status = 'approved',
        start_time = ?, end_time = ? WHERE id = ?`, [event.title, event.description, eventType,
        eventType === 'special_working_day' ? sqlTime(startTime) : null, eventType === 'special_working_day' ? sqlTime(endTime) : null, calendarEventId]);
    } else {
      const [created] = await connection.execute(`INSERT INTO academic_calendar_events
        (event_name, event_date, description, event_type, source, approval_status, start_time, end_time)
        VALUES (?, ?, ?, ?, 'google_calendar', 'approved', ?, ?)`, [event.title, String(event.eventDate).slice(0, 10), event.description,
        eventType, eventType === 'special_working_day' ? sqlTime(startTime) : null, eventType === 'special_working_day' ? sqlTime(endTime) : null]);
      calendarEventId = created.insertId;
    }
    const reviewStatus = eventType === 'holiday' ? 'approved_holiday' : 'approved_special_working_day';
    await connection.execute('UPDATE google_calendar_events SET review_status = ?, approved_calendar_event_id = ? WHERE id = ?', [reviewStatus, calendarEventId, eventId]);
    await connection.commit();
    res.json({ message: 'Event classification approved and added to the academic calendar.' });
  } catch (error) { await connection.rollback(); if (error.code === 'ER_DUP_ENTRY') return fail(res, 'This event is already imported.', 409); next(error); }
  finally { connection.release(); }
});

module.exports = router;
