// End-to-end check with a real server process, a real Chrome, a file database and a restart in the middle.
const { launch } = require('./cdp.js'); const { spawn } = require('node:child_process'); const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert');
const dbf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cde2e-')), 'clinic.db'); const PORT = 3457, U = `http://127.0.0.1:${PORT}`;
const PW = crypto.randomBytes(9).toString('base64url'); // random per run, never printed or stored
const start = () => new Promise(r => { const p = spawn('node', ['--no-warnings', 'server.js'], { env: { ...process.env, DB: dbf, PORT, SEED_DEMO: '1', CLINIC_TZ: 'Africa/Cairo' }, cwd: path.join(__dirname, '..') }); let out = ''; p.stdout.on('data', d => { out += d; if (out.includes('ClinicDesk on')) r({ p, out }); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let srv = await start(); console.log(srv.out.trim());
  // bound to loopback only?
  const ss = require('node:child_process').execSync(`ss -ltn | grep ${PORT} || true`).toString(); console.log('listen:', ss.trim()); assert.match(ss, /127\.0\.0\.1:3457/);
  const D = await launch(1280, 900, false);
  await D.goto(U + '/admin'); await D.shot('docs/01-first-run-setup.png', false);
  await D.type('#su', 'owner'); await D.type('#sp', PW); await D.click('#sf button'); await sleep(900);
  assert.ok(await D.ev(`!document.getElementById('app').hidden`), 'app visible after setup');
  await D.shot('docs/02-schedule-desktop.png', false);
  await D.click('.tabs button[data-t=svc]'); await D.ev(`document.querySelector('#srows .f-p').value='45'`); await D.click('#srows .save'); await sleep(600); await D.shot('docs/03-services-edit-saved.png', false);
  await D.click('.tabs button[data-t=stf]'); await D.shot('docs/04-staff-hours.png', true);
  // public booking
  await D.goto(U + '/'); await D.click('.slot'); await D.type('#name', 'Persistence Check'); await D.type('#phone', '000 0000 0099'); await D.click('#go'); await sleep(600);
  const code = await D.ev(`document.getElementById('code').textContent`); assert.strictEqual(code.length, 32); await D.shot('docs/05-booking-confirmed.png', false);
  D.close();
  // restart
  srv.p.kill(); await sleep(800); srv = await start(); console.log('restarted');
  const M = await launch(390, 844, true);
  await M.goto(U + '/admin'); await M.type('#u', 'owner'); await M.type('#p', PW); await M.click('#lf button'); await sleep(900);
  assert.ok(await M.ev(`!document.getElementById('app').hidden`), 'login works after restart');
  const day = await M.ev(`fetch('/api/admin/overview').then(r=>r.json()).then(o=>o.today)`);
  const svc = await M.ev(`fetch('/api/admin/overview').then(r=>r.json()).then(o=>o.services[0].price)`); assert.strictEqual(svc, 45); console.log('service price persisted:', svc);
  // find the day of the persistence booking
  const info = await M.ev(`(async()=>{for(let i=1;i<9;i++){const d=new Date(Date.parse('${day}T00:00:00Z')+i*864e5).toISOString().slice(0,10);const a=(await fetch('/api/admin/appointments?day='+d).then(r=>r.json())).appointments;if(a.find(x=>x.code==='${code}'))return {d,n:a.length}}return null})()`);
  assert.ok(info, 'booking persisted across restart'); console.log('booking persisted on', info.d);
  await M.type('#d', info.d); await sleep(700); await M.shot('docs/06-mobile-schedule-after-restart.png', true);
  const find = s => `[...document.querySelectorAll('#rows tr')].find(r=>r.textContent.includes('Persistence Check')).querySelector(${JSON.stringify(s)})`;
  await M.ev(`${find('[data-mv]')}.click()`); await sleep(700); await M.shot('docs/06b-mobile-move-dialog.png', false);
  await M.ev(`document.querySelector('#mslots .slot[data-t="16:30"]').click()`); await sleep(200); await M.ev(`document.getElementById('mgo').click()`); await sleep(900);
  const moved = await M.ev(`fetch('/api/admin/appointments?day=${info.d}').then(r=>r.json()).then(o=>o.appointments.find(x=>x.code==='${code}'))`); console.log('after move:', moved.start, moved.status); assert.strictEqual(moved.start, '16:30');
  await M.shot('docs/07-mobile-after-move.png', true);
  await M.ev(`${find('[data-s=completed]')}.click()`); await sleep(800);
  const done = await M.ev(`fetch('/api/admin/appointments?day=${info.d}').then(r=>r.json()).then(o=>o.appointments.find(x=>x.code==='${code}').status)`); assert.strictEqual(done, 'completed'); console.log('after complete:', done);
  await M.shot('docs/08-mobile-after-complete.png', true);
  // a second booking, cancelled from the mobile cards
  const b = await M.ev(`fetch('/api/book',{method:'POST',body:JSON.stringify({customer:'Cancel Check',phone:'000 0000 0098',serviceId:2,staffId:1,day:'${info.d}',time:'15:00'})}).then(r=>r.json())`);
  await M.ev(`load()`); await sleep(700);
  await M.ev(`[...document.querySelectorAll('#rows tr')].find(r=>r.textContent.includes('Cancel Check')).querySelector('[data-s=cancelled]').click()`); await sleep(800);
  const cs = await M.ev(`fetch('/api/booking/${b.booking.code}').then(r=>r.json()).then(o=>o.booking.status)`); assert.strictEqual(cs, 'cancelled'); console.log('after cancel:', cs);
  await M.shot('docs/09-mobile-after-cancel.png', true);
  await M.click('.tabs button[data-t=svc]'); await M.shot('docs/10-mobile-services.png', true);
  // clients tab (search, visit counts, history) and the next-7-days agenda with reminders
  await M.click('.tabs button[data-t=cli]'); await sleep(700);
  await M.type('#cq', 'Persistence'); await sleep(800);
  const crow = await M.ev(`document.querySelector('#crows tr')?.textContent||''`); assert.match(crow, /Persistence Check/); assert.match(crow, /1/); console.log('clients search:', crow.replace(/\s+/g, ' ').trim());
  await M.shot('docs/11-mobile-clients.png', true);
  await M.click('#crows [data-h]'); await sleep(600); const hist = await M.ev(`document.querySelector('#modal').textContent`); assert.match(hist, /completed/); await M.shot('docs/12-mobile-client-history.png', false);
  await M.click('#hx'); await M.click('.tabs button[data-t=agn]'); await sleep(800);
  const agn = await M.ev(`document.querySelectorAll('#agnbody [data-cp]').length`); assert.ok(agn > 0, 'agenda has reminders'); console.log('agenda rows with reminders:', agn);
  const wa = await M.ev(`document.querySelectorAll('#agnbody a[href^="https://wa.me/"]').length`); console.log('whatsapp links (only for numbers with a +country code; demo numbers get none):', wa); assert.strictEqual(wa, 0);
  await M.shot('docs/13-mobile-agenda.png', true);
  M.close(); srv.p.kill(); console.log('E2E PASS'); process.exit(0);
})().catch(e => { console.error('E2E FAIL', e); process.exit(1); });
