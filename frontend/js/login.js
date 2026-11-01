const form = document.querySelector('#login-form');
const message = document.querySelector('#login-message');
const submitButton = form.querySelector('button[type="submit"]');

document.querySelector('[data-toggle-password]').addEventListener('click', event => {
  const input = form.elements.password;
  input.type = input.type === 'password' ? 'text' : 'password';
  event.currentTarget.textContent = input.type === 'password' ? 'Show' : 'Hide';
});

if (new URLSearchParams(location.search).get('reset') === 'success') {
  message.textContent = 'Password updated. Sign in with your new password.';
  message.classList.add('success');
  message.setAttribute('role', 'status');
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  message.textContent = '';
  if (!form.reportValidity()) return;
  submitButton.disabled = true;
  submitButton.textContent = 'Signing in…';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: form.elements.identifier.value, password: form.elements.password.value, remember: form.elements.remember.checked })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to sign in.');
    location.assign(data.redirectTo);
  } catch (error) {
    message.textContent = error.message || 'Could not connect. Please try again.';
    submitButton.disabled = false;
    submitButton.textContent = 'Sign in securely';
  }
});
