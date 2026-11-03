'use strict';
// scripts/soak/drive.js — the soak's scripted viewer, alive for the whole soak
// (H.11, U579).
//
// It holds the surface socket as a browser tab does (the ws dependency, a
// local Origin so lib/core/cors verifyUpgrade admits it) and, once a CYCLE_MS,
// inside one turn (POST /api/turn-begin … /api/turn-end, so a node commits when
// the surface changed):
//
//   * re-renders the three panes and rewrites the markdown item (fixture.js's
//     PANES, MD_ID — the page the fixture primed);
//   * writes an element — a highlight over a rendered pane's text through POST
//     /api/elements, its range anchor built as test/element-routes.test.js
//     builds one; and a stroke of the strokes fixture's type when the daemon
//     lists a non-built-in type — and undoes it (POST /api/elements/undo,
//     U518). A 404 there, before U518 merges, counts `undo_missing` and the
//     highlight is removed with DELETE /api/elements/:id instead, so the soak's
//     page does not grow by one highlight a minute;
//   * spawns a child pane under a soak pane and closes it (POST /api/pane/spawn
//     and /api/pane/close; a lib/client request is a local caller that is not
//     a browser, which the pane-stamp rule lets through);
//
// then, outside the turn:
//
//   * navigates: GET /api/graph/node/:id and GET /preview/node/:id of an older
//     node — reads, never Set active, so the soak mints no preserve nodes —
//     and reads one of the fixture's conversations' turns (GET
//     /api/mirror/conversations/:id/turns, a different one each cycle), so
//     the mirror parses listed conversations and its budget moves;
//   * drops the socket and opens it again: a `hello` within RECONNECT_MS is
//     `reconnects` + 1, else `reconnect_failures` + 1;
//   * every RESTART_EVERY cycles: one Set active round trip (an older node,
//     then back; over a clean surface neither preserves), recorded; then a
//     restart (stop.js's stopSoak, then start.js's startSoak) — the daemon not
//     answering within RESTART_MS is `restart_failures` + 1.
//
// Every write that fails (a non-2xx, a refusal, a dead socket) is
// `write_failures` + 1, with its reason in <out>/drive.log. The counters go to
// <out>/drive.json through writeJsonAtomic after every step. A SIGTERM (soak.sh
// kills the drive at the end) ends an open turn, writes drive.json and exits.
//
//   node scripts/soak/drive.js --root R [--cycle-ms 60000]

const path = require('path');
const { WebSocket } = require('ws');
const { enter, parseArgs, runMain, DRIVE_SOCKETS, DRIVE_RESTART_EVERY } = require('./lib');
const client = require('../../lib/client');
const { writeJsonAtomic } = require('../../lib/core/fsjson');
const { PANES, MD_ID, CONVERSATIONS, paneHtml, markdownText, sessionIdOf, readFixtureRecord } = require('./fixture');
const { startSoak } = require('./start');
const { stopSoak } = require('./stop');

const CYCLE_MS = 60 * 1000;
const RESTART_EVERY = DRIVE_RESTART_EVERY; // cycles: a restart and a Set active round trip every 5 minutes
const RECONNECT_MS = 5 * 1000;
const RESTART_MS = 10 * 1000;
const CALL_MS = 15 * 1000;

const COUNTERS = Object.freeze([
  'cycles', 'turns', 'reconnects', 'reconnect_failures', 'restarts', 'restart_failures',
  'element_writes', 'undo_ok', 'undo_missing', 'write_failures', 'nav_reads', 'nav_failures',
  'spawn_close_ok', 'set_active_ok', 'set_active_failures', 'stroke_writes', 'stroke_failures',
  'mirror_reads', 'mirror_read_failures',
]);

// The highlight anchor, as test/element-routes.test.js's RANGE builds one.
const rangeAnchor = (mount, exact = 'Hello') => ({ v: 1, kind: 'range', mount, quote: { exact, prefix: '', suffix: '' }, pos: { start: 0, end: exact.length } });

function createDrive(cfg, { cycleMs = CYCLE_MS, log = (line) => console.log(line) } = {}) {
  const counts = Object.fromEntries(COUNTERS.map((k) => [k, 0]));
  counts.sockets = DRIVE_SOCKETS;
  const file = path.join(cfg.out, 'drive.json');
  const opts = () => ({ port: cfg.port, timeout: CALL_MS });
  let sock = null;
  let inTurn = false;
  let stopping = false;

  const save = () => { try { writeJsonAtomic(file, { ...counts, at: Date.now() }); } catch (e) { log(`drive: drive.json: ${e.message}`); } };
  const fail = (what, e) => {
    counts.write_failures += 1;
    log(`drive: write failed — ${what}: ${e && e.status ? `${e.status} ${JSON.stringify(e.body)}` : (e && e.message) || e}`);
  };
  // A write: resolves its body, or null after counting the failure. A soft
  // refusal (`{ok: false}`) is a failure too.
  async function write(what, fn) {
    try {
      const r = await fn();
      if (r && r.ok === false) { fail(what, { message: JSON.stringify(r) }); return null; }
      return r || {};
    } catch (e) { fail(what, e); return null; }
  }

  // ── the socket ──
  function open() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
      const timer = setTimeout(() => done(false), RECONNECT_MS);
      let s;
      try {
        s = new WebSocket(`ws://localhost:${cfg.port}/ws`, { origin: `http://localhost:${cfg.port}` });
      } catch { done(false); return; }
      sock = s;
      s.on('message', (data) => {
        let m = null;
        try { m = JSON.parse(data.toString()); } catch {}
        if (m && m.type === 'hello') done(true);
      });
      s.on('error', () => done(false));
      s.on('unexpected-response', (_req, res) => { res.resume(); done(false); });
      s.on('close', () => { if (sock === s) sock = null; done(false); });
    });
  }
  function close() {
    return new Promise((resolve) => {
      const s = sock;
      sock = null;
      if (!s || s.readyState === WebSocket.CLOSED) return resolve();
      const t = setTimeout(() => { try { s.terminate(); } catch {} resolve(); }, 2000);
      s.once('close', () => { clearTimeout(t); resolve(); });
      try { s.close(); } catch { clearTimeout(t); resolve(); }
    });
  }
  async function reconnect() {
    await close();
    if (await open()) counts.reconnects += 1;
    else { counts.reconnect_failures += 1; log('drive: no hello within the reconnect window'); }
    save();
  }

  // ── one cycle ──
  async function elementStep() {
    const posted = await write('POST /api/elements highlight', () => client.post('/api/elements', {
      type: 'highlight', anchor: rangeAnchor(PANES[0]), payload: { color: 'gold', note: 'soak' },
    }, opts()));
    const el = posted && posted.element;
    if (!el || !el.id) return;
    counts.element_writes += 1;
    try {
      await client.post('/api/elements/undo', {}, opts());
      counts.undo_ok += 1;
    } catch (e) {
      if (e && e.status === 404) {
        counts.undo_missing += 1;
        await write(`DELETE /api/elements/${el.id}`, () => client.api('DELETE', `/api/elements/${encodeURIComponent(el.id)}`, null, opts()));
      } else fail('POST /api/elements/undo', e);
    }
  }

  // A stroke of the first non-built-in type the daemon lists (the strokes
  // fixture, U565). Its payload keys are the type's own; a refusal counts
  // `stroke_failures`, recorded and not judged, so a type this drive does not
  // know never fails the soak.
  async function strokeStep() {
    let types = [];
    try { types = ((await client.get('/api/elements/types', opts())).types || []).filter((t) => t && t.builtin === false); } catch { return; }
    if (!types.length) return;
    const t = types[0];
    const anchorKind = (t.anchors || []).includes('point') ? 'point' : 'range';
    const anchor = anchorKind === 'range' ? rangeAnchor(PANES[1]) : { v: 1, kind: 'point', mount: PANES[1], x: 0.5, y: 0.5 };
    try {
      const r = await client.post('/api/elements', { type: t.type, anchor, payload: { points: [[0.1, 0.1, 0.5], [0.4, 0.3, 0.6], [0.7, 0.5, 0.5]] } }, opts());
      counts.stroke_writes += 1;
      const id = r && r.element && r.element.id;
      if (id) { try { await client.post('/api/elements/undo', {}, opts()); } catch { await client.api('DELETE', `/api/elements/${encodeURIComponent(id)}`, null, opts()).catch(() => {}); } }
    } catch (e) {
      counts.stroke_failures += 1;
      log(`drive: stroke of ${t.type} refused: ${e && e.status} ${JSON.stringify(e && e.body)}`);
    }
  }

  async function spawnStep() {
    const parent = PANES[2];
    const s = await write('POST /api/pane/spawn', () => client.post('/api/pane/spawn', { parent, html: '<p class="soak-child">a child of the soak</p>' }, opts()));
    if (!s || !s.id) return;
    const c = await write('POST /api/pane/close', () => client.post('/api/pane/close', { parent, id: s.id }, opts()));
    if (c) counts.spawn_close_ok += 1;
  }

  async function graphNodes() {
    const g = await client.get('/api/graph', opts());
    const nodes = Array.isArray(g.nodes) ? g.nodes : Object.values(g.nodes || {});
    return { active: g.active, ids: nodes.map((n) => n && n.id).filter((id) => typeof id === 'string') };
  }
  const olderThan = (ids, active) => {
    const pool = ids.filter((id) => id !== active);
    return pool.length ? pool[Math.floor(Math.random() * Math.max(1, pool.length - 1))] : null;
  };

  async function navigate() {
    try {
      const { active, ids } = await graphNodes();
      const id = olderThan(ids, active);
      if (!id) return;
      await client.get(`/api/graph/node/${encodeURIComponent(id)}`, opts());
      await client.get(`/preview/node/${encodeURIComponent(id)}`, opts());
      counts.nav_reads += 1;
    } catch (e) {
      counts.nav_failures += 1;
      log(`drive: navigation read failed: ${e && e.status} ${e && e.message}`);
    }
  }

  const fx = readFixtureRecord(cfg);
  const conversations = fx && Number.isInteger(fx.conversations) && fx.conversations > 0 ? fx.conversations : CONVERSATIONS;
  async function readConversation(n) {
    const sid = sessionIdOf(n % conversations);
    try {
      await client.get(`/api/mirror/conversations/${encodeURIComponent(sid)}/turns?limit=5`, opts());
      counts.mirror_reads += 1;
    } catch (e) {
      counts.mirror_read_failures += 1;
      log(`drive: mirror read of ${sid} failed: ${e && e.status} ${e && e.message}`);
    }
  }

  async function setActiveRoundTrip() {
    try {
      const { active, ids } = await graphNodes();
      const id = olderThan(ids, active);
      if (!id || !active) return;
      const a = await client.post('/api/graph/active', { id }, opts());
      const b = await client.post('/api/graph/active', { id: active }, opts());
      if (a && a.ok && b && b.ok && !a.preserved && !b.preserved) counts.set_active_ok += 1;
      else { counts.set_active_failures += 1; log(`drive: set active round trip: ${JSON.stringify({ a, b })}`); }
    } catch (e) {
      counts.set_active_failures += 1;
      log(`drive: set active round trip failed: ${e && e.status} ${e && e.message}`);
    }
  }

  async function restart() {
    const before = await require('../../lib/util/registry').daemonFor(cfg.project);
    await close();
    await stopSoak(cfg, { waitHub: false, log });
    const d = await startSoak(cfg, { maxMs: RESTART_MS, not: before ? { pid: before.pid, port: before.port } : null });
    if (d && !d.already) counts.restarts += 1;
    else { counts.restart_failures += 1; log(`drive: the daemon did not answer within ${RESTART_MS} ms of the restart`); }
    save();
    await reconnect();
  }

  async function cycle(n) {
    const begun = await write('POST /api/turn-begin', () => client.post('/api/turn-begin', { message: `soak drive cycle ${n}`, author: 'user' }, opts()));
    inTurn = Boolean(begun);
    for (const id of PANES) await write(`POST /api/render ${id}`, () => client.post('/api/render', { id, html: paneHtml(id, `d${n}`) }, opts()));
    await write('POST /api/markdown', () => client.post('/api/markdown', { id: MD_ID, text: markdownText(`d${n}`) }, opts()));
    await elementStep();
    await strokeStep();
    await spawnStep();
    if (inTurn) {
      const end = await write('POST /api/turn-end', () => client.post('/api/turn-end', { author: 'claude', summary: `soak drive cycle ${n}` }, opts()));
      inTurn = false;
      if (end) counts.turns += 1;
    }
    save();
    await navigate();
    await readConversation(n);
    if (n % RESTART_EVERY === 0) {
      await setActiveRoundTrip();
      save();
      await restart();
    } else await reconnect();
    counts.cycles += 1;
    save();
  }

  async function run() {
    if (!(await open())) { counts.reconnect_failures += 1; log('drive: the first socket got no hello'); }
    save();
    for (let n = 1; !stopping; n++) {
      const t0 = Date.now();
      await cycle(n);
      const wait = Math.max(0, cycleMs - (Date.now() - t0));
      await new Promise((r) => { const t = setTimeout(r, wait); stopWaits.push(() => { clearTimeout(t); r(); }); });
    }
  }
  const stopWaits = [];

  async function stop() {
    stopping = true;
    for (const w of stopWaits.splice(0)) w();
    if (inTurn) {
      try { await client.post('/api/turn-end', { author: 'claude', summary: 'soak drive stopped' }, { port: cfg.port, timeout: 2000 }); } catch {}
      inTurn = false;
    }
    save();
    await close();
  }

  return { run, stop, counts, cycle, save };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = enter(args.root);
  const cycleMs = args.cycleMs !== undefined ? Number(args.cycleMs) : CYCLE_MS;
  const drive = createDrive(cfg, { cycleMs, log: (line) => console.log(`${new Date().toISOString()} ${line}`) });
  const onSignal = () => { drive.stop().then(() => process.exit(0), () => process.exit(0)); };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  await drive.run();
  return 0;
}

if (require.main === module) runMain(main);

module.exports = { createDrive, COUNTERS, CYCLE_MS, RESTART_EVERY, RECONNECT_MS, RESTART_MS, rangeAnchor };
