'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { open, createUser, login, logout, sessionUser } = require('../db');
const B = require('../booking');
const { seed } = require('../seed');
const { createApp } = require('../server');

const NOW = new Date('2026-11-24T08:00:00Z'); // Tuesday
const fresh = () => { const db = open(); db.prepare("UPDATE settings SET value='UTC' WHERE key='tz'").run(); seed(db, new Date(0)); return db; };
const base = { customer: 'Test Person', phone: '+20 100 000 1111', serviceId: 1, day: '2026-11-25', time: '10:00' };

test('slots respect working hours and service length', () => {
  const db = fresh();
  const s = B.availableSlots(db, { day: '2026-11-25', serviceId: 3, staffId: 1, now: NOW }); // 60 min, Wed
  assert.strictEqual(s[0].time, '09:00');
  assert.strictEqual(s[s.length - 1].time, '16:00'); // must end by 17:00
});
test('no slots on weekend or past days', () => {
  const db = fresh();
  assert.deepStrictEqual(B.availableSlots(db, { day: '2026-11-28', serviceId: 1, now: NOW }), []); // Saturday
  assert.deepStrictEqual(B.availableSlots(db, { day: '2026-11-20', serviceId: 1, now: NOW }), []);
});
test('past times today are hidden', () => {
  const db = fresh();
  const s = B.availableSlots(db, { day: '2026-11-24', serviceId: 1, staffId: 1, now: NOW });
  assert.ok(s.every(x => x.time > '08:00'));
});
test('booking succeeds and blocks the slot for that staff member', () => {
  const db = fresh();
  const a = B.book(db, { ...base, staffId: 1 }, NOW);
  assert.strictEqual(a.status, 'booked'); assert.match(a.code, /^[0-9A-F]{32}$/);
  assert.throws(() => B.book(db, { ...base, staffId: 1 }, NOW), e => e.status === 409);
  const s = B.availableSlots(db, { day: base.day, serviceId: 1, staffId: 1, now: NOW });
  assert.ok(!s.find(x => x.time === '10:00'));
});
test('overlapping longer service is rejected', () => {
  const db = fresh();
  B.book(db, { ...base, staffId: 1, time: '10:30' }, NOW);
  assert.throws(() => B.book(db, { ...base, staffId: 1, serviceId: 3, time: '10:00' }, NOW), e => e.status === 409);
  B.book(db, { ...base, staffId: 1, serviceId: 3, time: '11:00' }, NOW); // adjacent is fine
});
test('any-staff booking picks a free person', () => {
  const db = fresh();
  const a = B.book(db, { ...base, staffId: null }, NOW);
  const b = B.book(db, { ...base, staffId: null }, NOW);
  assert.notStrictEqual(a.staff, b.staff);
});
test('validation', () => {
  const db = fresh();
  assert.throws(() => B.book(db, { ...base, customer: '' }, NOW), /Name/);
  assert.throws(() => B.book(db, { ...base, phone: 'abc' }, NOW), /phone/);
  assert.throws(() => B.book(db, { ...base, email: 'nope' }, NOW), /email/);
  assert.throws(() => B.book(db, { ...base, day: '2026-13-45' }, NOW), /date/);
  assert.throws(() => B.book(db, { ...base, serviceId: 99 }, NOW), /service/);
  assert.throws(() => B.book(db, { ...base, day: '2026-11-20' }, NOW), /passed/);
  assert.throws(() => B.book(db, { ...base, time: '03:00' }, NOW), e => e.status === 409); // outside hours
});
test('cancel frees the slot; double cancel rejected', () => {
  const db = fresh();
  const a = B.book(db, { ...base, staffId: 1 }, NOW);
  assert.strictEqual(B.cancel(db, a.code).status, 'cancelled');
  assert.throws(() => B.cancel(db, a.code), e => e.status === 409);
  B.book(db, { ...base, staffId: 1 }, NOW);
});
test('reschedule moves, keeps staff, refuses taken slot and keeps original on failure', () => {
  const db = fresh();
  const a = B.book(db, { ...base, staffId: 1 }, NOW);
  B.book(db, { ...base, staffId: 1, time: '12:00' }, NOW);
  assert.throws(() => B.reschedule(db, a.code, base.day, '12:00', NOW), e => e.status === 409);
  assert.strictEqual(B.getByCode(db, a.code).start, '10:00');
  assert.strictEqual(B.getByCode(db, a.code).status, 'booked');
  const m = B.reschedule(db, a.code, '2026-11-26', '09:30', NOW);
  assert.strictEqual(m.day, '2026-11-26'); assert.strictEqual(m.start, '09:30');
});
test('time off removes availability', () => {
  const db = fresh();
  db.prepare("INSERT INTO time_off(staff_id,day) VALUES(1,'2026-11-25')").run();
  assert.deepStrictEqual(B.availableSlots(db, { day: '2026-11-25', serviceId: 1, staffId: 1, now: NOW }), []);
});
test('stats count completed revenue only', () => {
  const db = fresh();
  const a = B.book(db, { ...base, staffId: 1 }, NOW); B.setStatus(db, a.code, 'completed');
  const b = B.book(db, { ...base, staffId: 1, time: '11:00' }, NOW); B.setStatus(db, b.code, 'no_show');
  const s = B.stats(db, '2026-11-25', '2026-11-25');
  assert.strictEqual(s.completed, 1); assert.strictEqual(s.no_show, 1); assert.strictEqual(s.revenue, 40);
});
test('csv escapes quotes and neutralises formulas', () => {
  const csv = B.toCsv([{ code: 'A', customer: '=HYPERLINK("x")', service: 'a,b' }]);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/); assert.match(csv, /"a,b"/);
});
test('passwords are hashed, sessions work', () => {
  const db = open(); createUser(db, 'a', 'pw-long-12345');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM users').all()).includes('pw-long-12345'));
  assert.strictEqual(login(db, 'a', 'bad'), null);
  const t = login(db, 'a', 'pw-long-12345'); assert.strictEqual(sessionUser(db, t).username, 'a');
  assert.strictEqual(sessionUser(db, 'zzz'), null);
});

async function withServer(fn) {
  const db = fresh(); createUser(db, 'admin', 'secret-pass-99');
  const srv = createApp(db, { now: () => NOW, publicLimit: 30 });
  await new Promise(r => srv.listen(0, r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try { await fn(base); } finally { srv.close(); }
}
const j = (r) => r.json();
const loginCookie = async url => (await fetch(url + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'secret-pass-99' }) })).headers.get('set-cookie').split(';')[0];
test('HTTP: public booking flow and admin protection', async () => {
  await withServer(async url => {
    const sl = await j(await fetch(`${url}/api/slots?day=2026-11-25&service=1`));
    assert.ok(sl.slots.length > 5);
    const r = await fetch(url + '/api/book', { method: 'POST', body: JSON.stringify({ ...base, serviceId: 1, staffId: 2 }) });
    assert.strictEqual(r.status, 201);
    const { booking } = await j(r);
    const pub = await j(await fetch(`${url}/api/booking/${booking.code}`));
    assert.ok(!('phone' in pub.booking) && !('customer' in pub.booking)); // public lookup exposes no personal data
    assert.strictEqual((await fetch(url + '/api/admin/appointments?day=2026-11-25')).status, 401);
    assert.strictEqual((await fetch(url + '/api/admin/export.csv')).status, 401);
    const bad = await fetch(url + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'x' }) });
    assert.strictEqual(bad.status, 401);
    const ok = await fetch(url + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'secret-pass-99' }) });
    const ck = ok.headers.get('set-cookie'); assert.match(ck, /HttpOnly/); assert.match(ck, /SameSite=Strict/);
    const h = { cookie: ck.split(';')[0] };
    const list = await j(await fetch(url + '/api/admin/appointments?day=2026-11-25', { headers: h }));
    assert.ok(list.appointments.find(a => a.code === booking.code && a.phone));
    const csv = await fetch(url + '/api/admin/export.csv', { headers: h });
    assert.match(csv.headers.get('content-type'), /csv/);
    const st = await fetch(`${url}/api/admin/booking/${booking.code}/status`, { method: 'POST', headers: h, body: JSON.stringify({ status: 'completed' }) });
    assert.strictEqual((await j(st)).booking.status, 'completed');
  });
});
test('HTTP: malformed input handled, no path traversal, login lockout', async () => {
  await withServer(async url => {
    assert.strictEqual((await fetch(url + '/api/book', { method: 'POST', body: '{bad' })).status, 400);
    assert.strictEqual((await fetch(url + '/api/slots?day=nope&service=1')).status, 400);
    assert.strictEqual((await fetch(url + '/api/booking/ZZZZZZZZ')).status, 404);
    assert.strictEqual((await fetch(url + '/..%2f..%2fserver.js')).status, 404);
    assert.strictEqual((await fetch(url + '/')).status, 200);
    let last;
    for (let i = 0; i < 6; i++) last = await fetch(url + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'no' }) });
    assert.strictEqual(last.status, 429);
  });
});
test('concurrent double booking: exactly one wins', async () => {
  await withServer(async url => {
    const go = () => fetch(url + '/api/book', { method: 'POST', body: JSON.stringify({ ...base, serviceId: 1, staffId: 1 }) }).then(r => r.status);
    const res = await Promise.all([go(), go(), go(), go()]);
    assert.deepStrictEqual(res.sort(), [201, 409, 409, 409]);
  });
});

const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
test('restart persistence: data survives closing and reopening the database file', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-')), 'c.db');
  let db = open(f); db.prepare("UPDATE settings SET value='UTC' WHERE key='tz'").run(); seed(db, new Date(0)); createUser(db, 'owner', 'a-long-password');
  const a = B.book(db, { ...base, staffId: 1 }, NOW); B.saveService(db, null, { name: 'Persisted', minutes: 30, price: 10 });
  db.close(); db = open(f);
  assert.strictEqual(B.getByCode(db, a.code).customer, 'Test Person');
  assert.ok(db.prepare("SELECT 1 FROM services WHERE name='Persisted'").get());
  assert.ok(login(db, 'owner', 'a-long-password'));
  assert.throws(() => B.book(db, { ...base, staffId: 1 }, NOW), e => e.status === 409); // the old booking still blocks the slot
  db.close();
});
test('timezone: "today" and past-time rules follow the clinic zone, not the server UTC date', () => {
  const db = fresh(); db.prepare("UPDATE settings SET value='Africa/Cairo' WHERE key='tz'").run();
  const late = new Date('2026-11-24T23:30:00Z'); // 01:30 on 25 Nov in Cairo
  assert.deepStrictEqual(B.clinicNow(db, late), { day: '2026-11-25', min: 90 });
  assert.deepStrictEqual(B.availableSlots(db, { day: '2026-11-24', serviceId: 1, now: late }), []); // yesterday there
  const noon = new Date('2026-11-25T08:00:00Z'); // 10:00 Cairo
  const s = B.availableSlots(db, { day: '2026-11-25', serviceId: 1, staffId: 1, now: noon });
  assert.strictEqual(s[0].time, '10:30');
});
test('cancellation codes are 128-bit and unique', () => {
  const db = fresh(); const codes = new Set();
  for (const t of ['09:00', '09:30', '10:00', '10:30']) codes.add(B.book(db, { ...base, staffId: 1, time: t }, NOW).code);
  assert.strictEqual(codes.size, 4); for (const c of codes) assert.strictEqual(c.length, 32);
});
test('service and staff management: edit, deactivate, hours, validation', () => {
  const db = fresh();
  const id = B.saveService(db, null, { name: 'Massage', minutes: 60, price: 50 });
  assert.ok(B.availableSlots(db, { day: '2026-11-25', serviceId: id, now: NOW }).length > 0);
  B.saveService(db, id, { name: 'Massage', minutes: 90, price: 55 }); assert.strictEqual(db.prepare('SELECT minutes FROM services WHERE id=?').get(id).minutes, 90);
  assert.throws(() => B.saveService(db, null, { name: 'x', minutes: 30, price: 1 }), /name/);
  assert.throws(() => B.saveService(db, null, { name: 'Odd', minutes: 45, price: 1 }), /multiple/);
  assert.throws(() => B.saveService(db, null, { name: 'Neg', minutes: 30, price: -1 }), /price/);
  B.saveService(db, id, { name: 'Massage', minutes: 90, price: 55, active: false });
  assert.throws(() => B.book(db, { ...base, serviceId: id }, NOW), e => e.status === 404);
  const sid = B.saveStaff(db, null, { name: 'New Person', role: 'Therapist' });
  assert.deepStrictEqual(B.availableSlots(db, { day: '2026-11-25', serviceId: 1, staffId: sid, now: NOW }), []); // no hours yet
  B.setHours(db, sid, [{ weekday: 3, start: '12:00', end: '14:00' }]);
  assert.deepStrictEqual(B.availableSlots(db, { day: '2026-11-25', serviceId: 1, staffId: sid, now: NOW }).map(x => x.time), ['12:00', '12:30', '13:00', '13:30']);
  assert.throws(() => B.setHours(db, sid, [{ weekday: 3, start: '15:00', end: '14:00' }]), /before/);
  assert.throws(() => B.setHours(db, sid, [{ weekday: 9, start: '10:00', end: '11:00' }]), /weekday/);
  B.saveStaff(db, sid, { name: 'New Person', active: false });
  assert.deepStrictEqual(B.availableSlots(db, { day: '2026-11-25', serviceId: 1, staffId: sid, now: NOW }), []);
  assert.strictEqual(B.addTimeOff(db, 1, '2026-11-26', 'x').existingBookings, 0);
});
test('HTTP: first-run setup creates the only account, once, with a strong-enough password', async () => {
  const db = open(); const srv = createApp(db, { now: () => NOW }); await new Promise(r => srv.listen(0, r)); const url = 'http://127.0.0.1:' + srv.address().port;
  try {
    assert.strictEqual((await (await fetch(url + '/api/setup-status')).json()).needsSetup, true);
    assert.strictEqual((await fetch(url + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin' }) })).status, 401); // no default account
    assert.strictEqual((await fetch(url + '/api/setup', { method: 'POST', body: JSON.stringify({ username: 'boss', password: 'short' }) })).status, 400);
    assert.strictEqual((await fetch(url + '/api/setup', { method: 'POST', body: JSON.stringify({ username: 'boss', password: 'long-enough-pass' }) })).status, 201);
    assert.strictEqual((await fetch(url + '/api/setup', { method: 'POST', body: JSON.stringify({ username: 'evil', password: 'long-enough-pass' }) })).status, 409);
    assert.strictEqual((await (await fetch(url + '/api/setup-status')).json()).needsSetup, false);
  } finally { srv.close(); }
});
test('HTTP: admin management endpoints need login and work with it; public sees only active services', async () => {
  await withServer(async url => {
    assert.strictEqual((await fetch(url + '/api/admin/services', { method: 'POST', body: '{}' })).status, 401);
    assert.strictEqual((await fetch(url + '/api/admin/overview')).status, 401);
    const h = { cookie: await loginCookie(url) };
    const r = await fetch(url + '/api/admin/services', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Hidden', minutes: 30, price: 5, active: false }) });
    assert.strictEqual(r.status, 201);
    const pub = await (await fetch(url + '/api/services')).json(); assert.ok(!pub.services.find(s => s.name === 'Hidden')); assert.strictEqual(pub.timezone, 'UTC');
    assert.strictEqual((await fetch(url + '/api/admin/staff/1/hours', { method: 'POST', headers: h, body: JSON.stringify({ hours: [{ weekday: 1, start: '09:00', end: '12:00' }] }) })).status, 200);
    const ov = await (await fetch(url + '/api/admin/overview', { headers: h })).json(); assert.strictEqual(ov.staff[0].hours.length, 1);
  });
});
test('HTTP: cancel and reschedule end to end, and public endpoints are rate limited', async () => {
  await withServer(async url => {
    const h = { cookie: await loginCookie(url) };
    const mk = async time => (await (await fetch(url + '/api/book', { method: 'POST', body: JSON.stringify({ ...base, serviceId: 1, staffId: 1, time }) })).json()).booking;
    const a = await mk('10:00'), b = await mk('11:00');
    const mv = await fetch(`${url}/api/admin/booking/${a.code}/reschedule`, { method: 'POST', headers: h, body: JSON.stringify({ day: '2026-11-26', time: '09:00' }) });
    assert.strictEqual((await mv.json()).booking.day, '2026-11-26');
    const clash = await fetch(`${url}/api/admin/booking/${a.code}/reschedule`, { method: 'POST', headers: h, body: JSON.stringify({ day: '2026-11-25', time: '11:00' }) });
    assert.strictEqual(clash.status, 409);
    assert.strictEqual((await (await fetch(`${url}/api/booking/${a.code}`)).json()).booking.day, '2026-11-26'); // failed move left it untouched
    assert.strictEqual((await (await fetch(`${url}/api/booking/${b.code}/cancel`, { method: 'POST' })).json()).booking.status, 'cancelled');
    assert.strictEqual((await fetch(`${url}/api/booking/${b.code}/cancel`, { method: 'POST' })).status, 409);
    let last; for (let i = 0; i < 40; i++) last = await fetch(url + '/api/booking/' + 'F'.repeat(32));
    assert.strictEqual(last.status, 429);
  });
});

test('clients are grouped by phone and carry visit, no-show and next-booking facts', () => {
  const db = fresh();
  const a = B.book(db, { ...base, day: '2026-11-25', time: '09:00', phone: '+20 100 000 1111' }, NOW);
  const b = B.book(db, { ...base, day: '2026-11-26', time: '09:00', phone: '0020-100-000-1111'.replace('0020-', '+20 ') }, NOW); // same digits, different formatting
  const c = B.book(db, { ...base, customer: 'Other Person', day: '2026-11-25', time: '11:00', phone: '+20 100 000 2222' }, NOW);
  B.setStatus(db, a.code, 'completed'); B.setStatus(db, c.code, 'no_show');
  const all = B.clients(db, '', '2026-11-24');
  assert.strictEqual(all.length, 4 + 2); // 4 fictional demo clients from the seed + these 2
  const t = all.find(x => x.name === 'Test Person'); assert.strictEqual(t.visits, 1); assert.strictEqual(t.upcoming, 1); assert.strictEqual(t.next, '2026-11-26 09:00'); assert.strictEqual(t.spent, 40);
  assert.strictEqual(all.find(x => x.name === 'Other Person').no_shows, 1);
  assert.strictEqual(B.clients(db, 'other', '2026-11-24').length, 1); assert.strictEqual(B.clients(db, '2222', '2026-11-24').length, 1); assert.strictEqual(B.clients(db, 'zzz', '2026-11-24').length, 0);
  assert.strictEqual(B.clientHistory(db, '+20 100 000 1111').length, 2); assert.throws(() => B.clientHistory(db, ''), /Phone/);
  assert.ok(b.code);
});
test('agenda lists only booked appointments in range with reminder text; range is limited', () => {
  const db = fresh();
  const a = B.book(db, { ...base, day: '2026-11-25', time: '09:00' }, NOW), x = B.book(db, { ...base, day: '2026-11-25', time: '10:00' }, NOW);
  B.cancel(db, x.code); B.book(db, { ...base, day: '2026-12-20', time: '10:00' }, NOW);
  const ag = B.agenda(db, '2026-11-24', '2026-11-30');
  assert.strictEqual(ag.length, 1); assert.strictEqual(ag[0].code, a.code); assert.match(ag[0].reminder, /Test Person.*2026-11-25 at 09:00/);
  assert.throws(() => B.agenda(db, '2026-11-24', '2027-03-01'), /31 days/); assert.throws(() => B.agenda(db, 'x', 'y'), /range/);
});
test('client and agenda endpoints require staff login', async () => {
  const db = fresh(); const srv = createApp(db, { now: () => NOW }); await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  for (const u of ['/api/admin/clients', '/api/admin/agenda?from=2026-11-24&to=2026-11-25', '/api/admin/client-history?phone=123456']) { const r = await fetch(`http://127.0.0.1:${port}${u}`); assert.strictEqual(r.status, 401, u); }
  srv.close();
});
test('logout deletes the server session: the old token no longer works', async () => {
  const db = open(':memory:');
  createUser(db, 'o', 'a-long-password');
  const t1 = login(db, 'o', 'a-long-password'), t2 = login(db, 'o', 'a-long-password');
  assert.ok(sessionUser(db, t1));
  logout(db, t1);
  assert.strictEqual(sessionUser(db, t1), null);
  assert.ok(sessionUser(db, t2)); // another session of the same user stays valid
  assert.doesNotThrow(() => logout(db, undefined)); // no cookie is harmless
  assert.doesNotThrow(() => logout(db, 'unknown'));
});
test('HTTP: replaying the cookie after /api/logout is rejected', async () => {
  await withServer(async url => {
    const ck = await loginCookie(url);
    const h = { cookie: ck };
    assert.strictEqual((await fetch(url + '/api/admin/me', { headers: h })).status, 200);
    const out = await fetch(url + '/api/logout', { method: 'POST', headers: h });
    assert.strictEqual(out.status, 200);
    assert.strictEqual((await fetch(url + '/api/admin/me', { headers: h })).status, 401); // old cookie replayed
  });
});
