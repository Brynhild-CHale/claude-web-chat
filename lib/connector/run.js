'use strict';

// `claude-web-chat connect run` — the connector process (contract 06 C-06.1,
// C-06.3, C-06.10; tranche 6, U726), and `connect rotate`, the one command
// that asks it for something through its record's directory (form 3 CB2 = a).
//
// `connect run` is what the start-at-login unit runs (./install.js writes it)
// and what a person or the hub machine's supervisor runs in a terminal (manual
// mode): one long-lived process for the machine's one hub. In order:
//   * root is refused (C-06.1); the only flag is --insecure-loopback (C-05.4's
//     development flag, form 3 CB1 = b): a record whose hub is plain http on
//     127.0.0.1 or localhost runs only with it, and with it any other hub
//     refuses;
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
//     lib/core/connected-policy (U744), onSettings = lifecycle.applySettings
//     and heartbeatBody = U729's signals.heartbeatBody (the minimal body until
//     the signals module exists). Each composed module's install(ctx) is
//     called, ctx.link set first; then (U790) the relay (U717: targetOf from
//     the supervisor's answers, the chats' origins and the relay credential,
//     hintFor = remote-policy's hintFor), the ring (U723), the delivery
//     (U728), the signals (U729), the authority log (U730, its redactor and
//     the link holding every relay secret), the chats (U720, chat.assign on
//     the control channel, the ring's cursor set first, every outcome tracked
//     and polled), the folders' watch (U721) and the local socket (U731, with
//     ctx.releaseAll: connector.release-all). A revocation prints the hub's
//     hint once ('connect run: the hub says: <hint>', the link's cleaned copy;
//     U726b), runs disconnectLocal('revoked') with that release in process,
//     then stops;
//   * at boot the record's running chats are resumed (chats.resume);
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
// codes, ids and counts only: never a key, a secret or a path, and no hub text
// but machine.revoked's hint, cleaned by the link and withheld when it holds a
// registered secret (05 C-05.9 gives it for the person at the machine). The
// advice a line gives for a plain-http loopback record names
// --insecure-loopback (pairAgain).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { userPaths } = require('../core/paths');
const { readJson } = require('../core/fsjson');
const { LOCAL_HOSTNAMES } = require('../core/cors');
const { stripControls } = require('../core/text');
const { watchFile } = require('../core/watch');
const { TABLE_VERSION, TABLE_SHA256 } = require('../core/connected-policy');
const remotePolicy = require('../core/remote-policy');
const { isSafeId } = require('../core/paths');
const registry = require('../util/registry');
const setup = require('../setup/connector');
const { minimalHeartbeat } = require('./link');

const ROTATE_WAIT_MS = 30000;
const ROTATE_POLL_MS = 200;
const ROTATE_WATCH_POLL_MS = 2000;
const EXIT_BACKSTOP_MS = 3000;
const LAST_REPORTED_MAX = 64;     // 06-connector-state.json's maxLength
const SECRETS_PER_CHAT = 8;       // relay secrets a chat keeps registered

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
    // The rest of the composition (U790, CONNECTOR@install-seam): each is the
    // owning module's own constructor or install, a seam a test may replace.
    installRelay: (ctx) => require('./relay').install(ctx),
    createRing: (opts) => require('./ring').createRing(opts),
    createDelivery: (opts) => require('./delivery').createDelivery(opts),
    createSignals: (opts) => require('./signals').createSignals(opts),
    installAuthorityLog: (ctx) => require('./authority-log').install(ctx),
    createChats: (opts) => require('./chats').createChats(opts),
    installFolders: (ctx, opts) => require('./folders').install(ctx, opts),
    installLocalSocket: (ctx, opts) => require('./local-socket').install(ctx, opts),
    createRedactor: () => require('../core/redact').createRedactor(),
    disconnectLocal: (opts) => setup.disconnectLocal(opts),
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
    return { exit: 0, line: `connect run: this machine's pairing with ${rec.hub.origin} was revoked; run \`${pairAgain(rec.hub.origin)}\` to pair again` };
  }
  if (state !== 'paired') {
    return { exit: 0, line: `connect run: this machine is not paired yet (${state}); run \`${pairAgain(rec.hub.origin)}\` in a terminal first` };
  }
  return { hubId, record: rec };
}

// Whether a record's hub origin is plain http on 127.0.0.1 or localhost (the
// one kind --insecure-loopback admits); install.js's --pair-only sentence asks
// it too.
function loopbackHttp(origin) {
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && LOCAL_HOSTNAMES.has(u.hostname);
  } catch {
    return false;
  }
}

// The command that pairs this record's hub again: --insecure-loopback when
// its origin is plain http on 127.0.0.1 or localhost (the flag is per
// invocation; without it `connect` refuses that origin). `connect status`
// (./cli.js) prints the same for a revoked record.
function pairAgain(origin, { rePair = false } = {}) {
  return `claude-web-chat connect ${origin}${rePair ? ' --re-pair' : ''}${loopbackHttp(origin) ? ' --insecure-loopback' : ''}`;
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
    d.err('connect run: --insecure-loopback is for a hub on this machine\'s loopback (127.0.0.1 or localhost) only');
    return 2;
  }
  if (http && !insecureLoopback) {
    d.out('connect run: the record names a plain-http hub on this machine; the connector reaches it only with --insecure-loopback');
    return 0;
  }
  const key = readKey(record);
  if (!key) {
    d.out(`connect run: the machine key is missing or unreadable; run \`${pairAgain(record.hub.origin, { rePair: true })}\``);
    return 0;
  }

  const log = (line) => {
    try { d.out(`${new Date(d.now()).toISOString()} connector ${line}`); } catch { /* the log's own failure */ }
  };

  // The composition. ctx is what each module's install(ctx) fills.
  const ctx = { hubId, log };
  const supervisor = d.createSupervisor({ hubId, log });
  // The supervisor's answers as the relay's targetOf reads them (U718/U719/
  // U720 → U717): the supervisor keeps a chat's pid and port to itself, so the
  // lifecycle is handed a view that notes each answer and registers the relay
  // secret of a daemon this connector spawned on the link (a frame holding it
  // is never sent, C-05.50) and on the authority log's redactor.
  // Each respawn mints a new secret (U718), so a chat keeps at most its last
  // SECRETS_PER_CHAT registered; the oldest beyond that, and every secret of
  // a chat the connector forgets, is unregistered from the link (its stored
  // off()) and from the redactor (U790@run.js:secrets-never-unregistered).
  const redactor = d.createRedactor();
  const daemons = new Map();       // chat id → { pid, port, root }
  const secrets = new Map();       // chat id → [{ secret, off }], oldest first
  const dropSecret = (e) => {
    try { if (typeof e.off === 'function') e.off(); } catch { /* the link's */ }
    try { if (redactor && typeof redactor.removeKnown === 'function') redactor.removeKnown(e.secret); } catch { /* the redactor's */ }
  };
  const noteSecret = (id) => {
    let s = null;
    try { s = supervisor.relayCredential(id); } catch { s = null; }
    if (!s) return;
    const kept = secrets.get(id) || [];
    if (kept.some((e) => e.secret === s)) return;
    let off = null;
    try { if (ctx.link && typeof ctx.link.registerSecret === 'function') off = ctx.link.registerSecret(s); } catch { off = null; }
    try { if (redactor && typeof redactor.addKnown === 'function') redactor.addKnown(s, 'relay-secret'); } catch { /* the redactor's */ }
    kept.push({ secret: s, off });
    while (kept.length > SECRETS_PER_CHAT) dropSecret(kept.shift());
    secrets.set(id, kept);
  };
  const forgetSecrets = (id) => {
    const kept = secrets.get(id);
    secrets.delete(id);
    if (kept) for (const e of kept) dropSecret(e);
  };
  const supervised = {
    ...supervisor,
    async ensureRunning(chat) {
      const r = await supervisor.ensureRunning(chat);
      const id = chat && (chat.id != null ? chat.id : chat.chat_id);
      if (r && r.state === 'running' && Number.isInteger(r.port) && Number.isInteger(r.pid)) {
        daemons.set(id, { pid: r.pid, port: r.port, root: chat.root });
        noteSecret(id);
      } else {
        daemons.delete(id);
      }
      return r;
    },
    forget(chatId) {
      daemons.delete(chatId);
      forgetSecrets(chatId);
      return supervisor.forget(chatId);
    },
  };
  const lifecycle = d.createLifecycle({ supervisor: supervised, hubId, log });
  const facts = d.createFacts({ hubId });
  try {
    await facts.start();
  } catch {
    log('facts first read failed');
  }
  // heartbeatBody is U729's (U726-U716@link-composition-inputs (a)); the
  // signals module is made after the link, so the link is handed a seam that
  // answers the minimal body until it exists.
  let signals = null;
  const link = d.createLink({
    record,
    key,
    versions: facts.versions,
    facts: facts.facts,
    routeTable,
    heartbeatBody: (base) => (signals ? signals.heartbeatBody(base) : minimalHeartbeat(base)),
    onSettings: lifecycle.applySettings,
    log,
  });
  ctx.link = link;
  const uninstalls = [];
  for (const mod of [supervisor, lifecycle, facts]) {
    const off = mod.install(ctx);
    if (typeof off === 'function') uninstalls.push(off);
  }

  const readCurrent = () => {
    try {
      const r = setup.readRecord(hubId);
      return r.ok ? r.value : null;
    } catch {
      return null;
    }
  };
  const chatOf = (c) => ({ id: c.chat_id, root: c.root, owned_root: c.owned_root });

  // The relay (U717): targetOf from the supervisor's answers, the chats'
  // origins and the relay credential; hintFor is U745's
  // hintFor(need, {connected, destructive}) (U717-U745@hintFor-signature (a)).
  const targetOf = (label) => {
    const t = daemons.get(label);
    if (!t) return null;
    let origins = null;
    try { origins = ctx.chats ? ctx.chats.originsOf(label) : null; } catch { origins = null; }
    let secret = null;
    try { secret = supervisor.relayCredential(label); } catch { secret = null; }
    return { running: true, root: t.root, rec: { pid: t.pid, port: t.port }, origins, secret };
  };
  const relay = d.installRelay({
    link,
    targetOf,
    record: readCurrent,
    hintFor: remotePolicy.hintFor,
    log,
    onUnconfirmed: (label) => log(`relay identity unconfirmed chat ${isSafeId(label) ? label : '?'}`),
  });
  ctx.relay = relay;
  uninstalls.push(() => { try { relay.stop(); } catch { /* stopped */ } });

  // The ring reader (U723), the delivery and its ledger (U728), the signals,
  // status poll and heartbeat rows (U729), the authority log (U730).
  const ring = d.createRing({ log });
  uninstalls.push(ring.install(ctx));
  const delivery = d.createDelivery({ relay, ring, lifecycle, hubId, log });
  uninstalls.push(delivery.install(ctx));
  signals = d.createSignals({ log });
  uninstalls.push(signals.install(ctx));
  const alog = d.installAuthorityLog({ relay, link, paths: userPaths(), log, redactor });
  ctx.authorityLog = alog;
  uninstalls.push(() => { try { alog.stop(); } catch { /* stopped */ } });

  // Every status after a lifecycle stop is the signals module's (U729's
  // hand-off): a stopped chat gets its 'stopped' row only by this poll.
  const pollAfter = async (id) => {
    try { await signals.pollNow(id); } catch { /* the poll's own failure */ }
  };
  // The chats (U720), over a lifecycle that tracks each chat's root in the
  // ring and the signals beside lifecycle.run, and polls after every stop.
  const chatLifecycle = {
    ...lifecycle,
    run: (chat) => {
      const id = chat && (chat.id != null ? chat.id : chat.chat_id);
      try { ring.track({ id, root: chat.root }); } catch { /* the ring's */ }
      try { signals.track({ id, root: chat.root }); } catch { /* the signals' */ }
      return lifecycle.run(chat);
    },
    stop: async (chat, mode) => {
      const r = await lifecycle.stop(chat, mode);
      const id = chat && (chat.id != null ? chat.id : chat.chat_id);
      await pollAfter(id);
      return r;
    },
  };
  const chats = d.createChats({ lifecycle: chatLifecycle, hubId, log });
  uninstalls.push(chats.install(ctx));
  // After every outcome that is not ignored (U729's hand-off): track, then
  // poll, so a refused chat (rev 0, never run) reaches the hub as chat.status
  // too; a removal is forgotten only after that poll.
  const afterOutcome = async (o) => {
    if (!o || o.ignored || typeof o.chat_id !== 'string') return;
    const rec = readCurrent();
    const entry = rec && Array.isArray(rec.chats) ? rec.chats.find((c) => c.chat_id === o.chat_id) : null;
    try { signals.track({ id: o.chat_id, ...(entry ? { root: entry.root } : {}) }); } catch { /* the signals' */ }
    await pollAfter(o.chat_id);
    if (o.removed) {
      try { signals.forget(o.chat_id); } catch { /* forgotten */ }
      try { ring.forget(o.chat_id); } catch { /* forgotten */ }
    }
  };
  const applyAssign = async (f) => {
    const a = f && f.assignment;
    // 07's cursor precedes the read (U723: setCursor before lifecycle.run).
    if (a && typeof a.chat_id === 'string' && f.cursor) {
      try { ring.setCursor(a.chat_id, f.cursor); } catch { /* a cursor the ring refuses */ }
    }
    let o = null;
    try { o = await chats.apply(a); } catch { o = null; }
    await afterOutcome(o);
    return o;
  };
  uninstalls.push(link.channel('control', { kinds: ['chat.assign'], handle: (f) => applyAssign(f) }));

  // The folders' watch (U721): a change re-sends machine.facts; a withdrawn
  // folder's chats are released and refused folder-withdrawn (chats.resume
  // refuses a running record chat whose folder is gone).
  ctx.onFoldersChanged = () => { try { link.factsChanged(); } catch { /* the link's */ } };
  ctx.onFolderWithdrawn = (folderId) => {
    (async () => {
      const rec = readCurrent();
      for (const c of (rec && rec.chats) || []) {
        if (c.scope_kind !== 'folder' || c.folder_id !== folderId) continue;
        try { await chatLifecycle.stop(chatOf(c), 'release'); } catch { /* the lifecycle's */ }
      }
      let outs = [];
      try { outs = await chats.resume(); } catch { outs = []; }
      for (const o of outs) await afterOutcome(o);
    })().catch(() => {});
  };
  try {
    const stopFolders = d.installFolders(ctx, { hubId });
    if (typeof stopFolders === 'function') uninstalls.push(stopFolders);
  } catch (e) {
    log(`folders watch not started ${clean(e && e.code ? e.code : 'error').slice(0, 32)}`);
  }

  // connector.release-all (form 2, S4; U727-U731@via-connector-socket-op (a)):
  // every hold released, every started_by: connector daemon and every daemon
  // on an owned root stopped now (lifecycle.stop 'now' decides which), each
  // chat polled after its stop; a daemon left running is named in `left`.
  const releaseAll = async () => {
    const rec = readCurrent();
    const left = [];
    let stopped = 0;
    for (const c of (rec && rec.chats) || []) {
      let by = null;
      try { by = supervisor.startedBy(c.chat_id); } catch { by = null; }
      let r = null;
      try { r = await chatLifecycle.stop(chatOf(c), 'now'); } catch { r = null; }
      if (r && r.shutdown) { stopped += 1; continue; }
      let live = null;
      try { live = await d.registry.daemonFor(c.root); } catch { live = null; }
      if (!live) continue;
      const why = c.owned_root || by === 'connector' ? 'not-stopped' : 'other';
      left.push({ chat_id: c.chat_id, scope_kind: c.scope_kind, root: c.root, why });
    }
    log(`release-all: ${stopped} stopped, ${left.length} left`);
    return { left, stopped };
  };
  ctx.releaseAll = releaseAll;

  // The local socket (U731): `connect disconnect`, `connect ls|open|…` reach
  // this process through it. A socket that cannot be opened is logged by the
  // module and leaves the connector running (the CLI then takes its direct
  // path).
  try {
    const stopSocket = await d.installLocalSocket(ctx, {});
    if (typeof stopSocket === 'function') uninstalls.push(() => stopSocket());
  } catch {
    /* logged by the socket's install, `local socket refused code=…` */
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
  // The record's running chats come back on their own (U720 resume): after a
  // restart the hub's resend of an applied rev is ignored.
  chats.resume()
    .then(async (outs) => { for (const o of outs || []) await afterOutcome(o); })
    .catch(() => log('resume failed'));
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
    // A revocation (the link's 'revoked'): C-06.9's local half with the
    // in-process release as its viaConnector — never connector.leave (the hub
    // revoked the machine itself) — then this process stops. Inside a
    // start-at-login unit the unload, last, ends it anyway.
    let hintSaid = false;
    link.on('revoked', (ev) => {
      // The hub's hint for the person at the machine, once (U726b): the link
      // cleaned it and withheld it if it held a registered secret.
      const hint = ev && typeof ev.hint === 'string' && ev.hint ? ev.hint : null;
      if (hint && !hintSaid) {
        hintSaid = true;
        d.out(`connect run: the hub says: ${clean(hint)}`);
      }
      if (stopping) return;
      (async () => {
        try {
          const r = await d.disconnectLocal({
            hubId,
            reason: 'revoked',
            deps: { viaConnector: async () => ({ ok: true, ...(await releaseAll()) }) },
          });
          log(`revoked: local half ${r && r.ok ? 'done' : 'incomplete'}`);
        } catch (e) {
          log(`revoked: local half failed ${clean(e && e.code ? e.code : 'error').slice(0, 32)}`);
        }
        await stop('revoked');
      })().catch(() => {});
    });
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
  loopbackHttp,
  pairAgain,
  RUN_USAGE,
  ROTATE_USAGE,
  ROTATE_WAIT_MS,
};
