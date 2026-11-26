// Role-aware admin UI check in a real Chrome: owner vs reception, same day, same data (fictional demo bookings only).
const { launch } = require('./cdp.js'); const { spawn } = require('node:child_process'); const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert');
const { open, createUser } = require('../db'); const { seedDefaults, seedDemoBookings } = require('../seed');
const dbf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cderoles-')), 'clinic.db'); const PORT = 3458, U = `http://127.0.0.1:${PORT}`;
const PW = crypto.randomBytes(9).toString('base64url'); const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const db = open(dbf); seedDefaults(db); seedDemoBookings(db); createUser(db, 'owner1', PW, 'owner'); createUser(db, 'front1', PW, 'reception'); db.close();
  const srv = spawn('node', ['--no-warnings', 'server.js'], { env: { ...process.env, DB: dbf, PORT, CLINIC_TZ: 'Africa/Cairo' }, cwd: path.join(__dirname, '..') });
  await sleep(1500);
  for (const [user, role] of [['front1', 'reception'], ['owner1', 'owner']]) {
    const D = await launch(1100, 800, false);
    await D.goto(U + '/admin'); await D.type('#u', user); await D.type('#p', PW); await D.click('#lf button'); for (let i = 0; i < 30 && !(await D.ev(`document.getElementById('d').value`)); i++) await sleep(200);
    // step through the next days until the schedule shows demo bookings
    for (let k = 1; k <= 7; k++) {
      await D.ev(`(()=>{const e=document.getElementById('d');const d=new Date(e.dataset.base||e.value);e.dataset.base=e.dataset.base||e.value;const b=new Date(e.dataset.base+'T00:00:00Z');b.setUTCDate(b.getUTCDate()+${k});e.value=b.toISOString().slice(0,10);e.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(700);
      if (await D.ev(`document.querySelectorAll('#rows tr').length`) > 0) break;
    }
    const rows = await D.ev(`document.querySelectorAll('#rows tr').length`);
    const tabs = await D.ev(`[...document.querySelectorAll('.tabs button')].filter(b=>!b.hidden).map(b=>b.textContent).join('|')`);
    const stats = await D.ev(`document.getElementById('stats').textContent.length>0`);
    const err = await D.ev(`document.getElementById('amsg').hidden?'':document.getElementById('amsg').textContent`);
    const who = await D.ev(`document.getElementById('who').textContent`);
    console.log(role, { who, rows, tabs, statsVisible: stats, err });
    console.log(await D.ev('document.getElementById("rows").textContent.slice(0,200)')); assert.ok(rows > 0, role + ': schedule rows visible'); assert.strictEqual(err, '', role + ': no error banner');
    if (role === 'reception') { assert.strictEqual(tabs, 'Schedule|Next 7 days|Clients'); assert.strictEqual(stats, false); }
    else { assert.match(tabs, /Services\|Staff and hours/); assert.strictEqual(stats, true); }
    await D.shot(`docs/roles-${role}-schedule.png`, false); D.close();
  }
  srv.kill(); console.log('ROLES E2E PASS'); process.exit(0);
})().catch(e => { console.error('ROLES E2E FAIL', e); process.exit(1); });
