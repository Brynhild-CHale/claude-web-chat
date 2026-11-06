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
//     builds one — and undoes it (POST /api/elements/undo, U518). A 404 there,
//     before U518 merges, counts `undo_missing` and the highlight is removed
//     with DELETE /api/elements/:id instead, so the soak's page does not grow
//     by one highlight a minute;
//   * strokes (strokeStep, U641) with the strokes fixture's type — the listed
//     type whose pack is the one fixture.json names, never another — in three
//     frames: an element-anchored stroke on a pane's svg, a pane-frame stroke
//     (the pane's outermost element's record) and one page-frame stroke, an
//     arrow between two panes on odd cycles and a margin stroke beside a pane
//     on even ones. The bodies are test-support/element-packs strokeBodies',
//     built once; each stroke is PRIVATE (shared false: no rail item, K.5 J2)
//     and written as the local browser writes one (a local Origin, the
//     socket's, so the daemon reads the writer as 'user' and the writer sees
//     its private stroke), then undone at once — POST /api/elements/undo {}
//     for the element and pane strokes, {item} (the arrow's to item, the
//     margin stroke's item) for the page one — with DELETE /api/elements/:id
//     when the undo fails. Counted as stroke_writes (the total) and
//     stroke_writes_element / _pane / _page (the type's row is the listing's,
//     so its own name rides each body); a refused write, undo or DELETE is
//     stroke_failures + 1, its status and body in drive.log (judged:
//     thresholds.json, max 0). No
//     pack listed, or the helper or jsdom missing, strokes nothing and counts
//     nothing;
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
// strokeBodies' fixed boxes (jsdom lays nothing out): #main's content box at
// pen-down for a page stroke's points, and each item's box for its endpoints.
const STROKE_FRAME = Object.freeze({ w: 1200, h: 2400 });
const STROKE_ITEM_BOX = Object.freeze({ w: 600, h: 240 });
// The panes the strokes go on: element and pane strokes on STROKE_MOUNT, the
// arrow from ARROW_FROM to ARROW_TO, the margin stroke beside MARGIN_ITEM.
const STROKE_MOUNT = PANES[1];
const ARROW_FROM = PANES[0];
const ARROW_TO = PANES[1];
const MARGIN_ITEM = PANES[2];

const COUNTERS = Object.freeze([
  'cycles', 'turns', 'reconnects', 'reconnect_failures', 'restarts', 'restart_failures',
  'element_writes', 'undo_ok', 'undo_missing', 'write_failures', 'nav_reads', 'nav_failures',
  'spawn_close_ok', 'set_active_ok', 'set_active_failures', 'stroke_writes', 'stroke_failures',
  'stroke_writes_element', 'stroke_writes_pane', 'stroke_writes_page',
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

  // ── the strokes (see the head of this file) ──
  const fx = readFixtureRecord(cfg);
  const strokePack = fx && typeof fx.pack === 'string' && fx.pack ? fx.pack : null;
  let strokeKit = null;
  if (strokePack) {
    try {
      const packs = require('../../test-support/element-packs');
      strokeKit = packs.strokeBodies({
        type: packs.STROKES_FIXTURE_TYPE, mount: STROKE_MOUNT, html: paneHtml(STROKE_MOUNT, 'd0'),
        arrowFrom: ARROW_FROM, arrowTo: ARROW_TO, marginItem: MARGIN_ITEM,
        frame: STROKE_FRAME, itemBox: STROKE_ITEM_BOX,
      });
    } catch (e) {
      log(`drive: no strokes this soak — the stroke bodies could not be built: ${e && e.message}`);
      strokeKit = null;
    }
  }
  // A browser's write: the socket's local Origin (lib/core/cors isLocalOrigin).
  const asBrowser = () => ({ ...opts(), headers: { origin: `http://localhost:${cfg.port}` } });
  const refused = (e) => (e && e.status ? `${e.status} ${JSON.stringify(e.body)}` : (e && e.message) || String(e));
  let strokeN = 0;

  // One stroke: POST it, then undo it at once (DELETE when the undo fails).
  async function strokeOnce(type, frame, body, undoBody) {
    let id = null;
    try {
      const r = await client.post('/api/elements', { ...body, type }, asBrowser());
      id = r && r.element && r.element.id;
      if (!id) throw new Error(`no element in the answer: ${JSON.stringify(r)}`);
    } catch (e) {
      counts.stroke_failures += 1;
      log(`drive: ${frame} stroke of ${type} refused: ${refused(e)}`);
      return;
    }
    counts.stroke_writes += 1;
    counts[`stroke_writes_${frame}`] += 1;
    try {
      const u = await client.post('/api/elements/undo', undoBody, asBrowser());
      if (u && u.undone && u.undone.id === id) return;
      throw new Error(`undid ${JSON.stringify(u && u.undone)}, not ${id}`);
    } catch (e) {
      counts.stroke_failures += 1;
      log(`drive: undo of the ${frame} stroke ${id} refused (${refused(e)}); deleting it`);
      try { await client.api('DELETE', `/api/elements/${encodeURIComponent(id)}`, null, asBrowser()); } catch (d) {
        counts.stroke_failures += 1;
        log(`drive: DELETE of the ${frame} stroke ${id} refused: ${refused(d)}`);
      }
    }
  }

  // The element, pane and one page stroke (the arrow on odd calls, the margin
  // stroke on even ones), each written and undone.
  async function strokeStep() {
    if (!strokeKit) return;
    let row = null;
    try {
      row = ((await client.get('/api/elements/types', opts())).types || []).find((t) => t && t.builtin === false && t.pack === strokePack) || null;
    } catch { return; }
    if (!row) return;
    strokeN += 1;
    const page = strokeN % 2 === 1
      ? { body: strokeKit.arrow, undo: { item: ARROW_TO } }
      : { body: strokeKit.margin, undo: { item: MARGIN_ITEM } };
    await strokeOnce(row.type, 'element', strokeKit.element, {});
    await strokeOnce(row.type, 'pane', strokeKit.pane, {});
    await strokeOnce(row.type, 'page', page.body, page.undo);
    save();
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

  return { run, stop, counts, cycle, save, strokeStep };
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

module.exports = {
  createDrive, COUNTERS, CYCLE_MS, RESTART_EVERY, RECONNECT_MS, RESTART_MS, rangeAnchor,
  STROKE_FRAME, STROKE_ITEM_BOX, STROKE_MOUNT, ARROW_FROM, ARROW_TO, MARGIN_ITEM,
};
