// The documents' element payload (annotation engine tranche 4, PLAN.md 4B.1;
// U521): lib/server/document-elements.js documentElements — THE one builder
// every document reads — with readerOf / fileReader, its projection (the
// per-type gate, the route's TEXT_RULES and PRIVATE_RULES rows), the type rows
// read through U511's readTypeFile, the `sources` table, the lazy-body rule,
// and the opt-in `{refs: true}` it adds to leanElements.
//
// Every scenario runs on a real daemon (withServer): the elements are written
// through POST /api/elements as the chrome and Claude write them, a node is a
// turn's commit, a plug-in type is a pack installed and approved in process
// (test-support/element-type-fixture: B1's path), and an answer is the side
// table's record appended through the log (test/side-table.test.js's way).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A box grab POSTed here is drawn off the request by headless Chrome (U328b):
// pin the finder to no browser, so this file never launches one.
process.env.WEB_CHAT_CHROME = '/nonexistent/web-chat-test/chrome';

const { withServer } = require('../test-support/helpers');
const { elementPack, approveElementPack } = require('../test-support/element-type-fixture');
const packs = require('../lib/packs/install');
const { readStore } = require('../lib/packs/store');
const { projectPaths } = require('../lib/core/paths');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { createAudience } = require('../lib/server/audience');
const { readTypeFile } = require('../lib/server/element-files');
const { resolveNodeRef } = require('../lib/server/domain/refs');
const { leanElements } = require('../lib/server/domain/element-projection');
const { pageItems } = require('../lib/server/preview');
const { validatePayload } = require('../lib/server/runtime/elements-doc-src');
const { fieldEntries, kindsOf } = require('../lib/server/runtime/anchors-src');
const { FILE_MAX } = require('../lib/core/element-assets');
const de = require('../lib/server/document-elements');

const { documentElements, readerOf, fileReader, documentDeps } = de;

const PREVIEW = 'GET /preview/node/:id';
const EXPORT = 'GET /api/export/:ref';
const PANE = 'GET /preview/pane/:node/:mount';

const HTML_A = '<p class="lead">Hello world</p><p class="body">The quick brown fox jumps</p>';
const HTML_B = '<figure><svg class="chart" viewBox="0 0 10 10" width="100" height="100"><rect width="10" height="10"/></svg></figure>';
const LOCATOR = (mount) => ({ mount, selector: 'p.lead', text: 'Hello world', ordinal: 0 });
const RANGE = (mount, exact = 'quick brown') => ({ v: 1, kind: 'range', mount, quote: { exact, prefix: 'The ', suffix: ' fox' } });
const ELEMENT = (mount) => ({ v: 1, kind: 'element', mount, at: { path: [0, 0], sib: 0 }, fp: { tag: 'svg', id: '', cls: ['chart'], head: '', attrs: [], parent: 'figure' }, rows: [] });
const SOURCE = (md) => ({ v: 1, kind: 'source', md, slug: 'notes', quote: { exact: 'three steps', prefix: 'The plan holds ', suffix: '.' } });
const RECT = (item) => ({ x: 1, y: 2, w: 30, h: 40, item, viewport: { w: 1200, h: 800 } });

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>\n';
// A WebP header over more than the per-file cap: readFenced refuses it before
// any sniff.
const BIG = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(FILE_MAX + 16, 1)]);
const MARK_DRAW = [
  '// de-mark: frames its target.',
  "export const glyph = { dx: -13, dy: -26, w: 26, h: 26 };",
  'export default function draw(group, ctx) {',
  "  if (group.container) group.container.setAttribute('data-de-mark', String(group.items.length));",
  '}',
  '',
].join('\n');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const NEVER = ['writer', 'provenance', 'author', 'chain', 'meta', 'grab', 'qual', 'surface', 'source'];

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
async function commit(api, message = 't') {
  await ok(api.post('/api/turn-begin', { message }), 'turn-begin');
  const r = await ok(api.post('/api/turn-end', { author: 'claude' }), 'turn-end');
  assert.ok(r.node_id, `a node committed: ${JSON.stringify(r)}`);
  return r.node_id;
}
const post = async (api, body, what) => (await ok(api.post('/api/elements', body), what));

// Every key anywhere in a JSON value.
function keysIn(v, out = new Set()) {
  if (Array.isArray(v)) for (const x of v) keysIn(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysIn(x, out); }
  return out;
}

// The request shapes a reader is named from (lib/server/audience): a local
// browser (fetch metadata, as private-routes.test.js's api helper sends), lib/
// client (none), a remote viewer (the portal's label) and a network peer.
const LOOPBACK = { remoteAddress: '127.0.0.1' };
const REQ = {
  browser: { headers: { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' }, socket: LOOPBACK },
  client: { headers: {}, socket: LOOPBACK },
  remote: { headers: { 'x-wc-remote': '1' }, socket: LOOPBACK },
  peer: { headers: {}, socket: { remoteAddress: '10.0.0.5' } },
};
const TUNNEL = {
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
};

// Audiences over a tunnel.json naming this root at `level` (and one with none).
function audiences(t, root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-doc-elements-aud-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = (level) => {
    const file = path.join(dir, `${level}.json`);
    writeJsonAtomic(file, { ...TUNNEL, remote: { mirror: { [path.resolve(root)]: level } } });
    const a = createAudience({ root, configFile: file, pollMs: 60000 });
    t.after(() => a.stop());
    return a;
  };
  return { none: createAudience({ configFile: null }), read: at('read'), full: at('full') };
}

// The route ctx's members documentDeps reads, from a withServer context.
const ctxOf = (d) => ({ graph: d.srv.graph, sideTable: d.srv.sideTable, elementTypes: d.srv.elementTypes, root: d.root });
const recordedDraw = (root, packName, type) => {
  const pack = readStore(projectPaths(root).packs).packs.find((p) => p.name === packName);
  return pack.units.find((u) => u.kind === 'element' && u.name === type).files.find((f) => f.path === 'draw.js').sha256;
};

const MARK_JSON = { payload: { keys: ['anchor', 'shared', 'label'] }, anchors: ['element', 'range'], place: 'box' };

// The scenario: two panes and a markdown item; a shared comment Claude
// replied to, a private comment, a shared and a private highlight, a shared
// de-mark (a plug-in type, place 'box'), a box grab; committed, then an
// answer recorded for the comment on that node, then the highlight edited
// live (so the node's pin is its earlier v).
async function scenario(t, { files = {}, draw = MARK_DRAW } = {}) {
  const d = await withServer(t);
  const { api } = d;
  approveElementPack(d, { name: 'de-pack', type: 'de-mark', json: MARK_JSON, files, draw });
  assert.ok(d.srv.elementTypes.listed('de-mark'), 'the fixture type lists');
  await ok(api.post('/api/render', { id: 'pa', html: HTML_A }), 'render pa');
  await ok(api.post('/api/render', { id: 'pb', html: HTML_B }), 'render pb');
  await ok(api.post('/api/markdown', { id: 'md-notes', text: '## Notes\n\nThe plan holds three steps.' }), 'markdown');
  const shared = (await post(api, { type: 'comment', anchor: LOCATOR('pa'), payload: { text: 'Is this the lead?', shared: true } }, 'shared comment')).pin;
  const replied = (await ok(api.post(`/api/elements/${shared.id}/reply`, { text: 'Yes, kept it.', author: 'claude' }), 'claude reply')).pin;
  const priv = (await post(api, { type: 'comment', anchor: LOCATOR('pa'), payload: { text: 'my own note', shared: false } }, 'private comment')).pin;
  const hl = (await post(api, { type: 'highlight', anchor: RANGE('pa'), payload: { color: 'gold', note: 'the subject' } }, 'shared highlight')).element;
  const hlPriv = (await post(api, { type: 'highlight', anchor: RANGE('pa', 'brown fox'), payload: { color: 'green', note: 'mine', shared: false } }, 'private highlight')).element;
  const mark = (await post(api, { type: 'de-mark', anchor: ELEMENT('pb'), payload: { label: 'framed' } }, 'de-mark')).element;
  const grab = (await post(api, { type: 'box-grab', anchor: null, payload: { rect: RECT('pb'), meta: {} } }, 'box grab')).element;
  const node = await commit(api, 'the scenario');
  // The answer the side table records for the comment on that node.
  d.srv.elements.log.appendAnswers({ node, items: [{
    id: shared.id, v: replied.v, mount: 'pa', state: 'exact', how: 'path', gen: 0, surface: 0,
    qual: { spec: 'x', store: 'y' }, source: { peer: 'local', device: null },
  }] });
  // A later live edit: the node keeps the v it pinned.
  await ok(api.patch(`/api/elements/${hl.id}`, { payload: { note: 'edited later' } }), 'edit the highlight');
  return { d, node, ids: { shared: shared.id, priv: priv.id, hl: hl.id, hlPriv: hlPriv.id, mark: mark.id, grab: grab.id }, replied };
}

const nodeOf = (d, id) => d.srv.graph.nodes.get(id);
const build = (d, id, reader, opts = {}) => documentElements(opts.deps || documentDeps(ctxOf(d)), opts.node || nodeOf(d, id), { reader, route: opts.route || PREVIEW, item: opts.item });
const idsOf = (p) => (p ? p.items.map((it) => it.id) : null);

test('a local browser gets every item the node carries, at the v the node pins, with its recorded answer; the payload passes validatePayload and carries no attribution', async (t) => {
  const { d, node, ids, replied } = await scenario(t);
  const aud = audiences(t, d.root);
  const reader = readerOf(aud.none, REQ.browser);
  assert.deepStrictEqual(reader, { level: 'local', seesPrivate: true });
  const p = build(d, node, reader);
  assert.equal(validatePayload(p), null, JSON.stringify(p));
  const want = [ids.shared, ids.priv, ids.hl, ids.hlPriv, ids.mark].sort();
  assert.deepStrictEqual(idsOf(p), want, 'every item, the box grab never one');
  const by = Object.fromEntries(p.items.map((it) => [it.id, it]));
  // The comment: Claude's reply, the recorded answer, its pinned v.
  assert.equal(by[ids.shared].v, replied.v);
  assert.deepStrictEqual(by[ids.shared].payload, { text: 'Is this the lead?', replies: [{ text: 'Yes, kept it.', claude: true }] });
  assert.deepStrictEqual(by[ids.shared].answer, { state: 'exact', how: 'path' });
  assert.equal(by[ids.priv].shared, false);
  assert.equal(by[ids.priv].answer, null);
  // The highlight at the v the node pins (1), not the live edit (2).
  assert.equal(by[ids.hl].v, 1);
  assert.deepStrictEqual(by[ids.hl].payload, { color: 'gold', note: 'the subject' });
  assert.equal(d.srv.elements.latest(ids.hl).v, 2, 'the live edit is v2');
  // The plug-in: its schema's keys less anchor, shared and meta.
  assert.deepStrictEqual(by[ids.mark].payload, { label: 'framed' });
  assert.equal(by[ids.mark].schema, 'de-mark@1');
  for (const it of p.items) assert.ok(Number.isSafeInteger(it.seq), `${it.id} carries its seq`);
  assert.deepStrictEqual(p.builtins, ['comment', 'highlight']);
  assert.deepStrictEqual(p.removed, []);
  assert.deepStrictEqual(p.types.map((r) => [r.type, r.schema, r.place]), [['de-mark', 'de-mark@1', 'box']]);
  // Never attribution or engine bookkeeping, and never the minted record.
  const keys = keysIn(p);
  for (const k of NEVER) assert.ok(!keys.has(k), `the payload holds no ${k}`);
  assert.ok(!keys.has('record'), 'the minted record is not carried');
  assert.ok(!keys.has('gen'));
  assert.ok(!('sources' in p), 'no source-anchored item: no sources key');
});

test('the projection: no private item for lib/client, a remote read viewer or a file; nothing for basic or a network peer; a see-full type only from full', async (t) => {
  const { d, node, ids } = await scenario(t);
  const aud = audiences(t, d.root);
  const shared = [ids.shared, ids.hl, ids.mark].sort();
  assert.deepStrictEqual(readerOf(aud.none, REQ.client), { level: 'local', seesPrivate: false });
  assert.deepStrictEqual(readerOf(aud.read, REQ.remote), { level: 'read', seesPrivate: false });
  assert.deepStrictEqual(fileReader('local'), { level: 'local', seesPrivate: false });
  for (const [who, reader, route] of [
    ['lib/client', readerOf(aud.none, REQ.client), PREVIEW],
    ['a remote read viewer', readerOf(aud.read, REQ.remote), PREVIEW],
    ['a remote full viewer', readerOf(aud.full, REQ.remote), PREVIEW],
    ['a file', fileReader('local'), EXPORT],
    ['the replay download', fileReader('local'), 'GET /api/replay/html'],
  ]) {
    const p = build(d, node, reader, { route });
    assert.equal(validatePayload(p), null, `${who}: ${JSON.stringify(p)}`);
    assert.deepStrictEqual(idsOf(p), shared, `${who}: the shared items only`);
    assert.ok(!JSON.stringify(p).includes('my own note') && !JSON.stringify(p).includes('"mine"'), `${who}: no private text`);
  }
  for (const [who, reader] of [
    ['a remote basic viewer', readerOf(aud.none, REQ.remote)],
    ['a network peer', readerOf(aud.full, REQ.peer)],
  ]) {
    assert.equal(reader.level, 'basic', who);
    assert.equal(build(d, node, reader), null, `${who}: null`);
  }
  // A reader with no audience at all: no opt-in, narrower never wider.
  assert.deepStrictEqual(readerOf(null, REQ.remote), { level: 'basic', seesPrivate: false });
  // An audience that throws: basic, nothing private.
  const boom = { levelOf() { throw new Error('x'); }, seesPrivate() { throw new Error('x'); } };
  assert.deepStrictEqual(readerOf(boom, REQ.browser), { level: 'basic', seesPrivate: false });
  // A route with no PRIVATE_RULES row is refused.
  assert.throws(() => build(d, node, fileReader('local'), { route: 'GET /api/nowhere' }), TypeError);

  // A type whose see is 'full': absent for read, present for full and local.
  approveElementPack(d, { name: 'de-full-pack', type: 'de-full', json: { payload: { keys: ['anchor', 'shared', 'label'] }, remote: { see: 'full', send: 'full' } } });
  assert.equal(d.srv.elementTypes.gate('de-full').see, 'full');
  const full = (await post(d.api, { type: 'de-full', anchor: RANGE('pa'), payload: { label: 'only full' } }, 'de-full')).element;
  const n2 = await commit(d.api, 'with a see-full element');
  assert.ok(!idsOf(build(d, n2, readerOf(aud.read, REQ.remote))).includes(full.id), 'read: no see-full item');
  assert.ok(!build(d, n2, readerOf(aud.read, REQ.remote)).types.some((r) => r.type === 'de-full'), 'read: and no row for its type');
  assert.ok(idsOf(build(d, n2, readerOf(aud.full, REQ.remote))).includes(full.id), 'full: the see-full item');
  assert.ok(idsOf(build(d, n2, fileReader('local'), { route: EXPORT })).includes(full.id), 'local: the see-full item');
});

test('a type no kept item uses carries no row: a remote read viewer of a node whose only plug-in element is private gets no draw module', async (t) => {
  const d = await withServer(t);
  approveElementPack(d, { name: 'de-pack', type: 'de-mark', json: MARK_JSON });
  const aud = audiences(t, d.root);
  await ok(d.api.post('/api/render', { id: 'pa', html: HTML_A }), 'render');
  await ok(d.api.post('/api/render', { id: 'pb', html: HTML_B }), 'render');
  await post(d.api, { type: 'comment', anchor: LOCATOR('pa'), payload: { text: 'shared', shared: true } }, 'comment');
  const mark = (await post(d.api, { type: 'de-mark', anchor: ELEMENT('pb'), payload: { label: 'hidden', shared: false } }, 'private de-mark')).element;
  const node = await commit(d.api);
  let reads = 0;
  const deps = { ...documentDeps(ctxOf(d)), readTypeFile: (type, rel) => { reads++; return readTypeFile(ctxOf(d), type, rel); } };
  const p = build(d, node, readerOf(aud.read, REQ.remote), { deps });
  assert.equal(validatePayload(p), null);
  assert.deepStrictEqual(p.types, [], 'no row');
  assert.ok(!idsOf(p).includes(mark.id));
  assert.equal(reads, 0, 'the type\'s files were never read');
  const local = build(d, node, readerOf(aud.none, REQ.browser), { deps });
  assert.ok(idsOf(local).includes(mark.id));
  assert.deepStrictEqual(local.types.map((r) => r.type), ['de-mark']);
  assert.ok(reads > 0);
});

test('draw.js inlined byte-equal to its recorded digest; an asset over the cap and one outside the allowlist are skipped with their reasons; an inert svg is inlined', async (t) => {
  const { d, node } = await scenario(t, { files: { 'assets/mark.svg': SVG, 'assets/big.webp': BIG, 'assets/notes.txt': 'plain words\n' } });
  const p = build(d, node, fileReader('local'), { route: EXPORT });
  assert.equal(validatePayload(p), null, JSON.stringify(p && p.types));
  const [row] = p.types;
  assert.equal(row.module, MARK_DRAW);
  assert.equal(sha256(Buffer.from(row.module, 'utf8')), recordedDraw(d.root, 'de-pack', 'de-mark'), 'byte-equal to the install record\'s digest');
  assert.equal(row.sha256, recordedDraw(d.root, 'de-pack', 'de-mark'));
  assert.deepStrictEqual(Object.keys(row.assets), ['mark.svg']);
  assert.equal(row.assets['mark.svg'], `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`);
  const skipped = Object.fromEntries(row.skipped.map((s) => [s.rel, s.reason]));
  assert.deepStrictEqual(Object.keys(skipped).sort(), ['big.webp', 'notes.txt']);
  assert.match(skipped['big.webp'], new RegExp(`over ${FILE_MAX} bytes`));
  assert.match(skipped['notes.txt'], /not an allowed file/);
});

test('a module that breaks the draw contract or cannot be spliced rides as no module, named in skipped; its items still ride for the generic mark (readTypeFile a stub through deps)', async (t) => {
  const { d, node, ids } = await scenario(t);
  for (const [text, reason] of [
    ['export default (g, c) => { g.container.textContent = "x"; };\n', 'draw-contract'],
    [`${MARK_DRAW}// </script><script>alert(1)\n`, 'unsafe-splice'],
    [`${MARK_DRAW}// <!-- a comment opener\n`, 'unsafe-splice'],
    [`import x from './x.js';\n${MARK_DRAW}`, 'draw-contract'],
    [`${MARK_DRAW}export default function draw(g) {}\n`, 'draw-contract'],
  ]) {
    const real = documentDeps(ctxOf(d));
    const deps = { ...real, readTypeFile: (type, rel) => (rel === 'draw.js' ? { bytes: Buffer.from(text), sha256: sha256(Buffer.from(text)), type: 'text/javascript; charset=utf-8', kind: 'draw' } : real.readTypeFile(type, rel)) };
    const p = build(d, node, fileReader('local'), { route: EXPORT, deps });
    assert.equal(validatePayload(p), null, reason);
    const [row] = p.types;
    assert.equal(row.module, '', `${reason}: no module`);
    assert.deepStrictEqual(row.skipped, [{ rel: 'draw.js', reason }], JSON.stringify(text));
    const it = p.items.find((x) => x.id === ids.mark);
    assert.ok(it, `${reason}: the item still rides`);
    assert.deepStrictEqual(it.payload, { label: 'framed' });
  }
});

test('the pack removed after the commit: its type in removed, its items with payload null; a schema the type no longer reads: the item parked', async (t) => {
  const { d, node, ids } = await scenario(t);
  // A new version of the pack whose type reads only de-mark@2.
  packs.installFromStage({
    stageDir: elementPack({ name: 'de-pack', version: '2.0.0', type: 'de-mark', draw: MARK_DRAW,
      json: { ...MARK_JSON, schema: 'de-mark@2', reads: ['de-mark@2'], payload: { keys: ['anchor', 'shared', 'label', 'tone'] } } }),
    source: { via: 'test' }, tier: 'local', root: d.root, via: 'approve', replace: true,
  });
  d.srv.elementTypes.invalidate();
  assert.deepStrictEqual(d.srv.elementTypes.reads('de-mark'), ['de-mark@2']);
  const parked = build(d, node, fileReader('local'), { route: EXPORT });
  assert.equal(validatePayload(parked), null);
  const it = parked.items.find((x) => x.id === ids.mark);
  assert.deepStrictEqual([it.parked, it.payload, it.schema], [true, null, 'de-mark@1']);
  assert.deepStrictEqual(parked.types.map((r) => [r.type, r.schema, r.reads]), [['de-mark', 'de-mark@2', ['de-mark@2']]]);

  packs.removePackByName({ name: 'de-pack', root: d.root });
  d.srv.elementTypes.invalidate();
  assert.equal(d.srv.elementTypes.listed('de-mark'), false);
  const gone = build(d, node, fileReader('local'), { route: EXPORT });
  assert.equal(validatePayload(gone), null, JSON.stringify(gone));
  assert.deepStrictEqual(gone.removed, ['de-mark']);
  assert.deepStrictEqual(gone.types, []);
  const g = gone.items.find((x) => x.id === ids.mark);
  assert.equal(g.payload, null);
  // A removed type's gate is 'local': no remote reader gets its items.
  const aud = audiences(t, d.root);
  const remote = build(d, node, readerOf(aud.full, REQ.remote));
  assert.ok(!idsOf(remote).includes(ids.mark));
  assert.deepStrictEqual(remote.removed, []);
});

test('{item} keeps only the items anchored on that pane; the live node gives its live references with answer null', async (t) => {
  const { d, node, ids } = await scenario(t);
  const aud = audiences(t, d.root);
  const reader = readerOf(aud.none, REQ.browser);
  const pb = build(d, node, reader, { route: PANE, item: 'pb' });
  assert.equal(validatePayload(pb), null);
  assert.deepStrictEqual(idsOf(pb), [ids.mark], 'only the item anchored on pb');
  assert.deepStrictEqual(pb.builtins, []);
  const pa = build(d, node, reader, { route: PANE, item: 'pa' });
  assert.deepStrictEqual(idsOf(pa), [ids.shared, ids.priv, ids.hl, ids.hlPriv].sort());
  assert.deepStrictEqual(pa.types, [], 'no row for a type the cut leaves out');
  assert.equal(build(d, node, reader, { route: PANE, item: 'nowhere' }), null);

  const live = resolveNodeRef(d.srv.graph, 'live');
  assert.ok(live.ok && live.live);
  const p = documentElements(documentDeps(ctxOf(d)), live.node, { reader, route: EXPORT });
  assert.equal(validatePayload(p), null);
  assert.deepStrictEqual(idsOf(p), [ids.shared, ids.priv, ids.hl, ids.hlPriv, ids.mark].sort(), 'the live pins and references');
  for (const it of p.items) assert.equal(it.answer, null, `${it.id}: the live node has no recorded answer`);
  assert.equal(p.items.find((x) => x.id === ids.hl).v, 2, 'the live reference\'s own v');
});

test('sources: a kept source-anchored item carries its markdown item\'s {src, map} as pageItems gives them; a private one only for a reader who sees it', async (t) => {
  const d = await withServer(t);
  const aud = audiences(t, d.root);
  await ok(d.api.post('/api/render', { id: 'pa', html: HTML_A }), 'render');
  await ok(d.api.post('/api/markdown', { id: 'md-notes', text: '## Notes\n\nThe plan holds three steps.' }), 'markdown');
  await ok(d.api.post('/api/markdown', { id: 'md-other', text: 'Another item.' }), 'markdown');
  const plain = await commit(d.api, 'no source anchor');
  assert.equal(build(d, plain, readerOf(aud.none, REQ.browser)), null, 'no element: null');
  await post(d.api, { type: 'comment', anchor: LOCATOR('pa'), payload: { text: 'on the pane', shared: true } }, 'comment');
  const n1 = await commit(d.api, 'still no source anchor');
  assert.ok(!('sources' in build(d, n1, readerOf(aud.none, REQ.browser))), 'no source-anchored item: no sources key');

  const priv = (await post(d.api, { type: 'comment', anchor: SOURCE('md-notes'), payload: { text: 'only mine', shared: false } }, 'private source comment')).pin;
  const n2 = await commit(d.api, 'a private source anchor');
  const want = Object.fromEntries(pageItems(nodeOf(d, n2), { sourceMap: true }).filter((it) => it.md === 'md-notes').map((it) => [it.md, { src: it.src, map: it.map }]));
  const local = build(d, n2, readerOf(aud.none, REQ.browser));
  assert.equal(validatePayload(local), null, JSON.stringify(local.sources));
  assert.deepStrictEqual(local.sources, want, 'the named item only, as pageItems gives it');
  assert.ok(idsOf(local).includes(priv.id));
  for (const reader of [readerOf(aud.read, REQ.remote), fileReader('local'), readerOf(aud.none, REQ.client)]) {
    const p = build(d, n2, reader, { route: EXPORT });
    assert.ok(p && !('sources' in p), 'the only source-anchored item is private: no table');
  }

  await post(d.api, { type: 'comment', anchor: SOURCE('md-notes'), payload: { text: 'everyone', shared: true } }, 'shared source comment');
  const n3 = await commit(d.api, 'a shared source anchor');
  const file = build(d, n3, fileReader('local'), { route: EXPORT });
  assert.equal(validatePayload(file), null);
  assert.deepStrictEqual(Object.keys(file.sources), ['md-notes'], 'never md-other: no item names it');
});

test('lazy bodies: with every other node\'s body throwing, the build for one node succeeds and reads none of them', async (t) => {
  const { d, ids } = await scenario(t);
  await ok(d.api.post('/api/render', { id: 'pc', html: '<p>more</p>' }), 'render');
  const n2 = await commit(d.api, 'second');
  await ok(d.api.post('/api/render', { id: 'pd', html: '<p>more still</p>' }), 'render');
  const n3 = await commit(d.api, 'third');
  const graph = d.srv.graph;
  const nodes = graph.nodes;
  const kept = new Map(nodes);
  const touched = [];
  const OK = new Set(['id', 'parent_id']);
  t.after(() => { for (const [id, n] of kept) nodes.set(id, n); });
  for (const [id, n] of kept) {
    if (id === n3) continue;
    nodes.set(id, new Proxy(n, {
      get(target, key, recv) {
        if (typeof key === 'symbol' || OK.has(key)) return Reflect.get(target, key, recv);
        touched.push(`${id}.${String(key)}`);
        throw new Error(`the body of ${id} was read (${String(key)})`);
      },
    }));
  }
  const target = kept.get(n3);
  assert.notEqual(target.parent_id, null, 'the node has an ancestry');
  assert.ok(n2);
  const p = documentElements(documentDeps(ctxOf(d)), target, { reader: fileReader('local'), route: EXPORT });
  assert.equal(validatePayload(p), null);
  assert.ok(idsOf(p).includes(ids.shared));
  assert.deepStrictEqual(touched, [], 'no other node\'s body');
});

test('leanElements: {node: true} is unchanged by the refs option; {node: true, refs: true} adds the references\' rows', async (t) => {
  const { d, node, ids } = await scenario(t);
  const n = nodeOf(d, node);
  const store = d.srv.elements;
  const lean = leanElements(n, store, { node: true });
  assert.deepStrictEqual(leanElements(n, store, { node: true, refs: false }), lean);
  assert.deepStrictEqual(lean.map((r) => r.id), [ids.shared, ids.priv].sort(), 'the comment copies alone');
  const both = leanElements(n, store, { node: true, refs: true });
  assert.deepStrictEqual(both.map((r) => r.id), [ids.shared, ids.priv, ids.hl, ids.hlPriv, ids.mark, ids.grab].sort());
  const hl = both.find((r) => r.id === ids.hl);
  assert.deepStrictEqual([hl.type, hl.v, hl.shared], ['highlight', 1, true]);
  assert.equal(both.find((r) => r.id === ids.hlPriv).shared, false);
  // The live surface's projection is untouched by the option.
  assert.deepStrictEqual(leanElements(d.srv.state, store, { refs: true }), leanElements(d.srv.state, store));
});

test('fieldEntries: the field table\'s walk as a list, the records kindsOf reads', () => {
  const node = {
    comments: [{ id: 'c1', anchor: { mount: 'a', selector: 'p', text: 'x' } }],
    elements: ['h2@1', 'p3@2'],
    mounts: [{ id: 'a' }],
  };
  assert.deepStrictEqual(fieldEntries(node), [
    { field: 'comments', entry: node.comments[0] },
    { field: 'elements', entry: 'h2@1' },
    { field: 'elements', entry: 'p3@2' },
  ]);
  assert.deepStrictEqual(fieldEntries(null), []);
  assert.deepStrictEqual(fieldEntries({ comments: 'no' }), []);
  assert.ok(kindsOf(node).length > 0, 'the same records kindsOf reads');
});

// U415e's documents' half: a value the redactor learns after the commit is in
// no document — the draw fields come from the log's masked view, the anchors
// through the read view — and the item whose pinned words held it is served
// masked (state, visible, explain), which the document draws el-masked.
test('a value learned after the commit: no fragment of it in the payload, and the item it touched rides masked', async (t) => {
  const { waitUntil } = require('../test-support/helpers');
  const { findLeaks } = require('../test-support/fake-secrets');
  const d = await withServer(t);
  const value = `wcdoc${crypto.randomBytes(12).toString('hex')}`;
  const text = `Use ${value} for access to the staging host now.`;
  await ok(d.api.post('/api/render', { id: 'pa', html: `<p>${text}</p>` }), 'render');
  const at = text.indexOf(value) + 4;
  const exact = `${value.slice(4)} for access`;
  const range = { v: 1, kind: 'range', mount: 'pa', quote: { exact, prefix: text.slice(Math.max(0, at - 32), at), suffix: text.slice(at + exact.length, at + exact.length + 32) }, pos: { start: at, end: at + exact.length } };
  const hl = (await post(d.api, { type: 'highlight', anchor: range, payload: { note: `see ${value}` } }, 'highlight')).element;
  const probe = (await post(d.api, { type: 'comment', anchor: range, payload: { text: `names ${value}`, shared: true } }, 'comment')).pin;
  const node = await commit(d.api, 'before the value is learned');
  const learned = [{ id: 'learned', rule: 'known', secrets: [value] }];
  const reader = readerOf(createAudience({ configFile: null }), REQ.browser);
  assert.ok(findLeaks(JSON.stringify(build(d, node, reader)), learned).length > 0, 'precondition: the payload names the value before it is learned');
  fs.writeFileSync(projectPaths(d.root).captureToken, `${value}\n`);
  await waitUntil(() => !JSON.stringify(build(d, node, reader)).includes(value), { timeout: 6000, what: 'the redactor learned the value' });
  const p = build(d, node, reader);
  assert.equal(validatePayload(p), null, JSON.stringify(p));
  assert.deepStrictEqual(findLeaks(JSON.stringify(p), learned), [], 'no fragment of the value');
  for (const id of [hl.id, probe.id]) {
    const it = p.items.find((x) => x.id === id);
    assert.ok(it, `${id} rides`);
    assert.equal(it.state, 'masked', `${id}: served masked`);
  }
});
