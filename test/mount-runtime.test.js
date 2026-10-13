const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { PUBLIC_DIR } = require('../lib/core/paths');
const src = require('../lib/server/runtime/mount-runtime-src');
const { PREVIEW_CSP } = require('../lib/core/cors');

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

test('the /preview/node response carries the CSP, on the 404 branch too', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'm1', html: '<p>hi</p>' });
  await api.post('/api/commit', { message: 'seed' });

  // The graph viewer draws one of these per visible node, every time it draws,
  // executing pane scripts from nodes the user is not on — against the LIVE
  // daemon, same-origin, unless something says otherwise. connect-src is that
  // something; jsdom enforces no CSP, so the header itself is the assertion.
  const res = await fetch(`http://localhost:${port}/preview/node/n0`);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.equal(csp, PREVIEW_CSP);
  assert.match(csp, /connect-src 'none'/, 'the load-bearing directive');
  assert.match(csp, /script-src [^;]*'unsafe-eval'/,
    "the spliced runtime runs pane code through new Function — without 'unsafe-eval' every preview blanks");

  const missing = await fetch(`http://localhost:${port}/preview/node/nope`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('content-security-policy'), PREVIEW_CSP,
    'the policy is not a function of which branch ran');
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

// Panes spawning panes: a script gets `api` beside store/root. The live chrome
// passes one bound to the mount; a frozen page (export, preview) passes none and
// the script gets a stand-in whose verbs resolve to a refusal instead of throwing
// — a pane that spawns children still mounts in a snapshot.
test('runScripts: hands each script `api` — the caller\'s, or a frozen stand-in that never throws', async () => {
  const seen = [];
  const store = mount.createStore({});
  const live = { spawn: (s) => Promise.resolve({ ok: true, spec: s }), close: () => Promise.resolve({ ok: true }) };
  mount.runScripts(null, ['store.set({ got: api })'], store, {}, 'm1', (e) => seen.push(e), live);
  assert.equal(store.get('got'), live, 'the live api is passed through as-is');
  mount.runScripts(null, ['store.set({ p: api.spawn({ html: "x" }), c: api.close("m1") })'], store, {}, 'm1', (e) => seen.push(e));
  assert.deepEqual(seen, [], 'calling the frozen api does not throw');
  const p = await store.get('p');
  assert.equal(p.ok, false);
  assert.equal(p.frozen, true);
  assert.equal((await store.get('c')).frozen, true);
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

// ── a pane's lifecycle (U98): runScripts' `life`, frozenPaneApi's signal and onUnmount ──

test('runScripts without `life` compiles as it always did: a script reading the timer names gets the globals', () => {
  const store = mount.createStore({});
  mount.runScripts(null, ['store.set({ si: setInterval, st: setTimeout, n: arguments.length })'], store, {}, 'm1');
  assert.strictEqual(store.get('si'), globalThis.setInterval);
  assert.strictEqual(store.get('st'), globalThis.setTimeout);
  assert.strictEqual(store.get('n'), 5, 'store, root, params, mountId, api — and nothing more');
});

test('runScripts with `life` shadows the six timer names, calls the globals at call time, and records each handle', (t) => {
  const seen = [];
  const saved = { si: global.setInterval, ci: global.clearInterval, raf: global.requestAnimationFrame, caf: global.cancelAnimationFrame };
  t.after(() => {
    global.setInterval = saved.si; global.clearInterval = saved.ci;
    if (saved.raf === undefined) delete global.requestAnimationFrame; else global.requestAnimationFrame = saved.raf;
    if (saved.caf === undefined) delete global.cancelAnimationFrame; else global.cancelAnimationFrame = saved.caf;
  });
  const life = { timers: new Set(), signal: new AbortController().signal, onUnmount() {} };
  const store = mount.createStore({});
  const errors = [];
  mount.runScripts(null, ['store.set({ si: setInterval, go: function () { return setInterval(function () {}, 99); } })'],
    store, {}, 'm1', (e) => errors.push(e), null, life);
  assert.deepStrictEqual(errors, []);
  assert.notStrictEqual(store.get('si'), globalThis.setInterval, 'the pane sees its own setInterval');
  // Stubbed AFTER the mount: the pane's call must reach this one.
  global.setInterval = (fn, ms) => { seen.push(['set', ms]); return 41; };
  global.clearInterval = (h) => { seen.push(['clear', h]); };
  assert.strictEqual(store.get('go')(), 41);
  assert.deepStrictEqual(seen, [['set', 99]]);
  const [entry] = [...life.timers];
  assert.strictEqual(entry.handle, 41);
  assert.strictEqual(entry.kind, 'interval');
  entry.clear();
  assert.deepStrictEqual(seen[1], ['clear', 41], 'the entry\'s clear is the matching global clear');

  // a frame, cleared by the pane itself, leaves the record
  global.requestAnimationFrame = () => 7;
  global.cancelAnimationFrame = (h) => seen.push(['caf', h]);
  life.timers.clear();
  mount.runScripts(null, ['cancelAnimationFrame(requestAnimationFrame(function () {}))'], store, {}, 'm1', (e) => errors.push(e), null, life);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(life.timers.size, 0);
  assert.deepStrictEqual(seen[seen.length - 1], ['caf', 7]);
});

test('runScripts with `life`: a script that declares a timer name itself still compiles, on the globals', () => {
  const life = { timers: new Set(), signal: new AbortController().signal, onUnmount() {} };
  const store = mount.createStore({});
  const errors = [];
  mount.runScripts(null, ['const setTimeout = 5; store.set({ v: setTimeout })', 'store.set({ w: 1 +'], store, {}, 'm1',
    (e, i) => errors.push(i), null, life);
  assert.strictEqual(store.get('v'), 5);
  assert.deepStrictEqual(errors, [1], 'a real syntax error is still reported, once');
});

test('frozenPaneApi: a signal that never aborts and an onUnmount that does nothing', () => {
  const api = mount.frozenPaneApi();
  assert.strictEqual(api.signal.aborted, false);
  let called = 0;
  assert.strictEqual(api.onUnmount(() => { called++; }), undefined);
  assert.strictEqual(called, 0);
  assert.doesNotThrow(() => api.signal.addEventListener('abort', () => {}));
});

test('frozenPaneApi: where AbortController is missing, a stand-in signal that answers the same questions', (t) => {
  const saved = global.AbortController;
  t.after(() => { global.AbortController = saved; });
  delete global.AbortController;
  const api = mount.frozenPaneApi();
  assert.strictEqual(api.signal.aborted, false);
  assert.doesNotThrow(() => { api.signal.addEventListener('abort', () => {}); api.signal.removeEventListener('abort', () => {}); });
});

// No parser ships with the repo, so the source is tokenised just enough to
// drop comments and string literals (it holds no regex literals), and what is
// left must carry no ES2015+ syntax a baked export could choke on.
test('mount-runtime source stays ES5-ish: no arrow, let/const, class, template, spread, ** or async/await syntax', () => {
  const s = fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8');
  let code = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; code += '\n'; continue; }
    if (c === '/' && n === '*') { i = s.indexOf('*/', i + 2) + 1; code += ' '; continue; }
    if (c === '\'' || c === '"') {
      i++;
      while (i < s.length && s[i] !== c) { if (s[i] === '\\') i++; i++; }
      code += '""';
      continue;
    }
    code += c;
  }
  for (const [re, what] of [[/=>/, 'an arrow function'], [/\b(let|const|class)\s/, 'let/const/class'], [/`/, 'a template literal'],
    [/\.\.\./, 'spread/rest'], [/\*\*/, 'exponentiation'], [/\b(async|await)\b/, 'async/await']]) {
    assert.doesNotMatch(code, re, `public/mount-runtime.js uses ${what}`);
  }
});

const LIFECYCLE_SCRIPT = '<output id="o"></output><script>'
  + 'api.signal.addEventListener("abort", function () {});'
  + 'window.addEventListener("resize", function () {}, { signal: api.signal });'
  + 'api.onUnmount(function () { root.getElementById("o").textContent = "UNMOUNTED"; });'
  + 'root.getElementById("o").textContent = "LIFE:" + api.signal.aborted;'
  + '</script>';

test('an exported page runs a pane script that uses api.signal and api.onUnmount without throwing', async () => {
  const { assembleExport } = require('../lib/server/export');
  const html = assembleExport({ mounts: [{ id: 'm1', html: LIFECYCLE_SCRIPT, params: {} }], store: {}, meta: { label: 'n1.0' } });
  const { VirtualConsole } = require('jsdom');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', (...a) => errors.push(a.map(String).join(' ')));
  virtualConsole.on('jsdomError', (e) => errors.push(String(e && e.message)));
  const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole });
  await new Promise((r) => setTimeout(r, 50));
  const host = dom.window.document.getElementById('m1');
  assert.ok(host, 'pane host mounted');
  assert.strictEqual(host.shadowRoot.getElementById('o').textContent, 'LIFE:false');
  assert.deepStrictEqual(errors, []);
  dom.window.close();
});

test('a node preview runs a pane script that uses api.signal and api.onUnmount without throwing', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'm1', html: LIFECYCLE_SCRIPT, params: { title: 'T' } });
  await api.post('/api/commit', { message: 'seed' });
  const html = await (await fetch(`http://localhost:${port}/preview/node/n0`)).text();
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  await new Promise((r) => setTimeout(r, 50));
  const host = dom.window.document.getElementById('m1');
  assert.ok(host, 'preview pane mounted');
  assert.strictEqual(host.shadowRoot.getElementById('o').textContent, 'LIFE:false');
  dom.window.close();
});
