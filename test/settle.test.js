// The settle sync point (annotation engine 1C.3) — public/mount-runtime.js
// `settle` / `onSettle` / `generation` / `itemEl`, driven through the runtime's
// node export (the same object the browser gets as window.__wcMount).
//
// Pinned here:
//   - settle counts per root (1, 2, 3 on one root; 1 on a second), tells every
//     listener (root, mountId, gen, why) in registration order, survives a
//     throwing listener, and touches no DOM and creates no ids;
//   - onSettle's unsubscribe removes exactly one registration; generation reads
//     0 before any settle;
//   - itemEl finds every pane host and markdown block by id in the documents
//     that draw a node — a preview (the daemon's own /preview/node), an export
//     (assembleExport) and a replay frame (assembleReplay's frame filled as the
//     player fills it) — with the right kind and no misses, a pane whose id
//     names one of the document's own elements as its host, and an unknown id
//     as null. The live chrome's half is test/settle-chrome.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const M = require('../public/mount-runtime.js');
const { withServer } = require('../test-support/helpers');
const { assembleExport } = require('../lib/server/export');
const { assembleReplay, normalizeReplayOpts } = require('../lib/server/replay/document');

// One listener registration for the length of a test.
function listen(t, fn) {
  const off = M.onSettle(fn);
  t.after(off);
  return off;
}

test('settle: exported on module.exports beside the runtime it extends', () => {
  for (const k of ['settle', 'onSettle', 'generation', 'itemEl']) assert.equal(typeof M[k], 'function', k);
});

test('settle: counts per root — 1, 2, 3 on one root, 1 on a second; generation follows', () => {
  const a = {}, b = {};
  assert.equal(M.generation(a), 0, 'never settled: generation 0');
  assert.equal(M.settle(a, 'p', 'mount'), 1);
  assert.equal(M.settle(a, 'p', 'form'), 2);
  assert.equal(M.settle(a, 'p', 'mode'), 3);
  assert.equal(M.generation(a), 3);
  assert.equal(M.generation(b), 0, 'a second root is counted on its own');
  assert.equal(M.settle(b, 'q', 'mount'), 1);
  assert.equal(M.generation(a), 3);
  assert.equal(M.generation(b), 1);
});

test('settle: listeners get (root, mountId, gen, why), in registration order', (t) => {
  const root = {};
  const seen = [];
  listen(t, (r, id, gen, why) => seen.push(['first', r === root, id, gen, why]));
  listen(t, (r, id, gen, why) => seen.push(['second', r === root, id, gen, why]));
  M.settle(root, 'p1', 'mount');
  M.settle(root, 'p1', 'mode');
  assert.deepEqual(seen, [
    ['first', true, 'p1', 1, 'mount'], ['second', true, 'p1', 1, 'mount'],
    ['first', true, 'p1', 2, 'mode'], ['second', true, 'p1', 2, 'mode'],
  ]);
});

test('settle: a throwing listener stops neither the next listener nor the caller', (t) => {
  const errors = [];
  const saved = console.error;
  console.error = (...a) => errors.push(a);
  t.after(() => { console.error = saved; });
  const seen = [];
  listen(t, () => { throw new Error('boom'); });
  listen(t, (r, id, gen) => seen.push(gen));
  let gen;
  assert.doesNotThrow(() => { gen = M.settle({}, 'p', 'mount'); });
  assert.equal(gen, 1, 'the caller still gets its generation');
  assert.deepEqual(seen, [1], 'the listener after the throwing one ran');
  assert.equal(errors.length, 1, 'the throw is reported, not swallowed');
});

test('onSettle: the unsubscribe removes exactly one registration, once', (t) => {
  const seen = [];
  const fn = (r, id) => seen.push(id);
  const offA = M.onSettle(fn);
  const offB = M.onSettle(fn);   // the same function, registered twice
  t.after(offA); t.after(offB);
  M.settle({}, 'one', 'mount');
  assert.deepEqual(seen, ['one', 'one']);
  offA();
  offA();   // a second call removes nothing more
  M.settle({}, 'two', 'mount');
  assert.deepEqual(seen, ['one', 'one', 'two'], 'one registration left');
  offB();
  M.settle({}, 'three', 'mount');
  assert.deepEqual(seen, ['one', 'one', 'two'], 'none left');
  assert.throws(() => M.onSettle('nope'), TypeError);
});

test('settle with no listeners touches no DOM: the root is byte-identical, no ids appear', () => {
  const dom = new JSDOM('<!doctype html><body><main id="m"><div class="mount-host" id="p1"></div></main></body>');
  const doc = dom.window.document;
  const root = doc.getElementById('p1').attachShadow({ mode: 'open' });
  root.innerHTML = '<p id="x">hello <b>there</b></p><input value="v">';
  const before = root.innerHTML;
  const ids = doc.querySelectorAll('[id]').length;
  assert.equal(M.settle(root, 'p1', 'mount'), 1);
  assert.equal(root.innerHTML, before);
  assert.equal(doc.querySelectorAll('[id]').length, ids);
  assert.equal(root.querySelectorAll('[id]').length, 1);
  dom.window.close();
});

test('settle: a missing root is not a root (0, nobody told)', (t) => {
  const seen = [];
  listen(t, () => seen.push(1));
  assert.equal(M.settle(null, 'p', 'mount'), 0);
  assert.equal(M.generation(null), 0);
  assert.deepEqual(seen, []);
});

// ── itemEl over the documents ────────────────────────────────────────────────

// Every pane id and markdown id is found with the right kind (0 misses), the
// pane's element is its .mount-host, the markdown's its [data-md-id] block, and
// an unknown id is null.
function assertFinds(doc, { panes, md }, where) {
  for (const id of panes) {
    const hit = M.itemEl(doc, id);
    assert.ok(hit, `${where}: pane ${id} found`);
    assert.equal(hit.kind, 'pane', `${where}: ${id} is a pane`);
    assert.ok(hit.el.classList.contains('mount-host'), `${where}: ${id} → its mount host`);
    assert.ok(hit.el.shadowRoot, `${where}: ${id}'s host carries the pane's shadow root`);
  }
  for (const id of md) {
    const hit = M.itemEl(doc, id);
    assert.ok(hit, `${where}: markdown ${id} found`);
    assert.equal(hit.kind, 'md', `${where}: ${id} is markdown`);
    assert.equal(hit.el.getAttribute('data-md-id'), id);
  }
  assert.equal(M.itemEl(doc, 'no-such-item'), null, `${where}: an unknown id → null`);
  assert.equal(M.itemEl(doc, null), null);
}

test('itemEl: a preview (/preview/node) finds every pane and markdown item', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'p1', html: '<p>one</p>' });
  await api.post('/api/markdown', { id: 'md-1', text: '# Title', after: 'start' });
  await api.post('/api/render', { id: 'p2', html: '<p>two</p>' });
  await api.post('/api/markdown', { id: 'md-2', text: 'between', after: 'p1' });
  const c = await api.post('/api/commit', { message: 'one' });
  assert.equal(c.status, 200);
  const html = await (await fetch(`http://localhost:${port}/preview/node/n0`)).text();
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  assertFinds(dom.window.document, { panes: ['p1', 'p2'], md: ['md-1', 'md-2'] }, 'preview');
  // The document's own copy of the runtime answers the same.
  const own = dom.window.__wcMount;
  for (const id of ['p1', 'p2', 'md-1', 'md-2']) assert.equal(own.itemEl(dom.window.document, id).el, M.itemEl(dom.window.document, id).el);
  dom.window.close();
});

// A pane whose id names one of the document's own elements: the export's page
// container is #export-main, and a pane may be called that — only a scan of the
// mount hosts finds the pane rather than the page.
const DOC_MOUNTS = [
  { id: 'p1', html: '<p>one</p>', params: {} },
  { id: 'contents-nav', html: '<p>nav-named</p>', params: {} },
  { id: 'export-main', html: '<p>page-named</p>', params: {} },
];
const DOC_MARKDOWN = [{ id: 'md-1', text: '# Title' }, { id: 'md-2', text: 'after' }];
const DOC_ORDER = ['md-1', 'p1', 'contents-nav', 'md-2', 'export-main'];

test('itemEl: an export finds every pane and markdown item, a page-named pane as its host', () => {
  const html = assembleExport({ mounts: DOC_MOUNTS, markdown: DOC_MARKDOWN, order: DOC_ORDER });
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const doc = dom.window.document;
  assertFinds(doc, { panes: DOC_MOUNTS.map((m) => m.id), md: ['md-1', 'md-2'] }, 'export');
  const page = doc.getElementById('export-main');
  assert.equal(page.tagName, 'MAIN', 'a lookup by id finds the page container');
  assert.notEqual(M.itemEl(doc, 'export-main').el, page, 'itemEl finds the pane, never the page');
  assert.equal(M.itemEl(doc, 'export-main').el.shadowRoot.textContent, 'page-named');
  dom.window.close();
});

test('itemEl: a replay frame (filled as the player fills it) finds every pane and markdown item', () => {
  const step = {
    id: 'n0', label: 'n1.0', author: 'claude', kind: 'turn', prompt: 'p', summary: 's', reply: null,
    folded_count: 0, created_at: 1000, dt_from_prev: null, theme: 0,
    node: { id: 'n0', mounts: DOC_MOUNTS, markdown: DOC_MARKDOWN, order: DOC_ORDER, store: {} },
  };
  const html = assembleReplay({ steps: [step], themes: [{}], opts: normalizeReplayOpts({}) });
  const payload = JSON.parse(new JSDOM(html).window.document.getElementById('wc-replay-data').textContent);
  const [a, b, c, d] = payload.frame;
  const s = payload.steps[0];
  const dom = new JSDOM(a + payload.themes[s.theme] + b + c + s.node + d, { runScripts: 'dangerously' });
  assertFinds(dom.window.document, { panes: DOC_MOUNTS.map((m) => m.id), md: ['md-1', 'md-2'] }, 'replay frame');
  dom.window.close();
});
