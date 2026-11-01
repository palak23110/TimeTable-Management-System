'use strict';

const pool = require('../database/pool');
const { createSmtpTransporter, escapeHtml } = require('./mail');

/**
 * Sends timetable reschedule notifications to the assigned teacher and enrolled students.
 * Crucially executed AFTER the database transaction commits.
 * Any delivery failure is caught and logged, never rolling back the timetable change.
 */
async function sendTimetableRescheduleNotification({
  changeLogId,
  entryId,
  sectionId,
  subjectName,
  subjectCode,
  previousDetails,
  newDetails,
  reason,
  rescheduledBy,
}) {
  const result = {
    sent: false,
    recipientCount: 0,
    recipients: [],
    error: null,
  };

  try {
    // 1. Gather recipients:
    // a) The assigned teacher
    const [teachers] = await pool.execute(
      `SELECT u.email, u.name 
       FROM timetable_entries t 
       JOIN users u ON t.teacher_user_id = u.id 
       WHERE t.id = ?`,
      [entryId]
    );

    // b) All students in the affected section (both linked accounts and registered profile emails)
    const [students] = await pool.execute(
      `SELECT 
         COALESCE(u.email, sp.email) AS email, 
         COALESCE(u.name, sp.name) AS name 
       FROM student_profiles sp
       LEFT JOIN users u ON u.id = sp.user_id 
       WHERE sp.section_id = ? 
         AND ((u.email IS NOT NULL AND u.email != '') OR (sp.email IS NOT NULL AND sp.email != ''))`,
      [sectionId]
    );

    const recipientMap = new Map();
    if (teachers[0]?.email) {
      recipientMap.set(teachers[0].email.toLowerCase().trim(), {
        email: teachers[0].email,
        name: teachers[0].name || 'Faculty Member',
        role: 'teacher',
      });
    }

    for (const student of students) {
      if (student.email) {
        const emailKey = student.email.toLowerCase().trim();
        if (!recipientMap.has(emailKey)) {
          recipientMap.set(emailKey, {
            email: student.email,
            name: student.name || 'Student',
            role: 'student',
          });
        }
      }
    }

    const recipients = Array.from(recipientMap.values());
    result.recipientCount = recipients.length;
    result.recipients = recipients.map(r => r.email);

    if (recipients.length === 0) {
      result.sent = true;
      if (changeLogId) {
        await pool.execute(
          'UPDATE timetable_change_logs SET notification_sent = 1, notification_recipient_count = 0 WHERE id = ?',
          [changeLogId]
        );
      }
      return result;
    }

    // 2. Try sending emails via Nodemailer
    let transporter;
    let from;
    let appBaseUrl;

    try {
      const smtp = createSmtpTransporter();
      transporter = smtp.transporter;
      from = smtp.from;
      appBaseUrl = smtp.appBaseUrl;
    } catch (smtpConfigError) {
      // SMTP not configured in environment
      result.error = `SMTP configuration unavailable: ${smtpConfigError.message}`;
      console.warn(`[Timetable Notification] Email skipped: ${result.error}`);
      if (changeLogId) {
        await pool.execute(
          'UPDATE timetable_change_logs SET notification_sent = 0, notification_recipient_count = ?, notification_error = ? WHERE id = ?',
          [result.recipientCount, result.error, changeLogId]
        );
      }
      return result;
    }

    const emailSubject = `[BMU TTMS] Schedule Update: ${subjectName} (${subjectCode})`;
    const emailText = [
      'Notice of Timetable Rescheduling',
      '=================================',
      `Subject: ${subjectName} (${subjectCode})`,
      `Class/Section: ${newDetails.sectionName || previousDetails.sectionName || ''}`,
      `Rescheduled By: ${rescheduledBy.name} (${rescheduledBy.role})`,
      reason ? `Reason: ${reason}` : '',
      '',
      'PREVIOUS SCHEDULE:',
      `Day: ${previousDetails.dayLabel || 'N/A'}`,
      `Time: ${previousDetails.startTime || ''} - ${previousDetails.endTime || ''} (${previousDetails.slotCode || ''})`,
      `Room: ${previousDetails.roomName || 'N/A'}`,
      '',
      'NEW UPDATED SCHEDULE:',
      `Day: ${newDetails.dayLabel || 'N/A'}`,
      `Time: ${newDetails.startTime || ''} - ${newDetails.endTime || ''} (${newDetails.slotCode || ''})`,
      `Room: ${newDetails.roomName || 'N/A'}`,
      '',
      `View your updated schedule at: ${appBaseUrl}`,
      '',
      'BMU Timetable Management System',
    ].filter(Boolean).join('\n');

    const emailHtml = `
      <div style="margin:0;background:#f3f5fa;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;color:#25324d">
        <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e0e5ef;border-radius:12px;overflow:hidden">
          <div style="background:#18233f;padding:24px 30px;color:#ffffff">
            <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#c8c2f4">BMU TTMS Alert</div>
            <div style="margin-top:6px;font-size:20px;font-weight:700">Class Rescheduling Notification</div>
          </div>
          <div style="padding:28px 30px">
            <h3 style="margin-top:0;color:#18233f">${escapeHtml(subjectName)} (${escapeHtml(subjectCode)})</h3>
            <p style="margin:0 0 16px;line-height:1.5;color:#4f5d75">
              The schedule for <strong>${escapeHtml(subjectName)}</strong> has been updated by <strong>${escapeHtml(rescheduledBy.name)}</strong>.
            </p>
            ${reason ? `<div style="background:#fff9eb;border-left:4px solid #f59e0b;padding:10px 14px;margin-bottom:18px;border-radius:4px;font-size:14px;color:#92400e"><strong>Reason:</strong> ${escapeHtml(reason)}</div>` : ''}
            
            <table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px">
              <thead>
                <tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;text-align:left">
                  <th style="padding:10px">Schedule</th>
                  <th style="padding:10px">Day</th>
                  <th style="padding:10px">Time Slot</th>
                  <th style="padding:10px">Room</th>
                </tr>
              </thead>
              <tbody>
                <tr style="border-bottom:1px solid #e2e8f0;color:#64748b;background:#fff5f5">
                  <td style="padding:10px"><strong>Previous</strong></td>
                  <td style="padding:10px">${escapeHtml(previousDetails.dayLabel || '—')}</td>
                  <td style="padding:10px">${escapeHtml(previousDetails.startTime || '')} - ${escapeHtml(previousDetails.endTime || '')} (${escapeHtml(previousDetails.slotCode || '')})</td>
                  <td style="padding:10px">${escapeHtml(previousDetails.roomName || '—')}</td>
                </tr>
                <tr style="border-bottom:1px solid #e2e8f0;color:#0f766e;background:#f0fdf4">
                  <td style="padding:10px"><strong>Updated</strong></td>
                  <td style="padding:10px"><strong>${escapeHtml(newDetails.dayLabel || '—')}</strong></td>
                  <td style="padding:10px"><strong>${escapeHtml(newDetails.startTime || '')} - ${escapeHtml(newDetails.endTime || '')} (${escapeHtml(newDetails.slotCode || '')})</strong></td>
                  <td style="padding:10px"><strong>${escapeHtml(newDetails.roomName || '—')}</strong></td>
                </tr>
              </tbody>
            </table>

            <p style="margin:24px 0 0">
              <a href="${escapeHtml(appBaseUrl)}" style="display:inline-block;padding:12px 22px;border-radius:6px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700">View Updated Timetable</a>
            </p>
          </div>
          <div style="padding:16px 30px;background:#fafbfe;border-top:1px solid #e8ebf2;color:#7b879d;font-size:12px">
            BMU Timetable Management System · Automated notification
          </div>
        </div>
      </div>
    `;

    // Deliver to all recipients
    for (const recipient of recipients) {
      try {
        await transporter.sendMail({
          from,
          to: recipient.email,
          subject: emailSubject,
          text: emailText,
          html: emailHtml,
        });
      } catch (sendErr) {
        console.warn(`[Timetable Notification] Failed to send email to ${recipient.email}: ${sendErr.message}`);
      }
    }

    result.sent = true;
    if (changeLogId) {
      await pool.execute(
        'UPDATE timetable_change_logs SET notification_sent = 1, notification_recipient_count = ? WHERE id = ?',
        [result.recipientCount, changeLogId]
      );
    }
  } catch (err) {
    result.error = err.message;
    console.error('[Timetable Notification] Error during notification process:', err);
    if (changeLogId) {
      try {
        await pool.execute(
          'UPDATE timetable_change_logs SET notification_sent = 0, notification_error = ? WHERE id = ?',
          [err.message, changeLogId]
        );
      } catch (_) {}
    }
  }

  return result;
}

module.exports = {
  sendTimetableRescheduleNotification,
};

