// A node read's top-level `elements` below seesPrivate (U584; H.4; DECISIONS
// K.5 J2, rulings REQ@ink-privacy AD5). A committed node carries `elements`,
// the id@v strings of the live element references at its commit
// (lib/server/domain/element-refs). Those strings carry no shared flag, so
// PRIVATE_RULES cannot see them: GET /api/graph/node/:id and the node preview
// (GET /preview/node/:id, the node embedded as JSON) handed a private
// highlight's id@v to lib/client (Claude's tools) and to a remote viewer at
// every level — the residual U406a's hand-off names. routes/graph.js
// privateFor now drops, for a reader without seesPrivate, every id@v the log
// records as private and every one it cannot read (fail closed), through
// domain/elements chainPrivate's per-reference check — the one private rule.
// A local browser (audience.seesPrivate) keeps the list as committed, and the
// node file on disk is never rewritten. Red with the elements filter removed
// from privateFor.
//
// Who is who (test/private-routes.test.js's cast): a local browser is Node's
// fetch (withServer's `anonApi`, fetch metadata); lib/client sends none; a
// remote viewer is a loopback request carrying the portal's X-WC-Remote: 1 at
// the project's opt-in in the sandbox's tunnel.json.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer, tmpRoot, commentBody } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths, projectPaths } = require('../lib/core/paths');
const { putRef, refsOf, setRefs } = require('../lib/server/domain/element-refs');
const client = require('../lib/client');

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const REMOTE_BROWSER = Object.freeze({ ...REMOTE, 'Sec-Fetch-Mode': 'cors', Origin: 'https://wc.example.test' });
const RANGE = { v: 1, kind: 'range', mount: 'm1', quote: { exact: 'Hello', prefix: '', suffix: '' }, pos: { start: 0, end: 5 } };
const LOC = { mount: 'm1', selector: 'p', text: 'p', ordinal: 0 };
// An element reference the log has no record of (fail closed).
const UNREAD = 'h999@1';
// An entry element-refs keeps (a non-empty string holding an '@') that parsePin
// cannot read: no id@v at all, so it is dropped too (fail closed).
const UNPARSED = 'h998@01';

async function ok(p, what) {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text || JSON.stringify(r.body)}`);
  return r.json !== undefined ? r.json : r.body;
}
const textOf = (body) => (typeof body === 'string' ? body : JSON.stringify(body));
// An id@v of `id` anywhere in a body or a document ("h1@…", never "h10@…").
const carriesRef = (body, id) => textOf(body).includes(`"${id}@`);
const nodeFile = (root, id) => path.join(projectPaths(root).graphDir, `${id}.json`);
// The ids a preview document's element payload draws (its one data element;
// none: []).
const drawnIds = (html) => {
  const m = /<script type="application\/json" data-wc-elements>([^<]*)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]).items.map((it) => it.id) : [];
};

// Two daemons on one sandbox HOME, their remote viewers opted in at `read` and
// `full`. On each: a pane, a shared and a private highlight, a shared and a
// private comment pin, and a reference the log cannot read, committed into a
// node.
async function boot(t) {
  const roots = { read: tmpRoot('wc-u584-read-'), full: tmpRoot('wc-u584-full-') };
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, {
    ...TUNNEL, remote: { mirror: { [path.resolve(roots.read)]: 'read', [path.resolve(roots.full)]: 'full' } },
  });
  const out = {};
  let seeded = false;
  for (const level of ['read', 'full']) {
    const d = await withServer(t, { root: roots[level], ...(seeded ? {} : { seed }) });
    seeded = true;
    d.call = (p, headers) => client.request(d.port, 'GET', p, null, { headers, timeout: 10000 });
    await ok(d.api.post('/api/turn-begin', { message: 'u584 base' }), 'base turn-begin');
    await ok(d.api.post('/api/render', { id: 'm1', html: '<p>Hello</p>' }), `${level}: render`);
    d.baseId = (await ok(d.api.post('/api/turn-end', { author: 'claude', summary: 'u584 base' }), 'base turn-end')).node_id;
    assert.ok(d.baseId, `${level}: a base node was committed`);
    d.hShared = (await ok(d.anonApi.post('/api/elements', { type: 'highlight', anchor: RANGE, payload: { note: 'wc-u584-shared-hl' } }), 'shared highlight')).element.id;
    d.hPrivate = (await ok(d.anonApi.post('/api/elements', { type: 'highlight', anchor: RANGE, payload: { note: 'wc-u584-private-hl', shared: false } }), 'private highlight')).element.id;
    d.cShared = (await ok(d.anonApi.post('/api/elements', commentBody({ text: 'wc-u584-shared-pin', shared: true, anchor: LOC })), 'shared pin')).element.id;
    d.cPrivate = (await ok(d.anonApi.post('/api/elements', commentBody({ text: 'wc-u584-private-pin', shared: false, anchor: LOC })), 'private pin')).element.id;
    // A reference no version of the log answers for (a torn log, a lost
    // record): put on the live surface as element-refs puts one, so the
    // commit carries it in node.elements.
    putRef(d.srv.state, 'h999', 1);
    setRefs(d.srv.state, [...refsOf(d.srv.state), UNPARSED]);
    await ok(d.api.post('/api/turn-begin', { message: 'u584 node' }), 'turn-begin');
    d.nodeId = (await ok(d.api.post('/api/turn-end', { author: 'claude', summary: 'u584 node' }), 'turn-end')).node_id;
    assert.ok(d.nodeId, `${level}: a node was committed`);
    d.stored = fs.readFileSync(nodeFile(d.root, d.nodeId), 'utf8');
    const file = JSON.parse(d.stored);
    for (const ref of [`${d.hShared}@1`, `${d.hPrivate}@1`, UNREAD, UNPARSED]) {
      assert.ok(file.elements.includes(ref), `${level}: precondition: the node carries ${ref} (${JSON.stringify(file.elements)})`);
    }
    out[level] = d;
  }
  return out;
}

const readers = (d) => [
  ['lib/client', undefined],
  [`remote ${d.level}`, REMOTE],
  [`remote ${d.level} browser`, REMOTE_BROWSER],
];

test('GET /api/graph/node/:id: no id@v of a private highlight (nor one the log cannot read) for lib/client or a remote viewer at read and full; the local browser keeps them; a shared highlight\'s is kept for all; comments[] and lean_elements as before', async (t) => {
  const ds = await boot(t);
  for (const [level, d] of Object.entries(ds)) {
    d.level = level;
    const browser = await ok(d.anonApi.get(`/api/graph/node/${d.nodeId}`), `${level}: browser node read`);
    assert.deepStrictEqual(browser.elements, JSON.parse(d.stored).elements, `${level}: the local browser gets the node's references as committed`);
    assert.deepStrictEqual(browser.comments.map((c) => c.id).sort(), [d.cPrivate, d.cShared].sort(), `${level}: the local browser keeps both pins`);
    for (const [who, headers] of readers(d)) {
      const r = await d.call(`/api/graph/node/${d.nodeId}`, headers);
      assert.equal(r.status, 200, `${level} ${who}: ${textOf(r.body)}`);
      assert.ok(!carriesRef(r.body, d.hPrivate), `${level} ${who}: the private highlight's id@v is nowhere in the body`);
      assert.ok(!textOf(r.body).includes(`"${d.hPrivate}"`), `${level} ${who}: nor its bare id`);
      assert.ok(!textOf(r.body).includes(UNREAD), `${level} ${who}: a reference the log cannot read is dropped (fail closed)`);
      assert.ok(!textOf(r.body).includes(UNPARSED), `${level} ${who}: an entry parsePin cannot read is dropped (fail closed)`);
      assert.deepStrictEqual(r.body.elements, [`${d.hShared}@1`], `${level} ${who}: the shared highlight's id@v is kept`);
      // comments[] and lean_elements keep their own projection (dropPrivate):
      // the private pin nulled, the shared one as the local browser has it.
      const sharedPin = (body) => body.comments.find((c) => c && c.id === d.cShared);
      assert.deepStrictEqual(sharedPin(r.body), sharedPin(browser), `${level} ${who}: the shared pin as the browser gets it`);
      assert.ok(!r.body.comments.some((c) => c && c.id === d.cPrivate), `${level} ${who}: no private pin`);
      assert.deepStrictEqual(r.body.lean_elements.filter(Boolean).map((e) => e.id), [d.cShared], `${level} ${who}: lean_elements: the shared pin only`);
    }
    assert.equal(fs.readFileSync(nodeFile(d.root, d.nodeId), 'utf8'), d.stored, `${level}: the node file is never rewritten`);
  }
});

test('GET /preview/node/:id: the document holds no id@v of a private highlight (nor one the log cannot read) for lib/client or a remote viewer at read and full; the local browser\'s document unchanged', async (t) => {
  const ds = await boot(t);
  for (const [level, d] of Object.entries(ds)) {
    d.level = level;
    const bp = await d.anonApi.get(`/preview/node/${d.nodeId}`);
    assert.equal(bp.status, 200, `${level}: browser preview`);
    // U523: the document embeds no id@v any more (preview.js previewNodeJson
    // drops `elements`); what it draws rides its element payload, by id.
    for (const ref of [`${d.hShared}@1`, `${d.hPrivate}@1`, UNREAD, UNPARSED]) {
      assert.ok(!bp.text.includes(`"${ref}"`), `${level}: the local browser's document embeds no id@v (${ref})`);
    }
    const bIds = drawnIds(bp.text);
    assert.ok(bIds.includes(d.hShared) && bIds.includes(d.hPrivate), `${level}: the local browser's document draws both highlights (${bIds})`);
    assert.ok(!bIds.includes('h999') && !bIds.includes('h998'), `${level}: and never a reference the log cannot read`);
    for (const [who, headers] of readers(d)) {
      const p = await d.call(`/preview/node/${d.nodeId}`, headers);
      assert.equal(p.status, 200, `${level} ${who} preview`);
      const html = textOf(p.body);
      assert.ok(drawnIds(html).includes(d.hShared), `${level} ${who} preview: the shared highlight is drawn`);
      assert.ok(!drawnIds(html).includes(d.hPrivate) && !html.includes(`"${d.hPrivate}"`), `${level} ${who} preview: the private highlight is not, nor its bare id`);
      assert.ok(!carriesRef(html, d.hPrivate), `${level} ${who} preview: the private highlight's id@v is nowhere in the document`);
      assert.ok(!html.includes(UNREAD), `${level} ${who} preview: a reference the log cannot read is dropped (fail closed)`);
      assert.ok(!html.includes(UNPARSED), `${level} ${who} preview: an entry parsePin cannot read is dropped (fail closed)`);
    }
    assert.equal(fs.readFileSync(nodeFile(d.root, d.nodeId), 'utf8'), d.stored, `${level}: the node file is never rewritten`);
  }
});

// Read-only (the brief's step 3): the node list and the diff. GET /api/graph
// lists nodes by id, label, author and summary — no node's elements; GET
// /api/graph/diff's element section carries each entry's `shared` flag and
// PRIVATE_RULES.routes withholds a private one (an entry the log cannot read
// reads shared: false). Neither hands a private highlight's id to a reader
// without seesPrivate; the local browser's diff names it.
test('GET /api/graph and GET /api/graph/diff: no id of a private highlight for lib/client or a remote viewer at read and full; the local browser\'s diff names it', async (t) => {
  const ds = await boot(t);
  for (const [level, d] of Object.entries(ds)) {
    d.level = level;
    const diffPath = `/api/graph/diff?a=${d.baseId}&b=${d.nodeId}`;
    const local = await ok(d.anonApi.get(diffPath), `${level}: browser diff`);
    assert.ok(local.elements.added.some((e) => e && e.id === d.hPrivate), `${level}: the local browser's diff names the private highlight`);
    for (const [who, headers] of readers(d)) {
      for (const p of ['/api/graph', diffPath]) {
        const r = await d.call(p, headers);
        assert.equal(r.status, 200, `${level} ${who} ${p}: ${textOf(r.body)}`);
        assert.ok(!carriesRef(r.body, d.hPrivate) && !textOf(r.body).includes(`"${d.hPrivate}"`), `${level} ${who} ${p}: no id of the private highlight`);
        assert.ok(!textOf(r.body).includes('"h999'), `${level} ${who} ${p}: no id the log cannot read`);
      }
      const diff = (await d.call(diffPath, headers)).body;
      assert.ok(diff.elements.added.some((e) => e && e.id === d.hShared), `${level} ${who}: the diff keeps the shared highlight`);
    }
  }
});
