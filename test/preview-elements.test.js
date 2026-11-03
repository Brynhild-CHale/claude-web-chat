// The node preview and /preview/pane draw elements (annotation engine
// tranche 4, PLAN.md 4B.1's preview half; DECISIONS.md B3, R1 stage B, K.5
// J2, N.1 AD5 = a; U523).
//
// What must hold:
//   - GET /preview/node/:id fills the template's anchors hole with the
//     resolver's script and, right after it, the element payload as
//     elements-doc-src scripts() splices it — the runtime, each listed
//     plug-in type's module, one data element — for the request's reader
//     (documentElements, readerOf): a local browser views the preview in
//     place, so it gets its private elements; lib/client and a remote read
//     viewer get the shared ones only; a remote basic viewer and a network
//     peer get no runtime and no data element (the document as before 4B);
//   - loaded, the local browser's preview draws one el-marker per placed item;
//   - a pin masked by a value learned after the commit rides with the served
//     state 'masked' and is drawn el-masked (U415e's residue, the document
//     half);
//   - a type whose pack was removed after the commit is in the payload's
//     `removed` and drawn as the generic mark;
//   - GET /preview/pane/:node/:mount carries only the items anchored on that
//     pane, and a pane with none is drawn as before (no resolver, no runtime);
//   - renderPreviewHtml(node, theme) with no payload keeps the template's
//     bytes around the holes, and the embedded node carries no `comments` or
//     `elements` key: the payload is the documents' one element carrier.
//
// The scenarios run on a real daemon (withServer): the elements written
// through POST /api/elements, each node a turn's commit, the plug-in type a
// pack approved in process (test-support/element-type-fixture: B1's path).
// The network-peer case needs a socket address the daemon cannot be handed,
// so it mounts the graph routes on a bare host over the same daemon's graph,
// as test/graph-text-rules.test.js and test/replay-elements.test.js do.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { JSDOM } = require('jsdom');

const { withServer, tmpRoot, waitUntil } = require('../test-support/helpers');
const { approveElementPack } = require('../test-support/element-type-fixture');
const { fixture } = require('../test-support/doc-elements-fixture');
const packs = require('../lib/packs/install');
const client = require('../lib/client');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths, projectPaths } = require('../lib/core/paths');
const { createAudience } = require('../lib/server/audience');
const { createBus } = require('../lib/core/bus');
const { resolvePaths } = require('../lib/server/paths');
const { mountGraphRoutes } = require('../lib/server/routes/graph');
const {
  previewTemplate, previewThemeCss, previewNodeJson, renderPreviewHtml, pageItems,
} = require('../lib/server/preview');
const { scriptElement: anchorsScript, kindsOf } = require('../lib/server/runtime/anchors-src');
const { scripts, runtimeElement, typeElement, dataElement, keyOf } = require('../lib/server/runtime/elements-doc-src');
const { documentElements, documentDeps } = require('../lib/server/document-elements');

const TYPE = 'pv-mark';
const SENTINEL = 'PV-MARK-DRAW-SENTINEL';
const MARK_DRAW = [
  `// ${TYPE}: ${SENTINEL}`,
  'export default function draw(group, ctx) {',
  "  if (group.container) group.container.setAttribute('data-pv-mark', String(group.items.length));",
  '}',
  '',
].join('\n');
const MARK_JSON = { payload: { keys: ['anchor', 'shared', 'label'] }, anchors: ['element', 'range'] };

const HTML_A = '<p class="lead">Hello world</p><p class="step">The second line</p><p class="third">A third line here</p>';
const HTML_B = '<figure><svg class="chart" viewBox="0 0 10 10" width="100" height="100"><rect width="10" height="10"/></svg></figure>';
const HTML_C = '<p class="none">Nothing is anchored here</p>';
const LOCATOR = (mount, selector, text) => ({ mount, selector, text, ordinal: 0 });
const RANGE = { v: 1, kind: 'range', mount: 'pa', quote: { exact: 'third line', prefix: 'A ', suffix: ' here' }, pos: { start: 2, end: 12 } };
const ELEMENT = (mount) => ({ v: 1, kind: 'element', mount, at: { path: [0, 0], sib: 0 }, fp: { tag: 'svg', id: '', cls: ['chart'], head: '', attrs: [], parent: 'figure' }, rows: [] });

const SHARED_TEXT = 'PV-SHARED-NOTE';
const PRIVATE_TEXT = 'PV-PRIVATE-NOTE';
const HL_NOTE = 'PV-HIGHLIGHT-NOTE';
const REMOTE = { 'X-WC-Remote': '1' };
const ROUTE = 'GET /preview/node/:id';
const DATA_RE = /<script type="application\/json" data-wc-elements>([^<]*)<\/script>/g;

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
const post = (api, body, what) => ok(api.post('/api/elements', body), what);
async function commit(api, k) {
  await ok(api.post('/api/turn-begin', { message: `prompt ${k}` }), 'turn-begin');
  const r = await ok(api.post('/api/turn-end', { author: 'claude', reply: `reply ${k}` }), 'turn-end');
  assert.ok(r.node_id, `a node committed: ${JSON.stringify(r)}`);
  return r.node_id;
}
const count = (hay, needle) => hay.split(needle).length - 1;
// A document's data elements, parsed.
const dataOf = (html) => [...html.matchAll(DATA_RE)].map((m) => JSON.parse(m[1]));
const idsOf = (html) => dataOf(html).flatMap((p) => p.items.map((it) => it.id));
const seed = (level) => ({ root: r }) => writeJsonAtomic(userPaths().tunnelConfig, {
  hostname: 'wc.example.test', style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
  remote: { mirror: { [path.resolve(r)]: level } },
});
const depsOf = (d) => documentDeps({ graph: d.srv.graph, sideTable: d.srv.sideTable, elementTypes: d.srv.elementTypes, root: d.root });
const LOCAL = Object.freeze({ level: 'local', seesPrivate: true });

// The scenario: three panes; on pa a shared comment, a private comment and a
// shared highlight, on pb an element of the listed fixture type, on pc
// nothing; one commit. The daemon's remote viewers are opted in at `read`.
async function scenario(t) {
  const d = await withServer(t, { root: tmpRoot('wc-preview-el-'), seed: seed('read') });
  const { api, anonApi } = d;
  approveElementPack(d, { name: 'pv-pack', type: TYPE, json: MARK_JSON, draw: MARK_DRAW });
  assert.ok(d.srv.elementTypes.listed(TYPE), 'the fixture type lists');
  for (const [id, html] of [['pa', HTML_A], ['pb', HTML_B], ['pc', HTML_C]]) await ok(api.post('/api/render', { id, html }), `render ${id}`);
  const ids = {};
  ids.shared = (await post(anonApi, { type: 'comment', anchor: LOCATOR('pa', 'p.lead', 'Hello world'), payload: { text: SHARED_TEXT, shared: true } }, 'shared comment')).element.id;
  ids.priv = (await post(anonApi, { type: 'comment', anchor: LOCATOR('pa', 'p.step', 'The second line'), payload: { text: PRIVATE_TEXT, shared: false } }, 'private comment')).element.id;
  ids.hl = (await post(anonApi, { type: 'highlight', anchor: RANGE, payload: { note: HL_NOTE } }, 'shared highlight')).element.id;
  ids.mark = (await post(anonApi, { type: TYPE, anchor: ELEMENT('pb'), payload: { label: 'pv mark' } }, 'plug-in mark')).element.id;
  const nodeId = await commit(api, 1);
  const node = d.srv.graph.nodes.get(nodeId);
  assert.ok(node.comments.length === 2 && node.elements.length === 2, `precondition: two copies, two references: ${JSON.stringify([node.comments.map((c) => c.id), node.elements])}`);
  return { d, ids, nodeId, node };
}

// A bare host over the daemon's own graph, store, side table and registry,
// with no remote opt-in: a remote request and a network peer (x-test-peer:
// the socket's address while the route runs) are basic.
async function bareHost(t, d) {
  const app = express();
  app.use((req, res, next) => {
    const addr = req.headers['x-test-peer'];
    if (!addr) return next();
    const real = req.socket;
    req.socket = { remoteAddress: addr, localPort: real.localPort };
    try { next(); } finally { req.socket = real; }
  });
  const ctx = {
    graph: d.srv.graph, paths: resolvePaths(d.root), root: d.root, bus: createBus(), broadcastReset: () => {},
    sideTable: d.srv.sideTable, elementTypes: d.srv.elementTypes, audience: createAudience({ configFile: null }),
  };
  mountGraphRoutes(app, ctx);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const port = server.address().port;
  return (p, headers) => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: p, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    }).on('error', reject);
  });
}

// Opens a document in jsdom with each anchored element given its own box
// (so the resolver places what it resolves, each at its own place); `define`
// stands in for a plug-in module (jsdom runs no module script).
const WINDOWS = [];
test.after(() => { for (const w of WINDOWS) w.close(); });
const TOPS = { lead: 10, step: 60, third: 110, chart: 160, none: 210, tok: 260 };
function openDoc(html, defineType = null) {
  const box = (top) => ({ left: 10, top, width: 100, height: 20, right: 110, bottom: top + 20, x: 10, y: top });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(win) {
      win.fetch = () => { throw new Error('no fetch in a document'); };
      win.Element.prototype.getBoundingClientRect = function () {
        const cls = (this.getAttribute && this.getAttribute('class')) || '';
        const key = Object.keys(TOPS).find((k) => cls.split(' ').includes(k));
        if (key) return box(TOPS[key]);
        if (cls.split(' ').includes('mount-host')) return { left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400, x: 0, y: 0 };
        return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };
      };
      win.Range.prototype.getClientRects = function () {
        const p = this.startContainer && this.startContainer.parentNode;
        const cls = (p && p.getAttribute && p.getAttribute('class')) || '';
        return TOPS[cls] != null ? [box(TOPS[cls])] : [];
      };
    },
  });
  WINDOWS.push(dom.window);
  if (defineType) dom.window.__wcMount.elements.define(defineType, (group) => { if (group.container) group.container.setAttribute('data-pv-mark', '1'); }, {});
  return dom.window;
}
const settled = async (win) => {
  await waitUntil(() => win.document.readyState === 'complete', { timeout: 5000, what: 'the load event' });
  await new Promise((r) => win.setTimeout(r, 30));
};
const markers = (win) => [...win.document.querySelectorAll('.wc-el-layer .el-marker')];
const markerOf = (win, id) => markers(win).find((m) => (m.getAttribute('data-el-ids') || '').split(' ').includes(id));

// ── the node preview ────────────────────────────────────────────────────────

test('GET /preview/node/:id from a local browser: the resolver, then the runtime, the type\'s module and one data element, in the anchors hole; the private pin\'s text rides; loaded, one el-marker per placed item', async (t) => {
  const { d, ids, nodeId, node } = await scenario(t);
  const r = await d.anonApi.get(`/preview/node/${nodeId}`);
  assert.equal(r.status, 200, r.text);
  const html = r.text;
  const p = documentElements(depsOf(d), node, { reader: LOCAL, route: ROUTE });
  assert.ok(p, 'the local browser sees elements');
  assert.deepStrictEqual(p.items.map((it) => it.id).sort(), Object.values(ids).sort(), 'every item, the private one included');
  assert.deepStrictEqual(p.types.map((row) => row.type), [TYPE], 'the listed type has a row');
  const [, b, c] = previewTemplate();
  const resolver = anchorsScript({ kinds: kindsOf(node) });
  // In that order, contiguous, inside the anchors hole.
  const rt = runtimeElement(keyOf(p));
  const mod = typeElement(p.types[0]);
  const data = dataElement(p);
  assert.equal(scripts(p), rt + mod + data, 'scripts() is the three parts');
  assert.ok(html.includes(b + resolver + rt + mod + data + c), 'the hole: the resolver, the runtime, the type\'s module, one data element');
  assert.equal(count(html, SENTINEL), 1, 'the module rides once');
  assert.equal(dataOf(html).length, 1, 'one data element');
  assert.ok(html.includes(PRIVATE_TEXT) && html.includes(SHARED_TEXT), 'the private pin\'s text rides, in the payload');
  // The embedded node carries no element records any more.
  const nodeJson = /const NODE = (\{[\s\S]*?\});\n/.exec(html);
  assert.ok(nodeJson, 'the node hole');
  const embedded = JSON.parse(nodeJson[1]);
  assert.ok(!('comments' in embedded) && !('elements' in embedded), `no comments or elements key: ${Object.keys(embedded)}`);
  assert.ok(!nodeJson[1].includes(PRIVATE_TEXT), 'the private text is not in the node hole');

  const win = openDoc(html, TYPE);
  await settled(win);
  for (const id of Object.values(ids)) assert.ok(markerOf(win, id), `${id} is drawn`);
  for (const id of Object.values(ids)) {
    assert.equal(markers(win).filter((m) => (m.getAttribute('data-el-ids') || '').split(' ').includes(id)).length, 1, `${id}: one el-marker`);
  }
  assert.equal(markers(win).length, Object.keys(ids).length, 'one el-marker per placed item');
  assert.equal(markerOf(win, ids.mark).getAttribute('data-type'), TYPE, 'the plug-in item by its type');
  assert.equal(markerOf(win, ids.mark).getAttribute('data-pv-mark'), '1', 'drawn by its type\'s draw');
});

test('GET /preview/node/:id from lib/client and a remote read viewer: the shared items only, never a private item or its text; a remote basic viewer and a network peer: no runtime and no data element', async (t) => {
  const { d, ids, nodeId } = await scenario(t);
  const local = (await d.anonApi.get(`/preview/node/${nodeId}`)).text;
  const shared = [ids.shared, ids.hl, ids.mark].sort();
  const lib = await client.request(d.port, 'GET', `/preview/node/${nodeId}`, null, { timeout: 10000 });
  const remote = await d.anonApi.get(`/preview/node/${nodeId}`, REMOTE);
  for (const [who, status, html] of [['lib/client', lib.status, lib.body], ['a remote read viewer', remote.status, remote.text]]) {
    assert.equal(status, 200, who);
    assert.equal(typeof html, 'string', `${who}: a document`);
    assert.deepStrictEqual(idsOf(html).sort(), shared, `${who}: the shared items`);
    assert.ok(!html.includes(PRIVATE_TEXT), `${who}: no private text`);
    assert.ok(!html.includes(`"${ids.priv}"`), `${who}: no private item`);
    assert.ok(html.includes(SHARED_TEXT) && html.includes(SENTINEL), `${who}: the shared pin's text and the type's module`);
  }

  const get = await bareHost(t, d);
  for (const [who, headers] of [['a remote basic viewer', REMOTE], ['a network peer', { 'x-test-peer': '10.0.0.7' }], ['a network peer claiming the portal\'s label', { 'x-test-peer': '10.0.0.7', ...REMOTE }]]) {
    const r = await get(`/preview/node/${nodeId}`, headers);
    assert.equal(r.status, 200, `${who}: ${r.text}`);
    assert.equal(dataOf(r.text).length, 0, `${who}: no data element`);
    assert.ok(!r.text.includes('__wcMount.elements'), `${who}: no element runtime, no define line`);
    assert.ok(!r.text.includes(SENTINEL), `${who}: no module`);
    assert.ok(!r.text.includes(PRIVATE_TEXT) && !r.text.includes(SHARED_TEXT) && !r.text.includes(HL_NOTE), `${who}: no element text`);
    assert.equal(count(r.text, '<script'), count(local, '<script') - 3, `${who}: the local document less the runtime, the module and the data`);
  }
});

test('a pin masked by a value learned after the commit: its payload row carries state \'masked\' and the preview draws it el-masked', async (t) => {
  const d = await withServer(t);
  const { api, anonApi, root } = d;
  const value = `wcpv${crypto.randomBytes(12).toString('hex')}`;
  await ok(api.post('/api/render', { id: 'pt', html: `<p class="tok">Use ${value} for the staging host.</p>` }), 'render');
  const text = `Use ${value} for the staging host.`;
  const exact = `${value} for`;
  const i = text.indexOf(exact);
  const anchor = { v: 1, kind: 'range', mount: 'pt', quote: { exact, prefix: text.slice(0, i), suffix: text.slice(i + exact.length) }, pos: { start: i, end: i + exact.length } };
  const pin = (await post(anonApi, { type: 'comment', anchor, payload: { text: 'a pin on the passage', shared: true } }, 'comment')).element;
  const nodeId = await commit(api, 1);
  // Unmasked at the commit: drawn as any pin.
  const before = dataOf((await anonApi.get(`/preview/node/${nodeId}`)).text)[0].items.find((it) => it.id === pin.id);
  assert.ok(before && before.state === undefined, `precondition: not masked yet: ${JSON.stringify(before)}`);
  // The redactor learns the value (the capture token's file, a known source).
  fs.writeFileSync(projectPaths(root).captureToken, value + '\n');
  await waitUntil(async () => {
    const it = dataOf((await anonApi.get(`/preview/node/${nodeId}`)).text)[0].items.find((x) => x.id === pin.id);
    return it && it.state === 'masked';
  }, { timeout: 6000, what: 'the redactor learned the value' });
  const html = (await anonApi.get(`/preview/node/${nodeId}`)).text;
  const row = dataOf(html)[0].items.find((it) => it.id === pin.id);
  assert.equal(row.state, 'masked', 'the served state rides the row');
  assert.ok(typeof row.visible === 'string' && typeof row.explain === 'string', 'with its visible and explain');
  assert.ok(!JSON.stringify(row).includes(value), 'the row holds no fragment of the value');
  const win = openDoc(html);
  await settled(win);
  const m = markerOf(win, pin.id);
  assert.ok(m, 'the masked pin is drawn');
  assert.ok(m.classList.contains('el-masked'), `drawn el-masked: ${m.className}`);
});

test('a type whose pack was removed after the commit: in the payload\'s removed, drawn as the generic mark; its module rides nowhere', async (t) => {
  const { d, ids, nodeId } = await scenario(t);
  packs.removePackByName({ name: 'pv-pack', root: d.root });
  d.srv.elementTypes.invalidate();
  assert.equal(d.srv.elementTypes.listed(TYPE), false);
  const html = (await d.anonApi.get(`/preview/node/${nodeId}`)).text;
  const [p] = dataOf(html);
  assert.deepStrictEqual(p.removed, [TYPE]);
  assert.deepStrictEqual(p.types, [], 'no type row');
  assert.equal(p.items.find((it) => it.id === ids.mark).payload, null, 'its payload null');
  assert.equal(count(html, SENTINEL), 0, 'no module');
  const win = openDoc(html);
  await settled(win);
  const m = markerOf(win, ids.mark);
  assert.ok(m, 'the removed type\'s item is drawn');
  assert.ok(m.classList.contains('el-generic') && m.classList.contains('el-standin'), `the generic mark: ${m.className}`);
  assert.equal(m.querySelector('.el-generic-name').textContent, TYPE, 'naming its type');
  assert.ok(markerOf(win, ids.shared), 'the comment still drawn');
});

// ── /preview/pane ───────────────────────────────────────────────────────────

test('GET /preview/pane/:node/:mount: only the items anchored on that pane; a pane with none carries no resolver and no runtime', async (t) => {
  const { d, ids, nodeId, node } = await scenario(t);
  const pane = async (mount, api = d.anonApi) => {
    const r = await api.get(`/preview/pane/${nodeId}/${mount}`);
    assert.equal(r.status, 200, `${mount}: ${r.text}`);
    return r.text;
  };
  const pa = await pane('pa');
  assert.deepStrictEqual(idsOf(pa).sort(), [ids.shared, ids.priv, ids.hl].sort(), 'pa: its comments and its highlight');
  assert.equal(count(pa, SENTINEL), 0, 'pa: no module (no item of the type on it)');
  const pPa = documentElements(depsOf(d), node, { reader: LOCAL, route: 'GET /preview/pane/:node/:mount', item: 'pa' });
  const [, b, c] = previewTemplate();
  const kept = new Set(pPa.items.map((it) => it.id));
  const onPa = { comments: node.comments.filter((x) => kept.has(x.id)), elements: node.elements.filter((ref) => kept.has(ref.split('@')[0])) };
  assert.equal(onPa.comments.length + onPa.elements.length, 3, 'precondition: pa\'s three records');
  assert.ok(pa.includes(b + anchorsScript({ kinds: kindsOf(onPa) }) + scripts(pPa) + c), 'pa: the resolver for its items\' kinds, then their payload');
  const paWin = openDoc(pa);
  await settled(paWin);
  for (const id of [ids.shared, ids.priv, ids.hl]) assert.ok(markerOf(paWin, id), `pa: ${id} drawn over the one version shown`);
  assert.equal(markers(paWin).length, 3, 'pa: one el-marker per item');

  const pb = await pane('pb');
  assert.deepStrictEqual(idsOf(pb), [ids.mark], 'pb: the plug-in item only');
  assert.equal(count(pb, SENTINEL), 1, 'pb: its type\'s module');
  assert.ok(!pb.includes(SHARED_TEXT) && !pb.includes(PRIVATE_TEXT), 'pb: no other pane\'s item');
  const pbWin = openDoc(pb, TYPE);
  await settled(pbWin);
  assert.ok(markerOf(pbWin, ids.mark), 'pb: the plug-in item drawn');

  const pc = await pane('pc');
  assert.equal(dataOf(pc).length, 0, 'pc: no data element');
  assert.ok(!pc.includes('__wcMount.elements'), 'pc: no element runtime');
  assert.ok(pc.includes(b + c), 'pc: the anchors hole is empty, as before');

  // lib/client: the shared items of the pane only.
  const lib = await client.request(d.port, 'GET', `/preview/pane/${nodeId}/pa`, null, { timeout: 10000 });
  assert.equal(lib.status, 200);
  assert.deepStrictEqual(idsOf(lib.body).sort(), [ids.shared, ids.hl].sort(), 'lib/client: pa\'s shared items');
  assert.ok(!lib.body.includes(PRIVATE_TEXT), 'lib/client: no private text');
});

// ── the template ────────────────────────────────────────────────────────────

// The node hole's bytes before U523 (preview.js previewNodeJson then): the
// node less `markdown` and `mirror`, with its page baked in.
const before = (node) => {
  const { markdown: _m, mirror: _t, ...rest } = node;
  return JSON.stringify({ ...rest, page: pageItems(node) }).replace(/</g, '\\u003c');
};
const THEME = { tokens: { '--wc-bg': '#fefefe' } };

test('renderPreviewHtml with no payload: a pinless node\'s bytes as before; a pinned node\'s as before less its records in the node hole; the embedded node carries no comments or elements key', () => {
  const [a, b, c, d] = previewTemplate();
  const pinless = { id: 'n1', mounts: [{ id: 'm1', html: '<p>hi</p>' }], store: {}, markdown: [{ id: 'md-1', text: '# T' }], order: ['md-1', 'm1'] };
  const want = a + previewThemeCss(THEME) + b + c + before(pinless) + d;
  assert.equal(renderPreviewHtml(pinless, THEME), want, 'a pinless node: today\'s bytes');
  assert.equal(renderPreviewHtml(pinless, THEME, { elements: null }), want, 'a null payload: the same');
  assert.equal(renderPreviewHtml(pinless, THEME, { elements: fixture().payload }), want, 'a payload on a node that carries no records: nothing spliced (carriesElements decides)');

  const { node: fx, payload } = fixture();
  // The fixture's node with records of its own: a 0.8.5 comment copy on
  // fx-a's p.lead and an id@v reference.
  const node = { ...fx, comments: [{ id: 'c1', text: 'a note', shared: true, anchor: { mount: 'fx-a', selector: 'p.lead', text: 'x', ordinal: 0 } }], elements: ['h1@1'] };
  const { comments: _c, elements: _e, ...bare } = node;
  const resolver = anchorsScript({ kinds: kindsOf(node) });
  assert.equal(renderPreviewHtml(node, THEME), a + previewThemeCss(THEME) + b + resolver + c + before(bare) + d,
    'a pinned node: the resolver alone in the hole, the node hole without its records');
  assert.equal(renderPreviewHtml(node, THEME, { elements: payload }), a + previewThemeCss(THEME) + b + resolver + scripts(payload) + c + before(bare) + d,
    'with a payload: the payload right after the resolver, every piece else unchanged');
  const parsed = JSON.parse(previewNodeJson(node));
  assert.ok(!('comments' in parsed) && !('elements' in parsed), 'no comments or elements key');
  assert.ok(node.comments.length === 1 && node.elements.length === 1, 'the node itself is untouched');
});

// A committed picture entry is projected by the reader's element payload
// (U525c; GT-22 F9 at 06f4023f): a reference rides only when the payload
// carries that id; the describe (whose bbox covers every member) goes with
// any member; a null payload drops every reference; the entry's id, seq, ts,
// source and image stay; any other capture is byte-for-byte as committed; the
// node is never rewritten.
test('previewNodeJson: a picture entry keeps only the element references the payload carries; a null payload keeps none; other captures and the node untouched', () => {
  const picture = {
    id: 'cap4', seq: 4, ts: 1700000000000, url: 'element:p5', title: '', profile: 'element-picture', source: 'element:scribble',
    kind: 'element-picture',
    distilled: {
      kind: 'element-picture', type: 'scribble', elements: ['p1@1', 'p2@1', 'p5@1'],
      describe: { shape: 'underline', confidence: 0.8, count: 3, bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.04 } },
      previous: 'cap2', new: ['p5'],
    },
    image: { state: 'ready', capture: 'cap4', path: 'captures/cap4.png', sha256: 'ab'.repeat(32), width: 40, height: 30, bytes: 120 },
  };
  const grab = { id: 'cap1', seq: 1, url: 'element:p9', kind: 'box-grab', distilled: { kind: 'box-grab', element: 'p9', v: 1 } };
  const tab = { id: 'cap2', seq: 2, url: 'https://example.com/', kind: 'page', distilled: { title: 'x' } };
  const node = { id: 'n1', mounts: [], store: {}, captures: [grab, tab, picture] };
  const frozen = JSON.stringify(node);
  const embedded = (elements) => JSON.parse(previewNodeJson(node, { elements })).captures;
  const items = (...ids) => ({ v: 1, builtins: [], types: [], removed: [], items: ids.map((id) => ({ id, v: 1, type: 'scribble' })) });

  // Every member in the payload: the entry as committed.
  assert.deepEqual(embedded(items('p1', 'p2', 'p5')), [grab, tab, picture], 'a reader whose payload carries every member');

  // p5 (the newest member) not in the payload.
  const [g1, t1, p1] = embedded(items('p1', 'p2'));
  assert.deepEqual([g1, t1], [grab, tab], 'the box grab and the tab capture untouched');
  assert.deepEqual(p1.distilled.elements, ['p1@1', 'p2@1']);
  assert.deepEqual(p1.distilled.new, []);
  assert.equal(p1.distilled.describe, undefined, 'no describe: its bbox covers p5');
  assert.equal(p1.url, 'element:p2', 'the url names the newest kept member');
  for (const k of ['id', 'seq', 'ts', 'title', 'profile', 'source', 'kind', 'image']) assert.deepEqual(p1[k], picture[k], k);
  assert.equal(p1.distilled.previous, 'cap2', 'a capture id, not an element reference');
  assert.ok(!/p5/.test(JSON.stringify(p1)), JSON.stringify(p1));

  // A null payload, and an empty one: no element reference at all.
  for (const elements of [null, undefined, items()]) {
    const p = embedded(elements)[2];
    assert.deepEqual(p.distilled.elements, []);
    assert.equal(p.url, '');
    assert.equal(p.distilled.describe, undefined);
    assert.ok(!/\bp\d@\d|element:p\d/.test(JSON.stringify(p)), JSON.stringify(p));
    assert.equal(p.image.sha256, picture.image.sha256, 'the digest stays');
  }
  // The replay frame's call (no payload) and renderPreviewHtml's (with one) agree.
  assert.equal(previewNodeJson(node), previewNodeJson(node, { elements: null }));
  assert.equal(JSON.stringify(node), frozen, 'the node itself is untouched');
});
