'use strict';

async function validateRoomSectionAssignment(connection, { roomId, sectionId, programmeId }) {
  const [sections] = await connection.execute(`
    SELECT id, programme_id AS programmeId FROM academic_sections
    WHERE id = ? AND is_active = 1 LIMIT 1
  `, [sectionId]);
  if (!sections.length || Number(sections[0].programmeId) !== Number(programmeId)) {
    return { valid: false, status: 400, error: 'Select a section that belongs to the selected programme.' };
  }

  const [rooms] = await connection.execute(`
    SELECT id, capacity, is_active AS isActive FROM rooms WHERE id = ? LIMIT 1 FOR UPDATE
  `, [roomId]);
  if (!rooms.length || !Number(rooms[0].isActive)) {
    return { valid: false, status: 404, error: 'The selected room is unavailable.' };
  }
  if (rooms[0].capacity == null) {
    return { valid: false, status: 409, error: 'Room capacity is not specified. Enter and verify capacity before assigning a class or section.' };
  }

  const [[strength]] = await connection.execute(
    'SELECT COUNT(*) AS studentCount FROM student_profiles WHERE section_id = ?', [sectionId]);
  if (Number(strength.studentCount) > Number(rooms[0].capacity)) {
    return { valid: false, status: 409, error: 'Room capacity is insufficient for the selected class/section. Please choose a room with higher capacity.' };
  }

  const [existing] = await connection.execute(
    'SELECT id FROM room_section_assignments WHERE room_id = ? AND section_id = ? LIMIT 1', [roomId, sectionId]);
  if (existing.length) return { valid: false, status: 409, error: 'This room is already assigned to the selected class/section.' };

  // The current database has no timetable/day/time-slot allocation source. Only
  // static class-section and capacity checks can be enforced here; time overlap
  // checks belong in the future timetable allocation transaction.
  return { valid: true, studentCount: Number(strength.studentCount) };
}

async function validateExistingRoomCapacity(connection, roomId, capacity) {
  const [assignments] = await connection.execute(`
    SELECT a.section_id AS sectionId, s.section_name AS sectionName, COUNT(sp.id) AS studentCount
    FROM room_section_assignments a
    JOIN academic_sections s ON s.id = a.section_id
    LEFT JOIN student_profiles sp ON sp.section_id = s.id
    WHERE a.room_id = ?
    GROUP BY a.section_id, s.section_name
  `, [roomId]);
  if (assignments.length && capacity == null) {
    return { valid: false, error: 'Capacity cannot be unspecified while this room is assigned to a class/section.' };
  }
  const oversized = assignments.find((assignment) => Number(assignment.studentCount) > Number(capacity));
  if (oversized) {
    return { valid: false, error: `Capacity is below the current student strength of ${oversized.sectionName} (${oversized.studentCount}).` };
  }
  return { valid: true };
}

module.exports = { validateRoomSectionAssignment, validateExistingRoomCapacity };
