'use strict';
// fleet-server's only command-line tool. Run on the server, in the fleet-server folder (Docker:
// `docker compose exec server node bin/admin.js clear-password`):
//   node bin/admin.js clear-password   remove the web password and sign everyone out; the next person to open the
//                                      page sets a new one
const db = require('../lib/db');
const webAuth = require('../lib/web-auth');

if (process.argv[2] !== 'clear-password' || process.argv.length !== 3) {
  console.error('usage: node bin/admin.js clear-password');
  process.exit(1);
}
db.migrate();
webAuth.clearPassword();
console.log('password cleared and everyone signed out: the next person to open the page sets a new one');
