// The shell's chrome, under jsdom with the real front-end module graph (same
// harness style as test/client-boot.test.js — node --test gives each test FILE
// its own process, so importing public/app/main.js here does not collide with
// that file's import; within this file there is exactly ONE boot, because the
// ESM cache would hand a second import the same already-initialised modules).
//
// Four defects are pinned here:
//   (a) Every chrome panel — the ⋯ menu, Settings, New graph, the bookmark
//       popover, the branch picker, the ⌘K palette, the shortcut legend, the
//       component drawer — opened and then stayed open forever. Clicking
//       anywhere else, or moving focus away, dismissed none of them; only
//       Escape did, and only if you knew.
//   (b) ...and the naive fix for (a) breaks the toggle: a document-level
//       listener closes the menu, then the trigger's own click reopens it.
//   (c) #pin-layer (z-index 10) sat ABOVE #topbar (z-index 2), so a comment pin
//       anchored near the top of the page floated over the topbar and its
//       pointer-events:auto marker swallowed the topbar's clicks.
//   (d) A wipe bookmarks the point it happened at, but fired the instant the
//       menu item was clicked — a bookmark nobody could name.
// ...plus the pinned-pane contract: a clear-all spares pinned panes, and a
// `reset` frame is rendered verbatim (the SERVER decides what survives a wipe).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');

/* ======================= (c) the stacking scale ======================= */
// Static audit of public/app.css. No jsdom: jsdom does not lay out or cascade an
// external stylesheet, and the defect is a pure source-order/number question.

// The named rungs declared in the `--z-*` :root block.
function scale() {
  const block = /:root\s*\{[^}]*--z-depth\s*:[^}]*\}/.exec(CSS);
  assert.ok(block, 'public/app.css declares a --z-* stacking scale on :root');
  const out = {};
  for (const m of block[0].matchAll(/(--z-[a-z]+)\s*:\s*(-?\d+)/g)) out[m[1]] = Number(m[2]);
  return out;
}
// Every `z-index:` declaration in the sheet, as { selectors, value }.
function zDeclarations() {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, ''); // a commented-out rule is not a rule
  const out = [];
  for (const r of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const d = /(?:^|;)\s*z-index\s*:\s*([^;]+)/.exec(r[2]);
    if (!d) continue;
    out.push({ selectors: r[1].split(',').map((s) => s.trim()), value: d[1].trim() });
  }
  return out;
}
// The resolved paint order of `selector`: var(--z-x) looked up in the scale, or
// a literal number taken at face value — so the ORDER assertions below are about
// what the browser actually paints, not about which spelling was used. (The
// "one scale" ratchet is a separate test.)
function zOf(selector) {
  const s = scale();
  const hit = zDeclarations().find((d) => d.selectors.includes(selector));
  assert.ok(hit, `${selector} declares a z-index`);
  const v = /^var\((--z-[a-z]+)\)$/.exec(hit.value);
  if (v) {
    assert.ok(v[1] in s, `${selector} names a rung that exists: ${v[1]}`);
    return s[v[1]];
  }
  assert.match(hit.value, /^-?\d+$/, `${selector} has a resolvable z-index, got: ${hit.value}`);
  return Number(hit.value);
}

test('the topbar sits above every surface artifact — including comment pins', () => {
  // The bug, stated as the assertion: #pin-layer is a full-stage layer on <body>
  // whose markers take pointer events, so anything it paints over is unclickable.
  assert.ok(zOf('#pin-layer') < zOf('#topbar'),
    `#pin-layer (${zOf('#pin-layer')}) must paint BELOW #topbar (${zOf('#topbar')})`);
  // ...and above the surface content it annotates, or the pins are invisible.
  assert.ok(zOf('.body') < zOf('#pin-layer'), 'pins paint above the surface well');
  assert.ok(zOf('.depth') < zOf('.body'), 'the depth backdrop stays behind content');
});

test('the whole z-index inventory is one ordered scale', () => {
  const s = scale();
  const order = ['--z-depth', '--z-content', '--z-glass', '--z-drag', '--z-pins',
    '--z-topbar', '--z-panel', '--z-notice', '--z-overlay', '--z-glance'];
  for (const k of order) assert.ok(k in s, `the scale declares ${k}`);
  for (let i = 1; i < order.length; i++) {
    assert.ok(s[order[i - 1]] < s[order[i]],
      `${order[i - 1]} (${s[order[i - 1]]}) must come before ${order[i]} (${s[order[i]]})`);
  }
  // the layering the product actually depends on, spelled out selector by selector
  assert.ok(zOf('#topbar') < zOf('.popover'), 'popovers open above the topbar');
  assert.equal(zOf('.popover'), zOf('.palette'), 'every chrome panel shares one rung');
  assert.equal(zOf('.popover'), zOf('.drawer'));
  assert.equal(zOf('.popover'), zOf('.legend'));
  assert.equal(zOf('.popover'), zOf('.pin-pop'));
  assert.ok(zOf('.popover') < zOf('#overlay.overlay'), 'the graph overlay covers the panels');
  // Host notices sit above ALL ordinary chrome so an advisory is never buried…
  assert.ok(zOf('.popover') < zOf('.svc-trust-host'),
    'the service-trust notice is reachable over every chrome panel');
  assert.ok(zOf('.popover') < zOf('.reaim-note'));
  // …but BELOW the graph overlay, which is a full-screen working view the user
  // deliberately opened. The notice is advisory, non-blocking, and re-announced
  // on every viewer connect, so yielding for the overlay's duration loses nothing;
  // the reverse painted an undismissable card over the one view that needs the
  // whole screen.
  assert.ok(zOf('.svc-trust-host') < zOf('#overlay.overlay'),
    'the graph overlay is not painted over by an advisory notice');
  assert.ok(zOf('.reaim-note') < zOf('#overlay.overlay'));
  // Layers raised from INSIDE the overlay ride above it.
  assert.ok(zOf('#overlay.overlay') < zOf('.glance-backdrop'));
  assert.ok(zOf('#overlay.overlay') < zOf('.popover.gv-name-panel'),
    'the graph rename panel opens above the overlay that raised it');
});

test('no z-index in the shell is a hand-picked number any more', () => {
  // Ratchet: the two survivors are LOCAL to a stacking context of their own and
  // are commented as such. A new bare number here means the scale was bypassed.
  const bare = [];
  for (const d of zDeclarations()) {
    if (/^var\(--z-[a-z]+\)$/.test(d.value)) continue;
    bare.push(`${d.selectors.join(', ')} { z-index: ${d.value} }`);
  }
  assert.deepEqual(bare.sort(), [
    '.glance-controls { z-index: 1 }',
    '.pane-resize-b { z-index: 3 }',
    '.pane-resize-r { z-index: 3 }',
  ], 'z-index declarations outside the --z-* scale');
});

/* ======================= (e) one palette ======================= */
// The chrome used to carry a SECOND, literal two-mode palette: five surfaces
// (the topbar gradient and its hairline, the dock-button hover, the stepper
// hover, the queue rail, the active history row) were painted from hex with a
// hand-written `:root[data-theme="light"]` twin each. A saved theme that set
// --wc-header-bg still got #2c2519 at the top of the topbar, because the value
// it needed to override lived outside the token blocks. Same static-audit style
// as the z-index ratchet above: jsdom cascades no external sheet, and the
// question is a pure source one.

const CSS_RULES = (() => {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, ''); // a commented-out rule is not a rule
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((r) => ({ selector: r[1].trim(), body: r[2] }));
})();

// The two blocks that ARE the palette: the base :root vocabulary and its
// Earthy Light override.
const PALETTE = [':root', ':root[data-theme="light"]'];

test('the Earthy Light palette block is the only place the sheet branches on mode', () => {
  // Ratchet: a `:root[data-theme=...]` rule anywhere else is a second palette —
  // a colour pair the token layer cannot reach, which is the defect.
  const branches = CSS_RULES.filter((r) => r.selector.includes('data-theme')).map((r) => r.selector);
  assert.deepEqual(branches, [':root[data-theme="light"]'],
    'mode-branching rules outside the palette block');
});

test('every --wc-* the chrome references is a token that exists', () => {
  // The pack panel's error text asked for --wc-coral, which no block has ever
  // defined, so it painted from the literal fallback beside it and no theme
  // could move it. An undefined token here is a colour that silently is not
  // part of the palette.
  const defined = new Set();
  for (const r of CSS_RULES) {
    if (!PALETTE.includes(r.selector)) continue;
    for (const m of r.body.matchAll(/(--wc-[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  }
  assert.ok(defined.has('--wc-accent'), 'the palette blocks were found');
  const missing = new Set();
  for (const r of CSS_RULES) {
    for (const m of r.body.matchAll(/var\(\s*(--wc-[a-z0-9-]+)/g)) {
      if (!defined.has(m[1])) missing.add(`${m[1]} (${r.selector})`);
    }
  }
  assert.deepEqual([...missing].sort(), [], '--wc-* references with no definition');
});

/* ======================= the jsdom boot ======================= */
const calls = [];
const routes = {
  queue: { items: [], count: 0 },
  pending: null,
};
let W = null, WS = null, restore = () => {};

async function boot() {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8')
    .replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;

  const wsInstances = [];
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; wsInstances.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send() {}
    close() {}
  };
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (url === '/api/graph') return json({ nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }], active: 'n1' });
    if (url === '/api/components') return json({ components: [{ name: 'demo', description: 'd', location: 'local' }] });
    if (url === '/api/packs') return json({ ok: true, packs: [], quarantined: [] });
    if (url === '/api/services/pending') return json({ ok: true, pending: [] });
    if (url === '/api/themes') return json({ themes: [] });
    if (url === '/api/queue') return json(routes.queue);
    if (url === '/api/queue/pending') return json({ pending: routes.pending });
    if (url === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (String(url).startsWith('/api/theme')) return json({ name: 'web-chat' });
    return json({ ok: true });
  };

  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'FocusEvent', 'navigator', 'getComputedStyle', 'localStorage', 'WebSocket', 'fetch', 'HTMLElement', 'Node', 'Element'];
  // Node 21+ defines some of these (navigator) as GETTERS with no setter, so a
  // plain assignment is a silent no-op and the modules keep seeing Node's own.
  const aliasGlobal = (k, v) => {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch { try { global[k] = v; } catch {} }
  };
  for (const k of keys) { try { saved[k] = global[k]; } catch {} aliasGlobal(k, window[k]); }
  const savedSetInterval = global.setInterval;
  global.setInterval = () => 0; // no pollers keeping the process alive
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
}

const tick = () => new Promise((r) => setTimeout(r, 25));
const $ = (id) => W.document.getElementById(id);
const click = (el) => el.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
// A real click is pointerdown-then-click: the dismiss layer runs on the first,
// the trigger's own toggle on the second. Tests that only fire `click` would
// miss the ordering bug entirely, so this helper always fires both.
const press = (el) => {
  el.dispatchEvent(new W.MouseEvent('pointerdown', { bubbles: true }));
  click(el);
};
const focusOn = (el) => el.dispatchEvent(new W.FocusEvent('focusin', { bubbles: true }));
const open = (id) => !$(id).classList.contains('hidden');

test('boot the shell once for the DOM-level checks', async () => {
  await boot();
  await tick();
  WS.onmessage({ data: JSON.stringify({
    type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'test',
    mounts: [
      { id: 'keep', html: '<p>pinned</p>', target: 'main', params: {}, pane_state: { pinned: true } },
      { id: 'drop', html: '<p>plain</p>', target: 'main', params: {}, pane_state: {} },
    ],
  }) });
  await tick();
  assert.equal($('main').querySelectorAll('.pane').length, 2, 'precondition: two panes mounted');
});

/* ---------- (a)/(b) the dismiss layer ---------- */
test('a popover closes on an outside click, and its trigger still toggles it', async () => {
  press($('btn-more'));
  assert.ok(open('more-menu'), 'the ⋯ button opens its menu');
  assert.equal($('btn-more').getAttribute('aria-expanded'), 'true');

  // a click inside the panel must NOT dismiss it
  $('more-menu').dispatchEvent(new W.MouseEvent('pointerdown', { bubbles: true }));
  assert.ok(open('more-menu'), 'clicking inside the menu keeps it open');

  // ...anywhere else does
  press($('main'));
  assert.ok(!open('more-menu'), 'clicking the surface dismisses the menu');
  assert.equal($('btn-more').getAttribute('aria-expanded'), 'false', 'and aria-expanded follows');

  // (b) the ordering trap: the trigger closes its OWN menu instead of
  // close-then-reopening it. This is what a naive document listener gets wrong.
  press($('btn-more'));
  assert.ok(open('more-menu'), 'reopened');
  press($('btn-more'));
  assert.ok(!open('more-menu'), 'pressing ⋯ again closes it — it must not reopen');
});

test('losing focus dismisses a popover too', () => {
  press($('btn-bookmark'));
  assert.ok(open('bookmark-pop'), 'the ⚑ button opens the bookmark popover');
  focusOn($('bookmark-name'));
  assert.ok(open('bookmark-pop'), 'focus INSIDE the popover keeps it open');
  focusOn($('btn-graph'));
  assert.ok(!open('bookmark-pop'), 'focus leaving the popover dismisses it');
});

test('focus falling to <body> is not "focus moved elsewhere"', () => {
  press($('btn-bookmark'));
  assert.ok(open('bookmark-pop'), 'precondition: a panel is open');
  focusOn(W.document.body);
  assert.ok(open('bookmark-pop'),
    'a deliberate .blur() leaves focus on <body>; reading that as an outside click would defeat the '
    + 'comment thread’s first-Escape draft guard, which blurs exactly that way');
  focusOn($('btn-graph'));
  assert.ok(!open('bookmark-pop'), 'a move to a real element still dismisses');
});

test('the palette, the legend and the drawer participate in the same dismissal', async () => {
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'k', metaKey: true }));
  assert.ok(open('cmd-palette'), '⌘K opened the palette');
  press($('main'));
  assert.ok(!open('cmd-palette'), 'an outside click closes the palette');

  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: '?' }));
  assert.ok(open('key-legend'), '? opened the shortcut legend');
  press($('main'));
  assert.ok(!open('key-legend'), 'an outside click closes the legend');

  // The drawer now expresses openness with `.hidden`, like every other panel —
  // which is what let the two special cases come out of the dismiss layer.
  press($('btn-add'));
  await tick();
  assert.ok(!$('drawer').classList.contains('hidden'), '+ opened the components drawer');
  press($('main'));
  assert.ok($('drawer').classList.contains('hidden'), 'an outside click closes the drawer');

  // Escape must keep working for all of them.
  press($('btn-more'));
  assert.ok(open('more-menu'));
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.ok(!open('more-menu'), 'Escape still closes');
});

test('opening one panel closes the others — one at a time', () => {
  press($('btn-more'));
  assert.ok(open('more-menu'));
  press($('btn-bookmark'));
  assert.ok(open('bookmark-pop'), 'the bookmark popover opened');
  assert.ok(!open('more-menu'), 'and the ⋯ menu closed on the way');
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape' }));
});

/* ---------- the comment pin popover, which used to run its own layer ----------
   comments.js kept a private outside-mousedown listener AND a second
   document-level Escape owner beside this file's, and .pin-pop carried no
   `.popover` class — so it was invisible to OPEN_PANELS: Escape could not reach
   a thread, focus moving away did not dismiss it, and "one panel at a time" was
   false for it. Nothing tested it in either direction. */

// Click an element INSIDE a pane's shadow root, the way a real press does:
// composed, so composedPath() reaches document and comments.js can see the host.
const pressInPane = (mountId, sel) => {
  const host = [...W.document.querySelectorAll('.mount-host')].find((h) => (h.dataset.mountId || h.id) === mountId);
  const target = host.shadowRoot.querySelector(sel);
  for (const type of ['pointerdown', 'click']) {
    target.dispatchEvent(new W.MouseEvent(type, { bubbles: true, composed: true, clientX: 40, clientY: 40 }));
  }
};
const pinPop = () => W.document.querySelector('.pin-pop');

test('a comment composer is a chrome panel like any other', async () => {
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'c' }));   // pin mode
  assert.ok(W.document.body.classList.contains('pin-mode'), 'precondition: pin mode armed');
  pressInPane('drop', 'p');
  await tick();
  const pop = pinPop();
  assert.ok(pop, 'clicking a pane element in pin mode opened the composer');
  assert.ok(pop.classList.contains('popover'),
    'and it declares itself a panel, so the ONE dismiss layer can see it at all');
});

test('an outside press dismisses the composer, like every other panel', async () => {
  assert.ok(pinPop(), 'precondition');
  press($('topbar'));
  await tick();
  assert.equal(pinPop(), null, 'the shell’s dismiss layer removed it — comments.js no longer runs its own');
});

test('opening another panel closes an open comment popover', async () => {
  pressInPane('drop', 'p');
  await tick();
  assert.ok(pinPop(), 'precondition: composer open');
  press($('btn-more'));
  assert.ok(open('more-menu'), 'the ⋯ menu opened');
  assert.equal(pinPop(), null, '"one panel at a time" now includes the comment popover');
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape' }));
});

test('Escape in the composer closes it and leaves pin mode', async () => {
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'c' }));   // re-arm: the Escape above disarmed it
  pressInPane('drop', 'p');
  await tick();
  const ta = pinPop().querySelector('.pin-text');
  ta.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  assert.equal(pinPop(), null, 'the composer closed');
  assert.ok(!W.document.body.classList.contains('pin-mode'), 'and pin mode is disarmed, as it always was');
});

test('Escape leaves pin mode even with nothing open', async () => {
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'c' }));
  assert.ok(W.document.body.classList.contains('pin-mode'), 'armed');
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.ok(!W.document.body.classList.contains('pin-mode'),
    'the one Escape owner does what comments.js’s second document listener used to');
});

test('a reply draft survives the first Escape and closes on the second (F12)', async () => {
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'c' }));   // arm pin mode: a marker click reaches the thread with the crosshair up
  assert.ok(W.document.body.classList.contains('pin-mode'), 'precondition: pin mode armed');
  WS.onmessage({ data: JSON.stringify({
    type: 'comments',
    comments: [{ id: 'c1', text: 'look here', shared: true, replies: [], anchor: { mount: 'drop', selector: 'p', text: 'plain', ordinal: 0 } }],
  }) });
  await tick();
  const marker = $('pin-layer').querySelector('.pin-marker');
  assert.ok(marker, 'the pin rendered a marker');
  marker.dispatchEvent(new W.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 40 }));
  await tick();
  const thread = pinPop();
  assert.ok(thread && thread.classList.contains('pin-thread'), 'the marker opened the thread');

  const ta = thread.querySelector('.pin-reply-text');
  ta.value = 'half-written';
  ta.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  assert.ok(pinPop(), 'the first Escape kept the thread — a non-empty draft is not thrown away');
  assert.equal(pinPop().querySelector('.pin-reply-text').value, 'half-written', 'and kept the draft');

  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape' }));
  await tick();
  assert.equal(pinPop(), null, 'the second Escape — focus off the field — closes it through the shell');
  assert.ok(!W.document.body.classList.contains('pin-mode'), 'and that one, being the shell’s, disarmed pin mode');
});

test('Escape on an EMPTY reply draft closes the thread and leaves pin mode too', async () => {
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'c' }));
  assert.ok(W.document.body.classList.contains('pin-mode'), 'armed');
  const marker = $('pin-layer').querySelector('.pin-marker');
  marker.dispatchEvent(new W.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 40 }));
  await tick();
  const ta = pinPop().querySelector('.pin-reply-text');
  assert.equal(ta.value, '', 'precondition: nothing typed, so this Escape closes rather than blurs');

  ta.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  assert.equal(pinPop(), null, 'the thread closed');
  assert.ok(!W.document.body.classList.contains('pin-mode'),
    'and the crosshair went with it — this handler stops the key, so it owes what the shell’s ' +
    'Escape (and the document listener comments.js used to run) would have done');
});

/* ---------- (d) wiping offers a label ---------- */
test('Wipe surface asks for a bookmark label before it wipes', async () => {
  calls.length = 0;
  press($('btn-more'));
  click($('more-menu').querySelector('[data-act="wipe"]'));
  await tick();
  assert.ok(open('wipe-panel'), 'the ⋯ menu opens the wipe panel');
  assert.ok(!calls.some((c) => c.url === '/api/graph/wipe'),
    'and nothing is wiped until the user confirms');

  // Cancel backs out without wiping.
  click($('btn-wipe-cancel'));
  assert.ok(!open('wipe-panel'), 'Cancel dismisses the panel');
  assert.ok(!calls.some((c) => c.url === '/api/graph/wipe'), 'Cancel wipes nothing');

  // A label rides the wipe.
  press($('btn-more'));
  click($('more-menu').querySelector('[data-act="wipe"]'));
  await tick();
  $('wipe-name').value = '  before the refactor  ';
  click($('btn-wipe-go'));
  await tick();
  const wiped = calls.find((c) => c.url === '/api/graph/wipe');
  assert.ok(wiped && wiped.method === 'POST', 'confirming POSTs the wipe');
  assert.deepEqual(wiped.body, { name: 'before the refactor' }, 'the typed label rides the request, trimmed');
  assert.ok(!open('wipe-panel'), 'and the panel closes');
});

test('declining to label still wipes, and still bookmarks', async () => {
  calls.length = 0;
  // the keyboard path: the ⌘K palette's "Wipe surface" command
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'k', metaKey: true }));
  await tick();
  const row = [...$('cmd-list').querySelectorAll('.palette-item')]
    .find((r) => r.textContent.includes('Wipe surface'));
  assert.ok(row, 'the palette offers Wipe surface');
  row.dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true }));
  await tick();
  assert.ok(open('wipe-panel'), 'the keyboard path lands on the same panel');
  assert.equal($('wipe-name').value, '', 'with an empty name field');
  click($('btn-wipe-go'));
  await tick();
  const wiped = calls.find((c) => c.url === '/api/graph/wipe');
  assert.ok(wiped, 'an empty label still wipes');
  assert.deepEqual(wiped.body, { name: '' },
    'and still bookmarks — the server bookmarks on an empty name, it just has no label');
});

/* ---------- pinned panes ---------- */
test('a pinned pane says what pinning means', () => {
  const pane = $('main').querySelector('.pane[data-pane-id="keep"]');
  const pin = [...pane.querySelectorAll('.pane-btn')].find((b) => b.textContent === '📌');
  assert.ok(pin, 'a pane has a pin button');
  assert.match(pin.title, /survives wipes/i,
    'the tooltip states the meaning, not just the name of the gesture');
  assert.equal(pin.getAttribute('aria-label'), pin.title, 'and it is the button\'s accessible name');
  assert.ok(pin.classList.contains('active'), 'the pinned pane renders as pinned');
});

test('an agent-driven clear-all spares pinned panes', () => {
  const ids = () => [...$('main').querySelectorAll('.pane')].map((p) => p.dataset.paneId);
  assert.deepEqual(ids(), ['keep', 'drop'], 'precondition');

  WS.onmessage({ data: JSON.stringify({ type: 'clear' }) }); // clear-all, no id
  assert.deepEqual(ids(), ['keep'], 'the unpinned pane goes, the pinned one stays');

  // force:true is the server's own escape hatch — the client honours it.
  WS.onmessage({ data: JSON.stringify({ type: 'clear', force: true }) });
  assert.deepEqual(ids(), [], 'force clears the pinned pane too');
});

test('a reset frame is rendered verbatim — the server decides what survives a wipe', () => {
  const ids = () => [...$('main').querySelectorAll('.pane')].map((p) => p.dataset.paneId);
  // What a wipe with a surviving pinned pane looks like on the wire.
  WS.onmessage({ data: JSON.stringify({
    type: 'reset', active: 'n1', lock: null, store: {}, theme: null, activeTheme: null,
    mounts: [{ id: 'keep', html: '<p>pinned</p>', target: 'main', params: {}, pane_state: { pinned: true } }],
  }) });
  assert.deepEqual(ids(), ['keep'], 'the survivor the server sent is what is on screen');

  // ...and the client must NOT re-apply the pinned rule on top: a reset that
  // drops a pinned mount drops it. (This is the half that a client-side filter
  // would get wrong — the pane would resurrect itself.)
  WS.onmessage({ data: JSON.stringify({
    type: 'reset', active: 'n1', lock: null, store: {}, theme: null, activeTheme: null, mounts: [],
  }) });
  assert.deepEqual(ids(), [], 'an empty reset empties the surface, pinned or not');
});

test.after(async () => { await new Promise((r) => setTimeout(r, 400)); restore(); });
