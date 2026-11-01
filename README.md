# BMU TTMS authentication foundation

This project contains the BMU authentication flows, role-protected dashboard placeholders, and administrator-only teacher account management. The UI uses HTML, CSS, and browser-native JavaScript with an Express/MySQL backend. Password hashing uses `bcrypt`; sessions use `express-session` stored in MySQL; password reset and teacher invitation email use Nodemailer.

## Requirements

- Node.js 20 or newer
- MySQL 8 or compatible MySQL server
- SMTP account for password-reset and teacher-invitation email (optional; login works without it)

## 1. Install dependencies

From the project root:

```bash
npm install
```

## 2. Configure MySQL

Create a MySQL user/database as appropriate for your machine, then run the included schema. The schema creates `bmu_ttms` and its authentication, teacher-profile, subject-mapping, and session tables:

```bash
mysql -u root -p < database/schema.sql
```

If your MySQL user is not `root`, use your own administrative MySQL account for this command. The application account configured in `.env` must have select/insert/update/delete permissions on the created tables.

## 3. Configure environment variables

Copy `.env.example` to `.env` and set values for your environment:

```bash
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead. Configure `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`. Set `SESSION_SECRET` to a unique random string of at least 32 characters. For production, set `NODE_ENV=production`, serve the app over HTTPS, and keep `APP_BASE_URL` pointed at the public HTTPS URL. The session cookie is HttpOnly and SameSite=Lax, and Secure in production.

### SMTP email setup (optional)

Login and the dashboards work without SMTP. To enable password-reset and teacher-invitation delivery, set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM` in `.env` using the values supplied by your mail provider. Use port `587` for STARTTLS or port `465` for implicit TLS. `SMTP_FROM` should be an address or display-name address authorized by that provider, for example `BMU TTMS <no-reply@your-domain.example>`. Some providers require an app password or SMTP-specific credentials instead of your normal mailbox password. Keep all credentials in `.env`; do not commit them.

Also set `APP_BASE_URL` to the URL where users open the app. The emailed link uses this value and opens `/reset-password`. If SMTP values are absent or delivery fails, login remains available and the forgot-password page still returns the same generic response; the user will not receive a reset email until SMTP is configured. Delivery failures are logged with a generic message only, never the token or link. Password reset uses a 30-minute, single-use random token; only its SHA-256 hash is stored.

## 4. Create the initial administrator

Set `ADMIN_NAME`, `ADMIN_LOGIN_ID`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in `.env`. Choose a password of at least 8 characters. The seed command hashes the password with bcrypt and refuses to create a duplicate administrator:

```bash
npm run db:seed-admin
```

Do not share or commit `.env` or administrator credentials.

## 5. Run the app

```bash
npm run dev
```

Open <http://localhost:3000>. Use `npm start` to run without Node's watch mode. The server checks its MySQL connection at startup.

### Development test accounts

The local-only credentials are listed in `TEST_CREDENTIALS.md`, which is ignored by Git. On a development database only, standardize those existing accounts with `SEED_TEST_ACCOUNTS=true npm run db:seed-test-accounts` (PowerShell: `$env:SEED_TEST_ACCOUNTS='true'; npm run db:seed-test-accounts; Remove-Item Env:SEED_TEST_ACCOUNTS`). The script requires `NODE_ENV=development`, verifies all four IDs, roles, and active flags before changing anything, creates no users, and updates only `password_hash` using bcrypt hashes.

Run the role/login checks after seeding with `npm run test:auth-roles`. It verifies all three redirects, role protection, invalid and inactive login rejection, and logout.

Run `npm run test:teachers` to verify administrator access, input and duplicate validation, database-backed teacher lists and subject filters, bcrypt-12 temporary credentials, first-login password change, and login with the replacement password. The test uses a temporary email and mocks Nodemailer; it sends no email and cleans up its database records.

## Verify the password-reset flow

With the schema installed and `.env` pointing to a test database, run:

```bash
npm run test:tc05
```

This integration check creates a uniquely named temporary test user, exercises the real Express and MySQL routes/session store, and deletes that user afterward. It mocks the mail boundary, so it does not send an email. To verify SMTP delivery separately, configure SMTP and submit the forgot-password form for a mailbox you control; the reset request page intentionally uses the same response for registered and unregistered addresses.

## Routes

- `/login`, `/forgot-password`, `/reset-password`
- `/admin/dashboard`, `/admin/teachers`, `/teacher/dashboard`, `/student/dashboard`, `/change-password`
- `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`
- `GET /api/auth/me` returns the authenticated user's display name and verified role
- `/api/admin/teachers` provides protected listing, statistics, subject lookup, profile lookup, creation, and invitation resend APIs

Dashboard and teacher-management HTML/API routes validate sessions and roles on the server. Teacher and student accounts are redirected away from administrator pages. Teachers created by the teacher form must replace their temporary password on first login. Student management and timetable features are intentionally not included.

## Security and configuration notes

- Passwords are stored as bcrypt hashes, never plaintext.
- Reset tokens and session IDs are random and only their SHA-256 hashes are stored in MySQL.
- `express-session` stores session data server-side in the MySQL `sessions` table. Logout revokes the stored session; a successful password reset revokes the user's existing sessions.
- The session cookie is HttpOnly. In production the app must run behind HTTPS for the Secure cookie setting.
- Forgot-password requests always return the same public response to avoid revealing whether an email is registered. SMTP delivery errors are recorded without logging reset links or tokens.
- There is no public registration endpoint. Teacher creation is restricted to authenticated administrators.

## Existing database migration

For an existing database, apply the additive teacher-management migration before starting the updated app:

```bash
npm run db:migrate-teachers
```

It adds `users.must_change_password`, `teacher_profiles`, `subjects`, and `teacher_subjects`, and creates empty profile rows for existing teachers. No sample people, subjects, or timetable records are inserted. The migration widens `users.login_id` to 254 characters so email addresses can be used as teacher login IDs.

Administrators create teachers with a name, email, and contact number. The server derives the Teacher ID from the account ID, uses the email as login ID, and stores a bcrypt hash (12 rounds) for the temporary password. It uses the first four email characters followed by four cryptographically random digits; shorter addresses are padded. Nodemailer sends credentials when configured. Teachers must replace the temporary password with a different password of at least 8 characters before using their dashboard. If email delivery fails, the account remains in the database and the administrator sees a delivery-failed status. The administrator can use the row's **Resend invitation** action to generate a fresh temporary password and retry delivery. Temporary passwords are never returned by the API or logged.

The included schema is suitable for a fresh database. If you created the previous draft schema already, its `sessions` table needs a nullable `user_id` and a `session_data JSON` column before using this Express session store. Back up existing data before applying a migration.
