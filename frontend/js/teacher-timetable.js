'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const icon = (name) => `<svg class="timetable-icon" aria-hidden="true"><use href="/css/timetable-icons.svg#${name}"></use></svg>`;

  const state = {
    view: 'grid',
    filters: {
      weekdayId: '',
      search: '',
    },
    data: null,
    rescheduleOptions: null,
    activeEntry: null,
  };

  function esc(val) {
    if (val === null || val === undefined) return '';
    return String(val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function notify(msg, isError = false) {
    const el = isError ? $('[data-error]') : $('[data-message]');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => {
      el.textContent = '';
      el.style.display = 'none';
    }, 6000);
  }

  async function loadData() {
    try {
      const params = new URLSearchParams();
      if (state.filters.weekdayId) params.set('weekdayId', state.filters.weekdayId);
      if (state.filters.search) params.set('search', state.filters.search);

      const res = await fetch(`/api/teacher/timetable?${params.toString()}`);
      if (!res.ok) {
        if (res.status === 401) {
          window.location.href = '/login';
          return;
        }
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to load timetable.');
      }

      const data = await res.json();
      state.data = data;

      // Update teacher profile elements
      if (data.teacher) {
        const name = data.teacher.name || 'Teacher';
        const teacherId = data.teacher.teacherId || 'TCH';
        const nameEls = $$('[data-user-name]');
        nameEls.forEach(el => el.textContent = name);
        const printNameEl = $('[data-print-teacher-name]');
        if (printNameEl) printNameEl.textContent = `${name} (${teacherId})`;
        const idEl = $('[data-teacher-id]');
        if (idEl) idEl.textContent = teacherId;
      }

      // Update print date
      const dateEl = $('[data-print-date]');
      if (dateEl) dateEl.textContent = new Date().toLocaleDateString(undefined, { dateStyle: 'long' });

      // Populate day filter once
      const dayFilter = $('[data-filter-day]');
      if (dayFilter && dayFilter.options.length <= 1 && data.grid?.weekdays) {
        dayFilter.innerHTML = '<option value="">All working days</option>' +
          data.grid.weekdays.map(w => `<option value="${w.id}">${esc(w.dayLabel)}</option>`).join('');
      }

      renderStats();
      renderGrid();
      renderTable();
    } catch (err) {
      notify(err.message || 'Could not load timetable.', true);
    }
  }

  function renderStats() {
    if (!state.data) return;
    const entries = state.data.entries || [];
    const totalEl = $('[data-stat="total"]');
    if (totalEl) totalEl.textContent = String(entries.length);

    const sections = new Set(entries.map(e => e.sectionId));
    const secEl = $('[data-stat="sections"]');
    if (secEl) secEl.textContent = String(sections.size);

    const subjects = new Set(entries.map(e => e.subjectId));
    const subEl = $('[data-stat="subjects"]');
    if (subEl) subEl.textContent = String(subjects.size);

    const rooms = new Set(entries.map(e => e.roomId));
    const roomEl = $('[data-stat="rooms"]');
    if (roomEl) roomEl.textContent = String(rooms.size);
  }

  function renderGrid() {
    if (!state.data?.grid) return;
    const { weekdays, timeSlots, matrix } = state.data.grid;
    const canReschedule = Boolean(state.data.canReschedule);
    const head = $('[data-matrix-head]');
    const body = $('[data-matrix-body]');
    if (!head || !body) return;

    const activeWeekdays = state.filters.weekdayId
      ? weekdays.filter(w => String(w.id) === String(state.filters.weekdayId))
      : weekdays;

    head.innerHTML = `<tr><th>Time Slot</th>${activeWeekdays.map(w => `<th>${esc(w.dayLabel)}</th>`).join('')}</tr>`;

    if (!timeSlots.length) {
      body.innerHTML = `<tr><td colspan="${activeWeekdays.length + 1}" class="empty-row">No active time slots configured.</td></tr>`;
      return;
    }

    const search = state.filters.search.toLowerCase();

    body.innerHTML = timeSlots.map(slot => {
      const cells = activeWeekdays.map(day => {
        const item = matrix[day.id]?.[slot.id];
        if (!item) {
          return '<td class="matrix-cell empty-slot"><span class="free-badge">Free</span></td>';
        }

        const match = !search ||
          item.sectionName.toLowerCase().includes(search) ||
          item.subjectName.toLowerCase().includes(search) ||
          item.roomNumber.toLowerCase().includes(search);

        if (!match) {
          return '<td class="matrix-cell empty-slot"><span class="muted-slot">—</span></td>';
        }

        return `
          <td class="matrix-cell booked-slot">
            <div class="matrix-card">
              <strong class="matrix-subject">${esc(item.subjectName)}</strong>
              <div class="matrix-meta">
                <span class="matrix-sec">${esc(item.sectionName)}</span>
                <span class="matrix-room">${esc(item.roomNumber)}</span>
              </div>
              <small class="matrix-building">${esc(item.buildingName)}</small>
              ${canReschedule ? `
                <div class="no-print" style="margin-top:6px;text-align:right">
                  <button type="button" class="text-button" data-reschedule-btn="${item.id}" style="font-size:11px;padding:2px 6px">${icon('refresh')}Reschedule</button>
                </div>
              ` : ''}
            </div>
          </td>
        `;
      }).join('');

      return `
        <tr>
          <td class="slot-time-col">
            <strong>${esc(slot.slotCode)}</strong>
            <small>${esc(slot.startTime)} – ${esc(slot.endTime)}</small>
          </td>
          ${cells}
        </tr>
      `;
    }).join('');

    attachRescheduleButtons();
  }

  function renderTable() {
    const tbody = $('[data-timetable-rows]');
    if (!tbody || !state.data) return;
    const entries = state.data.entries || [];
    const canReschedule = Boolean(state.data.canReschedule);

    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No scheduled classes found matching the filters.</td></tr>';
      return;
    }

    tbody.innerHTML = entries.map(e => `
      <tr>
        <td>
          <span class="day-badge">${esc(e.dayLabel)}</span>
          <span class="slot-time-badge">${esc(e.startTime)} – ${esc(e.endTime)}</span>
          <small>${esc(e.slotCode)}</small>
        </td>
        <td>
          <strong>${esc(e.sectionName)}</strong>
          <small>${esc(e.programmeName)}</small>
        </td>
        <td>
          <strong>${esc(e.subjectName)}</strong>
          ${e.subjectCode ? `<small>${esc(e.subjectCode)}</small>` : ''}
        </td>
        <td>
          <span class="room-badge">${esc(e.roomNumber)}</span>
        </td>
        <td>
          <small>${esc(e.buildingName)}</small>
        </td>
        <td class="no-print">
          ${canReschedule ? `
            <button type="button" class="secondary-button" data-reschedule-btn="${e.id}" style="font-size:12px;padding:4px 8px">${icon('refresh')}Reschedule</button>
          ` : `
            <span class="view-pill" style="font-size:11px;opacity:0.6" title="Teacher rescheduling permission not granted by administrator">Not permitted</span>
          `}
        </td>
      </tr>
    `).join('');

    attachRescheduleButtons();
  }

  function attachRescheduleButtons() {
    $$('[data-reschedule-btn]').forEach(btn => {
      btn.onclick = () => {
        const id = Number(btn.getAttribute('data-reschedule-btn'));
        const entry = state.data.entries.find(e => e.id === id);
        if (entry) openRescheduleModal(entry);
      };
    });
  }

  async function openRescheduleModal(entry) {
    state.activeEntry = entry;
    const modal = $('[data-reschedule-modal]');
    if (!modal) return;

    $('[data-reschedule-subject]').value = `${entry.subjectName} (${entry.subjectCode || ''})`;
    $('[data-reschedule-section]').value = `${entry.sectionName} · ${entry.programmeName}`;
    $('input[name="entryId"]').value = String(entry.id);
    $('[data-reschedule-error]').textContent = '';

    // Load options if not loaded
    if (!state.rescheduleOptions) {
      try {
        const res = await fetch('/api/teacher/timetable/reschedule-options');
        if (res.ok) {
          state.rescheduleOptions = await res.json();
        }
      } catch (_) {}
    }

    const opts = state.rescheduleOptions || state.data?.grid;
    if (opts) {
      const daySelect = $('[data-reschedule-day]');
      if (daySelect && opts.weekdays) {
        daySelect.innerHTML = '<option value="">Select working day</option>' +
          opts.weekdays.map(w => `<option value="${w.id}" ${w.id === entry.weekdayId ? 'selected' : ''}>${esc(w.dayLabel)}</option>`).join('');
      }

      const slotSelect = $('[data-reschedule-slot]');
      if (slotSelect && opts.timeSlots) {
        slotSelect.innerHTML = '<option value="">Select time slot</option>' +
          opts.timeSlots.map(s => `<option value="${s.id}" ${s.id === entry.timeSlotId ? 'selected' : ''}>${esc(s.slotCode)} (${esc(s.startTime)} – ${esc(s.endTime)})</option>`).join('');
      }

      const roomSelect = $('[data-reschedule-room]');
      if (roomSelect && state.rescheduleOptions?.rooms) {
        roomSelect.innerHTML = '<option value="">Select room</option>' +
          state.rescheduleOptions.rooms.map(r => `<option value="${r.id}" ${r.id === entry.roomId ? 'selected' : ''}>${esc(r.roomNumber)} (${esc(r.buildingName)})</option>`).join('');
      }
    }

    modal.hidden = false;
  }

  function closeRescheduleModal() {
    const modal = $('[data-reschedule-modal]');
    if (modal) modal.hidden = true;
    state.activeEntry = null;
  }

  async function handleRescheduleSubmit(e) {
    e.preventDefault();
    const errorEl = $('[data-reschedule-error]');
    errorEl.textContent = '';

    if (!state.activeEntry) return;

    const form = e.target;
    const body = {
      weekdayId: form.weekdayId.value,
      timeSlotId: form.timeSlotId.value,
      roomId: form.roomId.value,
      reason: form.reason.value,
    };

    try {
      const res = await fetch(`/api/teacher/timetable/${state.activeEntry.id}/reschedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        errorEl.textContent = data.error || 'Failed to reschedule class.';
        return;
      }

      closeRescheduleModal();
      notify('Class rescheduled successfully. Enrolled students and faculty have been notified.');
      await loadData();
    } catch (err) {
      errorEl.textContent = err.message || 'Network error occurred.';
    }
  }

  function setView(view) {
    state.view = view;
    $$('.view-tab').forEach(btn => {
      const on = btn.dataset.view === view;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
    });

    const gridSec = $('[data-grid-section]');
    const tableSec = $('[data-table-section]');
    if (gridSec) gridSec.hidden = view !== 'grid';
    if (tableSec) tableSec.hidden = view !== 'table';
  }

  function init() {
    // View Switcher
    $$('.view-tab').forEach(btn => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });

    // Filters
    $('[data-filter-day]')?.addEventListener('change', (e) => {
      state.filters.weekdayId = e.target.value;
      loadData();
    });

    $('[data-search]')?.addEventListener('input', (e) => {
      state.filters.search = e.target.value;
      loadData();
    });

    $('[data-clear]')?.addEventListener('click', () => {
      state.filters.weekdayId = '';
      state.filters.search = '';
      const dayEl = $('[data-filter-day]');
      if (dayEl) dayEl.value = '';
      const searchEl = $('[data-search]');
      if (searchEl) searchEl.value = '';
      loadData();
    });

    // Download CSV
    $('[data-download-csv]')?.addEventListener('click', () => {
      window.location.href = '/api/teacher/timetable/export';
    });

    // Print
    $('[data-print-timetable]')?.addEventListener('click', () => {
      window.print();
    });

    // Reschedule Modal controls
    $('[data-reschedule-close]')?.addEventListener('click', closeRescheduleModal);
    $('[data-reschedule-cancel]')?.addEventListener('click', closeRescheduleModal);
    $('[data-reschedule-form]')?.addEventListener('submit', handleRescheduleSubmit);

    loadData();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
