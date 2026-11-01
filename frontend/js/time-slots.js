'use strict';
(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const state = { weekdays: [], slots: [], slotStats: { total: 0 }, calendar: [], googleEvents: [], editingSlot: null, editingEvent: null, confirmAction: null };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const titleCase = (value) => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const displayTime = (value) => {
    if (!value) return '—';
    const [hours, minutes] = value.slice(0, 5).split(':').map(Number);
    return `${String((hours % 12) || 12).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${hours >= 12 ? 'PM' : 'AM'}`;
  };
  function notify(text, error = false) {
    const node = $('[data-message]'); node.textContent = text; node.classList.toggle('error', error);
    node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options,
      headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || 'The request could not be completed.'); error.data = data; error.status = response.status; throw error; }
    return data;
  }
  async function loadSettings() {
    const { weekdays, slotStats } = await api('/api/admin/time-slots/settings');
    state.weekdays = weekdays; state.slotStats = slotStats;
    const enabled = weekdays.filter((day) => day.isWorking).length;
    $('[data-enabled-count]').textContent = `${enabled} ${enabled === 1 ? 'day' : 'days'} enabled`;
    renderWeekdays(); renderHours(); renderDayFilter(); renderSlotDayChoices();
    $('[data-slot-count]').textContent = `${slotStats.total} ${slotStats.total === 1 ? 'slot' : 'slots'}`;
  }
  function renderWeekdays() {
    $('[data-weekdays]').innerHTML = state.weekdays.map((day) => `<article class="weekday-card ${day.isWorking ? 'is-working' : ''}">
      <button type="button" class="weekday-toggle" data-toggle-day="${esc(day.dayKey)}" aria-label="Set ${esc(day.dayLabel)} ${day.isWorking ? 'non-working' : 'working'}" aria-pressed="${day.isWorking}">${day.isWorking ? '✓' : ''}</button>
      <strong>${esc(day.dayLabel.slice(0, 3))}</strong><small>${day.isWorking ? 'Working day' : 'Non-working'}</small></article>`).join('');
  }
  function renderHours() {
    $('[data-hours]').innerHTML = state.weekdays.map((day) => `<div class="hours-row" data-hours-row="${esc(day.dayKey)}">
      <strong>${esc(day.dayLabel)}</strong><input type="time" data-hours-start value="${esc(day.startTime || '')}" ${day.isWorking ? '' : 'disabled'} aria-label="${esc(day.dayLabel)} opening time">
      <input type="time" data-hours-end value="${esc(day.endTime || '')}" ${day.isWorking ? '' : 'disabled'} aria-label="${esc(day.dayLabel)} closing time">
      <button type="button" data-save-hours="${esc(day.dayKey)}" ${day.isWorking ? '' : 'disabled'}>Save hours</button></div>`).join('');
  }
  function renderDayFilter() {
    $('[data-slot-day]').innerHTML = `<option value="">All working days</option>${state.weekdays.map((day) => `<option value="${esc(day.dayKey)}">${esc(day.dayLabel)}</option>`).join('')}`;
  }
  function renderSlotDayChoices(selected = []) {
    $('[data-slot-day-options]').innerHTML = state.weekdays.map((day) => { const checked = selected.includes(Number(day.id)); return `<label><input type="checkbox" name="weekdayIds" value="${day.id}" data-weekday-check ${checked ? 'checked' : ''} ${day.isWorking || checked ? '' : 'disabled'}><span>${esc(day.dayLabel)}</span></label>`; }).join('');
  }
  function slotFilters() {
    const query = new URLSearchParams();
    const search = $('[data-slot-search]').value.trim(); const day = $('[data-slot-day]').value; const status = $('[data-slot-status]').value;
    if (search) query.set('search', search); if (day) query.set('day', day); if (status) query.set('status', status);
    return query.toString();
  }
  async function loadSlots() {
    const url = `/api/admin/time-slots/slots${slotFilters() ? `?${slotFilters()}` : ''}`;
    const { slots } = await api(url); state.slots = slots;
    $('[data-slot-rows]').innerHTML = slots.length ? slots.map((slot) => `<tr><td><span class="slot-id">${esc(slot.slotId)}</span></td><td>${esc(slot.workingDays)}${slot.invalidDayCount ? `<small class="slot-invalid">${slot.invalidDayCount} day(s) need review</small>` : ''}</td><td class="slot-time">${displayTime(slot.startTime)}</td><td class="slot-time">${displayTime(slot.endTime)}</td><td>${slot.durationMinutes} min</td><td><span class="slot-status ${esc(slot.status)}">${esc(slot.status)}</span></td><td><div class="table-actions"><button type="button" data-slot-action="edit" data-id="${slot.id}" aria-label="Edit ${esc(slot.slotId)}" title="Edit">✎</button><button type="button" data-slot-action="status" data-status="${slot.status === 'active' ? 'inactive' : 'active'}" data-id="${slot.id}" aria-label="${slot.status === 'active' ? 'Deactivate' : 'Activate'} ${esc(slot.slotId)}" title="${slot.status === 'active' ? 'Deactivate' : 'Activate'}">${slot.status === 'active' ? '⏸' : '✓'}</button><button type="button" class="danger-action" data-slot-action="delete" data-id="${slot.id}" aria-label="Archive ${esc(slot.slotId)}" title="Archive">▤</button></div></td></tr>`).join('') : '<tr><td colspan="7" class="empty-row">No time slots match these filters.</td></tr>';
    $('[data-slot-summary]').textContent = `Showing ${slots.length ? `1–${slots.length} of ` : ''}${slots.length} records`;
    $('[data-slot-pages]').textContent = '1'; $('[data-slot-count]').textContent = `${state.slotStats.total} ${state.slotStats.total === 1 ? 'slot' : 'slots'}`;
  }
  function calendarFilters() {
    const query = new URLSearchParams();
    const search = $('[data-calendar-search]').value.trim(); const type = $('[data-calendar-type]').value; const period = $('[data-calendar-period]').value;
    if (search) query.set('search', search); if (type) query.set('type', type); if (period) query.set('period', period);
    return query.toString();
  }
  async function loadCalendar() {
    const query = calendarFilters(); const { events, counts } = await api(`/api/admin/time-slots/calendar${query ? `?${query}` : ''}`);
    state.calendar = events;
    $('[data-calendar-rows]').innerHTML = events.length ? events.map((event) => `<tr><td><strong>${esc(event.eventName)}</strong>${event.description ? `<small class="calendar-description" title="${esc(event.description)}">${esc(event.description)}</small>` : ''}</td><td>${esc(event.eventDate)}</td><td>${esc(event.dayName)}</td><td><span class="calendar-type ${esc(event.eventType)}">${esc(titleCase(event.eventType))}</span></td><td>${event.startTime ? `${displayTime(event.startTime)}–${displayTime(event.endTime)}` : '—'}</td><td>${esc(titleCase(event.source))}</td><td><div class="table-actions"><button type="button" data-calendar-action="view" data-id="${event.id}" aria-label="View ${esc(event.eventName)}" title="View">◉</button>${event.source === 'manual' ? `<button type="button" data-calendar-action="edit" data-id="${event.id}" aria-label="Edit ${esc(event.eventName)}" title="Edit">✎</button><button type="button" class="danger-action" data-calendar-action="delete" data-id="${event.id}" aria-label="Delete ${esc(event.eventName)}" title="Delete">×</button>` : ''}</div></td></tr>`).join('') : '<tr><td colspan="7" class="empty-row">No calendar entries match these filters.</td></tr>';
    $('[data-calendar-summary]').textContent = `${counts.total} approved entries · ${counts.holidays} holidays · ${counts.specialDays} special working days · ${counts.upcoming} upcoming`;
  }
  async function loadGoogle() {
    const status = await api('/api/admin/time-slots/google/status');
    const label = status.connectionStatus === 'connected' ? 'Connected' : status.connectionStatus === 'not_connected' ? 'Not connected' : 'Not configured';
    $('[data-google-status]').textContent = label;
    $('[data-google-status]').className = `status-pill ${status.connectionStatus === 'connected' ? 'active' : 'inactive'}`;
    $('[data-google-summary]').textContent = status.connectionStatus === 'not_configured'
      ? 'Google OAuth credentials are not configured. No account is connected and no events have been imported.'
      : `${status.accountEmail || 'No Google account connected'} · Last sync: ${status.lastSuccessfulSync || 'Never'} · ${status.importedEventCount} imported · ${status.pendingReviewCount} pending review${status.lastSyncMessage ? ` · ${status.lastSyncMessage}` : ''}`;
    $('[data-pending-count]').textContent = `${status.pendingReviewCount} pending`;
    const { events } = await api('/api/admin/time-slots/google/events?status=pending_review');
    state.googleEvents = events;
    $('[data-google-events]').innerHTML = events.length ? events.map((event) => `<article class="google-review-row"><div><strong>${esc(event.title)}</strong><small>${esc(event.eventDate)} · Google Calendar${event.description ? ` · ${esc(event.description)}` : ''}</small></div><button type="button" data-review-event="${event.id}">Review</button></article>`).join('') : '<p class="muted">No imported events are awaiting review.</p>';
    const reviewList = await api('/api/admin/time-slots/google/events?status=needs_review');
    if (reviewList.events.length) $('[data-google-events]').insertAdjacentHTML('afterbegin', reviewList.events.map((event) => `<article class="google-review-row"><div><strong>${esc(event.title)}</strong><small>${esc(event.eventDate)} · Updated source event needs review</small></div><button type="button" data-review-event="${event.id}">Review</button></article>`).join(''));
  }
  async function reload() {
    try { await Promise.all([loadSettings(), loadSlots(), loadCalendar(), loadGoogle()]); }
    catch (error) { notify(error.message, true); }
  }
  function currentDay(dayKey) { return state.weekdays.find((item) => item.dayKey === dayKey); }
  function openConfirm({ title, body, actionLabel = 'Confirm', action }) {
    state.confirmAction = action;
    $('[data-confirm-title]').textContent = title;
    $('[data-confirm-body]').textContent = body;
    $('[data-confirm-action]').textContent = actionLabel;
    $('[data-confirm-modal]').hidden = false;
    document.body.classList.add('modal-open');
    $('[data-confirm-action]').focus();
  }
  function closeConfirm() { $('[data-confirm-modal]').hidden = true; state.confirmAction = null; if ($('[data-slot-modal]').hidden && $('[data-calendar-modal]').hidden) document.body.classList.remove('modal-open'); }
  async function saveHours(dayKey, confirmed = false) {
    const day = currentDay(dayKey); const row = $(`[data-hours-row="${dayKey}"]`);
    const body = { isWorking: day.isWorking, startTime: $('[data-hours-start]', row).value, endTime: $('[data-hours-end]', row).value, confirmAffectedSlots: confirmed };
    try {
      const result = await api(`/api/admin/time-slots/weekdays/${dayKey}`, { method: 'PUT', body: JSON.stringify(body) });
      notify(result.message); await Promise.all([loadSettings(), loadSlots()]);
    } catch (error) {
      if (error.status === 409 && error.data.affectedSlots?.length && !confirmed) {
        const list = error.data.affectedSlots.map((slot) => `${slot.slotId} · ${slot.startTime}–${slot.endTime} · ${slot.status}`).join('; ');
        openConfirm({ title: 'Existing slots need review', body: `${list}. Save these hours? Existing slot records will remain unchanged.`, actionLabel: 'Save hours', action: () => saveHours(dayKey, true) });
      } else notify(error.message, true);
    }
  }
  async function toggleDay(dayKey) {
    const day = currentDay(dayKey); if (!day) return;
    const next = !day.isWorking;
    const body = { isWorking: next, startTime: day.startTime || '08:30', endTime: day.endTime || '14:35' };
    try {
      await api(`/api/admin/time-slots/weekdays/${dayKey}`, { method: 'PUT', body: JSON.stringify(body) });
      notify(`${day.dayLabel} is now ${next ? 'a working day' : 'non-working'}.`); await Promise.all([loadSettings(), loadSlots()]);
    } catch (error) {
      if (error.status === 409 && error.data.affectedSlots?.length) {
        const list = error.data.affectedSlots.map((slot) => `${slot.slotId} (${slot.startTime}–${slot.endTime})`).join(', ');
        openConfirm({ title: `Change ${day.dayLabel}?`, body: `${list} currently include this day. They will not be changed, but will need review.`, actionLabel: 'Confirm change', action: async () => {
          try { const result = await api(`/api/admin/time-slots/weekdays/${dayKey}`, { method: 'PUT', body: JSON.stringify({ ...body, confirmAffectedSlots: true }) }); closeConfirm(); notify(result.message); await Promise.all([loadSettings(), loadSlots()]); }
          catch (failure) { closeConfirm(); notify(failure.message, true); }
        } });
      } else notify(error.message, true);
    }
  }
  function checkSlotPreview() {
    const form = $('[data-slot-form]'); const selectedIds = $$('[data-weekday-check]:checked', form).map((el) => Number(el.value));
    const start = form.elements.startTime.value; const end = form.elements.endTime.value;
    const status = $('[data-slot-validation]');
    if (!selectedIds.length) { status.textContent = 'Select at least one active working day.'; status.classList.add('error'); return; }
    if (!start || !end) { status.textContent = 'Enter a start and end time.'; status.classList.remove('error'); return; }
    if (end <= start) { status.textContent = 'End time must be later than start time.'; status.classList.add('error'); return; }
    for (const weekdayId of selectedIds) {
      const day = state.weekdays.find((item) => item.id === weekdayId);
      if (!day?.isWorking) { status.textContent = `${day?.dayLabel || 'Selected day'} is not an active working day.`; status.classList.add('error'); return; }
      if (start < day.startTime || end > day.endTime) { status.textContent = `${day.dayLabel} hours are ${displayTime(day.startTime)}–${displayTime(day.endTime)}.`; status.classList.add('error'); return; }
    }
    const overlap = state.slots.find((slot) => slot.id !== state.editingSlot?.id && slot.dayKeys.some((key) => selectedIds.some((idValue) => state.weekdays.find((day) => day.id === idValue)?.dayKey === key)) && slot.startTime < end && slot.endTime > start);
    if (overlap) { status.textContent = `Overlaps ${overlap.slotId} (${displayTime(overlap.startTime)}–${displayTime(overlap.endTime)}).`; status.classList.add('error'); return; }
    const duration = Number(end.slice(0, 2)) * 60 + Number(end.slice(3)) - Number(start.slice(0, 2)) * 60 - Number(start.slice(3));
    status.textContent = `Valid ${duration}-minute time range. No duplicate or overlap detected.`;
    status.classList.remove('error');
  }
  function openSlotModal(slot = null) {
    state.editingSlot = slot; const form = $('[data-slot-form]'); form.reset(); $('[data-slot-error]').textContent = '';
    $('#slot-modal-title').textContent = slot ? `Edit ${slot.slotId}` : 'Add time slot';
    $('[data-slot-eyebrow]').textContent = slot ? 'Update record' : 'New record';
    $('[data-slot-code]').textContent = slot ? slot.slotId : 'Generated automatically when saved';
    $('[data-slot-save]').textContent = slot ? '✓  Save changes' : '✓  Save record';
    renderSlotDayChoices(slot?.weekdayIds || []);
    if (slot) { form.elements.startTime.value = slot.startTime; form.elements.endTime.value = slot.endTime; form.elements.status.value = slot.status; }
    $('[data-slot-modal]').hidden = false; document.body.classList.add('modal-open'); checkSlotPreview();
  }
  function closeSlotModal() { $('[data-slot-modal]').hidden = true; state.editingSlot = null; document.body.classList.remove('modal-open'); }
  async function saveSlot(event) {
    event.preventDefault(); const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const weekdayIds = $$('[data-weekday-check]:checked', form).map((input) => Number(input.value));
    if (!weekdayIds.length) { $('[data-slot-error]').textContent = 'Select at least one active working day.'; return; }
    const body = { weekdayIds, startTime: form.elements.startTime.value, endTime: form.elements.endTime.value, status: form.elements.status.value };
    try {
      const endpoint = state.editingSlot ? `/api/admin/time-slots/slots/${state.editingSlot.id}` : '/api/admin/time-slots/slots';
      const result = await api(endpoint, { method: state.editingSlot ? 'PUT' : 'POST', body: JSON.stringify(body) });
      closeSlotModal(); notify(result.message || `${result.slotId} created.`); await Promise.all([loadSettings(), loadSlots()]);
    } catch (error) { $('[data-slot-error]').textContent = error.message; }
  }
  function openCalendarModal(eventRecord = null) {
    state.editingEvent = eventRecord; const form = $('[data-calendar-form]'); form.reset(); $('[data-calendar-error]').textContent = '';
    $('#calendar-modal-title').textContent = eventRecord ? 'Edit calendar entry' : 'Add calendar entry';
    $('[data-calendar-eyebrow]').textContent = eventRecord ? 'Update record' : 'New record';
    if (eventRecord) {
      form.elements.eventName.value = eventRecord.eventName; form.elements.eventDate.value = eventRecord.eventDate;
      form.elements.description.value = eventRecord.description || ''; form.elements.eventType.value = eventRecord.eventType;
      form.elements.startTime.value = eventRecord.startTime || ''; form.elements.endTime.value = eventRecord.endTime || '';
    }
    toggleSpecialHours(); $('[data-calendar-modal]').hidden = false; document.body.classList.add('modal-open');
  }
  function toggleSpecialHours() { const visible = $('[data-calendar-form]').elements.eventType.value === 'special_working_day'; $$('[data-special-hours]').forEach((el) => { el.hidden = !visible; }); }
  function closeCalendarModal() { $('[data-calendar-modal]').hidden = true; state.editingEvent = null; document.body.classList.remove('modal-open'); }
  async function saveCalendar(event) {
    event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return;
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      const route = state.editingEvent ? `/api/admin/time-slots/calendar/${state.editingEvent.id}` : '/api/admin/time-slots/calendar';
      const result = await api(route, { method: state.editingEvent ? 'PUT' : 'POST', body: JSON.stringify(body) });
      closeCalendarModal(); notify(result.message); await loadCalendar();
    } catch (error) { $('[data-calendar-error]').textContent = error.message; }
  }
  async function reviewGoogleEvent(event) {
    const classification = window.prompt(`Classify “${event.title}” as: holiday, special_working_day, or ignore. No action is taken until you enter a classification.`);
    if (!classification) return;
    const normalized = classification.trim().toLowerCase().replaceAll(' ', '_');
    const body = { classification: normalized };
    if (normalized === 'special_working_day') {
      const hours = window.prompt('Enter special-day hours as HH:MM-HH:MM (24-hour time), e.g. 09:00-13:00.');
      const match = hours?.match(/^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
      if (!match) { notify('Enter special working-day hours as HH:MM-HH:MM.', true); return; }
      body.startTime = match[1]; body.endTime = match[2];
    }
    try { const result = await api(`/api/admin/time-slots/google/events/${event.id}/review`, { method: 'PATCH', body: JSON.stringify(body) }); notify(result.message); await Promise.all([loadGoogle(), loadCalendar()]); }
    catch (error) { notify(error.message, true); }
  }
  document.addEventListener('click', async (event) => {
    const toggle = event.target.closest('[data-toggle-day]'); if (toggle) await toggleDay(toggle.dataset.toggleDay);
    const saveHoursButton = event.target.closest('[data-save-hours]'); if (saveHoursButton) await saveHours(saveHoursButton.dataset.saveHours);
    const addSlotButton = event.target.closest('[data-add-slot]'); if (addSlotButton) openSlotModal();
    const slotAction = event.target.closest('[data-slot-action]');
    if (slotAction) {
      const slot = state.slots.find((item) => String(item.id) === slotAction.dataset.id);
      if (slotAction.dataset.slotAction === 'edit' && slot) {
        try { const { slot: complete } = await api(`/api/admin/time-slots/slots/${slot.id}`); openSlotModal(complete); } catch (error) { notify(error.message, true); }
      } else if (slotAction.dataset.slotAction === 'status') {
        try { const result = await api(`/api/admin/time-slots/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: slotAction.dataset.status }) }); notify(result.message); await Promise.all([loadSettings(), loadSlots()]); }
        catch (error) { notify(error.message, true); }
      } else if (slotAction.dataset.slotAction === 'delete') openConfirm({ title: `Archive ${slot.slotId}?`, body: 'The slot will be removed from active configuration. Its generated ID remains reserved and will not be reused.', actionLabel: 'Archive slot', action: async () => {
        try { const result = await api(`/api/admin/time-slots/slots/${slot.id}`, { method: 'DELETE', body: '{}' }); closeConfirm(); notify(result.message); await Promise.all([loadSettings(), loadSlots()]); } catch (error) { closeConfirm(); notify(error.message, true); }
      } });
    }
    if (event.target.closest('[data-add-calendar]')) openCalendarModal();
    const calendarAction = event.target.closest('[data-calendar-action]');
    if (calendarAction) {
      const record = state.calendar.find((item) => String(item.id) === calendarAction.dataset.id);
      if (calendarAction.dataset.calendarAction === 'view' && record) openConfirm({ title: record.eventName, body: `${record.eventDate} · ${record.dayName} · ${titleCase(record.eventType)} · ${record.description || 'No remarks'} · Source: ${titleCase(record.source)}`, actionLabel: 'Close', action: closeConfirm });
      if (calendarAction.dataset.calendarAction === 'edit' && record) openCalendarModal(record);
      if (calendarAction.dataset.calendarAction === 'delete' && record) openConfirm({ title: 'Delete calendar entry?', body: `${record.eventName} · ${record.eventDate}. The timetable module is not connected, so no affected timetable entries are available to review.`, actionLabel: 'Delete entry', action: async () => {
        try { const result = await api(`/api/admin/time-slots/calendar/${record.id}`, { method: 'DELETE', body: '{}' }); closeConfirm(); notify(result.message); await loadCalendar(); } catch (error) { closeConfirm(); notify(error.message, true); }
      } });
    }
    const reviewButton = event.target.closest('[data-review-event]'); if (reviewButton) { const record = state.googleEvents.find((item) => String(item.id) === reviewButton.dataset.reviewEvent); if (record) await reviewGoogleEvent(record); }
    if (event.target.closest('[data-confirm-cancel]')) closeConfirm();
    if (event.target.closest('[data-confirm-action]') && state.confirmAction) await state.confirmAction();
  });
  $('[data-slot-close]').addEventListener('click', closeSlotModal); $('[data-slot-cancel]').addEventListener('click', closeSlotModal);
  $('[data-slot-form]').addEventListener('submit', saveSlot);
  $('[data-slot-form]').addEventListener('input', checkSlotPreview);
  $('[data-slot-form]').addEventListener('change', checkSlotPreview);
  $('[data-calendar-close]').addEventListener('click', closeCalendarModal); $('[data-calendar-cancel]').addEventListener('click', closeCalendarModal);
  $('[data-calendar-form]').addEventListener('submit', saveCalendar);
  $('[data-calendar-form]').elements.eventType.addEventListener('change', toggleSpecialHours);
  $('[data-confirm-modal]').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeConfirm(); });
  $('[data-slot-search]').addEventListener('input', () => loadSlots().catch((error) => notify(error.message, true)));
  $('[data-slot-day]').addEventListener('change', () => loadSlots().catch((error) => notify(error.message, true)));
  $('[data-slot-status]').addEventListener('change', () => loadSlots().catch((error) => notify(error.message, true)));
  $('[data-clear-slots]').addEventListener('click', () => { $('[data-slot-search]').value = ''; $('[data-slot-day]').value = ''; $('[data-slot-status]').value = ''; loadSlots().catch((error) => notify(error.message, true)); });
  $('[data-calendar-search]').addEventListener('input', () => loadCalendar().catch((error) => notify(error.message, true)));
  $('[data-calendar-type]').addEventListener('change', () => loadCalendar().catch((error) => notify(error.message, true)));
  $('[data-calendar-period]').addEventListener('change', () => loadCalendar().catch((error) => notify(error.message, true)));
  $('[data-clear-calendar]').addEventListener('click', () => { $('[data-calendar-search]').value = ''; $('[data-calendar-type]').value = ''; $('[data-calendar-period]').value = ''; loadCalendar().catch((error) => notify(error.message, true)); });
  loadSettings().then(() => Promise.all([loadSlots(), loadCalendar(), loadGoogle()])).catch((error) => notify(error.message, true));
})();
