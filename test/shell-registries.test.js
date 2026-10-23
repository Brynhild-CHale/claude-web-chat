// The shell's registries (PLAN.md 2A.4; readiness R2 §3 rows 5, 11, 12), against
// the real chrome booted once in jsdom (test-support/chrome-shell):
//
//   * the popover registry in the ONE dismiss layer (verdict S-18): a
//     shadow-rooted `.popover` was invisible to OPEN_PANELS — it survived
//     Escape and an outside press — and closePanel grew by a special case per
//     panel that closes by more than `.hidden`. A registered popover closes
//     through the one layer, and the five former special cases are entries;
//   * multi-producer node marks (X-15): setNodeMarker held ONE marker, so a
//     second producer overwrote graph-turns' ↶;
//   * row caps for element rows (S-19: 5.6 ms per keystroke at 500 rows, 21.7
//     at 2000): a palette source is capped through row-caps.js, and the rail is
//     bounded by the daemon's MAX_QUEUE, held at most the cap here;
//   * the per-type queue card registration (K.2-11, K.2-18): the type supplies
//     the card the rail draws an element item through, the engine owns the item.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { MAX_QUEUE } = require('../lib/server/domain/queue');

const REPO = path.resolve(__dirname, '..');
const T = Date.UTC(2026, 9, 6, 14, 2, 0);

// n1 ── n2 ── n3 (active); n2 has rewound turns, so graph-turns marks it ↶.
const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: T - 60000 },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: T - 50000, name: 'fork here' },
  { id: 'n3', label: 'n1.2', parent_id: 'n2', created_at: T - 40000 },
  { id: 'n4', label: 'n1.1.0', parent_id: 'n2', created_at: T - 30000 },
];
const SUMMARIES = { n2: { turns: 2, superseded: 1, rewound_at: T }, n3: { turns: 0, superseded: 0 } };
// The queue at boot: one element item of a type that will register a card, and
// one of a type that never does.
const QUEUE = {
  items: [
    { id: 'q-el-1', kind: 'element', type: 'test-card', element_id: 'g1', v: 1, summary: 'a grab of the chart', source: 'browser', staged: true },
    { id: 'q-el-2', kind: 'element', type: 'no-card', element_id: 'h2', v: 1, summary: 'a highlight', source: 'browser', staged: true },
  ],
  count: 2,
};

let shell, W, $, gv, gt, S, shellMod, rowCaps;
let rev = 100;
const snapshot = () => ({ v: 1, enabled: true, now: Date.now(), rev: ++rev, content: true,
  access: { level: 'local', remote: false }, capabilities: {}, primary: null, aggregate: { state: 'idle' },
  conversations: [], tasks: [], asks: [] });

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/graph': () => ({ nodes: NODES.map((n) => ({ ...n })), active: 'n3' }),
      '/api/graph/node/*': (url) => {
        const id = decodeURIComponent(url.split('?')[0].split('/').pop());
        const n = NODES.find((x) => x.id === id) || NODES[0];
        return { ...n, author: 'claude', trigger: { message: 'a turn' }, mounts: [], store: {} };
      },
      '/api/queue': () => JSON.parse(JSON.stringify(QUEUE)),
      '/api/mirror': () => snapshot(),
      '/api/mirror/nodes': () => ({ nodes: SUMMARIES, rev: 7 }),
      '/api/mirror/node/*': () => ({ node: {}, turns: [], rev: 7 }),
    },
    init: async (sh) => {
      gt = await sh.importApp('graph-turns.js');
      gt.initGraphTurns();
    },
  });
  W = shell.window;
  $ = shell.$;
  gv = await shell.importApp('graph-view.js');
  S = await shell.importApp('chat-state.js');
  shellMod = await shell.importApp('shell.js');
  rowCaps = await shell.importApp('row-caps.js');
  const want = rev + 1;
  await shell.frame(helloFrame({ active: 'n3' }));
  await waitUntil(() => S.mirror.rev >= want, { timeout: 2000, what: 'the mirror snapshot' });
  await waitUntil(() => W.document.querySelector('.rail-item[data-id="q-el-1"]'), { timeout: 2000, what: 'the queue rail' });
});

after(async () => {
  if (gt) gt.stopGraphTurns();
  await shell.restore();
});

const isOpen = (el) => !!el && el.isConnected && !el.classList.contains('hidden');
const pointerdown = (target) => target.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }));

/* ── (1) the popover registry ─────────────────────────────────────────────── */

// The S-18 pair: a body-appended light .popover the selector sees, and a
// popover inside a shadow root that only the registry can see.
function s18Pair() {
  const light = W.document.createElement('div');
  light.className = 'popover';
  light.id = 'test-light-pop';
  light.textContent = 'light';
  W.document.body.appendChild(light);

  const host = W.document.createElement('div');
  host.id = 'test-shadow-host';
  W.document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const trigger = W.document.createElement('button');
  trigger.setAttribute('aria-controls', 'test-shadow-pop');
  trigger.textContent = 'toggle';
  const pop = W.document.createElement('div');
  pop.className = 'popover';
  pop.id = 'test-shadow-pop';
  const inner = W.document.createElement('span');
  inner.textContent = 'inside';
  pop.appendChild(inner);
  root.append(trigger, pop);
  let closes = 0;
  const off = shellMod.registerPopover({ el: pop, close: () => { closes++; pop.classList.add('hidden'); } });
  trigger.addEventListener('click', () => pop.classList.toggle('hidden'));
  const reopen = () => { light.classList.remove('hidden'); pop.classList.remove('hidden'); };
  const cleanup = () => { off(); light.remove(); host.remove(); };
  return { light, pop, inner, trigger, reopen, cleanup, closes: () => closes };
}

test('registerPopover: Escape closes a body-appended .popover and a shadow-rooted registered one alike', () => {
  const p = s18Pair();
  try {
    assert.ok(isOpen(p.light) && isOpen(p.pop), 'precondition: both open');
    shell.key('Escape');
    assert.ok(!isOpen(p.light), 'the light popover closed');
    assert.ok(!isOpen(p.pop), 'the shadow-rooted popover closed through the one layer');
    assert.equal(p.closes(), 1, 'through its own close, once');
  } finally { p.cleanup(); }
});

test('registerPopover: an outside press closes both; a press inside the shadow-rooted one keeps it', () => {
  const p = s18Pair();
  try {
    pointerdown(p.inner);
    assert.ok(isOpen(p.pop), 'a press inside the shadow-rooted popover is inside it (the composed path holds it)');
    assert.ok(!isOpen(p.light), 'and is outside the light one, which closed');
    p.reopen();
    pointerdown(W.document.body);
    assert.ok(!isOpen(p.light), 'an outside press closed the light popover');
    assert.ok(!isOpen(p.pop), 'and the shadow-rooted one');
  } finally { p.cleanup(); }
});

test('registerPopover: the trigger\'s own toggle still opens and closes it (the aria-controls skip, in its own root)', () => {
  const p = s18Pair();
  try {
    p.light.classList.add('hidden');
    shell.press(p.trigger);
    assert.ok(!isOpen(p.pop), 'the trigger closed it — the dismiss pass skipped the panel it owns');
    assert.equal(p.closes(), 0, 'the layer did not close it under the toggle');
    shell.press(p.trigger);
    assert.ok(isOpen(p.pop), 'and opens it again');
  } finally { p.cleanup(); }
});

test('registerPopover: unregistered, the shadow-rooted popover is invisible to the layer again; a bad spec throws', () => {
  const p = s18Pair();
  p.cleanup();   // unregisters; re-attach the host to see the layer ignore it
  W.document.body.appendChild(p.pop.getRootNode().host);
  try {
    shell.key('Escape');
    assert.ok(isOpen(p.pop), 'no entry: Escape does not reach it');
  } finally { p.pop.getRootNode().host.remove(); }
  assert.throws(() => shellMod.registerPopover({ close() {} }), TypeError);
  assert.throws(() => shellMod.registerPopover({ el: W.document.body }), TypeError);
});

test('registerPopover: a getter el, a custom contains and isOpen; the window blur closes an entry through its close', async () => {
  let built = null, closes = 0, open = false;
  const off = shellMod.registerPopover({
    el: () => built,
    isOpen: () => open,
    contains: (target, pathList) => pathList.includes(built) || target === $('topbar'),
    close: () => { closes++; open = false; },
  });
  try {
    built = W.document.createElement('div');
    W.document.body.appendChild(built);
    open = true;
    pointerdown($('topbar'));
    assert.ok(open, 'its contains() says a press on the topbar is inside it');
    W.dispatchEvent(new W.Event('blur'));
    await shell.tick(5);
    assert.equal(open, false, 'the window blur closed it');
    assert.equal(closes, 1);
  } finally { off(); if (built) built.remove(); }
});

test('the five former special cases are registry entries: closePanel has no per-panel branch', () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/shell.js'), 'utf8');
  const body = /function closePanel\(el\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(body, 'closePanel is found');
  assert.doesNotMatch(body[0], /el\.id === |classList\.contains\('pin-pop'\)/, 'no special case left in closePanel');
  for (const [el, close] of [
    ["document.querySelector('.pin-pop')", 'closePinPop'], ["$('drawer')", 'closeDrawer'],
    ["$('cmd-palette')", 'closePalette'], ["$('replay-pop')", 'closeReplay'], ["$('pane-history')", 'closePaneHistory'],
  ]) {
    const line = `registerPopover({ el: () => ${el}, close: () => ${close}() });`;
    assert.ok(src.includes(line), `registered: ${line}`);
  }
});

test('the palette closes through its entry exactly as before: an outside press hides it and drops the input\'s focus', async () => {
  shellMod.openPalette();
  await shell.tick(5);
  const inp = $('cmd-input');
  assert.ok(isOpen($('cmd-palette')));
  assert.equal(W.document.activeElement, inp, 'precondition: the input holds focus');
  pointerdown(W.document.body);
  assert.ok(!isOpen($('cmd-palette')), 'closed');
  assert.notEqual(W.document.activeElement, inp, 'and the input was blurred (closePalette, not a bare .hidden)');
});

/* ── (2) multi-producer node marks ────────────────────────────────────────── */

const glyph = (id) => W.document.querySelector(`#graph-svg g.gv-node[data-id="${id}"]`);
const markIn = (el) => el && el.querySelector(':scope > .gv-rewound');

test('node marks: graph-turns\' ↶ and a second producer coexist on one node; each removes only its own', async () => {
  if (!gv.isOverlayOpen()) await gv.openOverlay();
  await waitUntil(() => markIn(glyph('n2')), { timeout: 3000, what: 'graph-turns\' ↶ on n1.1' });
  const turnsMark = markIn(glyph('n2'));
  const turnsTitle = turnsMark.querySelector('title').textContent;
  assert.ok(turnsMark.textContent.startsWith('↶'));

  let refreshed = 0;
  const off = gv.setNodeMarker({
    mark: (id) => (id === 'n2' ? { text: '◆', title: 'two highlights' } : null),
    refresh: async () => { refreshed++; return false; },
  }, { producer: 'test' });
  try {
    gv.layoutAndRender();
    const both = markIn(glyph('n2'));
    assert.ok(both.textContent.startsWith('↶'), 'graph-turns registered first: its glyph first');
    assert.ok(both.textContent.includes(' ◆'), 'the second glyph, after a thin space');
    assert.equal(both.querySelector('title').textContent, `${turnsTitle} · two highlights`, 'both titles, joined by " · "');
    assert.equal(markIn(glyph('n3')), null, 'a node neither producer marks stays bare');

    // refreshMarker refreshes every producer (graph-view's refreshGraph calls it)
    const before_ = refreshed;
    await shell.tick(2100);
    await gv.refreshGraph();
    await shell.tick(5);
    assert.equal(refreshed, before_ + 1, 'the test producer was asked to refresh too');

    // a producer replaces only its own
    const off2 = gv.setNodeMarker({ mark: (id) => (id === 'n2' ? { text: '✦', title: '' } : null) }, { producer: 'test' });
    gv.layoutAndRender();
    assert.ok(markIn(glyph('n2')).textContent.includes(' ✦'));
    assert.ok(!markIn(glyph('n2')).textContent.includes('◆'), 'the replaced marker is gone');
    assert.ok(markIn(glyph('n2')).textContent.startsWith('↶'), 'and graph-turns\' is kept');
    off();   // the replaced registration's unregister is a no-op
    gv.layoutAndRender();
    assert.ok(markIn(glyph('n2')).textContent.includes('✦'), 'a stale unregister removes nothing');
    off2();
    gv.layoutAndRender();
    const only = markIn(glyph('n2'));
    assert.equal(only.textContent, turnsMark.textContent, 'unregistering one producer leaves the other');
    assert.equal(only.querySelector('title').textContent, turnsTitle);
  } finally { off(); }
});

test('node marks: the one-argument form is producer "default" — graph-turns\' own call, which a default re-registration replaces', async () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/graph-turns.js'), 'utf8');
  assert.match(src, /setNodeMarker\(\{ mark, refresh \}\)/, 'graph-turns uses the one-argument form, unchanged');
  if (!gv.isOverlayOpen()) await gv.openOverlay();
  const off = gv.setNodeMarker({ mark: (id) => (id === 'n3' ? { text: '★', title: 'default' } : null) });
  try {
    gv.layoutAndRender();
    assert.equal(markIn(glyph('n2')), null, 'the one-argument form replaced the default producer (graph-turns\')');
    assert.equal(markIn(glyph('n3')).firstChild.nodeValue, '★');
  } finally { off(); }
  // put graph-turns' marker back the way it registers
  gt.stopGraphTurns();
  gt.initGraphTurns();
  gv.closeOverlay();
});

/* ── (3) row caps ─────────────────────────────────────────────────────────── */

test('capRows: under, at and over the cap; ELEMENT_ROW_CAP is 1000; the rail is bounded by MAX_QUEUE ≤ the cap', () => {
  const { capRows, ELEMENT_ROW_CAP, moreLabel } = rowCaps;
  assert.equal(ELEMENT_ROW_CAP, 1000, 'between S-19\'s 500 and 2000 readings');
  const list = (n) => Array.from({ length: n }, (_, i) => i);
  assert.deepEqual(capRows(list(3), 5), { rows: [0, 1, 2], more: 0 }, 'under');
  assert.deepEqual(capRows(list(5), 5), { rows: [0, 1, 2, 3, 4], more: 0 }, 'at');
  assert.deepEqual(capRows(list(8), 5), { rows: [0, 1, 2, 3, 4], more: 3 }, 'over');
  assert.equal(capRows(list(1500)).rows.length, ELEMENT_ROW_CAP, 'the default cap');
  assert.deepEqual(capRows(null, 5), { rows: [], more: 0 }, 'not a list: nothing');
  const l = list(2);
  assert.notEqual(capRows(l, 5).rows, l, 'a copy, never the caller\'s array');
  assert.equal(moreLabel(500), '+500 more — type to narrow');
  assert.ok(Number.isInteger(MAX_QUEUE) && MAX_QUEUE <= ELEMENT_ROW_CAP,
    `the daemon's MAX_QUEUE (${MAX_QUEUE}) bounds the rail at or under ELEMENT_ROW_CAP (${ELEMENT_ROW_CAP}), so the rail needs no cap of its own`);
});

const paletteRows = () => [...$('cmd-list').querySelectorAll('.palette-item')];
async function typeInPalette(q) {
  const inp = $('cmd-input');
  inp.value = q;
  inp.dispatchEvent(new W.Event('input', { bubbles: true }));
}
const elementRows = (n) => Array.from({ length: n }, (_, i) => ({
  kind: 'element', label: `highlight h${i} · a note on row ${i}`, hint: 'n1.2', run: () => {},
}));

test('S-19: a registered source of 500 element rows — every keystroke builds and renders under a generous jsdom bound', async (t) => {
  const rows = elementRows(500);
  let asked = [];
  const off = shellMod.registerPaletteSource('elements', { rows: (q) => { asked.push(q); return rows; } });
  try {
    shellMod.openPalette();
    await waitUntil(() => paletteRows().filter((r) => r.dataset.kind === 'element').length === 500,
      { timeout: 2000, what: 'the 500 element rows' });
    const own = paletteRows().length - 500;
    assert.ok(own > 0, 'the palette\'s own rows come first');
    assert.equal(paletteRows()[own].dataset.kind, 'element', 'the source\'s rows follow them');
    const times = [];
    for (const q of ['h', 'hi', 'hig', 'high', 'highl', 'highli', 'highlig', 'highligh', 'highlight']) {
      const t0 = performance.now();
      await typeInPalette(q);
      await waitUntil(() => asked.at(-1) === q && paletteRows().filter((r) => r.dataset.kind === 'element').length === 500,
        { timeout: 2000, interval: 0, what: `the rows for "${q}"` });
      times.push(performance.now() - t0);
    }
    const worst = Math.max(...times);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    // A diagnostic, not a gate: GT-07's < 16 ms is a real browser's line, and
    // the time here includes the poll that sees the rows land.
    t.diagnostic(`S-19 in jsdom: ${times.length} keystrokes over 500 element rows, mean ${mean.toFixed(1)} ms, worst ${worst.toFixed(1)} ms`);
    // Generous: jsdom on Node 22 reads ~100 ms a keystroke on a quiet machine,
    // and the full suite runs files side by side.
    assert.ok(worst < 2500, `a keystroke's build and render stays under a generous jsdom bound (worst ${worst.toFixed(1)} ms)`);

    // narrowing: the palette's one match applies to a source's rows too
    await typeInPalette('h42 ');
    await waitUntil(() => asked.at(-1) === 'h42 ', { timeout: 2000, what: 'the narrowed build' });
    await shell.tick(5);
    assert.deepEqual(paletteRows().filter((r) => r.dataset.kind === 'element').map((r) => r.querySelector('.label').textContent),
      ['highlight h42 · a note on row 42'], 'one row matches');
  } finally {
    off();
    pointerdown(W.document.body);
  }
});

test('S-19: 1500 rows show ELEMENT_ROW_CAP rows and one "+500 more" row, which keeps the palette open', async () => {
  const { ELEMENT_ROW_CAP } = rowCaps;
  const off = shellMod.registerPaletteSource('elements', { rows: () => elementRows(1500) });
  const offSmall = shellMod.registerPaletteSource('few', { rows: () => elementRows(30).map((r) => ({ ...r, kind: 'few' })), cap: 10 });
  try {
    shellMod.openPalette();
    await waitUntil(() => paletteRows().some((r) => /more — type to narrow/.test(r.textContent)), { timeout: 2000, what: 'the capped rows' });
    const all = paletteRows();
    assert.equal(all.filter((r) => r.dataset.kind === 'element').length, ELEMENT_ROW_CAP, 'the cap');
    const more = all.filter((r) => /more — type to narrow/.test(r.textContent));
    assert.deepEqual(more.map((r) => r.querySelector('.label').textContent), ['+500 more — type to narrow', '+20 more — type to narrow'],
      'one more row per capped source, a source\'s own cap honoured');
    assert.deepEqual(more.map((r) => r.dataset.kind), ['elements', 'few'], 'a more row is in its source\'s name');
    assert.equal(all.filter((r) => r.dataset.kind === 'few').length, 11, 'the few source\'s 10, and its more row');
    more[0].dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    assert.ok(isOpen($('cmd-palette')), 'the more row stands for rows; choosing it keeps the palette up');
  } finally {
    off(); offSmall();
    pointerdown(W.document.body);
  }
  assert.throws(() => shellMod.registerPaletteSource('', { rows: () => [] }), TypeError);
  assert.throws(() => shellMod.registerPaletteSource('x', {}), TypeError);
});

test('a palette source that throws is skipped; unregistered, its rows are gone', async () => {
  const offBad = shellMod.registerPaletteSource('bad', { rows: () => { throw new Error('boom'); } });
  const off = shellMod.registerPaletteSource('elements', { rows: () => elementRows(3) });
  const errs = [];
  const err = console.error;
  console.error = (...a) => errs.push(a);
  try {
    shellMod.openPalette();
    await waitUntil(() => paletteRows().filter((r) => r.dataset.kind === 'element').length === 3, { timeout: 2000, what: 'the rows' });
    assert.ok(errs.some((a) => /palette source 'bad'/.test(String(a[0]))), 'the failure is reported');
    off(); offBad();
    await typeInPalette('');
    await shell.tick(5);
    assert.equal(paletteRows().filter((r) => r.dataset.kind === 'element').length, 0, 'gone');
  } finally {
    console.error = err;
    pointerdown(W.document.body);
  }
});

/* ── (4) queue cards per element type ─────────────────────────────────────── */

const railRow = (id) => W.document.querySelector(`.rail-item[data-id="${id}"]`);

test('registerQueueCard: queueCardOf answers the registered card; the last registration wins and its unregister restores the one before', () => {
  const a = { render() {} }, b = { render() {} };
  assert.equal(shellMod.queueCardOf('reg-test'), null, 'an unregistered type answers null');
  const offA = shellMod.registerQueueCard('reg-test', a);
  assert.equal(shellMod.queueCardOf('reg-test'), a);
  const offB = shellMod.registerQueueCard('reg-test', b);
  assert.equal(shellMod.queueCardOf('reg-test'), b, 'the second registration wins');
  offB();
  assert.equal(shellMod.queueCardOf('reg-test'), a, 'its unregister restores the first');
  offB();
  assert.equal(shellMod.queueCardOf('reg-test'), a, 'a second unregister is a no-op');
  offA();
  assert.equal(shellMod.queueCardOf('reg-test'), null);
  assert.equal(shellMod.queueCardOf('other'), null);
  assert.throws(() => shellMod.registerQueueCard('', a), TypeError);
  assert.throws(() => shellMod.registerQueueCard('t', {}), TypeError);
});

test('the rail draws an element item through its type\'s card, in a row the rail owns; the card never holds the queue', async () => {
  // before any card: the generic row
  assert.ok(railRow('q-el-1'), 'precondition: the element item is in the rail');
  assert.equal(railRow('q-el-1').querySelector('.qi-card'), null, 'no card registered: the generic row');
  assert.equal(railRow('q-el-1').querySelector('.qi-summary').textContent, 'a grab of the chart');

  const seen = [];
  const unmounted = [];
  const card = {
    render(item, slot, ctx) {
      seen.push({ item, ctx });
      const b = W.document.createElement('b');
      b.className = 'test-card-body';
      b.textContent = `card for ${item.element_id}@${item.v}`;
      slot.appendChild(b);
    },
    unmount(slot) { unmounted.push(slot); },
  };
  const off = shellMod.registerQueueCard('test-card', card);
  try {
    // a registration redraws the rail
    await waitUntil(() => railRow('q-el-1') && railRow('q-el-1').querySelector('.test-card-body'), { timeout: 2000, what: 'the card' });
    const row = railRow('q-el-1');
    const slot = row.querySelector('.qi-card');
    assert.equal(slot.dataset.type, 'test-card');
    assert.equal(slot.textContent, 'card for g1@1');
    assert.equal(row.querySelector('.qi-summary'), null, 'the card draws in place of the generic summary');
    assert.ok(row.querySelector('.qi-kind'), 'the rail keeps the kind line');
    assert.ok(row.querySelector('.qi-stage') && row.querySelector('.qi-revert'), 'and the engine\'s stage and ⟲ controls');
    const { item, ctx } = seen.at(-1);
    assert.ok(Object.isFrozen(item), 'the card is handed a frozen copy of the item');
    assert.equal(item.id, 'q-el-1');
    assert.equal(typeof ctx.remove, 'function', 'the engine\'s remove');
    assert.equal(typeof ctx.setStaged, 'function', 'and its stage/hold');
    assert.equal(ctx.staged, true);
    assert.ok(Object.isFrozen(ctx));

    // a type with no card keeps the generic row
    assert.equal(railRow('q-el-2').querySelector('.qi-card'), null);
    assert.equal(railRow('q-el-2').querySelector('.qi-summary').textContent, 'a highlight');

    // the card's remove is the engine's: the item leaves the queue
    const n = shell.calls.length;
    ctx.remove();
    await shell.tick(5);
    const del = shell.calls.slice(n).find((c) => c.method === 'DELETE');
    assert.ok(del && del.url === '/api/queue/q-el-1', 'remove is the queue\'s DELETE, nothing more (no ?revert)');
    assert.ok(unmounted.length >= 1, 'the slot that left the rail was unmounted at the next draw');
  } finally { off(); }
});

test('a card whose render throws falls back to the generic row', async () => {
  // the rail re-reads the queue so the item is back
  await shell.frame(helloFrame({ active: 'n3' }));
  const queue = await shell.importApp('queue.js');
  await queue.hydrateQueue?.();
  await waitUntil(() => railRow('q-el-1'), { timeout: 2000, what: 'the item back in the rail' });
  const errs = [];
  const err = console.error;
  console.error = (...a) => errs.push(a);
  const off = shellMod.registerQueueCard('test-card', { render() { throw new Error('bad card'); } });
  try {
    await shell.tick(5);
    const row = railRow('q-el-1');
    assert.equal(row.querySelector('.qi-card'), null, 'no slot left behind');
    assert.equal(row.querySelector('.qi-summary').textContent, 'a grab of the chart', 'the generic row');
    assert.ok(errs.some((a) => /queue card for 'test-card' failed/.test(String(a[0]))), 'reported');
  } finally { off(); console.error = err; }
});

test('queue.js reaches the registry only through what shell.js hands in: it never imports shell.js', () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/queue.js'), 'utf8');
  assert.doesNotMatch(src, /from\s+['"]\.\/shell\.js['"]/, 'no import back (shell.js imports queue.js: a cycle)');
  const shellSrc = fs.readFileSync(path.join(REPO, 'public/app/shell.js'), 'utf8');
  assert.match(shellSrc, /setQueueCards\(queueCardOf\)/, 'shell.js hands its lookup in');
  assert.ok(pathToFileURL(path.join(REPO, 'public/app/row-caps.js')));
});
