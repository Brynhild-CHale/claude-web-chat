'use strict';
// The page export draws its elements, under a projection (annotation engine
// tranche 4, U524; PLAN.md 4B.1; DECISIONS.md B3, R1 stage B, K.5 J2, N.1
// AD5 = a). lib/server/export.js buildExportHtml builds the node's element
// payload with lib/server/document-elements documentElements under a FILE
// reader (RULED U524-U525@file-documents-private a: an export never carries a
// private element, whoever downloads it) and splices elements-doc-src
// scripts() right after the resolver; GET /api/export/:ref (lib/server/routes/
// export.js) reads the requester's level through readerOf and names, counts
// only, how many private notes a local browser's download left out.
//
// Who is who (as test/private-routes.test.js and test/document-elements.test.js
// name them): a local browser is withServer's `api` (Node's fetch, which sends
// fetch metadata); lib/client (Claude's MCP tools, the CLI) sends none; a
// remote viewer is a loopback request carrying the portal's X-WC-Remote at the
// project's opt-in in the sandbox's tunnel.json; a network peer is a request
// whose socket's remoteAddress is stubbed before the app sees it.
//
// The scenario: two panes; a shared comment Claude replied to (its answer
// recorded on the node), a private comment, a shared and a private highlight,
// an element of a listed fixture plug-in type (xe-mark, place 'box') and one
// of a type whose pack is removed after the commit (xe-gone). A plug-in type is
// a pack installed and approved in process (test-support/element-type-fixture:
// B1's path). jsdom runs no module script, so the document's inline module is
// run in the window by hand (its exact text, less its `export` keywords) before
// the load event, as the browser runs a module before load.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// A box grab is drawn by headless Chrome; this file never launches one.
process.env.WEB_CHAT_CHROME = '/nonexistent/web-chat-test/chrome';

const { withServer, tmpRoot, waitUntil } = require('../test-support/helpers');
const { approveElementPack } = require('../test-support/element-type-fixture');
const packs = require('../lib/packs/install');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const { resolvePaths } = require('../lib/server/paths');
const client = require('../lib/client');
const anchorsSrc = require('../lib/server/runtime/anchors-src');
const docRuntime = require('../lib/server/runtime/elements-doc-src');
const { fileReader } = require('../lib/server/document-elements');
const exp = require('../lib/server/export');

const HTML_A = '<p class="lead">Hello world</p><p class="body">The quick brown fox jumps</p>';
const HTML_B = '<figure><svg class="chart" viewBox="0 0 10 10" width="100" height="100"><rect width="10" height="10"/></svg></figure>';
const LOCATOR = (mount) => ({ mount, selector: 'p.lead', text: 'Hello world', ordinal: 0 });
const RANGE = (mount, exact = 'quick brown') => ({ v: 1, kind: 'range', mount, quote: { exact, prefix: 'The ', suffix: ' fox' } });
const ELEMENT = (mount) => ({ v: 1, kind: 'element', mount, at: { path: [0, 0], sib: 0 }, fp: { tag: 'svg', id: '', cls: ['chart'], head: '', attrs: [], parent: 'figure' }, rows: [] });

const MARK_DRAW = [
  '// xe-mark: frames its target.',
  'export default function draw(group, ctx) {',
  "  if (group.container) group.container.setAttribute('data-xe-mark', String(group.items.length));",
  '}',
  '',
].join('\n');
const MARK_JSON = { payload: { keys: ['anchor', 'shared', 'label'] }, anchors: ['element', 'range'], place: 'box' };
const GONE_JSON = { payload: { keys: ['anchor', 'shared', 'label'] }, anchors: ['element', 'range'] };

// The words the scenario writes: each must reach (or never reach) a file.
const W = {
  shared: 'wc-u524-shared-comment',
  reply: 'wc-u524-claude-reply',
  priv: 'wc-u524-private-comment',
  hl: 'wc-u524-shared-highlight',
  hlPriv: 'wc-u524-private-highlight',
  mark: 'wc-u524-mark-label',
  gone: 'wc-u524-gone-label',
};
const ELEMENT_WORDS = [W.shared, W.reply, W.hl, W.mark];
const PRIVATE_WORDS = [W.priv, W.hlPriv];

const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const PEER = Object.freeze({ 'x-test-peer': '10.0.0.5' });
const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const DATA_EL = /<script type="application\/json" data-wc-elements>([^<]*)<\/script>/g;
const COUNT_LINE = /data-private-left-out="(\d+)"/;
const NOW = new Date('2026-11-03T12:00:00Z');

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
async function commit(api, message) {
  await ok(api.post('/api/turn-begin', { message }), 'turn-begin');
  const r = await ok(api.post('/api/turn-end', { author: 'claude', summary: message }), 'turn-end');
  assert.ok(r.node_id, `a node committed: ${JSON.stringify(r)}`);
  return r.node_id;
}
const post = async (api, body, what) => ok(api.post('/api/elements', body), what);

// Requests carrying x-test-peer arrive from that address (private-routes's).
function stubPeers(server) {
  const onRequest = (req, res) => {
    const addr = req.headers['x-test-peer'];
    if (!addr) return;
    Object.defineProperty(req.socket, 'remoteAddress', { value: addr, configurable: true });
    res.once('close', () => { delete req.socket.remoteAddress; });
  };
  server.prependListener('request', onRequest);
  return () => server.off('request', onRequest);
}

// A daemon whose remote viewers are opted in at `level` (none: basic).
async function daemon(t, level = null) {
  const root = tmpRoot('wc-u524-');
  const seed = level ? () => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(root)]: level } } }) : undefined;
  const d = await withServer(t, { root, seed });
  t.after(stubPeers(d.server));
  d.call = (p, headers) => client.request(d.port, 'GET', p, null, { headers, timeout: 10000 });
  return d;
}

// The scenario on `d`: the node id and every element id.
async function scenario(d) {
  const { api } = d;
  approveElementPack(d, { name: 'xe-pack', type: 'xe-mark', json: MARK_JSON, draw: MARK_DRAW });
  approveElementPack(d, { name: 'xg-pack', type: 'xe-gone', json: GONE_JSON });
  assert.ok(d.srv.elementTypes.listed('xe-mark') && d.srv.elementTypes.listed('xe-gone'), 'both fixture types list');
  await ok(api.post('/api/render', { id: 'pa', html: HTML_A }), 'render pa');
  await ok(api.post('/api/render', { id: 'pb', html: HTML_B }), 'render pb');
  const shared = (await post(api, { type: 'comment', anchor: LOCATOR('pa'), payload: { text: W.shared, shared: true } }, 'shared comment')).pin;
  const replied = (await ok(api.post(`/api/elements/${shared.id}/reply`, { text: W.reply, author: 'claude' }), 'claude reply')).pin;
  const priv = (await post(api, { type: 'comment', anchor: LOCATOR('pa'), payload: { text: W.priv, shared: false } }, 'private comment')).pin;
  const hl = (await post(api, { type: 'highlight', anchor: RANGE('pa'), payload: { color: 'gold', note: W.hl } }, 'shared highlight')).element;
  const hlPriv = (await post(api, { type: 'highlight', anchor: RANGE('pa', 'brown fox'), payload: { color: 'green', note: W.hlPriv, shared: false } }, 'private highlight')).element;
  const mark = (await post(api, { type: 'xe-mark', anchor: ELEMENT('pb'), payload: { label: W.mark } }, 'xe-mark')).element;
  const gone = (await post(api, { type: 'xe-gone', anchor: RANGE('pa'), payload: { label: W.gone } }, 'xe-gone')).element;
  const node = await commit(api, 'the scenario');
  d.srv.elements.log.appendAnswers({ node, items: [{
    id: shared.id, v: replied.v, mount: 'pa', state: 'exact', how: 'path', gen: 0, surface: 0,
    qual: { spec: 'x', store: 'y' }, source: { peer: 'local', device: null },
  }] });
  // The pack removed after the commit: the document draws its generic mark.
  packs.removePackByName({ name: 'xg-pack', root: d.root });
  d.srv.elementTypes.invalidate();
  assert.equal(d.srv.elementTypes.listed('xe-gone'), false, 'xe-gone is no longer listed');
  return { node, ids: { shared: shared.id, priv: priv.id, hl: hl.id, hlPriv: hlPriv.id, mark: mark.id, gone: gone.id } };
}

// The ctx members buildExportHtml reads, from a withServer context.
const ctxOf = (d) => ({ graph: d.srv.graph, sideTable: d.srv.sideTable, elementTypes: d.srv.elementTypes, root: d.root, paths: resolvePaths(d.root) });

// The export as this unit found it (ae/int 3afbd23d): the same pipeline with
// no element payload and no count (the test root has no brand images).
function exportBefore(ctx, ref, now = NOW) {
  const resolved = exp.nodeForExport(ctx, ref);
  const theme = exp.resolveExportTheme(ctx, resolved, null);
  return exp.assembleExport({
    mounts: theme.mounts, markdown: resolved.markdown, order: resolved.order, runs: resolved.runs,
    store: resolved.store, page: theme.page, elements: resolved.elements,
    meta: { label: resolved.label, title: `web-chat — ${resolved.label}`, exportedAt: now.toISOString().replace('T', ' ').slice(0, 19), brand: {} },
  });
}
// The stamp a served export writes (now is the request's), blanked.
const unstamped = (html) => html.replace(/<span>exported [^<]*<\/span>/, '<span>exported -</span>');

const dataElements = (html) => [...html.matchAll(DATA_EL)].map((m) => JSON.parse(m[1]));
// The payload a document carries, whole again: its data element (which holds
// each type row less its module and assets) with each row's module and assets
// read back from that type's own inline module (typeElement's form: the
// module's bytes, a newline, the one define line).
const DEFINE = /\nwindow\.__wcMount\.elements\.define\(("(?:[^"\\]|\\.)*"), draw, (.*)\);$/;
function carried(html) {
  const [p] = dataElements(html);
  if (!p) return null;
  const mods = new Map();
  for (const m of html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)) {
    const def = m[1].match(DEFINE);
    assert.ok(def, 'each inline module ends in its define line');
    mods.set(JSON.parse(def[1]), { module: m[1].slice(0, def.index), assets: JSON.parse(def[2]) });
  }
  return { ...p, types: p.types.map((r) => ({ ...r, ...mods.get(r.type) })) };
}
const quoted = (html, id) => html.includes(`"${id}"`);
const kindsOfNode = (d, id) => anchorsSrc.kindsOf(d.srv.graph.nodes.get(id));
const hasAny = (html, words) => words.filter((w) => html.includes(w));

// ── a file in jsdom ─────────────────────────────────────────────────────────
const WINDOWS = [];
test.after(() => { for (const w of WINDOWS) w.close(); });

// The export loaded with scripts on and resources off: fetch, XHR and
// WebSocket throw and are counted; every pane host and every element inside
// one gets a box (jsdom does no layout), the range one rect.
function open(html) {
  const net = { calls: 0 };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(win) {
      const refuse = (what) => function () { net.calls++; throw new Error(`no ${what} in an export`); };
      win.fetch = refuse('fetch');
      win.XMLHttpRequest = refuse('XMLHttpRequest');
      win.WebSocket = refuse('WebSocket');
      const box = (l, t, w, h) => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t });
      win.Element.prototype.getBoundingClientRect = function () {
        if (this.classList && this.classList.contains('mount-host')) return box(0, 0, 800, 600);
        if (this.localName === 'svg') return box(50, 300, 200, 100);
        return box(20, 40, 300, 20);
      };
      win.Range.prototype.getClientRects = function () { return [box(60, 80, 120, 18)]; };
    },
  });
  WINDOWS.push(dom.window);
  return { win: dom.window, net };
}

// Each inline module of the document, run in its window as the browser would
// (jsdom runs none): its exact text, less the `export` keywords, so its own
// define line runs.
function runModules(win, html) {
  const mods = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const src of mods) win.eval(`(function () {\n${src.replace(/^export default function /m, 'function ').replace(/^export const /gm, 'var ')}\n})();`);
  return mods.length;
}

const markers = (win) => [...win.document.querySelectorAll('.wc-el-layer .el-marker')];
const markerOf = (win, id) => markers(win).find((m) => (m.getAttribute('data-el-ids') || '').split(' ').includes(id));

// ── the tests ───────────────────────────────────────────────────────────────

test('a local browser download carries the resolver, the element runtime, the fixture type\'s module and one data element; in jsdom it draws a marker per placed item and the removed type\'s generic mark with no network; no private element; the counts-only line names 2', async (t) => {
  const d = await daemon(t);
  const { node, ids } = await scenario(d);
  const r = await d.api.get(`/api/export/${node}`);
  assert.equal(r.status, 200, r.text);
  const html = r.text;
  const kinds = kindsOfNode(d, node);

  // The splice: right after the resolver's cut, before the shell.
  const [p, ...more] = dataElements(html);
  assert.equal(more.length, 0, 'one data element');
  assert.equal(docRuntime.validatePayload(carried(html)), null, JSON.stringify(p));
  assert.equal(carried(html).types[0].module, MARK_DRAW, 'the module, its exact bytes');
  const resolver = anchorsSrc.scriptElement({ kinds });
  assert.ok(html.includes(resolver + docRuntime.runtimeElement(docRuntime.keyOf(p))), 'the element runtime right after the resolver');
  assert.equal(p.types.length, 1);
  assert.deepStrictEqual([p.types[0].type, p.types[0].place], ['xe-mark', 'box']);
  assert.ok(html.includes(`<script type="module">${MARK_DRAW}\nwindow.__wcMount.elements.define("xe-mark", draw, {});</script>`), 'the fixture type\'s inline module, its exact bytes');
  assert.ok(html.indexOf('data-wc-elements') < html.indexOf('<script>(function () {\n  var data;'), 'the data element before the shell');
  assert.ok(!html.match(/id="wc-export-data"[^>]*>[^<]*/)[0].includes(W.shared), 'the element data never rides in wc-export-data');
  assert.deepStrictEqual(p.removed, ['xe-gone']);
  assert.deepStrictEqual(p.builtins, ['comment', 'highlight']);
  assert.deepStrictEqual(p.items.map((it) => it.id).sort(), [ids.shared, ids.hl, ids.mark, ids.gone].sort(), 'the shared items only');

  // No private element, and the count of what was left out.
  assert.deepStrictEqual(hasAny(html, PRIVATE_WORDS), [], 'no private text');
  assert.ok(!quoted(html, ids.priv) && !quoted(html, ids.hlPriv), 'no private id');
  const line = html.match(COUNT_LINE);
  assert.ok(line, 'the counts-only line');
  assert.equal(Number(line[1]), 2, 'two private notes left out');
  const head = new JSDOM(html).window.document.getElementById('export-head');
  assert.equal(head.querySelector('[data-private-left-out]').textContent, '2 private notes left out', 'in #export-head, a number only');

  // Drawn offline.
  const { win, net } = open(html);
  assert.equal(runModules(win, html), 1, 'one inline module');
  await waitUntil(() => win.document.readyState === 'complete', { timeout: 5000, what: 'the load event' });
  await new Promise((res) => win.setTimeout(res, 20));
  const ms = markers(win);
  assert.equal(ms.length, 4, `a marker per placed item: ${ms.map((m) => m.className).join(' | ')}`);
  assert.ok(markerOf(win, ids.shared).classList.contains('replied'), 'the comment drawn answered');
  assert.ok(markerOf(win, ids.hl), 'the highlight drawn');
  const box = markerOf(win, ids.mark);
  assert.equal(box.getAttribute('data-place'), 'box');
  assert.equal(box.getAttribute('data-xe-mark'), '1', 'the fixture type drew it');
  const g = markerOf(win, ids.gone);
  for (const c of ['el-marker', 'el-generic', 'el-standin']) assert.ok(g.classList.contains(c), `the removed type: ${c}`);
  assert.equal(g.querySelector('.el-generic-name').textContent, 'xe-gone');
  assert.deepStrictEqual({ ...win.__wcMount.elements.stats() }, { drawn: 3, generic: 1, parked: 0, unplaced: 0, clipped: 0 });
  assert.equal(net.calls, 0, 'no network call');
  t.diagnostic(`export ${Buffer.byteLength(html)} B; element splice ${Buffer.byteLength(docRuntime.scripts(carried(html)))} B (runtime key ${docRuntime.keyOf(p)})`);
});

test('lib/client\'s export (GET ?format=file) and the MCP tool\'s file carry the shared elements, no private element, no count and no line; buildExportHtml with no reader equals fileReader(\'local\'); a seesPrivate reader is read as its level', async (t) => {
  const d = await daemon(t);
  const { node, ids } = await scenario(d);
  const ctx = ctxOf(d);

  const files = [];
  const viaClient = await d.call(`/api/export/${node}?format=file`);
  assert.equal(viaClient.status, 200, JSON.stringify(viaClient.body));
  files.push(['lib/client', fs.readFileSync(viaClient.body.path, 'utf8')]);
  const prev = process.env.WEB_CHAT_PORT;
  process.env.WEB_CHAT_PORT = String(d.port);
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_PORT; else process.env.WEB_CHAT_PORT = prev; });
  const tool = await require('../lib/mcp/tools/export').handler({ node });
  assert.ok(tool.ok && tool.path, JSON.stringify(tool));
  files.push(['the MCP tool', fs.readFileSync(tool.path, 'utf8')]);
  for (const [who, html] of files) {
    assert.deepStrictEqual(hasAny(html, PRIVATE_WORDS), [], `${who}: no private text`);
    assert.ok(!quoted(html, ids.priv) && !quoted(html, ids.hlPriv), `${who}: no private id`);
    assert.equal(docRuntime.validatePayload(carried(html)), null, `${who}: the carried payload passes validatePayload`);
    assert.ok(!COUNT_LINE.test(html) && !html.includes('private note'), `${who}: no count and no line`);
    const [p] = dataElements(html);
    assert.ok(p, `${who}: the shared elements drawn`);
    assert.deepStrictEqual(p.items.map((it) => it.id).sort(), [ids.shared, ids.hl, ids.mark, ids.gone].sort(), `${who}: shared items`);
    assert.deepStrictEqual(hasAny(html, ELEMENT_WORDS), ELEMENT_WORDS, `${who}: with their text`);
  }

  const none = exp.buildExportHtml(ctx, node, NOW).html;
  assert.strictEqual(none, exp.buildExportHtml(ctx, node, NOW, { reader: fileReader('local') }).html, 'no reader = fileReader(\'local\')');
  assert.strictEqual(exp.buildExportHtml(ctx, node, NOW, { reader: { level: 'local', seesPrivate: true } }).html, none,
    'a reader that sees private records still gets the file reader of its level');
  assert.strictEqual(unstamped(none), unstamped(files[0][1]), 'the route\'s file is the default build');
  assert.equal(dataElements(none).length, 1);
});

test('a remote read viewer\'s download carries the shared elements with their text and no count; a remote basic viewer\'s and a network peer\'s carry no data element, no runtime and no element text', async (t) => {
  const read = await daemon(t, 'read');
  const { node, ids } = await scenario(read);
  const remote = await read.call(`/api/export/${node}`, REMOTE);
  assert.equal(remote.status, 200, String(remote.body).slice(0, 200));
  const html = remote.body;
  const [p, ...more] = dataElements(html);
  assert.ok(p && !more.length, 'one data element');
  assert.equal(docRuntime.validatePayload(carried(html)), null);
  // A removed type's gate is 'local': no remote reader gets its item.
  assert.deepStrictEqual(p.items.map((it) => it.id).sort(), [ids.shared, ids.hl, ids.mark].sort(), 'the shared items of the types read meets');
  assert.deepStrictEqual(hasAny(html, ELEMENT_WORDS), ELEMENT_WORDS, 'with their text');
  assert.deepStrictEqual(hasAny(html, PRIVATE_WORDS), [], 'no private text');
  assert.ok(!COUNT_LINE.test(html) && !html.includes('private note'), 'no count and no line');

  const runtimeMark = 'window.__wcMount.elements';
  const peer = await read.call(`/api/export/${node}`, { ...PEER, 'Sec-Fetch-Mode': 'cors' });
  const basicD = await daemon(t);
  const b = await scenario(basicD);
  const basic = await basicD.call(`/api/export/${b.node}`, REMOTE);
  for (const [who, r] of [['a network peer', peer], ['a remote basic viewer', basic]]) {
    assert.equal(r.status, 200, `${who}: ${String(r.body).slice(0, 200)}`);
    const text = String(r.body);
    assert.equal(dataElements(text).length, 0, `${who}: no data element`);
    assert.ok(!text.includes(docRuntime.runtimeSource(docRuntime.keyOf(p))) && !text.includes(runtimeMark) && !text.includes('type="module"'), `${who}: no runtime`);
    assert.deepStrictEqual(hasAny(text, [...ELEMENT_WORDS, ...PRIVATE_WORDS, W.gone]), [], `${who}: no element text`);
    assert.ok(!COUNT_LINE.test(text), `${who}: no count`);
  }
});

test('a node without records and a node whose only element is private, exported for lib/client, are byte-equal to the export before this unit; a count of zero writes nothing', async (t) => {
  const d = await daemon(t);
  const { api } = d;
  const ctx = ctxOf(d);
  await ok(api.post('/api/render', { id: 'pa', html: HTML_A }), 'render pa');
  const bare = await commit(api, 'no records');
  await post(api, { type: 'comment', anchor: LOCATOR('pa'), payload: { text: W.priv, shared: false } }, 'private comment');
  const privOnly = await commit(api, 'a private comment only');
  assert.equal(kindsOfNode(d, bare).length, 0, 'the bare node carries no record');
  assert.ok(kindsOfNode(d, privOnly).length > 0, 'the private-only node carries one');

  for (const [what, ref] of [['the bare node', bare], ['the private-only node', privOnly]]) {
    const before = exportBefore(ctx, ref);
    assert.strictEqual(exp.buildExportHtml(ctx, ref, NOW).html, before, `${what}: buildExportHtml, byte-equal`);
    const file = await d.call(`/api/export/${ref}?format=file`);
    assert.equal(file.status, 200, JSON.stringify(file.body));
    assert.strictEqual(unstamped(fs.readFileSync(file.body.path, 'utf8')), unstamped(before), `${what}: lib/client's file, byte-equal`);
  }
  // The local browser's download of the bare node: nothing left out, nothing written.
  const bareDl = await api.get(`/api/export/${bare}`);
  assert.strictEqual(unstamped(bareDl.text), unstamped(exportBefore(ctx, bare)), 'a count of zero writes nothing');
  // The private-only node's: one left out, and only the line differs.
  const privDl = await api.get(`/api/export/${privOnly}`);
  assert.equal(Number(privDl.text.match(COUNT_LINE)[1]), 1);
  assert.strictEqual(unstamped(privDl.text).replace(/<span data-private-left-out="1">1 private note left out<\/span>/, ''), unstamped(exportBefore(ctx, privOnly)),
    'the line is the only difference; no private element rides');
  // assembleExport: a zero, a negative or a non-integer count writes nothing.
  const input = { mounts: [{ id: 'm', html: '<p>x</p>' }], meta: { label: 'n1.0' } };
  for (const n of [0, -1, 1.5, '2', null]) {
    assert.strictEqual(exp.assembleExport({ ...input, meta: { ...input.meta, privateLeftOut: n } }), exp.assembleExport(input), `${JSON.stringify(n)} writes nothing`);
  }
  // And a null payload splices nothing beside the resolver.
  assert.strictEqual(exp.assembleExport({ ...input, elements: ['element'], docElements: null }), exp.assembleExport({ ...input, elements: ['element'] }));
});

test('`live` exports the live surface\'s elements with no recorded answer; the committed node carries its recorded one', async (t) => {
  const d = await daemon(t);
  const { node, ids } = await scenario(d);
  const ctx = ctxOf(d);
  const [committed] = dataElements(exp.buildExportHtml(ctx, node, NOW).html);
  assert.deepStrictEqual(committed.items.find((it) => it.id === ids.shared).answer, { state: 'exact', how: 'path' }, 'the node\'s recorded answer');
  const r = await d.api.get('/api/export/live');
  assert.equal(r.status, 200);
  const [live, ...more] = dataElements(r.text);
  assert.ok(live && !more.length, 'one data element');
  assert.equal(docRuntime.validatePayload(carried(r.text)), null);
  assert.deepStrictEqual(live.items.map((it) => it.id).sort(), [ids.shared, ids.hl, ids.mark, ids.gone].sort(), 'the live shared elements');
  for (const it of live.items) assert.equal(it.answer, null, `${it.id}: no recorded answer on the live surface`);
  assert.equal(Number(r.text.match(COUNT_LINE)[1]), 2, 'the live private notes counted, not carried');
  assert.deepStrictEqual(hasAny(r.text, PRIVATE_WORDS), []);
});
