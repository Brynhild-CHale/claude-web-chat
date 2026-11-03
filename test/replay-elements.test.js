// The replay draws elements, and its captions below read (annotation engine
// tranche 4, PLAN.md 4B.1's replay half; DECISIONS.md B3, R1 stage B; U525).
//
// What must hold:
//   - each step whose node carries element records draws that node's
//     elements for the document's reader: the runtime rides once per cut key
//     (payload.elements_rt), each plug-in type's module once per replay
//     (payload.element_types), and each step only its own data element;
//   - a frame filled from the payload's parts is the node preview's pieces
//     around the same theme, resolver, element parts and node — and it draws
//     the step's markers when loaded;
//   - a type removed after its commit draws the generic mark;
//   - a private element reaches only the /replay player a local browser views
//     in place: never with shared_only=1, a download, a rendered .html, the
//     headless view a GIF is drawn from, or a remote viewer (RULED
//     U524-U525@file-documents-private a);
//   - below read a replay document carries no caption and no element
//     (DOCS@replay-text a); a rendered file is refused 403 below read with the
//     hint (U525@replay-file-below-read a).
//
// Every scenario runs on a real daemon (withServer) — the elements written
// through POST /api/elements, each node a turn's commit, the plug-in type a
// pack approved in process (test-support/element-type-fixture: B1's path) —
// except the file route's network-peer case, which needs a socket address the
// daemon cannot be handed, and mounts the replay routes on a bare host as
// test/graph-text-rules.test.js mounts the graph's.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { JSDOM } = require('jsdom');

// Nothing here launches a browser: pin the finder to none.
process.env.WEB_CHAT_CHROME = '/nonexistent/web-chat-test/chrome';

const { withServer, tmpRoot, waitUntil } = require('../test-support/helpers');
const { approveElementPack } = require('../test-support/element-type-fixture');
const packs = require('../lib/packs/install');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const { createAudience } = require('../lib/server/audience');
const { resolvePaths } = require('../lib/server/paths');
const { previewTemplate } = require('../lib/server/preview');
const { scriptElement: anchorsScript, kindsOf } = require('../lib/server/runtime/anchors-src');
const { scripts, runtimeElement, keyOf } = require('../lib/server/runtime/elements-doc-src');
const { documentElements, documentDeps } = require('../lib/server/document-elements');
const { jsonForScript } = require('../lib/server/export');
const { renderReplay } = require('../lib/server/replay/render');
const { createScriptStore } = require('../lib/server/replay/scripts');
const { mountReplayRoutes, FILE_BELOW_READ_HINT } = require('../lib/server/routes/replay');
const { elementsFill } = require('../lib/server/replay/player');

const TYPE = 'rp-mark';
const SENTINEL = 'RP-MARK-DRAW-SENTINEL';
const MARK_DRAW = [
  `// ${TYPE}: ${SENTINEL}`,
  'export default function draw(group, ctx) {',
  "  if (group.container) group.container.setAttribute('data-rp-mark', String(group.items.length));",
  '}',
  '',
].join('\n');
const MARK_JSON = { payload: { keys: ['anchor', 'shared', 'label'] }, anchors: ['element', 'range'] };
// The type's one asset: it rides inside the module row, once per replay, and
// is read as itself (the replay's memoised type-file reads key on the path).
const ASSET_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>\n';
const ASSET_URI = `data:image/svg+xml;base64,${Buffer.from(ASSET_SVG).toString('base64')}`;

const HTML_A = (k) => `<p class="lead">Hello world</p><p class="step">step ${k}</p>`;
const HTML_B = '<figure><svg class="chart" viewBox="0 0 10 10" width="100" height="100"><rect width="10" height="10"/></svg></figure>';
const LOCATOR = (mount) => ({ mount, selector: 'p.lead', text: 'Hello world', ordinal: 0 });
const ELEMENT = (mount) => ({ v: 1, kind: 'element', mount, at: { path: [0, 0], sib: 0 }, fp: { tag: 'svg', id: '', cls: ['chart'], head: '', attrs: [], parent: 'figure' }, rows: [] });

const PRIVATE_TEXT = 'RP-PRIVATE-NOTE';
const REPLY = (k) => `RP-REPLY-MARK ${k}`;
const SHARED = (k) => `RP-SHARED-NOTE ${k}`;
const BROWSER_REQ = { headers: { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' }, socket: { remoteAddress: '127.0.0.1' } };
const REMOTE = { 'X-WC-Remote': '1' };

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
const post = (api, body, what) => ok(api.post('/api/elements', body), what);
async function commit(api, k) {
  await ok(api.post('/api/turn-begin', { message: `prompt ${k}` }), 'turn-begin');
  const r = await ok(api.post('/api/turn-end', { author: 'claude', reply: REPLY(k) }), 'turn-end');
  assert.ok(r.node_id, `a node committed: ${JSON.stringify(r)}`);
  return r.node_id;
}
const count = (hay, needle) => hay.split(needle).length - 1;
// The element ids every step of a replay document draws (its data elements,
// parsed: an id like c4 is too short to grep a document for).
function drawnIds(html) {
  const out = new Set();
  for (const s of payloadOf(html).steps) {
    if (!s.elements) continue;
    const data = JSON.parse(/data-wc-elements>([\s\S]*?)<\/script>/.exec(s.elements.data)[1]);
    for (const it of data.items) out.add(it.id);
  }
  return out;
}
function payloadOf(html) {
  const m = /<script id="wc-replay-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'the document holds its payload');
  return JSON.parse(m[1]);
}
// The frame of step `i`, filled by concatenation as the player fills it —
// spelled out here, independently of the player's own elementsFill.
function frameOf(payload, i) {
  const s = payload.steps[i];
  const [a, b, c, d] = payload.frame;
  let el = '';
  if (s.elements && s.anchors) {
    el = payload.elements_rt[s.elements.rt] + s.elements.types.map((k) => payload.element_types[k]).join('') + s.elements.data;
  }
  return a + (payload.themes[s.theme] || '') + b + (s.anchors ? payload.anchors[s.anchors] : '') + el + c + s.node + d;
}

// The scenario: a three-step lineage, each node carrying a shared comment and
// an element of the listed fixture type; the third also a private comment.
async function scenario(t, opts = {}) {
  const d = await withServer(t, opts);
  const { api } = d;
  approveElementPack(d, { name: 'rp-pack', type: TYPE, json: MARK_JSON, draw: MARK_DRAW, files: { 'assets/dot.svg': ASSET_SVG } });
  assert.ok(d.srv.elementTypes.listed(TYPE), 'the fixture type lists');
  await ok(api.post('/api/render', { id: 'pb', html: HTML_B }), 'render pb');
  const nodes = [];
  const ids = { comments: [], marks: [], priv: null };
  for (let k = 1; k <= 3; k++) {
    await ok(api.post('/api/render', { id: 'pa', html: HTML_A(k) }), `render pa ${k}`);
    ids.comments.push((await post(api, { type: 'comment', anchor: LOCATOR('pa'), payload: { text: SHARED(k), shared: true } }, `comment ${k}`)).pin.id);
    ids.marks.push((await post(api, { type: TYPE, anchor: ELEMENT('pb'), payload: { label: `mark ${k}` } }, `mark ${k}`)).element.id);
    if (k === 3) ids.priv = (await post(api, { type: 'comment', anchor: LOCATOR('pa'), payload: { text: PRIVATE_TEXT, shared: false } }, 'private comment')).pin.id;
    nodes.push(await commit(api, k));
  }
  const q = `?from=${encodeURIComponent(nodes[0])}&to=${encodeURIComponent(nodes[2])}`;
  return { d, nodes, ids, q };
}

// Opens a frame in jsdom with every element given a box (so the resolver
// places what it resolves); `define` stands in for a plug-in module (jsdom
// runs no module script).
const WINDOWS = [];
test.after(() => { for (const w of WINDOWS) w.close(); });
function openFrame(html) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(win) {
      win.fetch = () => { throw new Error('no fetch in a document'); };
      win.Element.prototype.getBoundingClientRect = function () {
        return { left: 10, top: 10, width: 100, height: 20, right: 110, bottom: 30, x: 10, y: 10 };
      };
    },
  });
  WINDOWS.push(dom.window);
  return dom.window;
}
const settled = async (win) => {
  await waitUntil(() => win.document.readyState === 'complete', { timeout: 5000, what: 'the load event' });
  await new Promise((r) => win.setTimeout(r, 20));
};
const markers = (win) => [...win.document.querySelectorAll('.wc-el-layer .el-marker')];
const markerOf = (win, id) => markers(win).find((m) => (m.getAttribute('data-el-ids') || '').split(' ').includes(id));

// ── the elements, once each ────────────────────────────────────────────────

test('GET /replay from a local browser: the runtime once, the type\'s module once, one data element per step; each frame is the preview\'s pieces around the same parts and draws its step\'s markers', async (t) => {
  const { d, nodes, ids, q } = await scenario(t);
  const r = await d.api.get(`/replay${q}`);
  assert.equal(r.status, 200, r.text);
  const payload = payloadOf(r.text);
  assert.equal(payload.steps.length, 3);

  // The runtime once per cut key, the module once per replay.
  assert.deepStrictEqual(Object.keys(payload.elements_rt), ['comment'], 'one runtime cut: the comment built-in (the plug-in is a glyph)');
  assert.deepStrictEqual(Object.keys(payload.element_types), [TYPE], 'one module row');
  assert.equal(count(r.text, SENTINEL), 1, 'the draw module\'s bytes ride once in the whole document');
  assert.equal(count(r.text, ASSET_URI), 1, 'the type\'s asset rides once, as itself (not another file\'s bytes)');
  const rtJson = jsonForScript(runtimeElement('comment')).slice(1, -1);
  assert.equal(count(r.text, rtJson), 1, 'the runtime\'s bytes ride once');
  for (const [i, s] of payload.steps.entries()) {
    assert.ok(s.elements, `step ${i} draws elements`);
    assert.deepStrictEqual([s.elements.rt, s.elements.types], ['comment', [TYPE]]);
    assert.equal(count(s.elements.data, 'data-wc-elements'), 1, `step ${i}: its own data element`);
    assert.ok(!s.elements.data.includes(SENTINEL), 'the data element carries no module');
    const data = JSON.parse(/data-wc-elements>([\s\S]*?)<\/script>/.exec(s.elements.data)[1]);
    const own = data.items.map((it) => it.id);
    // A node's page carries every element made on it so far.
    for (const k of [...ids.comments.slice(0, i + 1), ...ids.marks.slice(0, i + 1)]) assert.ok(own.includes(k), `step ${i}: carries ${k}`);
    assert.equal(own.includes(ids.priv), i === 2, `step ${i}: the private comment only from the step it was made on`);
    assert.ok(s.elements.data.includes(SHARED(i + 1)), `step ${i}: the comment's text`);
    // The player's fill is the concatenation.
    assert.equal(elementsFill(payload, s), payload.elements_rt.comment + payload.element_types[TYPE] + s.elements.data);
  }

  // A frame equals the preview template's pieces around the same theme,
  // resolver, element parts (elements-doc-src scripts of the node's payload
  // for the same reader) and node.
  const reader = { level: 'local', seesPrivate: true };
  const [a, b, c, dd] = previewTemplate();
  for (const [i, s] of payload.steps.entries()) {
    const node = d.srv.graph.nodes.get(nodes[i]);
    const p = documentElements(documentDeps({ graph: d.srv.graph, sideTable: d.srv.sideTable, elementTypes: d.srv.elementTypes, root: d.root }), node, { reader, route: 'GET /replay' });
    assert.equal(keyOf(p), 'comment');
    const want = a + payload.themes[s.theme] + b + anchorsScript({ kinds: kindsOf(node) }) + scripts(p) + c + s.node + dd;
    assert.equal(frameOf(payload, i), want, `step ${i}: byte-equal to its node's preview parts for the same reader`);
  }

  // Loaded, a frame draws its step's markers.
  const win = openFrame(frameOf(payload, 2));
  const drawn = [];
  win.__wcMount.elements.define(TYPE, (group) => { drawn.push(group.items.map((it) => it.id)); if (group.container) group.container.setAttribute('data-rp-mark', '1'); }, {});
  await settled(win);
  const c3 = markerOf(win, ids.comments[2]);
  assert.ok(c3, 'the step\'s shared comment is drawn');
  assert.equal(c3.getAttribute('data-type'), 'comment');
  assert.ok(markerOf(win, ids.priv), 'and, for the local browser viewing in place, its private one');
  const first = openFrame(frameOf(payload, 0));
  await settled(first);
  assert.ok(markerOf(first, ids.comments[0]), 'the first step draws its comment');
  assert.ok(!markerOf(first, ids.comments[2]) && !markerOf(first, ids.priv), 'and never a later step\'s');
  const m3 = markerOf(win, ids.marks[2]);
  assert.ok(m3, 'the plug-in element is drawn');
  assert.equal(m3.getAttribute('data-type'), TYPE);
  assert.ok(drawn.flat().includes(ids.marks[2]), 'by its type\'s draw');
});

test('a step whose node\'s type was removed after its commit draws the generic mark; its module rides nowhere', async (t) => {
  const { d, ids, q } = await scenario(t);
  packs.removePackByName({ name: 'rp-pack', root: d.root });
  d.srv.elementTypes.invalidate();
  assert.equal(d.srv.elementTypes.listed(TYPE), false);
  const r = await d.api.get(`/replay${q}`);
  assert.equal(r.status, 200, r.text);
  const payload = payloadOf(r.text);
  assert.deepStrictEqual(payload.element_types, {}, 'no module row');
  assert.equal(count(r.text, SENTINEL), 0);
  const data = JSON.parse(/data-wc-elements>([\s\S]*?)<\/script>/.exec(payload.steps[0].elements.data)[1]);
  assert.deepStrictEqual(data.removed, [TYPE]);
  const win = openFrame(frameOf(payload, 0));
  await settled(win);
  const m = markerOf(win, ids.marks[0]);
  assert.ok(m, 'the removed type\'s item is drawn');
  assert.ok(m.classList.contains('el-generic') && m.classList.contains('el-standin'), `the generic mark: ${m.className}`);
  assert.equal(m.querySelector('.el-generic-name').textContent, TYPE, 'naming its type');
  assert.ok(markerOf(win, ids.comments[0]), 'the comment still drawn');
});

// ── who sees a private element ──────────────────────────────────────────────

test('a private comment: in the local browser\'s /replay only — never with shared_only=1, a download, a rendered .html or the headless view a GIF is drawn from', async (t) => {
  const { d, ids, q, nodes } = await scenario(t);
  const has = (html, what, want) => {
    assert.equal(html.includes(PRIVATE_TEXT), want, `${what}: the private text ${want ? 'present' : 'absent'}`);
    assert.equal(drawnIds(html).has(ids.priv), want, `${what}: the private item ${want ? 'drawn' : 'not drawn'}`);
    assert.ok(html.includes(SHARED(3)), `${what}: the shared comment present`);
  };
  has((await d.api.get(`/replay${q}`)).text, 'the local browser\'s /replay', true);
  has((await d.api.get(`/replay${q}&shared_only=1`)).text, '/replay?shared_only=1', false);
  has((await d.api.get(`/api/replay/html${q}`)).text, 'the download (a browser\'s)', false);

  const rendered = await ok(d.api.post('/api/replay/render', { format: 'replay', from: nodes[0], to: nodes[2] }), 'render replay');
  has(fs.readFileSync(rendered.path, 'utf8'), 'a rendered .html', false);

  // The GIF's headless view: the URL it is handed asks for shared elements only.
  const seen = [];
  const opts = {
    port: d.port, findChromeImpl: () => '/x/chrome', findFfmpegImpl: () => null, scripts: createScriptStore(),
    captureImpl: async (o) => { seen.push(o); throw Object.assign(new Error('stub'), { code: 'stub' }); },
  };
  const ctx = { graph: d.srv.graph, paths: resolvePaths(d.root), root: d.root, sideTable: d.srv.sideTable, elementTypes: d.srv.elementTypes };
  const gif = await renderReplay(ctx, { format: 'gif', from: nodes[0], to: nodes[2] }, opts);
  assert.equal(gif.code, 'stub', JSON.stringify(gif));
  const u = new URL(seen[0].url);
  assert.equal(u.pathname, '/replay');
  assert.equal(u.searchParams.get('shared_only'), '1', 'the headless view draws the shared elements only');
  // That view, as the headless Chrome (a local browser) would load it, from a
  // script this test's own store holds: fetch the same query with from/to.
  const viewQ = new URLSearchParams(u.search);
  viewQ.delete('script');
  viewQ.set('from', nodes[0]);
  viewQ.set('to', nodes[2]);
  has((await d.api.get(`/replay?${viewQ}`)).text, 'the headless view', false);
});

test('a remote read viewer: captions and shared elements, never a private one; the local browser\'s unchanged', async (t) => {
  const seedRead = ({ root: r }) => {
    writeJsonAtomic(userPaths().tunnelConfig, {
      hostname: 'wc.example.test', style: 'flat',
      access: { team: 'testteam', aud: 'test-aud-0123456789' },
      allow: { emails: ['me@example.com'], domains: [] },
      remote: { mirror: { [path.resolve(r)]: 'read' } },
    });
  };
  const { d, ids, q } = await scenario(t, { root: tmpRoot('wc-replay-el-read-'), seed: seedRead });
  for (const route of ['/replay', '/api/replay/html']) {
    const far = await d.anonApi.get(`${route}${q}`, REMOTE);
    assert.equal(far.status, 200, far.text);
    const p = payloadOf(far.text);
    assert.ok(far.text.includes(REPLY(3)), `${route}: a read viewer gets the captions`);
    assert.deepStrictEqual(p.steps.map((s) => s.caption), [1, 2, 3].map((k) => ({ reply: REPLY(k) })));
    assert.ok(far.text.includes(SHARED(3)) && p.steps.every((s) => s.elements), `${route}: and the shared elements`);
    assert.ok(!far.text.includes(PRIVATE_TEXT) && !drawnIds(far.text).has(ids.priv), `${route}: never a private one`);
  }
  // The local browser's request is never projected: captions, and its
  // private comment beside the shared ones.
  const local = await d.api.get(`/replay${q}`);
  assert.ok(local.text.includes(REPLY(3)) && local.text.includes(PRIVATE_TEXT));
});

test('below read: a remote basic viewer\'s /replay and /api/replay/html carry no caption text and no element data; the steps keep their timing and focus', async (t) => {
  const { d, ids, q } = await scenario(t);
  const near = payloadOf((await d.api.get(`/replay${q}`)).text);
  for (const route of ['/replay', '/api/replay/html']) {
    const far = await d.anonApi.get(`${route}${q}`, REMOTE);
    assert.equal(far.status, 200, far.text);
    for (const k of [1, 2, 3]) assert.ok(!far.text.includes(REPLY(k)), `${route}: no caption text (${k})`);
    assert.ok(!far.text.includes(SHARED(3)) && !far.text.includes(SENTINEL) && !far.text.includes('data-wc-elements'), `${route}: no element data`);
    const p = payloadOf(far.text);
    assert.ok(p.steps.every((s) => !('caption' in s) && !('elements' in s)), `${route}: no caption, no element parts`);
    assert.equal(p.elements_rt, undefined);
    assert.deepStrictEqual(p.steps.map((s) => [s.id, s.label, s.dt_from_prev, s.focus || null, s.anchors]),
      near.steps.map((s) => [s.id, s.label, s.dt_from_prev, s.focus || null, s.anchors]), `${route}: each step keeps its timing and focus`);
  }
  // A local request is unchanged: lib/client's /replay captions every step.
  const { request } = require('../lib/client');
  const host = await request(d.port, 'GET', `/replay${q}`, null, { timeout: 30000 });
  assert.deepStrictEqual(payloadOf(host.body).steps.map((s) => s.caption), [1, 2, 3].map((k) => ({ reply: REPLY(k) })));
  assert.ok(!host.body.includes(PRIVATE_TEXT), 'lib/client never sees a private element');
});

// ── a rendered file ─────────────────────────────────────────────────────────

// A rendered file is built at the lowest level that may fetch it (U525a;
// RULED U525@replay-file-below-read a: GET /api/replay/file/:name serves it
// from `read` up): an item whose type's remote.see is above read never rides
// a rendered .html or a frame a GIF, MP4 or WebM is drawn from, though the
// local browser's /replay, viewed in place, still draws it (AI9 a).
const FULL_TYPE = 'rp-full';
const FULL_SENTINEL = 'RP-FULL-DRAW-SENTINEL';
const FULL_DRAW = `// ${FULL_TYPE}: ${FULL_SENTINEL}\nexport default function draw(group) { if (group.container) group.container.setAttribute('data-rp-full', '1'); }\n`;
const FULL_LABEL = 'RP-FULL-LABEL';

test('a type gated above read: in the local browser\'s /replay in place, never in a rendered .html (built and fetched at read) or the headless view a GIF is drawn from', async (t) => {
  const seedRead = ({ root: r }) => {
    writeJsonAtomic(userPaths().tunnelConfig, {
      hostname: 'wc.example.test', style: 'flat',
      access: { team: 'testteam', aud: 'test-aud-0123456789' },
      allow: { emails: ['me@example.com'], domains: [] },
      remote: { mirror: { [path.resolve(r)]: 'read' } },
    });
  };
  const { d, nodes, q } = await scenario(t, { root: tmpRoot('wc-replay-el-full-'), seed: seedRead });
  approveElementPack(d, { name: 'rp-full-pack', type: FULL_TYPE, json: { payload: { keys: ['anchor', 'shared', 'label'] }, remote: { see: 'full', send: 'full' } }, draw: FULL_DRAW });
  assert.ok(d.srv.elementTypes.listed(FULL_TYPE), 'the full-gated type lists');
  // Its item on the last node (a turn of its own, after the scenario's three).
  await ok(d.api.post('/api/render', { id: 'pa', html: HTML_A(4) }), 'render pa 4');
  const full = (await post(d.api, { type: FULL_TYPE, anchor: ELEMENT('pb'), payload: { label: FULL_LABEL } }, 'full mark')).element.id;
  const last = await commit(d.api, 4);
  const q4 = `?from=${encodeURIComponent(nodes[0])}&to=${encodeURIComponent(last)}`;
  const has = (html, what, want) => {
    assert.equal(drawnIds(html).has(full), want, `${what}: the full-gated item ${want ? 'drawn' : 'not drawn'}`);
    assert.equal(html.includes(FULL_LABEL), want, `${what}: its text ${want ? 'present' : 'absent'}`);
    assert.equal(html.includes(FULL_SENTINEL), want, `${what}: its type's module ${want ? 'present' : 'absent'}`);
    assert.ok(html.includes(SHARED(3)), `${what}: the read-level comment still present`);
  };

  // Viewed in place by the local browser: drawn (a document viewed in place).
  has((await d.api.get(`/replay${q4}`)).text, 'the local browser\'s /replay', true);
  // A remote read viewer's /replay: withheld, as from every live frame.
  has((await d.anonApi.get(`/replay${q4}`, REMOTE)).text, 'a read viewer\'s /replay', false);

  // A rendered .html: built at read, so the file a read viewer may fetch
  // carries nothing it may not see.
  const rendered = await ok(d.api.post('/api/replay/render', { format: 'replay', from: nodes[0], to: last }), 'render replay');
  has(fs.readFileSync(rendered.path, 'utf8'), 'a rendered .html', false);
  const fetched = await d.anonApi.get(`/api/replay/file/${encodeURIComponent(path.basename(rendered.path))}`, REMOTE);
  assert.equal(fetched.status, 200, `a read viewer may fetch the file: ${fetched.status}`);
  has(fetched.text, 'the rendered .html a read viewer fetches', false);
  assert.ok(fetched.text.includes(REPLY(3)), 'with its captions (read sees them)');

  // The headless view a GIF's frames are drawn from: the URL narrows the
  // local browser that loads it to read, beside shared_only=1.
  const seen = [];
  const opts = {
    port: d.port, findChromeImpl: () => '/x/chrome', findFfmpegImpl: () => null, scripts: createScriptStore(),
    captureImpl: async (o) => { seen.push(o); throw Object.assign(new Error('stub'), { code: 'stub' }); },
  };
  const ctx = { graph: d.srv.graph, paths: resolvePaths(d.root), root: d.root, sideTable: d.srv.sideTable, elementTypes: d.srv.elementTypes };
  const gif = await renderReplay(ctx, { format: 'gif', from: nodes[0], to: last }, opts);
  assert.equal(gif.code, 'stub', JSON.stringify(gif));
  const u = new URL(seen[0].url);
  assert.equal(u.searchParams.get('shared_only'), '1');
  assert.equal(u.searchParams.get('level'), 'read', 'the headless view is narrowed to read');
  const viewQ = new URLSearchParams(u.search);
  viewQ.delete('script');
  viewQ.set('from', nodes[0]);
  viewQ.set('to', last);
  const view = (await d.api.get(`/replay?${viewQ}`)).text;
  has(view, 'the headless view', false);
  assert.ok(view.includes(REPLY(3)), 'the headless view keeps its captions (read sees them)');
  for (let i = 0; i < payloadOf(view).steps.length; i++) {
    assert.ok(!frameOf(payloadOf(view), i).includes(FULL_LABEL), `frame ${i}: no full-gated item`);
  }

  // The narrowing grants nothing: a read viewer asking for local is read; a
  // value that is no level is basic (fail closed); local asking for local is
  // unchanged.
  has((await d.anonApi.get(`/replay${q4}&level=local`, REMOTE)).text, 'a read viewer asking level=local', false);
  const bogus = await d.api.get(`/replay${q4}&level=nope`);
  assert.ok(!bogus.text.includes('data-wc-elements') && !bogus.text.includes(REPLY(3)), 'level=nope: basic, no element and no caption');
  has((await d.api.get(`/replay${q4}&level=local`)).text, 'the local browser asking level=local', true);
  has((await d.api.get(`/replay${q4}&level=full`)).text, 'the local browser asking level=full', true);
  const atFull = await d.api.get(`/replay${q4}&level=full`);
  assert.ok(!atFull.text.includes(PRIVATE_TEXT), 'below local, no private element');
});

test('GET /api/replay/file/:name: 403 with the hint for a remote basic request and a network peer; 200 for read and local', async (t) => {
  const root = tmpRoot('wc-replay-file-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolvePaths(root);
  fs.mkdirSync(paths.EXPORTS_DIR, { recursive: true });
  const name = 'replay-n1-1_n1-3-20261103-120000.gif';
  fs.writeFileSync(path.join(paths.EXPORTS_DIR, name), 'GIF89a-rendered');
  const app = express();
  // A request with x-test-peer has its socket report that address while the
  // route runs (it answers synchronously up to the stream).
  app.use((req, res, next) => {
    const addr = req.headers['x-test-peer'];
    if (!addr) return next();
    const real = req.socket;
    req.socket = { remoteAddress: addr, localPort: real.localPort };
    try { next(); } finally { req.socket = real; }
  });
  const ctx = { graph: null, paths, root, bus: { emit() {} }, audience: createAudience({ configFile: null }) };
  mountReplayRoutes(app, ctx);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const port = server.address().port;
  const get = (headers) => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: `/api/replay/file/${name}`, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    }).on('error', reject);
  });
  const fakeAt = (level) => ({ levelOf: () => level, isHost: () => false, seesPrivate: () => false });

  // A network peer is basic whatever the project's opt-in (Q9): the real
  // audience decides it from the socket's address.
  for (const [who, headers] of [
    ['a remote basic request', REMOTE],
    ['a network peer', { 'x-test-peer': '10.0.0.7' }],
    ['a network peer claiming the portal\'s label', { 'x-test-peer': '10.0.0.7', ...REMOTE }],
  ]) {
    ctx.audience = createAudience({ configFile: null });
    const r = await get(headers);
    assert.equal(r.status, 403, `${who}: ${r.text}`);
    const body = JSON.parse(r.text);
    assert.equal(body.hint, FILE_BELOW_READ_HINT, `${who}: the hint`);
    assert.equal(body.mirror, 'basic');
    assert.ok(!r.text.includes('GIF89a'), `${who}: no bytes`);
  }
  assert.match(FILE_BELOW_READ_HINT, /claude-web-chat tunnel mirror on --read-only/, 'the hint names the read opt-in');
  assert.match(FILE_BELOW_READ_HINT, /captions: 'none'/, 'and a render with captions off');

  ctx.audience = fakeAt('read');
  const read = await get(REMOTE);
  assert.equal(read.status, 200, read.text);
  assert.equal(read.text, 'GIF89a-rendered');
  ctx.audience = createAudience({ configFile: null });
  const local = await get({});
  assert.equal(local.status, 200, local.text);
  assert.equal(local.text, 'GIF89a-rendered');
});

test('a step whose node carries no element records adds nothing: its frame is today\'s bytes', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'pa', html: HTML_A(1) }), 'render');
  const n1 = await commit(d.api, 1);
  await ok(d.api.post('/api/render', { id: 'pa', html: HTML_A(2) }), 'render');
  const n2 = await commit(d.api, 2);
  const payload = payloadOf((await d.api.get(`/replay?from=${n1}&to=${n2}`)).text);
  assert.equal(payload.elements_rt, undefined);
  assert.equal(payload.element_types, undefined);
  for (const [i, s] of payload.steps.entries()) {
    assert.equal(s.elements, undefined);
    assert.equal(elementsFill(payload, s), '');
    const [a, b, c, dd] = previewTemplate();
    assert.equal(frameOf(payload, i), a + payload.themes[s.theme] + b + c + s.node + dd);
  }
});
