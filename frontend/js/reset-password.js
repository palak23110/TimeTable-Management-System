const form = document.querySelector('#reset-form');
const message = document.querySelector('#reset-message');
const button = form.querySelector('button[type="submit"]');
const token = new URLSearchParams(location.search).get('token') || '';
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  if (form.elements.password.value !== form.elements.confirmPassword.value) { message.textContent = 'The passwords do not match.'; return; }
  button.disabled = true; button.textContent = 'Updating…'; message.textContent = '';
  try {
    const response = await fetch('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: form.elements.password.value, confirmPassword: form.elements.confirmPassword.value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not reset your password.');
    location.assign('/login?reset=success');
  } catch (error) { message.textContent = error.message || 'Could not connect. Please try again.'; button.disabled = false; button.textContent = 'Set new password'; }
});
