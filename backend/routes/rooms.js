'use strict';

const express = require('express');
const pool = require('../database/pool');
const { validateRoomSectionAssignment, validateExistingRoomCapacity } = require('../services/room-allocation-validation');

const router = express.Router();
const roomTypes = new Set(['classroom', 'stepped_classroom', 'lab', 'language_lab']);
const availabilityStatuses = new Set(['available', 'maintenance']);
const floorsByBuilding = {
  'NB E2 Building': new Set(['1st Floor', '2nd Floor', '3rd Floor']),
  'GA Building': new Set(['Lower Ground', 'Upper Ground', '1st Floor', '2nd Floor', '3rd Floor']),
};
const pageSize = 8;

function id(value) {
  return /^\d+$/.test(String(value ?? '')) && Number(value) > 0 ? Number(value) : null;
}

function normalizeRoomNumber(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLocaleUpperCase('en') : '';
}

function parseRoomInput(body) {
  const buildingId = id(body?.buildingId);
  const floor = typeof body?.floor === 'string' ? body.floor.trim() : '';
  const roomNumber = normalizeRoomNumber(body?.roomNumber);
  const roomType = body?.roomType;
  let capacity = null;
  if (body?.capacity !== undefined && body.capacity !== null && String(body.capacity).trim() !== '') {
    if (!/^\d+$/.test(String(body.capacity)) || Number(body.capacity) < 1 || Number(body.capacity) > 65535) {
      return { error: 'Capacity must be a positive whole number when supplied.' };
    }
    capacity = Number(body.capacity);
  }
  const programmeId = body?.programmeId === undefined || body.programmeId === '' ? null : id(body.programmeId);
  const sectionId = body?.sectionId === undefined || body.sectionId === '' ? null : id(body.sectionId);
  if (!buildingId) return { error: 'Select a building.' };
  if (!floor) return { error: 'Select a floor.' };
  if (!roomNumber || roomNumber.length > 80) return { error: 'Enter a room number of 1–80 characters.' };
  if (!roomTypes.has(roomType)) return { error: 'Select a valid room or laboratory type.' };
  if ((body?.programmeId && !programmeId) || (body?.sectionId && !sectionId)) return { error: 'Select a valid class and section.' };
  if ((programmeId && !sectionId) || (!programmeId && sectionId)) return { error: 'Choose both a class/programme and section, or leave both unassigned.' };
  return { buildingId, floor, roomNumber, normalizedRoomNumber: roomNumber, roomType, capacity, programmeId, sectionId };
}

async function validateBuildingAndFloor(connection, buildingId, floor) {
  const [buildings] = await connection.execute('SELECT id, building_name AS buildingName FROM buildings WHERE id = ? LIMIT 1', [buildingId]);
  if (!buildings.length) return { error: 'Select a valid building.' };
  if (!floorsByBuilding[buildings[0].buildingName]?.has(floor)) return { error: 'Select a floor available in the selected building.' };
  return { building: buildings[0] };
}

async function validateRoomAndOptionalAssignment(connection, roomId, input) {
  if (!input.sectionId) return { valid: true };
  const result = await validateRoomSectionAssignment(connection, {
    roomId,
    sectionId: input.sectionId,
    programmeId: input.programmeId,
  });
  return { ...result, valid: result.valid };
}

router.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'Send room changes as JSON.' });
  }
  next();
});

router.get('/stats', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT COUNT(*) AS allSpaces,
        COALESCE(SUM(room_type IN ('classroom','stepped_classroom')), 0) AS classrooms,
        COALESCE(SUM(room_type IN ('lab','language_lab')), 0) AS laboratories,
        COALESCE(SUM(availability_status = 'maintenance'), 0) AS maintenance
      FROM rooms WHERE is_active = 1
    `);
    res.json({ stats: Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value || 0)])) });
  } catch (error) {
    next(error);
  }
});

router.get('/buildings', async (req, res, next) => {
  try {
    const [buildings] = await pool.execute('SELECT id, building_name AS buildingName FROM buildings ORDER BY building_name');
    res.json({ buildings });
  } catch (error) {
    next(error);
  }
});

router.get('/sections', async (req, res, next) => {
  const programmeId = req.query.programmeId ? id(req.query.programmeId) : null;
  if (req.query.programmeId && !programmeId) return res.status(400).json({ error: 'Select a valid class/programme.' });
  try {
    const [sections] = await pool.execute(`
      SELECT s.id, s.programme_id AS programmeId, s.branch_option_id AS branchOptionId,
        s.section_name AS sectionName, p.name AS programmeName, o.name AS branchName,
        COUNT(sp.id) AS studentCount
      FROM academic_sections s
      JOIN academic_programmes p ON p.id = s.programme_id
      LEFT JOIN academic_options o ON o.id = s.branch_option_id
      LEFT JOIN student_profiles sp ON sp.section_id = s.id
      WHERE s.is_active = 1 AND (? IS NULL OR s.programme_id = ?)
      GROUP BY s.id, s.programme_id, s.branch_option_id, s.section_name, p.name, o.name
      ORDER BY p.name, o.name, s.section_name
    `, [programmeId, programmeId]);
    res.json({ sections: sections.map((section) => ({ ...section, studentCount: Number(section.studentCount) })) });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  const page = Math.max(1, Math.min(100_000, Number.parseInt(req.query.page, 10) || 1));
  const offset = (page - 1) * pageSize;
  const buildingId = req.query.buildingId ? id(req.query.buildingId) : null;
  const roomType = req.query.roomType || '';
  const roomTypeGroup = req.query.roomTypeGroup || '';
  const availability = req.query.availability || '';
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 80) : '';
  if (req.query.buildingId && !buildingId) return res.status(400).json({ error: 'Select a valid building.' });
  if (roomType && !roomTypes.has(roomType)) return res.status(400).json({ error: 'Select a valid room type.' });
  if (roomTypeGroup && !['classrooms', 'laboratories'].includes(roomTypeGroup)) return res.status(400).json({ error: 'Select a valid room category.' });
  if (availability && !['available', 'in_use', 'maintenance', 'inactive'].includes(availability)) {
    return res.status(400).json({ error: 'Select a valid availability filter.' });
  }
  const where = `
    WHERE (? = 0 OR r.building_id = ?)
      AND (? = '' OR r.room_type = ?)
      AND (? = '' OR (? = 'classrooms' AND r.room_type IN ('classroom','stepped_classroom'))
        OR (? = 'laboratories' AND r.room_type IN ('lab','language_lab')))
      AND (? = '' OR r.room_number LIKE ? OR b.building_name LIKE ?)
      AND (? = 1 OR r.is_active = 1)
      AND (? = '' OR (? = 'available' AND r.availability_status = 'available' AND r.is_active = 1)
        OR (? = 'maintenance' AND r.availability_status = 'maintenance' AND r.is_active = 1)
        OR (? = 'inactive' AND r.is_active = 0)
        OR (? = 'in_use' AND 1 = 0))
  `;
  const args = [buildingId || 0, buildingId || 0, roomType, roomType, roomTypeGroup, roomTypeGroup, roomTypeGroup,
    search, `%${search}%`, `%${search}%`, availability === 'inactive' ? 1 : 0,
    availability, availability, availability, availability, availability];
  try {
    const [[counts], [rooms]] = await Promise.all([
      pool.execute(`SELECT COUNT(*) AS total FROM rooms r JOIN buildings b ON b.id = r.building_id ${where}`, args),
      pool.execute(`
        SELECT r.id, r.building_id AS buildingId, b.building_name AS buildingName,
          r.floor, r.room_number AS roomNumber, r.room_type AS roomType, r.capacity,
          r.availability_status AS availabilityStatus, r.is_active AS isActive,
          GROUP_CONCAT(DISTINCT CONCAT(p.name, ' · ', s.section_name) ORDER BY p.name, s.section_name SEPARATOR ', ') AS assignedClasses,
          COUNT(DISTINCT a.id) AS assignmentCount
        FROM rooms r
        JOIN buildings b ON b.id = r.building_id
        LEFT JOIN room_section_assignments a ON a.room_id = r.id
        LEFT JOIN academic_sections s ON s.id = a.section_id
        LEFT JOIN academic_programmes p ON p.id = s.programme_id
        ${where}
        GROUP BY r.id, r.building_id, b.building_name, r.floor, r.room_number,
          r.room_type, r.capacity, r.availability_status, r.is_active
        ORDER BY b.building_name, r.floor, r.normalized_room_number
        LIMIT ? OFFSET ?
      `, [...args, pageSize, offset]),
    ]);
    const total = Number(counts[0].total);
    res.json({
      rooms: rooms.map((room) => ({ ...room, capacity: room.capacity == null ? null : Number(room.capacity),
        isActive: Boolean(room.isActive), assignmentCount: Number(room.assignmentCount),
        availability: !room.isActive ? 'Inactive' : room.availabilityStatus === 'maintenance' ? 'Maintenance' : 'Available' })),
      total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:roomId', async (req, res, next) => {
  const roomId = id(req.params.roomId);
  if (!roomId) return res.status(404).json({ error: 'Room not found.' });
  try {
    const [rooms] = await pool.execute(`
      SELECT r.id, r.building_id AS buildingId, b.building_name AS buildingName,
        r.floor, r.room_number AS roomNumber, r.room_type AS roomType, r.capacity,
        r.availability_status AS availabilityStatus, r.is_active AS isActive,
        r.created_at AS createdAt, r.updated_at AS updatedAt
      FROM rooms r JOIN buildings b ON b.id = r.building_id WHERE r.id = ? LIMIT 1
    `, [roomId]);
    if (!rooms.length) return res.status(404).json({ error: 'Room not found.' });
    const [assignments] = await pool.execute(`
      SELECT a.id, s.id AS sectionId, s.programme_id AS programmeId,
        p.name AS programmeName, s.section_name AS sectionName, o.name AS branchName,
        COUNT(sp.id) AS studentCount
      FROM room_section_assignments a
      JOIN academic_sections s ON s.id = a.section_id
      JOIN academic_programmes p ON p.id = s.programme_id
      LEFT JOIN academic_options o ON o.id = s.branch_option_id
      LEFT JOIN student_profiles sp ON sp.section_id = s.id
      WHERE a.room_id = ?
      GROUP BY a.id, s.id, s.programme_id, p.name, s.section_name, o.name
      ORDER BY p.name, s.section_name
    `, [roomId]);
    const room = rooms[0];
    res.json({ room: { ...room, capacity: room.capacity == null ? null : Number(room.capacity), isActive: Boolean(room.isActive),
      availability: !room.isActive ? 'Inactive' : room.availabilityStatus === 'maintenance' ? 'Maintenance' : 'Available',
      assignments: assignments.map((assignment) => ({ ...assignment, studentCount: Number(assignment.studentCount) })),
      timetableAllocationAvailable: false } });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  const input = parseRoomInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const building = await validateBuildingAndFloor(connection, input.buildingId, input.floor);
    if (building.error) {
      await connection.rollback();
      return res.status(400).json({ error: building.error });
    }
    if (input.sectionId) {
      const [sections] = await connection.execute('SELECT programme_id AS programmeId FROM academic_sections WHERE id = ? AND is_active = 1', [input.sectionId]);
      if (!sections.length || Number(sections[0].programmeId) !== input.programmeId) {
        await connection.rollback();
        return res.status(400).json({ error: 'Select a section that belongs to the selected class/programme.' });
      }
      if (input.capacity == null) {
        await connection.rollback();
        return res.status(409).json({ error: 'Room capacity is not specified. Enter and verify capacity before assigning a class or section.' });
      }
      const [[strength]] = await connection.execute('SELECT COUNT(*) AS studentCount FROM student_profiles WHERE section_id = ?', [input.sectionId]);
      if (Number(strength.studentCount) > input.capacity) {
        await connection.rollback();
        return res.status(409).json({ error: 'Room capacity is insufficient for the selected class/section. Please choose a room with higher capacity.' });
      }
    }
    const [created] = await connection.execute(`
      INSERT INTO rooms (building_id, floor, room_number, normalized_room_number, room_type, capacity, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [input.buildingId, input.floor, input.roomNumber, input.normalizedRoomNumber, input.roomType, input.capacity, req.user.id]);
    if (input.sectionId) {
      await connection.execute('INSERT INTO room_section_assignments (room_id, section_id, created_by_user_id) VALUES (?, ?, ?)', [created.insertId, input.sectionId, req.user.id]);
    }
    await connection.commit();
    res.status(201).json({ roomId: created.insertId, message: 'Room record saved.' });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This room already exists in the selected building. Please check the room number.' });
    next(error);
  } finally {
    connection.release();
  }
});

router.put('/:roomId', async (req, res, next) => {
  const roomId = id(req.params.roomId);
  const input = parseRoomInput(req.body);
  if (!roomId) return res.status(404).json({ error: 'Room not found.' });
  if (input.error) return res.status(400).json({ error: input.error });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.execute('SELECT id FROM rooms WHERE id = ? FOR UPDATE', [roomId]);
    if (!existing.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Room not found.' });
    }
    const building = await validateBuildingAndFloor(connection, input.buildingId, input.floor);
    if (building.error) {
      await connection.rollback();
      return res.status(400).json({ error: building.error });
    }
    const capacityCheck = await validateExistingRoomCapacity(connection, roomId, input.capacity);
    if (!capacityCheck.valid) {
      await connection.rollback();
      return res.status(409).json({ error: capacityCheck.error });
    }
    await connection.execute(`
      UPDATE rooms SET building_id = ?, floor = ?, room_number = ?, normalized_room_number = ?, room_type = ?, capacity = ?
      WHERE id = ?
    `, [input.buildingId, input.floor, input.roomNumber, input.normalizedRoomNumber, input.roomType, input.capacity, roomId]);
    if (input.sectionId) {
      const assignment = await validateRoomAndOptionalAssignment(connection, roomId, input);
      if (!assignment.valid) {
        await connection.rollback();
        return res.status(assignment.status || 400).json({ error: assignment.error });
      }
      await connection.execute('INSERT INTO room_section_assignments (room_id, section_id, created_by_user_id) VALUES (?, ?, ?)', [roomId, input.sectionId, req.user.id]);
    }
    await connection.commit();
    res.json({ message: 'Room details updated.' });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This room already exists in the selected building. Please check the room number.' });
    next(error);
  } finally {
    connection.release();
  }
});

router.patch('/:roomId/status', async (req, res, next) => {
  const roomId = id(req.params.roomId);
  const availabilityStatus = req.body?.availabilityStatus;
  const isActive = req.body?.isActive;
  if (!roomId || (availabilityStatus !== undefined && !availabilityStatuses.has(availabilityStatus))
    || (isActive !== undefined && typeof isActive !== 'boolean')) {
    return res.status(400).json({ error: 'Provide a valid room status.' });
  }
  try {
    const [result] = await pool.execute(`
      UPDATE rooms SET availability_status = COALESCE(?, availability_status), is_active = COALESCE(?, is_active)
      WHERE id = ?
    `, [availabilityStatus ?? null, isActive ?? null, roomId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Room not found.' });
    res.json({ message: 'Room status updated.' });
  } catch (error) {
    next(error);
  }
});

router.post('/:roomId/assignments', async (req, res, next) => {
  const roomId = id(req.params.roomId);
  const programmeId = id(req.body?.programmeId);
  const sectionId = id(req.body?.sectionId);
  if (!roomId || !programmeId || !sectionId) return res.status(400).json({ error: 'Select a class/programme and section.' });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const validation = await validateRoomSectionAssignment(connection, { roomId, programmeId, sectionId });
    if (!validation.valid) {
      await connection.rollback();
      return res.status(validation.status).json({ error: validation.error });
    }
    await connection.execute('INSERT INTO room_section_assignments (room_id, section_id, created_by_user_id) VALUES (?, ?, ?)', [roomId, sectionId, req.user.id]);
    await connection.commit();
    res.status(201).json({ message: 'Room assigned to the selected class/section.', studentCount: validation.studentCount });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This room is already assigned to the selected class/section.' });
    next(error);
  } finally {
    connection.release();
  }
});

router.delete('/:roomId/assignments/:assignmentId', async (req, res, next) => {
  const roomId = id(req.params.roomId);
  const assignmentId = id(req.params.assignmentId);
  if (!roomId || !assignmentId) return res.status(404).json({ error: 'Room assignment not found.' });
  try {
    const [result] = await pool.execute('DELETE FROM room_section_assignments WHERE room_id = ? AND id = ?', [roomId, assignmentId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Room assignment not found.' });
    res.json({ message: 'Room assignment removed.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
