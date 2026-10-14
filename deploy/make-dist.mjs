#!/usr/bin/env node
/**
 * make-dist.mjs - cross-platform production build + dist assembly for Evolve.
 *
 * Replaces the shell-specific "deploy"/"deploy-win" npm scripts (rm/cp vs rmdir/xcopy)
 * with a single Node script that behaves identically on Windows, Linux and macOS,
 * and on CI runners.
 *
 *   node deploy/make-dist.mjs              # build from src/ and assemble ./dist
 *   node deploy/make-dist.mjs --no-build   # skip compiling, just re-assemble ./dist
 *   node deploy/make-dist.mjs --out public # custom output directory
 *
 * Output layout (ready to upload to GitHub Pages / Cloudflare Pages / nginx / OSS):
 *   dist/index.html  wiki.html  save.html  *.ico  LICENSE  .nojekyll
 *   dist/evolve/  dist/wiki/  dist/lib/  dist/font/  dist/strings/
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => (argv.indexOf(f) === -1 ? d : argv[argv.indexOf(f) + 1]);

const OUT = path.resolve(ROOT, val('--out', 'dist'));
const DO_BUILD = !has('--no-build');

const p = (...s) => path.join(ROOT, ...s);
const log = (...a) => console.log('[dist]', ...a);
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';

function die(msg) {
  console.error('[dist] FATAL: ' + msg);
  process.exit(1);
}

function mustExist(rel) {
  if (!fs.existsSync(p(rel))) die(`required file missing: ${rel} (are you running from the repo root?)`);
}

function copy(src, dest) {
  fs.cpSync(p(src), dest, { recursive: true });
}

const STATIC_DIRS = ['evolve', 'font', 'lib', 'strings', 'wiki'];
const STATIC_ROOT_FILES = ['index.html', 'wiki.html', 'save.html', 'evolved.ico', 'evolved-light.ico', 'LICENSE'];

async function build() {
  const esbuild = require('esbuild');
  const less = require('less');
  const csso = require('csso');

  log('bundling src/main.js -> evolve/main.js');
  await esbuild.build({
    logLevel: 'warning',
    entryPoints: [p('src/main.js')],
    bundle: true,
    minify: true,
    outfile: p('evolve/main.js'),
  });

  log('bundling src/wiki/wiki.js -> wiki/wiki.js');
  await esbuild.build({
    logLevel: 'warning',
    entryPoints: [p('src/wiki/wiki.js')],
    bundle: true,
    minify: true,
    outfile: p('wiki/wiki.js'),
  });

  for (const [lessFile, cssFile] of [
    ['src/evolve.less', 'evolve/evolve.css'],
    ['src/wiki/wiki.less', 'wiki/wiki.css'],
  ]) {
    log(`compiling ${lessFile} -> ${cssFile}`);
    mustExist(lessFile);
    const source = fs.readFileSync(p(lessFile), 'utf8');
    const { css } = await less.render(source, {
      paths: [path.dirname(p(lessFile))],
      filename: p(lessFile),
      compress: false,
    });
    const minified = csso.minify(css).css;
    fs.writeFileSync(p(cssFile), minified);
  }
}

function assemble() {
  log(`assembling ${path.relative(ROOT, OUT)}/`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  for (const d of STATIC_DIRS) {
    mustExist(d);
    copy(d, path.join(OUT, d));
  }
  for (const f of STATIC_ROOT_FILES) {
    mustExist(f);
    fs.copyFileSync(p(f), path.join(OUT, f));
  }

  // .nojekyll: stop GitHub Pages from running Jekyll over the output.
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

  // Optional: cache/security headers consumed by Cloudflare Pages and Netlify.
  const headers = p('deploy/_headers');
  if (fs.existsSync(headers)) {
    fs.copyFileSync(headers, path.join(OUT, '_headers'));
    log('copied deploy/_headers -> dist/_headers');
  }
}

function report() {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : [full];
    });
  const files = walk(OUT);
  const bytes = files.reduce((s, f) => s + fs.statSync(f).size, 0);

  for (const required of ['index.html', 'wiki.html', 'save.html', 'evolve/main.js', 'evolve/evolve.css', 'wiki/wiki.js', 'strings/strings.json', '.nojekyll']) {
    if (!fs.existsSync(path.join(OUT, required))) die(`dist is incomplete, missing ${required}`);
  }

  log(`${files.length} files, ${mb(bytes)}`);
  for (const d of STATIC_DIRS) {
    const size = walk(path.join(OUT, d)).reduce((s, f) => s + fs.statSync(f).size, 0);
    log(`  ${d}/ ${mb(size)}`);
  }
  log('done. verify with:  node deploy/verify-site.mjs');
}

(async () => {
  if (!fs.existsSync(p('package.json'))) die('package.json not found - run this from the repo root');
  if (DO_BUILD) {
    mustExist('node_modules');
    await build();
  } else {
    log('--no-build: reusing existing evolve/ and wiki/ artifacts');
  }
  assemble();
  report();
})().catch((e) => die(e?.message || String(e)));
