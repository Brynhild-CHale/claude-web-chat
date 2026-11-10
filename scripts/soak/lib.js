'use strict';
// scripts/soak/lib.js — the system soak's band and isolation, in one place
// (annotation engine tranche 4, H.11, unit U579).
//
// The soak runs the ASSEMBLED daemon for 10–30 minutes under a scripted viewer
// (drive.js) and samples counters (sample.js) for the workflow-shape skill's
// soak.sh template, which judges them against thresholds.json. Nothing under
// scripts/soak/ ships (package.json's `files` allowlist leaves scripts/ out),
// but test/conventions.test.js scans scripts/, so every engine rule applies.
//
// THE BAND. One port base (SOAK_PORT_BASE, default 6400; `--port-base N` or
// the env var): the daemon listens at the base, and the capture hub that its
// start() brings up (lib/util/hub ensureHub, through WEB_CHAT_HUB_PORT) at
// base + 1. A base whose daemon or hub port falls in 5173–5272 (the ports a
// project daemon may bind, lib/util/registry SCAN_PORTS), on 5170 (the hub's
// default, DEFAULT_HUB_PORT), on 5171 (the portal's fixed loopback port,
// lib/tunnel/config DEFAULT_PORTAL_PORT) or on 5172 (cloudflared's metrics
// port, DEFAULT_METRICS_PORT) is refused: those are the maintainer's. Each is
// required by name, never written here as a number.
//
// THE ISOLATION. A soak owns one --root, made fresh per run by run.sh:
//
//   <root>/soak.json   this file's record of the run (written by `prepare`)
//   <root>/home        HOME and USERPROFILE: the registry, the hub's entry,
//                      the user tier — never the real ~/.web-chat
//   <root>/home/.claude   CLAUDE_CONFIG_DIR: the synthetic Claude Code tier
//                      fixture.js writes (never a copy of ~/.claude)
//   <root>/project     the web-chat project the soak's daemon serves
//   <root>/fixture.json   what fixture.js put there (drive.js reads it)
//
// Every child the soak starts gets soakEnv(): those three variables pointing
// inside the root, the hub port, and test-support/sandbox.js's scrub (CLAUDE_PID,
// CLAUDECODE, CLAUDE_EFFORT, CLAUDE_JOB_DIR, the CLAUDE_CODE_* family) plus every
// inherited WEB_CHAT_* variable (WEB_CHAT_PORT or WEB_CHAT_HOST from a
// maintainer's shell would point the soak at a live daemon or a network bind;
// WEB_CHAT_TEST_SANDBOX from a test runner would point fixture.js's Claude tier
// at the test's sandbox). A HOME the real home answers for (lib/core/paths
// isHomeDir) is refused before anything is written.
//
//   node scripts/soak/lib.js prepare --root R --out O [--port-base N]
//   node scripts/soak/lib.js thresholds --root R --file thresholds.json --write O/thresholds.json
//
// A refusal exits 2 with a hint (SoakRefusal); every other failure exits 1.

const fs = require('fs');
const path = require('path');
const { isHomeDir } = require('../../lib/core/paths');
const { readJson, writeJsonAtomic } = require('../../lib/core/fsjson');
const { SCAN_PORTS } = require('../../lib/util/registry');
const { DEFAULT_HUB_PORT } = require('../../lib/util/hub');
const { DEFAULT_PORTAL_PORT, DEFAULT_METRICS_PORT } = require('../../lib/tunnel/config');

const SOAK_PORT_BASE_DEFAULT = 6400;
// How long the soak's hub waits with an empty registry before it exits
// (lib/hub WEB_CHAT_HUB_IDLE_MS, default 15 s): short, so stop.js sees it
// leave within its wait.
const HUB_IDLE_MS = 4000;
// …and how often it looks (WEB_CHAT_HUB_POLL_MS, default 5 s).
const HUB_POLL_MS = 1000;
// The viewer sockets drive.js holds open for the whole soak: `viewers` is
// judged at most this.
const DRIVE_SOCKETS = 1;
// drive.js restarts the daemon every this many cycles (one a minute), and
// reads one conversation per cycle, so a daemon's life sees at most this many
// conversation reads: the watches the mirror holds for them are bounded by it
// (plus WATCH_SLACK for the eager set).
const DRIVE_RESTART_EVERY = 5;
const WATCH_SLACK = 2;

// The names test-support/sandbox.js deletes, and the prefix it deletes by.
const SCRUB_EXACT = Object.freeze(['CLAUDE_PID', 'CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_JOB_DIR']);
const SCRUB_PREFIXES = Object.freeze(['CLAUDE_CODE_', 'WEB_CHAT_']);

const RECORD = 'soak.json';

class SoakRefusal extends Error {
  constructor(message, hint) {
    super(message);
    this.code = 'SOAK_REFUSED';
    this.hint = hint;
  }
}

// The single ports beside the scan band: the hub's, the portal's and
// cloudflared's metrics server's defaults (the ones the maintainer's tunnel
// binds; the soak scrubs every WEB_CHAT_* variable and never starts a portal,
// so a relocated WEB_CHAT_PORTAL_PORT changes nothing here).
const FIXED_PORTS = Object.freeze([DEFAULT_HUB_PORT, DEFAULT_PORTAL_PORT, DEFAULT_METRICS_PORT]);

function forbiddenPort(p) {
  return FIXED_PORTS.includes(p) || SCAN_PORTS.includes(p);
}

function checkPort(p, what = 'port') {
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    throw new SoakRefusal(`soak: ${what} ${p} is not a port between 1024 and 65535`, 'pass --port-base N (or SOAK_PORT_BASE), a free pair N and N+1');
  }
  if (forbiddenPort(p)) {
    throw new SoakRefusal(
      `soak: ${what} ${p} is in the band the maintainer's surfaces use (${SCAN_PORTS[0]}–${SCAN_PORTS[SCAN_PORTS.length - 1]}, the hub's ${DEFAULT_HUB_PORT}, the portal's ${DEFAULT_PORTAL_PORT} and cloudflared's metrics ${DEFAULT_METRICS_PORT})`,
      `pick a port base outside it, e.g. --port-base ${SOAK_PORT_BASE_DEFAULT}`,
    );
  }
  return p;
}

// The band at `base`: {port, hubPort}. Throws a SoakRefusal for a base whose
// daemon port or hub port the maintainer's surfaces use.
function bandOf(base) {
  const b = typeof base === 'string' && base.trim() !== '' ? Number(base) : base;
  checkPort(b, 'daemon port');
  checkPort(b + 1, 'hub port');
  return { port: b, hubPort: b + 1 };
}

function checkHome(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) {
    throw new SoakRefusal(`soak: HOME ${JSON.stringify(home)} is not an absolute path`, 'the soak HOME is <root>/home, under an absolute --root');
  }
  // isHomeDir answers by path AND by contents (a .web-chat/ holding the user
  // tier), so a soak HOME a run has already used answers true as well: a
  // root is fresh per run.
  if (isHomeDir(home)) {
    throw new SoakRefusal(`soak: ${home} is the real home directory, or already holds a user tier`, 'the soak runs in a fresh HOME of its own under a fresh --root; never the real ~/.web-chat');
  }
  return home;
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (path.resolve(a) === path.resolve(b)) return true;
  try { return fs.realpathSync.native(a) === fs.realpathSync.native(b); } catch { return false; }
}

// The soak's directories under `root`.
function layout(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new SoakRefusal(`soak: --root ${JSON.stringify(root)} is not an absolute path`, 'pass --root <absolute dir>, made fresh per run (run.sh does)');
  }
  const r = path.resolve(root);
  const home = path.join(r, 'home');
  return { root: r, home, claude: path.join(home, '.claude'), project: path.join(r, 'project'), record: path.join(r, RECORD) };
}

// The environment every child of the soak runs with: `base` (default
// process.env) less the scrub, plus the soak's own HOME, USERPROFILE,
// CLAUDE_CONFIG_DIR and hub port. Pure: `base` is not touched.
function soakEnv(cfg, base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (SCRUB_EXACT.includes(k) || SCRUB_PREFIXES.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  env.HOME = cfg.home;
  env.USERPROFILE = cfg.home;
  env.CLAUDE_CONFIG_DIR = cfg.claude;
  env.WEB_CHAT_HUB_PORT = String(cfg.hubPort);
  env.WEB_CHAT_HUB_IDLE_MS = String(HUB_IDLE_MS);
  env.WEB_CHAT_HUB_POLL_MS = String(HUB_POLL_MS);
  // Narrowing only: no update check reaches github.com (read by
  // lib/update/check once U586 lands), and no headless Chrome is found.
  env.WEB_CHAT_UPDATE_CHECK = '0';
  env.WEB_CHAT_CHROME = path.join(path.sep, 'nonexistent', 'web-chat-soak', 'chrome');
  env.NO_COLOR = '1';
  delete env.FORCE_COLOR;
  return env;
}

// Make this process the soak's: the scrub applied to process.env in place and
// the soak's variables set. lib/core/paths reads HOME and CLAUDE_CONFIG_DIR per
// use, so every engine called after this sees the soak's tier.
function applyEnv(cfg) {
  const next = soakEnv(cfg, process.env);
  for (const k of Object.keys(process.env)) if (!(k in next)) delete process.env[k];
  Object.assign(process.env, next);
}

// The run's record, validated again (a hand-edited soak.json cannot move the
// band into the maintainer's ports or HOME outside the root).
function readRecord(root) {
  const l = layout(root);
  const got = readJson(l.record, { validate: (v) => v && typeof v === 'object' && Number.isInteger(v.port) });
  if (!got.ok) throw new SoakRefusal(`soak: ${l.record} is ${got.absent ? 'missing' : 'unreadable'}`, 'run `node scripts/soak/lib.js prepare --root <root> --out <dir>` first (run.sh does)');
  const v = got.value;
  const band = bandOf(v.port);
  if (v.hubPort !== band.hubPort) throw new SoakRefusal(`soak: ${l.record} names hub port ${v.hubPort}, not ${band.hubPort}`, 'prepare the root again');
  return { ...l, ...band, out: typeof v.out === 'string' ? v.out : l.root, started_at: v.started_at || null };
}

// `prepare`: validate the band and the HOME under the CURRENT environment (so
// isHomeDir compares against the real home), then make the directories and
// write soak.json.
function prepare({ root, out, portBase }) {
  const l = layout(root);
  const band = bandOf(portBase == null ? SOAK_PORT_BASE_DEFAULT : portBase);
  checkHome(l.home);
  if (isHomeDir(l.root)) throw new SoakRefusal(`soak: --root ${l.root} is the real home directory`, 'pass a fresh directory under --out');
  const o = path.resolve(out || l.root);
  for (const d of [l.root, l.home, l.claude, o]) fs.mkdirSync(d, { recursive: true });
  const rec = { v: 1, port: band.port, hubPort: band.hubPort, out: o, started_at: Date.now() };
  writeJsonAtomic(l.record, rec);
  return { ...l, ...band, out: o, started_at: rec.started_at };
}

// Every script's first act: read the record, become the soak's process.
// `prepare` refused a HOME isHomeDir answers for while it was still empty; by
// now the soak's own daemon has made it hold a user tier (so isHomeDir would
// answer true for it), so here the HOME this process inherited is compared by
// path: a soak HOME that IS that home is refused.
function enter(root) {
  const cfg = readRecord(root);
  const inherited = process.env.HOME;
  if (inherited !== cfg.home && samePath(inherited, cfg.home)) {
    throw new SoakRefusal(`soak: ${cfg.home} is this process's HOME`, 'the soak runs in a HOME of its own under --root');
  }
  applyEnv(cfg);
  return cfg;
}

// ── thresholds ──────────────────────────────────────────────────────────────
// thresholds.json holds a number for every rule but three, whose bound is read
// when the soak runs: `_max_from` names where. The template ignores every key
// it does not know (`_why`, `_max_from`), so the resolved file keeps them.
const RULE_KEYS = Object.freeze(['max', 'max_growth', 'max_slope_per_min']);
const MAX_FROM = Object.freeze({
  // The retention table's one row (lib/server/mirror/retention.js), through
  // its own lookup: 160 at 503b8f2f, 389 after U575.
  'retention:parsed-conversations-max': () => require('../../lib/server/mirror/retention').valueOf('parsed-conversations-max'),
  'drive:sockets': () => DRIVE_SOCKETS,
  'drive:reads-per-daemon': () => DRIVE_RESTART_EVERY + WATCH_SLACK,
});

function resolveThresholds(raw) {
  const out = {};
  for (const [name, rule] of Object.entries(raw || {})) {
    if (name.startsWith('_')) continue;
    const r = { ...rule };
    if (typeof r._max_from === 'string') {
      const from = MAX_FROM[r._max_from];
      if (!from) throw new Error(`soak thresholds: ${name}: unknown _max_from ${r._max_from}`);
      r.max = from();
    }
    out[name] = r;
  }
  return out;
}

// ── argv and the exit rule ──────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

// Run `fn` as a script's main: a SoakRefusal exits 2 with its hint, any other
// throw exits 1; a resolved number is the exit code.
function runMain(fn) {
  Promise.resolve()
    .then(fn)
    .then((code) => { process.exitCode = Number.isInteger(code) ? code : 0; })
    .catch((e) => {
      if (e && e.code === 'SOAK_REFUSED') {
        console.error(e.message);
        if (e.hint) console.error(`hint: ${e.hint}`);
        process.exit(2);
      }
      console.error(e && e.stack ? e.stack : String(e));
      process.exit(1);
    });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'prepare') {
    const portBase = args.portBase !== undefined ? args.portBase : (process.env.SOAK_PORT_BASE || SOAK_PORT_BASE_DEFAULT);
    const cfg = prepare({ root: args.root, out: args.out, portBase });
    console.log(`soak root ${cfg.root} · daemon port ${cfg.port} · hub port ${cfg.hubPort} · HOME ${cfg.home}`);
    return 0;
  }
  if (cmd === 'thresholds') {
    const got = readJson(path.resolve(String(args.file)));
    if (!got.ok) throw new Error(`soak thresholds: ${args.file} is ${got.absent ? 'missing' : 'unreadable'}`);
    const resolved = resolveThresholds(got.value);
    writeJsonAtomic(path.resolve(String(args.write)), resolved);
    console.log(`soak thresholds: ${Object.keys(resolved).length} rules → ${args.write}`);
    return 0;
  }
  throw new SoakRefusal(`soak lib: unknown command ${JSON.stringify(cmd)}`, 'prepare --root R --out O [--port-base N] | thresholds --file F --write W');
}

if (require.main === module) runMain(main);

module.exports = {
  SOAK_PORT_BASE_DEFAULT, HUB_IDLE_MS, HUB_POLL_MS, DRIVE_SOCKETS, DRIVE_RESTART_EVERY, WATCH_SLACK, SCRUB_EXACT, SCRUB_PREFIXES, RULE_KEYS, MAX_FROM,
  SoakRefusal, forbiddenPort, checkPort, bandOf, checkHome, samePath, layout, soakEnv, applyEnv,
  readRecord, prepare, enter, resolveThresholds, parseArgs, runMain,
};
