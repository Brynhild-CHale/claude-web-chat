// The box grab, chrome side (annotation engine 2C.4; U328c; public/app/
// box-grab.js), in the real chrome (test-support/chrome-shell, booted once):
// synthetic PointerEvents walk the overlay's one pointer dispatch and the
// input-mode policy, as the browser sends them.
//
// Pinned here:
//   - main.js imports and inits the module; the type is registered through
//     element-types.js with input 'strokes';
//   - a mouse or pen drag with box-grab armed draws the rubber band in
//     #el-layer and POSTs {type, anchor {v, kind: 'page', item, mount, rect,
//     box, viewport}, payload {shared: true, rect, box, meta}} through
//     http.js, every metadata field present, html clipped at 8 KB; the rect
//     is measured from the item's content box (a pane's .mount-host, never
//     its wrapper's header) and box is that content box's size (K.2-72);
//   - block snap (the default) rounds the box to the smallest element holding
//     it; free keeps the drawn box;
//   - a finger drag scrolls (the page's) and creates nothing unless
//     finger-draws is on;
//   - a box over the chrome around the page is refused with its hint;
//   - a cancelled gesture drops the band and posts nothing;
//   - a previewed node creates nothing;
//   - when the grab's queue item arrives with its picture, the look shows an
//     <img> of /api/elements/<id>/grab (the URL the rail card uses); an
//     item whose picture is still pending opens no look;
//     Discard deletes the element and its queue item; chrome-not-found shows
//     the hint and no picture;
//   - the rail draws the grab's item through its card (picture, Open, Re-send,
//     Remove, Show on page) and an item of an unregistered type as before;
//     a PARKED grab (the daemon's own GET /api/queue/pending projection)
//     draws through its card with Re-send enabled, which posts the resend
//     (K.2-71);
//   - nothing is drawn on the page for a sent grab, across a re-render;
//   - a grab in a scrolled content box (a rows-capped pane's .mount-host)
//     posts that box's scroll {top, left} beside box (K.2-80; U328e).
const test = require('node:test');
const { before, after, beforeEach } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');

const REPO = path.join(__dirname, '..');
const BIG = 'x'.repeat(5000) + 'é'.repeat(3000);   // > 8 KB of UTF-8

const PANE = {
  id: 'bg1', target: 'main', params: {}, gen: 0,
  html: `<div class="card"><p class="lead">Hello <b>world</b></p></div><div class="big">${BIG}</div>`,
};
const TYPES = {
  ok: true,
  types: [{ type: 'box-grab', schema: 'box-grab@1', reads: ['box-grab@1'], anchors: ['page'],
    toolbar: { input: 'strokes', settings: { small: { properties: { snap: { enum: ['block', 'free'], default: 'block' } } } } } }],
  reserved: ['comment', 'highlight', 'box-grab'],
};

let shell, W, M, ov, IM, BG, Q, TS, state;
let nextId = 7;
// GET /api/queue/pending's body, as the daemon's own route projects a park
// (parkedProjection): null until a test parks something.
let pendingBody = { pending: null };

// The daemon's GET /api/queue/pending answer for a park holding `items`, made
// by the route itself (lib/server/routes/queue.js, mounted alone on a recording
// app, judged as a local request) — never a hand-written copy of its shape, so
// the rail draws exactly the fields the daemon projects (K.2-71).
function parkedProjection(items) {
  const { mountQueueRoutes } = require('../lib/server/routes/queue');
  const handlers = {};
  const app = new Proxy({}, { get: (_, m) => (p, ...h) => { handlers[`${String(m).toUpperCase()} ${p}`] = h.at(-1); } });
  const state = { queue: [], pendingWake: { id: 'pw-1', created_at: 1, envelope: { meta: {} }, note: '', batch: items } };
  mountQueueRoutes(app, { state, bus: null, graph: null });
  let body = null;
  handlers['GET /api/queue/pending']({ query: {}, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, { json: (b) => { body = b; } });
  return body;
}

const posts = () => shell.calls.filter((c) => c.method === 'POST' && c.url === '/api/elements');
const callsOf = (method, url) => shell.calls.filter((c) => c.method === method && c.url === url);
const rootOf = () => M.itemEl(W.document, 'bg1').el.shadowRoot;
const wrapper = () => W.document.querySelector('.pane[data-pane-id="bg1"]');
const band = () => W.document.querySelector('#el-layer .bg-band');
const look = () => W.document.querySelector('.popover.bg-look');

function rects() {
  shell.scrollMetrics(wrapper(), { rect: { left: 100, top: 100, width: 600, height: 400 } });
  shell.scrollMetrics(wrapper().querySelector('.mount-host'), { rect: { left: 100, top: 130, width: 600, height: 370 } });
  const r = rootOf();
  shell.scrollMetrics(r.querySelector('.card'), { rect: { left: 120, top: 150, width: 300, height: 200 } });
  shell.scrollMetrics(r.querySelector('p.lead'), { rect: { left: 130, top: 160, width: 200, height: 40 } });
  shell.scrollMetrics(r.querySelector('p.lead b'), { rect: { left: 180, top: 165, width: 40, height: 20 } });
  shell.scrollMetrics(r.querySelector('.big'), { rect: { left: 450, top: 150, width: 200, height: 300 } });
}

function pe(el, type, pointerType, x, y, extra = {}) {
  el.dispatchEvent(new W.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerType, pointerId: extra.pointerId || 1, isPrimary: true,
    clientX: x, clientY: y, buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0, ...extra,
  }));
}
// A drag from (x0, y0) to (x1, y1): down, two moves, up, click.
function drag(el, pointerType, [x0, y0], [x1, y1], { midCheck = null } = {}) {
  pe(el, 'pointerdown', pointerType, x0, y0);
  pe(el, 'pointermove', pointerType, (x0 + x1) / 2, (y0 + y1) / 2);
  pe(el, 'pointermove', pointerType, x1, y1);
  if (midCheck) midCheck();
  pe(el, 'pointerup', pointerType, x1, y1);
  el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType, clientX: x1, clientY: y1 }));
}

function elementsRoute(url, init) {
  const method = String((init && init.method) || 'GET').toUpperCase();
  if (method === 'POST') return { ok: true, element: { id: `g${nextId++}`, v: 1, type: 'box-grab', shared: true } };
  return { elements: [{ id: 'g99', v: 1, type: 'box-grab', anchor: { v: 1, kind: 'page', item: 'bg1', mount: 'bg1' } }], next_cursor: 0 };
}

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/elements/types': TYPES,
      '/api/elements': elementsRoute,
      '/api/elements/*': { ok: true, removed: 'x' },
      '/api/queue/items/*': { ok: true, item: { id: 'q-r' } },
      '/api/queue/pending': () => pendingBody,
      '/api/queue/*': { ok: true, removed: 'x', count: 0 },
    },
  });
  W = shell.window;
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  IM = await shell.importApp('input-mode.js');
  BG = await shell.importApp('box-grab.js');
  Q = await shell.importApp('queue.js');
  TS = await shell.importApp('toolbar-state.js');
  ({ view: state } = await shell.importApp('state.js'));
  await shell.frame(helloFrame({ active: 'n1', mounts: [PANE] }));
  await shell.tick();
  rects();
});
after(async () => {
  if (ov) ov.setArmed(null);
  if (W) { W.localStorage.removeItem('wc:finger-draws'); W.localStorage.removeItem('wc:pen-seen'); }
  if (shell) await shell.restore();
});
beforeEach(async () => {
  ov.setArmed(null);
  BG._resetForTests();
  TS.applyToolbarFrame({ user: { settings: {} }, project: { settings: {} } });
  IM.setFingerDraws('off');
  shell.calls.length = 0;
  await shell.frame({ type: 'queue', op: 'clear' });
});

test('main.js imports and inits the box grab; the type is registered with input strokes', () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/main.js'), 'utf8');
  assert.match(src, /^import \{ initBoxGrab \} from '\.\/box-grab\.js';$/m);
  assert.equal((src.match(/^initBoxGrab\(\);/gm) || []).length, 1);
  assert.equal(ov.inputKindOf('box-grab'), 'strokes');
  const mine = fs.readFileSync(path.join(REPO, 'public/app/box-grab.js'), 'utf8');
  assert.ok(!/\bregisterType\(/.test(mine), 'through registerElementType, never the overlay directly');
  assert.ok(!/getContext\(|getDisplayMedia\(|toDataURL\(|toBlob\(|createElement\('canvas'\)/.test(mine), 'no image is rendered in the browser');
});

test('a mouse drag draws the rubber band and posts the grab, block-snapped, with every metadata field', async () => {
  ov.setArmed('box-grab');
  const lead = rootOf().querySelector('p.lead b');
  drag(lead, 'mouse', [185, 170], [215, 180], {
    midCheck: () => {
      const b = band();
      assert.ok(b, 'the band is drawn in #el-layer while the box is dragged');
      assert.deepEqual([b.style.left, b.style.top, b.style.width, b.style.height], ['185px', '170px', '30px', '10px']);
    },
  });
  assert.equal(band(), null, 'the band goes at the release');
  await shell.tick();
  const [p] = posts();
  assert.ok(p, 'one POST /api/elements');
  const body = p.body;
  assert.equal(body.type, 'box-grab');
  assert.equal(body.device, 'desktop', 'through http.js with the device claim');
  // Block: the smallest element holding the box is the <b> (180,165 40×20),
  // measured from the pane's CONTENT BOX, its .mount-host (100,130 600×370) —
  // not the wrapper (100,100), whose 30 px header the export has no copy of
  // (K.2-72: y 35, not 65).
  const rect = { x: 80, y: 35, w: 40, h: 20 };
  const box = { w: 600, h: 370 };
  // An unscrolled content box sends scroll 0/0: the shape is the same (K.2-80).
  const scroll = { top: 0, left: 0 };
  assert.deepEqual(body.anchor, { v: 1, kind: 'page', item: 'bg1', mount: 'bg1', rect, box, scroll, viewport: body.anchor.viewport });
  assert.deepEqual(body.payload.box, box, 'the payload carries the content box\'s size too');
  assert.deepEqual(body.payload.scroll, scroll, 'and its scroll');
  assert.deepEqual(Object.keys(body.anchor.viewport).sort(), ['dpr', 'h', 'w']);
  assert.equal(body.anchor.viewport.w, W.innerWidth);
  assert.equal(body.payload.shared, true);
  assert.deepEqual({ ...body.payload.rect, item: undefined, viewport: undefined, client: undefined },
    { ...rect, item: undefined, viewport: undefined, client: undefined });
  assert.equal(body.payload.rect.item, 'bg1');
  assert.deepEqual(body.payload.rect.client, { x: 180, y: 165, w: 40, h: 20 }, 'and relative to the viewport');
  const meta = body.payload.meta;
  for (const k of ['item_path', 'element_path', 'html', 'theme', 'mode', 'viewport']) assert.ok(k in meta, `meta.${k}`);
  assert.match(meta.item_path, /^#main > .*div\[data-pane-id="bg1"\]$/);
  assert.equal(meta.element_path, 'div.card:nth-of-type(1) > p.lead > b');
  assert.equal(meta.html, '<b>world</b>');
  assert.ok(meta.mode === 'light' || meta.mode === 'dark');
  assert.deepEqual(meta.viewport, body.anchor.viewport);
});

test('a pen drag posts; html is clipped at 8 KB; free snap keeps the drawn box', async () => {
  TS.applyToolbarFrame({ user: { settings: { 'box-grab': { snap: 'free' } } }, project: { settings: {} } });
  ov.setArmed('box-grab');
  const big = rootOf().querySelector('.big');
  drag(big, 'pen', [460, 200], [560, 260]);
  await shell.tick();
  const [p] = posts();
  assert.ok(p, 'the pen draws');
  assert.deepEqual(p.body.anchor.rect, { x: 360, y: 70, w: 100, h: 60 }, 'free: as drawn, from the content box');
  const html = p.body.payload.meta.html;
  assert.ok(html.startsWith('<div class="big">'));
  assert.ok(Buffer.byteLength(html, 'utf8') <= 8192, 'at most 8 KB');
  assert.ok(Buffer.byteLength(html, 'utf8') > 8190, 'clipped, not dropped');
  assert.equal(p.body.payload.meta.element_path, 'div.big:nth-of-type(2)');
});

test('block snap rounds a box spanning two children to the smallest element holding it', async () => {
  ov.setArmed('box-grab');
  drag(rootOf().querySelector('.card'), 'mouse', [125, 155], [300, 330]);
  await shell.tick();
  const [p] = posts();
  assert.deepEqual(p.body.anchor.rect, { x: 20, y: 20, w: 300, h: 200 }, 'the card\'s box, from the content box');
  assert.equal(p.body.payload.meta.element_path, 'div.card:nth-of-type(1)');
});

test('a finger drag creates nothing unless finger-draws is on', async () => {
  ov.setArmed('box-grab');
  const card = rootOf().querySelector('.card');
  IM.setFingerDraws('off');
  // The page keeps the finger: the well's touch-action pans it (no
  // finger-strokes class) and the press's default is left alone.
  assert.equal(W.document.documentElement.classList.contains('finger-strokes'), false, 'the well pans for a finger');
  const down = new W.PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerType: 'touch',
    pointerId: 1, isPrimary: true, clientX: 130, clientY: 160, buttons: 1 });
  card.dispatchEvent(down);
  assert.equal(down.defaultPrevented, false, 'a finger press keeps its default (the scroll)');
  card.dispatchEvent(new W.PointerEvent('pointercancel', { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', pointerId: 1 }));
  drag(card, 'touch', [130, 160], [300, 300], { midCheck: () => assert.equal(band(), null, 'no band') });
  await shell.tick();
  assert.equal(posts().length, 0, 'the page\'s (a scroll)');
  IM.setFingerDraws('on');
  drag(card, 'touch', [130, 160], [300, 300]);
  await shell.tick();
  assert.equal(posts().length, 1, 'finger-draws: the finger draws');
});

test('a box over the chrome around the page is refused with the hint', async () => {
  ov.setArmed('box-grab');
  const main = W.document.getElementById('main');
  drag(main, 'mouse', [10, 10], [60, 60]);
  await shell.tick();
  assert.equal(posts().length, 0);
  const noteEl = W.document.getElementById('reaim-note');
  assert.ok(noteEl && noteEl.textContent.includes(BG.CHROME_HINT), 'the hint is shown');
});

test('a cancelled gesture drops the band and posts nothing', async () => {
  ov.setArmed('box-grab');
  const lead = rootOf().querySelector('p.lead b');
  pe(lead, 'pointerdown', 'mouse', 185, 170);
  pe(lead, 'pointermove', 'mouse', 215, 180);
  assert.ok(band(), 'the band is up while the box is dragged');
  pe(lead, 'pointercancel', 'mouse', 215, 180);
  assert.equal(band(), null, 'a cancel takes the band down');
  await shell.tick();
  assert.equal(posts().length, 0, 'and nothing is posted');
});

test('a previewed node creates nothing', async () => {
  ov.setArmed('box-grab');
  state.previewing = true;
  try {
    drag(rootOf().querySelector('.card'), 'mouse', [125, 155], [300, 330], { midCheck: () => assert.equal(band(), null) });
    await shell.tick();
    assert.equal(posts().length, 0);
  } finally { state.previewing = false; }
});

async function grabAndSettle(image, qid) {
  ov.setArmed('box-grab');
  drag(rootOf().querySelector('p.lead b'), 'mouse', [185, 170], [215, 180]);
  await shell.tick();
  const id = posts().at(-1) && `g${nextId - 1}`;
  assert.deepEqual(BG._awaiting(), [id]);
  assert.equal(look(), null, 'nothing to look at before the picture settles');
  const item = { id: qid, kind: 'element', type: 'box-grab', element_id: id, v: 1, source: 'browser',
    why_wake: 'Box grab sent to Claude', summary: `Box grab · ${id}@1`, origin_mount: 'bg1', image, staged: true };
  await shell.frame({ type: 'queue', op: 'add', item });
  await shell.frame({ type: 'element:box-grab', elements: [] });
  await shell.tick();
  return { id, item };
}

test('when the picture settles the look shows it — the same URL as the rail card — and Discard removes both', async () => {
  const { id } = await grabAndSettle({ state: 'ready', capture: 'cap3', width: 40, height: 20, sha256: 'ab' }, 'q-1');
  const l = look();
  assert.ok(l, 'the look opens');
  const img = l.querySelector('img');
  assert.equal(img.getAttribute('src'), `/api/elements/${id}/grab`);
  const card = W.document.querySelector('#queue-rail .qi-card[data-type="box-grab"]');
  assert.ok(card, 'the rail draws the grab through its card');
  assert.equal(card.querySelector('img').getAttribute('src'), img.getAttribute('src'), 'the same picture');
  [...l.querySelectorAll('button')].find((b) => b.textContent === 'Discard').click();
  await shell.tick();
  assert.equal(look(), null);
  assert.equal(callsOf('DELETE', `/api/elements/${id}`).length, 1, 'the element is deleted');
  assert.equal(callsOf('DELETE', '/api/queue/q-1').length, 1, 'its queue item through the queue\'s removal');
});

test('an item whose picture is still pending opens no look; the grab keeps waiting', async () => {
  ov.setArmed('box-grab');
  drag(rootOf().querySelector('p.lead b'), 'mouse', [185, 170], [215, 180]);
  await shell.tick();
  const id = `g${nextId - 1}`;
  const item = { id: 'q-p', kind: 'element', type: 'box-grab', element_id: id, v: 1, source: 'browser',
    why_wake: 'Box grab sent to Claude', summary: `Box grab · ${id}@1`, origin_mount: 'bg1', image: { state: 'pending' }, staged: true };
  await shell.frame({ type: 'queue', op: 'add', item });
  await shell.frame({ type: 'element:box-grab', elements: [] });
  await shell.tick();
  assert.equal(look(), null, 'no look before the picture settles');
  assert.deepEqual(BG._awaiting(), [id], 'still waiting for its picture');
});

test('Keep in queue closes the look and keeps both', async () => {
  const { id } = await grabAndSettle({ state: 'ready', capture: 'cap4', width: 40, height: 20 }, 'q-2');
  [...look().querySelectorAll('button')].find((b) => b.textContent === 'Keep in queue').click();
  await shell.tick();
  assert.equal(look(), null);
  assert.equal(callsOf('DELETE', `/api/elements/${id}`).length, 0);
  assert.equal(callsOf('DELETE', '/api/queue/q-2').length, 0);
});

test('chrome-not-found shows the hint and no picture', async () => {
  const hint = 'No Chrome-family browser was found; install one.';
  await grabAndSettle({ state: 'chrome-not-found', capture: 'cap5', hint }, 'q-3');
  const l = look();
  assert.ok(l);
  assert.equal(l.querySelector('img'), null, 'no picture');
  assert.ok(l.textContent.includes(BG.METADATA_ONLY), 'Claude gets the metadata only');
  assert.ok(l.textContent.includes(hint));
  const card = W.document.querySelector('#queue-rail .qi-card[data-type="box-grab"]');
  assert.equal(card.querySelector('img'), null);
  assert.ok(card.textContent.includes(hint));
});

test('the grab\'s card: Open, Re-send, Remove, Show on page', async () => {
  const id = 'g50';
  const item = { id: 'q-50', kind: 'element', type: 'box-grab', element_id: id, v: 1, source: 'browser',
    why_wake: 'Box grab sent to Claude', summary: 'Box grab · g50@1', origin_mount: 'bg1',
    image: { state: 'ready', capture: 'cap9', width: 40, height: 20 }, staged: true };
  await shell.frame({ type: 'queue', op: 'add', item });
  await shell.tick();
  const card = W.document.querySelector('#queue-rail .qi-card[data-type="box-grab"]');
  assert.ok(card);
  const btn = (t) => [...card.querySelectorAll('button')].find((b) => b.textContent === t);
  for (const t of ['Open', 'Re-send', 'Remove', 'Show on page']) assert.ok(btn(t), t);
  assert.equal(card.querySelector('img').getAttribute('src'), `/api/elements/${id}/grab`);
  // Open: the look at full size, the same URL.
  btn('Open').click();
  assert.equal(look().querySelector('img').getAttribute('src'), `/api/elements/${id}/grab`);
  BG.closeLook();
  // Re-send: a queued item is sent by the next Push; a delivered one is
  // re-raised through the queue domain's route (K.2-17).
  assert.equal(btn('Re-send').disabled, true);
  assert.equal(btn('Re-send').title, BG.QUEUED_RESEND);
  assert.equal(await BG.resendItem('q-50'), true);
  assert.equal(callsOf('POST', '/api/queue/items/q-50/resend').length, 1);
  // Show on page: the pane it came from.
  shell.scrolls.length = 0;
  btn('Show on page').click();
  await shell.tick();
  assert.ok(shell.scrolls.some((s) => s.el === wrapper()), 'scrolled to the pane');
  // Remove: the queue's own removal.
  btn('Remove').click();
  await shell.tick();
  assert.equal(callsOf('DELETE', '/api/queue/q-50').length, 1);
  assert.equal(W.document.querySelector('#queue-rail .qi-card[data-type="box-grab"]'), null);
});

test('a parked grab (the daemon\'s pending projection) draws through its card with Re-send enabled, and Re-send posts the resend (K.2-71)', async () => {
  const { elementItem } = require('../lib/channel/policy');
  const item = { id: 'q-70', ...elementItem({ type: 'box-grab', id: 'g70', v: 1, mount: 'bg1',
    image: { state: 'ready', capture: 'cap7', path: 'captures/cap7.png', width: 40, height: 20 } }, { label: 'Box grab' }) };
  pendingBody = parkedProjection([item]);
  try {
    await Q.refreshPending();
    await shell.tick();
    const row = W.document.querySelector('#queue-rail .rail-item.parked[data-id="q-70"]');
    assert.ok(row, 'the parked row is drawn');
    const card = row.querySelector('.qi-card[data-type="box-grab"]');
    assert.ok(card, 'through the grab\'s card, not the generic row');
    assert.equal(card.querySelector('img').getAttribute('src'), '/api/elements/g70/grab', 'its picture');
    const resend = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Re-send');
    assert.equal(resend.disabled, false, 'Re-send is enabled on a parked row');
    resend.click();
    await shell.tick();
    assert.equal(callsOf('POST', '/api/queue/items/q-70/resend').length, 1, 'the click posts the resend');
  } finally {
    pendingBody = { pending: null };
    await Q.refreshPending();
    await shell.tick();
  }
});

test('a box over a pane\'s header alone is chrome: refused with the hint, nothing posted', async () => {
  TS.applyToolbarFrame({ user: { settings: { 'box-grab': { snap: 'free' } } }, project: { settings: {} } });
  ov.setArmed('box-grab');
  drag(wrapper().querySelector('.pane-header'), 'mouse', [150, 104], [300, 126]);
  await shell.tick();
  assert.equal(posts().length, 0, 'the header is not the pane\'s content');
  const noteEl = W.document.getElementById('reaim-note');
  assert.ok(noteEl && noteEl.textContent.includes(BG.CHROME_HINT), 'the hint is shown');
});

test('an item of an unregistered type is drawn as before', async () => {
  const other = { id: 'q-60', kind: 'element', type: 'sticker', element_id: 's1', v: 1, source: 'browser',
    why_wake: 'Sticker sent to Claude', summary: 'Sticker · s1@1', staged: true };
  const cap = { id: 'q-61', kind: 'capture', source: 'tab', capture_id: 'cap1', why_wake: 'page captured', summary: 'a page', staged: true };
  await shell.frame({ type: 'queue', op: 'add', item: other });
  await shell.frame({ type: 'queue', op: 'add', item: cap });
  await shell.tick();
  for (const id of ['q-60', 'q-61']) {
    const row = W.document.querySelector(`#queue-rail .rail-item[data-id="${id}"]`);
    assert.ok(row, id);
    assert.equal(row.querySelector('.qi-card'), null, 'no card');
    assert.ok(row.querySelector('.qi-why') && row.querySelector('.qi-summary'), 'the generic lines');
  }
});

test('nothing is drawn on the page for a sent grab, across a re-render', async () => {
  const GRAB = { id: 'g1', v: 1, type: 'box-grab', shared: true,
    anchor: { v: 1, kind: 'page', item: 'bg1', mount: 'bg1', rect: { x: 4, y: 6, w: 80, h: 40 }, viewport: { w: 1280, h: 800 } } };
  await shell.frame(helloFrame({ active: 'n1', mounts: [PANE], elements: [GRAB] }));
  await shell.tick();
  rects();
  await shell.frame({ type: 'render', id: 'bg1', target: 'main', html: PANE.html, params: {}, gen: 1 });
  await shell.tick();
  rects();
  await shell.frame({ ...helloFrame({ active: 'n1', mounts: [PANE], elements: [GRAB] }), type: 'reset' });
  await shell.tick();
  const layer = W.document.getElementById('el-layer');
  assert.equal(layer.querySelectorAll('.el-marker').length, 0, 'no marker');
  assert.equal(layer.querySelectorAll('.bg-band').length, 0, 'no band');
  assert.ok(ov.elementsOf('live').some((r) => r.id === 'g1'), 'the grab is listed');
  const st = ov.stats();
  assert.equal(st.anchors, 0, 'never resolved: the overlay places a page anchor nowhere');
  assert.equal(st.drawn, 0);
  assert.equal(st.orphans, 0, 'and never listed as an orphan');
});

test('a box over a markdown item grabs that item: its id, no mount, a path inside the block', async () => {
  await shell.frame({ type: 'markdown', id: 'md-bg', text: '## Notes\n\nA short line.', owner: 'claude', gen: 1,
    order: ['bg1', 'md-bg'], claude_order: ['bg1', 'md-bg'] });
  await shell.tick();
  try {
    const block = W.document.querySelector('[data-md-id="md-bg"]');
    assert.ok(block, 'the markdown block is on the page');
    const para = block.querySelector('p');
    shell.scrollMetrics(block, { rect: { left: 100, top: 520, width: 600, height: 80 } });
    shell.scrollMetrics(block.querySelector('h2'), { rect: { left: 100, top: 520, width: 600, height: 30 } });
    shell.scrollMetrics(para, { rect: { left: 100, top: 560, width: 600, height: 24 } });
    ov.setArmed('box-grab');
    drag(para, 'mouse', [110, 565], [300, 580]);
    await shell.tick();
    const [p] = posts();
    assert.ok(p, 'a markdown item is page, not chrome');
    assert.equal(p.body.anchor.item, 'md-bg');
    assert.equal(p.body.anchor.mount, null, 'markdown has no mount');
    assert.deepEqual(p.body.anchor.rect, { x: 0, y: 40, w: 600, h: 24 }, 'block: the paragraph, from the block\'s box');
    assert.deepEqual(p.body.anchor.box, { w: 600, h: 80 }, 'a markdown item\'s content box is its block');
    assert.deepEqual(p.body.payload.box, { w: 600, h: 80 });
    assert.match(p.body.payload.meta.item_path, /div\[data-md-id="md-bg"\]$/);
    assert.equal(p.body.payload.meta.element_path, 'p');
    assert.equal(p.body.payload.meta.html, '<p>A short line.</p>');
  } finally {
    await shell.frame({ type: 'markdown:remove', id: 'md-bg', order: ['bg1'], claude_order: ['bg1'] });
    await shell.tick();
  }
});

// K.2-80 (U328e): the rect is measured over what the content box has scrolled
// into view, so the box's own scroll offset rides beside box, in the anchor
// and the payload alike, for the daemon to scroll the export's box the same.
test('a grab in a scrolled .mount-host posts its scroll {top, left} beside box', async () => {
  rects();
  const host = wrapper().querySelector('.mount-host');
  shell.scrollMetrics(host, { scrollTop: 200, scrollLeft: 0 });
  try {
    assert.equal(host.scrollTop, 200);
    ov.setArmed('box-grab');
    drag(rootOf().querySelector('p.lead b'), 'mouse', [185, 170], [215, 180]);
    await shell.tick();
    const [p] = posts();
    assert.ok(p, 'one POST');
    assert.deepEqual(p.body.anchor.rect, { x: 80, y: 35, w: 40, h: 20 }, 'the rect as the viewer saw it, from the content box');
    assert.deepEqual(p.body.anchor.scroll, { top: 200, left: 0 });
    assert.deepEqual(p.body.payload.scroll, { top: 200, left: 0 });
    assert.deepEqual(p.body.anchor.box, { w: 600, h: 370 });
  } finally {
    host.scrollTop = 0;
    host.scrollLeft = 0;
  }
});
