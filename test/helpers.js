'use strict';
// Test helpers: a throwaway fleet-server (own data folder, free ports), an HTTPS client for it, and a scripted
// fleet-agent that speaks the real agent protocol and keeps systemd's side in memory (recording every call).
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeoutMs = 5000, everyMs = 50, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

// One HTTP(S) request. body: object (sent as JSON) or Buffer (sent as is). Returns { status, headers, text, json, buf }.
function request(base, method, p, { body, headers = {} } = {}) {
  const url = new URL(p, base);
  const lib = url.protocol === 'https:' ? https : http;
  let data = null;
  if (Buffer.isBuffer(body)) data = body;
  else if (body !== undefined) { data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); headers = { 'Content-Type': 'application/json', ...headers }; }
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method, headers: { ...headers, ...(data && { 'Content-Length': data.length }) }, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks), text = buf.toString();
        let json; try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json, buf });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// A fleet-server in a temporary folder. env: extra settings.
async function startServer(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-'));
  const httpsPort = await freePort(), httpPort = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, FLEET_DATA_DIR: path.join(dir, 'data'), FLEET_FILES_DIR: path.join(dir, 'files'),
      FLEET_HOST: '127.0.0.1', FLEET_HTTPS_PORT: String(httpsPort), FLEET_HTTP_PORT: String(httpPort), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const base = `https://127.0.0.1:${httpsPort}`;
  const srv = {
    dir, base, httpBase: `http://127.0.0.1:${httpPort}`, httpsPort, proc, get log() { return log; },
    req: (method, p, opts) => request(base, method, p, opts),
    async stop() {
      if (proc.exitCode === null) { proc.kill(); await new Promise((r) => proc.once('exit', r)); }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  await until(async () => (await request(base, 'GET', '/health').catch(() => null))?.status === 200, { what: `server to start\n${log}` });
  return srv;
}

// A client bound to a server and a way of signing in: { cookie } or { key } (sent as Bearer) or { xKey }.
function client(srv, auth = {}) {
  const h = () => (auth.cookie ? { Cookie: auth.cookie } : auth.key ? { Authorization: `Bearer ${auth.key}` } : auth.xKey ? { 'X-API-Key': auth.xKey } : {});
  const c = {
    auth,
    req: (method, p, opts = {}) => srv.req(method, p, { ...opts, headers: { ...h(), ...(opts.headers || {}) } }),
    get: (p) => c.req('GET', p), post: (p, body) => c.req('POST', p, { body: body ?? {} }),
    put: (p, body) => c.req('PUT', p, { body }), del: (p) => c.req('DELETE', p),
  };
  return c;
}
// Signs in (setting the password first if none is set); returns the session cookie.
async function login(srv, password) {
  const r = await srv.req('POST', '/login', { body: { password } });
  if (r.status !== 200) throw new Error(`login ${r.status} ${r.text}`);
  return r.headers['set-cookie'][0].split(';')[0];
}

// A scripted agent. It enrolls (POST /enroll) or uses `key`, says hello as `hostname`, and answers show / start /
// stop / logs / probe like the real agent, with units kept in memory. `calls` records every call the server made.
// ops: the ops it announces in its hello (null = none, like agents from before health checks).
class FakeAgent {
  constructor(srv, hostname, { key = null, reconnect = true, ops = ['show', 'start', 'stop', 'logs', 'probe', 'remove'] } = {}) {
    Object.assign(this, { srv, hostname, key, reconnect, ops });
    this.health = new Map(); // url -> { ok, status } or { ok: false, error }; unknown urls: connection refused
    this.crashOnStart = new Set(); // units that exit with status 3 right after they start
    this.units = new Map(); // unit -> { active, sub, pid, startedAt, exitStatus, start: {the start call's body} }
    this.calls = [];
    this.closes = []; // [code, reason] of every closed connection
    this.welcomed = 0;
    this.hold = null; // op name -> Promise: delay the reply to that op until it resolves
    this.failNext = {}; // op name -> error message for the next such call
  }
  async enroll() {
    const r = await this.srv.req('POST', '/enroll');
    this.key = r.json.code;
    return r.json;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${this.srv.httpsPort}/agent`, { rejectUnauthorized: false });
      this.ws = ws;
      let settled = false;
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', machine: this.hostname, key: this.key, stats: this.stats(), ...(this.ops && { ops: this.ops }) })));
      ws.on('message', async (raw) => {
        const m = JSON.parse(raw);
        if (m.type === 'welcome') { this.welcomed++; if (!settled) { settled = true; resolve(this); } return; }
        if (m.type !== 'call') return;
        this.calls.push({ op: m.op, body: m.body });
        const reply = { type: 'result', id: m.id };
        try {
          if (this.hold?.[m.op]) await this.hold[m.op];
          if (this.failNext[m.op]) { const e = this.failNext[m.op]; delete this.failNext[m.op]; throw new Error(e); }
          reply.data = this.op(m.op, m.body) ?? null;
        } catch (e) { reply.error = e.message; }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
      });
      ws.on('close', (code, reason) => {
        this.closes.push([code, reason.toString()]);
        if (!settled) { settled = true; reject(Object.assign(new Error(`closed ${code} ${reason}`), { code })); return; }
        if (this.reconnect && !this.stopped && code !== 4003 && code !== 4004) setTimeout(() => this.connect().catch(() => {}), 50);
      });
      ws.on('error', () => {});
    });
  }
  stats() { return { uptime_sec: 100, cpu_pct: 5, cpus: 4, load: [0, 0, 0], mem_total_kb: 1000, mem_avail_kb: 500, swap_total_kb: 0, swap_free_kb: 0, disk_total_kb: 10, disk_used_kb: 5, gpus: [] }; }
  pushStats(extra = {}) { this.ws.send(JSON.stringify({ type: 'stats', stats: { ...this.stats(), ...extra } })); }
  op(op, body) {
    const unitOk = (u) => { if (!/^fleet-[a-z0-9][a-z0-9-]{0,39}\.service$/.test(u || '')) throw new Error('unit must be fleet-<name>.service'); return u; };
    if (op === 'show') return body.units.map((u) => {
      unitOk(u);
      const s = this.units.get(u);
      if (!s) return { ActiveState: 'inactive', SubState: 'dead', LoadState: 'not-found', MainPID: '0', ExecMainStartTimestamp: '', ExecMainStatus: '0' };
      return { ActiveState: s.active, SubState: s.sub, LoadState: 'loaded', MainPID: String(s.pid), ExecMainStartTimestamp: `@${s.startedAt}`, ExecMainStatus: String(s.exitStatus) };
    });
    if (op === 'start') {
      unitOk(body.unit);
      const cur = this.units.get(body.unit);
      if (cur && cur.active !== 'inactive' && cur.active !== 'failed') throw new Error(`systemd-run failed: Unit ${body.unit} was already loaded or has a fragment file.`);
      this.units.set(body.unit, { active: 'active', sub: 'running', pid: 1000 + this.calls.length, startedAt: Math.floor(Date.now() / 1000), exitStatus: 0, start: body });
      if (this.crashOnStart.has(body.unit)) setTimeout(() => Object.assign(this.units.get(body.unit), { active: 'failed', sub: 'failed', pid: 0, exitStatus: 3 }), 100);
      return undefined;
    }
    if (op === 'stop') { unitOk(body.unit); const s = this.units.get(body.unit); if (s) Object.assign(s, { active: 'inactive', sub: 'dead', pid: 0 }); return undefined; }
    if (op === 'logs') { unitOk(body.unit); return `log of ${body.unit} (lines=${body.lines})\n`; }
    if (op === 'remove' && this.ops?.includes('remove')) { unitOk(body.unit); this.units.delete(body.unit); return undefined; }
    if (op === 'probe' && this.ops?.includes('probe')) return body.urls.map((u) => this.health.get(u) || { ok: false, error: 'connect ECONNREFUSED' });
    throw new Error(`unknown op ${op}`);
  }
  close() { this.stopped = true; this.ws?.terminate(); }
}

module.exports = { startServer, client, login, request, FakeAgent, until, sleep, ROOT };
