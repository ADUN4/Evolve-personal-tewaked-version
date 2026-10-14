#!/usr/bin/env node
/**
 * measure-weight.mjs - what a first-time visitor actually downloads.
 *
 * Walks the entry page's local references (following url() inside local CSS),
 * then reports raw / gzip / brotli totals for the whole first-load set.
 *
 *   node deploy/measure-weight.mjs              # measures ./dist
 *   node deploy/measure-weight.mjs --root .     # measures the repo root
 *   node deploy/measure-weight.mjs --page wiki.html
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const val = (f, d) => (argv.indexOf(f) === -1 ? d : argv[argv.indexOf(f) + 1]);

const ROOT = path.resolve(REPO_ROOT, val('--root', 'dist'));
const PAGE = val('--page', 'index.html');

const mb = (x) => (x / 1048576).toFixed(2) + ' MB';

function localRefs(html, from) {
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  const out = new Set();
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const v = m[1].trim();
    if (!v || v.startsWith('#') || v.startsWith('data:')) continue;
    if (/^(https?:)?\/\//i.test(v)) continue;
    out.add(path.normalize(path.join(path.dirname(from), v.split('?')[0])));
  }
  return out;
}

function cssUrls(css, from) {
  const out = new Set();
  const re = /url\(([^)]+)\)/gi;
  let m;
  while ((m = re.exec(css))) {
    const u = m[1].replace(/["']/g, '').trim();
    if (!u || u.startsWith('data:') || /^(https?:)?\/\//i.test(u)) continue;
    out.add(path.normalize(path.join(path.dirname(from), u)));
  }
  return out;
}

if (!fs.existsSync(path.join(ROOT, PAGE))) {
  console.error(`[FATAL] ${path.join(ROOT, PAGE)} not found - run "node deploy/make-dist.mjs" first`);
  process.exit(2);
}

const queue = [PAGE];
const seen = new Set();
while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  seen.add(rel);
  const isCss = rel.endsWith('.css');
  const isHtml = rel.endsWith('.html');
  if (!isCss && !isHtml) continue;
  const text = fs.readFileSync(abs, 'utf8');
  const found = isHtml ? localRefs(text, rel) : cssUrls(text, rel);
  for (const f of found) queue.push(f);
}

// The game fetches its string pack at runtime, not via a tag in the HTML.
if (fs.existsSync(path.join(ROOT, 'strings/strings.json'))) seen.add('strings/strings.json');

const rows = [];
let raw = 0, gz = 0, br = 0;
for (const rel of seen) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  const g = zlib.gzipSync(buf, { level: 9 }).length;
  const b = zlib.brotliCompressSync(buf).length;
  raw += buf.length; gz += g; br += b;
  rows.push([rel, buf.length, g, b]);
}

rows.sort((a, b) => b[1] - a[1]);
const pad = (s, n) => String(s).padStart(n);
console.log(`[i] entry page: ${PAGE}  (root: ${ROOT})`);
console.log(`[i] ${rows.length} assets in the first-load set\n`);
console.log(pad('raw', 11) + pad('gzip', 11) + pad('brotli', 11) + '  asset');
console.log('-'.repeat(76));
for (const r of rows.slice(0, 8)) console.log(pad(r[1], 11) + pad(r[2], 11) + pad(r[3], 11) + '  ' + r[0]);

console.log('\n' + pad('TOTAL raw', 12) + ' : ' + mb(raw));
console.log(pad('TOTAL gzip', 12) + ' : ' + mb(gz) + `  (${((gz / raw) * 100).toFixed(0)}% of raw)`);
console.log(pad('TOTAL brotli', 12) + ' : ' + mb(br) + `  (${((br / raw) * 100).toFixed(0)}% of raw)`);
console.log(`\n[i] repeat visits hit the CDN/browser cache; only the HTML is re-fetched.`);
console.log(`[i] 100,000 first-time visitors on gzip  = ${((gz / 1073741824) * 100000).toFixed(1)} GB of transfer`);
console.log(`[i] 100,000 first-time visitors on brotli = ${((br / 1073741824) * 100000).toFixed(1)} GB of transfer`);
