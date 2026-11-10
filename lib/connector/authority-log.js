'use strict';

// The connector's authority log (04 C-04.27, 04-deny-record.json; 05 C-05.37,
// 05-event.json authority_log; 11 C-11.20 and C-11.1 (h); tranche 6, U730).
//
//   createAuthorityLog({ file, link, now, log, redactor, timers }) → alog
//     alog.record(event)  the relay's 'deny' handler (never throws)
//     alog.flush()        close every open window now (written and queued)
//     alog.stop()         flush, a last ship, then detach and close the file
//     alog.stats()        counters (codes and counts only)
//   install(ctx) → alog   (CONNECTOR@install-seam: subscribes to ctx.relay's
//                          'deny' (U717) and ships on ctx.link (U716); U790
//                          wires it)
//
// COALESCE (C-04.27: "identical lines within 60 s coalesce with a count";
// 04-deny-record count/first_ts/ts). A deny event opens or joins the window of
// its identical line: the same principal (the whole 03 record), chat, rule and
// reason, and every other field of the line equal too (machine, decision,
// enforcer, origin, method, path, need, status), so one record never stands
// for a denial it does not describe. The window closes WINDOW_MS after its
// first event (or on flush/stop) and only then is its record written and
// queued: count events, first_ts the first, ts the last (RFC 3339 UTC).
//
// WRITE (C-11.20; LOG@applog). One JSONL line per closed record through
// lib/core/applog openLog(file, {epoch: false}) — 0600, O_APPEND, one write per
// record, a torn tail set aside on the next open — so a line is a deny record
// and nothing else (no epoch, no pid, no boot):
//   {t: 'deny', ts, first_ts, count, enforcer, principal: <id>, chat_id,
//    machine_id, decision_id, origin, method, path, rule, need, reason, status}
// `principal` is the principal's id, never the record and never an email
// (C-11.20, C-03.4): its account (usr_/svc_), else its credential instance
// (an agent's agt_ token, a key, a session), else null. Every id is written
// only when it matches 04's or 03's grammar; `path` (the one free text) loses
// its query and fragment, passes the connector's redactor and is cut at 512
// (as access-log.js and 04-deny-record cut it); every other text field is
// redacted and bounded. No body, hint, header or secret is ever handed here.
// ROTATION (C-11.20 "capped at 1 MiB with one .1", access-log.js's shape):
// before a line that would take a non-empty file past MAX_BYTES the open log is
// closed, the file renamed to `<file>.1` (replacing an earlier one) and the log
// opened anew — between opens, because applog never rewrites a line. A write
// that fails is reported once through `log` (a code); the record still ships.
//
// SHIP (C-05.37: loss "never"; U730@authority-log-delivery (a)). A closed
// record whose event named a principal is queued in memory with the full 03
// principal the deciding decision carried and `sink: 'log'` (an 'activity'
// record needs a hub-built summary, 11-activity-summary.json, which the
// connector cannot author: the hub derives C-04.27's Activity entries from the
// records it receives). It goes out as `authority.log` frames on the events
// channel, at most FRAME_RECORDS records a frame, when the link is ready and
// then at most once every SHIP_EVERY_MS. 05 gives authority.log no ack, and
// link.send reports no write (U716's seam returns the frame id once the frame
// is queued), so a sent frame is IN FLIGHT until the connection it went out on
// has stayed up HOLD_MS (the link's dead_after_ms: a dead connection is closed
// within it) — then it counts as shipped and leaves memory. A link 'closed'
// puts every in-flight record back at the head of the queue, so after the next
// 'ready' the records that may not have reached the hub, and those closed
// while the link was down, go first (C-05.20's resend-before-new rule): at
// least once, never silently lost while the process lives. The queue holds at
// most QUEUE_MAX records; past it the oldest are dropped, counted, and told
// once (a code); a record in flight at three 4400 closes is dropped from the
// queue (a poison frame must not take the link down after every reconnect).
// A record with no principal (a no-decision refusal with no
// decision to read one from) or with a field outside 04-deny-record's grammar
// is written to the file and not shipped (counted): 04-deny-record requires a
// valid principal, and an invalid frame is a fatal bad_frame (A-05.1).
//
// NEVER: an email, a prompt, a body, a query string, a hint, a header or a
// secret in a line or a frame (C-11.20, C-11.6); appendFileSync or an
// append-mode open outside applog (the conventions ratchet); an 'activity'
// sink or a summary on the wire; a throw into the relay.

const fs = require('fs');
const path = require('path');
const { openLog } = require('../core/applog');
const { createRedactor } = require('../core/redact');
const { stableKey } = require('../core/stable-json');
const { userPaths } = require('../core/paths');
const { DEAD_AFTER_MS } = require('./link');

const WINDOW_MS = 60 * 1000;           // C-04.27: identical lines within 60 s
const MAX_BYTES = 1024 * 1024;         // C-11.20: capped at 1 MiB with one .1
const QUEUE_MAX = 10000;               // U730@authority-log-delivery (a)
const FRAME_RECORDS = 200;             // 05-event.json authority_log maxItems
const SHIP_EVERY_MS = 1000;            // at most once a second
const HOLD_MS = DEAD_AFTER_MS;         // a frame counts as shipped after this long up
const POISON_CLOSES = 3;               // 4400 closes with a record in flight before it is dropped
const PATH_MAX = 512;                  // 04-deny-record.json path
const TEXT_MAX = 128;                  // any other text field, bounded
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// 04-deny-record.json's grammar (the conformance test holds these equal to it).
const LABEL_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;
const MACHINE_RE = /^mch_[0-9a-hjkmnp-tv-z]{26}$/;
const DECISION_RE = /^dec_[0-9a-hjkmnp-tv-z]{26}$/;
const METHOD_RE = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|WS|MSG)$/;
const RULE_RE = /^(\*|[A-Z]+(\|[A-Z]+)*) \//;
const ENFORCERS = new Set(['connector', 'daemon']); // 'hub' is the hub's own
const ORIGINS = new Set(['session', 'answer', 'ws-inbound']);
const NEEDS = new Set(['status', 'read', 'message', 'write_page', 'files', 'host_only', 'retired']);
const REASONS = new Set([
  'no-access', 'level', 'requires', 'host-only', 'retired', 'unknown', 'malformed', 'query',
  'ceiling', 'archived', 'expired', 'no-decision', 'second-lock', 'daemon-rule',
]);

// 03-principal.json's properties (its cross-field rules are the hub's, which
// minted the decision the principal rides on).
const PRINCIPAL = Object.freeze({
  v: (x) => x === 1,
  user: (x) => x === null || (typeof x === 'string' && /^(usr_[0-9a-hjkmnp-tv-z]{26}|svc_[0-9a-hjkmnp-tv-z]{26}|svc_home)$/.test(x)),
  machine: (x) => x === null || (typeof x === 'string' && MACHINE_RE.test(x)),
  chat: (x) => x === null || (typeof x === 'string' && /^cht_[0-9a-hjkmnp-tv-z]{26}$/.test(x)),
  session: (x) => x === null || (typeof x === 'string'
    && /^((ses|srf|key|cxs|agt)_[0-9a-hjkmnp-tv-z]{26}|cc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(x)),
  writer_class: (x) => x === null || ['claude', 'service', 'driver', 'pane', 'user', 'remote'].includes(x),
  owner: (x) => x === null || (typeof x === 'string' && x.length <= 128 && /^(claude|service:[a-z][a-z0-9-]*)$/.test(x)),
  verified: (x) => typeof x === 'boolean',
  verified_by: (x) => x === null || x === 'hub' || x === 'daemon',
  via: (x) => ['shell', 'phone', 'notification', 'api', 'mcp', 'scheduler', 'connector', 'hub'].includes(x),
});
const PRINCIPAL_REQUIRED = ['v', 'user', 'machine', 'session', 'writer_class', 'verified', 'verified_by', 'via'];

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const iso = (ms) => new Date(ms).toISOString();
const codeOf = (e) => (e && typeof e.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(e.code) ? e.code : 'error');

// 03-principal.json whole: its properties, then its seven cross-field rules
// (allOf), so a record the hub would refuse as a bad frame never ships (an
// invalid authority.log is fatal, A-05.1, and would be resent after every
// reconnect). The conformance test holds this equal to the schema.
function principalOk(p) {
  if (!isPlainObject(p)) return false;
  for (const k of Object.keys(p)) if (!own(PRINCIPAL, k) || !PRINCIPAL[k](p[k])) return false;
  if (!PRINCIPAL_REQUIRED.every((k) => own(p, k))) return false;
  const str = (x) => typeof x === 'string';
  if (p.verified === true ? !(p.verified_by === 'hub' || p.verified_by === 'daemon') : p.verified_by !== null) return false;
  if (p.verified_by === 'daemon'
    && !(p.user === null && str(p.machine) && ['claude', 'service', 'driver'].includes(p.writer_class) && p.via === 'connector')) return false;
  const hubVerified = p.writer_class === 'remote' && p.verified === true && p.verified_by === 'hub';
  if (['shell', 'phone', 'notification', 'api'].includes(p.via) && !(str(p.user) && p.machine === null && hubVerified)) return false;
  if (p.via === 'mcp') {
    if (!hubVerified) return false;
    const key = str(p.user) && p.machine === null && str(p.session) && p.session.startsWith('key_');
    const agent = own(p, 'chat') && str(p.chat) && p.user === null && str(p.machine) && str(p.session) && p.session.startsWith('agt_');
    if (key === agent) return false; // oneOf: exactly one
  }
  if (p.via === 'hub'
    && !(p.user === null && p.machine === null && p.session === null && p.writer_class === null && p.verified === false)) return false;
  if ((p.writer_class === 'pane' || p.writer_class === 'user') && !(p.verified === false && p.user === null)) return false;
  if (str(p.owner) && !(p.verified === true && p.verified_by === 'daemon')) return false;
  return true;
}

// The principal's id on disk (C-11.20): its account, else its credential.
function principalId(p) {
  if (!isPlainObject(p)) return null;
  if (PRINCIPAL.user(p.user) && p.user !== null) return p.user;
  if (PRINCIPAL.session(p.session) && p.session !== null) return p.session;
  return null;
}

function createAuthorityLog({
  file,
  link = null,
  now = Date.now,
  log = () => {},
  redactor = null,
  timers = { setTimeout, clearTimeout },
  windowMs = WINDOW_MS,
  maxBytes = MAX_BYTES,
  queueMax = QUEUE_MAX,
  shipEveryMs = SHIP_EVERY_MS,
  holdMs = HOLD_MS,
} = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('authority log: a file path is required');
  const say = (line) => { try { log(line); } catch { /* the log's own failure */ } };
  const red = redactor && typeof redactor.text === 'function' ? redactor : createRedactor();
  const T = timers;
  const clock = () => { const t = Number(now()); return Number.isFinite(t) ? t : Date.now(); };

  const windows = new Map();   // line key → { line, principal, firstMs, lastMs, count, timer }
  const pending = [];          // { rec, sent: null | { gen, at }, badCloses }, oldest first
  const st = {
    events: 0, records: 0, written: 0, write_failures: 0, rotations: 0,
    queued: 0, shipped: 0, frames: 0, resent: 0, dropped: 0, local_only: 0, poisoned: 0,
  };
  let handle = null;
  let size = 0;
  let writeWarned = false;
  let dropWarned = false;
  let localWarned = false;
  let poisonWarned = false;
  let gen = 0;                 // the link's connection: +1 on every 'closed'
  let lastShip = -Infinity;
  let tick = null;
  let stopped = false;

  // ── the line ─────────────────────────────────────────────────────────────
  function text(v, max) {
    let s = typeof v === 'string' ? v : String(v == null ? '' : v);
    try { s = red.text(s); } catch { s = ''; }
    return s.slice(0, max);
  }
  const idOr = (v, re) => (v === null || v === undefined ? null : typeof v === 'string' && re.test(v) ? v : text(v, TEXT_MAX));
  const oneOf = (v, set) => (v === null || v === undefined ? null : set.has(v) ? v : text(v, TEXT_MAX));

  // The event as a line's fields (bounded, redacted), and whether every field
  // holds 04-deny-record's grammar.
  function lineOf(e) {
    const rawPath = typeof e.path === 'string' ? e.path : '';
    const fields = {
      enforcer: oneOf(e.enforcer, ENFORCERS),
      principal: principalId(e.principal),
      chat_id: idOr(e.chat_id, LABEL_RE),
      machine_id: idOr(e.machine_id, MACHINE_RE),
      decision_id: idOr(e.decision_id, DECISION_RE),
      origin: oneOf(e.origin, ORIGINS),
      method: typeof e.method === 'string' && METHOD_RE.test(e.method) ? e.method : text(e.method, 16),
      path: text(rawPath.split(/[?#]/)[0], PATH_MAX),
      rule: e.rule === null || e.rule === undefined ? null : typeof e.rule === 'string' && e.rule.length <= PATH_MAX && RULE_RE.test(e.rule) ? text(e.rule, PATH_MAX) : text(e.rule, TEXT_MAX),
      need: oneOf(e.need, NEEDS),
      reason: oneOf(e.reason, REASONS),
      status: e.status === null || e.status === undefined ? null : Number.isInteger(e.status) ? e.status : null,
    };
    const valid = ENFORCERS.has(fields.enforcer)
      && typeof fields.chat_id === 'string' && LABEL_RE.test(fields.chat_id)
      && (fields.machine_id === null || MACHINE_RE.test(fields.machine_id))
      && (fields.decision_id === null || DECISION_RE.test(fields.decision_id))
      && ORIGINS.has(fields.origin)
      && METHOD_RE.test(fields.method)
      && (fields.rule === null || RULE_RE.test(fields.rule))
      && (fields.need === null || NEEDS.has(fields.need))
      && REASONS.has(fields.reason)
      && (fields.status === null || (fields.status >= 400 && fields.status <= 599));
    return { fields, valid };
  }

  // ── coalescing ───────────────────────────────────────────────────────────
  function record(e) {
    try {
      if (stopped || !isPlainObject(e)) return;
      st.events++;
      const t = clock();
      const { fields, valid } = lineOf(e);
      const principal = principalOk(e.principal) ? e.principal : null;
      const key = stableKey({ fields, principal: e.principal == null ? null : e.principal });
      const w = windows.get(key);
      if (w && t - w.firstMs < windowMs) {
        w.count++;
        if (t > w.lastMs) w.lastMs = t;
        return;
      }
      if (w) closeWindow(key, w);
      const nw = { fields, valid, principal, firstMs: t, lastMs: t, count: 1, timer: null };
      nw.timer = T.setTimeout(() => { nw.timer = null; if (windows.get(key) === nw) closeWindow(key, nw); }, windowMs);
      if (nw.timer && typeof nw.timer.unref === 'function') nw.timer.unref();
      windows.set(key, nw);
    } catch (err) {
      say(`authority log event dropped code=${codeOf(err)}`);
    }
  }

  function closeWindow(key, w) {
    windows.delete(key);
    if (w.timer) { try { T.clearTimeout(w.timer); } catch { /* the timer's */ } w.timer = null; }
    st.records++;
    const ts = iso(w.lastMs);
    const firstTs = iso(w.firstMs);
    const f = w.fields;
    write({
      t: 'deny', ts, first_ts: firstTs, count: w.count, enforcer: f.enforcer, principal: f.principal,
      chat_id: f.chat_id, machine_id: f.machine_id, decision_id: f.decision_id, origin: f.origin,
      method: f.method, path: f.path, rule: f.rule, need: f.need, reason: f.reason, status: f.status,
    });
    if (!w.valid || !w.principal) {
      st.local_only++;
      if (!localWarned) { localWarned = true; say(`authority log record kept local code=${w.principal ? 'invalid' : 'no-principal'}`); }
      return;
    }
    enqueue({
      ts, first_ts: firstTs, count: w.count, enforcer: f.enforcer, sink: 'log', principal: w.principal,
      chat_id: f.chat_id, machine_id: f.machine_id, decision_id: f.decision_id, origin: f.origin,
      method: f.method, path: f.path, rule: f.rule, need: f.need, reason: f.reason, status: f.status,
    });
  }

  function flush() {
    for (const [key, w] of [...windows]) closeWindow(key, w);
  }

  // ── the file ─────────────────────────────────────────────────────────────
  function closeHandle() {
    const h = handle;
    handle = null;
    if (h) { try { h.close(); } catch { /* applog's */ } }
  }
  function openHandle() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
    const h = openLog(file, { epoch: false, now: clock });
    try {
      h.load();
    } catch (e) {
      h.close();
      throw e;
    }
    handle = h;
    size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    try { if (size > 0) fs.chmodSync(file, FILE_MODE); } catch { /* applog's mode on create stands */ }
  }
  function rotate() {
    closeHandle();
    fs.renameSync(file, `${file}.1`);
    st.rotations++;
    openHandle();
  }
  function write(line) {
    try {
      if (!handle) openHandle();
      const bytes = Buffer.byteLength(`${JSON.stringify(line)}\n`);
      if (size > 0 && size + bytes > maxBytes) rotate();
      const r = handle.append(line);
      size = r.offset + r.bytes;
      st.written++;
    } catch (e) {
      st.write_failures++;
      closeHandle(); // the next write reopens (a torn tail is set aside then)
      if (!writeWarned) { writeWarned = true; say(`authority log write failed code=${codeOf(e)}`); }
    }
  }

  // ── the queue and the link ───────────────────────────────────────────────
  function enqueue(rec) {
    pending.push({ rec, sent: null, badCloses: 0 });
    st.queued++;
    while (pending.length > queueMax) {
      pending.shift();
      st.dropped++;
      if (!dropWarned) { dropWarned = true; say('authority log queue full; oldest dropped code=queue-full'); }
    }
    arm(0);
  }

  const linkUp = () => !!link && link.state === 'up';

  function arm(delay) {
    if (stopped || tick || !pending.length || !linkUp()) return;
    tick = T.setTimeout(() => { tick = null; ship(); }, Math.max(0, delay));
    if (tick && typeof tick.unref === 'function') tick.unref();
  }

  // In-flight records whose connection stayed up HOLD_MS are shipped.
  function confirm(t) {
    let i = 0;
    while (i < pending.length) {
      const p = pending[i];
      if (p.sent && p.sent.gen === gen && t - p.sent.at >= holdMs) {
        pending.splice(i, 1);
        st.shipped++;
      } else {
        i++;
      }
    }
  }

  function sendFrame(records) {
    try {
      return link.send('events', 'authority.log', { records });
    } catch (e) {
      if (e && e.code === 'ELINKFRAME' && records.length > 1) return 'split';
      say(`authority log frame not sent code=${codeOf(e)}`);
      return null;
    }
  }

  function ship({ force = false } = {}) {
    if (!linkUp() || !pending.length) return;
    const t = clock();
    if (!force && t - lastShip < shipEveryMs) { arm(shipEveryMs - (t - lastShip)); return; }
    confirm(t);
    // In-flight records are always the queue's head (sent oldest first, and a
    // 'closed' unsends them all), so the unsent ones are one run after them.
    let size1 = FRAME_RECORDS;
    let i = pending.findIndex((p) => !p.sent);
    let sentAny = false;
    while (i !== -1 && i < pending.length) {
      const batch = pending.slice(i, i + size1);
      const id = sendFrame(batch.map((p) => p.rec));
      if (id === 'split') { size1 = Math.max(1, Math.floor(batch.length / 2)); continue; }
      if (!id) break;
      for (const p of batch) p.sent = { gen, at: t };
      st.frames++;
      sentAny = true;
      i += batch.length;
    }
    if (sentAny) lastShip = t;
    // Keep ticking while anything is unsent or in flight: the in-flight wait
    // for HOLD_MS, the unsent for the next second.
    if (pending.length) arm(pending.some((p) => !p.sent) ? shipEveryMs : Math.min(shipEveryMs, holdMs));
  }

  function onReady() {
    if (stopped) return;
    if (tick) { try { T.clearTimeout(tick); } catch { /* the timer's */ } tick = null; }
    ship({ force: true });
  }
  // A close with 4400 (a protocol error: an invalid frame is fatal, A-05.1)
  // while records were in flight counts against each of them; a record in
  // flight at POISON_CLOSES such closes is dropped from the queue (it stays in
  // the file), so one record the hub refuses cannot take the link down after
  // every reconnect.
  function onClosed(info) {
    gen++;
    const badFrame = !!info && info.code === 4400;
    let back = 0;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (!p.sent) continue;
      p.sent = null;
      if (badFrame && ++p.badCloses >= POISON_CLOSES) {
        pending.splice(i, 1);
        st.poisoned++;
        if (!poisonWarned) { poisonWarned = true; say('authority log record dropped after protocol errors code=bad-frame'); }
        continue;
      }
      back++;
    }
    st.resent += back;
    if (tick) { try { T.clearTimeout(tick); } catch { /* the timer's */ } tick = null; }
  }
  if (link && typeof link.on === 'function') {
    link.on('ready', onReady);
    link.on('closed', onClosed);
  }

  function stop() {
    if (stopped) return;
    flush();
    ship({ force: true });
    stopped = true;
    if (tick) { try { T.clearTimeout(tick); } catch { /* the timer's */ } tick = null; }
    if (link && typeof link.removeListener === 'function') {
      link.removeListener('ready', onReady);
      link.removeListener('closed', onClosed);
    }
    closeHandle();
  }

  function stats() {
    return {
      ...st,
      open_windows: windows.size,
      pending: pending.length,
      in_flight: pending.filter((p) => p.sent).length,
    };
  }

  return { record, flush, stop, stats, file };
}

// CONNECTOR@install-seam: U790 hands the connector's ctx — ctx.relay (U717's
// 'deny' emitter), ctx.link (U716), ctx.paths (userPaths(): its
// connectorAuthorityLog, a file in the 0700 connector directory).
function install(ctx = {}) {
  if (!ctx.relay || typeof ctx.relay.on !== 'function') throw new TypeError('authority log: ctx.relay (the deny emitter) is required');
  const paths = ctx.paths || userPaths();
  const alog = createAuthorityLog({
    file: ctx.authorityLogFile || paths.connectorAuthorityLog,
    link: ctx.link || null,
    ...(ctx.now ? { now: ctx.now } : {}),
    ...(ctx.log ? { log: ctx.log } : {}),
    ...(ctx.redactor ? { redactor: ctx.redactor } : {}),
    ...(ctx.timers ? { timers: ctx.timers } : {}),
  });
  ctx.relay.on('deny', alog.record);
  const stopLog = alog.stop;
  alog.stop = () => {
    try { ctx.relay.removeListener('deny', alog.record); } catch { /* the relay's */ }
    stopLog();
  };
  return alog;
}

module.exports = {
  createAuthorityLog,
  install,
  principalId,
  principalOk,
  WINDOW_MS,
  MAX_BYTES,
  QUEUE_MAX,
  FRAME_RECORDS,
  SHIP_EVERY_MS,
  HOLD_MS,
  POISON_CLOSES,
  PATH_MAX,
  // The grammar the conformance test holds equal to 04-deny-record.json.
  GRAMMAR: Object.freeze({
    label: LABEL_RE, machine: MACHINE_RE, decision: DECISION_RE, method: METHOD_RE, rule: RULE_RE,
    enforcers: [...ENFORCERS], origins: [...ORIGINS], needs: [...NEEDS], reasons: [...REASONS],
  }),
};
