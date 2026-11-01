'use strict';

require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const assert = require('node:assert/strict');
const { test } = require('node:test');
const app = require('../app');
const pool = require('../database/pool');

test('admin working days, reusable slots, calendar exceptions and Google configuration state', { timeout: 60000 }, async () => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, { method = 'GET', body, cookie } = {}) => fetch(`${base}${route}`, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  });
  let cookie;
  let temporarySlotId;
  const temporaryCalendarIds = [];
  try {
    const login = await request('/api/auth/login', { method: 'POST', body: { identifier: 'admin', password: 'admin001' } });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
    const page = await request('/admin/time-slots', { cookie });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Working days &amp; time slots/);
    assert.match(html, /data-slot-day-options/);
    assert.doesNotMatch(html, /⌘ K|☷|target\s*=\s*["']_blank/);
    assert.match(html, /href="\/admin\/time-slots" aria-current="page"/);
    assert.equal((await request('/api/admin/time-slots/settings')).status, 302);

    const { weekdays } = await (await request('/api/admin/time-slots/settings', { cookie })).json();
    assert.equal(weekdays.length, 7);
    assert.deepEqual(weekdays.filter((day) => day.isWorking).map((day) => day.dayKey), ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
    assert.equal(weekdays[0].startTime, '08:30'); assert.equal(weekdays[0].endTime, '14:35');
    const seeded = await (await request('/api/admin/time-slots/slots', { cookie })).json();
    assert.deepEqual(seeded.slots.map((slot) => slot.slotId), ['TS-01', 'TS-02', 'TS-03', 'TS-04', 'TS-05']);
    assert.deepEqual(seeded.slots.map((slot) => slot.status), ['active', 'active', 'active', 'active', 'draft']);
    assert.ok(seeded.slots.every((slot) => slot.workingDays === 'Monday, Tuesday, Wednesday, Thursday, Friday'));

    const missingDays = await request('/api/admin/time-slots/slots', { method: 'POST', cookie, body: { weekdayIds: [], startTime: '09:00', endTime: '10:00', status: 'active' } });
    assert.equal(missingDays.status, 409); assert.match((await missingDays.json()).error, /at least one working day/i);
    const earlierEnd = await request('/api/admin/time-slots/slots', { method: 'POST', cookie, body: { weekdayIds: [weekdays[0].id], startTime: '10:30', endTime: '09:30', status: 'active' } });
    assert.equal(earlierEnd.status, 409); assert.match((await earlierEnd.json()).error, /later than start/i);
    const duplicate = await request('/api/admin/time-slots/slots', { method: 'POST', cookie, body: { weekdayIds: [weekdays[0].id], startTime: '08:30', endTime: '09:30', status: 'active' } });
    assert.equal(duplicate.status, 409); assert.match((await duplicate.json()).error, /already exists/i);
    const overlap = await request('/api/admin/time-slots/slots', { method: 'POST', cookie, body: { weekdayIds: [weekdays[0].id], startTime: '09:00', endTime: '09:40', status: 'active' } });
    assert.equal(overlap.status, 409); assert.match((await overlap.json()).error, /overlaps/i);
    const weekend = await request('/api/admin/time-slots/slots', { method: 'POST', cookie, body: { weekdayIds: [weekdays[5].id], startTime: '09:00', endTime: '10:00', status: 'active' } });
    assert.equal(weekend.status, 409); assert.match((await weekend.json()).error, /non-working/i);
    const outsideHours = await request('/api/admin/time-slots/slots', { method: 'POST', cookie, body: { weekdayIds: [weekdays[0].id], startTime: '14:00', endTime: '15:00', status: 'draft' } });
    assert.equal(outsideHours.status, 409); assert.match((await outsideHours.json()).error, /working hours/i);

    const valid = await request('/api/admin/time-slots/slots', { method: 'POST', cookie, body: { weekdayIds: [weekdays[0].id], startTime: '09:30', endTime: '09:35', status: 'active' } });
    assert.equal(valid.status, 201);
    const created = await valid.json(); temporarySlotId = created.id;
    assert.match(created.slotId, /^TS-\d{2,}$/);
    const exactDuplicate = await request('/api/admin/time-slots/slots', { method: 'POST', cookie, body: { weekdayIds: [weekdays[0].id], startTime: '09:30', endTime: '09:35', status: 'draft' } });
    assert.equal(exactDuplicate.status, 409);
    const editing = await request(`/api/admin/time-slots/slots/${created.id}`, { method: 'PUT', cookie, body: { weekdayIds: [weekdays[0].id], startTime: '10:35', endTime: '10:40', status: 'draft' } });
    assert.equal(editing.status, 200);
    const activated = await request(`/api/admin/time-slots/slots/${created.id}/status`, { method: 'PATCH', cookie, body: { status: 'active' } });
    assert.equal(activated.status, 200);

    const impacted = await request('/api/admin/time-slots/weekdays/monday', { method: 'PUT', cookie, body: { isWorking: true, startTime: '08:35', endTime: '14:35' } });
    assert.equal(impacted.status, 409);
    const warning = await impacted.json(); assert.ok(warning.affectedSlots.some((slot) => slot.slotId === 'TS-01'));
    assert.equal(warning.willModifySlots, false);
    const saveHours = await request('/api/admin/time-slots/weekdays/monday', { method: 'PUT', cookie, body: { isWorking: true, startTime: '08:35', endTime: '14:35', confirmAffectedSlots: true } });
    assert.equal(saveHours.status, 200);
    const untouched = await (await request(`/api/admin/time-slots/slots/${created.id}`, { cookie })).json();
    assert.equal(untouched.slot.startTime, '10:35');
    const restoreHours = await request('/api/admin/time-slots/weekdays/monday', { method: 'PUT', cookie, body: { isWorking: true, startTime: '08:30', endTime: '14:35' } });
    assert.equal(restoreHours.status, 200);

    const normalSaturday = await (await request('/api/admin/time-slots/calendar-eligibility/2026-11-07', { cookie })).json();
    assert.equal(normalSaturday.schedulingAllowed, false);
    const special = await request('/api/admin/time-slots/calendar', { method: 'POST', cookie, body: { eventName: 'Temporary special day', eventDate: '2026-11-07', eventType: 'special_working_day', startTime: '09:00', endTime: '13:00' } });
    assert.equal(special.status, 201); temporaryCalendarIds.push((await special.json()).id);
    const specialContext = await (await request('/api/admin/time-slots/calendar-eligibility/2026-11-07', { cookie })).json();
    assert.equal(specialContext.schedulingAllowed, true);
    assert.deepEqual(specialContext.slots.map((slot) => slot.slotId), ['TS-02', created.slotId, 'TS-03']);
    const conflict = await request('/api/admin/time-slots/calendar', { method: 'POST', cookie, body: { eventName: 'Conflicting holiday', eventDate: '2026-11-07', eventType: 'holiday' } });
    assert.equal(conflict.status, 409);
    const missingWeekendHours = await request('/api/admin/time-slots/calendar', { method: 'POST', cookie, body: { eventName: 'Missing hours', eventDate: '2026-11-14', eventType: 'special_working_day' } });
    assert.equal(missingWeekendHours.status, 409);
    const holiday = await request('/api/admin/time-slots/calendar', { method: 'POST', cookie, body: { eventName: 'Temporary holiday', eventDate: '2026-11-09', eventType: 'holiday' } });
    assert.equal(holiday.status, 201); temporaryCalendarIds.push((await holiday.json()).id);
    const holidayContext = await (await request('/api/admin/time-slots/calendar-eligibility/2026-11-09', { cookie })).json();
    assert.equal(holidayContext.schedulingAllowed, false); assert.match(holidayContext.reason, /holiday/i);
    assert.equal((await (await request('/api/admin/time-slots/slots', { cookie })).json()).slots.length, 6, 'calendar exceptions do not alter reusable weekly slots');

    const google = await (await request('/api/admin/time-slots/google/status', { cookie })).json();
    assert.equal(google.connectionStatus, 'not_configured'); assert.equal(google.importedEventCount, 0);
    const sync = await request('/api/admin/time-slots/google/sync', { method: 'POST', cookie, body: {} });
    assert.equal(sync.status, 503); assert.equal((await sync.json()).connectionStatus, 'not_configured');
  } finally {
    if (cookie) {
      await request('/api/admin/time-slots/weekdays/monday', { method: 'PUT', cookie, body: { isWorking: true, startTime: '08:30', endTime: '14:35', confirmAffectedSlots: true } }).catch(() => {});
    }
    if (temporaryCalendarIds.length) await pool.execute(`DELETE FROM academic_calendar_events WHERE id IN (${temporaryCalendarIds.map(() => '?').join(',')})`, temporaryCalendarIds);
    if (temporarySlotId) await pool.execute('DELETE FROM time_slots WHERE id = ?', [temporarySlotId]);
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
