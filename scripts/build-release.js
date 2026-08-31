#!/usr/bin/env node
// Build the release artifact: a SELF-CONTAINED tarball plus its SHA256SUMS.
//
//   node scripts/build-release.js [--out dist]
//
// Why self-contained: this package has four runtime dependencies
// (@modelcontextprotocol/sdk, express, node-html-parser, ws). A source-only
// tarball — an `npm pack` of the `files` allowlist — unpacks fine and then dies
// on `Cannot find module 'express'`. Distribution is GitHub Releases with no npm
// step at install time, so production `node_modules` ships INSIDE the artifact
// (~28 MB on disk, ~4.5 MB compressed). devDependencies (jsdom) never ship: the
// tree comes from `npm ls --omit=dev`, and a check below fails the build if a
// devDependency sneaks in.
//
// Why a hand-rolled tar writer rather than shelling out to `tar`: determinism.
// GNU tar and BSD tar disagree about the flags that pin mtime/uid/gid/order, so
// the same tree produced different bytes on Linux and macOS and the published
// SHA256SUMS depended on which machine cut the release. Writing plain ustar
// ourselves fixes every varying field (mtime 0 or $SOURCE_DATE_EPOCH, uid/gid 0,
// sorted entries, modes normalized to 0644/0755) so the same input always
// produces the same bytes — and a checksum you can reproduce is the only kind
// worth publishing. Reading it back needs nothing special: both tars read ustar.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const BLOCK = 512;
// Fixed timestamp for every entry — 2000-01-01T00:00:00Z, not 0, so extracted
// files do not carry a pre-epoch date in negative timezones. Overridable via the
// SOURCE_DATE_EPOCH convention so a reproducible-builds toolchain can pin it.
const MTIME = parseInt(process.env.SOURCE_DATE_EPOCH || '', 10) || 946684800;

// ─────────────────────────────────────────────────────────── ustar writing ──

function octal(value, width) {
  // width-1 octal digits, NUL terminated — the classic ustar encoding.
  const s = value.toString(8).padStart(width - 1, '0');
  return Buffer.from(s + '\0', 'ascii');
}

// ustar splits a >100-char path into name(100) + prefix(155) at a '/' boundary.
function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    const rest = parts.slice(i).join('/');
    if (Buffer.byteLength(rest) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { name: rest, prefix };
    }
  }
  throw new Error(`path too long for ustar (>255 bytes): ${name}`);
}

function header({ name, mode, size, type }) {
  const buf = Buffer.alloc(BLOCK, 0);
  const { name: n, prefix } = splitName(name);
  buf.write(n, 0, 100, 'utf8');
  octal(mode, 8).copy(buf, 100);
  octal(0, 8).copy(buf, 108);        // uid
  octal(0, 8).copy(buf, 116);        // gid
  octal(size, 12).copy(buf, 124);
  octal(MTIME, 12).copy(buf, 136);
  buf.write('        ', 148, 8, 'ascii'); // checksum placeholder: 8 spaces
  buf.write(type, 156, 1, 'ascii');       // '0' file, '5' directory
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  // uname/gname deliberately empty — a build must not carry the builder's login.
  buf.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of buf) sum += b;
  Buffer.concat([octal(sum, 7), Buffer.from(' ', 'ascii')]).copy(buf, 148);
  return buf;
}

function pad(size) {
  const rem = size % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem, 0);
}

// entries: [{ name, type: 'file'|'dir', mode, source }] — already sorted.
function makeTar(entries) {
  const parts = [];
  for (const e of entries) {
    if (e.type === 'dir') {
      parts.push(header({ name: e.name.replace(/\/?$/, '/'), mode: 0o755, size: 0, type: '5' }));
      continue;
    }
    const data = fs.readFileSync(e.source);
    parts.push(header({ name: e.name, mode: e.mode, size: data.length, type: '0' }), data, pad(data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0)); // end-of-archive
  const body = Buffer.concat(parts);
  // Pad to the classic 10240-byte blocking factor.
  const rem = body.length % (BLOCK * 20);
  return rem === 0 ? body : Buffer.concat([body, Buffer.alloc(BLOCK * 20 - rem, 0)]);
}

// ──────────────────────────────────────────────────────── choosing content ──

const SKIP_NAMES = new Set(['.DS_Store', '.npmrc']);

function walk(dir, { skipNodeModules = false } = {}) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (SKIP_NAMES.has(e.name)) continue;
    if (skipNodeModules && e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push({ path: p, dir: true });
      out.push(...walk(p, { skipNodeModules }));
    } else if (e.isFile()) {
      out.push({ path: p, dir: false });
    }
    // Symlinks: the production tree has none outside node_modules/.bin, which is
    // skipped. Anything else is dropped rather than silently dereferenced.
  }
  return out;
}

// The production dependency tree, straight from npm's own resolution. Offline:
// it reads the installed tree + lockfile, it does not hit the registry.
function productionPackageDirs(root) {
  const r = spawnSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
    cwd: root, encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`npm ls --omit=dev failed — run \`npm ci\` first.\n${(r.stderr || '').trim()}`);
  }
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((p) => path.resolve(p) !== path.resolve(root))
    .map((p) => path.resolve(p));
}

function collectEntries(root, prefix) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entries = [];
  const add = (abs, isDir) => {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (isDir) {
      entries.push({ name: `${prefix}/${rel}`, type: 'dir' });
      return;
    }
    // Modes are normalized: executable (any x bit in the source) or not.
    const st = fs.statSync(abs);
    const exec = Boolean(st.mode & 0o111) || /^bin\//.test(rel);
    entries.push({ name: `${prefix}/${rel}`, type: 'file', mode: exec ? 0o755 : 0o644, source: abs });
  };

  // 1. package.json always (the runtime reads its own version out of it).
  add(path.join(root, 'package.json'), false);

  // 2. The `files` allowlist — the same set an `npm pack` would ship.
  for (const item of pkg.files || []) {
    const abs = path.join(root, item.replace(/\/$/, ''));
    if (!fs.existsSync(abs)) throw new Error(`package.json "files" lists ${item}, which does not exist`);
    if (fs.statSync(abs).isDirectory()) {
      add(abs, true);
      for (const f of walk(abs)) add(f.path, f.dir);
    } else {
      add(abs, false);
    }
  }

  // 3. Production node_modules, one package at a time (each package's own
  //    nested node_modules is listed separately by npm, so it is skipped here
  //    and added by its own entry).
  const devNames = Object.keys(pkg.devDependencies || {});
  for (const dir of productionPackageDirs(root)) {
    const rel = path.relative(root, dir).split(path.sep).join('/');
    if (!rel.startsWith('node_modules/')) {
      throw new Error(`production dependency resolved outside node_modules: ${dir}`);
    }
    const name = rel.replace(/^.*node_modules\//, '');
    if (devNames.includes(name)) {
      throw new Error(`devDependency ${name} appeared in the production tree — it must not ship`);
    }
    add(dir, true);
    for (const f of walk(dir, { skipNodeModules: true })) add(f.path, f.dir);
  }

  // Deterministic order, and no duplicates (a nested package dir can be added by
  // both its parent walk and its own entry only if the skip above ever regresses).
  const seen = new Set();
  return entries
    .filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ───────────────────────────────────────────────────────────────── the build ──

function buildRelease({ root = REPO_ROOT, outDir = path.join(REPO_ROOT, 'dist'), log = console.log } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  const prefix = `claude-web-chat-${version}`;
  const tarName = `${prefix}.tar.gz`;

  const entries = collectEntries(root, prefix);
  const tar = makeTar(entries);
  // level 9 + no mtime in the gzip header (node writes 0) keeps the bytes stable.
  const gz = zlib.gzipSync(tar, { level: 9 });
  // The OS field (RFC 1952 §2.3.1, byte 9) is the one remaining header byte that
  // depends on the machine rather than the tree: zlib stamps 3 on Linux and 19 on
  // macOS, so a tag rebuilt on another OS hashed differently and read as tampering.
  // 255 = "unknown", the value reproducible-build toolchains pin it to.
  gz[9] = 255;

  fs.mkdirSync(outDir, { recursive: true });
  const tarPath = path.join(outDir, tarName);
  fs.writeFileSync(tarPath, gz);

  const digest = crypto.createHash('sha256').update(gz).digest('hex');
  const sumsPath = path.join(outDir, 'SHA256SUMS');
  // The exact format `shasum -a 256` writes and `-c` reads, so install.sh can
  // verify with the stock tool.
  fs.writeFileSync(sumsPath, `${digest}  ${tarName}\n`);

  const files = entries.filter((e) => e.type === 'file').length;
  log(`built ${tarPath}`);
  log(`  version   ${version}`);
  log(`  entries   ${files} files, ${entries.length - files} dirs`);
  log(`  size      ${(gz.length / 1024 / 1024).toFixed(2)} MB compressed`);
  log(`  sha256    ${digest}`);
  log(`  sums      ${sumsPath}`);
  return { version, tarPath, sumsPath, digest, entries };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const outDir = i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : path.join(REPO_ROOT, 'dist');
  try {
    buildRelease({ outDir });
  } catch (e) {
    console.error(`build-release: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { buildRelease, collectEntries, makeTar, splitName, REPO_ROOT };
