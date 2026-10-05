// The chat dock's geometry (public/app/chat-dock.js), in plain node: jsdom
// cannot lay out, so the window's clamp and its saved prefs are pure functions
// (design spec §7.7, §10.1), and the module imports nothing that touches the
// DOM at load time — which this file also proves, by loading it with no DOM.
//
//   * clampWindow keeps a window inside the area for a move and for each of the
//     eight edge resizes, never below 320×300, and is pure: a geometry clamped
//     for a small area comes back unchanged for a larger one (the display clamp
//     on open and on a window resize never edits what was saved).
//   * A missing or malformed `wc:chat-window` value — a wrong version, a NaN, a
//     string, an accessor that throws — reads as the Final's defaults.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(REPO, 'public/app', rel)).href);

const DEFAULTS = { v: 1, mode: 'drawer', op: 1, hoverSolid: true, x: 760, y: 40, w: 420, h: 580 };
const AREA = { x: 0, y: 0, w: 1200, h: 700 };

let dock;
test.before(async () => {
  assert.equal(typeof globalThis.document, 'undefined', 'precondition: no DOM in this process');
  dock = await load('chat-dock.js');
});

const inside = (g, a) => g.x >= a.x && g.y >= a.y && g.x + g.w <= a.x + a.w && g.y + g.h <= a.y + a.h;

test('the module loads with no DOM, and its defaults are the Final\'s', () => {
  assert.deepEqual({ ...dock.WINDOW_DEFAULTS }, DEFAULTS);
  assert.equal(dock.WINDOW_KEY, 'wc:chat-window');
  assert.equal(dock.isChatOpen(), false, 'nothing is open before initChatDock');
  assert.equal(dock.dockEl, null);
  assert.equal(dock.initChatDock(), null, 'with no document there is no dock to init');
});

test('clampWindow: a geometry already inside the area is returned as it is', () => {
  const g = { x: 100, y: 50, w: 420, h: 580 };
  assert.deepEqual(dock.clampWindow(g, AREA), g);
});

test('clampWindow: a move is kept inside the area on every side, at its own size', () => {
  const size = { w: 420, h: 400 };
  const cases = [
    [{ x: -300, y: 50 }, { x: 0, y: 50 }],
    [{ x: 1000, y: 50 }, { x: 780, y: 50 }],
    [{ x: 100, y: -90 }, { x: 100, y: 0 }],
    [{ x: 100, y: 690 }, { x: 100, y: 300 }],
    [{ x: 5000, y: 5000 }, { x: 780, y: 300 }],
  ];
  for (const [from, to] of cases) {
    const g = dock.clampWindow({ ...from, ...size }, AREA);
    assert.deepEqual(g, { ...to, ...size }, `a move to ${JSON.stringify(from)}`);
    assert.ok(inside(g, AREA));
  }
  // A move through gestureGeom: the drag's travel, then the same clamp.
  const start = { x: 100, y: 100, w: 420, h: 400 };
  assert.deepEqual(dock.gestureGeom(start, null, 50, 20, AREA), { x: 150, y: 120, w: 420, h: 400 });
  assert.deepEqual(dock.gestureGeom(start, null, 5000, -5000, AREA), { x: 780, y: 0, w: 420, h: 400 });
});

test('clampWindow: each of the eight edges resizes inside the area, and the edges it does not name stay put', () => {
  const start = { x: 300, y: 200, w: 420, h: 400 };
  const right = start.x + start.w;    // 720
  const bottom = start.y + start.h;   // 600
  // Dragged far outward: the named edges stop at the area's border.
  const out = {
    n: { x: 300, y: 0, w: 420, h: bottom },
    s: { x: 300, y: 200, w: 420, h: 500 },
    e: { x: 300, y: 200, w: 900, h: 400 },
    w: { x: 0, y: 200, w: right, h: 400 },
    ne: { x: 300, y: 0, w: 900, h: bottom },
    nw: { x: 0, y: 0, w: right, h: bottom },
    se: { x: 300, y: 200, w: 900, h: 500 },
    sw: { x: 0, y: 200, w: right, h: 500 },
  };
  const far = { n: [0, -5000], s: [0, 5000], e: [5000, 0], w: [-5000, 0] };
  for (const [edge, want] of Object.entries(out)) {
    let dx = 0, dy = 0;
    for (const c of edge) { dx += far[c][0]; dy += far[c][1]; }
    const g = dock.gestureGeom(start, edge, dx, dy, AREA);
    assert.deepEqual(g, want, `${edge}, dragged outward`);
    assert.ok(inside(g, AREA), `${edge} stays inside`);
  }
  // Dragged far inward: the window stops at 320×300, the far edges anchored.
  const inward = {
    n: { x: 300, y: bottom - 300, w: 420, h: 300 },
    s: { x: 300, y: 200, w: 420, h: 300 },
    e: { x: 300, y: 200, w: 320, h: 400 },
    w: { x: right - 320, y: 200, w: 320, h: 400 },
    ne: { x: 300, y: bottom - 300, w: 320, h: 300 },
    nw: { x: right - 320, y: bottom - 300, w: 320, h: 300 },
    se: { x: 300, y: 200, w: 320, h: 300 },
    sw: { x: right - 320, y: 200, w: 320, h: 300 },
  };
  for (const [edge, want] of Object.entries(inward)) {
    let dx = 0, dy = 0;
    for (const c of edge) { dx -= far[c][0]; dy -= far[c][1]; }
    assert.deepEqual(dock.gestureGeom(start, edge, dx, dy, AREA), want, `${edge}, dragged inward past the minimum`);
  }
  // A modest resize is exactly the pointer's travel.
  assert.deepEqual(dock.gestureGeom(start, 'se', 30, 40, AREA), { x: 300, y: 200, w: 450, h: 440 });
  assert.deepEqual(dock.gestureGeom(start, 'nw', -30, -40, AREA), { x: 270, y: 160, w: 450, h: 440 });
});

test('clampWindow: never below 320×300, even in an area smaller than that', () => {
  const tiny = { x: 0, y: 0, w: 200, h: 150 };
  const g = dock.clampWindow({ x: 50, y: 50, w: 420, h: 580 }, tiny);
  assert.deepEqual(g, { x: 0, y: 0, w: 320, h: 300 }, 'the least size wins, at the area\'s start');
  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', null]) {
    const r = dock.clampWindow({ x: 10, y: 10, w: 100, h: 100 }, AREA, { edge });
    assert.ok(r.w >= 320 && r.h >= 300, `${edge}: at least 320×300`);
    assert.ok(inside(r, AREA), `${edge}: and inside`);
  }
  const custom = dock.clampWindow({ x: 0, y: 0, w: 10, h: 10 }, AREA, { minW: 200, minH: 120 });
  assert.deepEqual(custom, { x: 0, y: 0, w: 200, h: 120 }, 'the minimums are options');
});

test('clampWindow is pure: a geometry clamped for a small area is restored unchanged for a larger one', () => {
  const saved = Object.freeze({ x: 760, y: 40, w: 420, h: 580 });
  const small = dock.clampWindow(saved, { x: 0, y: 0, w: 700, h: 500 });
  assert.deepEqual(small, { x: 280, y: 0, w: 420, h: 500 }, 'shrunk and slid to fit the small area');
  const big = dock.clampWindow(saved, { x: 0, y: 0, w: 1600, h: 900 });
  assert.deepEqual(big, { ...saved }, 'the saved geometry, untouched, in a larger area');
  assert.notEqual(big, saved, 'a new object');
  // An offset area (its own origin) is honoured.
  assert.deepEqual(dock.clampWindow({ x: 0, y: 0, w: 400, h: 300 }, { x: 20, y: 30, w: 800, h: 600 }),
    { x: 20, y: 30, w: 400, h: 300 });
});

// ── the saved prefs ──────────────────────────────────────────────────────────

// A stand-in for the browser's storage: `raw` is what getItem answers, or
// `throws: true` makes the accessor itself throw (a private window, site data
// blocked). Returns the function that puts the global back.
function fakeStorage({ raw = null, throws = false } = {}) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = {
    getItem: () => raw,
    setItem: (k, v) => { raw = v; },
    removeItem: () => { raw = null; },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { if (throws) throw new Error('SecurityError: the operation is insecure'); return store; },
  });
  return () => {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete globalThis.localStorage;
  };
}

test('a missing or malformed wc:chat-window reads as the Final\'s defaults', (t) => {
  const bad = [
    null,                                                     // missing
    'not json at all',
    JSON.stringify('a string'),
    JSON.stringify(42),
    JSON.stringify([1, 2, 3]),
    JSON.stringify({ ...DEFAULTS, v: 2 }),                    // a wrong version
    JSON.stringify({ ...DEFAULTS, v: undefined }),
    JSON.stringify({ ...DEFAULTS, mode: 'sheet' }),
    JSON.stringify({ ...DEFAULTS, x: 'left' }),
    JSON.stringify({ ...DEFAULTS, w: -5 }),
    JSON.stringify({ ...DEFAULTS, hoverSolid: 'yes' }),
    JSON.stringify({ ...DEFAULTS, op: null }),                // NaN serialises to null
  ];
  for (const raw of bad) {
    const restore = fakeStorage({ raw });
    try { assert.deepEqual(dock.readWindowPrefs(), DEFAULTS, `read from ${raw}`); } finally { restore(); }
  }
  // NaN itself, which JSON cannot carry, through the normalizer.
  assert.deepEqual(dock.normalizeWindowPrefs({ ...DEFAULTS, y: NaN }), DEFAULTS);
  assert.deepEqual(dock.normalizeWindowPrefs({ ...DEFAULTS, h: Infinity }), DEFAULTS);
  // An accessor that throws.
  t.after(fakeStorage({ throws: true }));
  assert.deepEqual(dock.readWindowPrefs(), DEFAULTS, 'a throwing accessor');
});

test('a well-formed wc:chat-window reads back as saved, its opacity held to 25–100 %', (t) => {
  const saved = { v: 1, mode: 'window', op: 0.6, hoverSolid: false, x: 12, y: 34, w: 500, h: 600 };
  t.after(fakeStorage({ raw: JSON.stringify(saved) }));
  assert.deepEqual(dock.readWindowPrefs(), saved);
  assert.equal(dock.normalizeWindowPrefs({ ...saved, op: 0.05 }).op, 0.25);
  assert.equal(dock.normalizeWindowPrefs({ ...saved, op: 3 }).op, 1);
  assert.deepEqual(Object.keys(dock.normalizeWindowPrefs({ ...saved, extra: 'x' })).sort(),
    Object.keys(DEFAULTS).sort(), 'unknown fields are dropped');
});
