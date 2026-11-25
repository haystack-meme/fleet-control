'use strict';
// Settings, from the environment or an optional .env file in the app folder (git-ignored; see README):
//   FLEET_DATA_DIR      where the database and the TLS certificate live (default: data/ in the app folder)
//   FLEET_HOST          address to listen on (default 0.0.0.0)
//   FLEET_HTTPS_PORT    HTTPS port (default 443)
//   FLEET_HTTP_PORT     plain HTTP port that only redirects to HTTPS (default 80; 0 = off)
//   FLEET_FILES_DIR     the public file folder: whatever is put in it can be downloaded and browsed by anyone, no
//                       password, over HTTPS and plain HTTP (default: files/ in the app folder; "off" turns it off) ...
//   FLEET_FILES_PATH    ... at this URL path (default /files/)
const path = require('node:path');

const root = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }

const env = process.env;
const port = (name, dflt) => {
  const n = Number(env[name] ?? dflt);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number`);
  return n;
};
const filesPath = env.FLEET_FILES_PATH || '/files/';
if (!/^\/[A-Za-z0-9._-]+\/$/.test(filesPath) || ['/api/', '/install/', '/login/', '/agent/', '/health/', '/enroll/'].includes(filesPath))
  throw new Error('FLEET_FILES_PATH must look like /files/ (one folder name, not api, install, login, agent, health or enroll)');
const filesDir = env.FLEET_FILES_DIR ?? 'files';

module.exports = {
  root,
  dataDir: path.resolve(root, env.FLEET_DATA_DIR || 'data'),
  host: env.FLEET_HOST || '0.0.0.0',
  httpsPort: port('FLEET_HTTPS_PORT', 443),
  httpPort: port('FLEET_HTTP_PORT', 80),
  filesDir: filesDir === 'off' || filesDir === '' ? null : path.resolve(root, filesDir),
  filesPath,
};
