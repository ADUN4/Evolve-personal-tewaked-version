#!/usr/bin/env node
/**
 * verify-site.mjs - asset/health checker for an Evolve deployment.
 *
 * Usage:
 *   node deploy/verify-site.mjs                          # serve ./dist on :4400 and check it
 *   node deploy/verify-site.mjs --root .                 # serve the repo root instead of dist
 *   node deploy/verify-site.mjs https://USER.github.io/REPO/   # check a live site
 *   node deploy/verify-site.mjs https://example.com --port 8080
 *
 * It fetches every local asset referenced by index.html / wiki.html / save.html,
 * plus the runtime string packs, and reports status + size. Exit code 1 on failure.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i === -1 ? def : argv[i + 1];
};
// A positional target is the first arg that is neither a known flag nor a flag value.
const VALUE_FLAGS = new Set(['--port', '--root']);
let target = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.has(a)) { i++; continue; }
  if (a.startsWith('-')) continue;
  target = a;
  break;
}
const port = Number(flag('--port', 4400));
const rootDir = flag('--root', 'dist');
const waitSec = Number(flag('--wait', 0));
const failures = [];
const warnings = [];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8',
};

function startServer(dir) {
  const abs = path.resolve(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) {
    console.error(`[FATAL] root directory not found: ${abs}`);
    console.error(`        run "node deploy/make-dist.mjs" first, or pass --root .`);
    process.exit(2);
  }
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let rel = url.replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(abs, rel);
    if (!file.startsWith(abs)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function localRefs(html) {
  html = stripComments(html);
  const out = new Set();
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const v = m[1].trim();
    if (!v || v.startsWith('#') || v.startsWith('data:')) continue;
    if (/^(https?:)?\/\//i.test(v)) continue; // protocol-relative or absolute -> not ours
    out.add(v.split('?')[0]);
  }
  return [...out];
}

function externalRefs(html) {
  html = stripComments(html);
  const out = new Set();
  const re = /(?:src|href)\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) out.add(m[1]);
  return [...out];
}

async function check(base, rel) {
  const url = base + rel.replace(/^\/+/, '');
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const body = await res.arrayBuffer();
    const ok = res.status === 200 && body.byteLength > 0;
    const row = { url, status: res.status, bytes: body.byteLength, ok, ctype: res.headers.get('content-type') || '' };
    if (!ok) failures.push(`${rel} -> HTTP ${res.status} (${body.byteLength} bytes)`);
    return row;
  } catch (e) {
    failures.push(`${rel} -> ${e.message}`);
    return { url, status: 0, bytes: 0, ok: false, ctype: '' };
  }
}

const pad = (s, n) => String(s).padEnd(n);

/** Poll until the site answers (useful right after a deploy, while CDNs catch up). */
async function waitForBase(base, sec) {
  if (!sec) return;
  const deadline = Date.now() + sec * 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(base + 'index.html', { redirect: 'follow' });
      if (res.status === 200) {
        console.log(`[i] site answered HTTP 200 on attempt ${attempt}`);
        return;
      }
    } catch {
      /* keep polling */
    }
    if (Date.now() > deadline) {
      warnings.push(`site did not answer with HTTP 200 within ${sec}s; checking anyway`);
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

(async () => {
  let base;
  let server = null;
  if (target) {
    base = target.endsWith('/') ? target : target + '/';
    console.log(`[i] verifying live site: ${base}`);
  } else {
    server = await startServer(rootDir);
    base = `http://127.0.0.1:${port}/`;
    console.log(`[i] serving ${path.resolve(REPO_ROOT, rootDir)} at ${base}`);
  }

  await waitForBase(base, waitSec);

  const pages = ['index.html', 'wiki.html', 'save.html'];
  const queue = new Set(pages);
  const htmlCache = {};

  for (const page of pages) {
    const res = await fetch(base + page);
    if (res.status !== 200) {
      failures.push(`${page} -> HTTP ${res.status}`);
      continue;
    }
    const html = await res.text();
    htmlCache[page] = html;
    for (const r of localRefs(html)) queue.add(r);
    const ext = externalRefs(html);
    if (ext.length) warnings.push(`${page} loads third-party resources: ${ext.join(', ')}`);
  }

  for (const s of ['strings/strings.json', 'strings/strings.zh-CN.json', 'strings/strings.zh-TW.json']) queue.add(s);

  const rows = [];
  for (const rel of queue) rows.push(await check(base, rel));

  console.log('');
  console.log(pad('STATUS', 8) + pad('BYTES', 12) + 'ASSET');
  console.log('-'.repeat(78));
  for (const r of rows.sort((a, b) => a.url.localeCompare(b.url))) {
    console.log(pad(r.ok ? 'OK' : 'FAIL', 8) + pad(r.bytes, 12) + r.url.replace(base, ''));
  }

  // Signature checks that catch "200 but wrong thing" cases.
  const mainJs = rows.find((r) => r.url.endsWith('/evolve/main.js'));
  if (mainJs && mainJs.ok && mainJs.bytes < 100000)
    warnings.push(`evolve/main.js is only ${mainJs.bytes} bytes - bundle looks broken/unbuilt`);
  const idx = htmlCache['index.html'] || '';
  if (idx && !/evolve\/main\.js/.test(idx)) failures.push('index.html does not reference evolve/main.js');

  console.log('');
  console.log(`checked ${rows.length} assets, ${rows.filter((r) => r.ok).length} ok, ${failures.length} failed`);
  if (warnings.length) {
    console.log('');
    for (const w of warnings) console.log(`[WARN] ${w}`);
  }
  if (failures.length) {
    console.log('');
    for (const f of failures) console.log(`[FAIL] ${f}`);
  }
  if (server) server.close();
  console.log('');
  console.log(failures.length ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exit(failures.length ? 1 : 0);
})();
