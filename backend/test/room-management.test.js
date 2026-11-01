'use strict';

require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const assert = require('node:assert/strict');
const { test } = require('node:test');
const app = require('../app');
const pool = require('../database/pool');

test('administrator room catalogue, room creation, assignments, duplicate protection and capacity validation', { timeout: 60000 }, async () => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, { method = 'GET', body, cookie } = {}) => fetch(`${base}${route}`, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  });
  let cookie;
  const temporaryRoomIds = [];
  try {
    const login = await request('/api/auth/login', { method: 'POST', body: { identifier: 'admin', password: 'admin001' } });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);

    const page = await request('/admin/rooms', { cookie });
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Yes, Confirm &amp; Save/);
    assert.match(pageHtml, /class="teacher-toolbar room-toolbar"/, 'room filters share the Teacher Management toolbar pattern');
    assert.match(pageHtml, /data-search/);
    const roomNav = pageHtml.match(/<a class="nav-item active" href="([^"]+)" aria-current="page">▥ <span>Rooms &amp; labs<\/span><\/a>/);
    assert.equal(roomNav?.[1], '/admin/rooms');
    assert.doesNotMatch(pageHtml, /target\s*=|window\.open/);
    const adminPages = ['/admin/dashboard', '/admin/teachers', '/admin/students', '/admin/academic-structure', '/admin/subjects'];
    for (const path of adminPages) {
      const response = await request(path, { cookie });
      assert.equal(response.status, 200, `${path} remains accessible`);
      const html = await response.text();
      assert.doesNotMatch(html, /⌘ K|☷/, `${path} no longer renders the removed UI elements`);
    }
    assert.doesNotMatch(pageHtml, /⌘ K|☷/);
    const denied = await request('/api/admin/rooms/stats');
    assert.equal(denied.status, 302);

    const statsResponse = await request('/api/admin/rooms/stats', { cookie });
    assert.equal(statsResponse.status, 200);
    const stats = (await statsResponse.json()).stats;
    assert.equal(stats.allSpaces, 62);
    assert.equal(stats.classrooms, 49);
    assert.equal(stats.laboratories, 13);
    const [buildingCounts] = await pool.execute(`SELECT b.building_name AS buildingName, COUNT(r.id) AS roomCount
      FROM buildings b LEFT JOIN rooms r ON r.building_id = b.id
      WHERE b.building_name IN ('NB E2 Building','GA Building') GROUP BY b.id, b.building_name ORDER BY b.building_name`);
    assert.deepEqual(buildingCounts.map((row) => [row.buildingName, Number(row.roomCount)]), [['GA Building', 26], ['NB E2 Building', 36]]);
    const [[seedState]] = await pool.execute(`SELECT COUNT(*) AS rooms, SUM(capacity IS NULL) AS unverifiedCapacities,
      (SELECT COUNT(*) FROM room_section_assignments) AS sectionAssignments FROM rooms`);
    assert.equal(Number(seedState.rooms), 62);
    assert.equal(Number(seedState.unverifiedCapacities), 13);
    assert.equal(Number(seedState.sectionAssignments), 0, 'the supplied inventory should start without invented section allocations');
    const buildings = (await (await request('/api/admin/rooms/buildings', { cookie })).json()).buildings;
    assert.equal(buildings.length, 2);
    const rooms = (await (await request('/api/admin/rooms', { cookie })).json());
    assert.equal(rooms.total, 62);
    const labs = await (await request('/api/admin/rooms?roomTypeGroup=laboratories', { cookie })).json();
    assert.equal(labs.total, 13);
    const classrooms = await (await request('/api/admin/rooms?roomType=classroom', { cookie })).json();
    assert.equal(classrooms.total, 44);
    const availability = await (await request('/api/admin/rooms?availability=available', { cookie })).json();
    assert.equal(availability.total, 62);
    const searched = await (await request('/api/admin/rooms?search=NB%20206', { cookie })).json();
    assert.equal(searched.total, 1);
    assert.equal(searched.rooms[0].capacity, 60);

    const invalid = await request('/api/admin/rooms', { method: 'POST', cookie, body: { roomNumber: 'missing required fields' } });
    assert.equal(invalid.status, 400);
    const { sections } = await (await request('/api/admin/rooms/sections', { cookie })).json();
    const section = sections[0];
    assert.ok(section);
    const suffix = String(Date.now());
    const roomBody = { buildingId: buildings[0].id, floor: '1st Floor', roomNumber: `QA ${suffix}`, roomType: 'classroom', capacity: 10 };
    const created = await request('/api/admin/rooms', { method: 'POST', cookie, body: roomBody });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    temporaryRoomIds.push(createdBody.roomId);

    const duplicate = await request('/api/admin/rooms', { method: 'POST', cookie, body: { ...roomBody, roomNumber: ` qa   ${suffix} ` } });
    assert.equal(duplicate.status, 409);
    const assigned = await request(`/api/admin/rooms/${createdBody.roomId}/assignments`, { method: 'POST', cookie, body: { programmeId: section.programmeId, sectionId: section.id } });
    assert.equal(assigned.status, 201);
    const details = await (await request(`/api/admin/rooms/${createdBody.roomId}`, { cookie })).json();
    assert.equal(details.room.assignments.length, 1);
    assert.equal(details.room.timetableAllocationAvailable, false);
    assert.equal(details.room.assignments[0].studentCount, section.studentCount);
    const duplicateAssignment = await request(`/api/admin/rooms/${createdBody.roomId}/assignments`, { method: 'POST', cookie, body: { programmeId: section.programmeId, sectionId: section.id } });
    assert.equal(duplicateAssignment.status, 409);
    const noCapacity = await request('/api/admin/rooms', { method: 'POST', cookie, body: { ...roomBody, roomNumber: `QA LAB ${suffix}`, roomType: 'lab', capacity: '' , programmeId: section.programmeId, sectionId: section.id } });
    assert.equal(noCapacity.status, 409);

    const inactive = await request(`/api/admin/rooms/${createdBody.roomId}/status`, { method: 'PATCH', cookie, body: { isActive: false } });
    assert.equal(inactive.status, 200);
    const inactiveList = await (await request('/api/admin/rooms?availability=inactive', { cookie })).json();
    assert.ok(inactiveList.rooms.some((r) => r.id === createdBody.roomId));
  } finally {
    if (temporaryRoomIds.length) await pool.execute(`DELETE FROM rooms WHERE id IN (${temporaryRoomIds.map(() => '?').join(',')})`, temporaryRoomIds);
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
