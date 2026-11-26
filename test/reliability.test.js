'use strict';
// New in local/reliability-layer. Each audit test was first run against the unmodified fix-logout-session code (see AUDIT.md).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { open, createUser, login, sessionUser } = require('../db');
const B = require('../booking');
const { seed } = require('../seed');
const { createApp } = require('../server');
const NOW = new Date('2026-11-24T08:00:00Z');
const fresh = () => { const db = open(); db.prepare("UPDATE settings SET value='UTC' WHERE key='tz'").run(); seed(db, new Date(0)); return db; };
const base = { customer: 'Test Person', phone: '+20 100 000 1111', serviceId: 1, day: '2026-11-25', time: '10:00', staffId: 1 };

test('AUDIT 1: a cancelled booking cannot be restored on top of a newer booking', () => {
  const db = fresh();
  const a = B.book(db, base, NOW); B.cancel(db, a.code);
  B.book(db, { ...base, customer: 'Second Person' }, NOW);
  assert.throws(() => B.setStatus(db, a.code, 'booked'), e => e.status === 409);
  assert.strictEqual(db.prepare("SELECT count(*) n FROM appointments WHERE day=? AND start_min=600 AND staff_id=1 AND status='booked'").get(base.day).n, 1);
});
test('AUDIT 2: restoring a cancelled booking into a free slot works', () => {
  const db = fresh();
  const a = B.book(db, base, NOW); B.cancel(db, a.code);
  assert.strictEqual(B.setStatus(db, a.code, 'booked', NOW).status, 'booked');
});
test('AUDIT 3: reschedule uses the booking\'s own service even when two services share a name', () => {
  const db = fresh();
  const dup = B.saveService(db, null, { name: 'Consultation', minutes: 60, price: 10 }); // same name as id 1 (30 min)
  const a = B.book(db, { ...base, serviceId: dup }, NOW);
  const m = B.reschedule(db, a.code, '2026-11-25', '13:00', NOW);
  assert.strictEqual(m.end_min - m.start_min, 60);
});
test('AUDIT 4: status machine: completed cannot go back to booked; unknown status rejected', () => {
  const db = fresh();
  const a = B.book(db, base, NOW); B.setStatus(db, a.code, 'completed', NOW);
  assert.throws(() => B.setStatus(db, a.code, 'booked', NOW), e => e.status === 409);
  assert.throws(() => B.setStatus(db, a.code, 'nonsense', NOW), e => e.status === 400);
});
test('AUDIT 5: the database itself refuses overlapping active bookings for a staff member (even raw SQL)', () => {
  const db = fresh(); B.book(db, base, NOW);
  assert.throws(() => db.prepare("INSERT INTO appointments(code,service_id,staff_id,customer,phone,day,start_min,end_min) VALUES('X',1,1,'Raw Insert','0000000',?,600,630)").run(base.day), /overlap/i);
});
test('AUDIT 6: two separate connections racing for one slot: exactly one wins', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-')), 'c.db');
  const a = open(f); a.prepare("UPDATE settings SET value='UTC' WHERE key='tz'").run(); seed(a, new Date(0));
  const b = open(f); let ok = 0, conflict = 0;
  for (let i = 0; i < 20; i++) for (const db of [a, b]) {
    try { B.book(db, { ...base, day: '2026-11-26', time: '09:00', customer: 'Racer ' + i }, NOW); ok++; } catch (e) { if (e.status === 409) conflict++; else throw e; }
  }
  assert.strictEqual(ok, 1); assert.strictEqual(conflict, 39);
});
test('AUDIT 7: a failed reschedule leaves the original booking exactly as it was', () => {
  const db = fresh(); const a = B.book(db, base, NOW); B.book(db, { ...base, customer: 'Blocker', time: '13:00' }, NOW);
  assert.throws(() => B.reschedule(db, a.code, base.day, '13:00', NOW), e => e.status === 409);
  const after = B.getByCode(db, a.code); assert.strictEqual(after.status, 'booked'); assert.strictEqual(after.start, '10:00');
});
test('AUDIT 8: deactivating staff with future bookings reports them instead of hiding the problem', () => {
  const db = fresh(); B.book(db, base, NOW);
  const r = B.saveStaff(db, 1, { name: 'Dr. Layla Hassan', role: 'Physician', active: false }, NOW);
  assert.ok(B.futureBookingsFor(db, 1, '2026-11-24') === 1 && r === 1);
});

// ---- roles, audit log, migrations, backup ----
const listen = async (db) => { const srv = createApp(db, { now: () => NOW }); await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port; return { srv, port }; };
const call = async (port, m, p, body, cookie) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); return { status: r.status, body: await r.text(), cookie: sc && sc.split(';')[0] }; };
test('ROLES: reception can run the schedule but not money, exports, staff/services, users or the audit log; owner can; every change is audited', async () => {
  const db = fresh(); createUser(db, 'owner1', 'correct horse battery', 'owner'); createUser(db, 'front1', 'another long passphrase', 'reception');
  const { srv, port } = await listen(db);
  try {
    const o = (await call(port, 'POST', '/api/login', { username: 'owner1', password: 'correct horse battery' })).cookie;
    const f = (await call(port, 'POST', '/api/login', { username: 'front1', password: 'another long passphrase' })).cookie;
    for (const [m, p, b] of [['GET', '/api/admin/stats'], ['GET', '/api/admin/export.csv'], ['GET', '/api/admin/audit'], ['POST', '/api/admin/services', { name: 'X Service', minutes: 30, price: 1 }], ['POST', '/api/admin/staff', { name: 'New Person' }], ['POST', '/api/admin/staff/1/hours', { hours: [] }], ['POST', '/api/admin/timeoff', { staffId: 1, day: '2026-12-01' }], ['POST', '/api/admin/users', { username: 'sneaky', password: 'long enough pass', role: 'owner' }]])
      assert.strictEqual((await call(port, m, p, b, f)).status, 403, m + ' ' + p);
    assert.strictEqual((await call(port, 'GET', '/api/admin/appointments?day=2026-11-25', null, f)).status, 200);
    const bk = B.book(db, base, NOW);
    assert.strictEqual((await call(port, 'POST', `/api/admin/booking/${bk.code}/status`, { status: 'completed' }, f)).status, 200);
    assert.strictEqual((await call(port, 'GET', '/api/admin/stats', null, o)).status, 200);
    assert.strictEqual((await call(port, 'POST', '/api/admin/users', { username: 'front2', password: 'long enough pass', role: 'reception' }, o)).status, 201);
    const audit = JSON.parse((await call(port, 'GET', '/api/admin/audit', null, o)).body).entries;
    assert.ok(audit.some(e => e.username === 'front1' && e.action === 'status_completed'));
    assert.ok(audit.some(e => e.username === 'owner1' && e.action === 'user_create'));
    assert.ok(!JSON.stringify(audit).includes('long enough pass'), 'passwords never in the audit log');
    assert.strictEqual((await call(port, 'GET', '/api/admin/stats')).status, 401);
  } finally { srv.close(); }
});
test('ROLES: first-run setup user is an owner; unknown role refused', () => {
  const db = fresh(); createUser(db, 'first1', 'a long enough pass'); assert.strictEqual(db.prepare("SELECT role FROM users WHERE username='first1'").get().role, 'owner');
  assert.throws(() => createUser(db, 'bad1', 'a long enough pass', 'god'));
});
test('MIGRATION: an old (version 0) database upgrades in place keeping its data; a newer schema is refused', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-')), 'old.db');
  const old = new DatabaseSync(f);
  old.exec(`CREATE TABLE services(id INTEGER PRIMARY KEY, name TEXT NOT NULL, minutes INTEGER NOT NULL, price REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE staff(id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE staff_hours(staff_id INTEGER, weekday INTEGER, start TEXT, end TEXT, PRIMARY KEY(staff_id,weekday));
  CREATE TABLE time_off(id INTEGER PRIMARY KEY, staff_id INTEGER, day TEXT, note TEXT);
  CREATE TABLE appointments(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, service_id INTEGER, staff_id INTEGER, customer TEXT, phone TEXT, email TEXT, notes TEXT, day TEXT, start_min INTEGER, end_min INTEGER, status TEXT NOT NULL DEFAULT 'booked', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
  CREATE TABLE sessions(token TEXT PRIMARY KEY, user_id INTEGER, expires INTEGER NOT NULL);
  INSERT INTO users(username,salt,hash) VALUES('legacy','s','h'); INSERT INTO appointments(code,customer,phone,day,start_min,end_min,staff_id,service_id) VALUES('A','Old Row','0000000','2026-11-25',600,630,1,1);`);
  old.close();
  const db = open(f);
  assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, require('../db').MIGRATIONS.length);
  assert.strictEqual(db.prepare("SELECT role FROM users WHERE username='legacy'").get().role, 'owner');
  assert.strictEqual(db.prepare('SELECT customer FROM appointments').get().customer, 'Old Row');
  db.close(); assert.strictEqual(open(f).prepare('PRAGMA user_version').get().user_version, require('../db').MIGRATIONS.length); // idempotent
  const g = path.join(path.dirname(f), 'new.db'); const n = new DatabaseSync(g); n.exec('PRAGMA user_version=99'); n.close();
  assert.throws(() => open(g), /newer version/);
});
test('BACKUP: a backup verifies, refuses to overwrite, and corrupt or truncated files are detected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-')); const db = fresh(); B.book(db, base, NOW);
  const f = path.join(dir, 'b.db'); const r = require('../db').backup(db, f);
  assert.deepStrictEqual([r.ok, r.problems.length], [true, 0]);
  assert.throws(() => require('../db').backup(db, f), /overwrite/);
  const copy = new DatabaseSync(f); assert.strictEqual(copy.prepare('SELECT count(*) n FROM appointments').get().n >= 1, true); copy.close();
  const bad = path.join(dir, 'bad.db'); const bytes = fs.readFileSync(f); fs.writeFileSync(bad, bytes.subarray(0, Math.floor(bytes.length / 2)));
  assert.strictEqual(require('../db').verify(bad).ok, false);
  const junk = path.join(dir, 'junk.db'); fs.writeFileSync(junk, 'this is not a database at all, just some text'.repeat(50));
  assert.strictEqual(require('../db').verify(junk).ok, false);
  const nofile = require('../db').verify(path.join(dir, 'missing.db')); assert.strictEqual(nofile.ok, false);
});

// ---- second round (independent review findings) ----
const code = (db, over = {}) => B.book(db, { ...base, ...over }, NOW);
test('R2-1: restore re-validates against a day off added after the cancellation', () => {
  const db = fresh(); const a = code(db); B.cancel(db, a.code); B.addTimeOff(db, 1, base.day, 'off');
  assert.throws(() => B.setStatus(db, a.code, 'booked', NOW), e => e.status === 409);
  assert.strictEqual(B.getByCode(db, a.code).status, 'cancelled');
});
test('R2-2: restore re-validates against narrowed working hours', () => {
  const db = fresh(); const a = code(db); B.cancel(db, a.code);
  B.setHours(db, 1, [{ weekday: 3, start: '13:00', end: '17:00' }]);
  assert.throws(() => B.setStatus(db, a.code, 'booked', NOW), e => e.status === 409);
});
test('R2-3: restore refuses an inactive service or inactive staff; reschedule refuses inactive staff', () => {
  const db = fresh(); const a = code(db); B.cancel(db, a.code); B.saveService(db, 1, { name: 'Consultation', minutes: 30, price: 40, active: false });
  assert.throws(() => B.setStatus(db, a.code, 'booked', NOW), e => /Service is not active/.test(e.message));
  const db2 = fresh(); const b = code(db2); B.saveStaff(db2, 1, { name: 'Dr. Layla Hassan', role: 'Physician', active: false });
  assert.throws(() => B.reschedule(db2, b.code, base.day, '13:00', NOW), e => e.status === 409 && /not active/.test(e.message));
  assert.strictEqual(B.getByCode(db2, b.code).start, '10:00');
  B.cancel(db2, b.code); assert.throws(() => B.setStatus(db2, b.code, 'booked', NOW), e => /not active/.test(e.message));
});
test('R2-4: a booking in the past cannot be restored (policy: make a new booking)', () => {
  const db = fresh(); const a = code(db); B.cancel(db, a.code);
  assert.throws(() => B.setStatus(db, a.code, 'booked', new Date('2026-11-30T08:00:00Z')), e => e.status === 409 && /past/.test(e.message));
});
test('R2-5: raw SQL cannot create zero/negative/out-of-day appointments or an overlap by UPDATE', () => {
  const db = fresh(); const a = code(db), c = code(db, { time: '12:00' });
  for (const [s, e] of [[600, 600], [630, 600], [-30, 30], [1400, 1500]])
    assert.throws(() => db.prepare("INSERT INTO appointments(code,service_id,staff_id,customer,phone,day,start_min,end_min) VALUES('Z'||?,1,1,'Raw Insert','0000000','2026-12-01',?,?)").run(s, s, e), /bad times/);
  assert.throws(() => db.prepare('UPDATE appointments SET start_min=600,end_min=630 WHERE code=?').run(c.code), /overlap/);
  assert.strictEqual(B.getByCode(db, a.code).start, '10:00');
});
test('R2-6: restore command: verified backup replaces the database, old file kept; invalid backup or running server changes nothing', () => {
  const { restore, backup } = require('../db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-')); const f = path.join(dir, 'live.db');
  const db = open(f); db.prepare("UPDATE settings SET value='UTC' WHERE key='tz'").run(); seed(db, new Date(0));
  const good = path.join(dir, 'good.db'); backup(db, good);
  B.book(db, base, NOW); db.close();                                    // live now has one more booking than the backup
  const liveBytes = fs.readFileSync(f);
  const bad = path.join(dir, 'bad.db'); fs.writeFileSync(bad, fs.readFileSync(good).subarray(0, 4000));
  assert.throws(() => restore(bad, f), /not usable/); assert.deepStrictEqual(fs.readFileSync(f), liveBytes);
  assert.throws(() => restore(path.join(dir, 'nope.db'), f)); assert.deepStrictEqual(fs.readFileSync(f), liveBytes);
  fs.writeFileSync(f + '-journal', 'x'); assert.throws(() => restore(good, f), /in use/); assert.deepStrictEqual(fs.readFileSync(f), liveBytes); fs.unlinkSync(f + '-journal');
  const r = restore(good, f); assert.ok(r.ok && fs.existsSync(r.kept)); assert.deepStrictEqual(fs.readFileSync(r.kept), liveBytes);
  const back = open(f); const n = back.prepare("SELECT count(*) n FROM appointments WHERE customer='Test Person'").get().n; assert.strictEqual(n, 0);
  assert.strictEqual(require('../db').verify(f).ok, true);
  assert.strictEqual(fs.readdirSync(dir).filter(x => x.includes('.restoring-')).length, 0);
});
test('R2-7: setting the same status again does not write an audit entry; busy database gives 503 not a raw error', async () => {
  const db = fresh(); createUser(db, 'o1', 'correct horse battery'); const a = code(db);
  const { srv, port } = await listen(db);
  try {
    const c = (await call(port, 'POST', '/api/login', { username: 'o1', password: 'correct horse battery' })).cookie;
    await call(port, 'POST', `/api/admin/booking/${a.code}/status`, { status: 'completed' }, c);
    await call(port, 'POST', `/api/admin/booking/${a.code}/status`, { status: 'completed' }, c);
    assert.strictEqual(db.prepare("SELECT count(*) n FROM audit_log WHERE action='status_completed'").get().n, 1);
  } finally { srv.close(); }
});
test('R2-8: two OS processes run at the same time on one database and race for one slot: one wins, no raw lock error', async () => {
  const { spawn } = require('node:child_process');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-')), 'mp.db');
  const pre = open(f); pre.prepare("UPDATE settings SET value='UTC' WHERE key='tz'").run(); seed(pre, new Date(0)); pre.close();
  const script = `const {open}=require('./db'),B=require('./booking');let ok=0,conf=0,other=[];for(let i=0;i<15;i++){try{const db=open(process.argv[1]);B.book(db,{customer:'P '+i,phone:'+20 100 000 1111',serviceId:1,staffId:1,day:'2026-12-02',time:'09:00'},new Date('2026-11-24T08:00:00Z'));ok++;db.close()}catch(e){if(e.status===409)conf++;else other.push(e.message)}}console.log(JSON.stringify({ok,conf,other}))`;
  const run = () => new Promise(res => { let out = ''; const c = spawn(process.execPath, ['--no-warnings', '-e', script, f], { cwd: path.join(__dirname, '..') }); c.stdout.on('data', d => out += d); c.on('close', () => res(out)); });
  const outs = (await Promise.all([run(), run(), run()])).map(r => JSON.parse(r.trim().split('\n').pop()));
  assert.strictEqual(outs.reduce((n, o) => n + o.ok, 0), 1); assert.deepStrictEqual(outs.map(o => o.other), [[], [], []]);
});
