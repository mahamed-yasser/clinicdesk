'use strict';
const crypto = require('node:crypto');

const STEP = 30;
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fmt = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const weekday = day => new Date(day + 'T00:00:00Z').getUTCDay();
const validDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;

const tzOf = db => (db.prepare("SELECT value FROM settings WHERE key='tz'").get() || { value: 'UTC' }).value;
// "now" as clinic wall-clock time: all days and times in this app are in the clinic's single time zone.
function clinicNow(db, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tzOf(db), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(now).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, min: +parts.hour * 60 + +parts.minute };
}
class BookingError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

function staffSlots(db, staffId, day, minutes, nowMin = null) {
  const hours = db.prepare('SELECT start,end FROM staff_hours WHERE staff_id=? AND weekday=?').get(staffId, weekday(day));
  if (!hours) return [];
  if (db.prepare('SELECT 1 FROM time_off WHERE staff_id=? AND day=?').get(staffId, day)) return [];
  const busy = db.prepare("SELECT start_min s,end_min e FROM appointments WHERE staff_id=? AND day=? AND status IN('booked','completed','no_show')").all(staffId, day);
  const out = [];
  for (let s = toMin(hours.start); s + minutes <= toMin(hours.end); s += STEP) {
    if (nowMin !== null && s <= nowMin) continue;
    if (busy.some(b => s < b.e && s + minutes > b.s)) continue;
    out.push(s);
  }
  return out;
}

function availableSlots(db, { day, serviceId, staffId, now = new Date() }) {
  if (!validDay(day)) throw new BookingError('Invalid date');
  const svc = db.prepare('SELECT * FROM services WHERE id=?').get(serviceId);
  if (!svc) throw new BookingError('Unknown service', 404);
  if (!svc.active) throw new BookingError('Service is not available', 404);
  const cn = clinicNow(db, now), today = cn.day;
  if (day < today) return [];
  const nowMin = day === today ? cn.min : null;
  const staff = staffId ? db.prepare('SELECT id,name FROM staff WHERE id=? AND active=1').all(staffId)
                        : db.prepare('SELECT id,name FROM staff WHERE active=1').all();
  const slots = new Map();
  for (const st of staff) for (const s of staffSlots(db, st.id, day, svc.minutes, nowMin)) {
    if (!slots.has(s)) slots.set(s, []);
    slots.get(s).push({ id: st.id, name: st.name });
  }
  return [...slots.keys()].sort((a, b) => a - b).map(s => ({ time: fmt(s), staff: slots.get(s) }));
}

function clean(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

function book(db, input, now = new Date()) {
  const customer = clean(input.customer, 80), phone = clean(input.phone, 30), email = clean(input.email, 120), notes = clean(input.notes, 300);
  if (customer.length < 2) throw new BookingError('Name is required');
  if (!/^[+\d][\d\s()-]{6,}$/.test(phone)) throw new BookingError('A valid phone number is required');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BookingError('Invalid email');
  if (!validDay(input.day)) throw new BookingError('Invalid date');
  if (!/^\d{2}:\d{2}$/.test(input.time || '')) throw new BookingError('Invalid time');
  const svc = db.prepare('SELECT * FROM services WHERE id=?').get(input.serviceId);
  if (!svc || !svc.active) throw new BookingError('Unknown service', 404);
  const start = toMin(input.time), end = start + svc.minutes;
  const code = crypto.randomBytes(16).toString('hex').toUpperCase();
  db.exec('BEGIN IMMEDIATE');
  try {
    let staffId = input.staffId;
    const candidates = (staffId ? [staffId] : db.prepare('SELECT id FROM staff').all().map(r => r.id)).filter(id => db.prepare('SELECT 1 FROM staff WHERE id=? AND active=1').get(id));
    const cn = clinicNow(db, now), today = cn.day;
    if (input.day < today) throw new BookingError('That date has passed');
    const nowMin = input.day === today ? cn.min : null;
    staffId = candidates.find(id => staffSlots(db, id, input.day, svc.minutes, nowMin).includes(start));
    if (!staffId) throw new BookingError('That time is no longer available', 409);
    db.prepare('INSERT INTO appointments(code,service_id,staff_id,customer,phone,email,notes,day,start_min,end_min) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(code, svc.id, staffId, customer, phone, email || null, notes || null, input.day, start, end);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return getByCode(db, code);
}

const SELECT = `SELECT a.code,a.customer,a.phone,a.email,a.notes,a.day,a.start_min,a.end_min,a.status,s.name service,s.price,st.name staff,a.id,a.staff_id,a.service_id
  FROM appointments a JOIN services s ON s.id=a.service_id JOIN staff st ON st.id=a.staff_id`;
const shape = r => r && { ...r, start: fmt(r.start_min), end: fmt(r.end_min) };
const getByCode = (db, code) => shape(db.prepare(SELECT + ' WHERE a.code=?').get(String(code).toUpperCase()));
const listDay = (db, day) => db.prepare(SELECT + ' WHERE a.day=? ORDER BY a.start_min').all(day).map(shape);
const listRange = (db, from, to) => db.prepare(SELECT + ' WHERE a.day BETWEEN ? AND ? ORDER BY a.day,a.start_min').all(from, to).map(shape);

function cancel(db, code) {
  const a = getByCode(db, code);
  if (!a) throw new BookingError('Booking not found', 404);
  if (a.status !== 'booked') throw new BookingError('Only active bookings can be cancelled', 409);
  db.prepare("UPDATE appointments SET status='cancelled' WHERE code=?").run(a.code);
  return getByCode(db, code);
}
function setStatus(db, code, status) {
  if (!['booked', 'completed', 'cancelled', 'no_show'].includes(status)) throw new BookingError('Bad status');
  const a = getByCode(db, code);
  if (!a) throw new BookingError('Booking not found', 404);
  db.prepare('UPDATE appointments SET status=? WHERE code=?').run(status, a.code);
  return getByCode(db, code);
}
function reschedule(db, code, day, time, now = new Date()) {
  const a = getByCode(db, code);
  if (!a) throw new BookingError('Booking not found', 404);
  if (a.status !== 'booked') throw new BookingError('Only active bookings can be moved', 409);
  const svc = db.prepare('SELECT id,minutes FROM services WHERE name=?').get(a.service);
  if (!validDay(day) || !/^\d{2}:\d{2}$/.test(time || '')) throw new BookingError('Invalid date or time');
  const start = toMin(time);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE appointments SET status='cancelled' WHERE code=?").run(a.code); // free own slot for the check
    const cn = clinicNow(db, now), today = cn.day;
    if (day < today) throw new BookingError('That date has passed');
    const nowMin = day === today ? cn.min : null;
    const staffId = db.prepare('SELECT staff_id FROM appointments WHERE code=?').get(a.code).staff_id;
    if (!staffSlots(db, staffId, day, svc.minutes, nowMin).includes(start)) throw new BookingError('That time is not available with the same staff member', 409);
    db.prepare("UPDATE appointments SET status='booked',day=?,start_min=?,end_min=? WHERE code=?").run(day, start, start + svc.minutes, a.code);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return getByCode(db, code);
}

function stats(db, from, to) {
  const rows = db.prepare(`SELECT a.status, count(*) n, coalesce(sum(s.price),0) revenue FROM appointments a JOIN services s ON s.id=a.service_id WHERE a.day BETWEEN ? AND ? GROUP BY a.status`).all(from, to);
  const out = { booked: 0, completed: 0, cancelled: 0, no_show: 0, revenue: 0 };
  for (const r of rows) { out[r.status] = r.n; if (r.status === 'completed') out.revenue = r.revenue; }
  return out;
}

// ---- clients (grouped by phone number; there is no separate client table, so nothing extra is stored) ----
const digits = p => String(p || '').replace(/\D/g, '');
function clients(db, q, today) {
  const term = clean(q || '', 60).toLowerCase(), qd = digits(q);
  const rows = db.prepare(SELECT + ' ORDER BY a.day DESC, a.start_min DESC').all().map(shape);
  const map = new Map();
  for (const r of rows) {
    const key = digits(r.phone) || r.phone; let c = map.get(key);
    if (!c) { c = { key, name: r.customer, phone: r.phone, email: r.email || '', visits: 0, no_shows: 0, cancelled: 0, upcoming: 0, spent: 0, last_visit: null, next: null }; map.set(key, c); } // first row seen is the newest
    if (r.status === 'completed') { c.visits++; c.spent += r.price; if (!c.last_visit || r.day > c.last_visit) c.last_visit = r.day; }
    else if (r.status === 'no_show') c.no_shows++;
    else if (r.status === 'cancelled') c.cancelled++;
    else if (r.status === 'booked') { if (r.day >= today) { c.upcoming++; if (!c.next || (r.day + r.start) < c.next) c.next = r.day + ' ' + r.start; } }
    if (!c.email && r.email) c.email = r.email;
  }
  let out = [...map.values()];
  if (term) out = out.filter(c => c.name.toLowerCase().includes(term) || (qd.length >= 3 && digits(c.phone).includes(qd)));
  return out.sort((a, b) => (b.upcoming - a.upcoming) || a.name.localeCompare(b.name)).slice(0, 200);
}
function clientHistory(db, phone) {
  const d = digits(phone); if (d.length < 3) throw new BookingError('Phone number needed');
  return db.prepare(SELECT + ' ORDER BY a.day DESC, a.start_min DESC').all().map(shape).filter(r => digits(r.phone) === d).slice(0, 100)
    .map(({ code, day, start, end, service, staff, status, price, notes }) => ({ code, day, start, end, service, staff, status, price, notes }));
}
// Agenda for a date range (max 31 days), booked appointments only, with a ready-to-send reminder text.
function agenda(db, from, to, clinic = 'the clinic') {
  if (!validDay(from || '') || !validDay(to || '') || to < from) throw new BookingError('Invalid date range');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 30) throw new BookingError('Range is limited to 31 days');
  return listRange(db, from, to).filter(a => a.status === 'booked').map(a => ({ ...a, reminder: `Hello ${a.customer}, this is a reminder of your ${a.service} appointment with ${a.staff} on ${a.day} at ${a.start}. If you can't make it, please let us know so we can offer the time to someone else. Thank you, ${clinic}.` }));
}
function toCsv(rows) {
  const esc = v => { v = v == null ? '' : String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const cols = ['code', 'day', 'start', 'end', 'service', 'staff', 'customer', 'phone', 'email', 'status', 'price'];
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') + '\n';
}
// ---- staff-side management ----
const num = (v, lo, hi, msg) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new BookingError(msg); return n; };
function saveService(db, id, v) {
  const name = clean(v.name, 80); if (name.length < 2) throw new BookingError('Service name is required');
  const minutes = num(v.minutes, 5, 480, 'Minutes must be 5 to 480'); if (minutes % STEP) throw new BookingError('Minutes must be a multiple of ' + STEP);
  const price = num(v.price, 0, 100000, 'Invalid price'); const active = v.active === false || v.active === 0 ? 0 : 1;
  if (id) { if (!db.prepare('SELECT 1 FROM services WHERE id=?').get(id)) throw new BookingError('Service not found', 404); db.prepare('UPDATE services SET name=?,minutes=?,price=?,active=? WHERE id=?').run(name, minutes, price, active, id); return id; }
  return Number(db.prepare('INSERT INTO services(name,minutes,price,active) VALUES(?,?,?,?)').run(name, minutes, price, active).lastInsertRowid);
}
function saveStaff(db, id, v) {
  const name = clean(v.name, 80); if (name.length < 2) throw new BookingError('Staff name is required');
  const active = v.active === false || v.active === 0 ? 0 : 1;
  if (id) { if (!db.prepare('SELECT 1 FROM staff WHERE id=?').get(id)) throw new BookingError('Staff member not found', 404); db.prepare('UPDATE staff SET name=?,role=?,active=? WHERE id=?').run(name, clean(v.role, 60) || null, active, id); return id; }
  return Number(db.prepare('INSERT INTO staff(name,role,active) VALUES(?,?,?)').run(name, clean(v.role, 60) || null, active).lastInsertRowid);
}
function setHours(db, staffId, hours) { // hours: array of {weekday,start,end}, absent weekday = day off
  if (!db.prepare('SELECT 1 FROM staff WHERE id=?').get(staffId)) throw new BookingError('Staff member not found', 404);
  if (!Array.isArray(hours)) throw new BookingError('Invalid hours');
  const seen = new Set();
  for (const h of hours) {
    if (!Number.isInteger(h.weekday) || h.weekday < 0 || h.weekday > 6 || seen.has(h.weekday)) throw new BookingError('Invalid weekday');
    if (!/^\d{2}:\d{2}$/.test(h.start || '') || !/^\d{2}:\d{2}$/.test(h.end || '') || toMin(h.start) >= toMin(h.end) || toMin(h.end) > 1440) throw new BookingError('Start must be before end (HH:MM)');
    seen.add(h.weekday);
  }
  db.exec('BEGIN'); try { db.prepare('DELETE FROM staff_hours WHERE staff_id=?').run(staffId); for (const h of hours) db.prepare('INSERT INTO staff_hours VALUES(?,?,?,?)').run(staffId, h.weekday, h.start, h.end); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function staffOverview(db, today) {
  return db.prepare('SELECT * FROM staff ORDER BY id').all().map(s => ({ ...s,
    hours: db.prepare('SELECT weekday,start,end FROM staff_hours WHERE staff_id=? ORDER BY weekday').all(s.id),
    timeOff: db.prepare('SELECT id,day,note FROM time_off WHERE staff_id=? AND day>=? ORDER BY day').all(s.id, today) }));
}
function addTimeOff(db, staffId, day, note) {
  if (!validDay(day || '') || !db.prepare('SELECT 1 FROM staff WHERE id=?').get(staffId)) throw new BookingError('Invalid input');
  const clash = db.prepare("SELECT count(*) n FROM appointments WHERE staff_id=? AND day=? AND status='booked'").get(staffId, day).n;
  db.prepare('INSERT INTO time_off(staff_id,day,note) VALUES(?,?,?)').run(staffId, day, clean(note, 100)); return { existingBookings: clash };
}
module.exports = { clients, clientHistory, agenda, clinicNow, tzOf, saveService, saveStaff, setHours, staffOverview, addTimeOff, BookingError, availableSlots, book, cancel, setStatus, reschedule, getByCode, listDay, listRange, stats, toCsv, validDay };
