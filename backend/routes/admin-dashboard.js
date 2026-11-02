'use strict';

const express = require('express');
const pool = require('../database/pool');

const router = express.Router();

function dateFromIso(value) {
  const text = String(value || '').slice(0, 10);
  const [year, month, day] = text.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function formatWeekRange(startIso, endIso) {
  const start = dateFromIso(startIso);
  const end = dateFromIso(endIso);
  const startMonth = new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' }).format(start);
  const endMonth = new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' }).format(end);
  const endYear = end.getUTCFullYear();
  if (start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === endYear) {
    return `${startMonth} ${start.getUTCDate()}–${end.getUTCDate()}, ${endYear}`;
  }
  return `${startMonth} ${start.getUTCDate()}–${endMonth} ${end.getUTCDate()}, ${endYear}`;
}

function countText(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

router.get('/stats', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');

    const [[overview]] = await pool.execute(`
      SELECT
        DATE_FORMAT(CURRENT_DATE(), '%Y-%m-%d') AS today,
        (SELECT COUNT(*)
          FROM users u
          JOIN teacher_profiles tp ON tp.user_id = u.id
          WHERE u.role = 'teacher' AND u.is_active = 1 AND tp.invitation_pending = 0
        ) AS activeTeachers,
        (SELECT CASE WHEN COUNT(*) = 1 THEN (
            SELECT COUNT(*)
            FROM users u
            JOIN teacher_profiles tp ON tp.user_id = u.id
            JOIN academic_terms t ON t.is_active = 1
            JOIN academic_years y ON y.id = t.academic_year_id AND y.is_active = 1
            WHERE u.role = 'teacher' AND u.is_active = 1 AND tp.invitation_pending = 0
              AND CURRENT_DATE() BETWEEN t.starts_on AND t.ends_on
              AND tp.created_at >= t.starts_on
              AND tp.created_at < DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY)
          ) ELSE NULL END
          FROM academic_terms t
          JOIN academic_years y ON y.id = t.academic_year_id
          WHERE t.is_active = 1 AND y.is_active = 1
            AND CURRENT_DATE() BETWEEN t.starts_on AND t.ends_on
        ) AS newTeachersThisTerm,
        (SELECT COUNT(*)
          FROM student_profiles sp
          JOIN users u ON u.id = sp.user_id AND u.role = 'student' AND u.is_active = 1
        ) AS activeStudents,
        (SELECT COUNT(*) FROM academic_programmes WHERE is_active = 1) AS activeProgrammes,
        (SELECT COUNT(*)
          FROM academic_sections s
          JOIN academic_programmes p ON p.id = s.programme_id AND p.is_active = 1
          WHERE s.is_active = 1
        ) AS activeSections,
        (SELECT COUNT(*) FROM subjects WHERE is_active = 1) AS activeSubjects,
        (SELECT COUNT(DISTINCT s.id)
          FROM subjects s
          WHERE s.is_active = 1 AND (
            EXISTS (
              SELECT 1 FROM teacher_subjects ts
              JOIN users u ON u.id = ts.teacher_user_id AND u.role = 'teacher' AND u.is_active = 1
              WHERE ts.subject_id = s.id
            )
            OR EXISTS (
              SELECT 1 FROM class_course_assignments cca
              JOIN academic_sections sec ON sec.id = cca.section_id AND sec.is_active = 1
              JOIN academic_programmes p ON p.id = sec.programme_id AND p.is_active = 1
              JOIN curriculum_subjects c ON c.id = cca.curriculum_subject_id AND c.is_active = 1
              WHERE c.subject_id = s.id
            )
            OR EXISTS (
              SELECT 1 FROM teacher_course_assignments tca
              JOIN users u ON u.id = tca.teacher_user_id AND u.role = 'teacher' AND u.is_active = 1
              JOIN academic_sections sec ON sec.id = tca.section_id AND sec.is_active = 1
              JOIN academic_programmes p ON p.id = sec.programme_id AND p.is_active = 1
              JOIN curriculum_subjects c ON c.id = tca.curriculum_subject_id AND c.is_active = 1
              WHERE c.subject_id = s.id
            )
          )
        ) AS assignedSubjects,
        (SELECT COUNT(*) FROM rooms WHERE is_active = 1) AS activeRooms,
        (SELECT COUNT(*) FROM rooms WHERE is_active = 1 AND room_type IN ('lab', 'language_lab')) AS activeLabs,
        (SELECT COUNT(*)
          FROM rooms r
          WHERE r.is_active = 1 AND r.availability_status = 'available'
            AND NOT EXISTS (
              SELECT 1
              FROM timetable_entries te
              JOIN time_slots ts ON ts.id = te.time_slot_id
                AND ts.status = 'active' AND ts.deleted_at IS NULL
              WHERE te.room_id = r.id
                AND te.weekday_id = (
                  SELECT id FROM working_weekdays
                  WHERE day_order = WEEKDAY(CURRENT_DATE()) + 1 LIMIT 1
                )
            )
        ) AS roomsFreeAllDayToday,
        (SELECT id FROM working_weekdays WHERE day_order = WEEKDAY(CURRENT_DATE()) + 1 LIMIT 1) AS todayWeekdayId
    `);

    const [[academicCoverage]] = await pool.execute(`
      SELECT
        (SELECT COUNT(DISTINCT sem.id)
          FROM academic_semesters sem
          WHERE sem.is_active = 1 AND (
            EXISTS (SELECT 1 FROM curriculum_subjects c WHERE c.semester_id = sem.id AND c.is_active = 1)
            OR EXISTS (
              SELECT 1 FROM student_profiles sp
              JOIN users u ON u.id = sp.user_id AND u.role = 'student' AND u.is_active = 1
              WHERE sp.current_semester_id = sem.id
            )
            OR EXISTS (SELECT 1 FROM timetable_entries te WHERE te.semester_id = sem.id)
          )
        ) AS representedSemesters,
        COUNT(*) AS requiredClassCourses,
        COALESCE(SUM(EXISTS (
          SELECT 1
          FROM timetable_entries te
          JOIN users teacher ON teacher.id = te.teacher_user_id
            AND teacher.role = 'teacher' AND teacher.is_active = 1
          JOIN rooms r ON r.id = te.room_id AND r.is_active = 1
          JOIN time_slots ts ON ts.id = te.time_slot_id
            AND ts.status = 'active' AND ts.deleted_at IS NULL
          JOIN working_weekdays wd ON wd.id = te.weekday_id AND wd.is_working = 1
          WHERE te.section_id = cca.section_id
            AND te.subject_id = c.subject_id
            AND (te.semester_id IS NULL OR te.semester_id = c.semester_id)
        )), 0) AS scheduledClassCourses
      FROM class_course_assignments cca
      JOIN academic_sections sec ON sec.id = cca.section_id AND sec.is_active = 1
      JOIN academic_programmes p ON p.id = sec.programme_id AND p.is_active = 1
      JOIN curriculum_subjects c ON c.id = cca.curriculum_subject_id AND c.is_active = 1
      JOIN subjects s ON s.id = c.subject_id AND s.is_active = 1
    `);

    const todayDate = dateFromIso(overview.today);
    const monday = new Date(todayDate);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const weekStart = isoDate(monday);
    const weekEndDate = new Date(monday);
    weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 6);
    const weekEnd = isoDate(weekEndDate);

    const [[weekdayRows], [calendarEvents], [entryCounts]] = await Promise.all([
      pool.execute('SELECT id, day_order AS dayOrder, is_working AS isWorking FROM working_weekdays ORDER BY day_order'),
      pool.execute(`
        SELECT DATE_FORMAT(event_date, '%Y-%m-%d') AS eventDate, event_type AS eventType
        FROM academic_calendar_events
        WHERE approval_status = 'approved' AND event_date BETWEEN ? AND ?
      `, [weekStart, weekEnd]),
      pool.execute(`
        SELECT te.weekday_id AS weekdayId, COUNT(*) AS entryCount
        FROM timetable_entries te
        JOIN academic_sections sec ON sec.id = te.section_id AND sec.is_active = 1
        JOIN academic_programmes p ON p.id = sec.programme_id AND p.is_active = 1
        JOIN subjects s ON s.id = te.subject_id AND s.is_active = 1
        JOIN users teacher ON teacher.id = te.teacher_user_id
          AND teacher.role = 'teacher' AND teacher.is_active = 1
        JOIN rooms r ON r.id = te.room_id AND r.is_active = 1
        JOIN working_weekdays wd ON wd.id = te.weekday_id
        JOIN time_slots ts ON ts.id = te.time_slot_id
          AND ts.status = 'active' AND ts.deleted_at IS NULL
        GROUP BY te.weekday_id
      `),
    ]);

    const eventsByDate = new Map();
    for (const event of calendarEvents) {
      const types = eventsByDate.get(event.eventDate) || new Set();
      types.add(event.eventType);
      eventsByDate.set(event.eventDate, types);
    }
    const entriesByWeekday = new Map(entryCounts.map((row) => [Number(row.weekdayId), Number(row.entryCount)]));
    let scheduledThisWeek = 0;
    for (const weekday of weekdayRows) {
      const eventDate = new Date(monday);
      eventDate.setUTCDate(eventDate.getUTCDate() + Number(weekday.dayOrder) - 1);
      const date = isoDate(eventDate);
      const eventTypes = eventsByDate.get(date) || new Set();
      const dayCanBeScheduled = Number(weekday.isWorking) === 1 || eventTypes.has('special_working_day');
      if (dayCanBeScheduled && !eventTypes.has('holiday')) {
        scheduledThisWeek += entriesByWeekday.get(Number(weekday.id)) || 0;
      }
    }

    const teachersSupport = overview.newTeachersThisTerm === null
      ? 'Semester additions unavailable: one current active term with dates is required.'
      : `${countText(Number(overview.newTeachersThisTerm), 'teacher')} added this semester`;
    const requiredClassCourses = Number(academicCoverage.requiredClassCourses || 0);
    const scheduledClassCourses = Number(academicCoverage.scheduledClassCourses || 0);
    const scheduleHealth = requiredClassCourses > 0
      ? Math.round((scheduledClassCourses / requiredClassCourses) * 100)
      : null;
    const scheduleHealthSupport = requiredClassCourses > 0
      ? `${scheduledClassCourses} of ${requiredClassCourses} active section-course assignments have at least one scheduled class.`
      : 'Unavailable: no active section-course assignments are recorded.';
    const todayWeekdayId = overview.todayWeekdayId == null ? null : Number(overview.todayWeekdayId);
    const roomsFreeToday = todayWeekdayId === null ? null : Number(overview.roomsFreeAllDayToday);

    res.json({
      asOf: overview.today,
      cards: {
        teachers: {
          value: Number(overview.activeTeachers),
          supportingText: teachersSupport,
        },
        students: {
          value: Number(overview.activeStudents),
          supportingText: `${countText(Number(overview.activeProgrammes), 'active program')}`,
        },
        sections: {
          value: Number(overview.activeSections),
          supportingText: `${countText(Number(academicCoverage.representedSemesters || 0), 'semester')} represented in active academic records`,
        },
        subjects: {
          value: Number(overview.activeSubjects),
          supportingText: `${Number(overview.assignedSubjects)} assigned to teachers or classes`,
        },
        rooms: {
          value: Number(overview.activeRooms),
          supportingText: roomsFreeToday === null
            ? `${Number(overview.activeLabs)} labs · today's availability unavailable because the weekday calendar is incomplete`
            : `${roomsFreeToday} free all day today · ${countText(Number(overview.activeLabs), 'lab')}`,
        },
        scheduledClasses: {
          value: scheduledThisWeek,
          supportingText: `Valid timetable entries for ${formatWeekRange(weekStart, weekEnd)}`,
        },
        conflicts: {
          value: null,
          supportingText: 'Unavailable: this database does not store pending conflict records.',
        },
        scheduleHealth: {
          value: scheduleHealth,
          supportingText: scheduleHealthSupport,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
