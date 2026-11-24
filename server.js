'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open, login, sessionUser, createUser, needsSetup } = require('./db');
const B = require('./booking');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

function createApp(db, { now = () => new Date(), publicLimit = 30, loginLimit = 5 } = {}) {
  const hits = new Map();
  const limited = (ip, bucket, max) => { const k = bucket + ip, t = Date.now(); const a = (hits.get(k) || []).filter(x => t - x < 60000); a.push(t); hits.set(k, a); return a.length > max; };
  const send = (res, code, body, type = 'application/json', extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  const readBody = req => new Promise((ok, bad) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 20000) { bad(new B.BookingError('Body too large', 413)); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { bad(new B.BookingError('Invalid JSON')); } });
  });
  const cookie = req => (/(?:^|; )sid=([a-f0-9]+)/.exec(req.headers.cookie || '') || [])[1];
  const fails = new Map();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname, m = req.method;
    try {
      if (p.startsWith('/api/')) {
        const ip = req.socket.remoteAddress;
        if (p === '/api/book' || p.startsWith('/api/booking/')) { if (limited(ip, p === '/api/book' ? 'book' : 'lookup', p === '/api/book' ? Math.ceil(publicLimit / 2) : publicLimit)) throw new B.BookingError('Too many requests, wait a minute', 429); }
        if (m === 'GET' && p === '/api/setup-status') return send(res, 200, { needsSetup: needsSetup(db) });
        if (m === 'POST' && p === '/api/setup') {
          if (limited(ip, 'setup', 10)) throw new B.BookingError('Too many requests, wait a minute', 429);
          const b = await readBody(req); if (!needsSetup(db)) throw new B.BookingError('Setup already done', 409);
          const u = String(b.username || '').trim(); if (!/^[A-Za-z0-9._-]{3,30}$/.test(u)) throw new B.BookingError('Username: 3 to 30 letters, numbers or . _ -');
          try { createUser(db, u, String(b.password || '')); } catch (e) { throw new B.BookingError(e.message); }
          const tok = login(db, u, String(b.password)); return send(res, 201, { ok: true }, 'application/json', { 'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` });
        }
        if (m === 'GET' && p === '/api/services') return send(res, 200, { services: db.prepare('SELECT id,name,minutes,price FROM services WHERE active=1').all(), staff: db.prepare('SELECT id,name,role FROM staff WHERE active=1').all(), timezone: B.tzOf(db), today: B.clinicNow(db, now()).day });
        if (m === 'GET' && p === '/api/slots') return send(res, 200, { slots: B.availableSlots(db, { day: url.searchParams.get('day'), serviceId: +url.searchParams.get('service'), staffId: +url.searchParams.get('staff') || null, now: now() }) });
        if (m === 'POST' && p === '/api/book') { const b = await readBody(req); return send(res, 201, { booking: B.book(db, { ...b, serviceId: +b.serviceId, staffId: +b.staffId || null }, now()) }); }
        let mm;
        if (m === 'GET' && (mm = /^\/api\/booking\/([A-Za-z0-9]+)$/.exec(p))) { const a = B.getByCode(db, mm[1]); if (!a) throw new B.BookingError('Booking not found', 404); return send(res, 200, { booking: { code: a.code, service: a.service, staff: a.staff, day: a.day, start: a.start, end: a.end, status: a.status } }); }
        if (m === 'POST' && (mm = /^\/api\/booking\/([A-Za-z0-9]+)\/cancel$/.exec(p))) return send(res, 200, { booking: B.cancel(db, mm[1]) });
        if (m === 'POST' && p === '/api/login') {
          const ip = req.socket.remoteAddress; const f = fails.get(ip) || { n: 0, t: 0 };
          if (f.n >= loginLimit && Date.now() - f.t < 60000) throw new B.BookingError('Too many attempts, wait a minute', 429);
          const b = await readBody(req); const tok = login(db, String(b.username || ''), String(b.password || ''));
          if (!tok) { fails.set(ip, { n: f.n + 1, t: Date.now() }); throw new B.BookingError('Wrong username or password', 401); }
          fails.delete(ip);
          return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` });
        }
        if (m === 'POST' && p === '/api/logout') return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': 'sid=; Max-Age=0; Path=/' });
        // admin
        const user = sessionUser(db, cookie(req));
        if (!user) throw new B.BookingError('Login required', 401);
        if (m === 'GET' && p === '/api/admin/me') return send(res, 200, { user });
        if (m === 'GET' && p === '/api/admin/appointments') { const day = url.searchParams.get('day'); if (!B.validDay(day || '')) throw new B.BookingError('Invalid date'); return send(res, 200, { appointments: B.listDay(db, day) }); }
        if (m === 'GET' && p === '/api/admin/clients') return send(res, 200, { clients: B.clients(db, url.searchParams.get('q'), B.clinicNow(db, now()).day) });
        if (m === 'GET' && p === '/api/admin/client-history') return send(res, 200, { appointments: B.clientHistory(db, url.searchParams.get('phone')) });
        if (m === 'GET' && p === '/api/admin/agenda') return send(res, 200, { appointments: B.agenda(db, url.searchParams.get('from'), url.searchParams.get('to')) });
        if (m === 'GET' && p === '/api/admin/stats') return send(res, 200, { stats: B.stats(db, url.searchParams.get('from') || '0000-01-01', url.searchParams.get('to') || '9999-12-31') });
        if (m === 'GET' && p === '/api/admin/export.csv') return send(res, 200, B.toCsv(B.listRange(db, url.searchParams.get('from') || '0000-01-01', url.searchParams.get('to') || '9999-12-31')), 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="appointments.csv"' });
        if (m === 'POST' && (mm = /^\/api\/admin\/booking\/([A-Za-z0-9]+)\/status$/.exec(p))) { const b = await readBody(req); return send(res, 200, { booking: B.setStatus(db, mm[1], b.status) }); }
        if (m === 'POST' && (mm = /^\/api\/admin\/booking\/([A-Za-z0-9]+)\/reschedule$/.exec(p))) { const b = await readBody(req); return send(res, 200, { booking: B.reschedule(db, mm[1], b.day, b.time, now()) }); }
        if (m === 'GET' && p === '/api/admin/overview') return send(res, 200, { today: B.clinicNow(db, now()).day, timezone: B.tzOf(db), services: db.prepare('SELECT * FROM services ORDER BY id').all(), staff: B.staffOverview(db, B.clinicNow(db, now()).day) });
        if (m === 'POST' && p === '/api/admin/services') return send(res, 201, { id: B.saveService(db, null, await readBody(req)) });
        if (m === 'POST' && (mm = /^\/api\/admin\/services\/(\d+)$/.exec(p))) return send(res, 200, { id: B.saveService(db, +mm[1], await readBody(req)) });
        if (m === 'POST' && p === '/api/admin/staff') return send(res, 201, { id: B.saveStaff(db, null, await readBody(req)) });
        if (m === 'POST' && (mm = /^\/api\/admin\/staff\/(\d+)$/.exec(p))) return send(res, 200, { id: B.saveStaff(db, +mm[1], await readBody(req)) });
        if (m === 'POST' && (mm = /^\/api\/admin\/staff\/(\d+)\/hours$/.exec(p))) { B.setHours(db, +mm[1], (await readBody(req)).hours); return send(res, 200, { ok: true }); }
        if (m === 'POST' && p === '/api/admin/timeoff') { const b = await readBody(req); return send(res, 201, B.addTimeOff(db, +b.staffId, b.day, b.note)); }
        if (m === 'POST' && (mm = /^\/api\/admin\/timeoff\/(\d+)\/delete$/.exec(p))) { db.prepare('DELETE FROM time_off WHERE id=?').run(+mm[1]); return send(res, 200, { ok: true }); }
        throw new B.BookingError('Not found', 404);
      }
      if (m !== 'GET') throw new B.BookingError('Not found', 404);
      const file = p === '/' ? '/index.html' : p === '/admin' ? '/admin.html' : p;
      const full = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[\/\\])+/, ''));
      if (!full.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) throw new B.BookingError('Not found', 404);
      return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
    } catch (e) {
      if (e instanceof B.BookingError) return send(res, e.status, { error: e.message });
      console.error(e); return send(res, 500, { error: 'Server error' });
    }
  });
}
module.exports = { createApp };
if (require.main === module) {
  const db = open(process.env.DB || 'clinic.db');
  if (!db.prepare('SELECT 1 FROM services').get()) { require('./seed').seedDefaults(db); if (process.env.SEED_DEMO === '1') require('./seed').seedDemoBookings(db); }
  const host = process.env.HOST || '127.0.0.1', port = +process.env.PORT || 3000;
  createApp(db).listen(port, host, () => { console.log(`ClinicDesk on http://${host}:${port} (local only unless HOST is set)`); if (needsSetup(db)) console.log('No staff account yet: open /admin to create one.'); });
}
