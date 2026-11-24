// Builds a realistic fictional clinic (names and phone numbers are invented) with past and upcoming bookings, then takes presentation screenshots.
// Past visits are inserted straight into the database because the booking API refuses past dates by design.
const { launch } = require('./cdp.js'); const { spawn } = require('node:child_process'); const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { open, createUser } = require('../db'); const B = require('../booking'); const { seedDefaults } = require('../seed');
const dbf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdshow-')), 'clinic.db'), PORT = 3461, U = `http://127.0.0.1:${PORT}`, PW = crypto.randomBytes(9).toString('base64url');
const db = open(dbf); seedDefaults(db); createUser(db, 'owner', PW);
const today = B.clinicNow(db).day, add = n => new Date(Date.parse(today + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const people = [['Salma Fathy', '+20 100 555 0101'], ['Karim Soliman', '+20 100 555 0102'], ['Mona Adel', '+20 100 555 0103'], ['Youssef Hamdy', '+20 100 555 0104'], ['Hana Mostafa', '+20 100 555 0105'], ['Tarek Ibrahim', '+20 100 555 0106'], ['Dina Reda', '+20 100 555 0107']];
const wd = d => new Date(d + 'T00:00:00Z').getUTCDay(); const working = d => wd(d) <= 4; // Sun to Thu
const svcMin = [30, 30, 60, 60]; let seq = 0;
const ins = (p, d, start, svc, staff, status) => db.prepare('INSERT INTO appointments(code,service_id,staff_id,customer,phone,day,start_min,end_min,status) VALUES(?,?,?,?,?,?,?,?,?)').run(crypto.randomBytes(16).toString('hex').toUpperCase(), svc, staff, p[0], p[1], d, start, start + svcMin[svc - 1], status);
// 4 weeks of history: completed visits, a few no-shows and cancellations, no overlaps (one staff member, one slot per day-time)
for (let n = -28; n < 0; n++) { const d = add(n); if (!working(d)) continue; for (const [i, t] of [540, 630, 780].entries()) { const p = people[(seq++) % people.length]; const r = (seq * 7) % 11; ins(p, d, t, 1 + (seq % 4), 1 + (i % 3) === 3 ? 1 : 1 + i % 2, r === 3 ? 'no_show' : r === 6 ? 'cancelled' : 'completed'); } }
const start = () => new Promise(r => { const p = spawn('node', ['--no-warnings', 'server.js'], { env: { ...process.env, DB: dbf, PORT }, cwd: path.join(__dirname, '..') }); let o = ''; p.stdout.on('data', d => { o += d; if (o.includes('ClinicDesk on')) r(p); }); });
(async () => {
  db.exec('PRAGMA wal_checkpoint'); const srv = await start();
  // upcoming bookings through the real booking rules
  const now = new Date(); let n = 0;
  for (let d = 0; d <= 6 && n < 14; d++) for (const [i, t] of ['09:00', '10:30', '13:00'].entries()) { const day = add(d); if (!working(day)) continue; try { const p = people[(n + i) % people.length]; const r = await fetch(U + '/api/book', { method: 'POST', body: JSON.stringify({ customer: p[0], phone: p[1], serviceId: 1 + (n + i) % 4, staffId: 1 + (n + i) % 3, day, time: t }) }); if (r.ok) n++; } catch {} }
  const D = await launch(1280, 900, false);
  await D.goto(U + '/admin'); await D.type('#u', 'owner'); await D.type('#p', PW); await D.click('#lf button'); await sleep(1000);
  await D.ev(`(()=>{const d=document.getElementById('d');d.value='${add(1)}';d.dispatchEvent(new Event('change'))})()`); await sleep(800); await D.shot('docs/showcase-1-schedule.png', false);
  await D.click('.tabs button[data-t=agn]'); await sleep(800); await D.shot('docs/showcase-2-next-7-days.png', false);
  await D.click('.tabs button[data-t=cli]'); await sleep(800); await D.shot('docs/showcase-3-clients.png', false);
  await D.click('#crows [data-h]'); await sleep(600); await D.shot('docs/showcase-4-client-history.png', false);
  D.close();
  const M = await launch(390, 844, true); await M.goto(U + '/admin'); await M.type('#u', 'owner'); await M.type('#p', PW); await M.click('#lf button'); await sleep(1000);
  await M.click('.tabs button[data-t=agn]'); await sleep(800); await M.shot('docs/showcase-5-mobile-next-7-days.png', false);
  await M.click('.tabs button[data-t=cli]'); await sleep(800); await M.shot('docs/showcase-6-mobile-clients.png', false);
  M.close(); srv.kill(); console.log('showcase done, upcoming bookings:', n); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
