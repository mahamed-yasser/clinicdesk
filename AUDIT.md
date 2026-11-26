# ClinicDesk reliability layer: audit and changes (local branch local/reliability-layer, from fix-logout-session)

Fictional, non-clinical scheduling data only. Not deployed, not reviewed for real clinic use, no readiness claim.
This is an AI-assisted extension of existing code; it is not evidence of who wrote the original project.

Baseline (unmodified fix-logout-session, commit 18687ec): `npm test` 28 pass; docs/e2e.js real-Chrome flow passes.

## Bugs found by the audit (each has a test written first and failing on the baseline)
| # | Problem on baseline | Test | Fix |
|---|---|---|---|
| 1 | Admin "restore" (cancelled -> booked) ignored newer bookings: two active bookings in one slot | AUDIT 1 | restore re-checks the slot inside a transaction, 409 if taken |
| 3 | Reschedule looked the service up by NAME: two services with one name -> wrong length | AUDIT 3 | uses service_id |
| 4 | Any status could become any status (completed -> booked, etc.) | AUDIT 4 | explicit transition table |
| 5 | Only application code prevented overlaps | AUDIT 5 | database triggers refuse overlapping active bookings, even for raw SQL |
| 8 | Deactivating staff gave no sign of future bookings | AUDIT 8 | API returns futureBookings count (the admin UI does not show it yet) |
Passed on baseline (kept as regression tests): AUDIT 2 (free-slot restore), AUDIT 6 (two connections racing, 40 attempts, exactly 1 wins), AUDIT 7 (failed reschedule rolls back).

## New
- Roles: `owner` and `reception`. Reception: schedule, status changes, reschedule, clients, agenda. Owner only: stats, CSV export, services, staff, hours, time off, user creation, audit log. First-run user is owner. Existing users migrate to owner.
- Audit log of staff changes (who, what, target; no passwords or phone numbers stored in it).
- Versioned migrations (PRAGMA user_version); a database from a newer version is refused; upgrade of an old schema tested.
- `backup.js`: VACUUM INTO copy, integrity_check + foreign_key_check + table check; refuses to overwrite; detects truncated and junk files.

## Not done / limits
- The admin web UI was not updated for roles (a reception user sees errors on owner-only tabs) or for the futureBookings warning; only the API is covered by tests. docs/e2e.js (owner flow) still passes.
- No restore command: restoring is a manual file replace after `verify`. No automatic scheduled backups.
- Audit log has no tamper protection (an owner with file access can edit the database). No retention/delete/export of client phone numbers yet. No strict CSV import. No accessibility pass.
- Single process, SQLite; race test uses two connections in one process, not separate OS processes under load.

## Round 2 (after independent review of the first revision, tag local/reliability-v1)
Fixed, each with a test in test/reliability.test.js (R2-1 to R2-8):
- Restore re-validates against today's rules: day off added later, narrowed hours, inactive service, inactive staff. Policy: a booking in the past cannot be restored (make a new booking). Reschedule now refuses inactive staff.
- Database refuses zero/negative/out-of-day appointment times from raw SQL (migration 2, triggers).
- Reception could not use the schedule in the web UI because it fetched owner-only stats. The admin page is now role-aware: reception sees Schedule, Next 7 days, Clients only, no stats, no export link, no Services/Staff tabs; owner sees all. Checked in real Chrome with both roles (docs/e2e-roles.js, screenshots docs/roles-reception-schedule.png and docs/roles-owner-schedule.png). The staff deactivate button now shows a warning when upcoming bookings remain.
- `node backup.js restore BACKUP TARGET`: verifies the backup, builds and verifies a copy next to the target, keeps the old file as TARGET.before-restore-<time>, refuses if the database looks in use (journal/WAL file present) or if the backup is invalid; the existing database is unchanged on any failure (tested with a truncated backup, a missing backup and an in-use marker).
- Same-status updates no longer write audit entries. busy_timeout 5 s, no startup write when the time zone is already set, a lock error returns 503 instead of a raw 500. Three OS processes racing for one slot: exactly one booking, no raw lock error (test).
Deployment constraints (not promises): one SQLite file, designed for a single server process on one machine; restore needs the server stopped; passwords/roles are a two-role model, no password reset flow; audit log is not tamper-proof; fictional data only; no readiness claim.
Still not done: no web UI for backup/restore (command line only), no retention/export/delete of phone numbers, no CSV import, no accessibility pass, README test count corrected to 48.

## Known limitation (review round 3)
Restore guard is a marker-file check and misses an idle running server (stale reads, 500 read-only errors, a write into the renamed pre-restore backup were reproduced). Stop the server before restore, restart after. Docs-only change after review: README.md and this file; code unchanged from reviewed commit 5aa7325.
