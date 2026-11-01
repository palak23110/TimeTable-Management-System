'use strict';

(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => document.querySelectorAll(selector);
  const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  const state = {
    data: null,
    view: 'grid',
    filters: {
      weekdayId: '',
      search: '',
    },
  };

  async function api(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  function notify(text, isError = false) {
    const el = $('[data-message]');
    if (!el) return;
    el.textContent = text;
    el.className = `timetable-message${isError ? ' is-error' : ''}`;
  }

  async function loadData() {
    try {
      const query = new URLSearchParams({
        ...(state.filters.weekdayId ? { weekdayId: state.filters.weekdayId } : {}),
        ...(state.filters.search ? { search: state.filters.search } : {}),
      });

      const data = await api(`/api/student/timetable?${query.toString()}`);
      state.data = data;

      // Update student profile banner
      const student = data.student || {};
      const studentName = student.name || 'Student';
      const studentId = student.studentId || '';
      const sectionName = student.sectionName || 'Not placed';
      const programmeName = student.programmeName || 'General';
      const semesterName = student.semesterName || 'Semester 1';

      const titleEl = $('[data-student-title]');
      if (titleEl) titleEl.textContent = `${studentName} ${studentId ? `(${studentId})` : ''}`;

      const progEl = $('[data-student-programme]');
      if (progEl) progEl.textContent = programmeName;

      const semEl = $('[data-student-semester]');
      if (semEl) semEl.textContent = semesterName;

      const secEl = $('[data-student-section]');
      if (secEl) secEl.textContent = `Section: ${sectionName}`;

      const idEl = $('[data-student-id]');
      if (idEl) idEl.textContent = studentId;

      const printInfoEl = $('[data-print-student-info]');
      if (printInfoEl) printInfoEl.textContent = `${studentName} (${studentId}) · ${programmeName} · ${sectionName}`;

      const dateEl = $('[data-print-date]');
      if (dateEl) dateEl.textContent = new Date().toLocaleDateString(undefined, { dateStyle: 'long' });

      // Handle unassigned state
      const unassignedNotice = $('[data-unassigned-notice]');
      const controls = $('[data-controls]');
      const gridSec = $('[data-grid-section]');
      const tableSec = $('[data-table-section]');

      if (!data.hasSection) {
        if (unassignedNotice) {
          unassignedNotice.hidden = false;
          unassignedNotice.removeAttribute('hidden');
          const noticeText = $('[data-unassigned-text]');
          if (noticeText && data.message) noticeText.textContent = data.message;
        }
        if (controls) controls.hidden = true;
        if (gridSec) gridSec.hidden = true;
        if (tableSec) tableSec.hidden = true;
        return;
      }

      if (unassignedNotice) unassignedNotice.hidden = true;
      if (controls) controls.hidden = false;
      if (gridSec && state.view === 'grid') gridSec.hidden = false;
      if (tableSec && state.view === 'table') tableSec.hidden = false;

      // Populate day filter once
      const dayFilter = $('[data-filter-day]');
      if (dayFilter && dayFilter.options.length <= 1 && data.grid?.weekdays) {
        dayFilter.innerHTML = '<option value="">All working days</option>' +
          data.grid.weekdays.map(w => `<option value="${w.id}">${esc(w.dayLabel)}</option>`).join('');
      }

      renderGrid();
      renderTable();
    } catch (err) {
      notify(err.message || 'Could not load timetable.', true);
    }
  }

  function renderGrid() {
    if (!state.data?.grid) return;
    const { weekdays, timeSlots, matrix } = state.data.grid;
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
          return '<td class="matrix-cell empty-slot"><span class="free-badge">No class</span></td>';
        }

        const match = !search ||
          item.subjectName.toLowerCase().includes(search) ||
          item.teacherName.toLowerCase().includes(search) ||
          item.roomNumber.toLowerCase().includes(search);

        if (!match) {
          return '<td class="matrix-cell empty-slot"><span class="muted-slot">—</span></td>';
        }

        return `
          <td class="matrix-cell booked-slot student-booked">
            <div class="matrix-card">
              <strong class="matrix-subject">${esc(item.subjectName)}</strong>
              <div class="matrix-teacher">👨‍🏫 ${esc(item.teacherName)}</div>
              <div class="matrix-meta">
                <span class="matrix-room">▥ ${esc(item.roomNumber)}</span>
              </div>
              <small class="matrix-building">${esc(item.buildingName)}</small>
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
  }

  function renderTable() {
    const tbody = $('[data-timetable-rows]');
    if (!tbody || !state.data) return;
    const entries = state.data.entries || [];

    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-row">No scheduled classes found matching the filters.</td></tr>';
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
          <strong>${esc(e.subjectName)}</strong>
          ${e.subjectCode ? `<small>${esc(e.subjectCode)}</small>` : ''}
        </td>
        <td>
          <strong>${esc(e.teacherName)}</strong>
          ${e.teacherId ? `<small>${esc(e.teacherId)}</small>` : ''}
        </td>
        <td>
          <span class="room-badge">${esc(e.roomNumber)}</span>
        </td>
        <td>
          <small>${esc(e.buildingName)}</small>
        </td>
      </tr>
    `).join('');
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
    $$('.view-tab').forEach(btn => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });

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

    $('[data-download-csv]')?.addEventListener('click', () => {
      window.location.href = '/api/student/timetable/export';
    });

    $('[data-print-timetable]')?.addEventListener('click', () => {
      window.print();
    });

    loadData();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

