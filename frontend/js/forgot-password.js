const form = document.querySelector('#forgot-form');
const message = document.querySelector('#forgot-message');
const button = form.querySelector('button[type="submit"]');
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  button.disabled = true; button.textContent = 'Sending…'; message.textContent = '';
  try {
    const response = await fetch('/api/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: form.elements.email.value }) });
    const data = await response.json();
    message.textContent = data.message || 'If an account matches that email, a reset link will be sent shortly.';
    message.classList.add('success');
    message.setAttribute('role', 'status');
  } catch {
    message.textContent = 'If an account matches that email, a reset link will be sent shortly.';
    message.classList.add('success'); message.setAttribute('role', 'status');
  } finally { button.disabled = false; button.textContent = 'Send reset link'; }
});
