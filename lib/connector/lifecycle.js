// The connector's lifecycle half (contract 06 C-06.19 to C-06.23; 07 C-07.8;
// 05 C-05.19, C-05.27): hold each running chat's daemon, end it the way a stop
// asks, restart an adopted daemon as the connector's own once it is idle, and
// answer the machine's cap and pause.
//
//   * THE HOLD (C-06.21, C-07.8). Exactly one GET /api/events/stream per running
//     chat, through lib/client subscribeSSE with the supervisor's explicit port
//     (so the client never discovers a port and never spawns). The open call
//     carries `since` (always a number) and NOTHING ELSE that shapes the
//     stream: no kinds argument at all, so the hold can be neither a wake
//     consumer (a host stream asking for wake counts as the channel bridge and
//     drains the parked Push, routes/events.js isWakeConsumer) nor control-only
//     (which does not retain, routes/events.js holdsDaemon); and never the
//     non-holding read 07 Q-07.5 names. The connector holds no socket viewer
//     either: a socket is a viewer (health.viewers, the no-viewer turn line,
//     the service supervisor's getViewers). test/connector-hold.test.js pins
//     both expressions of routes/events.js by name.
//   * ONE STREAM, MANY READERS. Every event, the open, a gap and a close fan
//     out to subscribe()'s listeners: the hold, 07's ring ingest (U723) and the
//     turn signals (U729) read the same stream; no second reader exists.
//   * RECONNECT. On a close (or an error, which lib/client follows with a
//     close) the hold asks the supervisor again (the daemon may have moved)
//     and reopens with since = the cursor provider's answer (U723's C-07.10
//     choice), else the last seq this hold saw, else 0; backoff 1 s doubling to
//     30 s, reset on an open. A gap or a reset is "re-read health": one fresh
//     GET /api/health; a pid that changed is forgotten and asked for again.
//   * THE TICK. Every TICK_MS per running chat (unref'd): the idle check below,
//     then each onTick listener (U729's status poll). healthOf(chatId) is the
//     tick's ONE memoised health read, so the idle check and the status poll
//     make one GET per chat per tick however many ask (C-06.24).
//   * THE IDLE RESTART (C-06.19, C-06.12's rule). A chat whose daemon is
//     `started_by: other` and whose health reads no lock and no viewers is shut
//     down `now` and spawned again as the connector's own, on any root: forget,
//     POST /api/shutdown with SHUTDOWN_HEADER (read from lib/core/cors, never
//     from the CLI's stop command), wait for that pid to stop answering, then
//     ensureRunning (whose rate limit still holds).
//   * STOP (C-06.22). `release` (the default) closes the hold and forgets the
//     secret; the daemon's own idle grace ends it (C-06.20). `now` does the
//     same, then posts the shutdown only for a `started_by: connector` daemon or
//     any daemon on an owned root; an `other` daemon on an offered folder is
//     only released.
//   * CAP AND PAUSE (C-06.23, 05 C-05.19, C-05.27, ruling W3). applySettings
//     writes the hub's machine.settings into the record (an older or equal rev
//     ignored; the hub never sets local_cap); isPaused() answers the record.
//     Pause withholds what the delivery unit delivers and what a launcher
//     launches, and NOTHING here: run, stop (`now` included) and the hold are
//     unaffected. effectiveCap() is the lesser of the hub's cap and the local
//     cap (a local cap lowers, never raises); overCap() says whether the chats
//     with an attached session exceed it (a manual session cannot be stopped).
//
// The capture hub is not this module's (C-06.20a): nothing here supervises,
// starts, stops or names it. Log lines carry a chat id (when it is a safe id),
// a pid, a port, a started_by or a code; never text a daemon sent, never a
// secret.

const path = require('path');
const client = require('../client');
const registry = require('../util/registry');
const record = require('../setup/connector');
const { SHUTDOWN_HEADER, SHUTDOWN_HEADER_VALUE } = require('../core/cors');
const { isSafeId } = require('../core/paths');

const TICK_MS = 5_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HEALTH_TIMEOUT_MS = 3_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
// How long the idle restart waits for the old pid to stop answering before it
// asks the supervisor (which adopts a daemon still answering, as `other`).
const IDLE_RESTART_WAIT_MS = 10_000;
const IDLE_RESTART_POLL_MS = 100;
// After an idle restart that did not end the old daemon, the next try waits.
const IDLE_RESTART_RETRY_MS = 60_000;
const STOP_MODES = Object.freeze(['release', 'now']);
// The machine.settings fields the hub may set (05 C-05.19), with the record
// schema's bounds; local_cap is the machine's own (`connect cap`).
const HUB_SETTINGS = Object.freeze({
  agents_at_once: (v) => Number.isInteger(v) && v >= 0 && v <= 64,
  accept_new_chats: (v) => typeof v === 'boolean',
  let_home_start_agents: (v) => typeof v === 'boolean',
  paused: (v) => typeof v === 'boolean',
});

const logId = (id) => (isSafeId(id) ? id : '?');
const isPort = (p) => Number.isInteger(p) && p > 0 && p <= 65535;
const isSeq = (n) => Number.isInteger(n) && n >= 0;

function chatOf(chat) {
  const id = chat && (chat.id != null ? chat.id : chat.chat_id);
  const root = chat && chat.root;
  if (typeof id !== 'string' || !id) throw new TypeError('lifecycle: a chat needs an id');
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('lifecycle: a chat needs an absolute root');
  return { ...chat, id, root, owned_root: chat.owned_root === true };
}

function createLifecycle({ supervisor, hubId, log = () => {}, deps = {} } = {}) {
  if (!supervisor || typeof supervisor.ensureRunning !== 'function' || typeof supervisor.forget !== 'function'
    || typeof supervisor.startedBy !== 'function') {
    throw new TypeError('createLifecycle: a supervisor (ensureRunning, startedBy, forget) is required');
  }
  const d = {
    client,
    registry,
    record: { readRecord: record.readRecord, updateRecord: record.updateRecord },
    now: Date.now,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    ...deps,
  };
  const say = (line) => { try { log(line); } catch {} };
  const unref = (t) => { try { if (t && typeof t.unref === 'function') t.unref(); } catch {} return t; };

  const listeners = new Set();
  const tickListeners = new Set();
  let cursorProvider = null;

  // chat id -> per-chat state; deleted on stop.
  const chats = new Map();
  const live = (st) => chats.get(st.id) === st && st.desired === 'running';

  const emit = (msg) => {
    for (const fn of [...listeners]) { try { fn(msg); } catch {} }
  };

  // ── the record's settings ──────────────────────────────────────────────

  function settings() {
    let read = null;
    try { read = hubId ? d.record.readRecord(hubId) : null; } catch { read = null; }
    const s = read && read.ok && read.value && read.value.settings;
    return { ...record.SETTINGS_DEFAULTS, local_cap: null, ...(s || {}) };
  }

  function applySettings(s) {
    if (!s || typeof s !== 'object' || !isSeq(s.rev)) return { applied: false, reason: 'invalid' };
    if (!hubId) return { applied: false, reason: 'no-record' };
    let outcome = { applied: false, reason: 'no-record' };
    try {
      d.record.updateRecord(hubId, (rec) => {
        if (!rec) return null;
        const cur = rec.settings || {};
        if (isSeq(cur.rev) && s.rev <= cur.rev) { outcome = { applied: false, reason: 'stale' }; return null; }
        const next = { ...cur, rev: s.rev };
        for (const [k, ok] of Object.entries(HUB_SETTINGS)) {
          if (Object.prototype.hasOwnProperty.call(s, k) && ok(s[k])) next[k] = s[k];
        }
        rec.settings = next;
        outcome = { applied: true };
        return rec;
      });
    } catch (e) {
      say(`settings not applied: ${e && e.code ? e.code : 'error'}`);
      return { applied: false, reason: 'error' };
    }
    if (outcome.applied) say(`settings rev ${s.rev} applied`);
    return outcome;
  }

  const isPaused = () => settings().paused === true;

  function effectiveCap() {
    const s = settings();
    const cap = Number.isInteger(s.agents_at_once) ? s.agents_at_once : 0;
    return Number.isInteger(s.local_cap) ? Math.min(cap, s.local_cap) : cap;
  }

  // The chats this connector runs that have an attached session (a live MCP
  // presence row on their root), against the effective cap.
  function attachedCount() {
    let n = 0;
    for (const st of chats.values()) {
      let rows = [];
      try { rows = d.registry.mcpSessionsFor(st.root) || []; } catch { rows = []; }
      if (rows.length > 0) n++;
    }
    return n;
  }
  const overCap = () => attachedCount() > effectiveCap();

  // ── health: the tick's one memoised read ─────────────────────────────────

  function readHealth(st) {
    if (!isPort(st.port)) return Promise.resolve(null);
    return Promise.resolve()
      .then(() => d.client.get('/api/health', { port: st.port, noSpawn: true, timeout: HEALTH_TIMEOUT_MS }))
      .then((h) => (h && typeof h === 'object' ? h : null), () => null);
  }

  function healthOf(chatId, { fresh = false } = {}) {
    const st = chats.get(chatId);
    if (!st) return Promise.resolve(null);
    const m = st.health;
    if (!fresh && m && m.tick === st.tickGen && m.port === st.port) return m.p;
    const p = readHealth(st);
    st.health = { tick: st.tickGen, port: st.port, p };
    return p;
  }

  // ── the hold ─────────────────────────────────────────────────────────────

  function sinceFor(st) {
    if (typeof cursorProvider === 'function') {
      let c = null;
      try { c = cursorProvider(st.id); } catch { c = null; }
      if (isSeq(c)) return c;
    }
    return isSeq(st.lastSeq) ? st.lastSeq : 0;
  }

  function closeHold(st) {
    st.holdGen++;
    const h = st.handle;
    st.handle = null;
    st.held = false;
    if (h) { try { h.close(); } catch {} }
  }

  function clearReconnect(st) {
    if (st.reconnect) { try { d.clearTimeout(st.reconnect); } catch {} st.reconnect = null; }
  }

  function scheduleReconnect(st, ms) {
    if (!live(st) || st.reconnect || st.restarting) return;
    const wait = ms != null ? ms : st.backoff;
    if (ms == null) st.backoff = Math.min(st.backoff * 2, RECONNECT_MAX_MS);
    st.reconnect = unref(d.setTimeout(() => {
      st.reconnect = null;
      if (live(st) && !st.handle && !st.restarting) connect(st).catch(() => {});
    }, wait));
  }

  function openHold(st) {
    if (st.handle || !isPort(st.port) || !live(st)) return;
    const gen = ++st.holdGen;
    const mine = () => gen === st.holdGen && chats.get(st.id) === st;
    let closedEarly = false;
    const since = sinceFor(st);
    const handle = d.client.subscribeSSE({
      port: st.port,
      since,
      onOpen: (arg) => {
        if (!mine()) return;
        st.held = true;
        st.backoff = RECONNECT_MIN_MS;
        emit({ chatId: st.id, type: 'open', since, response: arg });
      },
      onEvent: (entry) => {
        if (!mine()) return;
        if (entry && isSeq(entry.seq)) st.lastSeq = entry.seq;
        emit({ chatId: st.id, type: 'entry', entry });
      },
      onGap: (gap) => {
        if (!mine()) return;
        emit({ chatId: st.id, type: 'gap', gap });
        rereadHealth(st).catch(() => {});
      },
      onError: (e) => {
        if (!mine()) return;
        st.lastError = (e && e.code) || 'error';
      },
      onClose: () => {
        closedEarly = true;
        if (!mine()) return;
        st.handle = null;
        st.held = false;
        emit({ chatId: st.id, type: 'close', ...(st.lastError ? { error: st.lastError } : {}) });
        st.lastError = null;
        scheduleReconnect(st);
      },
    });
    if (!closedEarly && mine()) st.handle = handle;
  }

  // A gap or a reset: the daemon may have restarted under the hold. One fresh
  // health read; a pid that changed is forgotten and asked for again, and the
  // hold moves to the daemon the supervisor answers.
  async function rereadHealth(st) {
    const h = await healthOf(st.id, { fresh: true });
    if (!live(st) || st.restarting || !h || !Number.isInteger(h.pid)) return;
    if (st.pid == null || h.pid === st.pid) return;
    say(`chat ${logId(st.id)} daemon pid changed ${st.pid} -> ${h.pid}`);
    supervisor.forget(st.id);
    closeHold(st);
    clearReconnect(st);
    await connect(st);
  }

  // Ask the supervisor for the chat's daemon, then open the hold on it.
  function connect(st) {
    if (st.connecting) return st.connecting;
    const p = (async () => {
      let r;
      try {
        r = await supervisor.ensureRunning(st.chat);
      } catch {
        r = { state: 'failed', reason: 'other' };
      }
      if (!live(st)) return r;
      st.status = r;
      if (r && r.state === 'running' && isPort(r.port)) {
        st.port = r.port;
        st.pid = Number.isInteger(r.pid) ? r.pid : null;
        try { openHold(st); } catch { st.handle = null; st.held = false; scheduleReconnect(st); }
      } else if (r && r.state === 'starting') {
        scheduleReconnect(st, Number.isFinite(r.retry_in_ms) ? Math.max(0, r.retry_in_ms) : undefined);
      } else {
        scheduleReconnect(st);
      }
      return r;
    })();
    st.connecting = p;
    const clear = () => { if (st.connecting === p) st.connecting = null; };
    p.then(clear, clear);
    return p;
  }

  // ── the tick and the idle restart ────────────────────────────────────────

  async function idleCheck(st) {
    if (!live(st) || st.restarting || !st.held) return;
    if (st.idleRetryAt != null && d.now() < st.idleRetryAt) return;
    if (supervisor.startedBy(st.id) !== 'other') return;
    const h = await healthOf(st.id);
    if (!live(st) || st.restarting || !h) return;
    if (h.lock != null || h.viewers !== 0) return;
    if (st.pid != null && Number.isInteger(h.pid) && h.pid !== st.pid) return;
    if (supervisor.startedBy(st.id) !== 'other') return;
    await idleRestart(st);
  }

  // Not unref'd: a short wait inside an idle restart that is under way.
  function sleep(ms) {
    return new Promise((resolve) => { d.setTimeout(resolve, ms); });
  }

  async function waitGone(root, pid) {
    const deadline = d.now() + IDLE_RESTART_WAIT_MS;
    for (;;) {
      let rec = null;
      try { rec = await d.registry.daemonFor(root); } catch { rec = null; }
      if (!rec || rec.pid !== pid) return true;
      if (d.now() >= deadline) return false;
      await sleep(IDLE_RESTART_POLL_MS);
    }
  }

  async function idleRestart(st) {
    st.restarting = true;
    const port = st.port;
    const pid = st.pid;
    say(`chat ${logId(st.id)} idle restart of adopted daemon pid ${pid} port ${port}`);
    let gone = false;
    try {
      closeHold(st);
      clearReconnect(st);
      supervisor.forget(st.id);
      await shutdown(port, 'connector idle restart', st.id);
      gone = await waitGone(st.root, pid);
    } finally {
      st.restarting = false;
    }
    if (!gone) {
      st.idleRetryAt = d.now() + IDLE_RESTART_RETRY_MS;
      say(`chat ${logId(st.id)} idle restart: pid ${pid} still answers`);
    }
    if (live(st)) await connect(st);
  }

  function tick(st) {
    if (!live(st)) return Promise.resolve();
    st.tickGen++;
    st.health = null;
    const busy = st.restarting ? Promise.resolve() : idleCheck(st).catch(() => {});
    for (const fn of [...tickListeners]) {
      try {
        const r = fn({ chatId: st.id, chat: st.chat });
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch {}
    }
    return busy;
  }

  // ── shutdown ─────────────────────────────────────────────────────────────

  async function shutdown(port, reason, chatId) {
    if (!isPort(port)) return false;
    try {
      const body = await d.client.post('/api/shutdown', { reason }, {
        port,
        noSpawn: true,
        timeout: SHUTDOWN_TIMEOUT_MS,
        headers: { [SHUTDOWN_HEADER]: SHUTDOWN_HEADER_VALUE },
      });
      const acked = Boolean(body && body.ok);
      say(`chat ${logId(chatId)} shutdown port ${port} ${acked ? 'acked' : 'not acked'}`);
      return acked;
    } catch (e) {
      say(`chat ${logId(chatId)} shutdown port ${port} failed: ${(e && (e.code || e.status)) || 'error'}`);
      return false;
    }
  }

  // ── run and stop ─────────────────────────────────────────────────────────

  async function run(chat) {
    const c = chatOf(chat);
    let st = chats.get(c.id);
    if (!st) {
      st = {
        id: c.id, root: c.root, chat: c, desired: 'running',
        port: null, pid: null, status: null,
        handle: null, held: false, holdGen: 0, lastSeq: null, lastError: null,
        backoff: RECONNECT_MIN_MS, reconnect: null, connecting: null,
        tickGen: 0, health: null, tickTimer: null,
        restarting: false, idleRetryAt: null,
      };
      chats.set(c.id, st);
      // The callback answers the tick's idle check (a test's injected
      // setInterval awaits it); the real timer ignores the answer.
      st.tickTimer = unref(d.setInterval(() => tick(st), TICK_MS));
    }
    st.chat = c;
    st.root = c.root;
    if (st.connecting) return st.connecting;
    // Mid idle restart: the restart asks the supervisor itself, once.
    if (st.restarting) return { state: 'starting', retry_in_ms: RECONNECT_MIN_MS };
    if (st.handle) {
      // Held already: one stream per chat. The supervisor is still asked, so
      // the answer is current; the hold stays the one it is.
      let r;
      try { r = await supervisor.ensureRunning(c); } catch { r = { state: 'failed', reason: 'other' }; }
      if (live(st)) st.status = r;
      return r;
    }
    return connect(st);
  }

  async function stop(chat, mode = 'release') {
    if (!STOP_MODES.includes(mode)) throw new TypeError(`stop: mode is release or now (got ${mode})`);
    const c = chatOf(chat);
    const st = chats.get(c.id);
    const startedBy = supervisor.startedBy(c.id);
    let port = st ? st.port : null;
    if (st) {
      st.desired = 'stopped';
      chats.delete(c.id);
      if (st.tickTimer) { try { d.clearInterval(st.tickTimer); } catch {} st.tickTimer = null; }
      clearReconnect(st);
      closeHold(st);
    }
    supervisor.forget(c.id);
    let shut = false;
    if (mode === 'now' && (startedBy === 'connector' || c.owned_root)) {
      if (!isPort(port)) {
        let rec = null;
        try { rec = await d.registry.daemonFor(c.root); } catch { rec = null; }
        port = rec && isPort(rec.port) ? rec.port : null;
      }
      shut = await shutdown(port, 'connector stop', c.id);
    }
    say(`chat ${logId(c.id)} ${mode === 'now' ? 'stopped now' : 'released'} started_by ${startedBy || 'none'}`);
    return { released: true, shutdown: shut };
  }

  // ── the seams ────────────────────────────────────────────────────────────

  function subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('subscribe: a function is required');
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function onTick(fn) {
    if (typeof fn !== 'function') throw new TypeError('onTick: a function is required');
    tickListeners.add(fn);
    return () => tickListeners.delete(fn);
  }

  function setCursorProvider(fn) {
    if (fn != null && typeof fn !== 'function') throw new TypeError('setCursorProvider: a function or null');
    cursorProvider = fn || null;
  }

  function heldBy(chatId) {
    const st = chats.get(chatId);
    return Boolean(st && st.held && st.handle);
  }

  const api = {
    run, stop, subscribe, onTick, setCursorProvider, healthOf,
    applySettings, isPaused, effectiveCap, overCap, heldBy,
  };

  // CONNECTOR@install-seam: the run context holds one lifecycle. Nothing is
  // registered on the link here; the link's settings frames reach
  // applySettings through the wiring (U790).
  function install(ctx) {
    if (!ctx || typeof ctx !== 'object') throw new TypeError('install: a context object is required');
    if (ctx.lifecycle && ctx.lifecycle !== api) throw new Error('install: a lifecycle is already installed');
    ctx.lifecycle = api;
    return () => { if (ctx.lifecycle === api) delete ctx.lifecycle; };
  }
  api.install = install;

  return api;
}

module.exports = {
  createLifecycle,
  TICK_MS,
  RECONNECT_MIN_MS,
  RECONNECT_MAX_MS,
  IDLE_RESTART_WAIT_MS,
  STOP_MODES,
};
