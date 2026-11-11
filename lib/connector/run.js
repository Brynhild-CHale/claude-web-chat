'use strict';

// `claude-web-chat connect run` — the connector process (contract 06 C-06.1,
// C-06.3, C-06.10; tranche 6, U726), and `connect rotate`, the one command
// that asks it for something through its record's directory (form 3 CB2 = a).
//
// `connect run` is what the start-at-login unit runs (./install.js writes it)
// and what a person or the hub machine's supervisor runs in a terminal (manual
// mode): one long-lived process for the machine's one hub. In order:
//   * root is refused (C-06.1); the only flag is --insecure-loopback (C-05.4's
//     development flag, form 3 CB1 = b): a record whose hub is plain http on a
//     loopback literal runs only with it, and with it any other hub refuses;
//   * the record: a record written by a newer build (v above this build's)
//     refuses naming that build; an unpaired, pending or revoked record — or
//     any record this build cannot run (none, several hubs, torn, its key
//     missing) — exits 0 with one sentence, so a launchd KeepAlive
//     {SuccessfulExit: false} unit does not restart-loop on it. Pairing is
//     never done here (C-06.8: it runs in the foreground of `connect`);
//   * the composition (CONNECTOR@install-seam; the ruling
//     U726-U716@link-composition-inputs (a)): the supervisor (./supervisor,
//     U718), the lifecycle over it (./lifecycle, U719), the facts holder
//     (./facts createFacts, U725: versions() and facts()), then the link
//     (./link createLink, U716) with those two, routeTable() →
//     {table_version: TABLE_VERSION, sha256: TABLE_SHA256} from
//     lib/core/connected-policy (U744) and onSettings = lifecycle.applySettings;
//     heartbeatBody is not passed (the link's minimal body until U790 wires
//     U729's rows). Each composed module's install(ctx) is called, ctx.link
//     set first. U790 wires the remaining modules' installs into this file;
//   * registerRole('connector', {pid}) — port-less (C-06.3) — and
//     deregisterRole on the way out;
//   * on every hello.ack (the link's 'ready', once per connection) the
//     record's last_reported {connector_version, install_kind,
//     claude_code_version, at} is written through updateRecord from the same
//     versions record hello carried (C-06.10: for `connect status`; and the
//     moment `connect <hub-url>`'s step (5) waits for);
//   * `connect rotate`'s request file is watched (lib/core/watch) so the link
//     checks it at once; the link also checks it at hello.ack and each beat;
//   * SIGTERM and SIGINT release every hold (lifecycle.stop 'release', never
//     'now': the daemons' own idle grace ends them, C-06.20), close the link,
//     deregister and resolve 0.
// Log lines go to stdout (the unit sends them to the connector log) and carry
// codes, ids and counts only: never a key, a secret, a path or hub text.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { userPaths } = require('../core/paths');
const { readJson } = require('../core/fsjson');
const { LOCAL_HOSTNAMES } = require('../core/cors');
const { stripControls } = require('../core/text');
const { watchFile } = require('../core/watch');
const { TABLE_VERSION, TABLE_SHA256 } = require('../core/connected-policy');
const registry = require('../util/registry');
const setup = require('../setup/connector');

const ROTATE_WAIT_MS = 30000;
const ROTATE_POLL_MS = 200;
const ROTATE_WATCH_POLL_MS = 2000;
const EXIT_BACKSTOP_MS = 3000;
const LAST_REPORTED_MAX = 64;     // 06-connector-state.json's maxLength

const RUN_USAGE = 'connect run [--insecure-loopback]';
const ROTATE_USAGE = 'connect rotate [--no-wait]';

const clean = (v) => stripControls(String(v));

function routeTable() {
  return { table_version: TABLE_VERSION, sha256: TABLE_SHA256 };
}

function defaults(deps = {}) {
  const d = {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    getuid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
    now: Date.now,
    pid: process.pid,
    signals: process,
    registry,
    createLink: (opts) => require('./link').createLink(opts),
    createSupervisor: (opts) => require('./supervisor').createSupervisor(opts),
    createLifecycle: (opts) => require('./lifecycle').createLifecycle(opts),
    createFacts: (opts) => require('./facts').createFacts(opts),
    watchFile,
    ...deps,
  };
  // The real process exits once stopped, whatever handle is left open; a
  // test's injected signals never reach process.exit.
  if (d.exit === undefined) d.exit = d.signals === process ? (code) => process.exit(code) : null;
  return d;
}

// The one record this machine runs, or { exit, line } saying why none runs.
function pickRecord() {
  const sole = setup.soleHub();
  if (!sole.ok) {
    return sole.refused === 'several-hubs'
      ? { exit: 0, line: 'connect run: this machine holds records for more than one hub; v1 pairs with one (run `claude-web-chat connect disconnect`, then pair again)' }
      : { exit: 0, line: 'connect run: this machine is not paired; run `claude-web-chat connect <hub-url>` in a terminal first' };
  }
  const { hubId, read } = sole;
  if (!read.ok) {
    // A record a newer build wrote names that build, when it can.
    const raw = readJson(userPaths().connectorRecord(hubId));
    const v = raw.ok && raw.value && typeof raw.value === 'object' ? raw.value.v : null;
    if (Number.isInteger(v) && v > setup.RECORD_VERSION) {
      const lr = raw.value.last_reported;
      const by = lr && typeof lr.connector_version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(lr.connector_version)
        ? `claude-web-chat ${lr.connector_version}` : 'a newer claude-web-chat';
      return {
        exit: 0,
        line: `connect run: the connector record is version ${v}, written by ${by}; this build reads version ${setup.RECORD_VERSION}. Run \`claude-web-chat update\`.`,
      };
    }
    return {
      exit: 0,
      line: `connect run: the connector record for ${hubId} is ${read.corrupt ? 'unreadable' : 'not a connector record'}; move it aside and pair again with \`claude-web-chat connect <hub-url>\``,
    };
  }
  const rec = read.value;
  const state = rec.credential.state;
  if (state === 'revoked') {
    return { exit: 0, line: `connect run: this machine's pairing with ${rec.hub.origin} was revoked; run \`claude-web-chat connect ${rec.hub.origin}\` to pair again` };
  }
  if (state !== 'paired') {
    return { exit: 0, line: `connect run: this machine is not paired yet (${state}); run \`claude-web-chat connect ${rec.hub.origin}\` in a terminal first` };
  }
  return { hubId, record: rec };
}

function loopbackHttp(origin) {
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && LOCAL_HOSTNAMES.has(u.hostname);
  } catch {
    return false;
  }
}

// The machine key, from the file the record's credential names — only when
// that file is in the connector's own directory (C-06.7), never a path
// elsewhere. Read, parsed and held as a KeyObject; its text is kept nowhere.
function readKey(record) {
  const file = record.credential && record.credential.key_file;
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.dirname(file) !== userPaths().connectorDir) return null;
  try {
    const key = crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

// 06-connector-state.json's last_reported from 12's versions record.
function lastReportedOf(versions, at) {
  const out = { at };
  const v = versions && typeof versions === 'object' ? versions : {};
  if (typeof v.package_version === 'string' && v.package_version.length <= LAST_REPORTED_MAX) out.connector_version = v.package_version;
  if (v.install && ['managed', 'dev', 'unmanaged'].includes(v.install.kind)) out.install_kind = v.install.kind;
  out.claude_code_version = typeof v.claude_code_version === 'string' && v.claude_code_version.length <= LAST_REPORTED_MAX
    ? v.claude_code_version : null;
  return out;
}

// ── connect run ──────────────────────────────────────────────────────────

async function run(args, deps) {
  const d = defaults(deps);
  const list = Array.isArray(args) ? args : [];
  const insecureLoopback = list.includes('--insecure-loopback');
  const unknown = list.filter((a) => a !== '--insecure-loopback');
  if (unknown.length) {
    d.err(`connect run: unknown argument ${clean(unknown[0]).slice(0, 40)}`);
    d.err(`usage: claude-web-chat ${RUN_USAGE}`);
    return 2;
  }
  if (d.getuid() === 0) {
    d.err('connect run: the connector runs as your own user, never as root');
    return 1;
  }
  const picked = pickRecord();
  if (!picked.record) {
    d.out(picked.line);
    return picked.exit;
  }
  const { hubId, record } = picked;
  const http = loopbackHttp(record.hub.origin);
  if (insecureLoopback && !http) {
    d.err('connect run: --insecure-loopback is for a hub on this machine\'s loopback (127.0.0.1, localhost or ::1) only');
    return 2;
  }
  if (http && !insecureLoopback) {
    d.out('connect run: the record names a plain-http hub on this machine; the connector reaches it only with --insecure-loopback');
    return 0;
  }
  const key = readKey(record);
  if (!key) {
    d.out(`connect run: the machine key is missing or unreadable; run \`claude-web-chat connect ${record.hub.origin} --re-pair\``);
    return 0;
  }

  const log = (line) => {
    try { d.out(`${new Date(d.now()).toISOString()} connector ${line}`); } catch { /* the log's own failure */ }
  };

  // The composition. ctx is what each module's install(ctx) fills.
  const ctx = { hubId, log };
  const supervisor = d.createSupervisor({ hubId, log });
  const lifecycle = d.createLifecycle({ supervisor, hubId, log });
  const facts = d.createFacts({ hubId });
  try {
    await facts.start();
  } catch {
    log('facts first read failed');
  }
  const link = d.createLink({
    record,
    key,
    versions: facts.versions,
    facts: facts.facts,
    routeTable,
    onSettings: lifecycle.applySettings,
    log,
  });
  ctx.link = link;
  const uninstalls = [];
  for (const mod of [supervisor, lifecycle, facts]) {
    const off = mod.install(ctx);
    if (typeof off === 'function') uninstalls.push(off);
  }

  d.registry.registerRole('connector', { pid: d.pid });

  // last_reported on every hello.ack (C-06.10).
  link.on('ready', () => {
    let versions = null;
    try { versions = facts.versions(); } catch { versions = null; }
    try {
      setup.updateRecord(hubId, (rec) => (rec && rec.credential.state === 'paired'
        ? { ...rec, last_reported: lastReportedOf(versions, d.now()) }
        : null));
    } catch (e) {
      log(`last_reported not written ${clean(e && e.code ? e.code : 'error').slice(0, 32)}`);
    }
  });

  // `connect rotate`'s request: checked at once when its file changes.
  let watcher = null;
  try {
    watcher = d.watchFile(setup.rotateRequestFile(hubId), () => {
      try { link.checkRotateRequest(); } catch { /* the link's own failure */ }
    }, { pollMs: ROTATE_WATCH_POLL_MS });
  } catch {
    log('rotation request watch not started');
  }

  log(`started hub ${hubId} machine ${record.machine ? record.machine.id : '?'}`);
  link.start();

  return new Promise((resolve) => {
    let stopping = false;
    const sig = d.signals;
    const off = (name, fn) => {
      if (!sig) return;
      if (typeof sig.off === 'function') sig.off(name, fn);
      else if (typeof sig.removeListener === 'function') sig.removeListener(name, fn);
    };
    const stop = async (name) => {
      if (stopping) return;
      stopping = true;
      off('SIGTERM', onTerm);
      off('SIGINT', onInt);
      log(`stopping on ${name}`);
      if (watcher) { try { watcher.stop(); } catch { /* gone */ } }
      // Release every hold — never 'now' (the daemons' idle grace ends them).
      let chats = [];
      try {
        const r = setup.readRecord(hubId);
        chats = r.ok ? r.value.chats : record.chats;
      } catch { chats = record.chats || []; }
      let released = 0;
      for (const c of chats) {
        try {
          await lifecycle.stop({ id: c.chat_id, root: c.root, owned_root: c.owned_root }, 'release');
          released += 1;
        } catch { /* a chat this build cannot name */ }
      }
      try { await link.stop(); } catch { /* closed already */ }
      for (const u of uninstalls.reverse()) { try { u(); } catch { /* best effort */ } }
      try { d.registry.deregisterRole('connector', { pid: d.pid }); } catch { /* best effort */ }
      log(`stopped; ${released} hold${released === 1 ? '' : 's'} released`);
      resolve(0);
      // A handle someone left open must not keep a stopped connector alive.
      if (typeof d.exit === 'function') {
        const t = setTimeout(() => d.exit(0), EXIT_BACKSTOP_MS);
        if (t && typeof t.unref === 'function') t.unref();
      }
    };
    const onTerm = () => { stop('SIGTERM'); };
    const onInt = () => { stop('SIGINT'); };
    if (sig && typeof sig.on === 'function') {
      sig.on('SIGTERM', onTerm);
      sig.on('SIGINT', onInt);
    }
  });
}

// ── connect rotate ───────────────────────────────────────────────────────

async function rotate(args, deps) {
  const d = {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now: Date.now,
    waitMs: ROTATE_WAIT_MS,
    connectorRow: () => require('./cli').liveConnectorRow(),
    ...deps,
  };
  const list = Array.isArray(args) ? args : [];
  const noWait = list.includes('--no-wait');
  const unknown = list.filter((a) => a !== '--no-wait');
  if (unknown.length) {
    d.err(`connect rotate: unknown argument ${clean(unknown[0]).slice(0, 40)}`);
    d.err(`usage: claude-web-chat ${ROTATE_USAGE}`);
    return 2;
  }
  const sole = setup.soleHub();
  if (!sole.ok) {
    d.err(sole.refused === 'several-hubs' ? 'connect rotate: this machine holds records for more than one hub' : 'Connector: not paired');
    return 1;
  }
  const { hubId, read } = sole;
  if (!read.ok || read.value.credential.state !== 'paired') {
    d.err(read.ok ? 'Connector: not paired' : `connect rotate: the connector record for ${hubId} cannot be read`);
    return 1;
  }
  const before = { key_id: read.value.credential.key_id, fingerprint: read.value.credential.fingerprint };
  try {
    setup.requestRotate(hubId, { at: d.now() });
  } catch (e) {
    d.err(`connect rotate: the request could not be written (${clean(e && e.code ? e.code : 'error').slice(0, 32)})`);
    return 1;
  }
  if (!d.connectorRow()) {
    d.out('the connector is not running; the rotation happens when `connect run` next connects');
    return 0;
  }
  if (noWait) {
    d.out('Rotation requested; the running connector offers the hub a new key at its next loop.');
    return 0;
  }
  const until = d.now() + Math.max(0, d.waitMs);
  for (;;) {
    let cred = null;
    try {
      const r = setup.readRecord(hubId);
      cred = r.ok ? r.value.credential : null;
    } catch { cred = null; }
    if (cred && cred.key_id && cred.key_id !== before.key_id) {
      d.out(`old key: ${before.key_id} · fingerprint ${before.fingerprint}`);
      d.out(`new key: ${cred.key_id} · fingerprint ${cred.fingerprint}`);
      return 0;
    }
    if (d.now() >= until) break;
    await d.sleep(Math.min(ROTATE_POLL_MS, Math.max(1, until - d.now())));
  }
  d.err('connect rotate: the key has not rotated yet; the request stays, and the connector performs it at its next connection');
  return 1;
}

module.exports = {
  run,
  rotate,
  routeTable,
  lastReportedOf,
  RUN_USAGE,
  ROTATE_USAGE,
  ROTATE_WAIT_MS,
};
