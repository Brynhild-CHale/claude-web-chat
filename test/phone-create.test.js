// The phone's create affordance (annotation engine 2A.4, the phone half;
// readiness R2 S-2: 0 tap-reachable create affordances on a phone, the pin
// button hidden with #dock; rulings H-3 (a) and U334-U308 (b)). Feeds GT-07's
// "≥ 1 tap-reachable phone create affordance, 0 markers over chrome in all 5
// states"; the check on a real phone is the maintainer's (E3), not this file's.
//
// The real chrome (test-support/chrome-shell, booted once, as an upright
// phone), app.css read through test-support/css-cascade against the shell's
// window. jsdom lays nothing out, so the test owns the geometry: #topbar and
// #bottombar get rectangles (the sheet measures its stops from them), the
// overlay's box reads are stubbed (initOverlay({rectOf})) and its frames run on
// a fake scheduler the test flushes, as test/overlay-clip.test.js does.
//
// Pinned here:
//   - #bb-tools, the bottom bar's tool slot, sits between the up/down arrows
//     (and ↩ active) and Graph in the spacer's place, outside #dock; its one
//     stand-in entry #bb-create is shown by the cascade at the phone layout,
//     a 44px target, while #btn-pin-mode is not; the slot grows; above 760px
//     the bar and its slot are hidden;
//   - a tap on #bb-create arms the comment pin mode (body.pin-mode), a second
//     disarms it, Escape leaves it; while previewing it stays off (setPinMode's
//     refusal); the pressed look is read off body.pin-mode;
//   - tools are content: at the phone layout (layoutLocked() true) a tap on a
//     static pane element in pin mode opens the pin composer. A tap on a
//     pane's CONTROL is U334's interactive-content row (DECISIONS.md K.2-9),
//     measured by GT-21's i1-input rows, not here;
//   - 0 markers painted over chrome: with the overlay drawing anchored test
//     elements top to bottom of a tall page, stepped through the well's scroll
//     range in each of the five sheet states (closed, half, full, Tasks →
//     Queue, the keyboard), no drawn marker's painted box meets the bottom bar
//     at all, and none meets the sheet, the rail or the keyboard band unless
//     chrome painting ABOVE the overlay's layer covers it — S-2's measure
//     (elementFromPoint in headless Chrome) as paint order: the rung each
//     stacking context takes in the root context, read off app.css; in the
//     half and full states markers do lie under the sheet (the check is not
//     vacuous);
//   - RESERVED_IDS has 'bb-tools' and 'bb-create'.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { createCascade } = require('../test-support/css-cascade');
const { RESERVED_IDS } = require('../lib/server/domain/mounts');

const REPO = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');

const PHONE = { width: 390, height: 844, coarse: true, visualHeight: 844, visualTop: 0 };
const DESKTOP = { width: 1280, height: 800, coarse: false, visualHeight: 800, visualTop: 0 };
const TOP_H = 44;
const BAR_H = 60;
const AVAIL = PHONE.height - TOP_H - BAR_H;      // the well: under the topbar, over the bottom bar
const BAR_TOP = TOP_H + AVAIL;

// The page: one tall pane of paragraphs, an anchored element on every other one.
const PARAS = 40;
const PARA_GAP = 60;
const MAIN_H = 40 + PARAS * PARA_GAP;
const PAGE_PANE = {
  id: 'pc-page', target: 'main', params: {},
  html: Array.from({ length: PARAS }, (_, i) => `<p class="para">paragraph number ${i}</p>`).join(''),
};

let rev = 0;
function snapshot() {
  rev += 1;
  return {
    v: 1, enabled: true, now: Date.now(), rev, content: true, access: { level: 'local', remote: false },
    capabilities: { queue_message: true }, primary: 'c1', aggregate: { state: 'idle' }, tasks: [], asks: [],
    conversations: [{ id: 'c1', rev: 1, title: 'Session c1', headless: false,
      live: { state: 'idle', since: Date.now() - 60000, last_activity_at: Date.now() - 1000 } }],
  };
}

let shell, W, doc, $, css, M, ov, anchors, sheet, topbar, comments, mountsMod;

// ── the fake scheduler and clock the overlay draws on ──────────────────────
const queue = [];
let clock = 0;
const fakeRaf = (fn) => { queue.push(fn); return queue.length; };
function flush(max = 20000) {
  let n = 0;
  while (queue.length && n < max) { queue.shift()(clock); n++; }
  assert.ok(n < max, 'the overlay settles to no pending frame');
  return n;
}

// ── the geometry ────────────────────────────────────────────────────────────
const geo = { scroll: 0 };
const rectFns = new Map();
const DEFAULT_BOX = { left: 0, top: -1000, width: 0, height: 0 };
function rect(r) { return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height }; }
function rectOf(x) {
  clock += 0.01;
  const f = rectFns.get(x);
  return rect(f ? f() : DEFAULT_BOX);
}
const WELL = { left: 0, top: TOP_H, width: PHONE.width, height: AVAIL };
const mainBox = () => ({ left: 0, top: TOP_H - geo.scroll, width: PHONE.width, height: MAIN_H });
const paraBox = (i) => ({ left: 16, top: mainBox().top + 20 + i * PARA_GAP, width: 300, height: 20 });
const box = (r) => ({ left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height });
const meet = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
const empty = (b) => !(b.right > b.left && b.bottom > b.top);
const within = (inner, outer) => inner.left >= outer.left && inner.top >= outer.top
  && inner.right <= outer.right && inner.bottom <= outer.bottom;

function layout() {
  shell.scrollMetrics($('topbar'), { rect: { top: 0, height: TOP_H, width: PHONE.width } });
  shell.scrollMetrics($('bottombar'), { rect: { top: BAR_TOP, height: BAR_H, width: PHONE.width } });
}

// ── the cascade: what shows, and on which rung it paints ───────────────────
// A property's value: the inline declaration, else the stylesheet's winner,
// with var() resolved against the element and its ancestors (where app.css
// and chat-sheet.js put their custom properties).
function valueOf(el, prop) {
  const inline = el.style && el.style.getPropertyValue(prop);
  return resolve(el, inline || css.value(el, prop));
}
function resolve(el, v) {
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/.exec(String(v == null ? '' : v).trim());
  if (!m) return v == null ? null : String(v).replace(/\s*!important$/, '').trim();
  for (let n = el; n; n = n.parentElement) {
    const own = (n.style && n.style.getPropertyValue(m[1])) || css.value(n, m[1]);
    if (own) return resolve(n, own);
  }
  return m[2] != null ? resolve(el, m[2]) : null;
}
// Shown: neither the element nor an ancestor is display: none.
function shown(el) {
  for (let n = el; n && n !== doc.documentElement; n = n.parentElement) {
    if (valueOf(n, 'display') === 'none') return false;
  }
  return true;
}
// The z-index its outermost stacking context takes in the root context — the
// order the chrome's rungs (--z-pins 4 under --z-topbar 5 under --z-chat 6)
// paint in. A positioned element with a z-index, or a fixed one, forms a
// context; none on the way up is the root's own layer, 0.
function rung(el) {
  let top = null;
  for (let n = el; n && n !== doc.body && n !== doc.documentElement; n = n.parentElement) {
    const pos = valueOf(n, 'position') || 'static';
    const z = valueOf(n, 'z-index');
    if (pos === 'fixed' || pos === 'sticky' || (pos !== 'static' && z != null && z !== 'auto')) top = n;
  }
  if (!top) return 0;
  const z = Number(valueOf(top, 'z-index'));
  return Number.isFinite(z) ? z : 0;
}

// The chrome's boxes in a sheet state, read off what chat-sheet.js and
// sheet-keyboard.js wrote (--sheet-h, --chat-top, --sheet-frac, --kb-top/--kb-h)
// and the app.css rules that place them (U68's and U71's sections).
function px(el, name) { const v = parseFloat(el.style.getPropertyValue(name)); return Number.isFinite(v) ? v : 0; }
function chromeBoxes({ band = null } = {}) {
  const pull = $('chat-pull');
  const scrim = $('chat-scrim');
  const rail = $('queue-rail');
  const out = [];
  out.push({ name: 'bottombar', el: $('bottombar'), box: { left: 0, top: BAR_TOP, right: PHONE.width, bottom: PHONE.height } });
  if (pull && shown(pull)) {
    const kb = pull.classList.contains('kb');
    const top = kb ? px(pull, '--kb-top') : BAR_TOP - px(pull, '--sheet-h');
    const bottom = kb ? top + px(pull, '--kb-h') : BAR_TOP;
    if (bottom > top) out.push({ name: 'chat-pull', el: pull, box: { left: 0, top, right: PHONE.width, bottom } });
  }
  if (scrim && shown(scrim) && px(scrim, '--sheet-frac') > 0) {
    out.push({ name: 'chat-scrim', el: scrim, box: { left: 0, top: px(scrim, '--chat-top'), right: PHONE.width, bottom: BAR_TOP }, coverOnly: true });
  }
  if (rail && shown(rail)) {
    // In the sheet (Tasks → Queue) the rail fills the sheet's page; in .body,
    // the narrow rule's queue screen covers the well.
    const inPull = pull && pull.contains(rail);
    const b = inPull ? out.find((c) => c.name === 'chat-pull') : { box: box(WELL) };
    if (b) out.push({ name: 'queue-rail', el: rail, box: { ...b.box } });
  }
  if (band) out.push({ name: 'keyboard band', el: null, box: band });
  return out;
}

const layer = () => $('el-layer');
const markers = () => [...layer().querySelectorAll('.el-marker')].filter((m) => m.style.display !== 'none');
// The painted glyph: the anchor point plus the transform offset, its size,
// less the clip-path's insets (as test/overlay-clip.test.js reads it).
function paintedBox(m) {
  const x = parseFloat(m.style.left);
  const y = parseFloat(m.style.top);
  const t = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(m.style.transform) || [0, 0, 0];
  const ins = /inset\(([\d.]+)px ([\d.]+)px ([\d.]+)px ([\d.]+)px\)/.exec(m.style.clipPath || '') || [0, 0, 0, 0, 0];
  const [it, ir, ib, il] = ins.slice(1).map(Number);
  const gx = x + Number(t[1]);
  const gy = y + Number(t[2]);
  return { left: gx + il, top: gy + it, right: gx + parseFloat(m.style.width) - ir, bottom: gy + parseFloat(m.style.height) - ib };
}

before(async () => {
  shell = await bootShell({
    viewport: PHONE,
    routes: {
      '/api/graph': { nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }, { id: 'n2', label: 'n2', parent_id: 'n1', created_at: 2 }], active: 'n1' },
      '/api/mirror': () => snapshot(),
    },
  });
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
  css = createCascade(CSS, { win: () => W });
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  anchors = (await shell.importApp('anchors.js')).default;
  sheet = await shell.importApp('chat-sheet.js');
  topbar = await shell.importApp('topbar.js');
  comments = await shell.importApp('comments.js');
  mountsMod = await shell.importApp('mounts.js');
  const { bus } = await shell.importApp('bus.js');
  let read = false;
  const off = bus.on('mirror', (d) => { if (d && Array.isArray(d.what) && d.what.includes('all')) read = true; });
  try {
    await shell.frame(helloFrame({ mounts: [PAGE_PANE] }));
    await waitUntil(() => read, { timeout: 5000, what: 'the store to read GET /api/mirror' });
  } finally { off(); }
  layout();
  const wrap = doc.querySelector('.well-wrap');
  wrap.style.overflow = 'auto';
  rectFns.set(wrap, () => WELL);
  rectFns.set($('main'), mainBox);
  ov.initOverlay({ rectOf, raf: fakeRaf, now: () => clock });
  await shell.tick();
  flush();
});

after(async () => { if (shell) await shell.restore(); });

const bbCreate = () => $('bb-create');
const pinOn = () => doc.body.classList.contains('pin-mode');

/* ── the place ─────────────────────────────────────────────────────────────── */

test('the tool slot sits in the bottom bar between the arrows and Graph, outside #dock, shown at the phone layout', () => {
  assert.ok(doc.documentElement.classList.contains('phone'), 'the shell boots as a phone');
  const bar = $('bottombar');
  const slot = $('bb-tools');
  const entry = bbCreate();
  assert.ok(slot && entry, 'the slot and its stand-in entry exist');
  assert.equal(slot.getAttribute('role'), 'toolbar');
  assert.equal(slot.getAttribute('aria-label'), 'Annotation tools');
  assert.equal(entry.parentElement, slot, 'the entry is the slot\'s');
  assert.ok(bar.contains(entry), 'inside #bottombar');
  assert.ok(!$('dock').contains(entry), 'outside #dock');
  assert.equal(entry.getAttribute('aria-label'), 'Pin comment');
  const follows = (a, b) => !!(a.compareDocumentPosition(b) & W.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(follows(bar.querySelector('.bb-stepper'), slot), 'after the up/down arrows');
  assert.ok(follows($('bb-return'), slot), 'after ↩ active');
  assert.ok(follows(slot, $('bb-graph')), 'before Graph');
  assert.equal(bar.querySelector('.tb-spacer'), null, 'the slot takes the spacer\'s place');

  assert.equal(valueOf(bar, 'display'), 'flex', 'the bar shows under 760px');
  assert.ok(shown(entry), 'the entry is shown by the cascade at the phone layout');
  assert.ok(!shown($('btn-pin-mode')), '#btn-pin-mode is not (.phone #dock)');
  assert.equal(valueOf(slot, 'flex'), '1 1 0', 'the slot grows as the spacer did');
  assert.equal(valueOf(slot, 'justify-content'), 'center', 'and centres what it holds');
  assert.equal(valueOf(entry, 'width'), '44px', 'a thumb\'s target');
  assert.equal(valueOf(entry, 'height'), '44px');
});

test('above 760px the bottom bar and its slot are hidden', async () => {
  shell.setViewport(DESKTOP);
  await shell.tick();
  try {
    assert.ok(!doc.documentElement.classList.contains('phone'));
    assert.equal(valueOf($('bottombar'), 'display'), 'none');
    assert.ok(!shown($('bb-tools')) && !shown(bbCreate()), 'the slot goes with the bar');
    assert.ok(shown($('btn-pin-mode')), 'the desktop keeps its pin button in #dock');
  } finally {
    shell.setViewport(PHONE);
    await shell.tick();
    layout();
  }
  assert.ok(shown(bbCreate()));
});

test('RESERVED_IDS holds the slot and its entry', () => {
  assert.ok(RESERVED_IDS.has('bb-tools'));
  assert.ok(RESERVED_IDS.has('bb-create'));
});

/* ── the entry ─────────────────────────────────────────────────────────────── */

test('a tap on the entry arms comment pin mode, a second disarms it, Escape leaves it', () => {
  comments.setPinMode(false);
  assert.equal(css.value(bbCreate(), 'background'), 'var(--wc-panel-bg)', 'unpressed');
  shell.press(bbCreate());
  assert.ok(pinOn(), 'the first tap arms pin mode');
  assert.equal(css.value(bbCreate(), 'background'), 'var(--wc-accent)', 'the pressed look is read off body.pin-mode');
  shell.press(bbCreate());
  assert.ok(!pinOn(), 'the second tap disarms it');
  shell.press(bbCreate());
  assert.ok(pinOn());
  shell.key('Escape');
  assert.ok(!pinOn(), 'Escape leaves pin mode (handleEscape)');
});

test('while previewing the entry stays off (setPinMode refuses in a preview)', async () => {
  comments.setPinMode(false);
  await topbar.previewNode('n2');
  await shell.tick();
  try {
    assert.ok(mountsMod.contentReadOnly(), 'a preview is up');
    shell.press(bbCreate());
    assert.ok(!pinOn(), 'no pin mode over a preview');
  } finally {
    topbar.returnToActive();
    await shell.tick();
  }
  assert.ok(!mountsMod.contentReadOnly());
  shell.press(bbCreate());
  assert.ok(pinOn(), 'back on the live page it arms again');
  comments.setPinMode(false);
});

test('tools are content: at the phone layout a tap on a static pane element in pin mode opens the pin composer', async () => {
  assert.ok(mountsMod.layoutLocked(), 'the phone\'s layout is locked');
  comments.setPinMode(false);
  shell.press(bbCreate());
  assert.ok(pinOn());
  const para = M.itemEl(doc, 'pc-page').el.shadowRoot.querySelectorAll('.para')[3];
  try {
    shell.press(para);
    await shell.tick();
    const pop = doc.querySelector('.pin-pop');
    assert.ok(pop, 'the pin composer opens');
    assert.ok(pop.querySelector('.pin-text'), 'a composer, not a thread');
    assert.match(pop.querySelector('.pin-anchor').textContent, /p\.para|paragraph number 3/, 'anchored on the tapped paragraph');
  } finally {
    comments.closePinPop();
    comments.setPinMode(false);
  }
});

/* ── 0 markers over chrome, in the five sheet states ──────────────────────── */

async function drawPage() {
  const root = M.itemEl(doc, 'pc-page').el.shadowRoot;
  const els = [...root.querySelectorAll('.para')];
  // The pane's elements as mounted now (a preview's return remounts it).
  els.forEach((el, i) => rectFns.set(el, () => paraBox(i)));
  const rows = [];
  for (let i = 0; i < PARAS; i += 2) {
    rows.push({ id: `c${i}`, v: 1, type: 'comment', anchor: anchors.record(root, els[i], { mount: 'pc-page' }), shared: true, replies: 0 });
  }
  ov.setElements('live', rows);
  await waitUntil(() => { flush(); return ov.stats().anchors >= rows.length; }, { timeout: 5000, what: `${rows.length} answers` });
  flush();
  assert.equal(ov.orphans().length, 0, 'every anchor resolves');
  return rows.length;
}

// Step the well through its scroll range; count, per drawn marker, whether it
// meets a chrome box, whether chrome above the overlay's layer covers that
// meeting, and whether it paints over the bottom bar at all.
function sweep(state, { band = null } = {}) {
  // The chrome does not move with the well's scroll: read once per state.
  const layerRung = rung(layer());
  const layerShown = shown(layer());
  const chrome = chromeBoxes({ band });
  const coverers = chrome.filter((c) => c.el && rung(c.el) > layerRung);
  const tally = { state, steps: 0, drawn: 0, overChrome: 0, underChrome: 0, meetsBar: 0, over: [],
    layerShown, chrome: chrome.map((c) => c.name), coverers: coverers.map((c) => c.name) };
  const range = MAIN_H - AVAIL;
  for (geo.scroll = 0; geo.scroll <= range; geo.scroll += 20) {
    ov.requestDraw();
    flush();
    tally.steps++;
    if (!layerShown) continue;     // the layer is hidden whole: nothing paints
    for (const m of markers()) {
      const p = paintedBox(m);
      if (empty(p)) continue;
      tally.drawn++;
      let under = false;
      for (const c of chrome) {
        if (c.coverOnly) continue;
        const hit = meet(p, c.box);
        if (empty(hit)) continue;
        if (c.name === 'bottombar') tally.meetsBar++;
        if (coverers.some((k) => within(hit, k.box))) { under = true; continue; }
        tally.overChrome++;
        tally.over.push(`${m.dataset.elIds} over ${c.name} at scroll ${geo.scroll}`);
      }
      if (under) tally.underChrome++;
    }
  }
  geo.scroll = 0;
  ov.requestDraw();
  flush();
  return tally;
}

test('0 markers painted over the bottom bar, the sheet, the rail or the keyboard band in all five sheet states', async () => {
  layout();
  const n = await drawPage();
  assert.ok(n >= 10);
  // The rungs the measure stands on, read off app.css: the layer under the
  // bottom bar and the sheet.
  const layerRung = rung(layer());
  assert.ok(layerRung > 0, `#el-layer paints on a rung (${layerRung})`);
  assert.ok(rung($('bottombar')) > layerRung, 'the bottom bar paints above the layer');
  assert.ok(rung($('chat-pull')) > layerRung, 'the sheet paints above the layer');

  const results = [];
  try {
    sheet.closeSheet({ returnFocus: false });
    await shell.tick();
    assert.equal(sheet.sheetState().stop, 'closed');
    results.push(sweep('closed'));

    const st = sheet.sheetState();
    sheet.setStop(st.stops.half, { view: 'chat' });
    await shell.tick();
    assert.equal(sheet.sheetState().stop, 'half');
    results.push(sweep('half'));

    sheet.setStop(sheet.sheetState().stops.full, { view: 'chat' });
    await shell.tick();
    assert.equal(sheet.sheetState().stop, 'full');
    results.push(sweep('full'));

    sheet.setStop(sheet.sheetState().stops.full, { view: 'tasks', page: 'queue' });
    await shell.tick();
    await waitUntil(() => $('chat-pull').contains($('queue-rail')), { timeout: 2000, what: 'the rail to move into Tasks → Queue' });
    assert.equal(sheet.sheetState().page, 'queue');
    results.push(sweep('tasks-queue'));

    // The keyboard: the sheet at half on Chat, the composer focused, the
    // visual viewport 300px short; the band below it is the keyboard.
    sheet.setStop(sheet.sheetState().stops.half, { view: 'chat' });
    await shell.tick();
    const input = $('chat-composer-input');
    assert.ok(input && $('chat-sheet').contains(input), 'the composer is in the sheet');
    input.focus();
    const visualHeight = PHONE.height - 300;
    shell.setViewport({ visualHeight, visualTop: 0 });
    await shell.tick();
    await waitUntil(() => $('chat-pull').classList.contains('kb'), { timeout: 2000, what: 'the sheet\'s keyboard mode' });
    layout();
    results.push(sweep('keyboard', { band: { left: 0, top: visualHeight, right: PHONE.width, bottom: PHONE.height } }));
  } finally {
    const a = doc.activeElement;
    if (a && a !== doc.body && typeof a.blur === 'function') a.blur();
    shell.setViewport({ visualHeight: PHONE.height, visualTop: 0 });
    await shell.tick();
    sheet.closeSheet({ returnFocus: false });
    await shell.tick();
    ov.setElements('live', []);
    flush();
  }

  const by = Object.fromEntries(results.map((r) => [r.state, r]));
  for (const r of results) {
    assert.deepEqual(r.over, [], `${r.state}: no marker paints over chrome`);
    assert.equal(r.overChrome, 0);
    assert.equal(r.meetsBar, 0, `${r.state}: no marker box meets the bottom bar (the well's clip)`);
  }
  for (const s of ['closed', 'half', 'full']) assert.ok(by[s].drawn > 0, `${s}: markers are drawn`);
  assert.equal(by.closed.underChrome, 0, 'closed: nothing lies under the sheet');
  assert.ok(by.half.underChrome > 0, 'half: markers lie under the sheet, painted beneath it');
  assert.ok(by.full.underChrome > by.half.underChrome, 'full: more of them');
  assert.equal(by.keyboard.drawn > 0 ? by.keyboard.overChrome : 0, 0, 'keyboard: none over the band or the sheet');
});
