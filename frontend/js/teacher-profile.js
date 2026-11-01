(() => {
  const form = document.querySelector('[data-profile-form]');
  const message = document.querySelector('[data-profile-message]');
  const actions = document.querySelector('[data-profile-actions]');
  const editButton = document.querySelector('[data-edit-profile]');
  const cancelButton = document.querySelector('[data-cancel-profile]');
  const saveButton = document.querySelector('[data-save-profile]');
  const fields = [...document.querySelectorAll('[data-profile-field]')];
  let profile = null;
  let initialValues = {};
  let editing = false;

  function initialsFor(name) {
    return String(name || '')
      .replace(/^(dr\.?|prof\.?|mr\.?|mrs\.?|ms\.?)\s+/i, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase() || '—';
  }

  function setMessage(text, type = '') {
    message.textContent = text;
    message.className = `profile-message${type ? ` ${type}` : ''}`;
  }

  function fieldValues() {
    return Object.fromEntries(fields.map((field) => [field.name, field.value]));
  }

  function setEditing(value) {
    editing = value;
    fields.forEach((field) => { field.readOnly = !value; });
    actions.hidden = !value;
    editButton.hidden = value;
    if (value) form.elements.name.focus();
  }

  function displayProfile(nextProfile) {
    profile = nextProfile;
    for (const field of fields) {
      const value = profile[field.name];
      field.value = value === null || value === undefined ? '' : String(value);
    }
    document.querySelectorAll('[data-profile-value]').forEach((field) => {
      const key = field.dataset.profileValue;
      const value = key === 'status'
        ? (Number(profile.isActive) ? 'Active' : 'Inactive')
        : profile[key];
      field.value = value === null || value === undefined || value === '' ? 'Not provided' : String(value);
    });

    const initials = initialsFor(profile.name);
    document.querySelectorAll('[data-profile-initials]').forEach((element) => { element.textContent = initials; });
    document.querySelector('[data-profile-name]').textContent = profile.name || 'Name not provided';
    document.querySelector('[data-profile-email]').textContent = profile.email || 'Email not provided';
    document.querySelectorAll('[data-profile-teacher-id]').forEach((element) => {
      element.textContent = profile.teacherId || 'Teacher ID not provided';
    });
    document.querySelector('[data-profile-id-top]').textContent = profile.teacherId || 'Teacher ID unavailable';
    const status = document.querySelector('[data-account-status]');
    status.textContent = Number(profile.isActive) ? 'Active account' : 'Inactive account';
    status.classList.toggle('inactive', !Number(profile.isActive));

    const updated = profile.updatedAt ? new Date(profile.updatedAt) : null;
    const editorLabel = profile.updatedByName
      ? `Last updated by ${profile.updatedByName}`
      : 'Profile update time';
    document.querySelector('[data-profile-updated]').textContent = updated && !Number.isNaN(updated.valueOf())
      ? `${editorLabel} · ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(updated)}`
      : 'No profile edits recorded yet';
    initialValues = fieldValues();
    setEditing(false);
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
    return data;
  }

  async function loadProfile() {
    try {
      const data = await request('/api/teacher/profile');
      if (!data.profile) throw new Error('The server returned an incomplete profile.');
      displayProfile(data.profile);
      setMessage('');
    } catch (error) {
      setMessage(error.message || 'Could not load your profile.', 'error');
    }
  }

  function cancelEditing() {
    fields.forEach((field) => { field.value = initialValues[field.name] ?? ''; });
    setMessage('Changes discarded.');
    setEditing(false);
  }

  editButton.addEventListener('click', () => {
    initialValues = fieldValues();
    setMessage('');
    setEditing(true);
  });
  cancelButton.addEventListener('click', cancelEditing);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && editing) cancelEditing();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const changes = Object.fromEntries(
      Object.entries(fieldValues()).filter(([key, value]) => initialValues[key] !== value),
    );
    if (!Object.keys(changes).length) {
      setMessage('There are no changes to save.', 'error');
      return;
    }

    saveButton.disabled = true;
    setMessage('Saving your profile…');
    try {
      const data = await request('/api/teacher/profile', {
        method: 'PATCH',
        body: JSON.stringify(changes),
      });
      displayProfile(data.profile);
      setMessage(data.message || 'Profile updated successfully.', 'success');
    } catch (error) {
      setMessage(error.message || 'Could not save your profile.', 'error');
    } finally {
      saveButton.disabled = false;
    }
  });

  loadProfile();
})();
