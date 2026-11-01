'use strict';

function asId(value) {
  return /^\d+$/.test(String(value ?? '')) && Number(value) > 0 ? Number(value) : null;
}

/**
 * Validates references and acquires pessimistic locks (TC34, TC39).
 * Lock order: academic_sections -> users -> rooms to prevent deadlocks.
 */
async function validateSchedulingEntities(connection, input) {
  // 1. Verify section and acquire section lock (TC37 & concurrency)
  const [sections] = await connection.execute(
    'SELECT id, programme_id AS programmeId, section_name AS sectionName, is_active AS isActive FROM academic_sections WHERE id = ? FOR UPDATE',
    [input.sectionId]
  );
  if (!sections.length || !sections[0].isActive) {
    return { error: 'Selected class/section is invalid or inactive.' };
  }

  // 2. Verify subject
  const [subjects] = await connection.execute(
    'SELECT id, subject_name AS subjectName, is_active AS isActive FROM subjects WHERE id = ? LIMIT 1',
    [input.subjectId]
  );
  if (!subjects.length || !subjects[0].isActive) {
    return { error: 'Selected subject is invalid or inactive.' };
  }

  // 3. Verify teacher and acquire teacher user lock (TC36 & concurrency)
  const [teachers] = await connection.execute(
    "SELECT u.id, u.name, u.is_active AS isActive FROM users u WHERE u.id = ? AND u.role = 'teacher' FOR UPDATE",
    [input.teacherUserId]
  );
  if (!teachers.length || !teachers[0].isActive) {
    return { error: 'Selected teacher is invalid or inactive.' };
  }

  // 4. Verify room and acquire room lock (TC38 & concurrency)
  const [rooms] = await connection.execute(
    'SELECT id, room_number AS roomNumber, is_active AS isActive, availability_status AS availabilityStatus FROM rooms WHERE id = ? FOR UPDATE',
    [input.roomId]
  );
  if (!rooms.length || !rooms[0].isActive) {
    return { error: 'Selected room is invalid or unavailable.' };
  }
  if (rooms[0].availabilityStatus === 'maintenance') {
    return { error: 'Selected room is currently under maintenance. Please select an available room.' };
  }

  // 5. Verify working day (TC39)
  const [weekdays] = await connection.execute(
    'SELECT id, day_key AS dayKey, day_label AS dayLabel, is_working AS isWorking FROM working_weekdays WHERE id = ? LIMIT 1',
    [input.weekdayId]
  );
  if (!weekdays.length) {
    return { error: 'Selected weekday is invalid.' };
  }
  if (!weekdays[0].isWorking) {
    return {
      error: `Non-working day error: ${weekdays[0].dayLabel} is not configured as an active working day. Timetable entries cannot be scheduled on non-working days.`,
    };
  }

  // 6. Verify time slot & fetch time boundaries
  const [slots] = await connection.execute(
    'SELECT id, slot_code AS slotCode, start_time AS startTime, end_time AS endTime, status, deleted_at AS deletedAt FROM time_slots WHERE id = ? LIMIT 1',
    [input.timeSlotId]
  );
  if (!slots.length || slots[0].deletedAt || slots[0].status !== 'active') {
    return { error: 'Selected time slot is invalid, deleted, or not active.' };
  }

  return {
    valid: true,
    slotInfo: {
      id: slots[0].id,
      slotCode: slots[0].slotCode,
      startTime: slots[0].startTime,
      endTime: slots[0].endTime,
    },
  };
}

/**
 * Module 8: Conflict Detection (TC36, TC37, TC38)
 * Compares actual start_time and end_time intervals to prevent overlapping bookings.
 * Two intervals [startA, endA) and [startB, endB) overlap if startA < endB AND endA > startB.
 */
async function detectConflicts(connection, input, excludeId = null) {
  const { startTime, endTime } = input.slotInfo;

  // TC36: Teacher scheduling conflict
  const [teacherConflicts] = await connection.execute(`
    SELECT
      t.id,
      u.name AS teacherName,
      sec.section_name AS sectionName,
      sub.subject_name AS subjectName,
      w.day_label AS dayLabel,
      ts.slot_code AS slotCode,
      TIME_FORMAT(ts.start_time, '%H:%i') AS startTime,
      TIME_FORMAT(ts.end_time, '%H:%i') AS endTime
    FROM timetable_entries t
    JOIN users u ON u.id = t.teacher_user_id
    JOIN academic_sections sec ON sec.id = t.section_id
    JOIN subjects sub ON sub.id = t.subject_id
    JOIN working_weekdays w ON w.id = t.weekday_id
    JOIN time_slots ts ON ts.id = t.time_slot_id
    WHERE t.teacher_user_id = ?
      AND t.weekday_id = ?
      AND (? IS NULL OR t.id <> ?)
      AND ? < ts.end_time
      AND ? > ts.start_time
    LIMIT 1
    FOR SHARE
  `, [input.teacherUserId, input.weekdayId, excludeId, excludeId, startTime, endTime]);

  if (teacherConflicts.length > 0) {
    const c = teacherConflicts[0];
    return {
      conflict: true,
      type: 'teacher',
      error: `Teacher conflict: ${c.teacherName} is already scheduled for section ${c.sectionName} (${c.subjectName}) on ${c.dayLabel} during ${c.startTime} – ${c.endTime} (${c.slotCode}). Please select a different teacher or time slot.`,
    };
  }

  // TC37: Class / Section scheduling conflict
  const [sectionConflicts] = await connection.execute(`
    SELECT
      t.id,
      sec.section_name AS sectionName,
      sub.subject_name AS subjectName,
      w.day_label AS dayLabel,
      ts.slot_code AS slotCode,
      TIME_FORMAT(ts.start_time, '%H:%i') AS startTime,
      TIME_FORMAT(ts.end_time, '%H:%i') AS endTime
    FROM timetable_entries t
    JOIN academic_sections sec ON sec.id = t.section_id
    JOIN subjects sub ON sub.id = t.subject_id
    JOIN working_weekdays w ON w.id = t.weekday_id
    JOIN time_slots ts ON ts.id = t.time_slot_id
    WHERE t.section_id = ?
      AND t.weekday_id = ?
      AND (? IS NULL OR t.id <> ?)
      AND ? < ts.end_time
      AND ? > ts.start_time
    LIMIT 1
    FOR SHARE
  `, [input.sectionId, input.weekdayId, excludeId, excludeId, startTime, endTime]);

  if (sectionConflicts.length > 0) {
    const c = sectionConflicts[0];
    return {
      conflict: true,
      type: 'section',
      error: `Section conflict: Section ${c.sectionName} already has subject "${c.subjectName}" scheduled on ${c.dayLabel} during ${c.startTime} – ${c.endTime} (${c.slotCode}). A section cannot have overlapping classes.`,
    };
  }

  // TC38: Classroom / Laboratory allocation conflict
  const [roomConflicts] = await connection.execute(`
    SELECT
      t.id,
      r.room_number AS roomNumber,
      b.building_name AS buildingName,
      sec.section_name AS sectionName,
      w.day_label AS dayLabel,
      ts.slot_code AS slotCode,
      TIME_FORMAT(ts.start_time, '%H:%i') AS startTime,
      TIME_FORMAT(ts.end_time, '%H:%i') AS endTime
    FROM timetable_entries t
    JOIN rooms r ON r.id = t.room_id
    JOIN buildings b ON b.id = r.building_id
    JOIN academic_sections sec ON sec.id = t.section_id
    JOIN working_weekdays w ON w.id = t.weekday_id
    JOIN time_slots ts ON ts.id = t.time_slot_id
    WHERE t.room_id = ?
      AND t.weekday_id = ?
      AND (? IS NULL OR t.id <> ?)
      AND ? < ts.end_time
      AND ? > ts.start_time
    LIMIT 1
    FOR SHARE
  `, [input.roomId, input.weekdayId, excludeId, excludeId, startTime, endTime]);

  if (roomConflicts.length > 0) {
    const c = roomConflicts[0];
    return {
      conflict: true,
      type: 'room',
      error: `Room allocation conflict: Room ${c.roomNumber} (${c.buildingName}) is already occupied by section ${c.sectionName} on ${c.dayLabel} during ${c.startTime} – ${c.endTime} (${c.slotCode}). Please select a different room or time slot.`,
    };
  }

  return { conflict: false };
}

/**
 * Checks for exact duplicates (TC35)
 */
async function checkDuplicateEntry(connection, input, excludeId = null) {
  const [duplicates] = await connection.execute(`
    SELECT id FROM timetable_entries
    WHERE section_id = ?
      AND subject_id = ?
      AND teacher_user_id = ?
      AND weekday_id = ?
      AND time_slot_id = ?
      AND (? IS NULL OR id <> ?)
    LIMIT 1
    FOR SHARE
  `, [
    input.sectionId,
    input.subjectId,
    input.teacherUserId,
    input.weekdayId,
    input.timeSlotId,
    excludeId,
    excludeId,
  ]);

  return duplicates.length > 0;
}

module.exports = {
  asId,
  validateSchedulingEntities,
  detectConflicts,
  checkDuplicateEntry,
};

