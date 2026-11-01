'use strict';
(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const state = { page: 1, category: '', rooms: [], buildings: [], editId: null, detail: null };
  const floors = { 'NB E2 Building': ['1st Floor', '2nd Floor', '3rd Floor'], 'GA Building': ['Lower Ground', 'Upper Ground', '1st Floor', '2nd Floor', '3rd Floor'] };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const typeName = (v) => ({ classroom: 'Classroom', stepped_classroom: 'Stepped classroom', lab: 'Laboratory', language_lab: 'Language lab' })[v] || v;
  const message = (text, error = false) => { const el = $('[data-message]'); el.textContent = text; el.classList.toggle('is-error', error); };
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
    return data;
  }
  function params() {
    const q = new URLSearchParams({ page: state.page });
    if (state.category === 'classrooms') q.set('roomTypeGroup', 'classrooms');
    if (state.category === 'laboratories') q.set('roomTypeGroup', 'laboratories');
    if ($('[data-search]').value.trim()) q.set('search', $('[data-search]').value.trim());
    if ($('[data-building]').value) q.set('buildingId', $('[data-building]').value);
    if ($('[data-type]').value) q.set('roomType', $('[data-type]').value);
    if ($('[data-availability]').value) q.set('availability', $('[data-availability]').value);
    return q;
  }
  async function load() {
    $('[data-room-rows]').innerHTML = '<tr><td colspan="7" class="empty-row">Loading room records…</td></tr>';
    try {
      const [stats, results] = await Promise.all([api('/api/admin/rooms/stats'), api(`/api/admin/rooms?${params()}`)]);
      Object.entries(stats.stats).forEach(([key, value]) => { const el = $(`[data-stat="${key}"]`); if (el) el.textContent = value; });
      state.rooms = results.rooms;
      render(results);
      $('[data-page-summary]').textContent = results.total ? `Showing ${(results.page - 1) * results.pageSize + 1}–${Math.min(results.page * results.pageSize, results.total)} of ${results.total} records` : 'No room records found';
      $('[data-page-number]').textContent = String(results.page);
      $('[data-prev]').disabled = results.page <= 1;
      $('[data-next]').disabled = results.page >= results.totalPages;
    } catch (error) { $('[data-room-rows]').innerHTML = `<tr><td colspan="7" class="empty-row">${esc(error.message)}</td></tr>`; }
  }
  function render(results) {
    const tbody = $('[data-room-rows]');
    if (!results.rooms.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No rooms match these filters.</td></tr>'; return; }
    tbody.innerHTML = results.rooms.map((r) => `<tr><td><strong>${esc(r.roomNumber)}</strong></td><td>${esc(r.buildingName)}<small>${esc(r.floor)}</small></td><td>${esc(typeName(r.roomType))}</td><td>${r.capacity == null ? '<span class="capacity-unverified">Not specified</span>' : `${r.capacity} seats`}</td><td>${r.assignedClasses ? esc(r.assignedClasses) : '<span class="muted">Unassigned</span>'}</td><td><span class="availability ${r.availability.toLowerCase()}">${esc(r.availability)}</span></td><td class="room-actions"><button type="button" data-action="view" data-id="${r.id}" aria-label="View ${esc(r.roomNumber)}">◉</button><button type="button" data-action="edit" data-id="${r.id}" aria-label="Edit ${esc(r.roomNumber)}">✎</button><button type="button" data-action="more" data-id="${r.id}" aria-label="Manage ${esc(r.roomNumber)}">•••</button></td></tr>`).join('');
  }
  async function loadOptions() {
    const [{ buildings }, { sections }] = await Promise.all([api('/api/admin/rooms/buildings'), api('/api/admin/rooms/sections')]);
    state.buildings = buildings;
    const options = buildings.map((b) => `<option value="${b.id}">${esc(b.buildingName)}</option>`).join('');
    $('[data-building]').insertAdjacentHTML('beforeend', options);
    $('[data-form-building]').insertAdjacentHTML('beforeend', options);
    const programmes = [...new Map(sections.map((s) => [s.programmeId, s.programmeName])).entries()];
    $('[data-programme]').insertAdjacentHTML('beforeend', programmes.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join(''));
    state.sections = sections;
  }
  function setFloorOptions(buildingId, selected = '') {
    const select = $('[data-form-floor]'); const building = state.buildings.find((b) => String(b.id) === String(buildingId));
    const values = floors[building?.buildingName] || [];
    select.innerHTML = `<option value="">Select floor</option>${values.map((f) => `<option value="${esc(f)}" ${f === selected ? 'selected' : ''}>${esc(f)}</option>`).join('')}`;
    select.disabled = !values.length;
  }
  function fillSections(programmeId, selected = '') {
    const select = $('[data-section]'); const sections = (state.sections || []).filter((s) => String(s.programmeId) === String(programmeId));
    select.innerHTML = `<option value="">${programmeId ? 'Select section' : 'Optional: select section'}</option>${sections.map((s) => `<option value="${s.id}" ${String(s.id) === String(selected) ? 'selected' : ''}>${esc(s.programmeName)}${s.branchName ? ` · ${esc(s.branchName)}` : ''} · ${esc(s.sectionName)} · ${s.studentCount} students</option>`).join('')}`;
    select.disabled = !programmeId;
  }
  function openEditor(room = null) {
    state.editId = room?.id || null;
    const form = $('[data-room-form]'); form.reset(); $('[data-form-error]').textContent = '';
    $('[data-editor-eyebrow]').textContent = room ? 'Update record' : 'New record';
    $('#editor-title').textContent = room ? `Edit ${room.roomNumber}` : 'Add room or laboratory';
    $('[data-save]').textContent = room ? '✓  Save changes' : '✓  Save record';
    if (room) {
      form.elements.buildingId.value = room.buildingId; setFloorOptions(room.buildingId, room.floor);
      form.elements.roomNumber.value = room.roomNumber; form.elements.roomType.value = room.roomType;
      form.elements.capacity.value = room.capacity ?? '';
    } else setFloorOptions('');
    $('[data-programme]').value = ''; fillSections('');
    $('[data-editor]').hidden = false; document.body.classList.add('modal-open');
    $('[data-form-building]').focus();
  }
  function closeEditor() { $('[data-editor]').hidden = true; document.body.classList.remove('modal-open'); state.editId = null; }
  function pendingSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    if (state.editId) { saveEdit(); return; }
    const fd = new FormData(form); const building = state.buildings.find((b) => String(b.id) === fd.get('buildingId'));
    const summary = [building?.buildingName, fd.get('floor'), fd.get('roomNumber'), typeName(fd.get('roomType')), fd.get('capacity') ? `${fd.get('capacity')} seats` : 'Capacity not specified'].filter(Boolean).join(' · ');
    $('[data-confirm-summary]').textContent = summary;
    $('[data-confirm-warning]').hidden = true; $('[data-confirm]').hidden = false; $('[data-confirm-back]').focus();
  }
  function readForm() { const fd = new FormData($('[data-room-form]')); return Object.fromEntries(fd.entries()); }
  async function saveEdit() {
    try { await api(`/api/admin/rooms/${state.editId}`, { method: 'PUT', body: JSON.stringify(readForm()) }); closeEditor(); message('Room details updated.'); await load(); }
    catch (e) { $('[data-form-error]').textContent = e.message; }
  }
  async function confirmSave() {
    const btn = $('[data-confirm-save]'); btn.disabled = true;
    try { await api('/api/admin/rooms', { method: 'POST', body: JSON.stringify(readForm()) }); $('[data-confirm]').hidden = true; closeEditor(); message('Room record saved.'); state.page = 1; await load(); }
    catch (e) { const warning = $('[data-confirm-warning]'); warning.textContent = e.message; warning.hidden = false; }
    finally { btn.disabled = false; }
  }
  async function showDetail(id, editable = false) {
    try {
      const { room } = await api(`/api/admin/rooms/${id}`); state.detail = room;
      $('[data-detail-title]').textContent = `${room.roomNumber} · ${room.buildingName}`;
      const assignments = room.assignments.length ? room.assignments.map((a) => `<div class="assignment-row"><span><strong>${esc(a.programmeName)}${a.branchName ? ` · ${esc(a.branchName)}` : ''} · ${esc(a.sectionName)}</strong><small>${a.studentCount} students · section assignment</small></span><button type="button" data-remove-assignment="${a.id}" aria-label="Remove section assignment">Remove</button></div>`).join('') : '<p class="muted">No class or section assigned.</p>';
      $('[data-detail-body]').innerHTML = `<div class="detail-grid"><div><small>Floor</small><strong>${esc(room.floor)}</strong></div><div><small>Type</small><strong>${esc(typeName(room.roomType))}</strong></div><div><small>Capacity</small><strong>${room.capacity == null ? 'Not specified' : `${room.capacity} seats`}</strong></div><div><small>Availability</small><strong>${esc(room.availability)}</strong></div></div><h3>Assigned class / sections</h3>${assignments}<p class="timetable-note">Time-slot allocation and schedule conflicts are pending a timetable data source.</p><form class="detail-assign-form" data-assign-form><label>Class<select name="programmeId" data-detail-programme required><option value="">Select class / programme</option>${[...new Map((state.sections || []).map((s) => [s.programmeId, s.programmeName])).entries()].map(([pid, name]) => `<option value="${pid}">${esc(name)}</option>`).join('')}</select></label><label>Section<select name="sectionId" data-detail-section required disabled><option value="">Select section</option></select></label><button class="secondary-button" type="submit">Assign section</button></form>`;
      $('[data-detail-actions]').innerHTML = `<button type="button" class="secondary-button" data-detail-edit>Edit room</button>${room.availability === 'Maintenance' ? '<button type="button" class="secondary-button" data-status="available">Mark available</button>' : '<button type="button" class="secondary-button" data-status="maintenance">Mark maintenance</button>'}${room.isActive ? '<button type="button" class="danger-button" data-status="inactive">Deactivate room</button>' : '<button type="button" class="secondary-button" data-status="active">Reactivate room</button>'}`;
      $('[data-detail]').hidden = false; document.body.classList.add('modal-open');
      $('[data-detail-programme]').addEventListener('change', (e) => {
        const select = $('[data-detail-section]'); const rows = state.sections.filter((s) => String(s.programmeId) === e.target.value);
        select.innerHTML = `<option value="">Select section</option>${rows.map((s) => `<option value="${s.id}">${esc(s.sectionName)} · ${s.studentCount} students</option>`).join('')}`; select.disabled = !e.target.value;
      });
      $('[data-assign-form]').addEventListener('submit', async (e) => { e.preventDefault(); const body = Object.fromEntries(new FormData(e.currentTarget).entries()); try { await api(`/api/admin/rooms/${id}/assignments`, { method: 'POST', body: JSON.stringify(body) }); await showDetail(id); await load(); message('Section assigned to room.'); } catch (err) { message(err.message, true); } });
    } catch (e) { message(e.message, true); }
  }
  async function updateStatus(status) {
    if (!state.detail) return;
    const body = status === 'active' ? { isActive: true } : status === 'inactive' ? { isActive: false } : { availabilityStatus: status };
    if (status === 'inactive' && !window.confirm('Deactivate this room? Existing room and section records will be preserved.')) return;
    try { await api(`/api/admin/rooms/${state.detail.id}/status`, { method: 'PATCH', body: JSON.stringify(body) }); await showDetail(state.detail.id); await load(); message('Room status updated.'); } catch (e) { message(e.message, true); }
  }
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]'); if (button) {
      const room = state.rooms.find((r) => String(r.id) === button.dataset.id);
      if (button.dataset.action === 'view') await showDetail(button.dataset.id);
      else if (button.dataset.action === 'edit') openEditor(room);
      else await showDetail(button.dataset.id, true);
    }
    const remove = event.target.closest('[data-remove-assignment]');
    if (remove && state.detail) { try { await api(`/api/admin/rooms/${state.detail.id}/assignments/${remove.dataset.removeAssignment}`, { method: 'DELETE', body: '{}' }); await showDetail(state.detail.id); await load(); } catch (e) { message(e.message, true); } }
    if (event.target.closest('[data-detail-edit]') && state.detail) { const room = state.detail; $('[data-detail]').hidden = true; document.body.classList.remove('modal-open'); openEditor(room); }
    const status = event.target.closest('[data-status]'); if (status) await updateStatus(status.dataset.status);
  });
  $('[data-open-room]').addEventListener('click', () => openEditor());
  function blockConfirmDismiss(event) { if (!$('[data-confirm]').hidden) { event.preventDefault(); event.stopPropagation(); $('[data-confirm-warning]').textContent = 'Please select either “Yes, Confirm & Save” to create the room or “No, Go Back” to return to the form.'; $('[data-confirm-warning]').hidden = false; } else closeEditor(); }
  $('[data-editor-close]').addEventListener('click', blockConfirmDismiss); $('[data-editor-cancel]').addEventListener('click', blockConfirmDismiss);
  $('[data-room-form]').addEventListener('submit', pendingSubmit);
  $('[data-confirm-back]').addEventListener('click', () => { $('[data-confirm]').hidden = true; $('[data-confirm-warning]').hidden = true; $('[data-save]').focus(); });
  $('[data-confirm-save]').addEventListener('click', confirmSave);
  $('[data-detail-close]').addEventListener('click', () => { $('[data-detail]').hidden = true; document.body.classList.remove('modal-open'); });
  $('[data-form-building]').addEventListener('change', (e) => setFloorOptions(e.target.value));
  $('[data-programme]').addEventListener('change', (e) => fillSections(e.target.value));
  $('[data-detail]').addEventListener('click', (e) => { if (e.target === e.currentTarget) { e.preventDefault(); } });
  $('[data-confirm]').addEventListener('click', (e) => { if (e.target === e.currentTarget) { $('[data-confirm-warning]').textContent = 'Please select either “Yes, Confirm & Save” to create the room or “No, Go Back” to return to the form.'; $('[data-confirm-warning]').hidden = false; } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('[data-confirm]').hidden) { e.preventDefault(); e.stopPropagation(); $('[data-confirm-warning]').textContent = 'Please select either “Yes, Confirm & Save” to create the room or “No, Go Back” to return to the form.'; $('[data-confirm-warning]').hidden = false; } });
  $('[data-search]').addEventListener('input', () => { state.page = 1; load(); });
  ['[data-building]', '[data-type]', '[data-availability]'].forEach((sel) => $(sel).addEventListener('change', () => { state.page = 1; load(); }));
  $('[data-clear]').addEventListener('click', () => { $('[data-search]').value = ''; $('[data-building]').value = ''; $('[data-type]').value = ''; $('[data-availability]').value = ''; state.category = ''; $$('.room-tabs button').forEach((b) => { const on = b.dataset.category === 'all'; b.classList.toggle('selected', on); b.setAttribute('aria-selected', String(on)); }); state.page = 1; load(); });
  $$('.room-tabs button').forEach((button) => button.addEventListener('click', () => { state.category = button.dataset.category === 'all' ? '' : button.dataset.category; $$('.room-tabs button').forEach((b) => { const on = b === button; b.classList.toggle('selected', on); b.setAttribute('aria-selected', String(on)); }); state.page = 1; load(); }));
  $('[data-prev]').addEventListener('click', () => { state.page = Math.max(1, state.page - 1); load(); }); $('[data-next]').addEventListener('click', () => { state.page += 1; load(); });
  loadOptions().then(load).catch((e) => message(e.message, true));
})();
