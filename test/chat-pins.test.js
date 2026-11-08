// The chat layer (public/app/chat-pins.js, U432; annotation engine 3C.1):
// the chat-comment pins drawn in ONE 'chat' overlay host over #chat-views,
// which follows the one chat panel across the dock (docked and windowed) and
// the phone sheet.
//
// The real chrome (test-support/chrome-shell, booted once) following a seeded
// conversation, as test/chat-stream.test.js does, with the overlay's box
// reads, frames and clock stubbed through initOverlay({rectOf, raf, now,
// clips}) as test/overlay-hosts.test.js does: jsdom does no layout, so the
// test owns the geometry (a model: each turn a band of the stream, each
// element of a turn a row of it, the diff view's lines rows of its body).
//
// Pinned here: a pin of each kind placed (turn, item — prompt, reply,
// thinking, tool card —, item-range through anchors.resolveSource over the
// chat sourceMap, diff-line in the turn's open diff view) docked, windowed
// and in the sheet; the clip over a stepped scroll; never over an answer
// frame; the six visible states with their explain lines (a note in place of
// one); the hidden reasons; the follow across chat:host; one re-place per
// chat:drawn; a passage past the cut at the cut's note; the relay (one GET per
// hello and reset, a frame applied with no GET, a hidden tab, below read, a
// reset and a preview keep every marker); indexing → placed; Escape; the
// reveal; the ⌘K row for pins whose conversation left the mirror; and the
// source checks.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { EXPLAIN, VISIBLE } = require('../lib/core/anchor-states');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

const T0 = Date.UTC(2026, 9, 28, 9, 0, 0);
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };
const CUT_MAX = 200000;   // lib/core/markdown.js CHAT_MAX_CHARS

let shell, W, $, doc, bus, S, ov, CP, dock, sheet, sh, topbar, anchors;
let level = 'local';
let rev = 1000;
let chatGets = 0;
const getTimes = [];          // when each chat GET reached the route (performance.now())
let hold = null;              // a promise the next chat GET waits on
let pinList = [];             // what GET /api/elements?type=chat-comment answers
const pages = new Map();      // conversation id → its page of turns

// jsdom has no IntersectionObserver (the stream's sentinel).
class StubIO {
  constructor(cb) { this.cb = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

// ── the conversations ───────────────────────────────────────────────────────
const LONG = 'a passage here. '.repeat(2500);   // 40,000: past the stream's reply cap (chat-state ITEM_CAPS, 32,768)
function snapshot(primary, { lvl = level, convs = ['cA', 'cB', 'cP'] } = {}) {
  const content = lvl !== 'basic';
  const rows = convs.map((id) => (content
    ? { id, rev: 1, headless: false, counts: ZERO, live: { state: 'idle', since: T0, last_activity_at: T0 } }
    : { id, state: 'idle', since: T0, last_activity_at: T0, counts: ZERO }));
  return { v: 1, enabled: true, now: Date.now(), rev: ++rev, content, access: { level: lvl, remote: lvl === 'basic' },
    capabilities: {}, primary, aggregate: { state: 'idle' }, conversations: rows, tasks: [], asks: [] };
}
let current = null;
const prompt = (tid, text) => ({ id: `p_${tid}`, kind: 'prompt', text, origin: 'human' });
const reply = (id, text) => ({ id, kind: 'reply', text });
const thinking = (id, text) => ({ id, kind: 'thinking', text });
const tool = (id, label) => ({ id, kind: 'tool_call', tool: 'Read', tool_kind: 'Read', label, call: label, status: 'done',
  started_at: T0, ended_at: T0 + 1000, duration_ms: 1000 });
function turn(cid, id, seq, items, extra = {}) {
  return {
    id, rev: ++rev, conversation_id: cid, session_id: 's1', seq, kind: 'prompt', author: 'user', status: 'done',
    started_at: T0 + seq * 60000, ended_at: T0 + seq * 60000 + 5000, duration_ms: 5000,
    counts: { items: items.length, tools: items.filter((i) => i.kind === 'tool_call').length, tool_errors: 0, agents: 0, tasks: 0, edits: 0 },
    tool_names: [], groups: [], node: null, folded_into: null, code: null, ...extra,
    items: items.map((it, i) => ({ turn_id: id, seq: seq * 1000 + i, ts: T0 + seq * 60000 + i, rev, ...it })),
  };
}
const R1 = "I'll look at **the rail** first.";
function seed() {
  pages.set('cA', [
    turn('cA', 't1', 1, [prompt('t1', 'Fix the rail please'), reply('r1_t1', R1), tool('tu_t1', 'Read · app.css'),
      thinking('th_t1', 'pondering the rail'), reply('r2_t1', 'Done.')]),
    turn('cA', 't2', 2, [prompt('t2', 'Second ask'), reply('r_t2', 'Answered.')], { superseded: true }),
    turn('cA', 't3', 3, [prompt('t3', 'A long one'), reply('r_t3', LONG)]),
    turn('cA', 't4', 4, [prompt('t4', 'Masked'), reply('r_t4', 'the token is ⟨masked⟩ here')]),
    turn('cA', 't5', 5, [prompt('t5', 'Indexing'), reply('r_t5', 'still reading')]),
  ]);
  pages.set('cB', [turn('cB', 'b1', 1, [prompt('b1', 'Other one')]), turn('cB', 'b2', 2, [prompt('b2', 'Other two'), reply('r_b2', 'reply b2')])]);
  const many = [];
  for (let i = 1; i <= 151; i++) many.push(turn('cP', `q${i}`, i, [prompt(`q${i}`, `turn ${i}`)]));
  pages.set('cP', many);
}
const DIFF = {
  v: 1, turn_id: 't1', status: 'ready', totals: { files: 1, additions: 1, deletions: 0 },
  files: [{ path: 'a.txt', status: 'M', additions: 1, deletions: 0 }],
  patch: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n line1\n+added\n line2\n',
};

// ── the pins ────────────────────────────────────────────────────────────────
const A = (state) => ({ state, visible: VISIBLE[state], explain: EXPLAIN[VISIBLE[state]] });
function pin(id, anchor, answer = A('exact'), extra = {}) {
  const a = { v: 1, conversation_id: 'cA', session_id: 's1', quote: { exact: `quote of ${id}`, prefix: '', suffix: '' },
    label: `label ${id}`, ...anchor };
  return { id, v: 1, type: 'chat-comment', schema: 'chat-comment@1', seq: 1, shared: true, replies: [],
    text: `SECRET COMMENT TEXT ${id}`, anchor: a, anchor_label: `on ${id}`, ...answer, ...extra };
}
const at15 = R1.indexOf('the rail');
const BASE = () => [
  pin('k1', { kind: 'turn', turn_id: 't1' }),
  pin('k2', { kind: 'item', turn_id: 't1', item_id: 'p_t1', field: 'text' }),
  pin('k3', { kind: 'item', turn_id: 't1', item_id: 'r1_t1', field: 'text' }),
  pin('k4', { kind: 'item', turn_id: 't1', item_id: 'th_t1', field: 'text' }),
  pin('k5', { kind: 'item', turn_id: 't1', item_id: 'tu_t1' }),
  pin('k6', { kind: 'item-range', turn_id: 't1', item_id: 'r1_t1', field: 'text',
    quote: { exact: 'the rail', prefix: 'look at **', suffix: '** first' }, pos: { start: at15, end: at15 + 8 } },
  { ...A('exact'), how: 'unique', at: { item_id: 'r1_t1', field: 'text', start: at15, end: at15 + 8 } }),
  pin('k7', { kind: 'diff-line', turn_id: 't1', file: 'a.txt', side: 'new', line: 2, quote: { exact: '+added' } },
    { ...A('exact'), how: 'line', at: { file: 'a.txt', side: 'new', line: 2 } }),
  pin('k8', { kind: 'item', turn_id: 't1', item_id: 'r2_t1', field: 'text' }, { ...A('re-resolved'), how: 'fingerprint' }),
  pin('k9', { kind: 'turn', turn_id: 't2' }, A('superseded')),
  pin('k10', { kind: 'item', turn_id: 't4', item_id: 'r_t4', field: 'text', quote: { exact: 'the token is ⟨masked⟩ here' } }, A('masked')),
  pin('k11', { kind: 'item', turn_id: 't5', item_id: 'r_t5', field: 'text' }, A('indexing')),
  pin('k12', { kind: 'turn', turn_id: 't4', quote: { exact: 'Masked prompt quote' } }, { ...A('unavailable'), rule: 'gone' }),
  pin('k13', { kind: 'item', turn_id: 'tgone', item_id: 'r_gone', quote: { exact: 'a reply that is gone' } }, A('unavailable')),
  pin('k14', { kind: 'turn', turn_id: 't5' }, { state: 'provisional', visible: 'refused', explain: EXPLAIN.refused }),
  pin('k15', { kind: 'item-range', turn_id: 't3', item_id: 'r_t3', field: 'text', quote: { exact: 'a passage here.' },
    pos: { start: CUT_MAX + 16, end: CUT_MAX + 31 } }, { ...A('exact'), at: { item_id: 'r_t3', start: CUT_MAX + 16, end: CUT_MAX + 31 } }),
  pin('k16', { kind: 'item', conversation_id: 'cB', turn_id: 'b2', item_id: 'r_b2', field: 'text' }),
];

// ── the fake scheduler, clock and geometry ──────────────────────────────────
const queue = [];
let clock = 0;
const fakeRaf = (fn) => { queue.push(fn); return queue.length; };
function flush(max = 20000) {
  let n = 0;
  while (queue.length && n < max) { queue.shift()(clock); n++; }
  assert.ok(n < max, 'the overlay settles to no pending frame');
  return n;
}
const geo = { scroll: 0, dscroll: 0, stream: { left: 860, top: 120, width: 400, height: 560 }, frame: null };
const TURN_H = 100;
const FAR = { left: -5000, top: -5000, width: 10, height: 10 };
const rect = (r) => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height });
function boxOfEl(el) {
  if (!el || el.nodeType !== 1) return FAR;
  const st = geo.stream;
  if (el.id === 'chat-stream' || el.id === 'chat-views') return st;
  if (el.localName === 'iframe') return geo.frame || FAR;
  const body = el.closest('.cp-dbody');
  if (body) {
    if (el === body) return st;
    const list = [...body.querySelectorAll('*')];
    const k = list.indexOf(el);
    return { left: st.left + 20, top: st.top + 30 + k * 18 - geo.dscroll, width: 300, height: 16 };
  }
  const t = el.closest('.ct-turn');
  const stream = $('chat-stream');
  if (t && stream && stream.contains(t)) {
    const i = [...stream.querySelectorAll('.ct-turn')].indexOf(t);
    const base = st.top + 10 + i * TURN_H - geo.scroll;
    if (el === t) return { left: st.left + 12, top: base, width: 370, height: TURN_H - 10 };
    const k = [...t.querySelectorAll('*')].indexOf(el);
    return { left: st.left + 30, top: base + 6 + (k % 16) * 5, width: 300, height: 12 };
  }
  return FAR;
}
let reads = 0;
function rectOf(x) {
  reads++;
  clock += 0.01;
  if (x && x.startContainer) {
    const sc = x.startContainer;
    const r = boxOfEl(sc.nodeType === 1 ? sc : sc.parentNode);
    return rect({ ...r, left: r.left + 8 });
  }
  return rect(boxOfEl(x));
}
const clips = (el) => el.id === 'chat-stream' || (el.classList && el.classList.contains('cp-dbody'));

async function settle(n = 4) {
  for (let i = 0; i < n; i++) {
    await shell.tick();
    flush();
  }
}
const layer = () => doc.getElementById('el-layer-chat');
const markers = () => [...layer().querySelectorAll('.el-marker')];
const markerOf = (id) => markers().find((m) => (m.dataset.elIds || '').split(' ').includes(id)) || null;
const shown = (m) => !!m && m.style.display !== 'none';
const turnEl = (id) => $('chat-stream').querySelector(`.ct-turn[data-turn-id="${id}"]`);
const itemElOf = (id) => $('chat-stream').querySelector(`[data-item-id="${id}"]`);
const placed = (id) => { const p = CP.chatPinOf(id); return p && p.placed; };

async function follow(cid) {
  S.followConversation(cid);
  await waitUntil(() => S.mirror.stream.conversationId === cid && !S.mirror.stream.loading
    && $('chat-stream').querySelectorAll('.ct-turn').length === Math.min(pages.get(cid).length, 150), { what: `the stream of ${cid}` });
  await settle();
}
async function hello() {
  await shell.frame(helloFrame());
  await waitUntil(() => S.mirror.availability === 'ok' && S.mirror.access.level === current.access.level, { what: 'the snapshot' });
  await settle();
}
async function chatOpen() {
  if (!dock.isChatOpen()) bus.emit('chat:open', { view: 'chat' });
  await settle();
}

before(async () => {
  globalThis.IntersectionObserver = StubIO;
  seed();
  pinList = BASE();
  current = snapshot('cA');
  shell = await bootShell({
    routes: {
      '/api/mirror': () => current,
      '/api/mirror/conversations/*': (url) => {
        const id = decodeURIComponent(url.split('?')[0].split('/')[4]);
        const turns = url.includes('before=') ? [] : (pages.get(id) || []);
        return { conversation_id: id, turns, next_before: null, total: turns.length, rev: ++rev };
      },
      '/api/mirror/diff': () => DIFF,
      '/api/elements': async (url) => {
        if (!url.includes('type=chat-comment')) return { elements: [], next_cursor: 0 };
        chatGets++;
        getTimes.push(performance.now());
        if (hold) await hold;
        return { elements: pinList.map((p) => ({ ...p })), next_cursor: 9 };
      },
    },
  });
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  ov = await shell.importApp('overlay.js');
  CP = await shell.importApp('chat-pins.js');
  dock = await shell.importApp('chat-dock.js');
  sheet = await shell.importApp('chat-sheet.js');
  sh = await shell.importApp('shell.js');
  topbar = await shell.importApp('topbar.js');
  anchors = (await shell.importApp('anchors.js')).default;
  ov.initOverlay({ rectOf, raf: fakeRaf, now: () => clock, clips });
  await hello();
  await chatOpen();
  await follow('cA');
  await waitUntil(() => CP.chatPins().length === pinList.length, { what: 'the chat pins' });
  await settle();
});

after(() => {
  delete globalThis.IntersectionObserver;
  return shell.restore();
});

// ── the host and the four kinds ─────────────────────────────────────────────
async function openDiff() {
  bus.emit('chat:open', { view: 'diff', id: 't1' });
  await waitUntil(() => doc.querySelector('#chat-detail .dv-diffview[data-turn-id="t1"] details.dv-file'), { what: 'the diff view' });
  doc.querySelector('#chat-detail details.dv-file[data-path="a.txt"]').open = true;
  await settle();
}
async function closeDetails() {
  bus.emit('chat:open', { view: 'chat' });
  await settle();
}
function checkKinds(where) {
  const stream = $('chat-stream');
  const at = (id) => markerOf(id) && markerOf(id)._group;
  assert.equal(at('k1').el, turnEl('t1'), `${where}: a turn pin on the turn root`);
  assert.equal(at('k2').el, itemElOf('p_t1'), `${where}: the prompt bubble`);
  assert.equal(at('k3').el, itemElOf('r1_t1'), `${where}: the reply prose`);
  const range = at('k6').range;
  assert.ok(range, `${where}: a passage is a Range`);
  assert.equal(range.toString(), 'the rail', `${where}: the answer's range, through the chat sourceMap`);
  assert.ok(itemElOf('r1_t1').contains(range.startContainer), `${where}: inside its reply`);
  for (const id of ['k1', 'k2', 'k3', 'k6']) {
    assert.ok(shown(markerOf(id)), `${where}: ${id} drawn`);
    assert.ok(markerOf(id).classList.contains('el-hit'), `${where}: ${id} drawn el-hit`);
    assert.ok(stream.contains(at(id).el || at(id).range.startContainer));
  }
  assert.equal(markerOf('k1').parentNode, layer(), 'in #el-layer-chat');
}

test('one chat host over #chat-views at --z-chat-pins; the chat-comment type on it with the comment tool', () => {
  const h = ov.hosts().find((x) => x.name === 'chat');
  assert.ok(h, 'the chat host is registered');
  assert.equal(h.root, $('chat-views'));
  assert.equal(h.rung, '--z-chat-pins');
  assert.deepEqual(h.kinds, ['turn', 'item', 'item-range', 'diff-line']);
  assert.equal(h.layer, 'el-layer-chat');
  assert.equal(ov.hosts().filter((x) => x.name === 'chat').length, 1);
  assert.equal(CP.CHAT_TYPE, 'chat-comment');
});

test('the four kinds docked: a turn, an item (prompt, reply, thinking, tool card), a passage and a diff line in the open diff view', async () => {
  checkKinds('docked');
  // The thinking and the tool card sit in closed <details>: placed at the summary.
  assert.equal(markerOf('k4')._group.el.localName, 'summary', 'a closed thought: its summary');
  assert.equal(markerOf('k5')._group.el.localName, 'summary', 'a closed tool group: its summary');
  turnEl('t1').querySelector('details.ct-group').open = true;
  turnEl('t1').querySelector('details.ct-think').open = true;
  bus.emit('chat:drawn', { conversationId: 'cA', turnIds: ['t1'] });
  await settle();
  assert.equal(markerOf('k4')._group.el, itemElOf('th_t1'), 'the thinking text');
  assert.equal(markerOf('k5')._group.el, itemElOf('tu_t1'), 'the tool card');
  assert.ok(shown(markerOf('k4')) && shown(markerOf('k5')));
  // The diff line: covered with no diff view open; drawn on its .dl in the view.
  assert.equal(placed('k7').hidden, 'covered', 'no diff view open: covered');
  assert.ok(!shown(markerOf('k7')));
  await openDiff();
  const m7 = markerOf('k7');
  assert.ok(shown(m7), 'drawn in the open diff view');
  assert.ok(m7._group.el.classList.contains('dl'), 'on the .dl line');
  assert.equal(m7._group.el.getAttribute('data-new'), '2');
  assert.equal(m7._group.el.textContent, '+added');
  for (const id of ['k1', 'k2', 'k3', 'k6']) assert.equal(placed(id).hidden, 'covered', `${id}: under the detail view`);
  for (const id of ['k1', 'k2', 'k3', 'k6']) assert.ok(!shown(markerOf(id)), `${id} not drawn under the view`);
  await closeDetails();
  assert.equal(placed('k7').hidden, 'covered');
  assert.ok(shown(markerOf('k1')));
});

test('windowed (chat-dock\'s window mode) and in the sheet at 390×844 (half and full): every kind drawn on its item', async () => {
  const before = Object.fromEntries(['k1', 'k2', 'k3'].map((id) => [id, markerOf(id)._group.el]));
  const placesBefore = ov.stats('chat').places;
  doc.querySelector('#chat-dock .cd-detach').click();
  await settle();
  assert.equal($('chat-dock').dataset.mode, 'window');
  assert.ok(ov.stats('chat').places > placesBefore, 'the dock\'s attribute change re-placed the host');
  checkKinds('windowed');
  for (const id of Object.keys(before)) assert.equal(markerOf(id)._group.el, before[id], 'the same element');
  doc.querySelector('#chat-dock .cd-attach').click();
  await settle();

  geo.stream = { left: 0, top: 300, width: 390, height: 460 };
  shell.setViewport({ width: 390, height: 844, coarse: true });
  await settle();
  sheet.openSheet({ view: 'chat' });
  await settle();
  assert.ok($('sh-chat') && $('sh-chat').contains($('chat-views')), 'the panel moved into the sheet');
  assert.equal(sheet.sheetState().stop, 'half');
  checkKinds('sheet half');
  // The turn root is the stream's own, kept; its items may be rebuilt when the
  // store reads the page again on the posture change (chat-state's), and each
  // marker is on its item as drawn now (checkKinds).
  assert.equal(markerOf('k1')._group.el, before.k1, 'the turn root: the same element, re-measured');
  sheet.setStop(sheet.sheetState().stops.full);
  await settle();
  assert.equal(sheet.sheetState().stop, 'full');
  checkKinds('sheet full');
  // Hidden 'sheet': the sheet closed, or on Tasks.
  sheet.setStop(0);
  await settle();
  assert.equal(placed('k1').hidden, 'sheet');
  assert.ok(!shown(markerOf('k1')));
  sheet.openSheet({ view: 'tasks' });
  await settle();
  assert.equal(placed('k1').hidden, 'sheet', 'the Tasks view');
  sheet.openSheet({ view: 'chat' });
  await settle();
  assert.equal(placed('k1').hidden, null);
  sheet.closeSheet({ returnFocus: false });
  geo.stream = { left: 860, top: 120, width: 400, height: 560 };
  shell.setViewport({ width: 1280, height: 800, coarse: false });
  await settle();
  await chatOpen();
  assert.ok($('cd-body').contains($('chat-views')), 'back in the dock');
  checkKinds('docked again');
  assert.equal(markerOf('k1')._group.el, before.k1, 'dock → sheet → dock: the same turn root');
});

test('follow: chat:host dock → sheet → dock keeps every marker drawn on its item (the same element, re-measured)', async () => {
  const ids = ['k1', 'k2', 'k3', 'k6', 'k8', 'k9'];
  const before = Object.fromEntries(ids.map((id) => [id, markerOf(id)._group.el || markerOf(id)._group.range.startContainer]));
  const dockBody = $('cd-body');
  const sheetHost = $('sh-chat') || (() => { const d = doc.createElement('div'); d.className = 'test-host'; $('stage').appendChild(d); return d; })();
  for (const [host, variant] of [[sheetHost, 'sheet'], [dockBody, 'desktop']]) {
    const p0 = ov.stats('chat').places;
    bus.emit('chat:host', { host, variant });
    await settle();
    assert.ok(host.contains($('chat-views')), `the panel is in the ${variant} host`);
    assert.ok(ov.stats('chat').places > p0, 'chat:host re-placed the host');
    for (const id of ids) {
      const g = markerOf(id)._group;
      assert.equal(g.el || g.range.startContainer, before[id], `${variant}: ${id} on the same element`);
      assert.ok(shown(markerOf(id)), `${variant}: ${id} drawn`);
    }
  }
});

// ── the clip and the frames ─────────────────────────────────────────────────
test('the clip: over a stepped scroll of #chat-stream, 0 anchor points and 0 glyph boxes outside well ∩ viewport', async () => {
  const well = geo.stream;
  const clip = { left: Math.max(0, well.left), top: Math.max(0, well.top), right: Math.min(W.innerWidth, well.left + well.width),
    bottom: Math.min(W.innerHeight, well.top + well.height) };
  let drawnSeen = 0;
  let clippedSeen = 0;
  for (let s = 0; s <= 5 * TURN_H; s += 40) {
    geo.scroll = s;
    $('chat-stream').dispatchEvent(new W.Event('scroll'));
    await settle(2);
    for (const m of markers()) {
      if (!shown(m)) { clippedSeen++; continue; }
      drawnSeen++;
      const x = parseFloat(m.style.left);
      const y = parseFloat(m.style.top);
      assert.ok(x >= clip.left && x < clip.right && y >= clip.top && y < clip.bottom, `anchor point inside at scroll ${s}`);
      const ins = (m.style.clipPath.match(/-?[\d.]+px/g) || ['0', '0', '0', '0']).map(parseFloat);
      const [t, r, b, l] = ins.length === 4 ? ins : [0, 0, 0, 0];
      const g = { left: x + l, top: y + t, right: x + parseFloat(m.style.width) - r, bottom: y + parseFloat(m.style.height) - b };
      assert.ok(g.left >= clip.left - 0.01 && g.top >= clip.top - 0.01 && g.right <= clip.right + 0.01 && g.bottom <= clip.bottom + 0.01,
        `glyph box inside at scroll ${s}`);
    }
  }
  assert.ok(drawnSeen > 0 && clippedSeen > 0, 'the steps drew some and clipped some');
  geo.scroll = 0;
  $('chat-stream').dispatchEvent(new W.Event('scroll'));
  await settle();
});

test('never over the awaiting card\'s frames: an answer frame meeting a glyph leaves it undrawn; no marker inside the card', async () => {
  const card = $('chat-awaiting');
  const m = markerOf('k1');
  assert.ok(shown(m));
  const x = parseFloat(m.style.left);
  const y = parseFloat(m.style.top);
  const iframe = doc.createElement('iframe');
  iframe.className = 'test-answer-frame';
  card.hidden = false;
  card.appendChild(iframe);
  geo.frame = { left: x + 4, top: y + 4, width: 8, height: 8 };
  try {
    $('chat-stream').dispatchEvent(new W.Event('scroll'));
    await settle();
    assert.ok(!shown(markerOf('k1')), 'the glyph meeting the frame is not drawn');
    assert.ok(ov.stats('chat').frame_hidden >= 1);
    assert.ok(shown(markerOf('k3')), 'one beside it is');
    assert.equal(card.querySelector('.el-marker'), null, 'no marker inside the awaiting card');
  } finally {
    iframe.remove();
    card.hidden = true;
    geo.frame = null;
    $('chat-stream').dispatchEvent(new W.Event('scroll'));
    await settle();
  }
  assert.ok(shown(markerOf('k1')));
});

// ── the six visible states ──────────────────────────────────────────────────
test('the states: placed el-hit; superseded, masked, indexing with their classes; unavailable listed; provisional drawn nowhere', async () => {
  assert.ok(markerOf('k1').classList.contains('el-hit'), 'exact');
  assert.ok(markerOf('k8').classList.contains('el-hit'), 're-resolved');
  assert.ok(turnEl('t2').classList.contains('ct-superseded'));
  assert.equal(markerOf('k9')._group.el, turnEl('t2'));
  assert.ok(markerOf('k9').classList.contains('el-superseded'), 'superseded');
  assert.ok(markerOf('k10').classList.contains('el-masked'), 'masked');
  assert.ok(markerOf('k11').classList.contains('el-indexing'), 'indexing');
  assert.equal(markerOf('k11')._group.el, itemElOf('r_t5'), 'an indexing pin whose turn is drawn: at its item');
  // Unavailable: under its turn while the stream draws it; else at the stream's top.
  assert.equal(markerOf('k12')._group.el, turnEl('t4'), 'listed under its turn');
  assert.ok(markerOf('k12').classList.contains('el-unavailable'));
  assert.equal(markerOf('k13')._group.el, $('chat-stream'), 'no turn drawn: the group marker at the stream\'s top');
  assert.ok(shown(markerOf('k13')));
  assert.equal(markerOf('k14'), null, 'a provisional answer: nothing draws it');
  for (const id of ['k1', 'k8', 'k9', 'k10', 'k11', 'k12', 'k13']) assert.ok(shown(markerOf(id)), `${id} shown`);
  // Each marker's title is its explain line, never the pin's text.
  for (const m of markers()) {
    assert.ok(!/SECRET COMMENT TEXT/.test(m.title), 'no comment text in a title');
    assert.ok(!/SECRET COMMENT TEXT/.test(m.textContent));
  }
  assert.equal(markerOf('k12').title, EXPLAIN.unavailable);
  assert.equal(markerOf('k10').title, EXPLAIN.masked);
  assert.equal(markerOf('k9').title, EXPLAIN.superseded);
  assert.equal(markerOf('k1').title, EXPLAIN.placed);
  assert.ok(!ov.orphans().some((o) => /^k\d+$/.test(o.id)), 'no chat pin is ever an orphan');
  // The list: each pin with its own quote and its explain line.
  const pop = CP.openPinList(['k12', 'k13'], 100, 100);
  try {
    assert.ok(pop.classList.contains('pin-chooser') && pop.classList.contains('pin-pop') && pop.classList.contains('popover'));
    const rows = [...pop.querySelectorAll('.pin-thread-row')];
    assert.deepEqual(rows.map((r) => r.dataset.id), ['k12', 'k13']);
    assert.equal(rows[1].querySelector('.ptr-quote').textContent, 'a reply that is gone', 'its own quote');
    assert.equal(rows[1].querySelector('.ptr-explain').textContent, EXPLAIN.unavailable);
    assert.ok(!/SECRET COMMENT TEXT/.test(pop.textContent));
    assert.equal(pop.querySelector('[id]'), null, 'classes only');
  } finally { CP.closePinList(); }
  // The masked quote is the served one, shown as served.
  const p10 = CP.openPinList(['k10'], 100, 100);
  assert.equal(p10.querySelector('.ptr-quote').textContent, 'the token is ⟨masked⟩ here');
  CP.closePinList();
});

test('Q7: an indexing answer\'s note replaces its EXPLAIN line in the title and the list; one without a note shows EXPLAIN', async () => {
  const NOTE = 'the code diff for this turn is still being prepared';
  pinList = [...BASE().filter((p) => p.id !== 'k11'),
    pin('k11', { kind: 'item', turn_id: 't5', item_id: 'r_t5', field: 'text' }, { ...A('indexing'), how: 'diff-pending', note: NOTE })];
  await CP.refreshChatPins();
  await settle();
  assert.equal(markerOf('k11').title, NOTE);
  const pop = CP.openPinList(['k11'], 10, 10);
  assert.equal(pop.querySelector('.ptr-explain').textContent, NOTE);
  CP.closePinList();
  pinList = BASE();
  await CP.refreshChatPins();
  await settle();
  assert.equal(markerOf('k11').title, EXPLAIN.indexing);
  const pop2 = CP.openPinList(['k11'], 10, 10);
  assert.equal(pop2.querySelector('.ptr-explain').textContent, EXPLAIN.indexing);
  CP.closePinList();
});

// ── hidden ──────────────────────────────────────────────────────────────────
test('hidden: another conversation → elsewhere; a detail over the stream → covered; never orphaned', async () => {
  assert.equal(placed('k16').hidden, 'elsewhere');
  assert.ok(!shown(markerOf('k16')));
  bus.emit('chat:open', { view: 'diff', id: 't1' });
  await settle();
  assert.equal(placed('k1').hidden, 'covered');
  await closeDetails();
  assert.equal(placed('k1').hidden, null);
  assert.deepEqual(ov.orphans().filter((o) => /^k/.test(o.id)), []);
});

test('hidden: a 151st turn pruned → its pin hidden \'pruned\' and never orphaned', async () => {
  pinList = [...BASE(), pin('kp1', { kind: 'turn', conversation_id: 'cP', turn_id: 'q1' }),
    pin('kp2', { kind: 'turn', conversation_id: 'cP', turn_id: 'q151' })];
  await CP.refreshChatPins();
  await follow('cP');
  try {
    assert.equal(turnEl('q1'), null, 'the first of 151 turns is pruned');
    assert.equal(placed('kp1').hidden, 'pruned');
    assert.ok(!shown(markerOf('kp1')));
    assert.equal(placed('kp2').hidden, null, 'the newest turn\'s pin is placed, not hidden');
    assert.equal(markerOf('kp2')._group.el, turnEl('q151'));
    assert.equal(placed('k1').hidden, 'elsewhere', 'cA\'s pins: another conversation now');
    assert.ok(!ov.orphans().some((o) => o.id === 'kp1'));
  } finally {
    pinList = BASE();
    await CP.refreshChatPins();
    await follow('cA');
  }
});

// ── follow and settle ───────────────────────────────────────────────────────
test('chat:drawn re-places the host once per draw', async () => {
  await settle();
  const p0 = ov.stats('chat').places;
  bus.emit('chat:drawn', { conversationId: 'cA', turnIds: ['t1'] });
  await settle();
  assert.equal(ov.stats('chat').places, p0 + 1, 'one draw, one re-place');
  bus.emit('chat:drawn', { conversationId: 'cA', turnIds: ['t1'] });
  bus.emit('chat:drawn', { conversationId: 'cA', turnIds: ['t1'] });
  await settle();
  assert.equal(ov.stats('chat').places, p0 + 2, 'two in one frame: one re-place');
});

test('a passage past the cut: at the cut\'s note (CHAT_MAX_CHARS, data-src-cut); past the text the stream holds, at its item — never orphaned', async () => {
  const el = itemElOf('r_t3');
  assert.equal(markerOf('k15')._group.el, el, 'past the text the stream holds: at the item');
  assert.equal(placed('k15').how, 'cut');
  assert.ok(markerOf('k15').classList.contains('el-hit'), 'drawn, never orphaned');
  // The renderer's cut note (markdown.js: p.md-note[data-src-cut] once a reply
  // passes CHAT_MAX_CHARS, which the stream's own cap keeps it under today):
  // a passage at or past its offset is drawn at the note.
  const note = doc.createElement('p');
  note.className = 'md-note';
  note.setAttribute('data-src-cut', '20');
  note.textContent = '… beyond the shown text';
  el.querySelector('.md-chat').appendChild(note);
  pinList = [...BASE(), pin('k19', { kind: 'item-range', turn_id: 't3', item_id: 'r_t3', field: 'text',
    quote: { exact: 'a passage here.' }, pos: { start: 32, end: 47 } }, { ...A('exact'), at: { item_id: 'r_t3', start: 32, end: 47 } })];
  try {
    await CP.refreshChatPins();
    await settle();
    assert.equal(markerOf('k19')._group.el, note, 'at the cut\'s note');
    assert.equal(placed('k19').how, 'cut');
  } finally {
    note.remove();
    pinList = BASE();
    await CP.refreshChatPins();
    await settle();
  }
});

// ── the records ─────────────────────────────────────────────────────────────
const QUIET = () => BASE().filter((p) => p.state !== 'indexing');   // no indexing re-read on the hydrate's mirror change
test('records: one GET per hello and per reset; a frame applied with no GET; a frame naming an unanswered pin asks once', async () => {
  pinList = QUIET();
  await CP.refreshChatPins();
  await settle();
  let n = chatGets;
  await shell.frame(helloFrame());
  await settle();
  // The hello's own GET, then the single-flight re-reads its hydrate's 'stream'
  // changes ask for while the followed conversation has pins (K.2-177 g3).
  assert.ok(chatGets - n >= 1 && chatGets - n <= 3, `a GET per hello, plus at most the hydrate's stream re-reads: ${chatGets - n}`);
  n = chatGets;
  await shell.frame({ ...helloFrame(), type: 'reset', elements: [] });
  await settle();
  assert.equal(chatGets, n + 1, 'one GET per reset');
  assert.ok(shown(markerOf('k1')), 'a reset (a Wipe\'s reset frame) keeps every chat marker');
  n = chatGets;
  const framed = QUIET().filter((p) => p.id !== 'k3');
  await shell.frame({ type: 'element:chat-comment', elements: framed });
  await settle();
  assert.equal(chatGets, n, 'the frame: applied with no GET');
  assert.equal(CP.chatPinOf('k3'), null, 'the frame is the whole set');
  assert.equal(markerOf('k3'), null);
  const unanswered = { ...pin('k3', { kind: 'item', turn_id: 't1', item_id: 'r1_t1' }) };
  delete unanswered.state;
  await shell.frame({ type: 'element:chat-comment', elements: [...framed, unanswered] });
  assert.equal(markerOf('k3'), null, 'a row with no answer is held undrawn');
  await settle();
  assert.equal(chatGets, n + 1, 'one GET for the pin it cannot place');
  assert.ok(shown(markerOf('k3')));
  pinList = BASE();
  await CP.refreshChatPins();
  await settle();
});

test('records: a hidden tab defers the read; shell.intervals() gains none; below read nothing is requested or drawn', async () => {
  pinList = QUIET();
  await CP.refreshChatPins();
  await settle();
  const intervals = shell.intervals().length;
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
  let n = chatGets;
  try {
    await shell.frame(helloFrame());
    await settle();
    assert.equal(chatGets, n, 'hidden: no read');
  } finally {
    delete doc.visibilityState;
  }
  doc.dispatchEvent(new W.Event('visibilitychange'));
  await settle();
  assert.equal(chatGets, n + 1, 'visible again: the read it owed');
  assert.equal(shell.intervals().length, intervals, 'no interval');
  // Below read.
  current = snapshot('cA', { lvl: 'basic' });
  await hello();
  assert.equal(S.mirror.access.level, 'basic');
  n = chatGets;
  await shell.frame(helloFrame());
  await settle();
  assert.equal(chatGets, n, 'nothing requested below read');
  assert.deepEqual(markers(), [], 'nothing drawn below read');
  await shell.frame({ type: 'element:chat-comment', elements: BASE() });
  await settle();
  assert.deepEqual(markers(), [], 'a frame below read draws nothing');
  current = snapshot('cA');
  await hello();
  await chatOpen();
  await follow('cA');
  await waitUntil(() => CP.chatPins().length === QUIET().length, { what: 'the pins back at local' });
  await settle();
  assert.ok(shown(markerOf('k1')));
  pinList = BASE();
  await CP.refreshChatPins();
  await settle();
});

test('a preview keeps every chat marker', async () => {
  const m = markerOf('k1');
  shell.setRoutes({ '/api/graph/node/n2': { id: 'n2', mounts: [], store: {}, created_at: 2, lean_elements: [], elements: [] } });
  await topbar.previewNode('n2');
  await settle();
  assert.equal(ov.drawnScopeOf(), 'preview');
  assert.equal(markerOf('k1'), m, 'not rebuilt');
  assert.ok(shown(markerOf('k1')));
  topbar.returnToActive();
  await settle();
  shell.setRoutes({});
  assert.ok(shown(markerOf('k1')));
});

test('indexing → placed: one more GET after a bus mirror {what: [all]}; two bursts give one read in flight', async () => {
  pinList = [...QUIET().filter((p) => p.id !== 'k3'), pin('k3', { kind: 'item', turn_id: 't1', item_id: 'r1_t1', field: 'text' }, A('indexing'))];
  await CP.refreshChatPins();
  await settle();
  assert.ok(markerOf('k3').classList.contains('el-indexing'));
  pinList = QUIET();
  let release;
  hold = new Promise((r) => { release = r; });
  const n = chatGets;
  bus.emit('mirror', { what: ['all'] });
  bus.emit('mirror', { what: ['stream'] });
  await shell.tick();
  assert.equal(chatGets, n + 1, 'one read in flight for two bursts');
  hold = null;
  release();
  await settle();
  // The 'stream' burst heard during the read asks for one more once it lands:
  // the followed conversation has pins (K.2-177 g3), a stream-only reason,
  // so it trails by the re-read interval (U635); then nothing further.
  await waitUntil(() => chatGets === n + 2, { timeout: CP.REREAD_MIN_MS + 2000, what: 'the burst\'s trailing re-read' });
  await settle();
  assert.equal(chatGets, n + 2, 'placed now: the burst\'s one re-read, no further read');
  assert.ok(markerOf('k3').classList.contains('el-hit'), 'placed');
  bus.emit('mirror', { what: ['all'] });
  await settle();
  assert.equal(chatGets, n + 2, 'no pin indexing: an \'all\' change asks for nothing');
  pinList = BASE();
  await CP.refreshChatPins();
  await settle();
});

test('a superseded answer after a terminal rewind: a bus mirror {what: [stream]} re-reads the followed conversation\'s pins, so the pin stops drawing el-hit before the next hello (K.2-177 g3)', async () => {
  pinList = QUIET();
  await CP.refreshChatPins();
  await settle();
  assert.ok(markerOf('k1').classList.contains('el-hit'), 'placed first');
  const n = chatGets;
  pinList = QUIET().map((p) => (p.id === 'k1' ? { ...p, ...A('superseded') } : p));
  bus.emit('mirror', { what: ['stream'] });
  // A stream-only reason: the re-read trails by the re-read interval (U635).
  await waitUntil(() => chatGets === n + 1, { timeout: CP.REREAD_MIN_MS + 2000, what: 'the stream change\'s trailing re-read' });
  await settle();
  assert.equal(chatGets, n + 1, 'one re-read for the stream change');
  assert.ok(!markerOf('k1').classList.contains('el-hit'), 'no longer el-hit');
  assert.ok(markerOf('k1').classList.contains('el-superseded'), 'drawn superseded');
  bus.emit('mirror', { what: ['conversations'] });
  await settle();
  assert.equal(chatGets, n + 1, 'a change naming neither stream nor all asks for nothing');
  pinList = BASE();
  await CP.refreshChatPins();
  await settle();
});

test('an indexing pin of a non-followed conversation that the inspector\'s turn list lists moves to placed on a bus mirror {what: [stream]} (K.2-181 g7)', async () => {
  const only = (answer) => [pin('k16', { kind: 'item', conversation_id: 'cB', turn_id: 'b2', item_id: 'r_b2', field: 'text' }, answer)];
  assert.equal(S.followed(), 'cA');
  pinList = only(A('indexing'));
  await CP.refreshChatPins();
  await settle();
  assert.equal(CP.chatPinOf('k16').row.answer.state, 'indexing');
  // Not listed by any other host: a stream change asks for nothing (no pin of the followed conversation either).
  let n = chatGets;
  bus.emit('mirror', { what: ['stream'] });
  await settle();
  assert.equal(chatGets, n, 'nothing lists b2: no read');
  // The inspector's turn list (the 'turns' host) lists b2.
  const host = ov.hosts().find((h) => h.name === 'turns');
  assert.ok(host && host.root, 'the turns host is registered');
  const li = doc.createElement('li');
  li.className = 'gi-turn';
  li.dataset.turnId = 'b2';
  host.root.appendChild(li);
  try {
    n = chatGets;
    pinList = only(A('exact'));
    bus.emit('mirror', { what: ['stream'] });
    await settle();
    assert.equal(chatGets, n + 1, 'one re-read');
    assert.equal(CP.chatPinOf('k16').row.answer.state, 'exact', 'placed without waiting for a frame');
  } finally {
    li.remove();
  }
  pinList = BASE();
  await CP.refreshChatPins();
  await settle();
});

// ── Escape, reveal, gone ────────────────────────────────────────────────────
test('Escape: the pin list closes on the first Escape (the shell\'s layer 4) while a detail view stays; the next pops the detail', async () => {
  bus.emit('chat:open', { view: 'diff', id: 't1' });
  await settle();
  assert.ok($('chat-views').classList.contains('cp-detail-open'));
  const pop = CP.openPinList(['k1'], 50, 50);
  assert.ok(pop.isConnected);
  sh.handleEscape();
  assert.ok(!pop.isConnected, 'the list closed');
  assert.ok($('chat-views').classList.contains('cp-detail-open'), 'the detail stays');
  sh.handleEscape();
  assert.ok(!$('chat-views').classList.contains('cp-detail-open'), 'the next Escape pops the detail');
  await chatOpen();
});

test('reveal: chat:open {view: turn} on another conversation follows it and scrolls the turn into view on its draw, then flashes', async () => {
  const at = shell.scrolls.length;
  bus.emit('chat:open', { view: 'turn', id: 'b2', conversation_id: 'cB' });
  await waitUntil(() => S.followed() === 'cB' && turnEl('b2'), { what: 'cB drawn' });
  await settle();
  const sc = shell.scrolls.slice(at).find((s) => s.el === turnEl('b2'));
  assert.ok(sc, 'the turn was scrolled into view');
  assert.equal(sc.arg && sc.arg.block, 'center');
  assert.ok(shown(markerOf('k16')), 'its pin drawn now');
  assert.ok(markerOf('k16').classList.contains(CP.FLASH_CLASS), 'flashed once');
  await follow('cA');
});

test('reveal: a turn the stream does not draw — the first chat:drawn of its conversation without it ends the reveal, so a later draw with it never scrolls (K.2-177 g4)', async () => {
  assert.equal(S.followed(), 'cA');
  const at = shell.scrolls.length;
  assert.equal(CP.revealTurn({ conversation_id: 'cA', turn_id: 't-late' }), false, 'not drawn: waiting');
  bus.emit('chat:drawn', { conversationId: 'cA', turnIds: ['t1', 't2'] });
  const fake = doc.createElement('article');
  fake.className = 'ct-turn';
  fake.dataset.turnId = 't-late';
  $('chat-stream').appendChild(fake);
  try {
    bus.emit('chat:drawn', { conversationId: 'cA', turnIds: ['t1', 't-late'] });
    await settle();
  } finally {
    fake.remove();
  }
  await settle();
  assert.equal(shell.scrolls.length, at, 'shell.scrolls gains no entry');
  // A later chat:open of another view ends a waiting reveal too.
  assert.equal(CP.revealTurn({ conversation_id: 'cA', turn_id: 't-later' }), false);
  bus.emit('chat:open', { view: 'chat' });
  await settle();
  const fake2 = doc.createElement('article');
  fake2.className = 'ct-turn';
  fake2.dataset.turnId = 't-later';
  $('chat-stream').appendChild(fake2);
  try {
    bus.emit('chat:drawn', { conversationId: 'cA', turnIds: ['t-later'] });
    await settle();
  } finally {
    fake2.remove();
  }
  await settle();
  assert.equal(shell.scrolls.length, at, 'still none');
});

test('Q4: pins whose conversation left the mirror: one ⌘K row \'Chat pins no longer in a chat (2)\' opening the list; none, no row', async () => {
  const gone = (id, q) => pin(id, { kind: 'turn', conversation_id: 'cGone', turn_id: 'g1', quote: { exact: q } }, A('unavailable'));
  pinList = [...QUIET(), gone('kg1', 'first gone quote'), gone('kg2', 'second gone quote')];
  await CP.refreshChatPins();
  await settle();
  await waitUntil(() => CP.chatPinOf('kg2'), { what: 'the gone pins' });
  sh.openPalette();
  await settle();
  await waitUntil(() => $('cmd-list').querySelector('.palette-item'), { what: 'the palette rows' });
  const rows = [...$('cmd-list').querySelectorAll('.palette-item')].filter((r) => /Chat pins no longer in a chat/.test(r.textContent));
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /Chat pins no longer in a chat \(2\)/);
  rows[0].dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await shell.tick();
  const pop = doc.querySelector('.chat-pin-list');
  assert.ok(pop, 'the pin list');
  assert.deepEqual([...pop.querySelectorAll('.pin-thread-row')].map((r) => r.dataset.id), ['kg1', 'kg2']);
  assert.deepEqual([...pop.querySelectorAll('.ptr-quote')].map((e) => e.textContent), ['first gone quote', 'second gone quote']);
  assert.deepEqual([...pop.querySelectorAll('.ptr-explain')].map((e) => e.textContent), [EXPLAIN.unavailable, EXPLAIN.unavailable]);
  CP.closePinList();
  pinList = QUIET();
  await CP.refreshChatPins();
  await settle();
  await waitUntil(() => !CP.chatPinOf('kg2'), { what: 'the gone pins removed' });
  sh.openPalette();
  await settle();
  await waitUntil(() => $('cmd-list').querySelector('.palette-item'), { what: 'the palette rebuilt' });
  const after = [...$('cmd-list').querySelectorAll('.palette-item')].filter((r) => /Chat pins no longer in a chat/.test(r.textContent));
  assert.equal(after.length, 0, 'none: no row');
  sh.handleEscape();   // the palette is open: this Escape closes it alone
  pinList = BASE();
  await CP.refreshChatPins();
  await settle();
});

test('a marker\'s click opens the pin list until an open is registered; registerChatPinActions re-registers the type with its create', async () => {
  // U434: comments.js (main.js's initComments) registers the chat pin's open
  // at boot, so the marker's click opens the comment's thread; with no open
  // registered (a registration naming none), the pin list.
  shell.click(markerOf('k1'));
  const thread = doc.querySelector('.pin-pop.pin-thread');
  assert.ok(thread && thread.dataset.id === 'k1', 'the open comments.js registered: the comment\'s thread');
  (await shell.importApp('comments.js')).closePinPop();
  CP.registerChatPinActions({});
  shell.click(markerOf('k1'));
  const pop = doc.querySelector('.chat-pin-list');
  assert.ok(pop, 'the default open');
  assert.deepEqual([...pop.querySelectorAll('.pin-thread-row')].map((r) => r.dataset.id), ['k1']);
  CP.closePinList();
  const opened = [];
  const off = CP.registerChatPinActions({ open: (ids) => opened.push(ids), create: () => {} });
  await settle();
  shell.click(markerOf('k1'));
  assert.deepEqual(opened, [['k1']]);
  assert.equal(ov.stats('chat').listening, false, 'nothing armed: no pointer listeners');
  off();
  await settle();
  const taps = [];
  const offTap = CP.onMarkerTap('turns', (ids) => taps.push(ids));
  offTap();
  assert.deepEqual(taps, []);
});

// ── the source checks ───────────────────────────────────────────────────────
test('source: no element id, no state literal outside the vocabulary, overlay exports only, no runs walker, no interval (one timer: the trailing re-read); no document builder serves it', async () => {
  const src = read('public/app/chat-pins.js');
  const code = stripComments(src);
  assert.ok(!/\.id\s*=[^=]/.test(code), 'no element id assigned');
  assert.ok(!/setAttribute\(\s*['"]id['"]/.test(code), 'no id attribute');
  for (const st of ['exact', 're-resolved', 'orphaned', 'hidden', 'masked', 'superseded', 'indexing', 'unavailable', 'provisional', 'placed', 'refused']) {
    const re = new RegExp(`['"\`]${st}['"\`]`, 'g');
    for (const m of code.matchAll(re)) {
      // The identity source map's run kind (markdown.js sourceMap's grammar), not a state.
      if (st === 'exact' && /len, len, $/.test(code.slice(Math.max(0, m.index - 10), m.index))) continue;
      // The page's visibility, not a state.
      if (st === 'hidden' && /visibilityState === $/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
      assert.ok(/stateOf\($/.test(code.slice(Math.max(0, m.index - 8), m.index)), `the state '${st}' spelled outside stateOf`);
    }
  }
  const imp = /import\s*\{([^}]*)\}\s*from\s*'\.\/overlay\.js'/.exec(code);
  assert.ok(imp, 'imports from overlay.js');
  for (const name of imp[1].split(',').map((s) => s.trim()).filter(Boolean)) {
    assert.equal(typeof ov[name], 'function', `${name} is an overlay export`);
  }
  assert.ok(!/createTreeWalker|SHOW_TEXT|nextNode\(/.test(code), 'no runs walker of its own: the offsets are anchors.resolveSource');
  assert.ok(/anchors\.resolveSource\(/.test(code) && /sourceMap\(text, \{ flavor: 'chat' \}\)/.test(code));
  assert.ok(!/\bsetInterval\(|requestAnimationFrame\(/.test(code), 'no interval, no frame');
  // The one timer is the trailing re-read's (U635): one bare setTimeout.
  assert.equal((code.match(/\bsetTimeout\(/g) || []).length, 1, 'one timer: the trailing re-read');
  assert.ok(!/\bmarks\b/.test(code), 'no `marks` Set: draw() keeps no detached marker div (K.2-177 g2)');
  assert.ok(!/\bfetch\(/.test(code), 'every request through http.js');
  const serverFiles = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(REPO, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js')) serverFiles.push(rel);
    }
  };
  walk('lib/server');
  for (const f of serverFiles) assert.ok(!read(f).includes('chat-pins'), `${f} never references chat-pins`);
  assert.ok(typeof anchors.resolveSource === 'function');
});

// ── the re-read interval (U635, corrective to U460) ─────────────────────────
// The chat pins restarted with a short interval through initChatPins's test
// seam, and back to the shipped REREAD_MIN_MS after.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function restartPins(opts) {
  CP.stopChatPins();
  const n = chatGets;
  CP.initChatPins(opts);
  await waitUntil(() => chatGets > n && CP.chatPins().length === pinList.length, { what: 'the chat pins re-read at init' });
  await settle();
}
async function backToShipped() {
  pinList = BASE();
  await restartPins();
}

test('the re-read interval: REREAD_MIN_MS is 1000; a burst of 20 stream changes over 250 ms re-reads at most once per interval, the trailing read after the burst (no indexing pin)', async () => {
  assert.equal(CP.REREAD_MIN_MS, 1000);
  const MS = 80;
  pinList = QUIET();
  await restartPins({ rereadMinMs: MS });
  const intervals = shell.intervals().length;
  await pause(MS + 20);
  const n = chatGets;
  const from = getTimes.length;
  const t0 = performance.now();
  let lastEmit = t0;
  for (let i = 0; i < 20; i++) {
    bus.emit('mirror', { what: ['stream'] });
    lastEmit = performance.now();
    await pause(12.5);
  }
  await waitUntil(() => getTimes.length > from && getTimes[getTimes.length - 1] >= lastEmit, { timeout: 2000, what: 'the trailing read after the burst' });
  await pause(MS * 2);
  await settle();
  const times = getTimes.slice(from);
  // At 627c5f53: one GET per change round trip (about 20 over the burst).
  assert.ok(times.length >= 2 && times.length <= Math.ceil((lastEmit - t0) / MS) + 2,
    `at most one GET per interval over the burst: ${times.length} GETs over ${Math.round(lastEmit - t0)} ms`);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] - times[i - 1] >= MS - 10, `GET ${i} started ${Math.round(times[i] - times[i - 1])} ms after the one before (>= ${MS})`);
  }
  const inFirst = times.filter((t) => t - times[0] < MS - 10).length;
  assert.equal(inFirst, 1, 'no GET beyond the burst\'s first within the interval');
  assert.ok(times[times.length - 1] >= lastEmit, 'the trailing read comes after the burst\'s last change');
  assert.equal(chatGets - n, times.length);
  assert.equal(shell.intervals().length, intervals, 'no interval added');
  await backToShipped();
});

test('the re-read interval: an indexing pin of the followed conversation re-reads at once on a stream change (no throttle)', async () => {
  pinList = [...QUIET().filter((p) => p.id !== 'k3'), pin('k3', { kind: 'item', turn_id: 't1', item_id: 'r1_t1', field: 'text' }, A('indexing'))];
  await restartPins({ rereadMinMs: 60000 });
  assert.ok(markerOf('k3').classList.contains('el-indexing'));
  const n = chatGets;
  pinList = QUIET();
  bus.emit('mirror', { what: ['stream'] });
  await settle();
  assert.equal(chatGets, n + 1, 'the index reason reads at once, inside the interval');
  assert.ok(markerOf('k3').classList.contains('el-hit'), 'placed');
  await backToShipped();
});

test('the re-read interval: a reset and a hello each make one GET and supersede a pending trailing read (none after the interval)', async () => {
  const MS = 300;
  pinList = QUIET();
  await restartPins({ rereadMinMs: MS });
  // A pending trailing read: a stream change inside the interval.
  await CP.refreshChatPins();
  let n = chatGets;
  bus.emit('mirror', { what: ['stream'] });
  bus.emit('mirror', { what: ['stream'] });
  await shell.tick();
  assert.equal(chatGets, n, 'a stream-only change inside the interval: no read yet');
  await shell.frame({ ...helloFrame(), type: 'reset', elements: [] });
  await settle();
  assert.equal(chatGets, n + 1, 'one GET for the reset, at once');
  await pause(MS + 100);
  await settle();
  assert.equal(chatGets, n + 1, 'the reset superseded the trailing read: none after the interval');
  // The same for a hello: the trailing read pending before it is gone. The
  // hello's hydrate may ask for its own stream re-read, at most one, after
  // the interval (K.2-187's 1..3 range).
  await CP.refreshChatPins();
  n = chatGets;
  bus.emit('mirror', { what: ['stream'] });
  await shell.tick();
  assert.equal(chatGets, n, 'pending again');
  // Half the interval on, so a trailing read the hello failed to supersede
  // would land half an interval after the hello's GET, not a whole one.
  await pause(MS / 2);
  assert.equal(chatGets, n, 'still pending');
  const helloAt = getTimes.length;
  await shell.frame(helloFrame());
  await settle();
  assert.equal(chatGets, n + 1, 'one GET for the hello, at once');
  await pause(MS + 100);
  await settle();
  assert.ok(chatGets - n >= 1 && chatGets - n <= 2, `the hello's GET, plus at most its hydrate's one trailing re-read: ${chatGets - n}`);
  if (chatGets - n === 2) {
    const gap = getTimes[helloAt + 1] - getTimes[helloAt];
    assert.ok(gap >= MS - 10, `the second GET is the hydrate's own trailing read, a whole interval after the hello's (${Math.round(gap)} ms), not the superseded one`);
  }
  await backToShipped();
});

test('the re-read interval: stopChatPins clears a pending trailing read; a hidden tab defers it as today; no interval', async () => {
  const MS = 150;
  pinList = QUIET();
  await restartPins({ rereadMinMs: MS });
  const intervals = shell.intervals().length;
  await CP.refreshChatPins();
  let n = chatGets;
  // The trailing timer itself, seen through the bare globals the module calls.
  const made = [];
  const cleared = new Set();
  const fired = new Set();
  const st = globalThis.setTimeout;
  const ct = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => {
    const h = st((...x) => { fired.add(h); fn(...x); }, ms, ...a);
    made.push({ h, ms });
    return h;
  };
  try {
    bus.emit('mirror', { what: ['stream'] });
  } finally {
    globalThis.setTimeout = st;
  }
  const timers = made.filter((m) => m.ms > 0 && m.ms <= MS);
  assert.ok(timers.length >= 1, 'a stream-only change inside the interval sets the trailing timer');
  await shell.tick();
  assert.equal(chatGets, n, 'pending');
  globalThis.clearTimeout = (h) => { cleared.add(h); return ct(h); };
  try {
    CP.stopChatPins();
  } finally {
    globalThis.clearTimeout = ct;
  }
  for (const { h } of timers) assert.ok(cleared.has(h) || fired.has(h), 'stopChatPins clears the pending trailing timer');
  await pause(MS + 100);
  assert.equal(chatGets, n, 'no GET after stop');
  // A timer stop left pending would fire into the next run: stopped and
  // started again inside the interval (the new run's own interval longer
  // than the pause), the new run makes its init GET and no other.
  await restartPins({ rereadMinMs: MS });
  await CP.refreshChatPins();
  bus.emit('mirror', { what: ['stream'] });
  await shell.tick();
  CP.stopChatPins();
  n = chatGets;
  CP.initChatPins({ rereadMinMs: MS * 4 });
  await waitUntil(() => chatGets > n, { what: 'the re-init\'s GET' });
  await settle();
  await pause(MS + 100);
  await settle();
  assert.equal(chatGets, n + 1, 'the re-init\'s one GET: stop left no trailing timer behind');
  await restartPins({ rereadMinMs: MS });
  // Hidden: the trailing read comes due while the tab is hidden and is owed
  // until it shows, as any read.
  await CP.refreshChatPins();
  n = chatGets;
  bus.emit('mirror', { what: ['stream'] });
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
  try {
    await pause(MS + 100);
    assert.equal(chatGets, n, 'hidden: no read');
  } finally {
    delete doc.visibilityState;
  }
  doc.dispatchEvent(new W.Event('visibilitychange'));
  await settle();
  assert.equal(chatGets, n + 1, 'visible again: the read it owed');
  await pause(MS + 100);
  assert.equal(chatGets, n + 1, 'and nothing more');
  assert.equal(shell.intervals().length, intervals, 'no interval');
  await backToShipped();
});

test('the re-read interval: a stream-only change heard while a read is in flight trails by the interval once that read lands (read()\'s again path)', async () => {
  const MS = 300;
  pinList = QUIET();
  await restartPins({ rereadMinMs: MS });
  let release;
  hold = new Promise((r) => { release = r; });
  const from = getTimes.length;
  const p = CP.refreshChatPins();
  await shell.tick();
  assert.equal(getTimes.length, from + 1, 'one read in flight');
  bus.emit('mirror', { what: ['stream'] });
  bus.emit('mirror', { what: ['stream'] });
  hold = null;
  release();
  await p;
  await settle();
  assert.equal(getTimes.length, from + 1, 'the stream-only again waits out the interval: no read at once');
  await waitUntil(() => getTimes.length === from + 2, { timeout: MS + 2000, what: 'the again path\'s trailing read' });
  const gap = getTimes[from + 1] - getTimes[from];
  assert.ok(gap >= MS - 10, `the trailing read starts an interval after the read in flight started (${Math.round(gap)} ms)`);
  await pause(MS + 100);
  await settle();
  assert.equal(getTimes.length, from + 2, 'one trailing read for the changes heard in flight, no more');
  await backToShipped();
});
