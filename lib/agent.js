'use strict';
// Agents connect to us: each machine's fleet-agent keeps a WebSocket open to wss://<server>/agent, says hello with its
// key + hostname, pushes stats every 5 s and answers our calls ({type: 'call', id, op, body}).
// Keys: `fleet-agent.js --install` gets a code from POST /enroll; the code must be used in a hello within 1 minute,
// which activates it as that machine's permanent key (only its sha256 is stored). Unused codes are deleted.
// A new machine is 'pending' until the user approves it on the page: it may stay connected, but no calls are sent
// to it (and it can't be given services) unless its status is 'approved'.
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const db = require('./db');

const CODE_TTL_SEC = 60;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const dropExpiredCodes = () => db.run('DELETE FROM machines WHERE activated_at IS NULL AND created_at < ?', db.ago(CODE_TTL_SEC));

// POST /enroll: a new code (64 hex), valid for CODE_TTL_SEC until the agent's first hello activates it.
function enroll() {
  dropExpiredCodes();
  const code = crypto.randomBytes(32).toString('hex');
  db.run('INSERT INTO machines (key_sha256) VALUES (?)', sha256(code));
  return { code, expires_in_sec: CODE_TTL_SEC };
}

// First free display name for a hostname: "box", then "box-2", "box-3", ... (names are unique; the key is the identity).
function freeName(hostname, id) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? hostname : `${hostname}-${n}`;
    if (!db.get('SELECT id FROM machines WHERE name = ? AND id <> ?', name, id)) return name;
  }
}

// Hello: find the machine by key (a pending code is activated as a new, unapproved machine). The display name follows
// the hostname, with a -2/-3 suffix if another machine already has it. Returns the machine name or null (unknown key).
function identify(key, hostname, address) {
  dropExpiredCodes();
  const m = db.get('SELECT * FROM machines WHERE key_sha256 = ?', sha256(key));
  if (!m) return null;
  // Keep the current name while it still matches the hostname (as is, or with its -N suffix); otherwise pick a free one.
  const matches = m.name === hostname || (m.name?.startsWith(`${hostname}-`) && /^\d+$/.test(m.name.slice(hostname.length + 1)));
  const name = matches ? m.name : freeName(hostname, m.id);
  if (!m.activated_at) {
    db.run(`UPDATE machines SET activated_at = ${db.NOW}, sort_order = (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM machines) WHERE id = ?`, m.id);
    console.log(`[agent] code activated: new machine ${name}, waiting for approval`);
  }
  db.run('UPDATE machines SET name = ?, address = ? WHERE id = ?', name, address, m.id);
  return name;
}

const conns = new Map();   // machine -> { ws, stats, since }
const pending = new Map(); // call id -> { resolve, reject, timer, machine }
let nextId = 1;
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });

function onConnection(ws, req) {
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
  let machine = null;
  const helloTimer = setTimeout(() => ws.close(4001, 'no hello'), 10000);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!machine) {
      if (m.type !== 'hello' || typeof m.machine !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(m.machine)
        || typeof m.key !== 'string' || !/^[0-9a-f]{64}$/.test(m.key)) return ws.close(4002, 'bad hello');
      clearTimeout(helloTimer);
      const name = identify(m.key, m.machine, ip); // synchronous, so no other message can arrive in between
      if (!name) { console.log(`[agent] refused ${m.machine} from ${ip}: unknown or expired key`); return ws.close(4003, 'unknown or expired key'); }
      machine = name;
      conns.get(machine)?.ws.close(4000, 'replaced by a new connection');
      conns.set(machine, { ws, stats: m.stats, since: Date.now() });
      ws.send(JSON.stringify({ type: 'welcome' }));
      return console.log(`[agent] ${machine} connected from ${ip}`);
    }
    const c = conns.get(machine);
    if (c?.ws !== ws) return;
    if (m.type === 'stats') c.stats = m.stats;
    else if (m.type === 'result' && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(httpErr(502, `${machine}: ${m.error}`)); else p.resolve(m.data);
    }
  });
  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (!machine || conns.get(machine)?.ws !== ws) return;
    conns.delete(machine);
    console.log(`[agent] ${machine} disconnected`);
    for (const [id, p] of pending) if (p.machine === machine) { pending.delete(id); clearTimeout(p.timer); p.reject(httpErr(502, `${machine}: agent disconnected`)); }
  });
}

// Hook into the HTTP server (nginx passes the WebSocket upgrade through). Dead connections are dropped after a missed ping.
function attach(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 << 20 });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/agent') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
  });
  setInterval(() => {
    for (const ws of wss.clients) { if (!ws.isAlive) ws.terminate(); else { ws.isAlive = false; ws.ping(); } }
  }, 30000).unref();
}

// call('web-1', 'start', {...}) -> the agent's reply data; not connected / agent error / no reply become HTTP errors.
async function call(machine, op, body, { timeoutMs = 30000 } = {}) {
  const c = conns.get(machine);
  if (!c) throw httpErr(502, `${machine}: agent not connected`);
  if (db.get('SELECT status FROM machines WHERE name = ?', machine)?.status !== 'approved') throw httpErr(403, `${machine} is not approved`);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(httpErr(504, `${machine}: no reply from agent`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer, machine });
    c.ws.send(JSON.stringify({ type: 'call', id, op, body }));
  });
}

const state = (machine) => conns.get(machine) || null;
// Close a machine's connection (after it was removed: its key no longer exists, so it can't come back).
const kick = (machine) => conns.get(machine)?.ws.close(4004, 'machine removed');

module.exports = { attach, call, state, kick, enroll, dropExpiredCodes };
