'use strict';
// fleet-server admin (all data lives in MariaDB). Run on the server, in the fleet-server folder:
//   node bin/admin.js password <new password>   set the web site password (existing sessions stay signed in)
//   node bin/admin.js default-user <user>        Linux user for services that don't name one
//   node bin/admin.js machines                   list machines (enrolled with fleet-agent.js --install)
//   node bin/admin.js remove-machine <name>      forget a machine and its key (not while it has services)
const db = require('../lib/db');
const { hash } = require('../lib/web-auth');

const [cmd, ...args] = process.argv.slice(2);
const usage = () => { console.error(require('node:fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 6).map((l) => l.slice(3)).join('\n')); process.exit(1); };

(async () => {
  await db.migrate();
  if (cmd === 'password' && args[0]) {
    await db.setSetting('password', JSON.stringify(hash(args[0])));
    console.log('password set');
  } else if (cmd === 'default-user' && /^[a-z_][a-z0-9_-]{0,31}$/.test(args[0] || '')) {
    await db.setSetting('default_run_as', args[0]);
    console.log(`services without a user now run as ${args[0]}`);
  } else if (cmd === 'machines') {
    const [rows] = await db.pool.query('SELECT id, name, address, activated_at, key_sha256 IS NOT NULL AS has_key FROM machines ORDER BY sort_order, id');
    for (const r of rows) console.log([r.id, r.name ?? '(pending code)', r.address ?? '-', r.activated_at ? 'active' : r.has_key ? 'pending' : 'no key yet'].join('\t'));
  } else if (cmd === 'remove-machine' && args[0]) {
    const [r] = await db.pool.query('DELETE FROM machines WHERE name=?', [args[0]]).catch((e) => {
      throw new Error(e.code === 'ER_ROW_IS_REFERENCED_2' ? `${args[0]} still has services: delete or move them first` : e.message);
    });
    console.log(r.affectedRows ? `${args[0]} removed (its agent can no longer connect)` : 'no such machine');
  } else usage();
  await db.pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
