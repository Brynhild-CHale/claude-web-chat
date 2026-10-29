// The chat host re-draws when its dock finishes animating (annotation engine
// 3C.1, U432a; the 3C gate's blocker, results/gate-t3-3C.md finding 1,
// C-3C-1): the chrome twin of F4 s1-hosts' windowed reading.
//
// What the gate measured at aa60492e: Detach puts the dock in window mode,
// whose cd-pop animation (public/app.css: scale .96 → 1) moves #chat-stream
// while the chat host's settle fires at the mode switch only; the overlay
// measured the stream mid-animation and kept that draw, so one glyph (k13)
// sat with its anchor past the at-rest stream's clip bottom and its clip-path
// cut to the mid-animation box. The docked mode's cd-slide is the same seam.
//
// The real chrome (test-support/chrome-shell, booted once) following a seeded
// conversation, with the overlay's box reads, frames and clock stubbed through
// initOverlay({rectOf, raf, now, clips}) as test/chat-pins.test.js does: jsdom
// runs no animation and does no layout, so the test owns the geometry — a
// stream box MID while the animation runs, REST once it has ended — and
// dispatches the animation's events itself. A ResizeObserver stand-in is put
// on globalThis before the boot (jsdom has none) so the overlay's well
// observer is the test's to drive.
//
// Pinned here:
//   - windowed: a draw taken at the mode switch, against the mid-animation
//     stream, is re-measured when cd-pop ends — every drawn anchor point and
//     every painted glyph box inside the at-rest stream ∩ viewport, the glyph
//     past the at-rest bottom no longer drawn, the one straddling it cut by
//     its clip-path; the host re-placed once (stats('chat').animation_settles);
//   - while cd-pop runs each frame re-measures (the glyph follows the moving
//     stream), and the follow ends with the animation;
//   - docked: cd-slide's end the same;
//   - the well's box: the overlay observes #chat-stream (the chat's well) and
//     #main; a first observation draws nothing; two size changes in one frame
//     draw one frame, re-measured; an unchanged size draws nothing;
//   - the chat host names #chat-dock and #chat-pull as its animations, and
//     keeps every settle trigger it had (chat:drawn still re-places it).
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { EXPLAIN, VISIBLE } = require('../lib/core/anchor-states');

const T0 = Date.UTC(2026, 9, 29, 9, 0, 0);
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };

let shell, W, $, doc, bus, S, ov, CP, dock;
let rev = 2000;

// jsdom has no IntersectionObserver (the stream's sentinel) and no
// ResizeObserver (the overlay's well observer): the second is the test's.
class StubIO {
  constructor(cb) { this.cb = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}
const observers = [];
class FakeRO {
  constructor(cb) { this.cb = cb; this.targets = new Set(); observers.push(this); }
  observe(el) { this.targets.add(el); }
  unobserve(el) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
}

// ── the conversation and the pins ───────────────────────────────────────────
const prompt = (tid, text) => ({ id: `p_${tid}`, kind: 'prompt', text, origin: 'human' });
const reply = (id, text) => ({ id, kind: 'reply', text });
function turn(cid, id, seq, items) {
  return {
    id, rev: ++rev, conversation_id: cid, session_id: 's1', seq, kind: 'prompt', author: 'user', status: 'done',
    started_at: T0 + seq * 60000, ended_at: T0 + seq * 60000 + 5000, duration_ms: 5000,
    counts: { items: items.length, tools: 0, tool_errors: 0, agents: 0, tasks: 0, edits: 0 },
    tool_names: [], groups: [], node: null, folded_into: null, code: null,
    items: items.map((it, i) => ({ turn_id: id, seq: seq * 1000 + i, ts: T0 + seq * 60000 + i, rev, ...it })),
  };
}
const TURNS = [];
for (let i = 1; i <= 6; i++) TURNS.push(turn('cA', `t${i}`, i, [prompt(`t${i}`, `ask ${i}`), reply(`r_t${i}`, `answer ${i}`)]));
const current = {
  v: 1, enabled: true, now: Date.now(), rev: ++rev, content: true, access: { level: 'local', remote: false },
  capabilities: {}, primary: 'cA', aggregate: { state: 'idle' },
  conversations: [{ id: 'cA', rev: 1, headless: false, counts: ZERO, live: { state: 'idle', since: T0, last_activity_at: T0 } }],
  tasks: [], asks: [],
};
const A = (state) => ({ state, visible: VISIBLE[state], explain: EXPLAIN[VISIBLE[state]] });
function pin(id, anchor) {
  return { id, v: 1, type: 'chat-comment', schema: 'chat-comment@1', seq: 1, shared: true, replies: [],
    text: `comment ${id}`, anchor_label: `on ${id}`,
    anchor: { v: 1, conversation_id: 'cA', session_id: 's1', quote: { exact: `quote ${id}`, prefix: '', suffix: '' }, ...anchor },
    ...A('exact') };
}
// kTop sits well inside every stream box; kA (the turn t5's root) and kB (t5's
// reply) are the pair the at-rest bottom falls between.
const PINS = [
  pin('kTop', { kind: 'turn', turn_id: 't1' }),
  pin('kA', { kind: 'turn', turn_id: 't5' }),
  pin('kB', { kind: 'item', turn_id: 't5', item_id: 'r_t5', field: 'text' }),
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
function oneFrame() {
  const fn = queue.shift();
  assert.ok(fn, 'a frame is pending');
  fn(clock);
}
const TURN_H = 100;
const FAR = { left: -5000, top: -5000, width: 10, height: 10 };
const REST = { left: 860, top: 120, width: 400, height: 560 };
const geo = { stream: { ...REST } };
const rect = (r) => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height });
// Each turn a band of the stream (its root at the band's top); each element of
// a turn a row of it, 7 px apart, 30 px in.
function boxOfEl(el) {
  if (!el || el.nodeType !== 1) return FAR;
  const st = geo.stream;
  if (el.id === 'chat-stream' || el.id === 'chat-views') return st;
  const t = el.closest('.ct-turn');
  const stream = $('chat-stream');
  if (t && stream && stream.contains(t)) {
    const i = [...stream.querySelectorAll('.ct-turn')].indexOf(t);
    const base = st.top + 10 + i * TURN_H;
    if (el === t) return { left: st.left + 12, top: base, width: 370, height: TURN_H - 10 };
    const k = [...t.querySelectorAll('*')].indexOf(el);
    return { left: st.left + 30, top: base + 4 + (k % 12) * 7, width: 300, height: 6 };
  }
  return FAR;
}
function rectOf(x) {
  clock += 0.01;
  if (x && x.startContainer) {
    const sc = x.startContainer;
    return rect(boxOfEl(sc.nodeType === 1 ? sc : sc.parentNode));
  }
  return rect(boxOfEl(x));
}
const clips = (el) => el.id === 'chat-stream';

async function settle(n = 4) {
  for (let i = 0; i < n; i++) {
    await shell.tick();
    flush();
  }
}
const layer = () => doc.getElementById('el-layer-chat');
const markerOf = (id) => [...layer().querySelectorAll('.el-marker')]
  .find((m) => (m.dataset.elIds || '').split(' ').includes(id)) || null;
const shown = (m) => !!m && m.style.display !== 'none';
const anchorY = (id) => rectOf(markerOf(id)._group.el).top;
const clipOf = (st) => ({ left: Math.max(0, st.left), top: Math.max(0, st.top), right: Math.min(W.innerWidth, st.left + st.width),
  bottom: Math.min(W.innerHeight, st.top + st.height) });

// The F4 reading: every drawn marker's anchor point and painted glyph box
// against the stream box the geometry holds NOW. Returns the counts.
function reading(st = geo.stream) {
  const clip = clipOf(st);
  const out = { drawn: 0, out_of_clip: 0, drawn_outside: 0 };
  for (const m of layer().querySelectorAll('.el-marker')) {
    if (!shown(m)) continue;
    out.drawn++;
    const x = parseFloat(m.style.left);
    const y = parseFloat(m.style.top);
    if (!(x >= clip.left && x < clip.right && y >= clip.top && y < clip.bottom)) out.out_of_clip++;
    const tr = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(m.style.transform) || [0, '0', '0'];
    const ins = /inset\((-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px\)/.exec(m.style.clipPath || '') || [0, 0, 0, 0, 0];
    const [it, ir, ib, il] = ins.slice(1).map(Number);
    const gx = x + Number(tr[1]);
    const gy = y + Number(tr[2]);
    const painted = { left: gx + il, top: gy + it, right: gx + parseFloat(m.style.width) - ir, bottom: gy + parseFloat(m.style.height) - ib };
    if (painted.left < clip.left - 0.01 || painted.top < clip.top - 0.01
      || painted.right > clip.right + 0.01 || painted.bottom > clip.bottom + 0.01) out.drawn_outside++;
  }
  return out;
}
const insetBottom = (id) => {
  const ins = /inset\((-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px\)/.exec(markerOf(id).style.clipPath || '');
  return ins ? Number(ins[3]) : 0;
};
// The animation's events, as an engine sends them (jsdom runs none): on the
// dock, bubbling, with the keyframes' name.
function animEvent(type, el, animationName) {
  const e = new W.Event(type, { bubbles: true });
  Object.defineProperty(e, 'animationName', { value: animationName });
  el.dispatchEvent(e);
}

// Geometry fitted to the model: MID's bottom below both kA and kB's glyphs
// (both drawn whole mid-animation), REST's bottom between kA's anchor and
// kB's (kA cut by its clip-path, kB's anchor outside).
let MID;
function fitGeometry() {
  const ya = anchorY('kA');
  const yb = anchorY('kB');
  assert.ok(yb > ya + 4, `kB (${yb}) sits below kA (${ya}) in the model`);
  const restBottom = (ya + yb) / 2;
  REST.height = restBottom - REST.top;
  MID = { ...REST, top: REST.top + 6, height: REST.height + 40 };
}

before(async () => {
  globalThis.IntersectionObserver = StubIO;
  globalThis.ResizeObserver = FakeRO;
  shell = await bootShell({
    routes: {
      '/api/mirror': () => current,
      '/api/mirror/conversations/*': (url) => {
        const turns = url.includes('before=') ? [] : TURNS;
        return { conversation_id: 'cA', turns, next_before: null, total: turns.length, rev: ++rev };
      },
      '/api/elements': (url) => (url.includes('type=chat-comment')
        ? { elements: PINS.map((p) => ({ ...p })), next_cursor: 9 } : { elements: [], next_cursor: 0 }),
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
  ov.initOverlay({ rectOf, raf: fakeRaf, now: () => clock, clips });
  await shell.frame(helloFrame());
  await waitUntil(() => S.mirror.availability === 'ok', { what: 'the snapshot' });
  await settle();
  if (!dock.isChatOpen()) bus.emit('chat:open', { view: 'chat' });
  await settle();
  S.followConversation('cA');
  await waitUntil(() => S.mirror.stream.conversationId === 'cA' && !S.mirror.stream.loading
    && $('chat-stream').querySelectorAll('.ct-turn').length === TURNS.length, { what: 'the stream of cA' });
  await waitUntil(() => CP.chatPins().length === PINS.length, { what: 'the chat pins' });
  await settle();
  for (const id of ['kTop', 'kA', 'kB']) assert.ok(markerOf(id), `${id} has a marker`);
  fitGeometry();
  geo.stream = { ...REST };
  ov.requestDraw();
  await settle();
});

after(() => {
  delete globalThis.IntersectionObserver;
  delete globalThis.ResizeObserver;
  return shell.restore();
});

test('the chat host names the dock and the pull as its animations', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public/app/chat-pins.js'), 'utf8');
  assert.ok(/settle, animates,/.test(src), 'registered with its settle kept and its animations named');
  assert.ok(/\[\$\('chat-dock'\), \$\('chat-pull'\)\]/.test(src), 'the dock (cd-slide, cd-pop) and the pull');
  assert.equal(typeof ov.ANIMATION_FOLLOW_MAX_MS, 'number');
});

test('windowed: the draw taken while cd-pop runs is re-measured from the at-rest stream when it ends (C-3C-1)', async () => {
  // The mode switch: the dock's data-mode changes and its animation starts;
  // the host's settle (the attribute observer) draws against the MID box.
  geo.stream = { ...MID };
  const places0 = ov.stats('chat').places;
  const settles0 = ov.stats('chat').animation_settles;
  doc.querySelector('#chat-dock .cd-detach').click();
  await settle();
  assert.equal($('chat-dock').dataset.mode, 'window');
  assert.ok(ov.stats('chat').places > places0, 'the mode switch re-placed the host (its settle, as before)');
  assert.ok(shown(markerOf('kA')) && shown(markerOf('kB')), 'mid-animation both glyphs are inside the MID stream');
  assert.equal(insetBottom('kA'), 0, 'kA drawn whole against MID');
  assert.deepEqual(reading(MID), { drawn: 3, out_of_clip: 0, drawn_outside: 0 }, 'the mid-animation reading against MID');
  // The animation settles: the stream is at REST, and the engine sends cd-pop's end.
  geo.stream = { ...REST };
  const places1 = ov.stats('chat').places;
  animEvent('animationend', $('chat-dock'), 'cd-pop');
  flush();
  const r = reading(REST);
  assert.equal(r.out_of_clip, 0, 'no anchor point drawn outside the at-rest stream');
  assert.equal(r.drawn_outside, 0, 'no painted fragment past the at-rest stream bottom');
  assert.ok(!shown(markerOf('kB')), 'kB, its anchor past the at-rest bottom, is not drawn');
  assert.ok(shown(markerOf('kA')), 'kA, its anchor inside, is drawn');
  const bottom = REST.top + REST.height;
  assert.ok(Math.abs(insetBottom('kA') - (anchorY('kA') + 26 - bottom)) < 0.01, 'kA cut by its clip-path at the at-rest bottom');
  assert.equal(ov.stats('chat').places, places1 + 1, 'the end re-placed the host once');
  assert.equal(ov.stats('chat').animation_settles, settles0 + 1);
  doc.querySelector('#chat-dock .cd-attach').click();
  await settle();
});

test('while cd-pop runs each frame re-measures (the glyph follows the stream); the follow ends with the animation', async () => {
  geo.stream = { ...MID };
  doc.querySelector('#chat-dock .cd-detach').click();
  await settle();
  assert.equal($('chat-dock').dataset.mode, 'window');
  animEvent('animationstart', $('chat-dock'), 'cd-pop');
  assert.equal(ov.stats('chat').animating, true, 'the start is followed');
  // Frame by frame the stream moves from MID to REST; each frame's reading is
  // taken against that frame's own box.
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    geo.stream = { ...REST, top: MID.top + (REST.top - MID.top) * f, height: MID.height + (REST.height - MID.height) * f };
    oneFrame();
    const r = reading();
    assert.equal(r.out_of_clip, 0, `step ${i}: no anchor point outside the stream`);
    assert.equal(r.drawn_outside, 0, `step ${i}: no painted fragment outside the stream`);
    assert.equal(queue.length, 1, `step ${i}: the follow asks for the next frame`);
  }
  animEvent('animationend', $('chat-dock'), 'cd-pop');
  assert.equal(ov.stats('chat').animating, false, 'the end stops the follow');
  const n = flush();
  assert.ok(n >= 1 && n <= 3, `the follow settles to no pending frame (${n})`);
  assert.equal(queue.length, 0);
  assert.deepEqual(reading(REST), { drawn: 2, out_of_clip: 0, drawn_outside: 0 });
  doc.querySelector('#chat-dock .cd-attach').click();
  await settle();
});

test('docked: cd-slide\'s end re-measures the same way', async () => {
  geo.stream = { ...REST };
  await settle();
  assert.notEqual($('chat-dock').dataset.mode, 'window');
  // Re-open the docked chat: cd-slide runs (translateX(32px) → 0), the draw at
  // its start (the dock's attribute change) reads the MID box.
  dock.closeChat();
  await settle();
  geo.stream = { ...MID, left: REST.left + 32 };
  bus.emit('chat:open', { view: 'chat' });
  await settle();
  assert.ok(dock.isChatOpen());
  assert.ok(shown(markerOf('kB')), 'mid-slide kB is inside the MID stream');
  geo.stream = { ...REST };
  const settles0 = ov.stats('chat').animation_settles;
  animEvent('animationend', $('chat-dock'), 'cd-slide');
  flush();
  assert.deepEqual(reading(REST), { drawn: 2, out_of_clip: 0, drawn_outside: 0 });
  assert.ok(!shown(markerOf('kB')));
  assert.equal(parseFloat(markerOf('kA').style.left), REST.left + 12, 'kA moved back with the slide');
  assert.equal(ov.stats('chat').animation_settles, settles0 + 1);
});

test('the well\'s box: #chat-stream and #main observed; a first observation draws nothing; two changes in a frame draw one', async () => {
  const ro = observers[0];
  assert.ok(ro, 'the overlay made one ResizeObserver');
  assert.equal(observers.length, 1, 'one observer for every well');
  assert.ok(ro.targets.has($('main')), 'the page well');
  assert.ok(ro.targets.has($('chat-stream')), 'the chat host\'s well, observed when a group was clipped to it');
  const frames = [];
  const off = bus.on('overlay:frame', (d) => frames.push(d));
  try {
    const entry = (el, w, h) => ({ target: el, contentRect: { width: w, height: h }, borderBoxSize: [{ inlineSize: w, blockSize: h }] });
    const s = $('chat-stream');
    ro.cb([entry(s, REST.width, REST.height), entry($('main'), 800, 700)], ro);
    assert.equal(queue.length, 0, 'a first observation asks for no draw');
    const resizes0 = ov.stats().well_resizes;
    // The stream grows (a window resize handle): two observations land before a frame.
    geo.stream = { ...REST, height: REST.height + 40 };
    ro.cb([entry(s, REST.width, REST.height + 20)], ro);
    ro.cb([entry(s, REST.width, REST.height + 40)], ro);
    assert.equal(queue.length, 1, 'one frame asked for');
    flush();
    assert.equal(frames.length, 1, 'one draw frame for two observations');
    assert.equal(ov.stats().well_resizes, resizes0 + 2);
    assert.ok(shown(markerOf('kB')), 'kB re-measured inside the grown stream');
    assert.deepEqual(reading(), { drawn: 3, out_of_clip: 0, drawn_outside: 0 });
    ro.cb([entry(s, REST.width, REST.height + 40)], ro);
    assert.equal(queue.length, 0, 'an unchanged size asks for no draw');
  } finally {
    off();
    geo.stream = { ...REST };
    ov.requestDraw();
    await settle();
  }
});

test('the present settle triggers are kept: chat:drawn still re-places the host once; an animation off the dock is not the chat\'s', async () => {
  const p0 = ov.stats('chat').places;
  bus.emit('chat:drawn', { conversationId: 'cA', turnIds: ['t1'] });
  flush();
  assert.equal(ov.stats('chat').places, p0 + 1);
  const s0 = ov.stats('chat').animation_settles;
  animEvent('animationend', $('main'), 'anything');
  assert.equal(queue.length, 0, 'an animation under #main draws nothing for the chat');
  assert.equal(ov.stats('chat').animation_settles, s0);
});
