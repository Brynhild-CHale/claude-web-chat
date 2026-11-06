'use strict';
// scripts/soak/sample.js — one sample of the soak's counters, numbers only
// (H.11, U579): one `name value` line per counter it has a value for, the
// shape the workflow-shape skill's soak.sh reads (its awk keeps a line whose
// second field is /^-?[0-9.]+$/). A source it cannot read prints nothing — a
// gap in the series, never a made-up 0.
//
// The sources:
//   proc.json    daemon.js's own counters (heap_used_mb, rss_mb, handles,
//                timers, mirror_timers, mirror_watchers, mirror_conversations,
//                mirror_parsed, services) — ignored once older than PROC_STALE_MS
//                (a daemon that died stops refreshing it)
//   /api/health  through lib/client: viewers, nodes, lock_held (0/1)
//   the registry the soak HOME's: daemons_per_root, lib/util/registry
//                daemonsFor(root, {scan: false}) — never a port scan of 5173–5272
//   drive.json   drive.js's counters
//   /api/events  the script-error events since the soak began: script_errors
//                (a cursor and a running count in <out>/sample-state.json,
//                reset to 0 when the daemon's boot id changes — a restart
//                empties the ring)
//   /api/elements/types   pack_listed: the non-built-in element types listed
//                (the strokes fixture when U565's pack is staged; recorded, not
//                judged)
//
// formatSample(sources) is the one pure formatter; NAMES lists every name it
// may print, and thresholds.json may judge only those.
//
//   node scripts/soak/sample.js --root R

const path = require('path');
const { enter, parseArgs, runMain } = require('./lib');
const client = require('../../lib/client');
const registry = require('../../lib/util/registry');
const { readJson, writeJsonAtomic } = require('../../lib/core/fsjson');

const PROC_STALE_MS = 30 * 1000;
const CALL = { timeout: 5000 };

const PROC_NAMES = Object.freeze(['heap_used_mb', 'rss_mb', 'handles', 'timers', 'mirror_timers', 'mirror_watchers', 'mirror_conversations', 'mirror_parsed', 'services']);
const HEALTH_NAMES = Object.freeze(['viewers', 'nodes', 'lock_held']);
const REGISTRY_NAMES = Object.freeze(['daemons_per_root']);
const DRIVE_NAMES = Object.freeze([
  'reconnects', 'reconnect_failures', 'restarts', 'restart_failures', 'element_writes', 'undo_ok', 'undo_missing',
  'write_failures', 'turns', 'nav_reads', 'nav_failures', 'spawn_close_ok', 'set_active_ok', 'set_active_failures',
  'stroke_writes', 'stroke_failures', 'stroke_writes_element', 'stroke_writes_pane', 'stroke_writes_page',
  'mirror_reads', 'mirror_read_failures',
]);
const EXTRA_NAMES = Object.freeze(['script_errors', 'pack_listed']);
const NAMES = Object.freeze([...PROC_NAMES, ...HEALTH_NAMES, ...REGISTRY_NAMES, ...DRIVE_NAMES, ...EXTRA_NAMES]);

// A number as soak.sh's awk accepts it: finite, no exponent, at most two
// decimals. null for anything else.
function num(v) {
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) >= 1e15) return null;
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}

// sources: {proc, health, registry, drive, scriptErrors, packListed}, each
// optional. → the sample's text: one 'name value' line per NAMES entry with a
// value, in NAMES order, each ending in '\n'.
function formatSample({ proc = null, health = null, registry: reg = null, drive = null, scriptErrors = null, packListed = null } = {}) {
  const vals = {};
  if (proc && typeof proc === 'object') for (const k of PROC_NAMES) vals[k] = proc[k];
  if (health && typeof health === 'object') {
    vals.viewers = health.viewers;
    vals.nodes = health.nodes;
    if ('lock' in health) vals.lock_held = health.lock ? 1 : 0;
  }
  if (reg && typeof reg === 'object' && Array.isArray(reg.daemons)) vals.daemons_per_root = reg.daemons.length;
  if (drive && typeof drive === 'object') for (const k of DRIVE_NAMES) vals[k] = drive[k];
  vals.script_errors = scriptErrors;
  vals.pack_listed = packListed;
  let out = '';
  for (const name of NAMES) {
    const v = num(vals[name]);
    if (v !== null) out += `${name} ${v}\n`;
  }
  return out;
}

// ── the sources ─────────────────────────────────────────────────────────────
function readRecent(file, maxAgeMs, now = Date.now()) {
  const got = readJson(file);
  if (!got.ok || !got.value || typeof got.value !== 'object') return null;
  if (maxAgeMs != null && !(now - got.value.at <= maxAgeMs)) return null;
  return got.value;
}

// The script-error count since the soak began, carried across samples (and
// across the drive's restarts) in sample-state.json.
async function scriptErrorsSince(cfg, health) {
  const file = path.join(cfg.out, 'sample-state.json');
  const prev = readRecent(file, null) || { boot: null, cursor: 0, count: 0 };
  const boot = health && health.boot != null ? health.boot : null;
  let cursor = boot === prev.boot ? prev.cursor : 0;
  const r = await client.get(`/api/events?since=${cursor}`, { ...CALL, port: cfg.port });
  let count = prev.count;
  for (const e of r.events || []) {
    if (e && e.kind === 'script-error' && (!cfg.started_at || !(e.ts < cfg.started_at))) count += 1;
    if (e && Number.isInteger(e.seq) && e.seq > cursor) cursor = e.seq;
  }
  if (Number.isInteger(r.latest) && r.latest > cursor) cursor = r.latest;
  writeJsonAtomic(file, { boot, cursor, count, at: Date.now() });
  return count;
}

async function collect(cfg) {
  const port = cfg.port;
  const src = {};
  src.proc = readRecent(path.join(cfg.out, 'proc.json'), PROC_STALE_MS);
  try { src.health = await client.get('/api/health', { ...CALL, port }); } catch { src.health = null; }
  try { src.registry = await registry.daemonsFor(cfg.project, { scan: false }); } catch { src.registry = null; }
  src.drive = readRecent(path.join(cfg.out, 'drive.json'), null);
  if (src.health) {
    try { src.scriptErrors = await scriptErrorsSince(cfg, src.health); } catch { src.scriptErrors = null; }
    try {
      const t = await client.get('/api/elements/types', { ...CALL, port });
      src.packListed = (t.types || []).filter((x) => x && x.builtin === false).length;
    } catch { src.packListed = null; }
  }
  return src;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = enter(args.root);
  process.stdout.write(formatSample(await collect(cfg)));
  return 0;
}

if (require.main === module) runMain(main);

module.exports = { NAMES, PROC_NAMES, HEALTH_NAMES, REGISTRY_NAMES, DRIVE_NAMES, EXTRA_NAMES, formatSample, num, collect, PROC_STALE_MS };
