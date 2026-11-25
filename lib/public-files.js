'use strict';
// Optional public file folder (FLEET_PUBLIC_DIR at FLEET_PUBLIC_PATH): anyone can read it, no password.
// GET/HEAD only; files are served as they are, folders get an HTML index. Hidden (dot) files are not served.
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const size = (n) => (n < 1024 ? `${n}` : n < 1048576 ? `${(n / 1024).toFixed(1)}K` : n < 1073741824 ? `${(n / 1048576).toFixed(1)}M` : `${(n / 1073741824).toFixed(1)}G`);

function listing(dir, urlPath) {
  const rows = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith('.'))
    .map((d) => {
      let st; try { st = fs.statSync(path.join(dir, d.name)); } catch { return null; }
      return { name: d.name + (st.isDirectory() ? '/' : ''), dir: st.isDirectory(), size: st.size, mtime: st.mtime };
    }).filter(Boolean).sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name));
  const tr = (r) => `<tr><td><a href="${esc(encodeURIComponent(r.name.replace(/\/$/, '')) + (r.dir ? '/' : ''))}">${esc(r.name)}</a></td>` +
    `<td>${r.mtime.toISOString().slice(0, 16).replace('T', ' ')} UTC</td><td style="text-align:right">${r.dir ? '-' : size(r.size)}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Index of ${esc(urlPath)}</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:24px}td{padding:2px 14px 2px 0}</style></head>
<body><h1 style="font-size:18px">Index of ${esc(urlPath)}</h1><table>${urlPath.split('/').length > 3 ? '<tr><td><a href="../">../</a></td></tr>' : ''}${rows.map(tr).join('')}</table></body></html>`;
}

function router(root, mount) {
  const r = express.Router();
  r.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).set('Allow', 'GET, HEAD').type('text/plain').send('read-only\n');
    next();
  });
  r.use(express.static(root, { index: false, dotfiles: 'ignore', redirect: true }));
  r.use((req, res, next) => {
    let rel; try { rel = decodeURIComponent(req.path); } catch { return next(); }
    const dir = path.join(root, rel);
    if (rel.split('/').some((p) => p.startsWith('.')) || !dir.startsWith(root)) return next();
    let st; try { st = fs.statSync(dir); } catch { return next(); }
    if (!st.isDirectory()) return next();
    if (!req.path.endsWith('/')) return res.redirect(302, `${mount.replace(/\/$/, '')}${req.path}/`);
    res.type('html').send(listing(dir, mount.replace(/\/$/, '') + req.path));
  });
  return r;
}

module.exports = { router };
