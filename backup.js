'use strict';
// node backup.js backup clinic.db out.db   (consistent copy, verified, never overwrites)
// node backup.js verify some.db            (integrity check only; changes nothing)
// node backup.js restore backup.db clinic.db  (server stopped; old file kept as clinic.db.before-restore-<time>)
const { open, backup, restore, verify } = require('./db');
const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'backup' && a && b) { const r = backup(open(a), b); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }
else if (cmd === 'verify' && a) { const r = verify(a); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }
else if (cmd === 'restore' && a && b) { try { const r = restore(a, b); console.log(JSON.stringify(r)); } catch (e) { console.error('restore refused: ' + e.message); process.exit(1); } }
else { console.error('usage: node backup.js backup <db> <new-file> | verify <file> | restore <backup-file> <target-db>   (stop the server before restore)'); process.exit(2); }
