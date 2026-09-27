// A fork's elbow crossing OTHER columns on its way to a far branch (s3a-3 rework).
// Driven against the REAL front-end module graph in jsdom, one boot per file.
//
// The branch lands in the next free column, which can be several columns away.
// Drawn at one height — the fork's own glyph height — the sideways run went
// through every glyph between on the same row, and lay on top of the elbow of
// the fork in the next column, so the drawing read that fork → the far branch.
// With the rows of a column in between shifted (a bookmark's room), the same run
// struck that column's label instead. Pinned: no edge passes through a node
// body, a label, a caption, a stack's range or a tree heading; no two edges run
// sideways along each other; both still hold after the tree is dragged.
//
//   tree 1 — the reviewer's fixture:
//     r0 ─ p1 ─ a3 ─ a4 (active)           column 0
//          └─ p4 ─ p5 (⚑ keep)            column 1: p4 at p1's next row
//               └─ x6                      column 2
//               a3 └──────────── c9        column 3: a3's elbow crosses 1 and 2
//   tree 2 — a column between whose rows are 16px off (a bookmarked branch head):
//     s0 ─ s1 ─ s2 ─ s3                    column 0
//          └─ q1 (⚑ offset) ─ q2           column 1: q1 carries a caption's room
//               s2 └──────── t1            column 2: s2's elbow crosses column 1
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');
const { strikes, sharedRuns, samples } = require('../test-support/graph-geometry');

const REPO = path.resolve(__dirname, '..');

const N = (id, label, parent_id, created_at, extra = {}) => ({ id, label, parent_id, created_at, trigger_summary: id, ...extra });
const NODES = [
  N('r0', 'n1.0', null, 1),
  N('p1', 'n1.1', 'r0', 2),
  N('a3', 'n1.2', 'p1', 3),
  N('p4', 'n1.1.0', 'p1', 3.5),
  N('p5', 'n1.1.1', 'p4', 4.5, { bookmarked: true, name: 'keep' }),
  N('x6', 'n1.1.0.0', 'p4', 5),
  N('a4', 'n1.3', 'a3', 6),
  N('c9', 'n1.2.0', 'a3', 7),
  N('s0', 'n2.0', null, 20),
  N('s1', 'n2.1', 's0', 21),
  N('s2', 'n2.2', 's1', 22),
  N('q1', 'n2.1.0', 's1', 23, { bookmarked: true, name: 'offset' }),
  N('q2', 'n2.1.1', 'q1', 24),
  N('s3', 'n2.3', 's2', 25),
  N('t1', 'n2.2.0', 's2', 26),
];
// A parent's earliest child is its trunk (kids[0]); the later ones fork off.

let W = null, WS = null, restore = () => {};

before(async () => {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;
  const wsInstances = [];
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; wsInstances.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send() {} close() {}
  };
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url) => {
    const u = String(url);
    if (u === '/api/graph') return json({ nodes: NODES.map((n) => ({ ...n })), active: 'a4' });
    if (u.startsWith('/api/graph/node/')) {
      const id = decodeURIComponent(u.split('/').pop());
      return json({ ...(NODES.find((x) => x.id === id) || NODES[0]), author: 'claude', mounts: [], store: {} });
    }
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.7.5', updateAvailable: false });
    if (u.startsWith('/api/theme')) return json({ name: 'earthy' });
    return json({ ok: true });
  };
  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'WheelEvent', 'FocusEvent', 'navigator', 'getComputedStyle', 'localStorage', 'sessionStorage', 'WebSocket', 'fetch',
    'HTMLElement', 'Node', 'Element'];
  const aliasGlobal = (k, v) => {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch { try { global[k] = v; } catch {} }
  };
  for (const k of keys) { try { saved[k] = global[k]; } catch {} aliasGlobal(k, window[k]); }
  const savedSetInterval = global.setInterval;
  global.setInterval = () => 0;
  global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  window.__wcMount = require(path.join(REPO, 'public/mount-runtime.js'));
  await import(pathToFileURL(path.join(REPO, 'public/app/main.js')).href);
  restore = () => {
    for (const k of keys) { try { global[k] = saved[k]; } catch {} }
    global.setInterval = savedSetInterval;
    window.close();
  };
  W = window;
  WS = wsInstances[0];
  await tick();
  WS.onmessage({ data: JSON.stringify({ type: 'hello', store: {}, theme: null, activeTheme: null, active: 'a4', lock: null, project: 'test', mounts: [] }) });
  await tick();
  W.document.getElementById('btn-graph').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick(); await tick();
});

after(async () => {
  await new Promise((r) => setTimeout(r, 400)); // drain the theme-transition timer while the window lives
  restore();
});

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const num = (el, a) => Number(el.getAttribute(a));
const body = (id) => W.document.querySelector(`#graph-svg g[data-id="${id}"] .gv-body`);
const at = (id) => ({ x: num(body(id), 'cx'), y: num(body(id), 'cy'), r: num(body(id), 'r') });
const edgeInto = (id) => {
  const b = at(id);
  return [...W.document.querySelectorAll('#graph-svg .gv-edge')].map((e) => e.getAttribute('d'))
    .find((d) => { const p = samples(d).pop(); return Math.abs(p.x - b.x) < 0.01 && p.y <= b.y - b.r + 0.01 && p.y > b.y - b.r - 40; });
};
const drag = async (root, dx, dy) => {
  const heading = [...W.document.querySelectorAll('#graph-svg .gv-tree-title')].find((h) => h.dataset.graphRoot === root);
  heading.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 200, clientY: 200 }));
  W.dispatchEvent(new W.PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 200 + dx, clientY: 200 + dy }));
  W.dispatchEvent(new W.PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 200 + dx, clientY: 200 + dy }));
  await tick();
};

test('the fixture lays out as drawn in the header', () => {
  assert.deepEqual([at('p1').x, at('p4').x, at('x6').x, at('c9').x], [0, 130, 260, 390], 'four columns');
  assert.equal(at('a3').y, at('p4').y, 'the fork in column 0 and the fork in column 1 share a row');
  assert.equal(at('q1').y, at('s2').y + 16, 'column 1 of tree 2 is a caption\'s room lower than column 0');
  assert.ok(edgeInto('c9') && edgeInto('x6') && edgeInto('t1'), 'the three far elbows are drawn');
});

test('no edge passes through a node, a label, a caption or a heading — or along another edge', () => {
  const hit = strikes(W.document);
  assert.deepEqual(hit, [], hit.join('\n'));
  const shared = sharedRuns(W.document);
  assert.deepEqual(shared, [], 'two elbows share a sideways run:\n' + shared.join('\n'));
});

test('a3\'s elbow crosses columns 1 and 2 between their rows, not at the fork\'s glyph height', () => {
  const d = edgeInto('c9');
  const across = samples(d).filter((p) => p.x > at('p4').x - 20 && p.x < at('x6').x + 20);
  assert.ok(across.length, 'the elbow crosses the columns between');
  const p4 = at('p4');
  for (const p of across) assert.ok(p.y > p4.y + p4.r, `at x=${p.x.toFixed(1)} the run (y ${p.y.toFixed(1)}) is below p4's glyph`);
  assert.ok(d.startsWith(`M ${at('a3').x + at('a3').r * 0.7} `), 'it still leaves a3 from beside the glyph');
});

test('after a tree is dragged, its elbows move with it and still strike nothing', async () => {
  const before = { c9: at('c9'), d: edgeInto('c9') };
  await drag('r0', 37, 23);
  try {
    const moved = at('c9');
    assert.ok(moved.x !== before.c9.x && moved.y !== before.c9.y, 'the tree moved');
    const d = edgeInto('c9');
    assert.ok(d, 'the elbow still ends on c9');
    const [p0, q0] = [samples(before.d)[0], samples(d)[0]];
    assert.ok(Math.abs(q0.x - p0.x - (moved.x - before.c9.x)) < 0.01 && Math.abs(q0.y - p0.y - (moved.y - before.c9.y)) < 0.01,
      'the whole route shifted by the drag');
    const hit = strikes(W.document);
    assert.deepEqual(hit, [], hit.join('\n'));
    assert.deepEqual(sharedRuns(W.document), []);
  } finally {
    await drag('r0', -37, -23);
  }
});
