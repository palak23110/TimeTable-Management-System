'use strict';

const express = require('express');
const pool = require('../database/pool');
const {
  asId,
  validateSchedulingEntities,
  detectConflicts,
} = require('../services/timetable-conflict-service');
const { sendTimetableRescheduleNotification } = require('../services/timetable-notifications');

const router = express.Router();

/**
 * TC40: Retrieve the logged-in teacher's timetable
 * Strictly scoped to req.user.id — teachers cannot access another teacher's timetable.
 */
router.get('/', async (req, res, next) => {
  try {
    const teacherUserId = req.user.id;

    // Security check: if teacherUserId is provided in query and differs from logged-in user, reject
    if (req.query.teacherUserId && Number(req.query.teacherUserId) !== teacherUserId) {
      return res.status(403).json({ error: 'Unauthorized: Teachers may only access their own timetable.' });
    }

    const weekdayId = asId(req.query.weekdayId);
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 80) : '';

    // Fetch teacher profile
    const [profiles] = await pool.execute(`
      SELECT tp.teacher_id AS teacherId, tp.department, u.name, u.email
      FROM users u
      LEFT JOIN teacher_profiles tp ON tp.user_id = u.id
      WHERE u.id = ? LIMIT 1
    `, [teacherUserId]);

    const teacher = profiles[0] || { name: req.user.name, teacherId: null, department: null };

    // Check rescheduling authorization for logged-in teacher (TC46)
    const [authRows] = await pool.execute(
      'SELECT is_authorized, notes FROM teacher_rescheduling_authorizations WHERE user_id = ?',
      [teacherUserId]
    );
    const canReschedule = authRows.length > 0 && authRows[0].is_authorized === 1;

    const conditions = ['t.teacher_user_id = ?'];
    const args = [teacherUserId];

    if (weekdayId) {
      conditions.push('t.weekday_id = ?');
      args.push(weekdayId);
    }
    if (search) {
      conditions.push('(sec.section_name LIKE ? OR sub.subject_name LIKE ? OR sub.subject_code LIKE ? OR r.room_number LIKE ?)');
      const term = `%${search}%`;
      args.push(term, term, term, term);
    }

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
        t.created_at AS createdAt
      FROM timetable_entries t
      JOIN academic_sections sec ON sec.id = t.section_id
      JOIN academic_programmes p ON p.id = sec.programme_id
      JOIN subjects sub ON sub.id = t.subject_id
      JOIN rooms r ON r.id = t.room_id
      JOIN buildings b ON b.id = r.building_id
      JOIN working_weekdays w ON w.id = t.weekday_id
      JOIN time_slots ts ON ts.id = t.time_slot_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY w.day_order, ts.start_time, sec.section_name
    `, args);

    // Fetch active weekdays and time slots to structure grid matrix
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
      matrix[entry.weekdayId][entry.timeSlotId] = entry;
    }

    res.json({
      teacher,
      canReschedule,
      entries,
      total: entries.length,
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

/**
 * TC46: Teacher Rescheduling Permission check
 */
router.get('/rescheduling-permission', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      'SELECT is_authorized AS isAuthorized, notes FROM teacher_rescheduling_authorizations WHERE user_id = ?',
      [req.user.id]
    );
    const isAuthorized = rows.length > 0 && rows[0].isAuthorized === 1;
    res.json({
      isAuthorized,
      notes: rows[0]?.notes || null,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Scheduling Options for Teacher Rescheduling Modal
 */
router.get('/reschedule-options', async (req, res, next) => {
  try {
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

    res.json({ rooms, weekdays, timeSlots });
  } catch (error) {
    next(error);
  }
});

/**
 * Step 3: Change Logs for Teacher
 */
router.get('/change-logs', async (req, res, next) => {
  try {
    const [logs] = await pool.execute(`
      SELECT
        l.id,
        l.timetable_entry_id AS timetableEntryId,
        l.action_type AS actionType,
        l.reason,
        l.changed_by_user_id AS changedByUserId,
        l.changed_by_role AS changedByRole,
        u.name AS changedByName,
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
      WHERE l.previous_teacher_user_id = ? OR l.new_teacher_user_id = ? OR l.changed_by_user_id = ?
      ORDER BY l.created_at DESC
      LIMIT 50
    `, [req.user.id, req.user.id, req.user.id]);

    res.json({ logs });
  } catch (error) {
    next(error);
  }
});

/**
 * TC46, TC47, TC48: Teacher Rescheduling Endpoint
 */
router.put('/:id/reschedule', async (req, res, next) => {
  const entryId = asId(req.params.id);
  if (!entryId) return res.status(404).json({ error: 'Timetable entry not found.' });

  // 1. TC46: Strict check of teacher rescheduling authorization
  const [authRows] = await pool.execute(
    'SELECT is_authorized FROM teacher_rescheduling_authorizations WHERE user_id = ?',
    [req.user.id]
  );
  if (!authRows.length || authRows[0].is_authorized !== 1) {
    return res.status(403).json({
      error: 'Unauthorized: You do not have permission to reschedule classes. Please contact an administrator.',
    });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 2. Fetch existing entry and verify ownership (teachers cannot modify other teachers' classes)
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
      return res.status(404).json({ error: 'Timetable entry not found.' });
    }

    const prev = existing[0];
    if (prev.teacher_user_id !== req.user.id) {
      await connection.rollback();
      return res.status(403).json({
        error: 'Unauthorized: You may only reschedule your own assigned classes.',
      });
    }

    // 3. Parse input parameters
    const weekdayId = asId(req.body.weekdayId) || prev.weekday_id;
    const timeSlotId = asId(req.body.timeSlotId) || prev.time_slot_id;
    const roomId = asId(req.body.roomId) || prev.room_id;
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;

    const schedulingInput = {
      sectionId: prev.section_id,
      subjectId: prev.subject_id,
      teacherUserId: req.user.id,
      roomId,
      weekdayId,
      timeSlotId,
    };

    // 4. Validate entities & working day (TC39)
    const entityValidation = await validateSchedulingEntities(connection, schedulingInput);
    if (entityValidation.error) {
      await connection.rollback();
      return res.status(400).json({ error: entityValidation.error });
    }
    schedulingInput.slotInfo = entityValidation.slotInfo;

    // 5. TC47: Check conflicts (Teacher, Section, Room, Overlaps)
    const conflictResult = await detectConflicts(connection, schedulingInput, entryId);
    if (conflictResult.conflict) {
      await connection.rollback();
      return res.status(409).json({ error: conflictResult.error });
    }

    // 6. Update timetable entry
    await connection.execute(`
      UPDATE timetable_entries SET
        room_id = ?,
        weekday_id = ?,
        time_slot_id = ?,
        updated_by_user_id = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [roomId, weekdayId, timeSlotId, req.user.id, entryId]);

    // 7. Insert change log
    const [changeLog] = await connection.execute(`
      INSERT INTO timetable_change_logs (
        timetable_entry_id, action_type,
        previous_section_id, previous_subject_id, previous_teacher_user_id, previous_room_id, previous_weekday_id, previous_time_slot_id,
        new_section_id, new_subject_id, new_teacher_user_id, new_room_id, new_weekday_id, new_time_slot_id,
        reason, changed_by_user_id, changed_by_role
      ) VALUES (?, 'reschedule', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'teacher')
    `, [
      entryId,
      prev.section_id, prev.subject_id, prev.teacher_user_id, prev.room_id, prev.weekday_id, prev.time_slot_id,
      prev.section_id, prev.subject_id, req.user.id, roomId, weekdayId, timeSlotId,
      reason, req.user.id
    ]);

    await connection.commit();

    // 8. TC48: Send notification asynchronously after commit
    const [newDetailsRows] = await pool.execute(`
      SELECT
        w.day_label AS dayLabel,
        ts.slot_code AS slotCode,
        TIME_FORMAT(ts.start_time, '%H:%i') AS startTime,
        TIME_FORMAT(ts.end_time, '%H:%i') AS endTime,
        r.room_number AS roomNumber
      FROM working_weekdays w, time_slots ts, rooms r
      WHERE w.id = ? AND ts.id = ? AND r.id = ?
    `, [weekdayId, timeSlotId, roomId]);

    const newDetails = newDetailsRows[0] || {};
    sendTimetableRescheduleNotification({
      changeLogId: changeLog.insertId,
      entryId,
      sectionId: prev.section_id,
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
      rescheduledBy: { name: req.user.name, role: 'teacher' },
    }).catch(err => console.error('[Teacher Reschedule Notification]', err));

    res.json({
      message: 'Class rescheduled successfully.',
      rescheduled: {
        id: entryId,
        weekdayId,
        timeSlotId,
        roomId,
      },
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

/**
 * TC44: Download / Export teacher timetable as CSV
 */
router.get('/export', async (req, res, next) => {
  try {
    const teacherUserId = req.user.id;
    if (req.query.teacherUserId && Number(req.query.teacherUserId) !== teacherUserId) {
      return res.status(403).json({ error: 'Unauthorized: Teachers may only export their own timetable.' });
    }

    const [entries] = await pool.execute(`
      SELECT
        w.day_label AS Day,
        ts.slot_code AS Slot,
        TIME_FORMAT(ts.start_time, '%H:%i') AS StartTime,
        TIME_FORMAT(ts.end_time, '%H:%i') AS EndTime,
        sec.section_name AS Section,
        p.name AS Programme,
        sub.subject_code AS SubjectCode,
        sub.subject_name AS SubjectName,
        r.room_number AS Room,
        b.building_name AS Building
      FROM timetable_entries t
      JOIN academic_sections sec ON sec.id = t.section_id
      JOIN academic_programmes p ON p.id = sec.programme_id
      JOIN subjects sub ON sub.id = t.subject_id
      JOIN rooms r ON r.id = t.room_id
      JOIN buildings b ON b.id = r.building_id
      JOIN working_weekdays w ON w.id = t.weekday_id
      JOIN time_slots ts ON ts.id = t.time_slot_id
      WHERE t.teacher_user_id = ?
      ORDER BY w.day_order, ts.start_time
    `, [teacherUserId]);

    const header = ['Day', 'Slot', 'Start Time', 'End Time', 'Class/Section', 'Programme', 'Subject Code', 'Subject Name', 'Room', 'Building'];
    const rows = entries.map(e => [
      `"${e.Day}"`,
      `"${e.Slot}"`,
      `"${e.StartTime}"`,
      `"${e.EndTime}"`,
      `"${e.Section}"`,
      `"${e.Programme}"`,
      `"${e.SubjectCode || ''}"`,
      `"${e.SubjectName}"`,
      `"${e.Room}"`,
      `"${e.Building}"`,
    ]);

    const csv = [header.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="teacher-timetable.csv"');
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
