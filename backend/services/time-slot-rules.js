'use strict';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function validIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function weekdayOrder(isoDate) {
  const day = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function timeText(value) {
  return value == null ? null : String(value).slice(0, 5);
}

async function getSchedulingContext(connection, isoDate) {
  if (!validIsoDate(isoDate)) throw new TypeError('Date must be a real calendar date in YYYY-MM-DD format.');
  const dayOrder = weekdayOrder(isoDate);
  const [[weekday]] = await connection.execute(`SELECT id, day_key AS dayKey, day_label AS dayLabel,
      day_order AS dayOrder, is_working AS isWorking, start_time AS startTime, end_time AS endTime
    FROM working_weekdays WHERE day_order = ? LIMIT 1`, [dayOrder]);
  if (!weekday) throw new Error('Working-week configuration is incomplete. Run the time-slot database migration.');
  const [exceptions] = await connection.execute(`SELECT id, event_name AS eventName,
      event_type AS eventType, approval_status AS approvalStatus,
      start_time AS startTime, end_time AS endTime
    FROM academic_calendar_events
    WHERE event_date = ? AND approval_status = 'approved'
    ORDER BY (event_type = 'holiday') DESC, id`, [isoDate]);
  const holiday = exceptions.find((event) => event.eventType === 'holiday');
  const special = exceptions.find((event) => event.eventType === 'special_working_day');
  let allowed = false;
  let reason;
  let startTime = null;
  let endTime = null;
  if (holiday) {
    reason = 'This date is marked as a holiday.';
  } else if (!weekday.isWorking && !special) {
    reason = 'This weekday is configured as non-working.';
  } else {
    startTime = timeText(special?.startTime || weekday.startTime);
    endTime = timeText(special?.endTime || weekday.endTime);
    if (!startTime || !endTime || endTime <= startTime) {
      reason = 'No valid working hours are configured for this date.';
    } else if (weekday.isWorking && (startTime < timeText(weekday.startTime) || endTime > timeText(weekday.endTime))) {
      reason = 'The special-day hours no longer fit within the configured weekday hours.';
    } else {
      allowed = true;
      reason = special ? 'Approved special working day.' : 'Regular working day.';
    }
  }

  let slots = [];
  if (allowed) {
    const [rows] = await connection.execute(`SELECT s.id, s.slot_code AS slotId,
        TIME_FORMAT(s.start_time, '%H:%i') AS startTime,
        TIME_FORMAT(s.end_time, '%H:%i') AS endTime,
        GROUP_CONCAT(DISTINCT w.day_label ORDER BY w.day_order SEPARATOR ', ') AS workingDays
      FROM time_slots s
      JOIN time_slot_weekdays sw ON sw.time_slot_id = s.id
      JOIN working_weekdays w ON w.id = sw.weekday_id
      WHERE s.status = 'active' AND s.deleted_at IS NULL
        AND (? = 1 OR w.id = ?)
      GROUP BY s.id, s.slot_code, s.start_time, s.end_time
      HAVING startTime >= ? AND endTime <= ?
      ORDER BY s.start_time, s.id`, [special && !weekday.isWorking ? 1 : 0, weekday.id, startTime, endTime]);
    slots = rows;
  }
  return {
    date: isoDate,
    weekday: weekday.dayLabel,
    weekdayKey: weekday.dayKey,
    isRegularWorkingDay: Boolean(weekday.isWorking),
    exception: holiday ? { id: holiday.id, type: 'holiday', name: holiday.eventName }
      : special ? { id: special.id, type: 'special_working_day', name: special.eventName } : null,
    schedulingAllowed: allowed,
    reason,
    workingHours: allowed ? { startTime, endTime } : null,
    slots,
  };
}

module.exports = { validIsoDate, weekdayOrder, getSchedulingContext };
