'use strict';
const { open } = require('./db');
const { book, clinicNow } = require('./booking');
// Default services, staff and weekly hours. Everything here can be edited in the staff page.
function seedDefaults(db) {
  const ins = (sql, ...a) => db.prepare(sql).run(...a);
  [['Consultation', 30, 40], ['Follow-up visit', 30, 25], ['Dental cleaning', 60, 80], ['Full check-up', 60, 95]].forEach(s => ins('INSERT INTO services(name,minutes,price) VALUES(?,?,?)', ...s));
  [['Dr. Layla Hassan', 'Physician'], ['Dr. Omar Nabil', 'Dentist'], ['Nour Adel', 'Hygienist']].forEach(s => ins('INSERT INTO staff(name,role) VALUES(?,?)', ...s));
  for (const st of [1, 2, 3]) for (const wd of [0, 1, 2, 3, 4]) ins('INSERT INTO staff_hours VALUES(?,?,?,?)', st, wd, st === 3 ? '10:00' : '09:00', st === 3 ? '16:00' : '17:00');
}
// Optional fictional bookings. Phone numbers are obvious placeholders (all zeros), not dialable numbers.
function seedDemoBookings(db, now = new Date()) {
  const people = [['Demo Client One', '000 0000 0001'], ['Demo Client Two', '000 0000 0002'], ['Demo Client Three', '000 0000 0003'], ['Demo Client Four', '000 0000 0004']];
  const { day } = clinicNow(db, now); let n = 0;
  for (let d = 1; d <= 6 && n < 12; d++) {
    const iso = new Date(new Date(day + 'T00:00:00Z').getTime() + d * 864e5).toISOString().slice(0, 10);
    for (const [i, t] of ['09:00', '10:30', '13:00'].entries()) {
      try { const p = people[(n + i) % 4]; book(db, { customer: p[0], phone: p[1], serviceId: 1 + (n + i) % 4, staffId: 1 + (n + i) % 3, day: iso, time: t }, now); n++; } catch {}
    }
  }
}
function seed(db, now = new Date(0)) { seedDefaults(db); seedDemoBookings(db, now); return db; }
module.exports = { seed, seedDefaults, seedDemoBookings };
