// A pane's timers, listeners and observers end with the pane (U98; the Safari
// report's item 1, design/tools/t567-inputs/safari-report.md). U97 released a
// pane's store subscriptions; this is the rest of what a pane script sets up.
// The shape is ruled A1 (c): inside a pane script the bare setTimeout,
// setInterval and requestAnimationFrame (and their clears) are per-pane
// wrappers cleared when the pane goes; `api.signal` aborts then, for listeners
// and fetches; `api.onUnmount(fn)` runs then, for anything else.
//
// Measured on wc085/int before the fix (notes-P.md §1): every remount of a pane
// with one setInterval left one more live interval — 605 after the same run —
// and none was cleared by a clear.
//
// Through the real shell (test-support/chrome-shell.js): its setInterval is a
// stub that records (shell.intervals()), its setTimeout and
// requestAnimationFrame are real but tracked, and the pane's shadowed names
// call those globals at call time — so what is asserted here is what the
// shell's globals saw.
const test = require('node:test');
const { before, beforeEach, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');

let shell, W, topbar, mounts;

const receive = (msg) => shell.socket().receive(msg);
const render = (id, html, extra = {}) => receive({ type: 'render', id, html, target: 'main', params: {}, pane_state: {}, ...extra });
const reset = (list) => receive({ type: 'reset', mounts: list, store: {}, active: 'n1' });
const paneSpec = (id, html, extra = {}) => ({ id, html, target: 'main', params: {}, pane_state: {}, ...extra });

// One interval at a period nothing in the chrome uses, so the pane's are the
// ones counted.
const TICKING = '<p>tick</p><script>setInterval(function () { window.__ticks = (window.__ticks || 0) + 1; }, 4321);</script>';
const paneIntervals = () => shell.intervals().filter((t) => t.ms === 4321);

// A pane that registers one onUnmount callback, tagged with its mount id and
// instance (one per script run).
const UNMOUNTING = `<p>u</p><script>
  const inst = (window.__inst = (window.__inst || 0) + 1);
  api.onUnmount(() => window.__un.push({ id: mountId, inst }));
</script>`;
const ran = () => W.__un.map((u) => u.id).sort();

before(async () => {
  shell = await bootShell({ open: true });
  W = shell.window;
  topbar = await shell.importApp('topbar.js');
  mounts = await shell.importApp('mounts.js');
  await shell.frame(helloFrame({ mounts: [] }));
});
after(() => shell.restore());

beforeEach(async () => {
  shell.setRoutes({});
  reset([]);
  await shell.tick();
  W.__un = [];
  W.__fired = [];
});

test('a pane\'s setInterval shows as one live interval, and a clear of the pane removes it', async () => {
  assert.strictEqual(paneIntervals().length, 0);
  render('ti', TICKING);
  await shell.tick();
  assert.strictEqual(paneIntervals().length, 1, 'the pane\'s interval reached the global setInterval');
  receive({ type: 'clear', id: 'ti' });
  await shell.tick();
  assert.strictEqual(paneIntervals().length, 0, 'the clear left the pane\'s interval running');
});

test('30 reset frames of the same pane leave exactly one interval, not 31', async () => {
  for (let i = 0; i < 30; i++) reset([paneSpec('ti', TICKING)]);
  await shell.tick();
  assert.strictEqual(paneIntervals().length, 1);
  render('ti', TICKING);   // and a re-render of the id swaps it, too
  await shell.tick();
  assert.strictEqual(paneIntervals().length, 1);
  receive({ type: 'clear' });
  await shell.tick();
  assert.strictEqual(paneIntervals().length, 0, 'a clear-all left it running');
});

test('a pending setTimeout and requestAnimationFrame never fire once the pane is gone', async () => {
  render('tt', `<script>
    setTimeout(function () { window.__fired.push('timeout'); }, 30);
    requestAnimationFrame(function () { window.__fired.push('frame'); });
  </script>`);
  receive({ type: 'clear', id: 'tt' });   // the same turn: neither has fired yet
  await shell.tick(80);
  assert.deepStrictEqual(W.__fired, []);

  // The same pane left alone: both fire, and the record drops what fired.
  render('tt', `<script>
    setTimeout(function () { window.__fired.push('timeout'); }, 30);
    requestAnimationFrame(function () { window.__fired.push('frame'); });
  </script>`);
  await shell.tick(80);
  assert.deepStrictEqual(W.__fired.sort(), ['frame', 'timeout']);
  assert.strictEqual(mounts.panes.get('tt').life.timers.size, 0, 'a fired timer stays recorded');
});

test('a setTimeout chain stops when the pane goes, and never piles up records while it runs', async () => {
  render('tc', `<script>
    (function step() { window.__fired.push(1); setTimeout(step, 1); })();
  </script>`);
  await shell.tick(60);
  assert.ok(W.__fired.length > 3, 'the chain ran');
  assert.ok(mounts.panes.get('tc').life.timers.size <= 1, 'each fired link left its record behind');
  receive({ type: 'clear', id: 'tc' });
  const n = W.__fired.length;
  await shell.tick(40);
  assert.strictEqual(W.__fired.length, n, 'the chain kept running after the pane was cleared');
});

test('a pane that clears its own timers leaves nothing recorded', async () => {
  render('tx', `<script>
    clearTimeout(setTimeout(function () { window.__fired.push('t'); }, 20));
    clearInterval(setInterval(function () {}, 4321));
    cancelAnimationFrame(requestAnimationFrame(function () { window.__fired.push('f'); }));
  </script>`);
  await shell.tick(50);
  assert.deepStrictEqual(W.__fired, []);
  assert.strictEqual(paneIntervals().length, 0);
  assert.strictEqual(mounts.panes.get('tx').life.timers.size, 0);
});

test('a timer asked for after the pane is gone is never scheduled', async () => {
  render('tl', `<script>
    (async () => {
      await Promise.resolve();
      window.__lateHandle = setInterval(function () {}, 4321);
      setTimeout(function () { window.__fired.push('late'); }, 1);
    })();
  </script>`);
  receive({ type: 'clear', id: 'tl' });   // before the script's await resolves
  await shell.tick(30);
  assert.strictEqual(paneIntervals().length, 0);
  assert.strictEqual(W.__lateHandle, 0);
  assert.deepStrictEqual(W.__fired, []);
});

// In a browser that is window.setInterval; under the shell the stubbed global
// lives on Node's global object (jsdom's window keeps its own), so the pane
// reaches it as globalThis.setInterval.
test('the global setInterval reached through the global object is not tracked (documented)', async () => {
  render('tw', '<script>window.__wh = globalThis.setInterval(function () {}, 4321);</script>');
  await shell.tick();
  receive({ type: 'clear', id: 'tw' });
  await shell.tick();
  assert.strictEqual(paneIntervals().length, 1, 'the global setInterval is outside the pane\'s shadowed names');
  globalThis.clearInterval(W.__wh);
  assert.strictEqual(paneIntervals().length, 0);
});

test('a script that declares a timer name itself still runs, on the globals', async () => {
  render('td', `<p id="o"></p><script>
    const requestAnimationFrame = function (fn) { return setTimeout(fn, 0); };
    root.getElementById('o').textContent = typeof requestAnimationFrame;
  </script>`);
  await shell.tick();
  const host = shell.document.querySelector('[data-mount-id="td"]');
  assert.strictEqual(host.shadowRoot.getElementById('o').textContent, 'function');
  assert.strictEqual(shell.socket().frames('script:error').filter((f) => f.id === 'td').length, 0);
});

test('a window listener added with {signal: api.signal} stops when the pane is removed', async () => {
  render('ls', `<script>
    window.__sig = api.signal;
    window.addEventListener('wc-u98', () => window.__fired.push(mountId), { signal: api.signal });
  </script>`);
  await shell.tick();
  W.dispatchEvent(new W.Event('wc-u98'));
  assert.deepStrictEqual(W.__fired, ['ls']);
  assert.strictEqual(W.__sig.aborted, false);
  receive({ type: 'clear', id: 'ls' });
  await shell.tick();
  assert.strictEqual(W.__sig.aborted, true);
  W.dispatchEvent(new W.Event('wc-u98'));
  assert.deepStrictEqual(W.__fired, ['ls'], 'the listener outlived its pane');
});

test('onUnmount runs exactly once on a clear by id, a clear-all and a re-render of the id', async () => {
  render('ua', UNMOUNTING);
  render('ub', UNMOUNTING);
  render('uc', UNMOUNTING);
  await shell.tick();
  assert.deepStrictEqual(ran(), [], 'nothing runs while the panes stand');

  receive({ type: 'clear', id: 'ua' });
  await shell.tick();
  assert.deepStrictEqual(ran(), ['ua']);

  const first = W.__inst;
  render('ub', UNMOUNTING);   // a re-render: the old instance's callback runs
  await shell.tick();
  assert.deepStrictEqual(W.__un.slice(1), [{ id: 'ub', inst: first - 1 }]);

  receive({ type: 'clear' });
  await shell.tick();
  assert.deepStrictEqual(ran(), ['ua', 'ub', 'ub', 'uc'], 'the clear-all runs each live pane\'s once');
  assert.deepStrictEqual(W.__un.filter((u) => u.id === 'ub').map((u) => u.inst), [first - 1, first + 1]);

  receive({ type: 'clear' });
  await shell.tick();
  assert.strictEqual(W.__un.length, 4, 'a second clear ran a callback again');
});

test('onUnmount runs exactly once on a reset, each preview step and the return to active', async () => {
  reset([paneSpec('ra', UNMOUNTING), paneSpec('rb', UNMOUNTING)]);
  await shell.tick();
  reset([paneSpec('ra', UNMOUNTING), paneSpec('rb', UNMOUNTING)]);
  await shell.tick();
  assert.deepStrictEqual(ran(), ['ra', 'rb'], 'a reset runs the replaced instances\' callbacks');

  W.__un = [];
  for (let i = 1; i <= 3; i++) {
    shell.setRoutes({ '/api/graph/node/*': { id: `pv${i}`, label: `n1.${i}`, parent_id: 'n1', created_at: 1 + i,
      store: {}, mounts: [paneSpec(`pv${i}`, UNMOUNTING)] } });
    await topbar.previewNode(`pv${i}`);
  }
  assert.deepStrictEqual(ran(), ['pv1', 'pv2', 'ra', 'rb'], 'each preview step runs what it replaced, once');

  topbar.returnToActive();
  await shell.tick();
  assert.deepStrictEqual(ran(), ['pv1', 'pv2', 'pv3', 'ra', 'rb'], 'the return runs the last preview pane\'s');
  assert.ok(mounts.panes.has('ra') && mounts.panes.has('rb'), 'the live panes are back');
});

test('a throwing onUnmount callback stops neither the next one nor the removal, and sends no frame', async () => {
  render('ut', `<script>
    api.onUnmount(() => { throw new Error('teardown boom'); });
    api.onUnmount(() => window.__un.push({ id: 'second' }));
  </script>`);
  await shell.tick();
  const errorsBefore = shell.socket().frames('script:error').length;
  const logged = [];
  const quiet = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  try {
    receive({ type: 'clear', id: 'ut' });
    await shell.tick();
  } finally {
    console.error = quiet;
  }
  assert.deepStrictEqual(W.__un, [{ id: 'second' }]);
  assert.strictEqual(shell.document.querySelector('.pane[data-pane-id="ut"]'), null, 'the pane is gone');
  assert.ok(!mounts.panes.has('ut'));
  assert.ok(logged.some((l) => /teardown boom/.test(l)), 'the failure is logged to the console');
  assert.strictEqual(shell.socket().frames('script:error').length, errorsBefore, 'the wire is unchanged');
});

test('a callback registered after the pane is gone runs at once', async () => {
  render('uz', '<script>window.__api = api;</script>');
  await shell.tick();
  receive({ type: 'clear', id: 'uz' });
  await shell.tick();
  let ranNow = 0;
  W.__api.onUnmount(() => { ranNow++; });
  assert.strictEqual(ranNow, 1);
  assert.strictEqual(W.__api.signal.aborted, true);
});

test('callbacks run before the timers are cleared, while the pane is still in the page', async () => {
  render('uo', `<p id="p">here</p><script>
    const h = setInterval(function () {}, 4321);
    api.onUnmount(() => {
      window.__un.push({ connected: root.host.isConnected, text: root.getElementById('p').textContent,
        timerLive: window.__live() });
    });
  </script>`);
  W.__live = () => paneIntervals().length;
  await shell.tick();
  receive({ type: 'clear', id: 'uo' });
  await shell.tick();
  assert.deepStrictEqual(W.__un, [{ connected: true, text: 'here', timerLive: 1 }]);
  assert.strictEqual(paneIntervals().length, 0);
});

test('the node-render builtin disconnects its data-theme observer when it is removed', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'components', 'node-render', 'component.html'), 'utf8');
  shell.setRoutes({
    '/api/graph': { active: 'n1', nodes: [{ id: 'n1', created_at: 1 }] },
    '/api/graph/node/*': { id: 'n1', author: 'claude', mounts: [], store: {} },
  });
  // Every observer made from here records whether it watches <html>'s
  // data-theme and whether it was let go.
  const Real = globalThis.MutationObserver;
  const made = [];
  class Recording extends Real {
    constructor(fn) { super(fn); this.rec = { watchesTheme: false, disconnected: false }; made.push(this.rec); }
    observe(target, opts) {
      if (target === W.document.documentElement && opts && (opts.attributeFilter || []).includes('data-theme')) this.rec.watchesTheme = true;
      return super.observe(target, opts);
    }
    disconnect() { this.rec.disconnected = true; return super.disconnect(); }
  }
  Object.defineProperty(globalThis, 'MutationObserver', { value: Recording, configurable: true, writable: true });
  try {
    render('nr', html, { params: { node_id: 'n1' }, component: 'node-render' });
    await shell.tick(30);
  } finally {
    Object.defineProperty(globalThis, 'MutationObserver', { value: Real, configurable: true, writable: true });
  }
  const watcher = made.filter((r) => r.watchesTheme);
  assert.strictEqual(watcher.length, 1, 'the pane watches data-theme');
  const frame = shell.document.querySelector('[data-mount-id="nr"]').shadowRoot.querySelector('iframe');
  assert.strictEqual(watcher[0].disconnected, false);

  receive({ type: 'clear', id: 'nr' });
  await shell.tick();
  assert.strictEqual(watcher[0].disconnected, true, 'the observer outlived its pane');

  const src = frame && frame.getAttribute('src');
  const graphCalls = shell.calls.length;
  const was = W.document.documentElement.getAttribute('data-theme');
  W.document.documentElement.setAttribute('data-theme', was === 'light' ? 'dark' : 'light');
  await shell.tick();
  if (was === null) W.document.documentElement.removeAttribute('data-theme');
  else W.document.documentElement.setAttribute('data-theme', was);
  await shell.tick();
  assert.strictEqual(frame && frame.getAttribute('src'), src, 'a theme flip after removal reloaded the frame');
  assert.strictEqual(shell.calls.slice(graphCalls).filter((c) => /\/api\/graph/.test(c.url)).length, 0);
});
