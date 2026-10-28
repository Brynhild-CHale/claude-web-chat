// lib/core/mirror-settings.js — the project's mirror settings: the chat
// mirror's disk budget (annotation engine PLAN.md 3E.1; DECISIONS.md L.4 P4 = c,
// "make the size adjustable but default to unlimited"; RULED R2 = a).
//
// One record, .web-chat/mirror.json (lib/core/paths projectPaths().mirrorSettings):
//
//   { "v": 1, "disk_budget_bytes": null }     exactly these two keys; the size
//                                             null (unlimited, the default) or
//                                             an integer >= MIN_BUDGET_BYTES
//
// Absent, torn or the wrong shape, it reads as the default — unlimited — so a
// corrupt record never deletes anything; the read never throws and never
// renames the user's file aside: the one writer rewrites it.
//
// WHO MAY SET IT: only the host's CLI, `claude-web-chat mirror budget
// <size>|unlimited|status` (lib/cli/commands/mirror.js). There is no route, no
// ctx member, no frame and no RULES row for it, and the daemon never writes it:
// nothing on the page, no pane and no remote viewer can reach the budget. It
// lives in lib/core because both the CLI (which writes it) and the daemon's
// codediff source (which reads it, lib/server/mirror/codediff.js) need it, and
// lib/cli → lib/server would be an entry → entry edge (lib/core/excerpts is the
// pattern).
//
//   readMirrorSettings(paths)    → {v: 1, disk_budget_bytes: <int> | null}
//   inspectMirrorSettings(paths) → {settings, state: 'ok'|'absent'|'corrupt'|'invalid'}
//   writeMirrorSettings(paths, {disk_budget_bytes}) → the record written
//                                  (TypeError for a size that is neither null
//                                  nor an integer >= MIN_BUDGET_BYTES)
//   parseSize(text) → bytes, or null for 'unlimited'; throws a SizeError
//                     ({code: 'bad-size'|'under-floor', hint}) for anything else
//   formatBytes(n)  → '2 GiB', '72.4 MiB', '512 B'
//   measureMirror(paths) → {total, index, diffs, shadow}: bytes under
//                     .web-chat/mirror/ (a walk of regular files; a symlink is
//                     never followed), and its three parts
//   MIN_BUDGET_BYTES  64 MiB, the smallest size a budget may be (RULED R2 = a)
//
// `paths` is lib/core/paths projectPaths(root). Dependency direction: lib/core;
// requires only ./fsjson and node built-ins.

'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('./fsjson');

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;
const TiB = 1024 * GiB;

const RECORD_VERSION = 1;
const MIN_BUDGET_BYTES = 64 * MiB;
const DEFAULT_SETTINGS = Object.freeze({ v: RECORD_VERSION, disk_budget_bytes: null });

// The units parseSize reads, case-insensitive: decimal in 1000s, binary in 1024s.
const UNITS = Object.freeze({
  b: 1,
  kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: KiB, mib: MiB, gib: GiB, tib: TiB,
});

class SizeError extends Error {
  constructor(code, hint) {
    super(hint);
    this.name = 'SizeError';
    this.code = code;
    this.hint = hint;
  }
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validSize = (n) => n === null || (Number.isSafeInteger(n) && n >= MIN_BUDGET_BYTES);

// Exactly {v: 1, disk_budget_bytes}: no other key, no other version.
function validRecord(value) {
  if (!isPlain(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && Object.hasOwn(value, 'v') && Object.hasOwn(value, 'disk_budget_bytes')
    && value.v === RECORD_VERSION && validSize(value.disk_budget_bytes);
}

function fileOf(paths) {
  if (!paths || typeof paths.mirrorSettings !== 'string' || !paths.mirrorSettings) {
    throw new TypeError('mirror-settings: paths (lib/core/paths projectPaths) is required');
  }
  return paths.mirrorSettings;
}

function inspectMirrorSettings(paths) {
  const file = fileOf(paths);
  let r;
  try { r = readJson(file, { validate: validRecord }); } catch { r = { corrupt: true }; }
  if (r.ok) return { settings: { v: RECORD_VERSION, disk_budget_bytes: r.value.disk_budget_bytes }, state: 'ok' };
  return { settings: { ...DEFAULT_SETTINGS }, state: r.absent ? 'absent' : r.invalid ? 'invalid' : 'corrupt' };
}

function readMirrorSettings(paths) {
  return inspectMirrorSettings(paths).settings;
}

function writeMirrorSettings(paths, { disk_budget_bytes } = {}) {
  const file = fileOf(paths);
  if (!validSize(disk_budget_bytes)) {
    throw new TypeError(`mirror-settings: the disk budget is null (unlimited) or a whole number of bytes, at least ${formatBytes(MIN_BUDGET_BYTES)}`);
  }
  const record = { v: RECORD_VERSION, disk_budget_bytes };
  writeJsonAtomic(file, record, { newline: true });
  return record;
}

const SIZE_RE = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i;
const SIZE_HINT = 'a size is a number with an optional unit — B, KB, MB, GB, TB (1000s) or KiB, MiB, GiB, TiB (1024s), e.g. 2GiB or 500MB — or `unlimited`';

function parseSize(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (s.toLowerCase() === 'unlimited') return null;
  const m = SIZE_RE.exec(s);
  const unit = m ? m[2].toLowerCase() || 'b' : null;
  if (!m || !Object.hasOwn(UNITS, unit)) {
    throw new SizeError('bad-size', `not a size: ${JSON.stringify(String(text))} — ${SIZE_HINT}`);
  }
  const bytes = Math.floor(Number(m[1]) * UNITS[unit]);
  if (!Number.isSafeInteger(bytes)) throw new SizeError('bad-size', `too large a size: ${s} — ${SIZE_HINT}`);
  if (bytes < MIN_BUDGET_BYTES) {
    throw new SizeError('under-floor', `${s} is under the smallest budget, ${formatBytes(MIN_BUDGET_BYTES)} — name a size of at least 64MiB, or \`unlimited\``);
  }
  return bytes;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return String(n);
  const steps = [['TiB', TiB], ['GiB', GiB], ['MiB', MiB], ['KiB', KiB]];
  for (const [name, size] of steps) {
    if (n >= size) {
      const v = n / size;
      return `${Number.isInteger(v) ? v : v.toFixed(1)} ${name}`;
    }
  }
  return `${n} B`;
}

// Bytes of the regular files under `dir` (lstat: a symlink is never followed).
function dirBytes(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) total += dirBytes(p);
    else if (ent.isFile()) { try { total += fs.lstatSync(p).size; } catch { /* gone */ } }
  }
  return total;
}

function measureMirror(paths) {
  if (!paths || typeof paths.mirrorDir !== 'string') throw new TypeError('mirror-settings: paths (lib/core/paths projectPaths) is required');
  return {
    total: dirBytes(paths.mirrorDir),
    index: dirBytes(paths.mirrorIndexDir),
    diffs: dirBytes(paths.mirrorDiffsDir),
    shadow: dirBytes(paths.mirrorGit),
  };
}

module.exports = {
  RECORD_VERSION,
  MIN_BUDGET_BYTES,
  DEFAULT_SETTINGS,
  SizeError,
  validRecord,
  readMirrorSettings,
  inspectMirrorSettings,
  writeMirrorSettings,
  parseSize,
  formatBytes,
  dirBytes,
  measureMirror,
};
