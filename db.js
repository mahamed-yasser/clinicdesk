'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');

function open(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');   // wait for another process instead of failing at once
  db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS services(id INTEGER PRIMARY KEY, name TEXT NOT NULL, minutes INTEGER NOT NULL CHECK(minutes>0 AND minutes<=480), price REAL NOT NULL CHECK(price>=0), active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS staff(id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS staff_hours(staff_id INTEGER NOT NULL REFERENCES staff(id), weekday INTEGER NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, PRIMARY KEY(staff_id,weekday));
  CREATE TABLE IF NOT EXISTS time_off(id INTEGER PRIMARY KEY, staff_id INTEGER NOT NULL REFERENCES staff(id), day TEXT NOT NULL, note TEXT);
  CREATE TABLE IF NOT EXISTS appointments(
    id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL,
    service_id INTEGER NOT NULL REFERENCES services(id), staff_id INTEGER NOT NULL REFERENCES staff(id),
    customer TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, notes TEXT,
    day TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'booked' CHECK(status IN('booked','completed','cancelled','no_show')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS idx_appt_day ON appointments(staff_id, day);
  CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
  `);
  migrate(db);
  const tz = process.env.CLINIC_TZ || 'Africa/Cairo';
  new Intl.DateTimeFormat('en', { timeZone: tz }); // throws on an invalid zone
  if (!db.prepare("SELECT 1 FROM settings WHERE key='tz'").get()) db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('tz',?)").run(tz);   // no write (and no lock) on later starts
  return db;
}

// Versioned migrations (PRAGMA user_version). Each step runs in a transaction; a failing step rolls back and the version does not move.
const BUSY = "('booked','completed','no_show')";
const MIGRATIONS = [
  // 1: roles, audit log, database-level overlap protection
  `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN('owner','reception'));
   CREATE TABLE audit_log(id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, username TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT);
   CREATE TRIGGER appt_no_overlap_ins BEFORE INSERT ON appointments WHEN NEW.status IN ${BUSY}
   BEGIN SELECT RAISE(ABORT,'overlap') WHERE EXISTS(SELECT 1 FROM appointments o WHERE o.staff_id=NEW.staff_id AND o.day=NEW.day AND o.status IN ${BUSY} AND NEW.start_min<o.end_min AND NEW.end_min>o.start_min); END;
   CREATE TRIGGER appt_no_overlap_upd BEFORE UPDATE ON appointments WHEN NEW.status IN ${BUSY}
   BEGIN SELECT RAISE(ABORT,'overlap') WHERE EXISTS(SELECT 1 FROM appointments o WHERE o.id<>NEW.id AND o.staff_id=NEW.staff_id AND o.day=NEW.day AND o.status IN ${BUSY} AND NEW.start_min<o.end_min AND NEW.end_min>o.start_min); END;`,
  // 2: the database refuses nonsense appointment times even from raw SQL
  `CREATE TRIGGER appt_sane_times_ins BEFORE INSERT ON appointments
   BEGIN SELECT RAISE(ABORT,'bad times') WHERE NEW.start_min<0 OR NEW.end_min>1440 OR NEW.end_min<=NEW.start_min; END;
   CREATE TRIGGER appt_sane_times_upd BEFORE UPDATE ON appointments
   BEGIN SELECT RAISE(ABORT,'bad times') WHERE NEW.start_min<0 OR NEW.end_min>1440 OR NEW.end_min<=NEW.start_min; END;`,
];
function migrate(db) {
  let v = db.prepare('PRAGMA user_version').get().user_version;
  if (v > MIGRATIONS.length) throw new Error('Database is from a newer version of ClinicDesk (schema ' + v + '); refusing to open it');
  for (; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[v]); db.exec('PRAGMA user_version=' + (v + 1)); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}
function audit(db, username, action, target, detail) {
  db.prepare('INSERT INTO audit_log(username,action,target,detail) VALUES(?,?,?,?)').run(username, action, target == null ? null : String(target), detail == null ? null : String(detail).slice(0, 300));
}
// Consistent copy of a live database. The copy is opened and checked before it is reported as good.
function backup(db, file) {
  if (fs.existsSync(file)) throw new Error('Refusing to overwrite ' + file);
  db.prepare('VACUUM INTO ?').run(file);
  return verify(file);
}
function verify(file) {
  let d; try { d = new DatabaseSync(file, { readOnly: true }); } catch (e) { return { ok: false, problems: ['cannot open: ' + e.message] }; }
  try {
    const problems = [];
    const ic = d.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check); if (ic.join() !== 'ok') problems.push('integrity_check: ' + ic.slice(0, 3).join('; '));
    const fk = d.prepare('PRAGMA foreign_key_check').all(); if (fk.length) problems.push(fk.length + ' foreign key violation(s)');
    const have = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    for (const t of ['appointments', 'services', 'staff', 'users', 'settings']) if (!have.has(t)) problems.push('missing table ' + t);
    const version = d.prepare('PRAGMA user_version').get().user_version;
    if (version > MIGRATIONS.length) problems.push('newer schema ' + version);
    return { ok: !problems.length, problems, version };
  } catch (e) { return { ok: false, problems: [e.message] }; } finally { d.close(); }
}
// Restore = replace TARGET with a verified backup. Server must be stopped. The existing database is never lost:
// the backup is verified first, the restored copy is built beside the target and verified, and the old file is kept as TARGET.before-restore-<time>.
function restore(backupFile, target) {
  const v = verify(backupFile);
  if (!v.ok) throw new Error('Backup is not usable: ' + v.problems.join('; '));
  if (!fs.existsSync(backupFile)) throw new Error('Backup not found');
  for (const ext of ['-wal', '-shm', '-journal']) if (fs.existsSync(target + ext)) throw new Error('The database looks in use (' + target + ext + ' exists). Stop the server first; nothing was changed.');
  const tmp = target + '.restoring-' + process.pid;
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  try {
    fs.copyFileSync(backupFile, tmp);
    const v2 = verify(tmp); if (!v2.ok) throw new Error('Restored copy failed verification: ' + v2.problems.join('; '));
    let kept = null;
    if (fs.existsSync(target)) { kept = target + '.before-restore-' + Date.now(); fs.renameSync(target, kept); }
    fs.renameSync(tmp, target);
    return { ok: true, kept, version: v2.version };
  } catch (e) { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); throw e; }
}
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}
function createUser(db, username, pw, role = 'owner') {
  if (!['owner', 'reception'].includes(role)) throw new Error('Unknown role');
  if (typeof pw !== 'string' || pw.length < 10) throw new Error('Password must be at least 10 characters');
  const { salt, hash } = hashPassword(pw);
  db.prepare('INSERT INTO users(username,salt,hash,role) VALUES(?,?,?,?)').run(username, salt, hash, role);
}
function login(db, username, pw) {
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u) return null;
  const h = crypto.scryptSync(pw, u.salt, 32);
  if (!crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'))) return null;
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(token, u.id, Date.now() + 8 * 3600e3);
  return token;
}
function sessionUser(db, token) {
  if (!token) return null;
  return db.prepare('SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(token, Date.now()) || null;
}
function logout(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
const needsSetup = db => !db.prepare('SELECT 1 FROM users').get();
module.exports = { audit, backup, restore, verify, migrate, MIGRATIONS, needsSetup, open, createUser, login, logout, sessionUser };
