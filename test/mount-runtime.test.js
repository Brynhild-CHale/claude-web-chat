const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { PUBLIC_DIR } = require('../lib/core/paths');
const src = require('../lib/server/runtime/mount-runtime-src');

// The shared runtime dual-exports for node (module.exports) so createStore is
// testable headlessly; the DOM primitives need a real DOM (jsdom, below).
const mount = require('../public/mount-runtime.js');

// ── createStore (headless — the frozen store contract) ─────────────────────

test('createStore.get: no-arg returns a shallow copy; keyed returns the raw value', () => {
  const s = mount.createStore({ a: 1, obj: { x: 1 } });
  const snap = s.get();
  snap.a = 999;
  assert.equal(s.get('a'), 1, 'mutating the snapshot must not touch state');
  assert.equal(s.get('obj'), s.get('obj'), 'keyed get returns the raw reference');
});

test('createStore.set: fires per-key (value,key) THEN wildcard (patch), in that order', () => {
  const s = mount.createStore({});
  const calls = [];
  s.subscribe('a', (v, k) => calls.push(['key', k, v]));
  s.subscribe((patch) => calls.push(['wild', patch]));
  s.set({ a: 5, b: 6 });
  assert.deepEqual(calls, [['key', 'a', 5], ['wild', { a: 5, b: 6 }]]);
});

test('createStore.set: a throwing subscriber does not block siblings or the wildcard', () => {
  const s = mount.createStore({});
  const seen = [];
  s.subscribe('a', () => { throw new Error('boom'); });
  s.subscribe('a', (v) => seen.push('a2:' + v));
  s.subscribe(() => seen.push('wild'));
  s.set({ a: 1 });
  assert.deepEqual(seen, ['a2:1', 'wild']);
});

test('createStore.subscribe: dual signature (wildcard vs per-key) + unsubscribe closures', () => {
  const s = mount.createStore({});
  const seen = [];
  const off1 = s.subscribe('k', (v) => seen.push('key:' + v));
  const off2 = s.subscribe(() => seen.push('wild'));
  s.set({ k: 1 });
  off1(); off2();
  s.set({ k: 2 });
  assert.deepEqual(seen, ['key:1', 'wild'], 'no further delivery after unsubscribe');
});

test('createStore.set: publish hook gets (patch, opts) AFTER subscribers; omitting it is a no-op', () => {
  const order = [];
  const s = mount.createStore({}, (patch, opts) => order.push(['publish', patch, opts]));
  s.subscribe((p) => order.push(['sub', p]));
  s.set({ a: 1 }, { fromServer: true });
  assert.deepEqual(order, [['sub', { a: 1 }], ['publish', { a: 1 }, { fromServer: true }]]);
  const s2 = mount.createStore({});
  s2.set({ b: 2 }); // no publish hook → must not throw
});

test('createStore.replace: wholesale swap of state, SILENT (no subscribers, no publish)', () => {
  const fires = [];
  const s = mount.createStore({ a: 1, b: 2 }, () => fires.push('publish'));
  s.subscribe(() => fires.push('sub'));
  s.replace({ c: 3 });
  assert.equal(s.get('a'), undefined, 'old keys are cleared');
  assert.equal(s.get('c'), 3);
  assert.deepEqual(fires, [], 'replace fires nothing (client re-mounts after)');
  s.replace(); // undefined → empty
  assert.deepEqual(s.get(), {});
});

test('createStore.merge: shallow merge keeping old keys, SILENT', () => {
  const fires = [];
  const s = mount.createStore({ a: 1 }, () => fires.push('publish'));
  s.subscribe(() => fires.push('sub'));
  s.merge({ b: 2 });
  assert.deepEqual(s.get(), { a: 1, b: 2 }, 'old key a survives, b added');
  assert.deepEqual(fires, [], 'merge fires nothing');
});

test('createStore.set(undefined|null) throws (unified on the strict client behavior)', () => {
  // The old client threw here (Object.entries(patch)); the old export/preview
  // tolerated it. The shared store unifies on the strict behavior. Pin it so a
  // future "helpful" patch=patch||{} can't silently re-diverge the 3 consumers.
  const s = mount.createStore({});
  assert.throws(() => s.set(), TypeError);
  assert.throws(() => s.set(null), TypeError);
});

// ── Source-identity + splice-safety tripwires (the primary drift net) ───────

test('mount-runtime source() equals the served public/mount-runtime.js byte-for-byte', () => {
  const onDisk = fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8');
  assert.equal(src.source(), onDisk, 'the text the server splices must equal the file the browser is served');
});

test('mount-runtime source is splice-safe: no script/style tag literal at all', () => {
  // The source is spliced verbatim inside a <script> element. A </script (or
  // </style) would break OUT of it; an opening <script would inflate the export's
  // tag count (export.test.js asserts an exact count). The source is pure JS and
  // needs neither, so forbid both directions of both tags.
  const s = src.source();
  assert.equal(/<\/?script/i.test(s), false, 'no <script or </script literal');
  assert.equal(/<\/?style/i.test(s), false, 'no <style or </style literal');
});

// ── Served assets + load order ─────────────────────────────────────────────

const { withServer } = require('../test-support/helpers');

test('the server serves /mount-runtime.js and index.html loads it BEFORE the app modules', async (t) => {
  const { port } = await withServer(t);
  const served = await (await fetch(`http://localhost:${port}/mount-runtime.js`)).text();
  assert.equal(served, src.source(), '/mount-runtime.js serves the shared source verbatim');
  const idx = await (await fetch(`http://localhost:${port}/`)).text();
  const mrPos = idx.indexOf('/mount-runtime.js');
  const appPos = idx.indexOf('/app/main.js');
  assert.ok(mrPos > 0 && appPos > 0, 'both mount-runtime.js and the app entry are referenced in index.html');
  assert.ok(mrPos < appPos, 'mount-runtime.js (classic) must load before /app/main.js (store.js calls createStore at module eval)');
});

// ── Preview route (splices + executes the shared runtime) ──────────────────

test('the /preview/node doc splices the shared runtime source verbatim', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'm1', html: '<p>hi</p>' });
  await api.post('/api/commit', { message: 'seed' }); // fresh graph → n0
  const html = await (await fetch(`http://localhost:${port}/preview/node/n0`)).text();
  assert.ok(html.includes(src.source()), 'preview must ship the same runtime bytes');
});

test('a node preview renders + executes offline under jsdom, keeping the sandbox (window.store undefined)', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', {
    id: 'm1',
    html: '<output id="o"></output><script>store.set({hit:1}); root.getElementById("o").textContent = "P:" + mountId;</script>',
    params: { title: 'T' },
  });
  await api.post('/api/commit', { message: 'seed' });
  const html = await (await fetch(`http://localhost:${port}/preview/node/n0`)).text();
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  await new Promise((r) => setTimeout(r, 50));
  const host = dom.window.document.getElementById('m1');
  assert.ok(host, 'preview pane mounted');
  assert.equal(host.shadowRoot.getElementById('o').textContent, 'P:m1', 'preview script ran');
  assert.equal(dom.window.store, undefined, 'preview store is NOT on window (sandbox preserved)');
  dom.window.close();
});

// The live client mount()→runtime end-to-end consumption (hello merge, render →
// pane mounts + component script runs, store.set → ws publish echo) now lives in
// test/client-boot.test.js, which loads the real ES-module graph (the monolithic
// public/client.js was rewritten into public/app/*.js in Phase 7).

// ── DOM primitives under jsdom (attachAndExtract + runScripts) ──────────────

function withDom(t) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const saved = { window: global.window, document: global.document, CustomEvent: global.CustomEvent };
  global.window = dom.window;
  global.document = dom.window.document;
  global.CustomEvent = dom.window.CustomEvent;
  t.after(() => {
    global.window = saved.window;
    global.document = saved.document;
    global.CustomEvent = saved.CustomEvent;
  });
  return dom.window.document;
}

test('attachAndExtract: builds a shadow root, mounts declared markup, lifts out <script> bodies', (t) => {
  const document = withDom(t);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const { root, scripts } = mount.attachAndExtract(host, '<p id="hi">yo</p><script>a=1</script><b>x</b>');
  assert.equal(root.host, host, 'root.host is the host element');
  assert.equal(root.querySelector('#hi').textContent, 'yo');
  assert.equal(root.querySelector('b').textContent, 'x');
  assert.equal(root.querySelector('script'), null, 'the <script> is removed from the mounted DOM');
  assert.deepEqual(scripts, ['a=1']);
});

test('runScripts: runs each body as new Function(store,root,params,mountId); a throw is isolated', (t) => {
  const document = withDom(t);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const store = mount.createStore({});
  const { root, scripts } = mount.attachAndExtract(
    host,
    '<div></div>'
    + '<script>throw new Error("boom")</script>'
    + '<script>store.set({ran:true}); root.host.dataset.paneTitle = params.title + ":" + mountId;</script>',
  );
  mount.runScripts(root, scripts, store, { title: 'T' }, 'm1');
  assert.equal(store.get('ran'), true, 'the 2nd script ran despite the 1st throwing');
  assert.equal(host.dataset.paneTitle, 'T:m1', 'store / root.host / params / mountId are all wired');
});

test('the assembled export splices the shared runtime source verbatim', () => {
  const { assembleExport } = require('../lib/server/export');
  const html = assembleExport({ mounts: [{ id: 'm1', html: '<p>x</p>', params: {} }], store: { a: 1 } });
  assert.ok(html.includes(src.source()), 'export must ship the same bytes the browser is served');
});

test('a full assembled export renders + executes OFFLINE under jsdom (end-to-end)', async () => {
  const { assembleExport } = require('../lib/server/export');
  const html = assembleExport({
    mounts: [{
      id: 'm1',
      html: '<output id="o"></output><script>store.set({hit:1}); root.getElementById("o").textContent = "RAN:" + mountId; root.host.dataset.paneTitle = "T";</script>',
      params: {},
      tokens: { '--wc-accent': '#123456' },
      css: 'output{color:red}',
    }],
    store: { seed: 9 },
    meta: { label: 'n1.0' },
  });
  // runScripts:'dangerously' executes the export's inline scripts — the shared
  // runtime + shell — with NO server and no network (a true offline render).
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  await new Promise((r) => setTimeout(r, 50));
  const host = dom.window.document.getElementById('m1');
  assert.ok(host, 'pane host mounted');
  assert.equal(host.shadowRoot.getElementById('o').textContent, 'RAN:m1', 'component script ran with root + mountId');
  assert.equal(dom.window.store.get('seed'), 9, 'store seeded from the JSON payload');
  assert.equal(dom.window.store.get('hit'), 1, 'store.set from the script took effect');
  assert.equal(host.parentElement.style.getPropertyValue('--wc-accent'), '#123456', 'per-pane token applied');
  assert.equal(host.parentElement.querySelector('.pane-title').textContent, 'T', 'data-pane-title honored');
  dom.window.close();
});

test('runScripts + createStore: a mounted script can subscribe and receive later store writes', (t) => {
  const document = withDom(t);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const store = mount.createStore({});
  const { root, scripts } = mount.attachAndExtract(
    host,
    '<output id="o"></output><script>store.subscribe("n", function (v) { root.getElementById("o").textContent = String(v); });</script>',
  );
  mount.runScripts(root, scripts, store, {}, 'm1');
  store.set({ n: 42 });
  assert.equal(root.getElementById('o').textContent, '42');
});
