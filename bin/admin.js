'use strict';
// fleet-server admin (all data is in the SQLite database). Run on the server, in the fleet-server folder:
//   node bin/admin.js password <new password>   set the web site password (existing sessions stay signed in)
//   node bin/admin.js default-user <user>        Linux user for services that don't name one
//   node bin/admin.js machines                   list machines (enrolled with fleet-agent.js --install)
//   node bin/admin.js remove-machine <name>      forget a machine and its key (not while it has services)
//   node bin/admin.js backup <file>              backup file (.fleetbackup), as the page's download (safe while running)
const db = require('../lib/db');
const { hash } = require('../lib/web-auth');

const [cmd, ...args] = process.argv.slice(2);
const usage = () => { console.error(require('node:fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 7).map((l) => l.slice(3)).join('\n')); process.exit(1); };

try {
  db.migrate();
  if (cmd === 'password' && args[0]) {
    db.setSetting('password', JSON.stringify(hash(args[0])));
    console.log('password set');
  } else if (cmd === 'default-user' && /^[a-z_][a-z0-9_-]{0,31}$/.test(args[0] || '')) {
    db.setSetting('default_run_as', args[0]);
    console.log(`services without a user now run as ${args[0]}`);
  } else if (cmd === 'machines') {
    for (const r of db.all('SELECT id, name, address, status, activated_at FROM machines ORDER BY sort_order, id'))
      console.log([r.id, r.name ?? '(unused code)', r.address ?? '-', r.activated_at ? r.status : 'code'].join('\t'));
  } else if (cmd === 'remove-machine' && args[0]) {
    let r;
    try { r = db.run('DELETE FROM machines WHERE name = ?', args[0]); }
    catch (e) { throw db.isForeignKey(e) ? new Error(`${args[0]} still has services: delete or move them first`) : e; }
    console.log(r.changes ? `${args[0]} removed (its agent can no longer connect)` : 'no such machine');
  } else if (cmd === 'backup' && args[0]) {
    require('../lib/backup').backupTo(args[0]);
    console.log(`database copied to ${args[0]}`);
  } else usage();
} catch (e) { console.error(e.message); process.exit(1); }
