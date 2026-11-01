const nameElements = document.querySelectorAll('[data-user-name]');
const roleElements = document.querySelectorAll('[data-user-role]');
const loginElements = document.querySelectorAll('[data-user-login]');
const initialsElements = document.querySelectorAll('[data-user-initials]');
const errorElement = document.querySelector('[data-dashboard-error]');

function initialsFor(name) {
  const displayName = name.replace(/^(dr\.?|prof\.?|mr\.?|mrs\.?|ms\.?)\s+/i, '').trim();
  return displayName.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
}

fetch('/api/auth/me').then(async response => {
  if (!response.ok) throw new Error('Your session expired. Please sign in again.');
  const { user } = await response.json();
  nameElements.forEach(element => { element.textContent = user.name; });
  roleElements.forEach(element => { element.textContent = user.role; });
  loginElements.forEach(element => { element.textContent = user.loginId; });
  initialsElements.forEach(element => { element.textContent = initialsFor(user.name); });
}).catch(error => {
  if (errorElement) errorElement.textContent = error.message;
});

const logoutButton = document.querySelector('[data-logout]');
if (logoutButton) logoutButton.addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    const data = await response.json();
    location.assign(data.redirectTo || '/login');
  } catch {
    button.disabled = false;
    if (errorElement) errorElement.textContent = 'Could not log out. Please try again.';
  }
});

const sidebar = document.querySelector('#admin-sidebar');
const scrim = document.querySelector('[data-sidebar-close]');
const toggleButton = document.querySelector('[data-sidebar-toggle]');
function closeSidebar() {
  sidebar?.classList.remove('open');
  scrim?.classList.remove('open');
  toggleButton?.setAttribute('aria-expanded', 'false');
}
toggleButton?.addEventListener('click', () => {
  const open = sidebar?.classList.toggle('open') ?? false;
  scrim?.classList.toggle('open', open);
  toggleButton.setAttribute('aria-expanded', String(open));
});
scrim?.addEventListener('click', closeSidebar);
