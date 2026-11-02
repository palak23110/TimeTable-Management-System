'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const pool = require('./pool');

async function migrate() {
  const [columns] = await pool.execute(`SELECT column_name AS name FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'teacher_profiles' AND column_name = 'invitation_setup_required'`);
  if (!columns.length) await pool.execute('ALTER TABLE teacher_profiles ADD COLUMN invitation_setup_required BOOLEAN NOT NULL DEFAULT FALSE AFTER invitation_pending');
  await pool.execute(`UPDATE teacher_profiles p JOIN users u ON u.id = p.user_id
    SET p.invitation_setup_required = TRUE
    WHERE p.invitation_pending = TRUE AND u.must_change_password = TRUE`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS user_invitation_tokens (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    token_hash CHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL,
    accepted_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_user_invitation_token_hash (token_hash),
    KEY ix_user_invitation_tokens_user (user_id, accepted_at, expires_at),
    CONSTRAINT fk_user_invitation_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  const [tokenColumns] = await pool.execute(`SELECT column_name AS name FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'user_invitation_tokens' AND column_name = 'rejected_at'`);
  if (!tokenColumns.length) await pool.execute('ALTER TABLE user_invitation_tokens ADD COLUMN rejected_at DATETIME NULL AFTER accepted_at');
  console.log('User invitation token table is ready. Existing users and sessions were not changed.');
}

migrate().catch((error) => {
  console.error(`User invitation migration failed (${error.code || 'database error'}).`);
  process.exitCode = 1;
}).finally(() => pool.end());
