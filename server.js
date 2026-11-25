'use strict';
const path = require('node:path');
const express = require('express');
const agent = require('./lib/agent');
const db = require('./lib/db');
const webAuth = require('./lib/web-auth');
const services = require('./lib/services');
const backup = require('./lib/backup');

const pub = path.join(__dirname, 'public');
const app = express();
// The TLS proxy in front is trusted for the client's address. Default loopback (proxy on the same host);
// Docker sets FLEET_TRUST_PROXY=uniquelocal (the proxy container is on a private network).
app.set('trust proxy', process.env.FLEET_TRUST_PROXY || 'loopback');
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

// Public: the agent and its unit template, for `curl -k https://<server>/install/fleet-agent.js` on a new machine.
// Served from ./agent, or FLEET_AGENT_DIR (e.g. a root-owned copy).
const agentDir = process.env.FLEET_AGENT_DIR || path.join(__dirname, 'agent');
for (const f of ['fleet-agent.js', 'fleet-agent.service'])
  app.get(`/install/${f}`, (req, res) => res.type(f.endsWith('.js') ? 'application/javascript' : 'text/plain').sendFile(path.join(agentDir, f)));

// Public: `fleet-agent.js --install` gets its code here (valid 1 minute; the agent's first hello makes it its key).
app.post('/enroll', (req, res) => {
  const out = agent.enroll();
  console.log(`[agent] enrollment code issued to ${req.ip}`);
  res.json(out);
});

// Web site: the login page is public, the main page needs a session.
app.get('/login', (req, res) => res.sendFile(path.join(pub, 'login.html')));
app.post('/login', webAuth.login);
app.post('/logout', webAuth.logout);
app.get('/', (req, res) => webAuth.valid(req) ? res.sendFile(path.join(pub, 'index.html')) : res.redirect(302, '/login'));

// API: needs a signed-in web session (the password is the only security).
app.use('/api', (req, res, next) => (webAuth.valid(req) ? next() : res.status(401).json({ error: 'sign in first' })));

// Machines: is the agent connected (online)? + the latest stats it pushed.
// status: pending (new, waiting for the user) | approved | rejected; stats only for approved machines.
app.get('/api/machines', (req, res) => {
  res.json(Object.entries(db.machines()).map(([name, m]) => {
    const c = agent.state(name), out = { name, address: m.address, status: m.status, online: !!c };
    if (c && m.status === 'approved') out.stats = c.stats;
    return out;
  }));
});

// Approve / reject a machine. Rejected stays rejected until approved.
for (const [action, status] of [['approve', 'approved'], ['reject', 'rejected']])
  app.post(`/api/machines/:name/${action}`, (req, res) => {
    if (status === 'rejected') {
      const { n } = db.get('SELECT COUNT(*) AS n FROM services s JOIN machines m ON m.id = s.machine_id WHERE m.name = ?', req.params.name);
      if (n) return res.status(409).json({ error: `${req.params.name} has ${n} service${n === 1 ? '' : 's'}: delete or move them before rejecting it` });
    }
    const r = db.run(`UPDATE machines SET status = ?, decided_at = ${db.NOW} WHERE name = ? AND activated_at IS NOT NULL`, status, req.params.name);
    if (!r.changes) return res.status(404).json({ error: 'no such machine' });
    console.log(`[agent] ${req.params.name} ${status}`);
    res.json({ ok: true, status });
  });

// Remove a machine (and its key). Refused while it still has services.
app.delete('/api/machines/:name', (req, res) => {
  const m = db.get('SELECT id FROM machines WHERE name = ? AND activated_at IS NOT NULL', req.params.name);
  if (!m) return res.status(404).json({ error: 'no such machine' });
  const { n } = db.get('SELECT COUNT(*) AS n FROM services WHERE machine_id = ?', m.id);
  if (n) return res.status(409).json({ error: `${req.params.name} still has ${n} service${n === 1 ? '' : 's'}: delete or move them first` });
  db.run('DELETE FROM machines WHERE id = ?', m.id);
  agent.kick(req.params.name);
  console.log(`[agent] ${req.params.name} removed`);
  res.json({ ok: true });
});

// Services (definitions in the database, run on each machine by its fleet-agent).
app.get('/api/services', async (req, res) => res.json(await services.listWithStatus()));
app.post('/api/services', async (req, res) => res.status(201).json(await services.create(req.body || {})));
app.get('/api/services/:name', async (req, res) => {
  const svc = await services.get(req.params.name);
  try { svc.status = await services.status(svc); } catch (e) { svc.status = { error: e.message }; }
  res.json(svc);
});
app.put('/api/services/:name', async (req, res) => res.json(await services.update(req.params.name, req.body || {})));
// ?force=1: delete even if its machine can't be reached (the unit may still be running there).
app.delete('/api/services/:name', async (req, res) => { await services.remove(req.params.name, { force: req.query.force === '1' }); res.json({ ok: true }); });
for (const action of ['start', 'stop', 'restart'])
  app.post(`/api/services/:name/${action}`, async (req, res) => res.json(await services[action](req.params.name)));
app.get('/api/services/:name/versions', async (req, res) => res.json(await services.versions(req.params.name)));
app.post('/api/services/:name/rollback', async (req, res) => res.json(await services.rollback(req.params.name, Number((req.body || {}).version))));
app.get('/api/services/:name/logs', async (req, res) => res.type('text/plain').send(await services.logs(req.params.name, req.query.lines)));

// Backup: the whole database as a file. Restore: replace machines, settings and services from such a file (sessions
// are kept). Agents are then disconnected so each one is identified again against the restored machines.
app.get('/api/backup', (req, res) => {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  res.attachment(`fleet-${stamp}.db.gz`).type('application/gzip').send(backup.backupGz());
});
app.post('/api/restore', express.raw({ type: '*/*', limit: '200mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'no file' });
  const counts = backup.restore(req.body);
  agent.kickAll();
  console.log(`[backup] restored from an upload by ${req.ip}: ${counts.machines} machines, ${counts.services} services`);
  res.json({ ok: true, ...counts });
});

app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message, ...(err.canForce && { can_force: true }) });
});

db.migrate();
console.log(`database: ${db.file}`);
{
  const every = (ms, fn) => setInterval(() => { try { fn(); } catch (e) { console.error(e); } }, ms).unref();
  every(60 * 60 * 1000, webAuth.prune);
  every(60 * 1000, agent.dropExpiredCodes);
  // Behind a TLS proxy (see deploy/nginx.conf.example). Overrides: FLEET_HOST, FLEET_PORT.
  const host = process.env.FLEET_HOST || '127.0.0.1', port = Number(process.env.FLEET_PORT || 3100);
  agent.attach(app.listen(port, host, () => console.log(`fleet-server on ${host}:${port}`)));
}
