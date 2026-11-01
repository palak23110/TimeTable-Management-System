'use strict';

const express = require('express');
const pool = require('../database/pool');

const router = express.Router();

function asId(value) {
  return /^\d+$/.test(String(value ?? '')) && Number(value) > 0 ? Number(value) : null;
}

/**
 * TC41: Retrieve the logged-in student's timetable
 * Strictly scoped to the student's assigned section — students cannot access another section's timetable.
 */
router.get('/', async (req, res, next) => {
  try {
    const studentUserId = req.user.id;

    // 1. Fetch student's profile and section assignment
    const [profiles] = await pool.execute(`
      SELECT
        sp.id AS profileId,
        sp.user_id AS userId,
        sp.student_id AS studentId,
        sp.name,
        sp.email,
        sp.programme_id AS programmeId,
        p.name AS programmeName,
        sp.current_semester_id AS currentSemesterId,
        sem.label AS semesterName,
        sp.section_id AS sectionId,
        sec.section_name AS sectionName
      FROM student_profiles sp
      LEFT JOIN academic_programmes p ON p.id = sp.programme_id
      LEFT JOIN academic_semesters sem ON sem.id = sp.current_semester_id
      LEFT JOIN academic_sections sec ON sec.id = sp.section_id
      WHERE sp.user_id = ?
      LIMIT 1
    `, [studentUserId]);

    const student = profiles[0] || {
      name: req.user.name,
      studentId: null,
      sectionId: null,
      sectionName: null,
      programmeName: null,
      semesterName: null,
    };

    // Security check: if student attempts to pass a sectionId different from their assigned section, reject
    if (req.query.sectionId && student.sectionId && Number(req.query.sectionId) !== Number(student.sectionId)) {
      return res.status(403).json({ error: 'Unauthorized: Students may only access their own section timetable.' });
    }

    if (!student.sectionId) {
      return res.json({
        hasSection: false,
        student,
        message: 'You have not been placed into an academic section yet. Please contact an administrator to complete your placement.',
        entries: [],
        grid: {
          weekdays: [],
          timeSlots: [],
          matrix: {},
        },
      });
    }

    const weekdayId = asId(req.query.weekdayId);
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 80) : '';

    const conditions = ['t.section_id = ?'];
    const args = [student.sectionId];

    if (weekdayId) {
      conditions.push('t.weekday_id = ?');
      args.push(weekdayId);
    }
    if (search) {
      conditions.push('(sub.subject_name LIKE ? OR sub.subject_code LIKE ? OR u.name LIKE ? OR r.room_number LIKE ?)');
      const term = `%${search}%`;
      args.push(term, term, term, term);
    }

    const [entries] = await pool.execute(`
      SELECT
        t.id,
        t.section_id AS sectionId,
        sec.section_name AS sectionName,
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
      JOIN users u ON u.id = t.teacher_user_id
      LEFT JOIN teacher_profiles tp ON tp.user_id = u.id
      JOIN rooms r ON r.id = t.room_id
      JOIN buildings b ON b.id = r.building_id
      JOIN working_weekdays w ON w.id = t.weekday_id
      JOIN time_slots ts ON ts.id = t.time_slot_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY w.day_order, ts.start_time
    `, args);

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
      hasSection: true,
      student,
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
 * TC44: Download / Export student timetable as CSV
 */
router.get('/export', async (req, res, next) => {
  try {
    const studentUserId = req.user.id;

    const [profiles] = await pool.execute(`
      SELECT sp.section_id AS sectionId, sec.section_name AS sectionName
      FROM student_profiles sp
      LEFT JOIN academic_sections sec ON sec.id = sp.section_id
      WHERE sp.user_id = ? LIMIT 1
    `, [studentUserId]);

    const sectionId = profiles[0]?.sectionId;
    if (req.query.sectionId && sectionId && Number(req.query.sectionId) !== Number(sectionId)) {
      return res.status(403).json({ error: 'Unauthorized: Students may only export their own section timetable.' });
    }

    if (!sectionId) {
      return res.status(400).json({ error: 'No academic section assigned to student.' });
    }

    const [entries] = await pool.execute(`
      SELECT
        w.day_label AS Day,
        ts.slot_code AS Slot,
        TIME_FORMAT(ts.start_time, '%H:%i') AS StartTime,
        TIME_FORMAT(ts.end_time, '%H:%i') AS EndTime,
        sec.section_name AS Section,
        sub.subject_code AS SubjectCode,
        sub.subject_name AS SubjectName,
        u.name AS Teacher,
        r.room_number AS Room,
        b.building_name AS Building
      FROM timetable_entries t
      JOIN academic_sections sec ON sec.id = t.section_id
      JOIN subjects sub ON sub.id = t.subject_id
      JOIN users u ON u.id = t.teacher_user_id
      JOIN rooms r ON r.id = t.room_id
      JOIN buildings b ON b.id = r.building_id
      JOIN working_weekdays w ON w.id = t.weekday_id
      JOIN time_slots ts ON ts.id = t.time_slot_id
      WHERE t.section_id = ?
      ORDER BY w.day_order, ts.start_time
    `, [sectionId]);

    const header = ['Day', 'Slot', 'Start Time', 'End Time', 'Class/Section', 'Subject Code', 'Subject Name', 'Teacher', 'Room', 'Building'];
    const rows = entries.map(e => [
      `"${e.Day}"`,
      `"${e.Slot}"`,
      `"${e.StartTime}"`,
      `"${e.EndTime}"`,
      `"${e.Section}"`,
      `"${e.SubjectCode || ''}"`,
      `"${e.SubjectName}"`,
      `"${e.Teacher}"`,
      `"${e.Room}"`,
      `"${e.Building}"`,
    ]);

    const csv = [header.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="student-timetable.csv"');
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

module.exports = router;

