'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const pool = require('./pool');

const inventory = [];
function add(building, floor, entries) {
  for (const [roomNumber, roomType, capacity] of entries) inventory.push({ building, floor, roomNumber, roomType, capacity });
}

add('NB E2 Building', '1st Floor', [
  ['NB 102', 'lab', null], ['NB 103', 'lab', null], ['NB 105', 'stepped_classroom', 120],
  ['NB 106', 'classroom', 60], ['NB 110', 'classroom', 30], ['NB 111', 'classroom', 60],
]);
add('NB E2 Building', '2nd Floor', [
  ['NB 201', 'classroom', 30], ['NB 203', 'classroom', 60], ['NB 205', 'classroom', 60],
  ['NB 206', 'classroom', 60], ['NB 207', 'classroom', 60], ['NB 208', 'lab', null],
  ['NB 209', 'lab', null], ['NB 211', 'classroom', 60], ['NB 212', 'classroom', 60],
  ['NB 213', 'classroom', 60], ['NB 214', 'classroom', 60], ['NB 215', 'classroom', 60],
  ['NB 216', 'classroom', 30], ['NB 217', 'classroom', 30],
]);
add('NB E2 Building', '3rd Floor', [
  ['NB 301', 'classroom', 30], ['NB 302', 'classroom', 30], ['NB 303', 'classroom', 60],
  ['NB 304', 'classroom', 60], ['NB 305', 'classroom', 60], ['NB 306', 'classroom', 60],
  ['NB 307', 'classroom', 60], ['NB 308', 'lab', null], ['NB 309', 'lab', null],
  ['NB 311', 'classroom', 60], ['NB 312', 'classroom', 60], ['NB 313', 'classroom', 60],
  ['NB 314', 'classroom', 60], ['NB 315', 'classroom', 60], ['NB 316', 'classroom', 30],
  ['NB 317', 'classroom', 30],
]);
add('GA Building', 'Lower Ground', [
  ['GA L01', 'stepped_classroom', 65], ['GA L02', 'stepped_classroom', 65],
  ['GA L03', 'language_lab', null], ['GA L04', 'classroom', 60],
]);
add('GA Building', 'Upper Ground', [
  ['GA U01', 'stepped_classroom', 65], ['GA U02', 'stepped_classroom', 65],
  ['GA U03', 'classroom', 60], ['GA U04', 'classroom', 60],
]);
add('GA Building', '1st Floor', [
  ['GA 101', 'lab', null], ['GA 102', 'lab', null], ['GA 103', 'classroom', 60],
  ['GA 104', 'classroom', 60], ['GA 105', 'classroom', 60], ['GA 106', 'classroom', 30],
]);
add('GA Building', '2nd Floor', [
  ['GA 201', 'lab', null], ['GA 202', 'lab', null], ['GA 203', 'classroom', 60],
  ['GA 204', 'classroom', 60], ['GA 205', 'classroom', 60], ['GA 206', 'classroom', 30],
]);
add('GA Building', '3rd Floor', [
  ['GA 301', 'lab', null], ['GA 302', 'lab', null], ['GA 303', 'classroom', 60],
  ['GA 304', 'classroom', 60], ['GA 305', 'classroom', 60], ['GA 306', 'classroom', 30],
]);

function normalizedRoomNumber(value) {
  return value.trim().replace(/\s+/g, ' ').toLocaleUpperCase('en');
}

async function migrate() {
  if (inventory.length !== 62) throw new Error(`Inventory integrity check failed: expected 62 rooms, found ${inventory.length}.`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS buildings (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    building_name VARCHAR(120) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_buildings_name (building_name)
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS rooms (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    building_id BIGINT UNSIGNED NOT NULL,
    floor VARCHAR(80) NOT NULL,
    room_number VARCHAR(80) NOT NULL,
    normalized_room_number VARCHAR(80) NOT NULL,
    room_type ENUM('classroom','stepped_classroom','lab','language_lab') NOT NULL,
    capacity SMALLINT UNSIGNED NULL,
    availability_status ENUM('available','maintenance') NOT NULL DEFAULT 'available',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_rooms_building_normalized_number (building_id, normalized_room_number),
    KEY ix_rooms_filters (is_active, room_type, availability_status, building_id),
    CONSTRAINT fk_rooms_building FOREIGN KEY (building_id) REFERENCES buildings(id) ON DELETE RESTRICT,
    CONSTRAINT fk_rooms_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS room_section_assignments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    room_id BIGINT UNSIGNED NOT NULL,
    section_id BIGINT UNSIGNED NOT NULL,
    created_by_user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_room_section_assignment (room_id, section_id),
    KEY ix_room_section_section (section_id),
    CONSTRAINT fk_room_section_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_room_section_section FOREIGN KEY (section_id) REFERENCES academic_sections(id) ON DELETE RESTRICT,
    CONSTRAINT fk_room_section_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);

  const connection = await pool.getConnection();
  const result = { buildingsInserted: 0, roomsInserted: 0, roomsMatched: 0, roomCount: 0 };
  try {
    await connection.beginTransaction();
    for (const buildingName of ['NB E2 Building', 'GA Building']) {
      const [inserted] = await connection.execute('INSERT IGNORE INTO buildings (building_name) VALUES (?)', [buildingName]);
      result.buildingsInserted += inserted.affectedRows;
    }
    const [buildings] = await connection.execute('SELECT id, building_name AS buildingName FROM buildings WHERE building_name IN (?, ?)', ['NB E2 Building', 'GA Building']);
    const buildingIds = new Map(buildings.map((building) => [building.buildingName, building.id]));
    for (const room of inventory) {
      const [inserted] = await connection.execute(`
        INSERT IGNORE INTO rooms
          (building_id, floor, room_number, normalized_room_number, room_type, capacity)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [buildingIds.get(room.building), room.floor, room.roomNumber.trim().replace(/\s+/g, ' '), normalizedRoomNumber(room.roomNumber), room.roomType, room.capacity]);
      result.roomsInserted += inserted.affectedRows;
      result.roomsMatched += inserted.affectedRows ? 0 : 1;
    }
    await connection.commit();
    const [[counts]] = await connection.query('SELECT COUNT(*) AS roomCount FROM rooms WHERE is_active = 1');
    result.roomCount = Number(counts.roomCount);
    console.log(JSON.stringify(result));
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

migrate().catch((error) => {
  console.error(`Room management migration failed (${error.code || error.message}).`);
  process.exitCode = 1;
}).finally(() => pool.end());
