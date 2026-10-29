// Tranche 3 of the annotation engine in the LIVE chrome, every host at once
// (U460; PLAN.md §4, RULED REQ@chat-pin-hosts L2 a, REQ@visible-states L4 a,
// M1–M3 a): the real public/index.html and public/app module graph
// (test-support/chrome-shell, booted once in before()), with a stub daemon
// behind its routes and the overlay's box reads, frames and clock stubbed
// through initOverlay({rectOf, raf, now, clips}) — jsdom does no layout, so the
// test owns the geometry (test/chat-pins.test.js's model of the chat stream,
// test/graph-turns-pins.test.js's of the inspector, and named page boxes).
//
// Pinned here, in order, in ONE shell where the page, the chat and the
// inspector's turn list are all registered hosts:
//   - every host is registered at once (page, chat, turns), each its own layer;
//   - the chat layer draws a pin of each kind (a turn, a passage, a tool card,
//     a diff line) in the dock docked and windowed, in the sheet at 390 px wide,
//     and in the graph inspector's turn list; no drawn marker outside its
//     well's clip, and never over the awaiting card's frame;
//   - the six visible states each draw their one line;
//   - Space with nothing focused puts the comment tool down and picks it up;
//     on a focused pane button it does not;
//   - Send to Claude in a highlight's tray posts once;
//   - a heading pin's glyph sits in the markdown item's margin;
//   - no script-error frame went to the daemon, and no interval was armed.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame, DEFAULT_ROUTES } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { EXPLAIN, VISIBLE } = require('../lib/core/anchor-states');

const T0 = Date.UTC(2026, 9, 29, 9, 0, 0);
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };

let shell, W, doc, $, bus, S, ov, CP, dock, sheet, gv, gt, tools, comments, anchors, M;
let rev = 2000;
let intervalsAtBoot = 0;

class StubIO {
  constructor(cb) { this.cb = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

// ── the conversation (cA) and its pins ──────────────────────────────────────
function snapshot() {
  return { v: 1, enabled: true, now: Date.now(), rev: ++rev, content: true, access: { level: 'local', remote: false },
    capabilities: {}, primary: 'cA', aggregate: { state: 'idle' },
    conversations: [{ id: 'cA', rev: 1, headless: false, counts: ZERO, live: { state: 'idle', since: T0, last_activity_at: T0 } }],
    tasks: [], asks: [] };
}
const prompt = (tid, text) => ({ id: `p_${tid}`, kind: 'prompt', text, origin: 'human' });
const reply = (id, text) => ({ id, kind: 'reply', text });
const tool = (id, label) => ({ id, kind: 'tool_call', tool: 'Read', tool_kind: 'Read', label, call: label, status: 'done',
  started_at: T0, ended_at: T0 + 1000, duration_ms: 1000 });
function turn(id, seq, items, extra = {}) {
  return {
    id, rev: ++rev, conversation_id: 'cA', session_id: 's1', seq, kind: 'prompt', author: 'user', status: 'done',
    started_at: T0 + seq * 60000, ended_at: T0 + seq * 60000 + 5000, duration_ms: 5000,
    counts: { items: items.length, tools: items.filter((i) => i.kind === 'tool_call').length, tool_errors: 0, agents: 0, tasks: 0, edits: 0 },
    tool_names: [], groups: [], node: null, folded_into: null, code: null, ...extra,
    items: items.map((it, i) => ({ turn_id: id, seq: seq * 1000 + i, ts: T0 + seq * 60000 + i, rev, ...it })),
  };
}
const R1 = "I'll look at **the rail** first.";
const TURNS = [
  turn('t1', 1, [prompt('t1', 'Fix the rail please'), reply('r1_t1', R1), tool('tu_t1', 'Read · app.css')]),
  turn('t2', 2, [prompt('t2', 'Second ask'), reply('r_t2', 'Answered.')], { superseded: true }),
  turn('t4', 3, [prompt('t4', 'Masked'), reply('r_t4', 'the token is ⟨masked⟩ here')]),
  turn('t5', 4, [prompt('t5', 'Indexing'), reply('r_t5', 'still reading')]),
];
const DIFF = {
  v: 1, turn_id: 't1', status: 'ready', totals: { files: 1, additions: 1, deletions: 0 },
  files: [{ path: 'a.txt', status: 'M', additions: 1, deletions: 0 }],
  patch: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n line1\n+added\n line2\n',
};
const A = (state) => ({ state, visible: VISIBLE[state], explain: EXPLAIN[VISIBLE[state]] });
function chatPin(id, anchor, answer = A('exact')) {
  const a = { v: 1, conversation_id: 'cA', session_id: 's1', quote: { exact: `quote of ${id}`, prefix: '', suffix: '' }, label: `label ${id}`, ...anchor };
  return { id, v: 1, type: 'chat-comment', schema: 'chat-comment@1', seq: 1, shared: true, replies: [],
    text: `SECRET CHAT TEXT ${id}`, anchor: a, anchor_label: `on ${id}`, ...answer };
}
const at15 = R1.indexOf('the rail');
const CHAT_PINS = [
  chatPin('k1', { kind: 'turn', turn_id: 't1' }),
  chatPin('k5', { kind: 'item', turn_id: 't1', item_id: 'tu_t1' }),
  chatPin('k6', { kind: 'item-range', turn_id: 't1', item_id: 'r1_t1', field: 'text',
    quote: { exact: 'the rail', prefix: 'look at **', suffix: '** first' }, pos: { start: at15, end: at15 + 8 } },
  { ...A('exact'), how: 'unique', at: { item_id: 'r1_t1', field: 'text', start: at15, end: at15 + 8 } }),
  chatPin('k7', { kind: 'diff-line', turn_id: 't1', file: 'a.txt', side: 'new', line: 2, quote: { exact: '+added' } },
    { ...A('exact'), how: 'line', at: { file: 'a.txt', side: 'new', line: 2 } }),
  chatPin('k9', { kind: 'turn', turn_id: 't2' }, A('superseded')),
  chatPin('k10', { kind: 'item', turn_id: 't4', item_id: 'r_t4', field: 'text' }, A('masked')),
  chatPin('k11', { kind: 'item', turn_id: 't5', item_id: 'r_t5', field: 'text' }, A('indexing')),
  chatPin('k12', { kind: 'turn', turn_id: 't4' }, { ...A('unavailable'), rule: 'gone' }),
  chatPin('k14', { kind: 'turn', turn_id: 't5' }, { state: 'provisional', visible: 'refused', explain: EXPLAIN.refused }),
];
const SIX = { placed: 'k1', refused: 'k14', superseded: 'k9', masked: 'k10', indexing: 'k11', unavailable: 'k12' };

// The page: a pane with a lead line and a button, and a markdown item.
const PANE = { id: 'p1', target: 'main', params: {}, html: '<p class="lead">lead of p1 here</p><button class="go">Go</button>' };
const MD_TEXT = 'Intro text here.\n\n## Margin heading\n\nBody text under it.';
const MD_ORDER = ['p1', 'md-sec'];

// The stub daemon's element records.
const highlights = new Map();
let pagePins = [];
const sends = [];
function elementsRoute(url) {
  if (url.includes('type=chat-comment')) return { elements: CHAT_PINS.map((p) => ({ ...p })), next_cursor: 9 };
  if (url.includes('type=highlight')) return { elements: [...highlights.values()], next_cursor: 9 };
  if (url.includes('type=comment')) return { elements: pagePins.map((p) => ({ ...p })), next_cursor: 9 };
  return { elements: [], next_cursor: 0 };
}
function elementRoute(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const parts = new URL(url, 'http://x').pathname.split('/');
  if (method === 'POST' && parts[parts.length - 1] === 'send') {
    const id = decodeURIComponent(parts[parts.length - 2]);
    sends.push(id);
    const rec = highlights.get(id);
    return { ok: true, element: rec ? { ...rec, shared: true } : { id }, item: { id: `q${sends.length}` } };
  }
  return { ok: true };
}

// ── the fake scheduler, clock and geometry ──────────────────────────────────
const rafQ = [];
let clock = 0;
const fakeRaf = (fn) => { rafQ.push(fn); return rafQ.length; };
function flush(max = 20000) {
  let n = 0;
  while (rafQ.length && n < max) { rafQ.shift()(clock); n++; }
  assert.ok(n < max, 'the overlay settles to no pending frame');
  return n;
}
const VIEW = { left: 0, top: 0, width: 1280, height: 800 };
const FAR = { left: -5000, top: -5000, width: 10, height: 10 };
const TURN_H = 100;
const INSP = { left: 900, top: 60, width: 340, height: 680 };
const GI_TURNS = { left: 910, top: 300, width: 320, height: 300 };
const POS = {};
const geo = { stream: { left: 860, top: 120, width: 400, height: 560 }, frame: null };
const rect = (r) => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height });
function boxOfEl(el) {
  if (!el || el.nodeType !== 1) return FAR;
  const key = el.dataset && el.dataset.pin;
  if (key && POS[key]) return POS[key];
  if (el.id === 'gv-inspector') return INSP;
  if (el.id === 'gi-turns') return GI_TURNS;
  if (el.classList.contains('gi-turn-pins')) {
    const rows = [...doc.querySelectorAll('#gi-turns li.gi-turn')];
    const i = rows.indexOf(el.parentNode);
    return i < 0 ? FAR : { left: 1200, top: 320 + i * 40, width: 18, height: 16 };
  }
  const st = geo.stream;
  if (el.id === 'chat-stream' || el.id === 'chat-views') return st;
  if (el.localName === 'iframe') return (el.closest('#chat-awaiting') && geo.frame) || FAR;
  const body = el.closest('.cp-dbody');
  if (body) {
    if (el === body) return st;
    const k = [...body.querySelectorAll('*')].indexOf(el);
    return { left: st.left + 20, top: st.top + 30 + k * 18, width: 300, height: 16 };
  }
  const t = el.closest('.ct-turn');
  const stream = $('chat-stream');
  if (t && stream && stream.contains(t)) {
    const i = [...stream.querySelectorAll('.ct-turn')].indexOf(t);
    const base = st.top + 10 + i * TURN_H;
    if (el === t) return { left: st.left + 12, top: base, width: 370, height: TURN_H - 10 };
    const k = [...t.querySelectorAll('*')].indexOf(el);
    return { left: st.left + 30, top: base + 6 + (k % 16) * 5, width: 300, height: 12 };
  }
  if (stream && (stream.contains(el) || ($('chat-views') && $('chat-views').contains(el)))) return FAR;
  return VIEW;
}
function rectOf(x) {
  clock += 0.01;
  if (x && x.startContainer) {
    const sc = x.startContainer;
    const at = sc.nodeType === 1 ? sc : sc.parentNode;
    const named = at && at.closest ? at.closest('[data-pin]') : null;
    if (named && POS[named.dataset.pin]) return rect(POS[named.dataset.pin]);
    const stream = $('chat-stream');
    if (stream && stream.contains(at)) { const r = boxOfEl(at); return rect({ ...r, left: r.left + 8 }); }
    return rect({ left: 200, top: 200, width: 40, height: 16 });
  }
  return rect(boxOfEl(x));
}
const clips = (el) => el.id === 'chat-stream' || el.id === 'gv-inspector' || (el.classList && el.classList.contains('cp-dbody'));

async function settle(n = 4) {
  for (let i = 0; i < n; i++) {
    await shell.tick();
    flush();
  }
}
const chatLayer = () => doc.getElementById('el-layer-chat');
const markerIn = (layer, id) => [...layer.querySelectorAll('.el-marker')].find((m) => (m.dataset.elIds || '').split(' ').includes(id)) || null;
const markerOf = (id) => markerIn(chatLayer(), id);
const pageMarker = (id) => markerIn(doc.getElementById('el-layer'), id);
const shown = (m) => !!m && m.style.display !== 'none';
const turnEl = (id) => $('chat-stream').querySelector(`.ct-turn[data-turn-id="${id}"]`);
const itemElOf = (id) => $('chat-stream').querySelector(`[data-item-id="${id}"]`);
const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;

// Every drawn marker of `layer` has its anchor point inside `well` ∩ the viewport.
function insideClip(layer, well, where) {
  const clip = { left: Math.max(0, well.left), top: Math.max(0, well.top),
    right: Math.min(W.innerWidth, well.left + well.width), bottom: Math.min(W.innerHeight, well.top + well.height) };
  let drawn = 0;
  for (const m of layer.querySelectorAll('.el-marker')) {
    if (!shown(m)) continue;
    drawn++;
    const x = parseFloat(m.style.left);
    const y = parseFloat(m.style.top);
    assert.ok(x >= clip.left && x < clip.right && y >= clip.top && y < clip.bottom, `${where}: ${m.dataset.elIds} inside the clip (${x}, ${y})`);
  }
  return drawn;
}
// The four kinds on their items, each drawn el-hit in the chat layer.
function checkKinds(where) {
  const g = (id) => markerOf(id) && markerOf(id)._group;
  assert.equal(g('k1').el, turnEl('t1'), `${where}: a turn pin on the turn root`);
  assert.ok(g('k5').el === itemElOf('tu_t1') || g('k5').el.localName === 'summary', `${where}: a tool card pin on its card (or its closed group's summary)`);
  assert.equal(g('k6').range && g('k6').range.toString(), 'the rail', `${where}: the passage, a Range through the chat sourceMap`);
  for (const id of ['k1', 'k5', 'k6']) {
    assert.ok(shown(markerOf(id)), `${where}: ${id} drawn`);
    assert.ok(markerOf(id).classList.contains('el-hit'), `${where}: ${id} placed`);
  }
  assert.ok(insideClip(chatLayer(), geo.stream, where) >= 3, `${where}: drawn inside the clip`);
}
async function openDiff() {
  bus.emit('chat:open', { view: 'diff', id: 't1' });
  await waitUntil(() => doc.querySelector('#chat-detail .dv-diffview[data-turn-id="t1"] details.dv-file'), { what: 'the diff view' });
  doc.querySelector('#chat-detail details.dv-file[data-path="a.txt"]').open = true;
  await settle();
}
async function chatOpen() {
  if (!dock.isChatOpen()) bus.emit('chat:open', { view: 'chat' });
  await settle();
}

before(async () => {
  globalThis.IntersectionObserver = StubIO;
  shell = await bootShell({
    routes: {
      '/api/mirror': () => snapshot(),
      '/api/mirror/conversations/*': (url) => {
        const turns = url.includes('before=') ? [] : TURNS;
        return { conversation_id: 'cA', turns, next_before: null, total: turns.length, rev: ++rev };
      },
      '/api/mirror/diff': () => DIFF,
      '/api/mirror/node/*': (url) => (url.split('?')[0].endsWith('/n2')
        ? { node: { id: 'n2', label: 'n1.1' }, turns: [{ id: 't1', conversation_id: 'cA', session_id: 's1', seq: 1, role: 'commit', kind: 'prompt',
          author: 'user', status: 'done', counts: { items: 3, tools: 1, tool_errors: 0, agents: 0, tasks: 0, edits: 0 }, tool_names: [], groups: [],
          code: null, started_at: T0, duration_ms: 5000, prompt: { preview: 'Fix the rail please', origin: 'terminal' } }], rev: 7 }
        : { node: { id: 'n1', label: 'n1.0' }, turns: [], rev: 7 }),
      '/api/mirror/nodes': { nodes: {}, rev: 7 },
      '/api/graph': () => ({ nodes: [{ id: 'n1', label: 'n1.0', parent_id: null, created_at: T0 - 60000 }, { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: T0 - 30000 }], active: 'n2' }),
      '/api/graph/node/*': (url) => {
        const id = decodeURIComponent(url.split('?')[0].split('/').pop());
        return { id, label: id === 'n2' ? 'n1.1' : 'n1.0', parent_id: id === 'n2' ? 'n1' : null, author: 'claude', trigger: { message: 'm' }, mounts: [], store: {} };
      },
      '/api/graph/diff': { mounts: { added: [], changed: [], removed: [] } },
      '/api/elements': elementsRoute,
      '/api/elements/types': DEFAULT_ROUTES['/api/elements/types'],
      '/api/elements/*': elementRoute,
    },
  });
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
  M = W.__wcMount;
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  ov = await shell.importApp('overlay.js');
  CP = await shell.importApp('chat-pins.js');
  dock = await shell.importApp('chat-dock.js');
  sheet = await shell.importApp('chat-sheet.js');
  gv = await shell.importApp('graph-view.js');
  gt = await shell.importApp('graph-turns.js');
  tools = await shell.importApp('tools.js');
  comments = await shell.importApp('comments.js');
  anchors = (await shell.importApp('anchors.js')).default;
  ov.initOverlay({ rectOf, raf: fakeRaf, now: () => clock, clips });
  await shell.frame(helloFrame({ active: 'n2', mounts: [PANE] }));
  await waitUntil(() => S.mirror.availability === 'ok', { what: 'the snapshot' });
  await chatOpen();
  S.followConversation('cA');
  await waitUntil(() => S.mirror.stream.conversationId === 'cA' && !S.mirror.stream.loading
    && $('chat-stream').querySelectorAll('.ct-turn').length === TURNS.length, { what: 'the stream of cA' });
  await waitUntil(() => CP.chatPins().length === CHAT_PINS.length, { what: 'the chat pins' });
  await settle();
  // The boot census, after the queue rail's own poll armed (U404a's pattern).
  const { refreshPending } = await shell.importApp('queue.js');
  await waitUntil(() => shell.intervals().some((i) => i.fn === refreshPending), { what: 'the queue rail\'s refreshPending interval armed' });
  intervalsAtBoot = shell.intervals().length;
});

after(() => {
  delete globalThis.IntersectionObserver;
  if (ov) ov.setArmed(null);
  return shell.restore();
});

test('every host at once: the page, the chat and the inspector\'s turn list, each over its own layer', () => {
  const byName = Object.fromEntries(ov.hosts().map((h) => [h.name, h]));
  assert.ok(byName.page && byName.chat && byName.turns, `hosts: ${Object.keys(byName).join(', ')}`);
  assert.equal(byName.chat.layer, 'el-layer-chat');
  assert.equal(byName.turns.layer, 'el-layer-turns');
  assert.equal(byName.chat.root, $('chat-views'));
  assert.equal(byName.turns.root, $('gv-inspector'));
  for (const h of ['chat', 'turns']) assert.deepEqual(byName[h].kinds, ['turn', 'item', 'item-range', 'diff-line'], `${h}: the chat kinds`);
});

test('the chat layer draws a pin of each kind docked, windowed and in the sheet at 390 px — inside the clip; a diff line in the open diff view', async () => {
  checkKinds('docked');
  await openDiff();
  const m7 = markerOf('k7');
  assert.ok(shown(m7), 'the diff line drawn in the open diff view');
  assert.ok(m7._group.el.classList.contains('dl') && m7._group.el.getAttribute('data-new') === '2', 'on its .dl line');
  bus.emit('chat:open', { view: 'chat' });
  await settle();

  doc.querySelector('#chat-dock .cd-detach').click();
  await settle();
  assert.equal($('chat-dock').dataset.mode, 'window');
  checkKinds('windowed');
  doc.querySelector('#chat-dock .cd-attach').click();
  await settle();

  geo.stream = { left: 0, top: 300, width: 390, height: 460 };
  shell.setViewport({ width: 390, height: 844, coarse: true });
  await settle();
  sheet.openSheet({ view: 'chat' });
  await settle();
  assert.ok($('sh-chat') && $('sh-chat').contains($('chat-views')), 'the panel is in the sheet');
  checkKinds('sheet 390');
  sheet.closeSheet({ returnFocus: false });
  geo.stream = { left: 860, top: 120, width: 400, height: 560 };
  shell.setViewport({ width: 1280, height: 800, coarse: false });
  await settle();
  await chatOpen();
  checkKinds('docked again');
});

test('the graph inspector\'s turn list draws the turn\'s chat pins on its row, inside the inspector\'s clip', async () => {
  if (!gv.isOverlayOpen()) await gv.openOverlay();
  await gv.selectNode('n2');
  await waitUntil(() => doc.querySelector('#gi-turns li.gi-turn[data-turn-id="t1"]'), { what: 'the turn list of n2' });
  await settle();
  const slot = doc.querySelector('#gi-turns li.gi-turn[data-turn-id="t1"] .gi-turn-pins');
  const layer = doc.getElementById('el-layer-turns');
  const m = [...layer.querySelectorAll('.el-marker')].find((x) => x._group && x._group.el === slot);
  assert.ok(m && shown(m), 'one marker on t1\'s row');
  for (const id of ['k1', 'k5', 'k6', 'k7']) assert.ok((m.dataset.elIds || '').split(' ').includes(id), `${id} in the row's marker`);
  assert.equal(m.querySelector('.pin-count').textContent, '4', 'the count');
  assert.ok(!/SECRET CHAT TEXT/.test(m.title), 'the title is explain lines, never a pin\'s text');
  assert.ok(insideClip(layer, INSP, 'inspector') >= 1);
  gv.closeOverlay();
  await settle();
  await chatOpen();
  assert.ok(shown(markerOf('k1')), 'the chat markers back once the graph closes');
});

test('never over the awaiting card\'s frame: a glyph meeting an answer frame is not drawn; no marker inside the card', async () => {
  const card = $('chat-awaiting');
  const m = markerOf('k1');
  assert.ok(shown(m));
  const iframe = doc.createElement('iframe');
  card.hidden = false;
  card.appendChild(iframe);
  geo.frame = { left: parseFloat(m.style.left) + 4, top: parseFloat(m.style.top) + 4, width: 8, height: 8 };
  try {
    $('chat-stream').dispatchEvent(new W.Event('scroll'));
    await settle();
    assert.ok(!shown(markerOf('k1')), 'not drawn over the frame');
    assert.ok(ov.stats('chat').frame_hidden >= 1);
    assert.equal(card.querySelector('.el-marker'), null);
  } finally {
    iframe.remove();
    card.hidden = true;
    geo.frame = null;
    $('chat-stream').dispatchEvent(new W.Event('scroll'));
    await settle();
  }
  assert.ok(shown(markerOf('k1')));
});

test('the six visible states each draw their one line', async () => {
  assert.ok(markerOf('k1').classList.contains('el-hit'));
  assert.ok(markerOf('k9').classList.contains('el-superseded'));
  assert.ok(markerOf('k10').classList.contains('el-masked'));
  assert.ok(markerOf('k11').classList.contains('el-indexing'));
  assert.ok(markerOf('k12').classList.contains('el-unavailable'));
  assert.equal(markerOf('k14'), null, 'a refused (provisional) answer draws no marker');
  for (const [visible, id] of Object.entries(SIX)) {
    if (visible !== 'refused') assert.equal(markerOf(id).title, EXPLAIN[visible], `${visible}: the marker's line`);
  }
  const pop = CP.openPinList(Object.values(SIX), 100, 100);
  try {
    const lines = Object.fromEntries([...pop.querySelectorAll('.pin-thread-row')].map((r) => [r.dataset.id, r.querySelector('.ptr-explain').textContent]));
    for (const [visible, id] of Object.entries(SIX)) assert.equal(lines[id], EXPLAIN[visible], `${visible}: its line in the list`);
    assert.ok(!/SECRET CHAT TEXT/.test(pop.textContent));
  } finally { CP.closePinList(); }
});

test('Space with nothing focused puts the comment tool down and picks it up again; on a focused pane button it does not', async () => {
  tools.disarm();
  shell.key('c');
  await shell.tick();
  assert.deepEqual(ov.armed(), { type: 'comment', profile: null }, 'precondition: the comment tool armed');
  const a = W.document.activeElement;
  if (a && a !== W.document.body && a.blur) a.blur();
  let e = shell.key(' ');
  await shell.tick();
  assert.equal(e.defaultPrevented, true, 'the page does not scroll');
  assert.equal(ov.armed(), null, 'put down');
  e = shell.key(' ');
  await shell.tick();
  assert.deepEqual(ov.armed(), { type: 'comment', profile: null }, 'picked up again');
  const btn = rootOf('p1').querySelector('button.go');
  btn.focus();
  e = shell.key(' ', { target: btn });
  await shell.tick();
  assert.equal(e.defaultPrevented, false, 'a focused pane button keeps Space');
  assert.deepEqual(ov.armed(), { type: 'comment', profile: null }, 'the tool stays armed');
  btn.blur();
  tools.disarm();
  await settle();
});

test('Send to Claude in a highlight\'s tray posts once', async () => {
  const lead = rootOf('p1').querySelector('p.lead');
  const r = W.document.createRange();
  r.setStart(lead.firstChild, 0);
  r.setEnd(lead.firstChild, 4);
  const rec = { id: 'h31', type: 'highlight', v: 1, schema: 'highlight@1', seq: 31, anchor: anchors.recordRange(rootOf('p1'), r, { mount: 'p1' }), shared: true, color: 'gold', note: '' };
  highlights.set(rec.id, rec);
  await shell.frame({ type: 'element:highlight', elements: [...highlights.values()] });
  await waitUntil(async () => { await settle(); return pageMarker(rec.id); }, { what: 'the highlight\'s marker' });
  pageMarker(rec.id).dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  const pop = await waitUntil(() => W.document.querySelector('.hl-pop'), { what: 'the tray' });
  const btn = pop.querySelector('.hl-pop-acts .hl-send');
  assert.ok(btn, 'Send to Claude is on the tray');
  btn.click();
  await waitUntil(() => sends.includes(rec.id), { what: 'the send' });
  await settle();
  const posted = shell.calls.filter((c) => c.method === 'POST' && c.url === `/api/elements/${rec.id}/send`);
  assert.equal(posted.length, 1, 'exactly one POST');
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle();
});

test('a heading pin\'s glyph sits in the markdown item\'s margin', async () => {
  await shell.frame({ type: 'markdown', id: 'md-sec', text: MD_TEXT, owner: 'claude', gen: 1, order: MD_ORDER, claude_order: MD_ORDER });
  const item = await waitUntil(() => W.document.querySelector('[data-md-id="md-sec"]'), { what: 'the markdown item' });
  const h2 = item.querySelector('h2');
  const range = W.document.createRange();
  range.selectNodeContents(h2);
  const { sourceMap } = await shell.importApp('markdown.js');
  const record = anchors.recordSource(item, range, sourceMap(MD_TEXT), MD_TEXT, { md: 'md-sec' });
  assert.ok(record, 'precondition: a source record');
  item.dataset.pin = 'md-item';
  h2.dataset.pin = 'md-h';
  POS['md-item'] = { left: 60, top: 260, width: 400, height: 120 };
  POS['md-h'] = { left: 100, top: 300, width: 200, height: 14 };
  pagePins = [{ id: 'c81', v: 1, seq: 81, type: 'comment', text: 'on the heading', shared: true, replies: [], anchor: record,
    locator: { mount: 'md-sec', selector: 'h2', text: 'Margin heading', ordinal: 0, section: 'Margin heading' } }];
  await shell.frame({ type: 'element:comment', elements: pagePins });
  const m = await waitUntil(async () => {
    await settle();
    const x = pageMarker('c81');
    return x && x.style.display === '' && x.style.left === '60px' ? x : null;
  }, { what: 'the heading pin drawn in the margin' });
  assert.equal(m.style.left, '60px', 'at the item\'s left edge');
  assert.equal(m.style.top, '300px', 'level with the heading');
  assert.equal(m.style.transform, `translate(${comments.SOURCE_GLYPH.dx}px, ${comments.SOURCE_GLYPH.dy}px)`, 'the margin glyph');
  assert.ok(60 + comments.SOURCE_GLYPH.dx + 26 <= 100, 'left of the heading\'s text');
});

test('no script-error frame reached the daemon, and no interval was armed', () => {
  const errors = shell.sockets.flatMap((s) => s.frames('script:error'));
  assert.deepEqual(errors, [], 'no pane script failed');
  assert.equal(shell.intervals().length, intervalsAtBoot, 'no interval armed since boot');
});
