// A point anchor end to end in the LIVE chrome (annotation engine tranche 4,
// U532; PLAN.md 4C.1, DECISIONS.md C5, RULED U531-U532@point-record-kind a):
// the real public/index.html and public/app module graph (test-support/
// chrome-shell, booted once in before()), a stub daemon behind the element
// routes, and the overlay's box reads, frames and clock stubbed through
// initOverlay({rectOf, raf, now, clips}) — jsdom does no layout, so the test
// owns the geometry: the page well, the svg's box (the target-frame walk reads
// the element's own getBoundingClientRect, the overlay reads rectOf — both
// answer the same live object) and a displayed frame.
//
// Pinned here, in order:
//   - a pen tap on an svg at its 1,280 px layout pins a point (the svg's
//     element record, kind 'point', x/y/aspect beside) with the svg's 0.8.5
//     locator, and the daemon's answer is drawn at once;
//   - the marker's anchor point is within 0.5 px of anchors.pointAt over the
//     svg's box, wholly inside the page well's clip, and its glyph meets no
//     displayed frame — at 1,280 px and again after the box changes to its
//     390 × 844 layout (F4 s1 at the 4C gate; GT-07's page half);
//   - a second point whose glyph lands on the displayed frame at 390 px is not
//     drawn (the never-draw rule), and is drawn again back at 1,280 px;
//   - no script-error frame went to the daemon, and no interval was armed.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame, DEFAULT_ROUTES } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

let shell, W, doc, M, ov, comments, anchors;
let intervalsAtBoot = 0;

// ── the geometry ────────────────────────────────────────────────────────────
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
const WIDE = { well: rect(0, 48, 1280, 752), svg: rect(300, 200, 640, 360), frame: rect(1000, 700, 200, 60) };
// The phone layout: the svg stacked to the column, 16 px gutters; the frame
// (an answer frame) over the svg's top-right corner.
const NARROW = { well: rect(0, 48, 390, 796), svg: rect(16, 300, 358, 201.375), frame: rect(300, 280, 80, 30) };
const POS = { ...WIDE };
const VIEW = rect(0, 0, 1280, 800);
let clock = 0;
function rectOf(x) {
  clock += 0.01;
  const key = x && x.dataset && x.dataset.pin;
  return key && POS[key] ? POS[key] : VIEW;
}
const rafQ = [];
const fakeRaf = (fn) => { rafQ.push(fn); return rafQ.length; };
function flush(max = 10000) { let n = 0; while (rafQ.length && n < max) { rafQ.shift()(0); n++; } return n; }
async function settle(n = 4) { for (let i = 0; i < n; i++) { await shell.tick(); flush(); } }

// ── the stub daemon ─────────────────────────────────────────────────────────
const live = new Map();
const posts = [];
let nextId = 1;
function elementsRoute(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  if (method === 'POST') {
    const b = JSON.parse(init.body);
    posts.push(b);
    const pin = { id: `c${300 + nextId++}`, v: 1, seq: nextId, type: 'comment', text: b.payload.text, shared: b.payload.shared !== false,
      replies: [], anchor: b.anchor, locator: b.locator, record: b.anchor };
    live.set(pin.id, pin);
    return { ok: true, element: pin, pin };
  }
  return { elements: [...live.values()], next_cursor: 9 };
}
const PANE = { id: 'fig', target: 'main', params: {},
  html: '<p class="cap">Figure 1</p><svg class="plot" data-pin="svg" width="640" height="360" viewBox="0 0 640 360">'
    + '<rect class="bg" x="0" y="0" width="640" height="360"></rect><circle class="dot" cx="160" cy="180" r="12"></circle></svg>' };

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/elements': elementsRoute,
      '/api/elements/types': DEFAULT_ROUTES['/api/elements/types'],
      '/api/elements/*': { ok: true },
    },
  });
  W = shell.window;
  doc = shell.document;
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  comments = await shell.importApp('comments.js');
  anchors = (await shell.importApp('anchors.js')).default;
  ov.initOverlay({ rectOf, raf: fakeRaf, now: () => clock, clips: () => false });
  await shell.frame(helloFrame({ active: 'n1', mounts: [PANE] }));
  await settle();
  doc.getElementById('main').dataset.pin = 'well';
  const frame = doc.createElement('iframe');
  frame.dataset.pin = 'frame';
  doc.body.appendChild(frame);
  svg().getBoundingClientRect = () => POS.svg;
  await settle();
  intervalsAtBoot = shell.intervals().length;
});
after(() => {
  if (ov) ov.setArmed(null);
  return shell.restore();
});

const root = () => M.itemEl(doc, 'fig').el.shadowRoot;
const svg = () => root().querySelector('svg');
const markerOf = (id) => [...doc.querySelectorAll('#el-layer .el-marker')].find((m) => (m.dataset.elIds || '').split(' ').includes(id)) || null;
const GLYPH = { dx: -13, dy: -26, w: 26, h: 26 };
const meets = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const glyphBox = (p) => ({ left: p.x + GLYPH.dx, top: p.y + GLYPH.dy, right: p.x + GLYPH.dx + GLYPH.w, bottom: p.y + GLYPH.dy + GLYPH.h });
const ids = [];

async function penPin(x, y, pointerId) {
  ov.setArmed('comment');
  const n = posts.length;
  const el = root().querySelector('circle');
  const pe = (type) => el.dispatchEvent(new W.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: 'pen',
    pointerId, isPrimary: true, clientX: x, clientY: y, buttons: type === 'pointerdown' ? 1 : 0 }));
  pe('pointerdown');
  pe('pointerup');
  el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType: 'pen', pointerId, clientX: x, clientY: y }));
  const pop = doc.querySelector('.pin-pop');
  assert.ok(pop && pop.querySelector('.pin-text'), 'the pen opened the composer');
  pop.querySelector('.pin-text').value = `point ${pointerId}`;
  shell.click(pop.querySelector('.pin-save'));
  await waitUntil(() => posts.length === n + 1, { what: 'the POST' });
  ov.setArmed(null);
  return posts.at(-1);
}
// Each id's marker at pointAt over the svg's box now, wholly inside the well's
// clip, its glyph clear of the displayed frame.
function assertPlaced(id, label) {
  const m = markerOf(id);
  const pin = live.get(id);
  const p = anchors.pointAt(pin.anchor, POS.svg);
  assert.ok(m && m.style.display === '', `${label}: ${id} drawn`);
  assert.ok(Math.abs(parseFloat(m.style.left) - p.x) <= 0.5 && Math.abs(parseFloat(m.style.top) - p.y) <= 0.5,
    `${label}: ${id}'s anchor point within 0.5 px of pointAt (${m.style.left}, ${m.style.top} vs ${p.x}, ${p.y})`);
  assert.equal(m.style.clipPath, '', `${label}: wholly inside the well's clip`);
  const g = glyphBox(p);
  const w = POS.well;
  assert.ok(g.left >= w.left && g.right <= w.right && g.top >= w.top && g.bottom <= w.bottom, `${label}: the glyph inside the well`);
  assert.ok(!meets(g, POS.frame), `${label}: never over the displayed frame`);
}
const placed = (id) => {
  const m = markerOf(id);
  const pin = live.get(id);
  const p = pin && anchors.pointAt(pin.anchor, POS.svg);
  return !!m && !!p && m.style.display === '' && Math.abs(parseFloat(m.style.left) - p.x) <= 0.5 && Math.abs(parseFloat(m.style.top) - p.y) <= 0.5;
};

test('a pen tap on the svg at its 1,280 px layout pins a point with the svg\'s locator, drawn at pointAt inside the well', async () => {
  const body = await penPin(300 + 0.25 * 640, 200 + 0.5 * 360, 81);
  assert.equal(body.anchor.kind, 'point');
  assert.deepEqual([body.anchor.x, body.anchor.y, body.anchor.aspect], [0.25, 0.5, 1.7778]);
  assert.equal(body.anchor.mount, 'fig');
  assert.deepEqual(body.locator, { mount: 'fig', selector: 'svg.plot', text: '', ordinal: 0 }, 'the svg\'s 0.8.5 locator');
  ids.push([...live.keys()].at(-1));
  const second = await penPin(300 + 0.9 * 640, 200 + 0.1 * 360, 82);
  assert.equal(second.anchor.kind, 'point');
  ids.push([...live.keys()].at(-1));
  await waitUntil(async () => { await settle(1); return ids.every(placed); }, { what: 'both points drawn at 1,280 px' });
  for (const id of ids) assertPlaced(id, '1280');
});

test('the svg\'s box changes to its 390 × 844 layout: the point follows; the one landing on the displayed frame is not drawn; back at 1,280 both draw', async () => {
  const [a, b] = ids;
  Object.assign(POS, NARROW);
  shell.setViewport({ width: 390, height: 844, coarse: true });
  try {
    ov.requestDraw();
    await waitUntil(async () => { await settle(1); return placed(a) && markerOf(b) && markerOf(b).style.display === 'none'; },
      { what: 'the point re-placed at 390 px, the framed one hidden' });
    assertPlaced(a, '390');
    const pb = anchors.pointAt(live.get(b).anchor, POS.svg);
    assert.ok(meets(glyphBox(pb), POS.frame), 'precondition: the second point\'s glyph meets the frame at 390 px');
  } finally {
    Object.assign(POS, WIDE);
    shell.setViewport({ width: 1280, height: 800, coarse: false });
  }
  ov.requestDraw();
  await waitUntil(async () => { await settle(1); return ids.every(placed); }, { what: 'both drawn again at 1,280 px' });
  for (const id of ids) assertPlaced(id, '1280 again');
});

test('no script-error frame reached the daemon, and no interval was armed', () => {
  const errors = shell.sockets.flatMap((s) => s.frames('script:error'));
  assert.deepEqual(errors, [], 'no pane script failed');
  assert.equal(shell.intervals().length, intervalsAtBoot, 'no interval armed since boot');
});
