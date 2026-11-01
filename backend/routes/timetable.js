'use strict';

const express = require('express');
const pool = require('../database/pool');
const {
  asId,
  validateSchedulingEntities,
  detectConflicts,
  checkDuplicateEntry,
} = require('../services/timetable-conflict-service');
const { sendTimetableRescheduleNotification } = require('../services/timetable-notifications');

const router = express.Router();
const pageSize = 10;

function badRequest(res, error, status = 400) {
  return res.status(status).json({ error });
}

function parseTimetableInput(body) {
  const sectionId = asId(body?.sectionId);
  const subjectId = asId(body?.subjectId);
  const teacherUserId = asId(body?.teacherUserId);
  const roomId = asId(body?.roomId);
  const weekdayId = asId(body?.weekdayId);
  const timeSlotId = asId(body?.timeSlotId);
  const academicYearId = body?.academicYearId !== undefined && body.academicYearId !== '' ? asId(body.academicYearId) : null;
  const semesterId = body?.semesterId !== undefined && body.semesterId !== '' ? asId(body.semesterId) : null;

  if (!sectionId) return { error: 'Select a valid class/section.' };
  if (!subjectId) return { error: 'Select a valid subject.' };
  if (!teacherUserId) return { error: 'Select a valid teacher.' };
  if (!roomId) return { error: 'Select a valid classroom or laboratory.' };
  if (!weekdayId) return { error: 'Select a valid working day.' };
  if (!timeSlotId) return { error: 'Select a valid time slot.' };

  return { sectionId, subjectId, teacherUserId, roomId, weekdayId, timeSlotId, academicYearId, semesterId };
}

router.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return badRequest(res, 'Send timetable requests as JSON.', 415);
  }
  next();
});

// Dropdown options for UI forms
router.get('/options', async (req, res, next) => {
  try {
    const [programmes] = await pool.execute(`
      SELECT id, code, name
      FROM academic_programmes
      WHERE is_active = 1
      ORDER BY name
    `);

    const [semesters] = await pool.execute(`
      SELECT id, semester_number AS semesterNumber, label
      FROM academic_semesters
      WHERE is_active = 1
      ORDER BY semester_number
    `);

    const [sections] = await pool.execute(`
      SELECT
        s.id,
        s.section_name AS sectionName,
        s.programme_id AS programmeId,
        p.name AS programmeName,
        s.is_active AS isActive
      FROM academic_sections s
      JOIN academic_programmes p ON p.id = s.programme_id
      WHERE s.is_active = 1
      ORDER BY p.name, s.section_name
    `);

    const [subjects] = await pool.execute(`
      SELECT id, subject_code AS code, subject_name AS name
      FROM subjects
      WHERE is_active = 1
      ORDER BY subject_name
    `);

    const [teachers] = await pool.execute(`
      SELECT u.id, u.name, tp.department, tp.designation
      FROM users u
      LEFT JOIN teacher_profiles tp ON u.id = tp.user_id
      WHERE u.role = 'teacher' AND u.is_active = 1
      ORDER BY u.name
    `);

    const [rooms] = await pool.execute(`
      SELECT r.id, r.room_number AS roomNumber, r.room_type AS roomType, r.capacity, b.building_name AS buildingName
      FROM rooms r
      JOIN buildings b ON b.id = r.building_id
      WHERE r.is_active = 1 AND r.availability_status = 'available'
      ORDER BY r.room_number
    `);

    const [weekdays] = await pool.execute(`
      SELECT id, day_key AS dayKey, day_label AS dayLabel, day_order AS dayOrder
      FROM working_weekdays
      WHERE is_working = 1
      ORDER BY day_order
    `);

    const [timeSlots] = await pool.execute(`
      SELECT id, slot_code AS slotCode, TIME_FORMAT(start_time, '%H:%i') AS startTime, TIME_FORMAT(end_time, '%H:%i') AS endTime
      FROM time_slots
      WHERE status = 'active' AND deleted_at IS NULL
      ORDER BY start_time
    `);

    res.json({ programmes, semesters, sections, subjects, teachers, rooms, weekdays, timeSlots });
  } catch (error) {
    next(error);
  }
});

// TC46 / Admin: Teacher Rescheduling Permissions
router.get('/permissions/teachers', async (req, res, next) => {
  try {
    const [teachers] = await pool.execute(`
      SELECT
        u.id,
        u.name,
        u.email,
        u.login_id AS loginId,
        tp.teacher_id AS teacherId,
        tp.department,
        COALESCE(tra.is_authorized, 0) AS isAuthorized,
        tra.notes,
        tra.granted_at AS grantedAt,
        gu.name AS grantedByName
      FROM users u
      LEFT JOIN teacher_profiles tp ON tp.user_id = u.id
      LEFT JOIN teacher_rescheduling_authorizations tra ON tra.user_id = u.id
      LEFT JOIN users gu ON gu.id = tra.granted_by_user_id
      WHERE u.role = 'teacher' AND u.is_active = 1
      ORDER BY u.name ASC
    `);

    res.json({ teachers });
  } catch (error) {
    next(error);
  }
});

router.post('/permissions/teachers/:userId', async (req, res, next) => {
  const teacherUserId = asId(req.params.userId);
  if (!teacherUserId) return badRequest(res, 'Teacher not found.', 404);

  const isAuthorized = req.body.isAuthorized === true || req.body.isAuthorized === 1 || req.body.isAuthorized === '1';
  const notes = typeof req.body.notes === 'string' ? req.body.notes.trim().slice(0, 255) : null;

  try {
    const [user] = await pool.execute("SELECT id, name FROM users WHERE id = ? AND role = 'teacher'", [teacherUserId]);
    if (!user.length) return badRequest(res, 'Teacher not found.', 404);

    await pool.execute(`
      INSERT INTO teacher_rescheduling_authorizations (user_id, is_authorized, notes, granted_by_user_id)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        is_authorized = VALUES(is_authorized),
        notes = VALUES(notes),
        granted_by_user_id = VALUES(granted_by_user_id),
        updated_at = CURRENT_TIMESTAMP
    `, [teacherUserId, isAuthorized ? 1 : 0, notes, req.user.id]);

    res.json({
      message: `Teacher ${user[0].name} rescheduling authorization ${isAuthorized ? 'granted' : 'revoked'}.`,
      isAuthorized,
    });
  } catch (error) {
    next(error);
  }
});

// Step 3 / Change Logs Audit Trail
router.get('/change-logs', async (req, res, next) => {
  try {
    const entryId = asId(req.query.entryId);
    const conditions = [];
    const args = [];

    if (entryId) {
      conditions.push('l.timetable_entry_id = ?');
      args.push(entryId);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [logs] = await pool.execute(`
      SELECT
        l.id,
        l.timetable_entry_id AS timetableEntryId,
        l.action_type AS actionType,
        l.reason,
        l.changed_by_user_id AS changedByUserId,
        l.changed_by_role AS changedByRole,
        u.name AS changedByName,
        l.notification_sent AS notificationSent,
        l.notification_recipient_count AS notificationRecipientCount,
        l.notification_error AS notificationError,
        l.created_at AS createdAt,
        pw.day_label AS previousDay,
        pts.slot_code AS previousSlot,
        TIME_FORMAT(pts.start_time, '%H:%i') AS previousStartTime,
        TIME_FORMAT(pts.end_time, '%H:%i') AS previousEndTime,
        nw.day_label AS newDay,
        nts.slot_code AS newSlot,
        TIME_FORMAT(nts.start_time, '%H:%i') AS newStartTime,
        TIME_FORMAT(nts.end_time, '%H:%i') AS newEndTime,
        pr.room_number AS previousRoom,
        nr.room_number AS newRoom,
        sub.subject_name AS subjectName,
        sub.subject_code AS subjectCode,
        sec.section_name AS sectionName
      FROM timetable_change_logs l
      JOIN users u ON u.id = l.changed_by_user_id
      LEFT JOIN working_weekdays pw ON pw.id = l.previous_weekday_id
      LEFT JOIN time_slots pts ON pts.id = l.previous_time_slot_id
      LEFT JOIN working_weekdays nw ON nw.id = l.new_weekday_id
      LEFT JOIN time_slots nts ON nts.id = l.new_time_slot_id
      LEFT JOIN rooms pr ON pr.id = l.previous_room_id
      LEFT JOIN rooms nr ON nr.id = l.new_room_id
      LEFT JOIN subjects sub ON sub.id = COALESCE(l.new_subject_id, l.previous_subject_id)
      LEFT JOIN academic_sections sec ON sec.id = COALESCE(l.new_section_id, l.previous_section_id)
      ${whereClause}
      ORDER BY l.created_at DESC
      LIMIT 100
    `, args);

    res.json({ logs });
  } catch (error) {
    next(error);
  }
});

// TC42, TC43: Timetable List & Search API with multi-filter and grid support
router.get('/', async (req, res, next) => {
  try {
    const programmeId = asId(req.query.programmeId);
    const sectionId = asId(req.query.sectionId);
    const semesterId = asId(req.query.semesterId);
    const teacherId = asId(req.query.teacherId);
    const subjectId = asId(req.query.subjectId);
    const weekdayId = asId(req.query.weekdayId);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || pageSize));
    const offset = (page - 1) * limit;
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 80) : '';

    const conditions = [];
    const args = [];

    if (programmeId) {
      conditions.push('sec.programme_id = ?');
      args.push(programmeId);
    }
    if (sectionId) {
      conditions.push('t.section_id = ?');
      args.push(sectionId);
    }
    if (semesterId) {
      conditions.push('t.semester_id = ?');
      args.push(semesterId);
    }
    if (teacherId) {
      conditions.push('t.teacher_user_id = ?');
      args.push(teacherId);
    }
    if (subjectId) {
      conditions.push('t.subject_id = ?');
      args.push(subjectId);
    }
    if (weekdayId) {
      conditions.push('t.weekday_id = ?');
      args.push(weekdayId);
    }
    if (search) {
      conditions.push('(sec.section_name LIKE ? OR sub.subject_name LIKE ? OR sub.subject_code LIKE ? OR u.name LIKE ? OR r.room_number LIKE ?)');
      const term = `%${search}%`;
      args.push(term, term, term, term, term);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [countResult] = await pool.execute(`
      SELECT COUNT(*) AS total
      FROM timetable_entries t
      JOIN academic_sections sec ON sec.id = t.section_id
      JOIN subjects sub ON sub.id = t.subject_id
      JOIN users u ON u.id = t.teacher_user_id
      JOIN rooms r ON r.id = t.room_id
      JOIN working_weekdays w ON w.id = t.weekday_id
      JOIN time_slots ts ON ts.id = t.time_slot_id
      ${whereClause}
    `, args);

    const total = countResult[0]?.total || 0;

    const [entries] = await pool.execute(`
      SELECT
        t.id,
        t.section_id AS sectionId,
        sec.section_name AS sectionName,
        p.id AS programmeId,
        p.name AS programmeName,
        t.semester_id AS semesterId,
        t.subject_id AS subjectId,
        sub.subject_code AS subjectCode,
        sub.subject_name AS subjectName,
        t.teacher_user_id AS teacherUserId,
        u.name AS teacherName,
        tp.teacher_id AS teacherId,
        t.room_id AS roomId,
        r.room_number AS roomNumber,
        b.building_name AS buildingName,
        t.weekday_id AS weekdayId,
        w.day_key AS dayKey,
        w.day_label AS dayLabel,
        w.day_order AS dayOrder,
        t.time_slot_id AS timeSlotId,
        ts.slot_code AS slotCode,
        TIME_FORMAT(ts.start_time, '%H:%i') AS startTime,
        TIME_FORMAT(ts.end_time, '%H:%i') AS endTime,
        t.created_at AS createdAt,
        t.updated_at AS updatedAt
      FROM timetable_entries t
      JOIN academic_sections sec ON sec.id = t.section_id
      JOIN academic_programmes p ON p.id = sec.programme_id
      JOIN subjects sub ON sub.id = t.subject_id
      JOIN users u ON u.id = t.teacher_user_id
      LEFT JOIN teacher_profiles tp ON tp.user_id = u.id
      JOIN rooms r ON r.id = t.room_id
      JOIN buildings b ON b.id = r.building_id
      JOIN working_weekdays w ON w.id = t.weekday_id
      JOIN time_slots ts ON ts.id = t.time_slot_id
      ${whereClause}
      ORDER BY w.day_order, ts.start_time, sec.section_name
      LIMIT ? OFFSET ?
    `, [...args, String(limit), String(offset)]);

    const [weekdays] = await pool.execute(`
      SELECT id, day_key AS dayKey, day_label AS dayLabel, day_order AS dayOrder
      FROM working_weekdays
      WHERE is_working = 1
      ORDER BY day_order
    `);

    const [timeSlots] = await pool.execute(`
      SELECT id, slot_code AS slotCode, TIME_FORMAT(start_time, '%H:%i') AS startTime, TIME_FORMAT(end_time, '%H:%i') AS endTime
      FROM time_slots
      WHERE status = 'active' AND deleted_at IS NULL
      ORDER BY start_time
    `);

    const matrix = {};
    for (const entry of entries) {
      if (!matrix[entry.weekdayId]) matrix[entry.weekdayId] = {};
      if (!matrix[entry.weekdayId][entry.timeSlotId]) matrix[entry.weekdayId][entry.timeSlotId] = [];
      matrix[entry.weekdayId][entry.timeSlotId].push(entry);
    }

    res.json({
      entries,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      grid: {
        weekdays,
        timeSlots,
        matrix,
      },
    });
  } catch (error) {
    next(error);
  }
});

// TC44: Admin CSV Export
router.get('/export', async (req, res, next) => {
  try {
    const programmeId = asId(req.query.programmeId);
    const sectionId = asId(req.query.sectionId);
    const semesterId = asId(req.query.semesterId);
    const teacherId = asId(req.query.teacherId);
    const subjectId = asId(req.query.subjectId);
    const weekdayId = asId(req.query.weekdayId);
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 80) : '';

    const conditions = [];
    const args = [];

    if (programmeId) {
      conditions.push('sec.programme_id = ?');
      args.push(programmeId);
    }
    if (sectionId) {
      conditions.push('t.section_id = ?');
      args.push(sectionId);
    }
    if (semesterId) {
      conditions.push('t.semester_id = ?');
      args.push(semesterId);
    }
    if (teacherId) {
      conditions.push('t.teacher_user_id = ?');
      args.push(teacherId);
    }
    if (subjectId) {
      conditions.push('t.subject_id = ?');
      args.push(subjectId);
    }
    if (weekdayId) {
      conditions.push('t.weekday_id = ?');
      args.push(weekdayId);
    }
    if (search) {
      conditions.push('(sec.section_name LIKE ? OR sub.subject_name LIKE ? OR sub.subject_code LIKE ? OR u.name LIKE ? OR r.room_number LIKE ?)');
      const term = `%${search}%`;
      args.push(term, term, term, term, term);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [entries] = await pool.execute(`
      SELECT
        w.day_label AS Day,
        ts.slot_code AS Slot,
        TIME_FORMAT(ts.start_time, '%H:%i') AS StartTime,
        TIME_FORMAT(ts.end_time, '%H:%i') AS EndTime,
        sec.section_name AS Section,
        p.name AS Programme,
        t.semester_id AS Semester,
        sub.subject_code AS SubjectCode,
        sub.subject_name AS SubjectName,
        u.name AS Teacher,
        r.room_number AS Room,
        b.building_name AS Building
      FROM timetable_entries t
      JOIN academic_sections sec ON sec.id = t.section_id
      JOIN academic_programmes p ON p.id = sec.programme_id
      JOIN subjects sub ON sub.id = t.subject_id
      JOIN users u ON u.id = t.teacher_user_id
      JOIN rooms r ON r.id = t.room_id
      JOIN buildings b ON b.id = r.building_id
      JOIN working_weekdays w ON w.id = t.weekday_id
      JOIN time_slots ts ON ts.id = t.time_slot_id
      ${whereClause}
      ORDER BY w.day_order, ts.start_time, sec.section_name
    `, args);

    const header = ['Day', 'Slot', 'Start Time', 'End Time', 'Class/Section', 'Programme', 'Semester', 'Subject Code', 'Subject Name', 'Teacher', 'Room', 'Building'];
    const rows = entries.map(e => [
      `"${e.Day}"`,
      `"${e.Slot}"`,
      `"${e.StartTime}"`,
      `"${e.EndTime}"`,
      `"${e.Section}"`,
      `"${e.Programme}"`,
      `"${e.Semester || ''}"`,
      `"${e.SubjectCode || ''}"`,
      `"${e.SubjectName}"`,
      `"${e.Teacher}"`,
      `"${e.Room}"`,
      `"${e.Building}"`,
    ]);

    const csv = [header.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="admin-timetable.csv"');
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  const entryId = asId(req.params.id);
  if (!entryId) return badRequest(res, 'Timetable entry not found.', 404);

  try {
    const [entries] = await pool.execute(`
      SELECT
        t.id,
        t.section_id AS sectionId,
        sec.section_name AS sectionName,
        p.id AS programmeId,
        p.name AS programmeName,
        t.subject_id AS subjectId,
        sub.subject_code AS subjectCode,
        sub.subject_name AS subjectName,
        t.teacher_user_id AS teacherUserId,
        u.name AS teacherName,
        tp.teacher_id AS teacherId,
        t.room_id AS roomId,
        r.room_number AS roomNumber,
        b.building_name AS buildingName,
        t.weekday_id AS weekdayId,
        w.day_key AS dayKey,
        w.day_label AS dayLabel,
        t.time_slot_id AS timeSlotId,
        ts.slot_code AS slotCode,
        TIME_FORMAT(ts.start_time, '%H:%i') AS startTime,
        TIME_FORMAT(ts.end_time, '%H:%i') AS endTime,
        t.created_at AS createdAt,
        t.updated_at AS updatedAt
      FROM timetable_entries t
      JOIN academic_sections sec ON sec.id = t.section_id
      JOIN academic_programmes p ON p.id = sec.programme_id
      JOIN subjects sub ON sub.id = t.subject_id
      JOIN users u ON u.id = t.teacher_user_id
      LEFT JOIN teacher_profiles tp ON tp.user_id = u.id
      JOIN rooms r ON r.id = t.room_id
      JOIN buildings b ON b.id = r.building_id
      JOIN working_weekdays w ON w.id = t.weekday_id
      JOIN time_slots ts ON ts.id = t.time_slot_id
      WHERE t.id = ?
      LIMIT 1
    `, [entryId]);

    if (!entries.length) return badRequest(res, 'Timetable entry not found.', 404);
    res.json({ entry: entries[0] });
  } catch (error) {
    next(error);
  }
});

// TC31 & TC34 & TC35 & TC36-TC39: Create a timetable entry with conflict detection
router.post('/', async (req, res, next) => {
  const input = parseTimetableInput(req.body);
  if (input.error) return badRequest(res, input.error, 400);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const entityValidation = await validateSchedulingEntities(connection, input);
    if (entityValidation.error) {
      await connection.rollback();
      return badRequest(res, entityValidation.error, 400);
    }
    input.slotInfo = entityValidation.slotInfo;

    const isDuplicate = await checkDuplicateEntry(connection, input);
    if (isDuplicate) {
      await connection.rollback();
      return badRequest(
        res,
        'A duplicate timetable entry already exists with the same Class, Section, Subject, Teacher, Day and Time Slot.',
        409
      );
    }

    const conflictResult = await detectConflicts(connection, input);
    if (conflictResult.conflict) {
      await connection.rollback();
      return badRequest(res, conflictResult.error, 409);
    }

    const [result] = await connection.execute(`
      INSERT INTO timetable_entries (
        section_id,
        subject_id,
        teacher_user_id,
        room_id,
        weekday_id,
        time_slot_id,
        academic_year_id,
        semester_id,
        created_by_user_id,
        updated_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      input.sectionId,
      input.subjectId,
      input.teacherUserId,
      input.roomId,
      input.weekdayId,
      input.timeSlotId,
      input.academicYearId,
      input.semesterId,
      req.user.id,
      req.user.id,
    ]);

    await connection.commit();

    res.status(201).json({
      id: result.insertId,
      message: 'Timetable entry created and saved successfully.',
    });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') {
      return badRequest(
        res,
        'A duplicate timetable entry already exists with the same Class, Section, Subject, Teacher, Day and Time Slot.',
        409
      );
    }
    next(error);
  } finally {
    connection.release();
  }
});

// Rescheduling / Edit Handler (TC32, TC33, TC36-TC39, TC45, TC47, TC48)
async function handleUpdateOrReschedule(req, res, next) {
  const entryId = asId(req.params.id);
  if (!entryId) return badRequest(res, 'Timetable entry not found.', 404);

  const input = parseTimetableInput(req.body);
  if (input.error) return badRequest(res, input.error, 400);

  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 1. Verify entry exists and capture previous state
    const [existing] = await connection.execute(`
      SELECT
        t.id,
        t.section_id,
        t.subject_id,
        t.teacher_user_id,
        t.room_id,
        t.weekday_id,
        t.time_slot_id,
        sec.section_name AS sectionName,
        sub.subject_code AS subjectCode,
        sub.subject_name AS subjectName,
        u.name AS teacherName,
        u.email AS teacherEmail,
        r.room_number AS roomNumber,
        w.day_label AS dayLabel,
        ts.slot_code AS slotCode,
        TIME_FORMAT(ts.start_time, '%H:%i') AS startTime,
        TIME_FORMAT(ts.end_time, '%H:%i') AS endTime
      FROM timetable_entries t
      JOIN academic_sections sec ON sec.id = t.section_id
      JOIN subjects sub ON sub.id = t.subject_id
      JOIN users u ON u.id = t.teacher_user_id
      JOIN rooms r ON r.id = t.room_id
      JOIN working_weekdays w ON w.id = t.weekday_id
      JOIN time_slots ts ON ts.id = t.time_slot_id
      WHERE t.id = ?
      FOR UPDATE
    `, [entryId]);

    if (!existing.length) {
      await connection.rollback();
      return badRequest(res, 'Timetable entry not found.', 404);
    }
    const prev = existing[0];

    // 2. Validate entities & active working day (TC34, TC39) with resource locks
    const entityValidation = await validateSchedulingEntities(connection, input);
    if (entityValidation.error) {
      await connection.rollback();
      return badRequest(res, entityValidation.error, 400);
    }
    input.slotInfo = entityValidation.slotInfo;

    // 3. Prevent duplicate entry with another existing record (TC35)
    const isDuplicate = await checkDuplicateEntry(connection, input, entryId);
    if (isDuplicate) {
      await connection.rollback();
      return badRequest(
        res,
        'A duplicate timetable entry already exists with the same Class, Section, Subject, Teacher, Day and Time Slot.',
        409
      );
    }

    // 4. TC47: Conflict detection: teacher, section, room overlaps (TC36, TC37, TC38) excluding current entry
    const conflictResult = await detectConflicts(connection, input, entryId);
    if (conflictResult.conflict) {
      await connection.rollback();
      return badRequest(res, conflictResult.error, 409);
    }

    // 5. Update entry (TC32, TC33, TC45)
    await connection.execute(`
      UPDATE timetable_entries SET
        section_id = ?,
        subject_id = ?,
        teacher_user_id = ?,
        room_id = ?,
        weekday_id = ?,
        time_slot_id = ?,
        academic_year_id = ?,
        semester_id = ?,
        updated_by_user_id = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      input.sectionId,
      input.subjectId,
      input.teacherUserId,
      input.roomId,
      input.weekdayId,
      input.timeSlotId,
      input.academicYearId,
      input.semesterId,
      req.user.id,
      entryId,
    ]);

    // 6. Record in change logs (Step 3)
    const [changeLog] = await connection.execute(`
      INSERT INTO timetable_change_logs (
        timetable_entry_id, action_type,
        previous_section_id, previous_subject_id, previous_teacher_user_id, previous_room_id, previous_weekday_id, previous_time_slot_id,
        new_section_id, new_subject_id, new_teacher_user_id, new_room_id, new_weekday_id, new_time_slot_id,
        reason, changed_by_user_id, changed_by_role
      ) VALUES (?, 'reschedule', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      entryId,
      prev.section_id, prev.subject_id, prev.teacher_user_id, prev.room_id, prev.weekday_id, prev.time_slot_id,
      input.sectionId, input.subjectId, input.teacherUserId, input.roomId, input.weekdayId, input.timeSlotId,
      reason, req.user.id, req.user.role
    ]);

    await connection.commit();

    // 7. TC48: Dispatched AFTER successful commit - never affects transaction outcome
    const [newDetailsRows] = await pool.execute(`
      SELECT
        w.day_label AS dayLabel,
        ts.slot_code AS slotCode,
        TIME_FORMAT(ts.start_time, '%H:%i') AS startTime,
        TIME_FORMAT(ts.end_time, '%H:%i') AS endTime,
        r.room_number AS roomNumber
      FROM working_weekdays w, time_slots ts, rooms r
      WHERE w.id = ? AND ts.id = ? AND r.id = ?
    `, [input.weekdayId, input.timeSlotId, input.roomId]);

    const newDetails = newDetailsRows[0] || {};
    sendTimetableRescheduleNotification({
      changeLogId: changeLog.insertId,
      entryId,
      sectionId: input.sectionId,
      subjectName: prev.subjectName,
      subjectCode: prev.subjectCode,
      previousDetails: {
        dayLabel: prev.dayLabel,
        slotCode: prev.slotCode,
        startTime: prev.startTime,
        endTime: prev.endTime,
        roomName: prev.roomNumber,
        sectionName: prev.sectionName,
      },
      newDetails: {
        dayLabel: newDetails.dayLabel,
        slotCode: newDetails.slotCode,
        startTime: newDetails.startTime,
        endTime: newDetails.endTime,
        roomName: newDetails.roomNumber,
        sectionName: prev.sectionName,
      },
      reason,
      rescheduledBy: { name: req.user.name, role: req.user.role },
    }).catch(err => console.error('[Reschedule Notification]', err));

    res.json({
      message: 'Updated timetable details are saved and displayed successfully.',
      rescheduled: {
        id: entryId,
        weekdayId: input.weekdayId,
        timeSlotId: input.timeSlotId,
        teacherUserId: input.teacherUserId,
        roomId: input.roomId,
      },
    });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') {
      return badRequest(
        res,
        'A duplicate timetable entry already exists with the same Class, Section, Subject, Teacher, Day and Time Slot.',
        409
      );
    }
    next(error);
  } finally {
    connection.release();
  }
}

// TC32 & TC45: Edit and update an existing timetable entry
router.put('/:id', handleUpdateOrReschedule);
router.put('/:id/reschedule', handleUpdateOrReschedule);

// Delete entry
router.delete('/:id', async (req, res, next) => {
  const entryId = asId(req.params.id);
  if (!entryId) return badRequest(res, 'Timetable entry not found.', 404);

  try {
    const [result] = await pool.execute('DELETE FROM timetable_entries WHERE id = ?', [entryId]);
    if (!result.affectedRows) return badRequest(res, 'Timetable entry not found.', 404);
    res.json({ message: 'Timetable entry deleted successfully.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.validateSchedulingEntities = validateSchedulingEntities;
module.exports.detectConflicts = detectConflicts;
module.exports.checkDuplicateEntry = checkDuplicateEntry;
