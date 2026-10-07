// lib/server/control/index.js — the control domain, `ctx.control` (spec §15.2,
// §15.5): the one place every acting control is registered, rate-limited,
// audited and routed, plus the one-shot notices Claude is owed (§15.3 "Claude is
// told", C47).
//
//   createControl({root, paths, bus, mirror, graph, audience, answerSurface,
//                  getViewers, now, log, userPaths, fsImpl})
//     → control = {
//         action(name, spec) → unregister      a row of the action table
//         invoke(name, target, reqCtx) → Promise<answer>   the one pipeline
//         provide(name, api) / use(name)       services reached through ctx.control
//         notices: {put, claim, pending, onChange}
//         audit(entry)
//         features() → {interrupt, code_revert, fork: {ok, reason?}}
//         framesActive() → bool
//         start() → Promise, stop() → Promise
//       }
//   `answerSurface` is ctx.answerSurface or a getter for it; `getViewers` is
//   lib/server/ws.js getViewerSummary (a number of viewers is read as local).
//
// ── THE ACTION TABLE (§15.5) ────────────────────────────────────────────────
// One table, to which the revert (U83), fork (U84) and mod (U89, U93) units add
// rows through action() — never by editing this file. A row:
//
//   { fields: [body keys],                the POST body's keys, exactly
//     params(source) → target             from a query or a body; a throw is a
//                                         bad target (400). Never handed the
//                                         surface's own keys (SURFACE_KEYS)
//     key(target) → string                binds the nonce and the limiter
//     layouts: ['stop'] | ['confirm']     the documents it is served in
//     limit: {scope: 'conversation'|'project', ms}
//     describe(target) → Promise<{title, summary, lines?}>   the frame's
//                                         SUBJECT, from server state only
//     check(target, reqCtx) → Promise<null | {refused, hint}>
//     run(target, reqCtx) → Promise<answer>      {ok: true, …} | {ok: false, refused, hint}
//     state?(target, reqCtx, {v, waitMs}) → Promise<view>   a long-polled view
//     features?() → {ok, reason?} }
//
// invoke() is the one pipeline, which the answer origin's handler calls after
// its HTTP gate and U83's and U84's tests drive directly:
//   limiter → check → run → ONE audit line → the answer.
// The limiter's window starts only at an accepted run (a refusal hands its
// reservation back); 'conversation' buckets are per action per key, 'project'
// buckets per action, so the toast's Undo is never refused by its own Restore
// (notes-B decision 2). reqCtx is {remote, device, ua, origin}.
//
// ── ON THE ANSWER SURFACE (§4.4, §15.5; Q-C ruled B1 (a)) ───────────────────
// start() registers kind 'control' through ctx.answerSurface.register — the
// seam no later unit edits — so every route below sits behind U55's gate (Host,
// Origin exactly the answer origin, Sec-Fetch-Site, JSON, the nonce; OPTIONS
// and X-WC-Remote refused by the engine until U74):
//
//   GET  /answer/control/<action>?<params>&layout=stop|confirm&size=&mode=light|dark
//        the document: U55's builder mints a nonce for 'control:<action>:<key>'
//        into <meta name="wc-answer-nonce"> and puts JSON.stringify(describe())
//        into <meta name="wc-control">. An unknown action or a layout the row
//        does not list → 404; a bad target → 400.
//   POST /answer/api/control/<action>    body: the row's fields, exactly
//        X-WC-Answer: a nonce minted for this action and this target → invoke.
//        200 accepted; a refusal → 429 rate_limited, 404 unknown, 400
//        bad-target, else 409, each as {ok: false, refused, hint}.
//   GET  /answer/api/control/state?action=<a>&<params>&v=&wait=≤20000
//        the row's state view, long-polled (32 in flight at most).
//
// The click token is the frame's nonce, minted on the answer origin (ruling
// U81-U85-U86@click-token): pane script can neither read it nor forge the
// origin, so no acting control is callable from a pane (C46). The main origin
// carries only the host-only notices claim (lib/server/routes/control.js).
//
// KEEP-ALIVE AND WARM-UP. framesActive() is true while a control document or a
// state read was served in the last 60 s, and registerSurface hands it to
// register() as the kind's keepAlive. When the mirror reports a conversation of
// this project entering an active state while a local viewer is connected, the
// surface is ensure()d, so its port is on /api/health before a Stop frame
// mounts (notes-B Q9 (a)); never at boot.
//
// ── NOTICES (§15.3, C47) ────────────────────────────────────────────────────
//   notices.put({conversation_id | null, session_ids, text, source}) → id
//     ONE pending notice per conversation: a later put replaces it (an undo
//     replaces a pending restore's notice, never stacks). A null conversation
//     (unresolvable) goes to the next claimer in the project (notes-B decision
//     8). Text past NOTICE_MAX is cut at its last whole line that fits, ending
//     '…and N more' (N the lines cut).
//   notices.claim({session_id, claude_pid, max_chars}) → [{id, text}]
//     the notices for that session or its conversation (mirror.conversationOf
//     when the facade has it, else conversationOfPid), oldest first, only whole
//     ones whose texts together fit in max_chars; those are deleted (claimed
//     exactly once), the rest kept for the next claim.
//   notices.pending() → copies; notices.onChange(fn) → unsubscribe, fn({op:
//     'put'|'replace'|'claim', notice}) — U83 persists the state through it.
//
// ── THE AUDIT (§15.5) ───────────────────────────────────────────────────────
// projectPaths(root).controlAudit, JSONL: {at, action, target, outcome, via,
// origin, device} for every action and every refusal (outcome 'accepted' or
// 'refused:<code>'), the HTTP gate's included. The target keeps ids only
// (primitive values, strings capped); never file contents, prompt text or a
// command. Past AUDIT_MAX_BYTES the file moves to audit.log.1 (one generation).

const fs = require('fs');
const crypto = require('crypto');
const { projectPaths, userPaths: defaultUserPaths, isSafeId } = require('../../core/paths');
const { REMOTE_HEADER } = require('../../core/cors');
const { ACTIVE_STATES } = require('../mirror/live');
const { createInterrupt } = require('./interrupt');

const NOTICE_MAX = 1500;
const AUDIT_MAX_BYTES = 1024 * 1024;
const FRAME_ACTIVE_MS = 60_000;
const STATE_WAIT_MAX = 20_000;
const MAX_STATE_INFLIGHT = 32;
const MAX_NOTICES = 64;
const ACTION_RE = /^[a-z][a-z-]{1,31}$/;
// A body key. One that is also a SURFACE_KEY (the interrupt's `mode`) is read
// from the POST body only, never from a document's or a state read's query.
const FIELD_RE = /^[a-z][a-z0-9_]{0,31}$/;
// 'state' is the state read's path segment under /answer/api/control/.
const RESERVED_ACTIONS = new Set(['state']);
const LAYOUTS = new Set(['stop', 'confirm']);
const SCOPES = new Set(['conversation', 'project']);
const DEVICES = new Set(['desktop', 'mobile']);
// The answer surface's own query keys: never part of a target. (`mode` is the
// frame's colour mode there, so a row's own field may not be read from a query
// under that name — the interrupt's `mode` comes in the POST body only.)
const SURFACE_KEYS = new Set(['layout', 'mode', 'size', 'device', 'v', 'wait', 'action']);
const AUDIT_STRING_MAX = 200;
const DESC_TEXT_MAX = 300;
const DESC_LINES_MAX = 40;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class BadTarget extends TypeError {
  constructor(msg) { super(msg); this.code = 'bad-target'; }
}

function hint(code) {
  return {
    'unknown-action': 'no such control action',
    rate_limited: 'that was just done — wait a moment and try again',
    'bad-target': 'the request names no valid target',
    stopped: 'the daemon is stopping',
    failed: 'the action failed',
  }[code] || 'refused';
}

function createControl({
  root,
  paths = null,
  bus = null,
  mirror = null,
  graph = null,
  audience = null,
  answerSurface = null,
  getViewers = null,
  now = Date.now,
  log = () => {},
  userPaths = defaultUserPaths,
  fsImpl = fs,
} = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('createControl needs root');
  void graph; void audience; // accepted from the wiring; the rows that need them take their own
  const p = paths || projectPaths(root);
  const say = (m) => { try { log(m); } catch {} };
  const rows = new Map(); // name → frozen spec
  const services = new Map();
  const buckets = new Map(); // limiter: bucket → {at}
  let lastFrameAt = null;
  let stateInflight = 0;
  let started = false;
  let stopped = false;
  let offMirror = null;
  let unregisterSurface = null;

  const surfaceNow = () => {
    try { return typeof answerSurface === 'function' ? answerSurface() : answerSurface; } catch { return null; }
  };

  // ── the audit ─────────────────────────────────────────────────────────────
  function auditTarget(target) {
    if (!isPlain(target)) return null;
    const out = {};
    for (const [k, v] of Object.entries(target)) {
      if (typeof v === 'string') out[k] = v.slice(0, AUDIT_STRING_MAX);
      else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (typeof v === 'boolean' || v === null) out[k] = v;
    }
    return out;
  }
  function audit({ action = null, target = null, outcome = null, via = null, origin = null, device = null } = {}) {
    const line = {
      at: now(),
      action: typeof action === 'string' ? action.slice(0, 64) : null,
      target: auditTarget(target),
      outcome: typeof outcome === 'string' ? outcome.slice(0, 64) : null,
      via: typeof via === 'string' ? via.slice(0, 32) : null,
      origin: origin === 'remote' ? 'remote' : 'local',
      device: DEVICES.has(device) ? device : null,
    };
    try {
      fsImpl.mkdirSync(p.controlDir, { recursive: true });
      let size = 0;
      try { size = fsImpl.statSync(p.controlAudit).size; } catch {}
      if (size >= AUDIT_MAX_BYTES) fsImpl.renameSync(p.controlAudit, `${p.controlAudit}.1`);
      fsImpl.appendFileSync(p.controlAudit, `${JSON.stringify(line)}\n`);
    } catch (e) { say(`control: audit failed (${e && e.code || 'error'})`); }
    return line;
  }

  // ── the action table ──────────────────────────────────────────────────────
  function action(name, spec) {
    if (typeof name !== 'string' || !ACTION_RE.test(name) || RESERVED_ACTIONS.has(name)) {
      throw new TypeError(`control: bad action name ${JSON.stringify(name)}`);
    }
    const s = spec || {};
    for (const fn of ['params', 'key', 'describe', 'check', 'run']) {
      if (typeof s[fn] !== 'function') throw new TypeError(`control: action '${name}' needs ${fn}()`);
    }
    for (const fn of ['state', 'features']) {
      if (s[fn] != null && typeof s[fn] !== 'function') throw new TypeError(`control: action '${name}': ${fn} must be a function`);
    }
    if (!Array.isArray(s.fields) || !s.fields.length || !s.fields.every((f) => typeof f === 'string' && FIELD_RE.test(f))) {
      throw new TypeError(`control: action '${name}' needs fields, a list of body keys`);
    }
    if (new Set(s.fields).size !== s.fields.length) throw new TypeError(`control: action '${name}': a field is listed twice`);
    if (!Array.isArray(s.layouts) || !s.layouts.length || !s.layouts.every((l) => LAYOUTS.has(l))) {
      throw new TypeError(`control: action '${name}': layouts must be 'stop' or 'confirm'`);
    }
    const lim = s.limit;
    if (!isPlain(lim) || !SCOPES.has(lim.scope) || !(Number.isFinite(lim.ms) && lim.ms > 0)) {
      throw new TypeError(`control: action '${name}': limit must be {scope: 'conversation'|'project', ms > 0}`);
    }
    const entry = Object.freeze({
      fields: Object.freeze([...s.fields]),
      layouts: Object.freeze([...s.layouts]),
      limit: Object.freeze({ scope: lim.scope, ms: lim.ms }),
      params: s.params, key: s.key, describe: s.describe, check: s.check, run: s.run,
      state: s.state || null, features: s.features || null,
    });
    rows.set(name, entry); // a second row under one name replaces the first
    return function unregister() { if (rows.get(name) === entry) rows.delete(name); };
  }

  // The limiter. take() reserves the bucket (a concurrent second call is
  // refused while the first runs); give() hands a refused run's reservation back.
  function take(bucket, ms) {
    const t = now();
    const prev = buckets.get(bucket) || null;
    if (prev && t - prev.at < ms) return null;
    const mine = { at: t };
    buckets.set(bucket, mine);
    if (buckets.size > 1024) {
      for (const [k, v] of buckets) if (t - v.at > 60_000 && k !== bucket) buckets.delete(k);
    }
    return { bucket, prev, mine };
  }
  function give(tok) {
    if (!tok || buckets.get(tok.bucket) !== tok.mine) return;
    if (tok.prev) buckets.set(tok.bucket, tok.prev); else buckets.delete(tok.bucket);
  }

  function normCtx(reqCtx) {
    const r = isPlain(reqCtx) ? reqCtx : {};
    const remote = r.remote === true;
    return {
      remote,
      device: DEVICES.has(r.device) ? r.device : null,
      ua: typeof r.ua === 'string' ? r.ua.slice(0, 200) : null,
      origin: remote ? 'remote' : 'local',
    };
  }

  async function invoke(name, target, reqCtx) {
    const ctx = normCtx(reqCtx);
    const row = rows.get(name);
    const finish = (answer) => {
      audit({
        action: name, target, via: answer && answer.ok ? (answer.via || null) : null,
        outcome: answer && answer.ok === true ? 'accepted' : `refused:${(answer && answer.refused) || 'failed'}`,
        origin: ctx.origin, device: ctx.device,
      });
      return answer;
    };
    const refuse = (code, h) => finish({ ok: false, refused: code, hint: h || hint(code) });
    if (!row) return refuse('unknown-action');
    if (stopped) return refuse('stopped');
    let key;
    try { key = String(row.key(target)); } catch { return refuse('bad-target'); }
    const bucket = row.limit.scope === 'project' ? name : `${name}:${key}`;
    const tok = take(bucket, row.limit.ms);
    if (!tok) return refuse('rate_limited');
    let answer;
    try {
      const r = await row.check(target, ctx);
      if (r) {
        give(tok);
        return refuse(typeof r.refused === 'string' && r.refused ? r.refused : 'refused', typeof r.hint === 'string' ? r.hint : undefined);
      }
      answer = await row.run(target, ctx);
    } catch (e) {
      say(`control: ${name} failed (${e && e.code || 'error'})`);
      answer = { ok: false, refused: 'failed', hint: hint('failed') };
    }
    if (!isPlain(answer)) answer = { ok: false, refused: 'failed', hint: hint('failed') };
    if (answer.ok !== true) {
      give(tok);
      if (typeof answer.refused !== 'string' || !answer.refused) answer = { ...answer, refused: 'failed' };
      if (typeof answer.hint !== 'string') answer = { ...answer, hint: hint(answer.refused) };
    }
    return finish(answer);
  }

  // ── services (provide/use) ────────────────────────────────────────────────
  function provide(name, api) {
    if (typeof name !== 'string' || !name) throw new TypeError('control.provide needs a name');
    services.set(name, api);
    return () => { if (services.get(name) === api) services.delete(name); };
  }
  const use = (name) => (services.has(name) ? services.get(name) : null);

  // ── notices ───────────────────────────────────────────────────────────────
  const notices = createNotices({ mirror, now, log: say });

  // ── the interrupt ─────────────────────────────────────────────────────────
  const interrupt = createInterrupt({ mirror, bus, userPaths, now, log: say, fsImpl });
  action('interrupt', interrupt.row);

  // ── the answer surface ────────────────────────────────────────────────────
  const framesActive = () => lastFrameAt != null && now() - lastFrameAt < FRAME_ACTIVE_MS;
  const nonceKeyOf = (name, row, target) => `control:${name}:${String(row.key(target))}`;

  // A target out of a query, without the surface's own keys.
  function targetOfQuery(row, query) {
    const q = {};
    for (const [k, v] of Object.entries(query || {})) if (!SURFACE_KEYS.has(k)) q[k] = v;
    return row.params(q);
  }
  function pick(body, fields) {
    const q = {};
    if (!isPlain(body)) return q;
    for (const f of fields) if (Object.prototype.hasOwnProperty.call(body, f)) q[f] = body[f];
    return q;
  }
  const isRemote = (req) => req.headers[REMOTE_HEADER] != null;
  const uaOf = (req) => String(req.headers['user-agent'] || '').slice(0, 200) || null;
  function reqCtxOf(req, query) {
    const remote = isRemote(req);
    return { remote, device: DEVICES.has(query && query.device) ? query.device : null, ua: uaOf(req), origin: remote ? 'remote' : 'local' };
  }

  function sanitizeDescription(d) {
    const src = isPlain(d) ? d : {};
    const text = (v) => (typeof v === 'string' ? v.slice(0, DESC_TEXT_MAX) : null);
    const out = { title: text(src.title), summary: text(src.summary) };
    if (Array.isArray(src.lines)) out.lines = src.lines.filter((l) => typeof l === 'string').slice(0, DESC_LINES_MAX).map((l) => l.slice(0, DESC_TEXT_MAX));
    return out;
  }

  async function serveDocument(req, res, kit, { rest, query }) {
    const row = rows.get(rest);
    if (!row) return kit.json(res, 404, { ok: false, error: 'not found' });
    if (!row.layouts.includes(query.layout)) return kit.json(res, 404, { ok: false, error: 'not found' });
    let target;
    try { target = targetOfQuery(row, query); } catch { return kit.json(res, 400, { ok: false, refused: 'bad-target', hint: hint('bad-target') }); }
    let key;
    try { key = nonceKeyOf(rest, row, target); } catch { return kit.json(res, 400, { ok: false, refused: 'bad-target', hint: hint('bad-target') }); }
    let desc = null;
    try { desc = await row.describe(target); } catch (e) { say(`control: describe ${rest} failed (${e && e.code || 'error'})`); }
    lastFrameAt = now();
    return kit.document(res, { key, mode: query.mode, meta: { 'wc-control': JSON.stringify(sanitizeDescription(desc)) } });
  }

  function nonceKey(req, { rest, query, body }) {
    try {
      if (req.method === 'GET' && rest === 'state') {
        const row = rows.get(query.action);
        if (!row || !row.state) return null;
        return nonceKeyOf(query.action, row, targetOfQuery(row, query));
      }
      if (req.method === 'POST') {
        const row = rows.get(rest);
        if (!row) return null;
        return nonceKeyOf(rest, row, row.params(pick(body, row.fields)));
      }
    } catch { return null; }
    return null;
  }

  const statusOf = (answer) => {
    if (answer.ok === true) return 200;
    return { rate_limited: 429, unknown: 404, 'bad-target': 400, 'unknown-action': 404 }[answer.refused] || 409;
  };

  async function serveState(req, res, kit, query) {
    const name = query.action;
    const row = rows.get(name);
    if (!row || !row.state) return kit.json(res, 404, { ok: false, error: 'not found' });
    let target;
    try { target = targetOfQuery(row, query); } catch { return kit.json(res, 400, { ok: false, refused: 'bad-target', hint: hint('bad-target') }); }
    const v = typeof query.v === 'string' && /^\d{1,15}$/.test(query.v) ? Number(query.v) : null;
    let waitMs = Math.max(0, Math.min(STATE_WAIT_MAX, Math.floor(Number(query.wait) || 0)));
    if (stopped || stateInflight >= MAX_STATE_INFLIGHT) waitMs = 0;
    lastFrameAt = now();
    stateInflight += 1;
    let view = null;
    try { view = await row.state(target, reqCtxOf(req, query), { v, waitMs }); } catch (e) {
      say(`control: state ${name} failed (${e && e.code || 'error'})`);
      view = null;
    } finally { stateInflight -= 1; }
    if (res.writableEnded || res.destroyed) return undefined;
    if (!isPlain(view)) return kit.json(res, 500, { ok: false, error: 'state failed' });
    return kit.json(res, 200, view);
  }

  async function serveApi(req, res, kit, { rest, query, body }) {
    if (req.method === 'GET' && rest === 'state') return serveState(req, res, kit, query);
    if (req.method !== 'POST') return kit.json(res, 405, { ok: false, error: 'method not allowed' });
    const row = rows.get(rest);
    const ctx = reqCtxOf(req, query);
    const refusedHere = (status, code) => {
      audit({ action: rest, target: null, outcome: `refused:${code}`, via: null, origin: ctx.origin, device: ctx.device });
      return kit.json(res, status, { ok: false, refused: code, hint: hint(code) });
    };
    if (!row) return refusedHere(404, 'unknown-action');
    // The body's keys, exactly the row's fields.
    const keys = isPlain(body) ? Object.keys(body) : null;
    if (!keys || keys.length !== row.fields.length || !row.fields.every((f) => keys.includes(f))) return refusedHere(400, 'bad-target');
    let target;
    try { target = row.params(pick(body, row.fields)); } catch { return refusedHere(400, 'bad-target'); }
    const answer = await invoke(rest, target, ctx);
    return kit.json(res, statusOf(answer), answer);
  }

  // A refusal U55's gate answered before our handler: audited for an action's
  // POST, a bad Host's 421 included (the engine reports it through onRefused,
  // U55b). A state read is not an action, nor is an OPTIONS preflight.
  function onRefused({ code, method, rest, query, remote }) {
    if (method !== 'POST') return;
    const device = DEVICES.has(query && query.device) ? query.device : null;
    audit({ action: typeof rest === 'string' ? rest : null, target: null, outcome: `refused:${code}`, via: null, origin: remote ? 'remote' : 'local', device });
  }

  function registerSurface() {
    if (unregisterSurface) return true;
    const s = surfaceNow();
    if (!s || typeof s.register !== 'function') { say('control: no answer surface; control frames are off'); return false; }
    try {
      unregisterSurface = s.register('control', {
        document: serveDocument,
        api: serveApi,
        nonceKey,
        keepAlive: () => framesActive(),
        onRefused,
      });
    } catch (e) {
      say(`control: register failed (${e && e.message})`);
      unregisterSurface = null;
      return false;
    }
    return true;
  }

  // ── the mirror's transitions ──────────────────────────────────────────────
  function hasLocalViewer() {
    let v = null;
    try { v = typeof getViewers === 'function' ? getViewers() : null; } catch { v = null; }
    if (typeof v === 'number') return v > 0;
    return isPlain(v) && Number(v.local) > 0;
  }
  function warmUp(ev) {
    if (ev.op !== 'state' || !ACTIVE_STATES.includes(ev.state)) return;
    if (typeof ev.prev === 'string' && ACTIVE_STATES.includes(ev.prev)) return;
    if (!hasLocalViewer()) return;
    const s = surfaceNow();
    if (!s || typeof s.ensure !== 'function') return;
    try { Promise.resolve(s.ensure()).catch(() => {}); } catch {}
  }
  function onMirror(ev) {
    if (!isPlain(ev) || ev.kind !== 'mirror' || stopped) return;
    try { interrupt.onMirror(ev); } catch (e) { say(`control: interrupt onMirror failed (${e && e.code || 'error'})`); }
    try { warmUp(ev); } catch {}
  }

  // ── features ──────────────────────────────────────────────────────────────
  function rowFeature(name) {
    if (stopped) return { ok: false, reason: 'stopped' };
    const row = rows.get(name);
    if (!row) return { ok: false, reason: 'not-installed' };
    if (!row.features) return { ok: true };
    try {
      const f = row.features();
      if (isPlain(f) && f.ok === true) return { ok: true };
      return { ok: false, reason: isPlain(f) && typeof f.reason === 'string' ? f.reason : 'unavailable' };
    } catch { return { ok: false, reason: 'unavailable' }; }
  }
  function features() {
    let interruptF;
    if (stopped) interruptF = { ok: false, reason: 'stopped' };
    else if (!unregisterSurface) interruptF = { ok: false, reason: 'no-answer-surface' };
    else interruptF = rowFeature('interrupt');
    return { interrupt: interruptF, code_revert: rowFeature('restore'), fork: rowFeature('fork') };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  async function start() {
    if (started || stopped) return;
    started = true;
    try { interrupt.sweep(); } catch (e) { say(`control: halt sweep failed (${e && e.code || 'error'})`); }
    registerSurface();
    if (mirror && typeof mirror.subscribe === 'function') {
      try { offMirror = mirror.subscribe(onMirror); } catch (e) { say(`control: mirror subscribe failed (${e && e.message})`); }
    }
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (offMirror) { try { offMirror(); } catch {} offMirror = null; }
    if (unregisterSurface) { try { unregisterSurface(); } catch {} unregisterSurface = null; }
    try { interrupt.stop(); } catch (e) { say(`control: interrupt stop failed (${e && e.code || 'error'})`); }
  }

  return {
    action,
    invoke,
    provide,
    use,
    notices,
    audit,
    features,
    framesActive,
    start,
    stop,
    // For the interrupt's own seams (tranche 6's mod path) and tests.
    interrupt: Object.freeze({ addPath: interrupt.addPath, flags: interrupt.flags }),
  };
}

// ── the notices ─────────────────────────────────────────────────────────────

// Cut a text to NOTICE_MAX at its last whole line that fits, ending
// '…and N more' (N the lines cut).
function capNotice(text, max = NOTICE_MAX) {
  const s = String(text);
  if (s.length <= max) return s;
  const lines = s.split('\n');
  for (let k = lines.length - 1; k >= 1; k--) {
    const tail = `…and ${lines.length - k} more`;
    const head = lines.slice(0, k).join('\n');
    if (head.length + 1 + tail.length <= max) return `${head}\n${tail}`;
  }
  // Not even the first line fits whole: cut inside it.
  const tail = lines.length > 1 ? `\n…and ${lines.length - 1} more` : '';
  return `${lines[0].slice(0, Math.max(0, max - tail.length - 1))}…${tail}`;
}

function createNotices({ mirror = null, now = Date.now, log = () => {} } = {}) {
  const byConversation = new Map(); // conversation id ('' for none) → notice
  const listeners = new Set();
  let seq = 0;

  function emit(op, notice) {
    for (const fn of [...listeners]) {
      try { fn({ op, notice: { ...notice, session_ids: [...notice.session_ids] } }); } catch (e) { log(`control: notice listener failed (${e && e.message})`); }
    }
  }

  function put({ conversation_id = null, session_ids = [], text, source = null } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('notices.put needs text');
    const cid = typeof conversation_id === 'string' && conversation_id ? conversation_id : null;
    const sids = Array.isArray(session_ids) ? [...new Set(session_ids.filter(isSafeId))] : [];
    const t = now();
    seq += 1;
    const notice = {
      id: `cn_${Math.max(0, Math.floor(t)).toString(36)}${crypto.randomBytes(2).toString('hex')}`,
      conversation_id: cid,
      session_ids: sids,
      text: capNotice(text),
      source: typeof source === 'string' ? source.slice(0, 64) : null,
      at: t,
      seq,
    };
    const k = cid || '';
    const replaced = byConversation.has(k);
    byConversation.delete(k); // a replaced notice goes to the back: it is the newest
    byConversation.set(k, notice);
    while (byConversation.size > MAX_NOTICES) byConversation.delete(byConversation.keys().next().value);
    emit(replaced ? 'replace' : 'put', notice);
    return notice.id;
  }

  function conversationFor(sessionId, pid) {
    if (!mirror) return null;
    try {
      if (sessionId && typeof mirror.conversationOf === 'function') {
        const c = mirror.conversationOf(sessionId);
        if (typeof c === 'string' && c) return c;
      }
      if (Number.isSafeInteger(pid) && pid > 0 && typeof mirror.conversationOfPid === 'function') {
        const c = mirror.conversationOfPid(pid);
        if (typeof c === 'string' && c) return c;
      }
    } catch (e) { log(`control: conversation lookup failed (${e && e.code || 'error'})`); }
    return null;
  }

  function claim({ session_id = null, claude_pid = null, max_chars } = {}) {
    const max = Number.isSafeInteger(max_chars) && max_chars > 0 ? max_chars : 0;
    const sid = isSafeId(session_id) ? session_id : null;
    const cid = conversationFor(sid, claude_pid);
    const mine = [...byConversation.values()]
      .filter((n) => (sid && n.session_ids.includes(sid)) || (cid && n.conversation_id === cid) || n.conversation_id === null)
      .sort((a, b) => a.seq - b.seq);
    const out = [];
    let used = 0;
    for (const n of mine) {
      if (used + n.text.length > max) continue;
      used += n.text.length;
      byConversation.delete(n.conversation_id || '');
      out.push({ id: n.id, text: n.text });
      emit('claim', n);
    }
    return out;
  }

  function pending() {
    return [...byConversation.values()].sort((a, b) => a.seq - b.seq)
      .map((n) => ({ id: n.id, conversation_id: n.conversation_id, session_ids: [...n.session_ids], text: n.text, source: n.source, at: n.at }));
  }

  function onChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('notices.onChange needs a function');
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return Object.freeze({ put, claim, pending, onChange });
}

module.exports = {
  createControl, createNotices, capNotice, BadTarget,
  NOTICE_MAX, AUDIT_MAX_BYTES, FRAME_ACTIVE_MS, STATE_WAIT_MAX, SURFACE_KEYS,
};
