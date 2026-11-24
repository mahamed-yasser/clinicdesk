'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

function open(file = ':memory:') {
  const db = new DatabaseSync(file);
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
  const tz = process.env.CLINIC_TZ || 'Africa/Cairo';
  new Intl.DateTimeFormat('en', { timeZone: tz }); // throws on an invalid zone
  db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('tz',?)").run(tz);
  return db;
}

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}
function createUser(db, username, pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new Error('Password must be at least 10 characters');
  const { salt, hash } = hashPassword(pw);
  db.prepare('INSERT INTO users(username,salt,hash) VALUES(?,?,?)').run(username, salt, hash);
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
  return db.prepare('SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(token, Date.now()) || null;
}
const needsSetup = db => !db.prepare('SELECT 1 FROM users').get();
module.exports = { needsSetup, open, createUser, login, sessionUser };
