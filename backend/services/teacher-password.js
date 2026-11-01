const { randomInt } = require('node:crypto');

function generateTeacherTemporaryPassword(email) {
  const prefix = Array.from(String(email)).slice(0, 4).join('').padEnd(4, '0');
  return `${prefix}${String(randomInt(0, 10000)).padStart(4, '0')}`;
}

function teacherIdFromUserId(userId) {
  return `TCH-${String(userId).padStart(4, '0')}`;
}

module.exports = { generateTeacherTemporaryPassword, teacherIdFromUserId };
