'use strict';

(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => document.querySelectorAll(selector);
  const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  const state = {
    options: null,
    entries: [],
    page: 1,
    totalPages: 1,
    total: 0,
    view: 'table', // 'table' | 'grid'
    filters: {
      programmeId: '',
      sectionId: '',
      teacherId: '',
      subjectId: '',
      semesterId: '',
      weekdayId: '',
      search: '',
    },
    activeDeleteId: null,
  };

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'The request could not be completed.');
      error.data = data;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function notify(text, isError = false) {
    const el = $('[data-message]');
    if (!el) return;
    el.textContent = text;
    el.className = `timetable-message${isError ? ' is-error' : ''}`;
    if (!isError) {
      setTimeout(() => {
        if (el.textContent === text) el.textContent = '';
      }, 5000);
    }
  }

  function formError(text = '') {
    const el = $('[data-form-error]');
    if (el) el.textContent = text;
  }

  async function loadOptions() {
    try {
      const data = await api('/api/admin/timetable/options');
      state.options = data;

      const programmes = data.programmes || [];
      const teachers = data.teachers || [];
      const subjects = data.subjects || [];
      const rooms = data.rooms || [];
      const weekdays = data.weekdays || [];
      const timeSlots = data.timeSlots || [];
      const semesters = data.semesters || [];

      // Populate filter dropdowns (TC43)
      const progFilter = $('[data-filter-programme]');
      if (progFilter) {
        progFilter.innerHTML = '<option value="">All programmes</option>' +
          programmes.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
      }

      const teacherFilter = $('[data-filter-teacher]');
      if (teacherFilter) {
        teacherFilter.innerHTML = '<option value="">All teachers</option>' +
          teachers.map((t) => `<option value="${t.id}">${esc(t.name)}${t.teacherId ? ` (${esc(t.teacherId)})` : ''}</option>`).join('');
      }

      const subjFilter = $('[data-filter-subject]');
      if (subjFilter) {
        subjFilter.innerHTML = '<option value="">All subjects</option>' +
          subjects.map((s) => `<option value="${s.id}">${esc(s.name)}${s.code ? ` (${esc(s.code)})` : ''}</option>`).join('');
      }

      const semFilter = $('[data-filter-semester]');
      if (semFilter) {
        semFilter.innerHTML = '<option value="">All semesters</option>' +
          semesters.map((sem) => `<option value="${sem.id}">${esc(sem.label)}</option>`).join('');
      }

      const dayFilter = $('[data-filter-day]');
      if (dayFilter) {
        dayFilter.innerHTML = '<option value="">All days</option>' +
          weekdays.map((w) => `<option value="${w.id}">${esc(w.dayLabel)}</option>`).join('');
      }

      updateSectionFilter();

      // Populate form dropdowns in editor modal
      const formProg = $('[data-form-programme]');
      if (formProg) {
        formProg.innerHTML = '<option value="">Select programme</option>' +
          programmes.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
      }

      const formSubj = $('[data-form-subject]');
      if (formSubj) {
        formSubj.innerHTML = '<option value="">Select subject</option>' +
          subjects.map((s) => `<option value="${s.id}">${esc(s.name)}${s.code ? ` (${esc(s.code)})` : ''}</option>`).join('');
      }

      const formTeacher = $('[data-form-teacher]');
      if (formTeacher) {
        formTeacher.innerHTML = '<option value="">Select teacher</option>' +
          teachers.map((t) => `<option value="${t.id}">${esc(t.name)}${t.teacherId ? ` (${esc(t.teacherId)})` : ''}</option>`).join('');
      }

      const formRoom = $('[data-form-room]');
      if (formRoom) {
        formRoom.innerHTML = '<option value="">Select room or lab</option>' +
          rooms.map((r) => `<option value="${r.id}">${esc(r.roomNumber)} · ${esc(r.buildingName)}${r.capacity ? ` (${r.capacity} seats)` : ''}</option>`).join('');
      }

      const formDay = $('[data-form-day]');
      if (formDay) {
        formDay.innerHTML = '<option value="">Select day</option>' +
          weekdays.map((w) => `<option value="${w.id}">${esc(w.dayLabel)}</option>`).join('');
      }

      const formSlot = $('[data-form-slot]');
      if (formSlot) {
        formSlot.innerHTML = '<option value="">Select time slot</option>' +
          timeSlots.map((ts) => `<option value="${ts.id}">${esc(ts.slotCode || ts.slotId)} (${esc(ts.startTime)} – ${esc(ts.endTime)})</option>`).join('');
      }

      updateFormSections('');
      return data;
    } catch (err) {
      notify(err.message || 'Could not load form options.', true);
      throw err;
    }
  }

  function updateSectionFilter() {
    const secFilter = $('[data-filter-section]');
    if (!secFilter || !state.options) return;

    const allSections = state.options.sections || [];
    const progId = state.filters.programmeId;
    const filtered = progId
      ? allSections.filter((s) => String(s.programmeId) === String(progId))
      : allSections;

    secFilter.innerHTML = '<option value="">All sections</option>' +
      filtered.map((s) => `<option value="${s.id}">${esc(s.programmeName)} · ${esc(s.sectionName)}</option>`).join('');
  }

  function updateFormSections(selectedProgId, selectedSecId = '') {
    const secSelect = $('[data-form-section]');
    if (!secSelect || !state.options) return;

    const allSections = state.options.sections || [];
    const sections = selectedProgId
      ? allSections.filter((s) => String(s.programmeId) === String(selectedProgId))
      : allSections;

    secSelect.innerHTML = '<option value="">Select section</option>' +
      sections.map((s) => `<option value="${s.id}"${String(s.id) === String(selectedSecId) ? ' selected' : ''}>${esc(s.programmeName)} · ${esc(s.sectionName)}</option>`).join('');
    secSelect.disabled = false;
  }

  function buildFilterQuery() {
    return new URLSearchParams({
      page: state.page,
      ...(state.filters.programmeId ? { programmeId: state.filters.programmeId } : {}),
      ...(state.filters.sectionId ? { sectionId: state.filters.sectionId } : {}),
      ...(state.filters.teacherId ? { teacherId: state.filters.teacherId } : {}),
      ...(state.filters.subjectId ? { subjectId: state.filters.subjectId } : {}),
      ...(state.filters.semesterId ? { semesterId: state.filters.semesterId } : {}),
      ...(state.filters.weekdayId ? { weekdayId: state.filters.weekdayId } : {}),
      ...(state.filters.search ? { search: state.filters.search } : {}),
    });
  }

  async function loadTimetable() {
    const tbody = $('[data-timetable-rows]');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="empty-row">Loading timetable records…</td></tr>';

    try {
      const query = buildFilterQuery();
      const data = await api(`/api/admin/timetable?${query.toString()}`);
      state.entries = data.entries || [];
      state.page = data.page || 1;
      state.totalPages = data.totalPages || 1;
      state.total = data.total || 0;

      // Update print metadata
      const dateEl = $('[data-print-date]');
      if (dateEl) dateEl.textContent = new Date().toLocaleDateString(undefined, { dateStyle: 'long' });
      const summaryEl = $('[data-print-filter-summary]');
      if (summaryEl) {
        const parts = [];
        if (state.filters.programmeId && state.options) {
          const p = state.options.programmes.find(item => String(item.id) === String(state.filters.programmeId));
          if (p) parts.push(p.name);
        }
        if (state.filters.sectionId && state.options) {
          const s = state.options.sections.find(item => String(item.id) === String(state.filters.sectionId));
          if (s) parts.push(`Section: ${s.sectionName}`);
        }
        if (state.filters.teacherId && state.options) {
          const t = state.options.teachers.find(item => String(item.id) === String(state.filters.teacherId));
          if (t) parts.push(`Teacher: ${t.name}`);
        }
        summaryEl.textContent = parts.length ? parts.join(' · ') : 'All Active Timetable Records';
      }

      renderTable();
      renderStats();
      if (state.view === 'grid') renderGrid();
    } catch (err) {
      notify(err.message || 'Could not load timetable records.', true);
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="empty-row">Error loading timetable records.</td></tr>';
    }
  }

  function renderTable() {
    const tbody = $('[data-timetable-rows]');
    if (!tbody) return;

    if (!state.entries.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No timetable records match the current filters.</td></tr>';
      const summaryEl = $('[data-page-summary]');
      if (summaryEl) summaryEl.textContent = 'Showing 0 records';
      const pageEl = $('[data-page-number]');
      if (pageEl) pageEl.textContent = '1';
      return;
    }

    tbody.innerHTML = state.entries.map((entry) => `
      <tr data-entry-id="${entry.id}">
        <td>
          <span class="day-badge">${esc(entry.dayLabel)}</span>
          <span class="slot-time-badge">${esc(entry.startTime)} – ${esc(entry.endTime)}</span>
          <small>${esc(entry.slotCode)}</small>
        </td>
        <td>
          <strong>${esc(entry.sectionName)}</strong>
          <small>${esc(entry.programmeName)}</small>
        </td>
        <td>
          <strong>${esc(entry.subjectName)}</strong>
          ${entry.subjectCode ? `<small>${esc(entry.subjectCode)}</small>` : ''}
        </td>
        <td>
          <strong>${esc(entry.teacherName)}</strong>
          ${entry.teacherId ? `<small>${esc(entry.teacherId)}</small>` : ''}
        </td>
        <td>
          <span class="room-badge">${esc(entry.roomNumber)}</span>
          <small>${esc(entry.buildingName)}</small>
        </td>
        <td class="timetable-actions no-print">
          <button type="button" class="action-edit" data-edit-id="${entry.id}">Edit</button>
          <button type="button" class="action-delete" data-delete-id="${entry.id}">Delete</button>
        </td>
      </tr>
    `).join('');

    const summaryEl = $('[data-page-summary]');
    if (summaryEl) {
      summaryEl.textContent = `Showing ${(state.page - 1) * 10 + 1}–${Math.min(state.page * 10, state.total)} of ${state.total} records`;
    }
    const pageEl = $('[data-page-number]');
    if (pageEl) pageEl.textContent = String(state.page);
  }

  function renderGrid() {
    if (!state.options) return;
    const { weekdays, timeSlots } = state.options;
    const head = $('[data-matrix-head]');
    const body = $('[data-matrix-body]');
    if (!head || !body) return;

    // Filter displayed weekdays if day filter is active
    const activeWeekdays = state.filters.weekdayId
      ? weekdays.filter(w => String(w.id) === String(state.filters.weekdayId))
      : weekdays;

    head.innerHTML = `<tr><th>Time Slot</th>${activeWeekdays.map(w => `<th>${esc(w.dayLabel)}</th>`).join('')}</tr>`;

    // Map entries into matrix[weekdayId][timeSlotId] = Array of entries
    const matrix = {};
    for (const e of state.entries) {
      if (!matrix[e.weekdayId]) matrix[e.weekdayId] = {};
      if (!matrix[e.weekdayId][e.timeSlotId]) matrix[e.weekdayId][e.timeSlotId] = [];
      matrix[e.weekdayId][e.timeSlotId].push(e);
    }

    body.innerHTML = timeSlots.map(slot => {
      const cells = activeWeekdays.map(day => {
        const items = matrix[day.id]?.[slot.id] || [];
        if (!items.length) {
          return '<td class="matrix-cell empty-slot"><span class="free-badge">Available</span></td>';
        }

        return `
          <td class="matrix-cell booked-slot">
            ${items.map(item => `
              <div class="matrix-card">
                <strong class="matrix-subject">${esc(item.subjectName)}</strong>
                <div class="matrix-teacher">👨‍🏫 ${esc(item.teacherName)}</div>
                <div class="matrix-meta">
                  <span class="matrix-sec">${esc(item.sectionName)}</span>
                  <span class="matrix-room">${esc(item.roomNumber)}</span>
                </div>
              </div>
            `).join('')}
          </td>
        `;
      }).join('');

      return `
        <tr>
          <td class="slot-time-col">
            <strong>${esc(slot.slotCode || slot.slotId)}</strong>
            <small>${esc(slot.startTime)} – ${esc(slot.endTime)}</small>
          </td>
          ${cells}
        </tr>
      `;
    }).join('');
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

    if (view === 'grid') renderGrid();
  }

  function renderStats() {
    const totalEl = $('[data-stat="total"]');
    if (totalEl) totalEl.textContent = String(state.total);

    const sectionsEl = $('[data-stat="sections"]');
    if (sectionsEl && state.options) sectionsEl.textContent = String(state.options.sections.length);

    const teachersEl = $('[data-stat="teachers"]');
    if (teachersEl && state.options) teachersEl.textContent = String(state.options.teachers.length);

    const roomsEl = $('[data-stat="rooms"]');
    if (roomsEl && state.options) roomsEl.textContent = String(state.options.rooms.length);
  }

  function openEditor(entry = null) {
    formError('');
    const form = $('[data-timetable-form]');
    if (!form) return;

    form.reset();

    const applyData = () => {
      if (entry) {
        $('[data-editor-eyebrow]').textContent = 'Edit Timetable Record';
        $('[data-editor-title]').textContent = 'Edit and update timetable';
        $('[data-save]').textContent = '✓  Update timetable';
        form.elements.entryId.value = entry.id;

        form.elements.programmeId.value = entry.programmeId;
        updateFormSections(entry.programmeId, entry.sectionId);

        form.elements.subjectId.value = entry.subjectId;
        form.elements.teacherUserId.value = entry.teacherUserId;
        form.elements.roomId.value = entry.roomId;
        form.elements.weekdayId.value = entry.weekdayId;
        form.elements.timeSlotId.value = entry.timeSlotId;
      } else {
        $('[data-editor-eyebrow]').textContent = 'New Timetable Record';
        $('[data-editor-title]').textContent = 'Create a timetable';
        $('[data-save]').textContent = '✓  Save timetable';
        form.elements.entryId.value = '';
        updateFormSections('');
      }
    };

    if (!state.options) {
      loadOptions().then(applyData).catch(() => {});
    } else {
      applyData();
    }

    const editorEl = $('[data-editor]');
    if (editorEl) {
      editorEl.hidden = false;
      editorEl.removeAttribute('hidden');
    }
    document.body.classList.add('modal-open');
  }

  function closeEditor() {
    const editorEl = $('[data-editor]');
    if (editorEl) {
      editorEl.hidden = true;
      editorEl.setAttribute('hidden', '');
    }
    document.body.classList.remove('modal-open');
    formError('');
  }

  function openConfirm(id, summary) {
    state.activeDeleteId = id;
    const summaryEl = $('[data-confirm-summary]');
    if (summaryEl) summaryEl.textContent = summary || 'Are you sure you want to delete this timetable record?';
    const confirmEl = $('[data-confirm]');
    if (confirmEl) {
      confirmEl.hidden = false;
      confirmEl.removeAttribute('hidden');
    }
    document.body.classList.add('modal-open');
  }

  function closeConfirm() {
    const confirmEl = $('[data-confirm]');
    if (confirmEl) {
      confirmEl.hidden = true;
      confirmEl.setAttribute('hidden', '');
    }
    document.body.classList.remove('modal-open');
    state.activeDeleteId = null;
  }

  async function handleFormSubmit(e) {
    e.preventDefault();
    formError('');

    const form = e.target;
    const entryId = form.elements.entryId.value;
    const sectionId = form.elements.sectionId.value;
    const subjectId = form.elements.subjectId.value;
    const teacherUserId = form.elements.teacherUserId.value;
    const roomId = form.elements.roomId.value;
    const weekdayId = form.elements.weekdayId.value;
    const timeSlotId = form.elements.timeSlotId.value;

    if (!sectionId || !subjectId || !teacherUserId || !roomId || !weekdayId || !timeSlotId) {
      formError('Please fill in all required scheduling details.');
      return;
    }

    const body = {
      sectionId: Number(sectionId),
      subjectId: Number(subjectId),
      teacherUserId: Number(teacherUserId),
      roomId: Number(roomId),
      weekdayId: Number(weekdayId),
      timeSlotId: Number(timeSlotId),
      reason: form.elements.reason?.value?.trim() || null,
    };

    try {
      const url = entryId ? `/api/admin/timetable/${entryId}` : '/api/admin/timetable';
      const method = entryId ? 'PUT' : 'POST';
      const result = await api(url, { method, body: JSON.stringify(body) });

      closeEditor();
      notify(result.message || (entryId ? 'Updated timetable details are saved and displayed successfully.' : 'Timetable is created and saved successfully.'));
      await loadTimetable();
    } catch (err) {
      formError(err.message || 'Failed to save timetable entry.');
    }
  }

  async function handleTableClick(e) {
    const editBtn = e.target.closest('[data-edit-id]');
    if (editBtn) {
      const id = editBtn.dataset.editId;
      try {
        const data = await api(`/api/admin/timetable/${id}`);
        if (data.entry) openEditor(data.entry);
      } catch (err) {
        notify(err.message || 'Could not load timetable record details.', true);
      }
      return;
    }

    const deleteBtn = e.target.closest('[data-delete-id]');
    if (deleteBtn) {
      const id = deleteBtn.dataset.deleteId;
      const entry = state.entries.find((item) => String(item.id) === String(id));
      const summary = entry
        ? `Delete timetable record for ${entry.sectionName} (${entry.subjectName} on ${entry.dayLabel} at ${entry.startTime})?`
        : 'Delete this timetable record?';
      openConfirm(id, summary);
    }
  }

  async function handleConfirmDelete() {
    if (!state.activeDeleteId) return;
    try {
      const result = await api(`/api/admin/timetable/${state.activeDeleteId}`, {
        method: 'DELETE',
        body: '{}',
      });
      closeConfirm();
      notify(result.message || 'Timetable entry deleted successfully.');
      await loadTimetable();
    } catch (err) {
      notify(err.message || 'Failed to delete timetable entry.', true);
      closeConfirm();
    }
  }

  function init() {
    // 1. Open Add Modal Button
    const openBtn = $('[data-open-timetable]') || $('#btn-create-timetable');
    if (openBtn) {
      openBtn.addEventListener('click', (e) => {
        e.preventDefault();
        openEditor();
      });
    }

    // 2. Modal Close / Cancel Buttons
    $('[data-editor-close]')?.addEventListener('click', closeEditor);
    $('[data-editor-cancel]')?.addEventListener('click', closeEditor);

    // 3. Form Programme Selection Change
    $('[data-form-programme]')?.addEventListener('change', (e) => {
      updateFormSections(e.target.value);
    });

    $('[data-form-section]')?.addEventListener('change', (e) => {
      const secId = e.target.value;
      if (secId && state.options?.sections) {
        const sec = state.options.sections.find((s) => String(s.id) === String(secId));
        const progSelect = $('[data-form-programme]');
        if (sec && progSelect && !progSelect.value) {
          progSelect.value = String(sec.programmeId);
        }
      }
    });

    // 4. Form Submission
    $('[data-timetable-form]')?.addEventListener('submit', handleFormSubmit);

    // 5. Table Actions (Edit / Delete delegation)
    $('[data-timetable-rows]')?.addEventListener('click', handleTableClick);

    // 6. Confirm Delete Actions
    $('[data-confirm-back]')?.addEventListener('click', closeConfirm);
    $('[data-confirm-delete]')?.addEventListener('click', handleConfirmDelete);

    // 7. View Switcher Tabs (TC42)
    $$('.view-tab').forEach(btn => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });

    // 8. Filters (TC43)
    $('[data-filter-programme]')?.addEventListener('change', (e) => {
      state.filters.programmeId = e.target.value;
      state.filters.sectionId = '';
      updateSectionFilter();
      state.page = 1;
      loadTimetable();
    });

    $('[data-filter-section]')?.addEventListener('change', (e) => {
      state.filters.sectionId = e.target.value;
      state.page = 1;
      loadTimetable();
    });

    $('[data-filter-teacher]')?.addEventListener('change', (e) => {
      state.filters.teacherId = e.target.value;
      state.page = 1;
      loadTimetable();
    });

    $('[data-filter-subject]')?.addEventListener('change', (e) => {
      state.filters.subjectId = e.target.value;
      state.page = 1;
      loadTimetable();
    });

    $('[data-filter-semester]')?.addEventListener('change', (e) => {
      state.filters.semesterId = e.target.value;
      state.page = 1;
      loadTimetable();
    });

    $('[data-filter-day]')?.addEventListener('change', (e) => {
      state.filters.weekdayId = e.target.value;
      state.page = 1;
      loadTimetable();
    });

    $('[data-search]')?.addEventListener('input', (e) => {
      state.filters.search = e.target.value;
      state.page = 1;
      loadTimetable();
    });

    $('[data-clear]')?.addEventListener('click', () => {
      state.filters = {
        programmeId: '',
        sectionId: '',
        teacherId: '',
        subjectId: '',
        semesterId: '',
        weekdayId: '',
        search: '',
      };
      const ids = ['[data-filter-programme]', '[data-filter-section]', '[data-filter-teacher]', '[data-filter-subject]', '[data-filter-semester]', '[data-filter-day]', '[data-search]'];
      ids.forEach(sel => { const el = $(sel); if (el) el.value = ''; });
      updateSectionFilter();
      state.page = 1;
      loadTimetable();
    });

    // 9. Download CSV (TC44)
    $('[data-download-csv]')?.addEventListener('click', () => {
      const query = buildFilterQuery();
      window.location.href = `/api/admin/timetable/export?${query.toString()}`;
    });

    // 10. Print Timetable (TC44)
    $('[data-print-timetable]')?.addEventListener('click', () => {
      window.print();
    });

    // 10b. Teacher Permissions Modal (TC46)
    $('[data-open-permissions]')?.addEventListener('click', async () => {
      const modal = $('[data-permissions-modal]');
      const tbody = $('[data-permissions-rows]');
      if (!modal || !tbody) return;
      modal.hidden = false;
      document.body.classList.add('modal-open');
      tbody.innerHTML = '<tr><td colspan="4" class="empty-row">Loading teacher authorizations…</td></tr>';

      try {
        const data = await api('/api/admin/timetable/permissions/teachers');
        const teachers = data.teachers || [];
        if (!teachers.length) {
          tbody.innerHTML = '<tr><td colspan="4" class="empty-row">No active teachers found.</td></tr>';
          return;
        }

        const renderRows = () => {
          tbody.innerHTML = teachers.map(t => `
            <tr style="border-bottom:1px solid #edf2f7;">
              <td style="padding:10px 8px;">
                <strong>${esc(t.name)}</strong>
                <div style="font-size:11px;color:#718096;">${esc(t.email || t.loginId)} · ${esc(t.teacherId || '')}</div>
              </td>
              <td style="padding:10px 8px;">${esc(t.department || '—')}</td>
              <td style="padding:10px 8px;">
                <span class="view-pill" style="background:${t.isAuthorized ? '#dcfce7;color:#166534' : '#f1f5f9;color:#64748b'}">
                  ${t.isAuthorized ? '✓ Authorized' : 'Standard'}
                </span>
              </td>
              <td style="padding:10px 8px;text-align:right;">
                <button type="button" class="secondary-button" data-toggle-perm="${t.id}" style="font-size:12px;padding:4px 10px;">
                  ${t.isAuthorized ? 'Revoke' : 'Authorize'}
                </button>
              </td>
            </tr>
          `).join('');

          $$('[data-toggle-perm]').forEach(btn => {
            btn.onclick = async () => {
              const id = Number(btn.getAttribute('data-toggle-perm'));
              const teacher = teachers.find(item => item.id === id);
              if (!teacher) return;
              btn.disabled = true;
              btn.textContent = 'Updating…';
              try {
                await api(`/api/admin/timetable/permissions/teachers/${id}`, {
                  method: 'POST',
                  body: JSON.stringify({ isAuthorized: !teacher.isAuthorized }),
                });
                teacher.isAuthorized = !teacher.isAuthorized;
                renderRows();
              } catch (err) {
                notify(err.message || 'Failed to update permission.', true);
                btn.disabled = false;
              }
            };
          });
        };

        renderRows();
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4" class="empty-row" style="color:#e53e3e">${esc(err.message || 'Failed to load permissions.')}</td></tr>`;
      }
    });

    $$('[data-permissions-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modal = $('[data-permissions-modal]');
        if (modal) modal.hidden = true;
        document.body.classList.remove('modal-open');
      });
    });

    // 10c. Change Logs Modal (Step 3)
    $('[data-open-logs]')?.addEventListener('click', async () => {
      const modal = $('[data-logs-modal]');
      const tbody = $('[data-logs-rows]');
      if (!modal || !tbody) return;
      modal.hidden = false;
      document.body.classList.add('modal-open');
      tbody.innerHTML = '<tr><td colspan="6" class="empty-row">Loading change logs…</td></tr>';

      try {
        const data = await api('/api/admin/timetable/change-logs');
        const logs = data.logs || [];
        if (!logs.length) {
          tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No rescheduling change logs recorded yet.</td></tr>';
          return;
        }

        tbody.innerHTML = logs.map(l => {
          const dateStr = new Date(l.createdAt).toLocaleString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
          });
          const prevStr = l.previousDay ? `${l.previousDay} ${l.previousStartTime || ''}–${l.previousEndTime || ''} (${l.previousSlot || ''}) · Rm ${l.previousRoom || ''}` : '—';
          const newStr = l.newDay ? `${l.newDay} ${l.newStartTime || ''}–${l.newEndTime || ''} (${l.newSlot || ''}) · Rm ${l.newRoom || ''}` : '—';
          const notifStr = l.notificationSent ? `✓ Sent (${l.notificationRecipientCount})` : (l.notificationError ? `⚠ Skipped (${l.notificationRecipientCount})` : 'Pending');

          return `
            <tr style="border-bottom:1px solid #edf2f7;">
              <td style="padding:8px;white-space:nowrap;">${esc(dateStr)}</td>
              <td style="padding:8px;">
                <strong>${esc(l.subjectName || '')}</strong>
                <div style="font-size:11px;color:#718096;">${esc(l.sectionName || '')}</div>
                ${l.reason ? `<div style="font-size:11px;color:#d97706;font-style:italic;">Reason: ${esc(l.reason)}</div>` : ''}
              </td>
              <td style="padding:8px;font-size:11px;color:#64748b;background:#fef2f2;">${esc(prevStr)}</td>
              <td style="padding:8px;font-size:11px;color:#15803d;background:#f0fdf4;"><strong>${esc(newStr)}</strong></td>
              <td style="padding:8px;">${esc(l.changedByName)} <small>(${esc(l.changedByRole)})</small></td>
              <td style="padding:8px;font-size:11px;">${esc(notifStr)}</td>
            </tr>
          `;
        }).join('');
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-row" style="color:#e53e3e">${esc(err.message || 'Failed to load change logs.')}</td></tr>`;
      }
    });

    $$('[data-logs-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modal = $('[data-logs-modal]');
        if (modal) modal.hidden = true;
        document.body.classList.remove('modal-open');
      });
    });

    // 11. Pagination
    $('[data-prev]')?.addEventListener('click', () => {
      if (state.page > 1) {
        state.page -= 1;
        loadTimetable();
      }
    });

    $('[data-next]')?.addEventListener('click', () => {
      if (state.page < state.totalPages) {
        state.page += 1;
        loadTimetable();
      }
    });

    // 12. Overlay backdrop clicks
    $('[data-editor]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeEditor();
    });
    $('[data-confirm]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeConfirm();
    });

    // 13. Escape key to close modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('[data-confirm]')?.hidden) closeConfirm();
        else if (!$('[data-editor]')?.hidden) closeEditor();
      }
    });

    // 14. Initial Data Load
    loadOptions()
      .then(() => loadTimetable())
      .catch((err) => {
        notify(err.message || 'Error initializing timetable data.', true);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
