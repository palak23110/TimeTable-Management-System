const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const nodemailer = require('nodemailer');

function createSmtpTransporter() {
  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASSWORD,
    SMTP_FROM,
    APP_BASE_URL,
  } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASSWORD || !SMTP_FROM || !APP_BASE_URL) {
    throw new Error('SMTP is not configured');
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASSWORD,
    },
  });

  return { transporter, from: SMTP_FROM, appBaseUrl: APP_BASE_URL.replace(/\/$/, '') };
}

async function sendPasswordResetEmail(email, token) {
  const { transporter, from, appBaseUrl } = createSmtpTransporter();
  const link = `${appBaseUrl}/reset-password?token=${encodeURIComponent(token)}`;

  await transporter.sendMail({
    from,
    to: email,
    subject: 'Reset your BMU TTMS password',
    text: [
      'Use this link to reset your BMU TTMS password.',
      'The link expires in 30 minutes.',
      '',
      link,
      '',
      'If you did not request this, ignore this email.',
    ].join('\n'),
    html: `
      <p>Use this link to reset your BMU TTMS password.</p>
      <p>The link expires in 30 minutes.</p>
      <p><a href="${escapeHtml(link)}">Reset password</a></p>
      <p>If you did not request this, ignore this email.</p>
    `,
  });
}

async function sendTeacherInvitationEmail({ email, name, teacherId, invitationToken, temporaryPassword }) {
  const { transporter, from, appBaseUrl } = createSmtpTransporter();
  const invitationUrl = `${appBaseUrl}/accept-invitation?token=${encodeURIComponent(invitationToken)}`;
  const safeName = escapeHtml(name);
  const safeTeacherId = escapeHtml(teacherId);
  const safeEmail = escapeHtml(email);
  const safeTemporaryPassword = escapeHtml(temporaryPassword);
  const safeInvitationUrl = escapeHtml(invitationUrl);

  await transporter.sendMail({
    from,
    to: email,
    subject: 'Your BMU TTMS teacher account',
    text: [
      `Hello ${name},`,
      '',
      'Your teacher account for the BMU Timetable Management System has been created.',
      `Teacher ID: ${teacherId}`,
      `Login ID: ${email}`,
      `Temporary password: ${temporaryPassword}`,
      'Accept this invitation before signing in:',
      invitationUrl,
      'The link expires in 24 hours and can only be used once.',
      '',
      'BMU Timetable Management System',
    ].join('\n'),
    html: `
      <div style="margin:0;background:#f3f5fa;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;color:#25324d">
        <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e0e5ef;border-radius:12px;overflow:hidden">
          <div style="background:#18233f;padding:24px 30px;color:#ffffff">
            <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#c8c2f4">BMU</div>
            <div style="margin-top:6px;font-size:20px;font-weight:700">Timetable Management System</div>
          </div>
          <div style="padding:30px">
            <p style="margin:0 0 16px">Hello ${safeName},</p>
            <p style="margin:0 0 20px;line-height:1.6">Your teacher account has been created. First accept the invitation, then sign in with the credentials below.</p>
            <div style="padding:18px;background:#f7f7fc;border:1px solid #e7e3fb;border-radius:8px;line-height:1.8">
              <div><strong>Teacher ID:</strong> ${safeTeacherId}</div>
              <div><strong>Login ID:</strong> ${safeEmail}</div>
              <div><strong>Temporary password:</strong> ${safeTemporaryPassword}</div>
            </div>
            <p style="margin:22px 0">
              <a href="${safeInvitationUrl}" style="display:inline-block;padding:12px 20px;border-radius:7px;background:#273553;color:#ffffff;text-decoration:none;font-weight:700">Review invitation</a>
            </p>
            <p style="margin:0;line-height:1.6">After you accept, sign in using the login ID and temporary password above. This invitation expires in 24 hours and can only be accepted once.</p>
          </div>
          <div style="padding:16px 30px;background:#fafbfe;border-top:1px solid #e8ebf2;color:#7b879d;font-size:12px">BMU Timetable Management System</div>
        </div>
      </div>
    `,
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

module.exports = {
  createSmtpTransporter,
  escapeHtml,
  sendPasswordResetEmail,
  sendTeacherInvitationEmail,
};
