// Creating chat pins and the chat tray (public/app/comments.js, U434;
// annotation engine 3C.1, M2 for the chat family): the armed Comment tool
// pressed in the chat records a chat-comment on a turn, a passage, a tool card
// or a diff line — in the dock (docked and windowed) and the phone sheet —
// and the chat pin's tray is the comment's thread (reply, the shared switch,
// Delete) with Send to Claude. One thread engine, two types: comments.js
// plugs into the chat layer (chat-pins.js, U432) through
// registerChatPinActions({create, open}).
//
// The real chrome (test-support/chrome-shell, booted once) following a seeded
// conversation, as test/chat-pins.test.js does, with the overlay's box reads,
// frames and clock stubbed through initOverlay({rectOf, raf, now, clips}):
// jsdom does no layout, so the test owns the geometry — each turn a band of
// the stream, each element of a turn its own thin row of it (no two rows of a
// turn overlap, so the chain under a press is exactly the pins drawn there),
// the diff view's lines rows of its body.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { EXPLAIN, VISIBLE } = require('../lib/core/anchor-states');

const T0 = Date.UTC(2026, 9, 29, 9, 0, 0);
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };

let shell, W, $, doc, bus, S, ov, CP, CM, dock, sheet, tools, topbar, st, anchors, md, ET, toolbar;
let rev = 1000;
let pinList = [];
let posts = [];                // the POST /api/elements bodies, in order
let postAnswer = null;         // (body) → a route answer; null: the default ok
let minted = 100;

class StubIO {
  constructor(cb) { this.cb = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

// ── the conversation ────────────────────────────────────────────────────────
function snapshot(primary) {
  const rows = ['cA'].map((id) => ({ id, rev: 1, headless: false, counts: ZERO, live: { state: 'idle', since: T0, last_activity_at: T0 } }));
  return { v: 1, enabled: true, now: Date.now(), rev: ++rev, content: true, access: { level: 'local', remote: false },
    capabilities: {}, primary, aggregate: { state: 'idle' }, conversations: rows, tasks: [], asks: [] };
}
const prompt = (tid, text) => ({ id: `p_${tid}`, kind: 'prompt', text, origin: 'human' });
const reply = (id, text) => ({ id, kind: 'reply', text });
const thinking = (id, text) => ({ id, kind: 'thinking', text });
const tool = (id, label) => ({ id, kind: 'tool_call', tool: 'Bash', tool_kind: 'Bash', label, call: label, status: 'done',
  started_at: T0, ended_at: T0 + 1000, duration_ms: 1000 });
function turn(cid, id, seq, items) {
  return {
    id, rev: ++rev, conversation_id: cid, session_id: 's1', seq, kind: 'prompt', author: 'user', status: 'done',
    started_at: T0 + seq * 60000, ended_at: T0 + seq * 60000 + 5000, duration_ms: 5000,
    counts: { items: items.length, tools: items.filter((i) => i.kind === 'tool_call').length, tool_errors: 0, agents: 0, tasks: 0, edits: 0 },
    tool_names: [], groups: [], node: null, folded_into: null, code: null,
    items: items.map((it, i) => ({ turn_id: id, seq: seq * 1000 + i, ts: T0 + seq * 60000 + i, rev, ...it })),
  };
}
const R1 = "I'll look at **the rail** first, then the rest.";
const R2 = 'Answered here, plainly.';
const TURNS = [
  turn('cA', 't1', 1, [prompt('t1', 'Fix the rail please'), reply('r1_t1', R1), tool('tu_t1', 'npm test'), thinking('th_t1', 'pondering')]),
  turn('cA', 't2', 2, [prompt('t2', 'Second ask'), reply('r_t2', R2)]),
];
const DIFF = {
  v: 1, turn_id: 't1', status: 'ready', totals: { files: 1, additions: 1, deletions: 1 },
  files: [{ path: 'lib/x.js', status: 'M', additions: 1, deletions: 1 }],
  patch: 'diff --git a/lib/x.js b/lib/x.js\n--- a/lib/x.js\n+++ b/lib/x.js\n@@ -1,3 +1,3 @@\n line1\n-gone\n+added\n line2\n',
};

// ── the pins ────────────────────────────────────────────────────────────────
const A = (state) => ({ state, visible: VISIBLE[state], explain: EXPLAIN[VISIBLE[state]] });
function pin(id, anchor, answer = A('exact'), extra = {}) {
  const a = { v: 1, conversation_id: 'cA', session_id: 's1', quote: { exact: `quote of ${id}`, prefix: '', suffix: '' },
    label: `label ${id}`, ...anchor };
  return { id, v: 1, type: 'chat-comment', schema: 'chat-comment@1', seq: 1, shared: true, replies: [],
    text: `comment text ${id}`, anchor: a, anchor_label: `on ${id}`, ...answer, ...extra };
}
const RAIL = R1.indexOf('the rail');
const BASE = () => [
  pin('k1', { kind: 'item-range', turn_id: 't1', item_id: 'r1_t1', field: 'text', label: "turn 1's reply",
    quote: { exact: 'the rail', prefix: 'look at **', suffix: '** first' }, pos: { start: RAIL, end: RAIL + 8 } },
  { ...A('exact'), how: 'unique', at: { item_id: 'r1_t1', field: 'text', start: RAIL, end: RAIL + 8 } }),
  pin('k2', { kind: 'item', turn_id: 't1', item_id: 'p_t1', field: 'text', label: "turn 1's prompt" }, A('exact'),
    { shared: false, text: 'a private note' }),
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
const DESK = { left: 860, top: 120, width: 400, height: 560 };
const geo = { stream: { ...DESK } };
const TURN_H = 160;
const ROWS = 52;                      // a turn's rows, 3 px apart, 2 px tall: none overlap
const FAR = { left: -5000, top: -5000, width: 10, height: 10 };
const rect = (r) => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height });
function boxOfEl(el) {
  if (!el || el.nodeType !== 1) return FAR;
  const s = geo.stream;
  if (el.id === 'chat-stream' || el.id === 'chat-views') return s;
  const body = el.closest('.cp-dbody');
  if (body) {
    if (el === body) return s;
    const k = [...body.querySelectorAll('*')].indexOf(el);
    return { left: s.left + 20, top: s.top + 30 + k * 18, width: 300, height: 16 };
  }
  const t = el.closest('.ct-turn');
  const stream = $('chat-stream');
  if (t && stream && stream.contains(t)) {
    const i = [...stream.querySelectorAll('.ct-turn')].indexOf(t);
    const base = s.top + 4 + i * TURN_H;
    if (el === t) return { left: s.left + 12, top: base, width: 370, height: TURN_H - 4 };
    const k = [...t.querySelectorAll('*')].indexOf(el) % ROWS;
    return { left: s.left + 30, top: base + 2 + k * 3, width: 300, height: 2 };
  }
  return FAR;
}
function rectOf(x) {
  clock += 0.01;
  if (x && x.startContainer) {
    const sc = x.startContainer;
    const r = boxOfEl(sc.nodeType === 1 ? sc : sc.parentNode);
    return rect({ ...r, left: r.left + 8, width: r.width - 16 });
  }
  return rect(boxOfEl(x));
}
const clips = (el) => el.id === 'chat-stream' || (el.classList && el.classList.contains('cp-dbody'));
const centre = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

async function settle(n = 4) {
  for (let i = 0; i < n; i++) {
    await shell.tick();
    flush();
  }
}
const layer = () => doc.getElementById('el-layer-chat');
const markerOf = (id) => [...layer().querySelectorAll('.el-marker')].find((m) => (m.dataset.elIds || '').split(' ').includes(id)) || null;
const turnEl = (id) => $('chat-stream').querySelector(`.ct-turn[data-turn-id="${id}"]`);
const itemElOf = (id) => $('chat-stream').querySelector(`[data-item-id="${id}"]`);
const pinPop = () => doc.querySelector('.pin-pop');
const reaimText = () => { const n = doc.querySelector('#reaim-note .reaim-note-text'); return n ? n.textContent : ''; };
const callsSince = (n) => shell.calls.slice(n).filter((c) => c.url.startsWith('/api/elements'));

// A pointer's press on `el` at (x, y): pointerdown, pointerup, click.
let pid = 40;
function press(el, { pointerType = 'mouse', at } = {}) {
  const { x, y } = at || centre(rectOf(el));
  const id = ++pid;
  const opts = (type) => ({ bubbles: true, cancelable: true, composed: true, pointerType, pointerId: id, isPrimary: true,
    clientX: x, clientY: y, buttons: type === 'pointerdown' ? 1 : 0 });
  el.dispatchEvent(new W.PointerEvent('pointerdown', opts('pointerdown')));
  el.dispatchEvent(new W.PointerEvent('pointerup', opts('pointerup')));
  el.dispatchEvent(new W.PointerEvent('click', { ...opts('click'), detail: 1 }));
  return { x, y };
}
function arm() {
  const r = tools.armTool('comment');
  assert.ok(r && r.ok, 'the comment tool arms');
  assert.equal(ov.armed().type, 'comment');
}
// Type into the open composer and press Pin; wait for its POST.
async function pinIt(text, { wait = true } = {}) {
  const c = pinPop();
  assert.ok(c && c.querySelector('.pin-text'), 'the composer is open');
  c.querySelector('.pin-text').value = text;
  const n = posts.length;
  shell.click(c.querySelector('.pin-save'));
  if (wait) await waitUntil(() => posts.length === n + 1, { what: 'the POST' });
  await settle();
  return posts[posts.length - 1];
}
// Drop the pins the tests made (their answers were applied to the chat layer).
function dropMade() {
  for (const p of CP.chatPins()) if (!BASE().some((b) => b.id === p.id)) CP.dropChatPin(p.id);
}

before(async () => {
  globalThis.IntersectionObserver = StubIO;
  pinList = BASE();
  shell = await bootShell({
    routes: {
      '/api/mirror': () => snapshot('cA'),
      '/api/mirror/conversations/*': (url) => {
        const id = decodeURIComponent(url.split('?')[0].split('/')[4]);
        const turns = url.includes('before=') || id !== 'cA' ? [] : TURNS;
        return { conversation_id: id, turns, next_before: null, total: turns.length, rev: ++rev };
      },
      '/api/mirror/diff': () => DIFF,
      '/api/elements': (url, init) => {
        if (init && init.method === 'POST') {
          const body = JSON.parse(init.body);
          posts.push(body);
          if (postAnswer) return postAnswer(body);
          const id = `k${++minted}`;
          return { ok: true, element: pin(id, { ...body.anchor, label: 'served label' }, A('exact'),
            { text: body.payload.text, shared: body.payload.shared, chain: body.payload.chain }) };
        }
        if (!url.includes('type=chat-comment')) return { elements: [], next_cursor: 0 };
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
  CM = await shell.importApp('comments.js');
  dock = await shell.importApp('chat-dock.js');
  sheet = await shell.importApp('chat-sheet.js');
  tools = await shell.importApp('tools.js');
  topbar = await shell.importApp('topbar.js');
  st = await shell.importApp('state.js');
  ET = await shell.importApp('element-types.js');
  toolbar = await shell.importApp('toolbar-state.js');
  md = await shell.importApp('markdown.js');
  anchors = (await shell.importApp('anchors.js')).default;
  ov.initOverlay({ rectOf, raf: fakeRaf, now: () => clock, clips });
  await shell.frame(helloFrame());
  await waitUntil(() => S.mirror.availability === 'ok', { what: 'the snapshot' });
  if (!dock.isChatOpen()) bus.emit('chat:open', { view: 'chat' });
  await settle();
  S.followConversation('cA');
  await waitUntil(() => S.mirror.stream.conversationId === 'cA' && !S.mirror.stream.loading
    && $('chat-stream').querySelectorAll('.ct-turn').length === 2, { what: 'the stream of cA' });
  await waitUntil(() => CP.chatPins().length === pinList.length, { what: 'the chat pins' });
  await settle();
  // Every comments.js module promise has landed (initComments' lazy load).
  await waitUntil(() => ov.hosts().some((h) => h.name === 'chat'), { what: 'the chat host' });
});

after(() => {
  delete globalThis.IntersectionObserver;
  return shell.restore();
});

// ── the seam ────────────────────────────────────────────────────────────────
test('the seam: comments.js names the chat layer\'s type and kinds; the chat-comment type on the chat host creates with the comment tool', async () => {
  assert.equal(CM.CHAT_TYPE, CP.CHAT_TYPE);
  assert.deepEqual([...CM.CHAT_KINDS], [...CP.KINDS]);
  arm();
  try {
    assert.equal(ov.stats('chat').listening, true, 'the chat host listens while the comment tool is armed (a create is registered)');
  } finally { tools.disarm(); }
  assert.equal(ov.stats('chat').listening, false);
});

// ── create, docked ──────────────────────────────────────────────────────────
test('docked: a mouse press on the turn root outside its items posts kind turn; on the reply prose item; on a tool card item — one POST each, type chat-comment, payload {text, shared, chain}', async () => {
  const n0 = shell.calls.length;
  arm();
  try {
    // The turn root, outside every item (its band's foot: no item row there).
    const tr = rectOf(turnEl('t2'));
    press(turnEl('t2'), { at: { x: tr.left + 4, y: tr.bottom - 3 } });
    assert.equal(pinPop().querySelector('.pin-anchor').textContent, 'turn', 'the composer names the place');
    assert.equal(pinPop().querySelector('.pin-share-cb').checked, true, 'shared by the tool\'s default');
    const b1 = await pinIt('on the turn');
    assert.deepEqual(b1, { type: 'chat-comment', device: b1.device,
      anchor: { kind: 'turn', conversation_id: 'cA', session_id: 's1', turn_id: 't2' },
      payload: { text: 'on the turn', shared: true, chain: [] } });
    assert.equal(typeof b1.device, 'string', 'the device claim (attribution only)');
    assert.equal(pinPop(), null, 'the composer closed on the daemon\'s ok');
    assert.equal(ov.armed(), null, 'Pin puts the tool down, as on the page');
    dropMade();   // a turn pin under the next press would join its chain
    await settle();

    arm();
    press(itemElOf('r_t2').querySelector('p'));
    assert.equal(pinPop().querySelector('.pin-anchor').textContent, 'turn · reply');
    const b2 = await pinIt('on the reply');
    assert.deepEqual(b2.anchor, { kind: 'item', conversation_id: 'cA', session_id: 's1', turn_id: 't2', item_id: 'r_t2', field: 'text' });
    assert.deepEqual(b2.payload, { text: 'on the reply', shared: true, chain: [] });
    dropMade();
    await settle();

    arm();
    const card = itemElOf('tu_t1');
    assert.ok(card && !card.dataset.field, 'the tool card\'s [data-item-id]');
    press(card.querySelector('summary') || card);
    assert.equal(pinPop().querySelector('.pin-anchor').textContent, 'tool card Bash');
    const b3 = await pinIt('on the tool card');
    assert.deepEqual(b3.anchor, { kind: 'item', conversation_id: 'cA', session_id: 's1', turn_id: 't1', item_id: 'tu_t1' });
    const mine = callsSince(n0);
    assert.deepEqual(mine.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`),
      ['POST /api/elements', 'POST /api/elements', 'POST /api/elements'], 'one POST per Pin, nothing else written');
    assert.ok(CP.chatPins().some((p) => p.text === 'on the tool card'), 'the answer applied through applyChatPin');
  } finally {
    tools.disarm();
    CM.closePinPop();
    dropMade();
    await settle();
  }
});

test('docked: a selection inside the reply, then a press inside it, posts item-range with pos as anchors.recordSource answers over sourceMap(text, {flavor: \'chat\'}) (S2)', async () => {
  const prose = itemElOf('r1_t1');
  const strong = prose.querySelector('strong');
  assert.equal(strong.textContent, 'the rail');
  const range = doc.createRange();
  range.setStart(strong.firstChild, 0);
  range.setEnd(strong.firstChild, 8);
  const sel = doc.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const want = anchors.recordSource(prose, range, md.sourceMap(R1, { flavor: 'chat' }), R1, { md: null });
  assert.deepEqual(want.pos, { start: RAIL, end: RAIL + 8 }, 'the engine\'s own answer');
  arm();
  try {
    press(strong);
    assert.equal(pinPop().querySelector('.pin-anchor').textContent.split(' · on ')[0], 'turn · reply › "the rail"');
    const b = await pinIt('a passage');
    assert.deepEqual(b.anchor, { kind: 'item-range', conversation_id: 'cA', session_id: 's1', turn_id: 't1', item_id: 'r1_t1',
      field: 'text', pos: want.pos });
    assert.ok(!('quote' in b.anchor) && !('label' in b.anchor), 'a locator: the daemon quotes the served text (D4)');
    // A collapsed selection, or one in another item, is a plain item press.
    sel.removeAllRanges();
    arm();
    press(itemElOf('r_t2').querySelector('p'));
    assert.equal((await pinIt('no selection')).anchor.kind, 'item');
    const other = doc.createRange();
    other.selectNodeContents(itemElOf('p_t1'));
    sel.addRange(other);
    arm();
    press(itemElOf('r_t2').querySelector('p'));
    assert.equal((await pinIt('selection elsewhere')).anchor.kind, 'item', 'a selection that does not hold the press');
  } finally {
    sel.removeAllRanges();
    tools.disarm();
    CM.closePinPop();
    dropMade();
    await settle();
  }
});

test('docked: a press on a .dl line of the turn\'s open diff view posts diff-line with turn_id, file, line and side (new; old for a deleted line)', async () => {
  bus.emit('chat:open', { view: 'diff', id: 't1' });
  await waitUntil(() => doc.querySelector('#chat-detail .dv-diffview[data-turn-id="t1"] details.dv-file'), { what: 'the diff view' });
  doc.querySelector('#chat-detail details.dv-file[data-path="lib/x.js"]').open = true;
  await settle();
  const lines = [...doc.querySelectorAll('#chat-detail details.dv-file .dl')];
  const added = lines.find((l) => l.textContent === '+added');
  const gone = lines.find((l) => l.textContent === '-gone');
  const hunk = lines.find((l) => l.classList.contains('dl-hunk'));
  const ctx = lines.find((l) => l.textContent === ' line2');
  assert.ok(added && gone && hunk && ctx);
  arm();
  try {
    press(added);
    assert.equal(pinPop().querySelector('.pin-anchor').textContent, 'lib/x.js:2');
    const b1 = await pinIt('on a line');
    assert.deepEqual(b1.anchor, { kind: 'diff-line', conversation_id: 'cA', session_id: 's1', turn_id: 't1', file: 'lib/x.js', side: 'new', line: 2 });
    arm();
    press(gone);
    const b2 = await pinIt('on a deleted line');
    assert.deepEqual([b2.anchor.side, b2.anchor.line], ['old', 2]);
    // A context line carries both numbers: the new side's (data-new) is the one.
    arm();
    press(ctx);
    assert.equal(pinPop().querySelector('.pin-anchor').textContent, 'lib/x.js:3');
    const b3 = await pinIt('on a context line');
    assert.deepEqual([b3.anchor.side, b3.anchor.line], ['new', 3]);
    // A hunk header has no line number: nothing is pinned.
    arm();
    const n = posts.length;
    press(hunk);
    await settle();
    assert.equal(pinPop(), null, 'no composer');
    assert.equal(posts.length, n);
  } finally {
    tools.disarm();
    CM.closePinPop();
    dropMade();
    bus.emit('chat:open', { view: 'chat' });
    await settle();
  }
});

test('windowed (the dock\'s window mode): the same press posts the same item', async () => {
  doc.querySelector('#chat-dock .cd-detach').click();
  await settle();
  assert.equal($('chat-dock').dataset.mode, 'window');
  arm();
  try {
    press(itemElOf('r_t2').querySelector('p'));
    const b = await pinIt('windowed');
    assert.deepEqual(b.anchor, { kind: 'item', conversation_id: 'cA', session_id: 's1', turn_id: 't2', item_id: 'r_t2', field: 'text' });
  } finally {
    tools.disarm();
    CM.closePinPop();
    dropMade();
    doc.querySelector('#chat-dock .cd-attach').click();
    await settle();
  }
});

// ── the chain (U406's, in the chat) ─────────────────────────────────────────
test('the chain: a press on a chat pin\'s passage shows its label in the composer and posts chain [its id]; a bare press posts chain []', async () => {
  const m = markerOf('k1');
  assert.ok(m && m._group.range, 'k1 is drawn on its passage');
  const at = centre(rectOf(m._group.range));
  assert.deepEqual(ov.elementsAt(at.x, at.y, { host: 'chat' }).map((h) => h.id), ['k1'], 'the chat host answers k1 under the point');
  arm();
  try {
    press(itemElOf('r1_t1').querySelector('strong'), { at });
    const line = pinPop().querySelector('.pin-anchor');
    assert.equal(line.querySelector('.pin-chain').textContent, 'on chat comment k1', 'U406\'s label, smallest first');
    const b = await pinIt('under a chat pin');
    assert.deepEqual(b.payload.chain, ['k1']);
    arm();
    press(itemElOf('r_t2').querySelector('p'));
    assert.equal(pinPop().querySelector('.pin-chain'), null, 'no chain line for a bare press');
    assert.deepEqual((await pinIt('bare')).payload.chain, []);
  } finally {
    tools.disarm();
    CM.closePinPop();
    dropMade();
    await settle();
  }
});

// ── refusals and the preview ────────────────────────────────────────────────
test('a 409 {state: provisional, hint} keeps the composer open where the press landed with the hint in .pin-reply-err and the draft kept; a 400 shows its hint', async () => {
  const HINT = 'That reply is still arriving: pin it once it has finished.';
  postAnswer = () => respond({ error: 'provisional', state: 'provisional', hint: HINT }, { status: 409 });
  arm();
  try {
    const at = press(itemElOf('r_t2').querySelector('p'));
    const c = pinPop();
    await pinIt('kept draft');
    assert.equal(pinPop(), c, 'the same composer is still open');
    assert.equal(c.style.left, Math.max(8, Math.min(at.x, W.innerWidth - 264 - 8)) + 'px', 'where the press landed');
    assert.equal(c.querySelector('.pin-reply-err').textContent, HINT);
    assert.equal(c.querySelector('.pin-text').value, 'kept draft', 'the draft kept');
    assert.equal(ov.armed().type, 'comment', 'the tool still armed');
    const BAD = 'Only a prompt, a reply, thinking or a tool card can be pinned.';
    postAnswer = () => respond({ error: 'bad chat anchor', hint: BAD }, { status: 400 });
    await pinIt('kept draft');
    assert.equal(c.querySelector('.pin-reply-err').textContent, BAD, 'the 400\'s hint');
    assert.equal(c.querySelectorAll('.pin-reply-err').length, 1, 'one line, replaced');
    assert.equal(reaimText(), BAD, 'and in the note');
    assert.equal(c.querySelector('.pin-text').value, 'kept draft');
  } finally {
    postAnswer = null;
    tools.disarm();
    CM.closePinPop();
    dropMade();
  }
});

test('previewing creates nothing: no composer, no request', async () => {
  arm();
  const n = shell.calls.length;
  st.view.previewing = true;
  try {
    press(itemElOf('r_t2').querySelector('p'));
    press(turnEl('t2'));
    await settle();
    assert.equal(pinPop(), null);
    assert.equal(callsSince(n).filter((c) => c.method !== 'GET').length, 0);
  } finally {
    st.view.previewing = false;
    tools.disarm();
  }
});

// ── the phone sheet ─────────────────────────────────────────────────────────
// The sheet at 390×844 (setViewport; the sheet's half stop): the panel moved
// into the sheet's Chat page, the host followed it.
async function intoSheet() {
  geo.stream = { left: 0, top: 300, width: 390, height: 460 };
  shell.setViewport({ width: 390, height: 844, coarse: true });
  await settle();
  sheet.openSheet({ view: 'chat' });
  await settle();
  assert.ok($('sh-chat') && $('sh-chat').contains($('chat-views')), 'the panel is in the sheet');
  assert.equal(sheet.sheetState().stop, 'half');
}
async function outOfSheet() {
  tools.disarm();
  CM.closePinPop();
  dropMade();
  sheet.closeSheet({ returnFocus: false });
  geo.stream = { ...DESK };
  shell.setViewport({ width: 1280, height: 800, coarse: false });
  await settle();
  if (!dock.isChatOpen()) bus.emit('chat:open', { view: 'chat' });
  await settle();
}

test('the sheet at 390×844 (half): a pen\'s press on reply text creates; a finger tap on a tool card\'s toggle runs the toggle and creates nothing; the tool stays armed', async () => {
  await intoSheet();
  try {
    arm();
    press(itemElOf('r_t2').querySelector('p'), { pointerType: 'pen' });
    assert.ok(pinPop(), 'the pen\'s press opened the composer');
    const b = await pinIt('from the phone');
    assert.deepEqual(b.anchor, { kind: 'item', conversation_id: 'cA', session_id: 's1', turn_id: 't2', item_id: 'r_t2', field: 'text' });
    dropMade();
    await settle();
    arm();
    const sum = itemElOf('tu_t1').querySelector('summary');
    assert.ok(sum, 'the tool card\'s toggle');
    let heard = 0;
    const onSum = () => { heard++; };
    sum.addEventListener('click', onSum);
    const n = posts.length;
    try {
      press(sum, { pointerType: 'touch' });
      await settle();
    } finally { sum.removeEventListener('click', onSum); }
    assert.equal(heard, 1, 'the toggle ran');
    assert.equal(pinPop(), null, 'no composer');
    assert.equal(posts.length, n, 'nothing created');
    assert.equal(ov.armed() && ov.armed().type, 'comment', 'the tool stays armed');
  } finally {
    await outOfSheet();
  }
});

// OPEN (U434's hand-off, outside its cell): input-mode.js isInteractive walks
// from the press up to the host's root, #chat-views, and #chat-stream on the
// way carries tabindex -1 (chat-panel.js, for focus) — so every finger tap in
// the stream reads as a control's and goes to the page. The ready patch
// (input-mode.js hostSink: a focus sink inside another host's root is never a
// control) turns this green; until it lands, the case is a todo.
test('the sheet: a finger tap on reply text creates (input-mode.js: #chat-stream\'s tabindex makes the stream a control)', {
  todo: 'U434 open issue: input-mode.js isInteractive reads #chat-stream[tabindex=-1] as a control (ready patch in the hand-off)',
}, async () => {
  await intoSheet();
  try {
    arm();
    press(itemElOf('r_t2').querySelector('p'), { pointerType: 'touch' });
    assert.ok(pinPop(), 'a finger tap on static text opened the composer');
    const b = await pinIt('a finger');
    assert.deepEqual(b.anchor, { kind: 'item', conversation_id: 'cA', session_id: 's1', turn_id: 't2', item_id: 'r_t2', field: 'text' });
  } finally {
    await outOfSheet();
  }
});

// ── the tray: the comment's thread ──────────────────────────────────────────
async function openThreadOf(id) {
  await settle();
  const m = markerOf(id);
  assert.ok(m, `${id} drawn`);
  m.dispatchEvent(new W.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 40 }));
  const thread = pinPop();
  assert.ok(thread && thread.classList.contains('pin-thread'), 'the thread opened');
  assert.equal(thread.dataset.id, id);
  return thread;
}

test('the tray: a chat marker\'s click opens the thread from chatPinOf; reply, the shared switch, Send to Claude and Delete are one request each, applied to the chat layer', async () => {
  const rec = (over) => ({ ...CP.chatPinOf('k1').record, ...over });
  shell.setRoutes({
    '/api/elements/k1/reply': (url, init) => ({ ok: true, element: rec({ v: 2, replies: [{ author: 'user', at: 1, text: JSON.parse(init.body).text }] }) }),
    '/api/elements/k1': (url, init) => (init.method === 'DELETE' ? { ok: true, removed: 'k1' } : { ok: true, element: rec({ v: 3, shared: false }) }),
    '/api/elements/k1/send': () => ({ ok: true, element: rec({ v: 4, shared: true }), item: { id: 'q1' } }),
  });
  try {
    const thread = await openThreadOf('k1');
    assert.equal(thread.querySelector('.pin-anchor').textContent, 'turn 1\'s reply › "the rail"', 'the chat place');
    assert.equal(thread.querySelector('.pin-msg .pin-body').textContent, 'comment text k1', 'the comment\'s text, in the thread');
    assert.ok(!/comment text/.test(markerOf('k1').title), 'never in the marker\'s title');
    let n = shell.calls.length;
    thread.querySelector('.pin-reply-text').value = 'a reply';
    shell.click(thread.querySelector('.pin-reply-send'));
    await waitUntil(() => CP.chatPinOf('k1').record.v === 2, { what: 'the reply applied' });
    assert.deepEqual(callsSince(n).map((c) => `${c.method} ${c.url}`), ['POST /api/elements/k1/reply']);
    assert.deepEqual(callsSince(n)[0].body, { text: 'a reply', author: 'user', device: callsSince(n)[0].body.device });
    const again = pinPop();
    assert.equal([...again.querySelectorAll('.pin-msg .pin-body')].pop().textContent, 'a reply', 'the thread again, with the reply');

    n = shell.calls.length;
    const cb = again.querySelector('.pin-share-cb');
    cb.checked = false;
    cb.dispatchEvent(new W.Event('change', { bubbles: true }));
    await waitUntil(() => CP.chatPinOf('k1').record.v === 3, { what: 'the share applied' });
    assert.deepEqual(callsSince(n).map((c) => `${c.method} ${c.url}`), ['PATCH /api/elements/k1']);
    assert.equal(callsSince(n)[0].body.shared, false);

    n = shell.calls.length;
    const send = again.querySelector('.pin-actions .pin-send');
    assert.ok(send, 'Send to Claude at canWrite');
    assert.equal(send.textContent, ET.SEND_LABEL);
    assert.equal(send.previousElementSibling, again.querySelector('.pin-del'), 'beside Delete');
    shell.click(send);
    await waitUntil(() => CP.chatPinOf('k1').record.v === 4 && reaimText() === ET.SENT_NOTE, { what: 'the send applied' });
    assert.deepEqual(callsSince(n).map((c) => `${c.method} ${c.url}`), ['POST /api/elements/k1/send']);
    assert.equal(again.querySelector('.pin-share-cb').checked, true, '"Shared with Claude" reads shared after the send');

    n = shell.calls.length;
    shell.click(again.querySelector('.pin-del'));
    await waitUntil(() => CP.chatPinOf('k1') === null, { what: 'the drop' });
    await settle();
    assert.deepEqual(callsSince(n).map((c) => `${c.method} ${c.url}`), ['DELETE /api/elements/k1']);
    assert.equal(markerOf('k1'), null, 'the marker goes');
    assert.equal(pinPop(), null);
  } finally {
    shell.setRoutes({});
    CM.closePinPop();
    pinList = BASE();
    await CP.refreshChatPins();
    await settle();
  }
});

test('the thread\'s anchor line names a chained chat pin\'s chain; a reply refused keeps the draft and says so', async () => {
  const k3 = pin('k3', { kind: 'turn', turn_id: 't2', label: 'turn 2' }, A('exact'), { chain: ['k1'] });
  CP.applyChatPin(k3);
  shell.setRoutes({ '/api/elements/k3/reply': respond({ error: 'stale' }, { status: 409 }) });
  try {
    const thread = await openThreadOf('k3');
    assert.equal(thread.querySelector('.pin-anchor').textContent, 'turn 2 · on chat comment k1');
    thread.querySelector('.pin-reply-text').value = 'kept';
    const n = shell.calls.length;
    shell.click(thread.querySelector('.pin-reply-send'));
    await waitUntil(() => thread.querySelector('.pin-reply-err'), { what: 'the refusal line' });
    assert.equal(thread.querySelector('.pin-reply-text').value, 'kept', 'the draft kept');
    assert.equal(callsSince(n).length, 1);
  } finally {
    shell.setRoutes({});
    CM.closePinPop();
    CP.dropChatPin('k3');
    await settle();
  }
});

test('Send to Claude is drawn at canWrite and absent below full', async () => {
  const live = await (await W.fetch('/api/toolbar')).json();
  shell.setRoutes({ '/api/toolbar': { ...live, canWrite: false } });
  await toolbar.refreshToolbar();
  try {
    const t = await openThreadOf('k2');
    assert.equal(t.querySelector('.pin-send'), null, 'absent below full');
    assert.ok(t.querySelector('.pin-del') && t.querySelector('.pin-reply-text'), 'the rest of the thread as before');
    assert.equal(t.querySelector('.pin-share-cb').checked, false, 'a private chat pin reads private');
  } finally {
    CM.closePinPop();
    shell.setRoutes({});
    await toolbar.refreshToolbar();
  }
  const t2 = await openThreadOf('k2');
  assert.ok(t2.querySelector('.pin-send'), 'drawn again at canWrite');
  CM.closePinPop();
});

test('while a page node is previewed the chat thread is read-only with READONLY_HINT; a write asked for once a preview has started is refused through the tray action guard with no request (Q5, TRAY@guard)', async () => {
  st.view.previewing = true;
  try {
    const ro = await openThreadOf('k2');
    assert.ok(ro.classList.contains('pin-readonly'));
    assert.equal(ro.querySelector('.pin-ro-hint').textContent, topbar.READONLY_HINT);
    for (const sel of ['.pin-reply-text', '.pin-share-cb', '.pin-del', '.pin-send', '.pin-reply-send']) {
      assert.equal(ro.querySelector(sel), null, `no ${sel}`);
    }
  } finally {
    st.view.previewing = false;
    CM.closePinPop();
  }
  const thread = await openThreadOf('k2');
  const n = shell.calls.length;
  st.view.previewing = true;
  try {
    thread.querySelector('.pin-reply-text').value = 'a reply';
    shell.click(thread.querySelector('.pin-reply-send'));
    const cb = thread.querySelector('.pin-share-cb');
    cb.checked = !cb.checked;
    cb.dispatchEvent(new W.Event('change', { bubbles: true }));
    shell.click(thread.querySelector('.pin-send'));
    shell.click(thread.querySelector('.pin-del'));
    await settle();
    assert.equal(shell.calls.length, n, 'nothing sent');
    assert.equal(cb.checked, false, 'the share box put back');
    assert.equal(reaimText(), topbar.READONLY_HINT, 'the guard\'s one hint');
    assert.ok(CP.chatPinOf('k2'), 'nothing dropped');
  } finally {
    st.view.previewing = false;
    CM.closePinPop();
  }
});

test('Escape: the composer\'s Escape closes it and puts the tool down; an empty reply draft\'s Escape closes the thread', async () => {
  arm();
  press(itemElOf('r_t2').querySelector('p'));
  const c = pinPop();
  c.querySelector('.pin-text').dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(pinPop(), null);
  assert.equal(ov.armed(), null);
  const t = await openThreadOf('k2');
  t.querySelector('.pin-reply-text').dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(pinPop(), null);
});

// ── the answered lookup (K.2-164) ───────────────────────────────────────────
test('isCommentAnswered is the one answered lookup for both families: a chat pin answers from the chat layer\'s records', () => {
  assert.equal(CM.isCommentAnswered('k2', 'chat-comment'), false);
  assert.equal(CM.isCommentAnswered('k2'), false);
  CP.applyChatPin({ ...CP.chatPinOf('k2').record, v: 9, replies: [{ author: 'claude', at: 1, text: 'done' }] });
  try {
    assert.equal(CM.isCommentAnswered('k2', 'chat-comment'), true);
    assert.equal(CM.isCommentAnswered('k2'), true, 'an id no page pin holds reads the chat layer');
    assert.equal(CM.isCommentAnswered('k2', 'comment'), false, 'a page pin\'s lookup never reads a chat pin');
  } finally {
    CP.applyChatPin(BASE().find((p) => p.id === 'k2'));
  }
});
