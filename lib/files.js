'use strict';
// The public file folder (FLEET_FILES_DIR, default files/ in the app folder, at FLEET_FILES_PATH, default /files/):
// put files in it and anyone who can reach the server can browse and download them, no password, over HTTPS and
// plain HTTP. Read-only (GET/HEAD); folders get a browsable index; hidden (dot) files and folders are never served.
//
// Every response carries `Content-Security-Policy: sandbox`, so an HTML file in the folder opens in a sandbox
// (no scripts, its own opaque origin) and can't act as the signed-in page on the same server.
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB`
  : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const SORTS = { name: 'name', size: 'size', time: 'time' };

const STYLE = `:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--mut:#6b7280;--line:#e5e7eb;--acc:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--fg:#e6e9ef;--mut:#9aa3b2;--line:#262c38;--acc:#6ea0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:20px 16px 40px}h1{font-size:20px;margin:0 0 4px}
.crumbs{color:var(--mut);margin-bottom:16px;word-break:break-all}.crumbs a{color:var(--acc);text-decoration:none}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow-x:auto}
table{width:100%;border-collapse:collapse}th,td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-size:13px;color:var(--mut);font-weight:600}th a{color:inherit;text-decoration:none}tr:last-child td{border-bottom:0}
td.n{white-space:normal;word-break:break-all;width:100%}td.r,th.r{text-align:right}td a{color:var(--fg);text-decoration:none}
td a:hover{color:var(--acc);text-decoration:underline}.ic{display:inline-block;width:1.4em}.mut{color:var(--mut)}
.dl{color:var(--mut)!important;font-size:13px}.empty{padding:24px;text-align:center;color:var(--mut)}
@media (max-width:600px){.t{display:none}}`;

function listing(dir, urlPath, sort, desc) {
  const rows = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith('.')).map((d) => {
    let st; try { st = fs.statSync(path.join(dir, d.name)); } catch { return null; }
    if (!st.isDirectory() && !st.isFile()) return null;
    return { name: d.name, dir: st.isDirectory(), size: st.size, mtime: st.mtime };
  }).filter(Boolean);
  const cmp = { name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
    size: (a, b) => a.size - b.size, time: (a, b) => a.mtime - b.mtime }[sort];
  rows.sort((a, b) => b.dir - a.dir || (desc ? -cmp(a, b) : cmp(a, b)));

  const parts = urlPath.split('/').filter(Boolean).map((p) => decodeURIComponentSafe(p) ?? p);
  const crumbs = parts.map((p, i) => `<a href="/${parts.slice(0, i + 1).map(encodeURIComponent).join('/')}/">${esc(p)}</a>`).join(' / ');
  const head = (key, label, cls = '') => {
    const next = sort === key && !desc ? '?sort=' + key + '&desc=1' : '?sort=' + key;
    return `<th class="${cls}"><a href="${next}">${label}${sort === key ? (desc ? ' ↓' : ' ↑') : ''}</a></th>`;
  };
  const files = rows.filter((r) => !r.dir), total = files.reduce((n, r) => n + r.size, 0);
  const tr = (r) => {
    const href = esc(encodeURIComponent(r.name) + (r.dir ? '/' : ''));
    return `<tr><td class="n"><span class="ic">${r.dir ? '📁' : '📄'}</span><a href="${href}">${esc(r.name)}${r.dir ? '/' : ''}</a></td>` +
      `<td class="r">${r.dir ? '<span class="mut">—</span>' : size(r.size)}</td>` +
      `<td class="t mut">${r.mtime.toISOString().slice(0, 16).replace('T', ' ')} UTC</td>` +
      `<td class="r">${r.dir ? '' : `<a class="dl" href="${href}?download=1" title="Download">⬇</a>`}</td></tr>`;
  };
  const up = parts.length > 1 ? '<tr><td class="n" colspan="4"><span class="ic">↩</span><a href="../">Parent folder</a></td></tr>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Files: /${esc(parts.join('/'))}/</title><style>${STYLE}</style></head><body><main>
<h1>Public files</h1><div class="crumbs">${crumbs}</div>
<div class="card"><table><thead><tr>${head('name', 'Name')}${head('size', 'Size', 'r')}${head('time', 'Modified', 't')}<th></th></tr></thead><tbody>
${up}${rows.map(tr).join('') || '<tr><td colspan="4" class="empty">This folder is empty.</td></tr>'}</tbody></table></div>
<p class="mut">${rows.length - files.length} folder${rows.length - files.length === 1 ? '' : 's'}, ${files.length} file${files.length === 1 ? '' : 's'} (${size(total)})</p>
</main></body></html>`;
}

// The router for `mount` (e.g. "/files/"), serving the folder `root`.
function router(root, mount) {
  const base = mount.replace(/\/$/, '');
  const r = express.Router();
  r.use((req, res, next) => {
    res.set({ 'Content-Security-Policy': 'sandbox allow-downloads', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).set('Allow', 'GET, HEAD').type('text/plain').send('read-only\n');
    if (req.query.download === '1') res.attachment(path.basename(decodeURIComponentSafe(req.path)));
    next();
  });
  r.use(express.static(root, { index: false, dotfiles: 'ignore', redirect: false }));
  r.use((req, res, next) => {
    const rel = decodeURIComponentSafe(req.path);
    if (rel === null || rel.includes('\0') || rel.split('/').some((p) => p.startsWith('.'))) return next();
    const dir = path.join(root, rel);
    if (dir !== root && !dir.startsWith(root + path.sep)) return next();
    let st; try { st = fs.statSync(dir); } catch { return next(); }
    if (!st.isDirectory()) return next();
    if (!req.path.endsWith('/')) return res.redirect(302, `${base}${req.path}/`);
    const sort = SORTS[req.query.sort] || 'name';
    res.type('html').send(listing(dir, base + req.path, sort, req.query.desc === '1'));
  });
  r.use((req, res) => res.status(404).type('text/plain').send('not found\n'));
  return r;
}
function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch { return null; } }

// Adds the folder to an express app: `mount` without its slash redirects to it.
function mountOn(app, root, mount) {
  app.get(mount.slice(0, -1), (req, res, next) => (req.path.endsWith('/') ? next() : res.redirect(302, mount)));
  app.use(mount, router(root, mount));
}

module.exports = { router, mountOn };
