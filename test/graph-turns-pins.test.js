// The graph inspector's turn list as a chat-pin host (public/app/graph-turns.js,
// U433; annotation engine 3C.1, L2's third host): each turn row of #gi-turns
// is stamped data-turn-id and ends in one empty .gi-turn-pins slot, and the
// overlay's 'turns' host (overlay.js registerHost, its layer #el-layer-turns)
// draws every chat-comment pin on a turn — on the turn or on any of its items —
// as ONE marker on that row's slot, with the count; the marker's title is the
// pins' explain lines (chat-pins.js's draw). A tap opens the chat at the turn
// (bus chat:open {view: 'turn'}), or, for a row whose pins are all
// unavailable, the pin list with each pin's own quote and explain line.
//
// The real chrome (test-support/chrome-shell, booted once), with the overlay's
// box reads, frames and clock stubbed through initOverlay({rectOf, raf, now,
// clips}) as test/chat-pins.test.js does: jsdom does no layout, so the test
// owns the geometry (the inspector a box, #gi-turns a box inside it, each row's
// slot an 18 × 16 box down its right edge, the preview iframe far away unless a
// case moves it onto a badge).
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { EXPLAIN, VISIBLE } = require('../lib/core/anchor-states');
const { isReservedId } = require('../lib/server/domain/mounts');

const REPO = path.resolve(__dirname, '..');
const T = Date.UTC(2026, 9, 29, 10, 0, 0);

const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: T - 60000 },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: T - 30000 },
];
const head = (over) => ({ conversation_id: 'c9', session_id: 's9', kind: 'prompt', author: 'user', status: 'done',
  counts: { items: 3, tools: 0, tool_errors: 0, agents: 0, tasks: 0, edits: 0 }, tool_names: [], groups: [], code: null,
  ...over });
// n2: three turns — tA with three pins, tB with none, tC gone from the chat
// history carrying one (unavailable) pin. Given out of seq order.
const N2_TURNS = [
  { id: 'tC', conversation_id: 'c9', session_id: 's9', seq: 3, role: 'commit', unavailable: true },
  head({ id: 'tA', seq: 1, role: 'folded', started_at: T - 20000, duration_ms: 3000, prompt: { preview: 'the first ask', origin: 'terminal' } }),
  head({ id: 'tB', seq: 2, role: 'folded', started_at: T - 10000, duration_ms: 2000, prompt: { preview: 'the second ask', origin: 'terminal' } }),
];

const A = (state) => ({ state, visible: VISIBLE[state], explain: EXPLAIN[VISIBLE[state]] });
function pin(id, anchor, answer = A('exact')) {
  const a = { v: 1, conversation_id: 'c9', session_id: 's9', quote: { exact: `quote of ${id}`, prefix: '', suffix: '' }, ...anchor };
  return { id, v: 1, type: 'chat-comment', schema: 'chat-comment@1', seq: 1, shared: true, replies: [],
    text: `SECRET COMMENT TEXT ${id}`, anchor: a, anchor_label: `on ${id}`, ...answer };
}
const PINS = [
  pin('kA1', { kind: 'item', turn_id: 'tA', item_id: 'r_tA', field: 'text' }),
  pin('kA2', { kind: 'item-range', turn_id: 'tA', item_id: 'r_tA', field: 'text', pos: { start: 0, end: 4 } }, A('superseded')),
  pin('kA3', { kind: 'turn', turn_id: 'tA' }),
  pin('kC1', { kind: 'item', turn_id: 'tC', item_id: 'r_tC', field: 'text', quote: { exact: 'a reply that is gone' } }, A('unavailable')),
  pin('kZ1', { kind: 'turn', turn_id: 'tz' }),   // a turn this node does not list: never in the turn list
];

let shell, doc, $, bus, S, ov, CP, gv, gt;
let level = 'local';
let rev = 100;

const snapshot = () => ({ v: 1, enabled: true, now: Date.now(), rev: ++rev, content: level !== 'basic',
  access: { level, remote: level === 'basic' }, capabilities: {}, primary: null, aggregate: { state: 'idle' },
  conversations: [], tasks: [], asks: [] });

// ── the fake scheduler, clock and geometry ──────────────────────────────────
const queue = [];
let clock = 0;
const fakeRaf = (fn) => { queue.push(fn); return queue.length; };
function flush(max = 20000) {
  let n = 0;
  while (queue.length && n < max) { queue.shift()(clock); n++; }
  assert.ok(n < max, 'the overlay settles to no pending frame');
}
const FAR = { left: -5000, top: -5000, width: 10, height: 10 };
const INSP = { left: 900, top: 60, width: 340, height: 680 };
const TURNS = { left: 910, top: 300, width: 320, height: 300 };
const slotBox = (i) => ({ left: 1200, top: 320 + i * 40, width: 18, height: 16 });
const geo = { frame: null };
const rect = (r) => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height });
function boxOfEl(el) {
  if (!el || el.nodeType !== 1) return FAR;
  if (el.id === 'gv-inspector') return INSP;
  if (el.id === 'gi-turns') return TURNS;
  if (el.localName === 'iframe') return (el.classList.contains('gv-preview-frame') && geo.frame) || FAR;
  if (el.classList.contains('gi-turn-pins')) {
    const rows = [...doc.querySelectorAll('#gi-turns li.gi-turn')];
    const i = rows.indexOf(el.parentNode);
    return i < 0 ? FAR : slotBox(i);
  }
  return FAR;
}
const rectOf = (x) => {
  clock += 0.01;
  return rect(x && x.startContainer ? FAR : boxOfEl(x));
};
const clips = (el) => el.id === 'gv-inspector';

async function settle(n = 4) {
  for (let i = 0; i < n; i++) {
    await shell.tick();
    flush();
  }
}
const layer = () => doc.getElementById('el-layer-turns');
const markers = () => [...layer().querySelectorAll('.el-marker')];
const shown = (m) => !!m && m.style.display !== 'none';
const shownMarkers = () => markers().filter(shown);
const rowOf = (tid) => doc.querySelector(`#gi-turns li.gi-turn[data-turn-id="${tid}"]`);
const markerOn = (tid) => {
  const slot = rowOf(tid) && rowOf(tid).querySelector('.gi-turn-pins');
  return markers().find((m) => m._group && m._group.el === slot) || null;
};
const chatGets = () => shell.calls.filter((c) => c.url.startsWith('/api/elements') && c.url.includes('type=chat-comment')).length;
const nodeReads = () => shell.calls.filter((c) => c.url.startsWith('/api/mirror/node')).length;

async function setLevel(next) {
  level = next;
  const want = rev + 1;
  await shell.frame(helloFrame({ active: 'n2' }));
  await waitUntil(() => S.mirror.rev >= want && S.mirror.access.level === next, { timeout: 2000, what: `access level ${next}` });
  await settle();
}
async function openOn(id) {
  if (!gv.isOverlayOpen()) await gv.openOverlay();
  const n = nodeReads();
  await gv.selectNode(id);
  await waitUntil(() => nodeReads() > n && rowOf('tC'), { timeout: 2000, what: `the turn list of ${id}` });
  await settle();
}
async function closeGraph() {
  if (gv.isOverlayOpen()) gv.closeOverlay();
  await settle();
}

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/graph': () => ({ nodes: NODES.map((n) => ({ ...n })), active: 'n2' }),
      '/api/graph/node/*': (url) => {
        const id = decodeURIComponent(url.split('?')[0].split('/').pop());
        const n = NODES.find((x) => x.id === id);
        // n2 has a block, so the inspector draws its preview iframe.
        return { ...n, author: 'claude', trigger: { message: `the turn at ${n.label}` },
          mounts: id === 'n2' ? [{ id: 'm1', html: '<p>x</p>' }] : [], store: {} };
      },
      '/api/graph/diff': { mounts: { added: [], changed: [], removed: [] } },
      '/api/mirror': () => snapshot(),
      '/api/mirror/node/*': (url) => (url.split('?')[0].endsWith('/n2')
        ? { node: { id: 'n2', label: 'n1.1' }, turns: N2_TURNS, rev: 7 } : { node: { id: 'n1', label: 'n1.0' }, turns: [], rev: 7 }),
      '/api/mirror/nodes': { nodes: {}, rev: 7 },
      '/api/elements': (url) => (url.includes('type=chat-comment')
        ? { elements: PINS.map((p) => ({ ...p })), next_cursor: 9 } : { elements: [], next_cursor: 0 }),
    },
  });
  doc = shell.document;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  ov = await shell.importApp('overlay.js');
  CP = await shell.importApp('chat-pins.js');
  gv = await shell.importApp('graph-view.js');
  gt = await shell.importApp('graph-turns.js');
  gt.initGraphTurns();   // main.js did; idempotent
  ov.initOverlay({ rectOf, raf: fakeRaf, now: () => clock, clips });
  await setLevel('local');
  await waitUntil(() => CP.chatPins().length === PINS.length, { timeout: 2000, what: 'the chat pins' });
  await openOn('n2');
});

after(async () => {
  await shell.restore();
});

test('the turns host: over #gv-inspector at --z-turns-pins, the chat kinds, its layer #el-layer-turns', () => {
  const h = ov.hosts().find((x) => x.name === 'turns');
  assert.ok(h, 'the turns host is registered');
  assert.equal(h.root, $('gv-inspector'));
  assert.equal(h.rung, '--z-turns-pins');
  assert.deepEqual(h.kinds, ['turn', 'item', 'item-range', 'diff-line']);
  assert.equal(h.layer, 'el-layer-turns');
  assert.equal(layer().parentNode, doc.body, 'a body-level layer');
  assert.equal(ov.hosts().filter((x) => x.name === 'turns').length, 1, 'one registration (initGraphTurns is idempotent)');
  assert.deepEqual({ ...gt.TURNS_GLYPH }, { dx: 0, dy: 0, w: 18, h: 16 });
});

test('each turn row carries data-turn-id and one .gi-turn-pins slot (an unavailable row too); rows stay non-buttons', () => {
  const rows = [...doc.querySelectorAll('#gi-turns li.gi-turn')];
  assert.deepEqual(rows.map((r) => r.dataset.turnId), ['tA', 'tB', 'tC'], 'seq order, each stamped');
  for (const r of rows) {
    const slots = r.querySelectorAll('.gi-turn-pins');
    assert.equal(slots.length, 1, `${r.dataset.turnId}: one slot`);
    assert.equal(r.lastElementChild, slots[0], 'at the row\'s end');
    assert.equal(slots[0].childNodes.length, 0, 'empty: the marker is the overlay\'s');
    assert.equal(slots[0].id, '', 'a class, never an id');
    assert.equal(r.querySelector('button, a'), null, 'not a link into the chat');
  }
  assert.ok(rowOf('tC').classList.contains('gi-turn-gone'));
  assert.equal(rowOf('tC').querySelector('.gi-turn-text').textContent, 'turn no longer in the chat history', 'its text unchanged');
  assert.equal(rowOf('tA').querySelector('.gi-turn-text').textContent, 'the first ask');
  for (const id of ['gv-inspector', 'overlay', 'gi-turns', 'el-layer-turns']) assert.ok(isReservedId(id), `#${id} reserved`);
});

test('the first row shows ONE marker with count 3, titled with its pins\' explain lines; the second none', () => {
  const m = markerOn('tA');
  assert.ok(m, 'a marker on tA\'s slot');
  assert.ok(shown(m), 'drawn');
  assert.deepEqual(m.dataset.elIds.split(' ').sort(), ['kA1', 'kA2', 'kA3'], 'the item, passage and turn pins group on the row');
  assert.equal(m.dataset.type, 'chat-comment');
  assert.ok(m.classList.contains('pin-marker'), 'chat-comment\'s own draw');
  assert.equal(m.querySelector('.pin-count').textContent, '3', 'glyph and count');
  assert.deepEqual(m.title.split('\n').sort(), [EXPLAIN.placed, EXPLAIN.superseded].sort(), 'the explain lines, each once');
  assert.doesNotMatch(m.title + m.textContent, /SECRET COMMENT TEXT/, 'never a pin\'s comment text');
  assert.equal(m.style.width, '18px');
  assert.equal(m.style.height, '16px');
  assert.equal(m.style.left, `${slotBox(0).left}px`, 'its point the slot\'s top-left');
  assert.equal(m.style.top, `${slotBox(0).top}px`);
  assert.equal(markerOn('tB'), null, 'tB lists no pin: no marker');
  assert.equal(markers().filter((x) => (x.dataset.elIds || '').includes('kZ1')).length, 0, 'a turn the node does not list: unplaced');
  assert.equal(shownMarkers().length, 2, 'tA\'s and tC\'s, nothing else');
});

test('the unavailable turn\'s row carries its pin; a tap opens the pin list with the pin\'s own quote and explain line, and no chat:open', async () => {
  const m = markerOn('tC');
  assert.ok(m && shown(m), 'tC\'s marker drawn');
  assert.equal(m.dataset.elIds, 'kC1');
  assert.ok(m.classList.contains('el-unavailable'), 'the state\'s class');
  assert.equal(m.title, EXPLAIN.unavailable);
  const opens = [];
  const off = bus.on('chat:open', (d) => opens.push(d));
  try {
    m.dispatchEvent(new shell.window.MouseEvent('click', { bubbles: true, clientX: 1200, clientY: 400 }));
    await settle();
    const pop = doc.querySelector('.chat-pin-list');
    assert.ok(pop, 'the pin list opened');
    const rows = [...pop.querySelectorAll('.pin-thread-row')];
    assert.deepEqual(rows.map((r) => r.dataset.id), ['kC1']);
    assert.equal(rows[0].querySelector('.ptr-quote').textContent, 'a reply that is gone', 'its own quote (L5 d)');
    assert.equal(rows[0].querySelector('.ptr-explain').textContent, EXPLAIN.unavailable, 'its explain line');
    assert.equal(pop.style.zIndex, 'var(--z-glance)', 'raised over the graph, at the glance\'s rung');
    assert.deepEqual(opens, [], 'no turn to open: no chat:open');
    assert.ok(gv.isOverlayOpen(), 'the graph stays');
  } finally {
    off();
    CP.closePinList();
  }
});

test('never over the inspector\'s preview iframe: a badge its box meets is not drawn; no marker in a frame\'s document', async () => {
  const fr = doc.querySelector('#gv-inspector iframe.gv-preview-frame');
  assert.ok(fr, 'the inspector draws its preview iframe');
  assert.equal(fr.getAttribute('sandbox'), gv.PREVIEW_SANDBOX);
  try {
    geo.frame = { left: slotBox(0).left - 4, top: slotBox(0).top - 4, width: 40, height: 24 };
    ov.requestDraw();
    await settle();
    assert.ok(!shown(markerOn('tA')), 'the badge meeting the frame is not drawn');
    assert.ok(shown(markerOn('tC')), 'the one clear of it still is');
    assert.ok(ov.stats('turns').frame_hidden >= 1, 'counted as kept off a frame');
  } finally {
    geo.frame = null;
    ov.requestDraw();
    await settle();
  }
  assert.ok(shown(markerOn('tA')), 'drawn again once the frame is clear');
  for (const m of doc.querySelectorAll('.el-marker')) {
    assert.equal(m.ownerDocument, doc, 'every marker in the chrome\'s document');
    assert.equal(m.closest('iframe'), null);
  }
  for (const f of doc.querySelectorAll('iframe')) {
    let inner = null;
    try { inner = f.contentDocument; } catch { inner = null; }
    if (inner) assert.equal(inner.querySelector('.el-marker'), null, 'no marker inside a frame');
  }
  assert.ok(layer().compareDocumentPosition(fr) & shell.window.Node.DOCUMENT_POSITION_PRECEDING, 'the layer is not inside the frame');
});

test('no canvas marker: the turns host adds no node mark to the graph', () => {
  assert.equal(doc.querySelector('#graph-svg .el-marker, #graph-svg .gi-turn-pins'), null);
  const src = fs.readFileSync(path.join(REPO, 'public/app/graph-turns.js'), 'utf8');
  assert.equal([...src.matchAll(/setNodeMarker\(/g)].length, 1, 'the one ↶ producer, unchanged');
  assert.match(src, /setNodeMarker\(\{ mark, refresh \}\)/);
});

test('a tap on the first row\'s marker closes the graph and emits chat:open {view: \'turn\', id, conversation_id} exactly once', async () => {
  const m = markerOn('tA');
  assert.ok(shown(m));
  const opens = [];
  const off = bus.on('chat:open', (d) => opens.push({ ...d }));
  try {
    m.dispatchEvent(new shell.window.MouseEvent('click', { bubbles: true, clientX: 1200, clientY: 320 }));
    await settle();
  } finally { off(); }
  assert.deepEqual(opens, [{ view: 'turn', id: 'tA', conversation_id: 'c9' }], 'once, at the turn');
  assert.ok(!gv.isOverlayOpen(), 'the graph closed first: the chat opens under it');
  assert.equal(doc.querySelector('.chat-pin-list'), null, 'no pin list');
});

test('closing the graph leaves #el-layer-turns empty; reopening on the node redraws', async () => {
  await openOn('n2');
  assert.equal(shownMarkers().length, 2, 'drawn while the graph is open');
  await closeGraph();
  assert.equal(markers().length, 0, 'closed: no marker in the layer');
  await openOn('n2');
  assert.equal(shownMarkers().length, 2, 'reopened: drawn again');
  assert.equal(markerOn('tA').querySelector('.pin-count').textContent, '3');
  // Another node: its section has none of these turns.
  const n = nodeReads();
  await gv.selectNode('n1');
  await waitUntil(() => nodeReads() > n && $('gi-turns') && !rowOf('tA'), { timeout: 2000, what: 'n1\'s turn list' });
  await settle();
  assert.equal(shownMarkers().length, 0, 'n1 lists no turn: nothing placed');
  await openOn('n2');
  assert.equal(shownMarkers().length, 2);
});

test('below the read level: no row, slot or marker, and no request added', async () => {
  await closeGraph();
  await setLevel('basic');
  try {
    await settle();
    const nodes0 = nodeReads();
    const chats0 = chatGets();
    await gv.openOverlay();
    await gv.selectNode('n2');
    await shell.tick(80);
    await settle();
    assert.equal($('gi-turns'), null, 'no turn list');
    assert.equal(doc.querySelectorAll('.gi-turn, .gi-turn-pins').length, 0, 'no row, no slot');
    assert.equal(markers().length, 0, 'no marker');
    assert.ok(ov.hosts().some((x) => x.name === 'turns'), 'the host stays registered');
    assert.equal(nodeReads(), nodes0, 'no /api/mirror/node read');
    assert.equal(chatGets(), chats0, 'no chat pin read');
  } finally {
    await closeGraph();
    await setLevel('local');
    await waitUntil(() => CP.chatPins().length === PINS.length, { timeout: 2000, what: 'the chat pins again' });
  }
  await openOn('n2');
  assert.equal(shownMarkers().length, 2, 'back at read: drawn');
});

test('stopGraphTurns unregisters the host and its layer; initGraphTurns registers them again', async () => {
  await closeGraph();
  gt.stopGraphTurns();
  try {
    assert.equal(ov.hosts().some((x) => x.name === 'turns'), false);
    assert.equal(layer(), null, 'the layer is gone');
  } finally {
    gt.initGraphTurns();
  }
  assert.ok(ov.hosts().some((x) => x.name === 'turns'));
  await openOn('n2');
  assert.equal(shownMarkers().length, 2);
});

test('the source: no request, no timer, no element id, and nothing drawn inside chat-pins\' module', () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/graph-turns.js'), 'utf8');
  assert.equal([...src.matchAll(/\bfetch\(/g)].length, 1, 'the one fetch (getJson), as before');
  assert.equal([...src.matchAll(/\bsetTimeout\(/g)].length, 1, 'the one-shot marks refresh, as before');
  assert.equal([...src.matchAll(/\bsetInterval\(|requestAnimationFrame\(/g)].length, 0);
  assert.match(src, /registerHost\(TURNS_HOST,/);
  assert.match(src, /onMarkerTap\(TURNS_HOST, onTurnsTap\)/);
  const css = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');
  assert.match(css, /#gi-turns \.gi-turn-pins \{[^}]*width: 18px; height: 16px;/, 'the slot is the badge\'s size');
  assert.match(css, /#el-layer-turns \.el-marker/);
});

test('a pin of another conversation naming a listed turn id is not placed on its row; a mixed group with an unavailable pin still opens the chat', async () => {
  await openOn('n2');
  const other = pin('kX1', { kind: 'turn', turn_id: 'tA', conversation_id: 'c-other' });
  const gone = pin('kA4', { kind: 'item', turn_id: 'tA', item_id: 'r_tA2', field: 'text' }, A('unavailable'));
  CP.applyChatPin(other);
  CP.applyChatPin(gone);
  const opens = [];
  const off = bus.on('chat:open', (d) => opens.push({ ...d }));
  try {
    ov.requestDraw();
    await settle();
    const m = markerOn('tA');
    assert.ok(shown(m));
    assert.deepEqual(m.dataset.elIds.split(' ').sort(), ['kA1', 'kA2', 'kA3', 'kA4'],
      'the row\'s own conversation only: c-other\'s pin on a same-named turn is not on it');
    m.dispatchEvent(new shell.window.MouseEvent('click', { bubbles: true, clientX: 1200, clientY: 320 }));
    await settle();
    assert.deepEqual(opens, [{ view: 'turn', id: 'tA', conversation_id: 'c9' }], 'not all unavailable: the chat at the turn');
    assert.equal(doc.querySelector('.chat-pin-list'), null, 'no pin list');
  } finally {
    off();
    CP.dropChatPin('kX1');
    CP.dropChatPin('kA4');
    CP.closePinList();
    await closeGraph();
  }
});
