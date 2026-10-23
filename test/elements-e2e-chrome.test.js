// Tranche 1 of the annotation engine in the LIVE chrome (U240): the real
// public/index.html and public/app module graph (test-support/chrome-shell,
// booted once), fed what a real daemon serves for a migrated v3 project.
//
// Pinned here:
//   - the live chrome installs the resolver: window.__wcMount.anchor is the
//     /app/anchors.js module's api (public/app/main.js imports and installs
//     it), beside the runtime's settle;
//   - the served /app/anchors.js is the factory's browserModuleSource();
//   - one settle per pane mount, after its restored form state; and the
//     resolver's ONE settle listener (anchors.js install → onSettle) turns a
//     settle into a coalesced pass for a watched pane — and only then;
//   - a migrated node's comment pins draw: the served copies keep `anchor` =
//     the original locator, and the overlay draws each pin at its converted
//     pin-locator@1 anchor (the read's `record`, the node's lean_elements);
//     a preview of the node draws that node's own pins, read-only (U327b,
//     F-DOCS a: pins draw on the live page and on previewed nodes), and once
//     the node is live again its pins resolve to their elements.
//
// The daemon half runs in before(), against a real createServer on a v3
// project (test-support/v3-graph.js), BEFORE the shell replaces fetch; the
// shell then answers the chrome with those bodies.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { v3Graph } = require('../test-support/v3-graph');
const { withServer, waitUntil } = require('../test-support/helpers');
const { browserModuleSource } = require('../lib/core/anchors');

// What the daemon served, by name.
const served = {};

// withServer, with an owner of its own: a before() hook has no test context to
// hand it, so its teardowns are collected here and run, last first, as soon as
// the daemon's answers are in.
async function fromDaemon() {
  const cleanups = [];
  const owner = { after: (fn) => { cleanups.push(fn); } };
  try {
    const { baseUrl } = await withServer(owner, { seed: ({ root }) => { v3Graph(root); } });
    // Node's fetch sends fetch metadata: the daemon reads it as the local
    // browser the chrome is (audience.seesPrivate).
    const get = async (p) => {
      const r = await fetch(baseUrl + p);
      assert.equal(r.status, 200, `${p}: ${r.status}`);
      return p.endsWith('.js') ? r.text() : r.json();
    };
    served.anchorsJs = await get('/app/anchors.js');
    served.graph = await get('/api/graph');
    served.n6 = await get('/api/graph/node/n6');
    served.n4 = await get('/api/graph/node/n4');
    served.liveN6 = (await get('/api/elements?type=comment')).elements;
    const r = await fetch(baseUrl + '/api/graph/active', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'n4' }),
    });
    assert.equal(r.status, 200, await r.text());
    served.liveN4 = (await get('/api/elements?type=comment')).elements;
  } finally {
    for (const fn of cleanups.reverse()) await fn();
  }
}

const asLive = (mounts) => mounts.map((m) => ({ target: 'main', params: {}, ...m }));

// A pane whose script logs its restored form input into the shared log.
const FORM_PANE = {
  id: 'e2e-form', target: 'main', params: {},
  html: `<p class="lead">form pane</p><input id="q" value="baked"><script>
    root.querySelector('#q').addEventListener('input', function () { window.__e2eLog.push('input:' + mountId); });
  </script>`,
  form_state: { '#q:0': { value: 'typed' } },
};

let shell, W, M, log, anchorsModule, topbar;

before(async () => {
  await fromDaemon();
  shell = await bootShell({
    routes: {
      '/api/graph': served.graph,
      '/api/graph/node/n4': served.n4,
      '/api/graph/node/n6': served.n6,
      '/api/elements?type=comment': { elements: served.liveN6, next_cursor: 0 },
    },
  });
  W = shell.window;
  M = W.__wcMount;
  log = [];
  W.__e2eLog = log;
  M.onSettle((root, id, gen, why) => { log.push(`settle:${id}:${why}`); });
  anchorsModule = await shell.importApp('anchors.js');
  topbar = await shell.importApp('topbar.js');
  await shell.frame(helloFrame({
    active: 'n6',
    mounts: [...asLive(served.n6.mounts), FORM_PANE],
  }));
  await shell.frame({ type: 'element:comment', elements: served.liveN6 });
});

after(async () => { if (shell) await shell.restore(); });

// The comment pins the page well's overlay drew (U327b: no pin layer of
// comments.js's own, no marker pass; the overlay places them on its frames).
const markers = () => [...W.document.getElementById('el-layer').querySelectorAll('.pin-marker')];
// The pins today's resolver can place: anchored on a pane the page holds (a
// ghost — c4 on m-b, which only n1 had — draws no marker, as in 0.8.5).
const anchoredIds = (pins, mounts) => pins.filter((p) => p.anchor && mounts.some((m) => m.id === p.anchor.mount))
  .map((p) => p.id).sort();
const markedIds = () => markers().flatMap((m) => (m.dataset.elIds || '').split(' ').filter(Boolean)).sort();
const markedUntil = async (want, what) => {
  await waitUntil(() => JSON.stringify(markedIds()) === JSON.stringify(want), { timeout: 4000, what });
  return markedIds();
};

test('the live chrome installs the resolver on the mount runtime, beside settle', () => {
  assert.equal(typeof M.settle, 'function', 'window.__wcMount.settle');
  assert.equal(typeof M.onSettle, 'function');
  assert.ok(M.anchor, 'window.__wcMount.anchor');
  assert.equal(M.anchor, anchorsModule.default, 'the /app/anchors.js module\'s api, installed by main.js');
  for (const fn of ['record', 'resolve', 'resolveAll', 'watch', 'invalidate', 'install']) {
    assert.equal(typeof M.anchor[fn], 'function', `anchor.${fn}`);
  }
  assert.equal(M.anchor.CONFIG.head_floor, true);
  assert.equal(M.anchor.CONFIG.ordinal, true);
});

test('the served /app/anchors.js is the factory\'s browserModuleSource()', () => {
  assert.equal(served.anchorsJs, browserModuleSource());
});

test('a pane mount settles once, after its restored form state', () => {
  const mine = log.filter((l) => l.split(':')[1] === 'e2e-form');
  assert.deepEqual(mine, ['input:e2e-form', 'settle:e2e-form:mount']);
  for (const m of served.n6.mounts) {
    assert.equal(log.filter((l) => l === `settle:${m.id}:mount`).length, 1, `${m.id}: one settle`);
  }
});

test('the resolver\'s settle listener: a settle on a watched pane runs one coalesced pass, an unwatched one runs none', async () => {
  const host = M.itemEl(W.document, 'e2e-form').el;
  const root = host.shadowRoot;
  const rec = M.anchor.record(root, root.querySelector('p.lead'), { mount: 'e2e-form' });
  assert.ok(rec, 'a record of the pane\'s lead paragraph');
  const answers = [];
  // jsdom's own requestAnimationFrame (pretendToBeVisual) runs its frames on
  // the global setInterval, which the shell stubs (it never fires), so the
  // resolver's default scheduler — the root's window rAF, as in a browser —
  // gets the shell's tracked-timeout frame for this test.
  const ownRaf = W.requestAnimationFrame;
  W.requestAnimationFrame = globalThis.requestAnimationFrame;
  const unwatch = M.anchor.watch('e2e-form', { records: () => [rec], onAnswers: (a, report) => answers.push({ a, report }) });
  try {
    await shell.tick();
    assert.equal(answers.length, 0, 'a watch alone runs nothing');
    await shell.frame({ type: 'pane:form', id: 'e2e-form', form_state: { '#q:0': { value: 'again' } } });
    for (let i = 0; i < 10 && !answers.length; i++) await shell.tick();
    assert.equal(answers.length, 1, 'the settle ran one pass');
    assert.equal(answers[0].a[0].state, 'exact', 'the recorded element resolves exact');
    assert.equal(answers[0].a[0].el, root.querySelector('p.lead'));
    // A settle on a pane nobody watches schedules nothing for this watcher.
    const p1 = served.n6.mounts[0].id;
    M.settle(M.itemEl(W.document, p1).el.shadowRoot, p1, 'form');
    for (let i = 0; i < 3; i++) await shell.tick();
    assert.equal(answers.length, 1);
  } finally { unwatch(); W.requestAnimationFrame = ownRaf; }
});

test('a migrated node\'s pins draw at their converted anchors; a preview draws its own pins, read-only; live again they resolve', async () => {
  // Live on n6: the draft's anchored pins resolve to m-a's lead paragraph, at
  // the converted pin-locator@1 anchor the read serves as `record`.
  for (const c of served.liveN6) {
    if (!c.anchor) continue;
    assert.equal(c.record && c.record.form, 'pin-locator@1', `${c.id}: the read serves the converted anchor as record`);
  }
  assert.deepEqual(await markedUntil(anchoredIds(served.liveN6, served.n6.mounts), 'the live pins'),
    anchoredIds(served.liveN6, served.n6.mounts), 'the live pins are marked');
  // The previewed node's copies, as the daemon serves them.
  assert.ok(served.n4.comments.length > 0);
  for (const c of served.n4.comments) {
    if (!c.anchor) continue;
    assert.deepEqual(Object.keys(c.anchor).sort(), ['mount', 'ordinal', 'selector', 'text'],
      `${c.id}: the served anchor is the original locator, never the log's pin-locator@1`);
  }
  await topbar.previewNode('n4');
  await shell.tick();
  assert.ok(W.document.getElementById('main').classList.contains('preview-readonly'), 'previewing n4');
  const previewed = anchoredIds(served.n4.comments, served.n4.mounts);
  assert.ok(previewed.length >= 1, 'n4 holds pins on its own panes');
  assert.deepEqual(await markedUntil(previewed, 'the preview\'s pins'), previewed,
    'a preview draws the previewed node\'s own pins (read-only), from its lean_elements');
  topbar.returnToActive();
  await shell.tick();
  assert.deepEqual(await markedUntil(anchoredIds(served.liveN6, served.n6.mounts), 'the live pins again'),
    anchoredIds(served.liveN6, served.n6.mounts), 'back on the live page, the markers return');
  // Set active on n4 (the daemon's answer, above): its restored pins resolve.
  await shell.frame({ type: 'reset', active: 'n4', store: {}, lock: null, theme: null, activeTheme: null,
    mounts: asLive(served.n4.mounts) });
  await shell.frame({ type: 'element:comment', elements: served.liveN4 });
  assert.deepEqual(served.liveN4.map((c) => c.id).sort(), served.n4.comments.map((c) => c.id).sort());
  for (const c of served.liveN4) assert.ok(Number.isInteger(c.v), `${c.id} live with its v`);
  const want = anchoredIds(served.liveN4, served.n4.mounts);
  assert.ok(want.length >= 3, 'the node holds anchored pins on its own pane');
  assert.deepEqual(await markedUntil(want, 'the migrated node\'s pins'), want, 'the migrated node\'s pins resolve to their elements');
});
