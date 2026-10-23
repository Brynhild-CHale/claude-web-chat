// diff_nodes' element section (annotation engine, PLAN.md 2C.5; U329; GT-20):
// lib/server/diff.js diffNodes gains `elements: {added, removed, changed,
// orphaned}` when it is handed the element store. Each side's set is its
// commit record's pins (a committed node: its comment copies' id@v and its
// element references, E-STORE a) or, for `live`, the live projection
// resolveNodeRef('live') now carries (the live pins and state.elements). A
// changed entry names its change kinds (replied, edited, shared, anchor) from
// the two versions' payloads; `orphaned` is read off U313's side table (F-SIDE
// a), never re-derived. No entry carries text, an anchor body or a payload, and
// GET /api/graph/diff withholds a private element's entries from everyone but
// a local browser (PRIVATE_RULES.routes, through graph.js's privateFor).
//
// Who is who (as test/private-routes.test.js): a local browser is Node's fetch
// (withServer's `api`, which sends sec-fetch-mode); lib/client sends no fetch
// metadata (Claude's tools); a remote viewer is a loopback request carrying
// X-WC-Remote at the project's opt-in in the sandbox's tunnel.json.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { withServer, tmpRoot, commentBody } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const { diffNodes, CHANGE_KINDS } = require('../lib/server/diff');
const { resolveNodeRef } = require('../lib/server/domain/refs');
const client = require('../lib/client');

// A box grab POSTed here is drawn by the export path's headless Chrome
// (U328b): pin the finder to no browser, so no test launches the machine's own.
process.env.WEB_CHAT_CHROME = '/nonexistent/web-chat-test/chrome';

const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});

const MARK = 'wc-u329-text-mark';
const LOCATOR = (mount) => ({ mount, selector: 'p.lead', text: 'Hello', ordinal: 0 });
const ELEMENT = (mount) => ({ v: 1, kind: 'element', mount, at: { path: [0], sib: 0 }, fp: { tag: 'p', id: '', cls: ['lead'], head: 'Hello world', attrs: [], parent: '' }, rows: [] });
const RANGE = (mount) => ({ v: 1, kind: 'range', mount, quote: { exact: 'Hello', prefix: '', suffix: '' }, pos: { start: 0, end: 5 } });
const RECT = (item) => ({ x: 1, y: 2, w: 30, h: 40, item, viewport: { w: 1200, h: 800 } });

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text || JSON.stringify(r.body)}`);
  return r.json !== undefined ? r.json : r.body;
}
async function commit(api, message = 't') {
  await ok(api.post('/api/turn-begin', { message }), 'turn-begin');
  const e = await ok(api.post('/api/turn-end', { author: 'claude', summary: message }), 'turn-end');
  assert.ok(e.node_id, `${message}: a node was committed (${JSON.stringify(e)})`);
  return e.node_id;
}
const render = (api, id) => ok(api.post('/api/render', { id, html: '<p class="lead">Hello world</p>' }), `render ${id}`);
const addComment = async (api, { text = MARK, shared = true, mount = 'm1' } = {}) => (await ok(
  api.post('/api/elements', commentBody({ text, shared, anchor: LOCATOR(mount) })), 'POST comment')).pin;
const addHighlight = async (api, mount = 'm1') => (await ok(api.post('/api/elements', {
  type: 'highlight', anchor: RANGE(mount), payload: { color: 'gold', note: MARK },
}), 'POST highlight')).element;
const addGrab = async (api, mount = 'm1') => (await ok(api.post('/api/elements', {
  type: 'box-grab', anchor: { v: 1, kind: 'page', item: mount, mount, rect: RECT(mount), viewport: { w: 1200, h: 800 } },
  payload: { rect: RECT(mount), meta: { tag: 'p' } },
}), 'POST box grab')).element;
const diffOf = async (api, a, b) => ok(api.get(`/api/graph/diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`), `diff ${a}..${b}`);
const ids = (list) => list.map((e) => e.id);
const count = (els) => els.added.length + els.removed.length + els.changed.length + els.orphaned.length;

// The real diff_nodes handler, reaching the test daemon through lib/mcp/client
// (WEB_CHAT_PORT): what Claude's tool gets.
function viaTool(t, port) {
  const prev = process.env.WEB_CHAT_PORT;
  process.env.WEB_CHAT_PORT = String(port);
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_PORT; else process.env.WEB_CHAT_PORT = prev; });
  const tool = require('../lib/mcp/tools/diff_nodes');
  return (a, b) => tool.handler({ a, b });
}

// Every key an entry may carry: ids, a type, versions, the flag, the kinds.
const ENTRY_KEYS = new Set(['id', 'type', 'v', 'shared', 'from_v', 'to_v', 'changes']);
function textFree(els, what) {
  for (const k of ['added', 'removed', 'changed', 'orphaned']) {
    for (const e of els[k]) {
      for (const key of Object.keys(e)) assert.ok(ENTRY_KEYS.has(key), `${what}: ${k} entry key ${key}`);
    }
  }
  assert.ok(!JSON.stringify(els).includes(MARK), `${what}: no entry carries text`);
}

// ── GT-20 (F5 s16): every comment-only commit has a non-empty element diff ──

test('GT-20: every comment-only commit (add, reply, edit, share toggle both ways, re-anchor, delete) reads a non-empty elements section naming the change; Claude\'s tool sees every step but the one that made the comment private', async (t) => {
  const { api, port } = await withServer(t);
  const tool = viaTool(t, port);
  await render(api, 'm1');
  const base = await commit(api, 'base');

  const steps = [];
  let parent = base;
  let pin;
  const step = async (name, fn) => {
    await fn();
    const node = await commit(api, name);
    steps.push({ name, a: parent, b: node });
    parent = node;
  };
  await step('add', async () => { pin = await addComment(api); });
  await step('reply', async () => ok(api.post(`/api/elements/${pin.id}/reply`, { text: `${MARK} reply`, author: 'user' }), 'reply'));
  await step('edit', async () => ok(api.patch(`/api/elements/${pin.id}`, { text: `${MARK} edited` }), 'edit'));
  await step('to-private', async () => ok(api.patch(`/api/elements/${pin.id}`, { shared: false }), 'to private'));
  await step('to-shared', async () => ok(api.patch(`/api/elements/${pin.id}`, { shared: true }), 'to shared'));
  await step('re-anchor', async () => ok(api.patch(`/api/elements/${pin.id}`, { anchor: ELEMENT('m1') }), 're-anchor'));
  await step('delete', async () => ok(api.del(`/api/elements/${pin.id}`), 'delete'));

  const expect = {
    add: (els) => assert.deepStrictEqual(els.added.map((e) => [e.id, e.type, e.shared]), [[pin.id, 'comment', true]]),
    reply: (els) => assert.deepStrictEqual(els.changed.map((e) => [e.id, e.changes]), [[pin.id, ['replied']]]),
    edit: (els) => assert.deepStrictEqual(els.changed.map((e) => [e.id, e.changes]), [[pin.id, ['edited']]]),
    'to-private': (els) => assert.deepStrictEqual(els.changed.map((e) => [e.id, e.changes, e.shared]), [[pin.id, ['shared'], false]]),
    'to-shared': (els) => assert.deepStrictEqual(els.changed.map((e) => [e.id, e.changes, e.shared]), [[pin.id, ['shared'], true]]),
    're-anchor': (els) => assert.deepStrictEqual(els.changed.map((e) => [e.id, e.changes]), [[pin.id, ['anchor']]]),
    delete: (els) => assert.deepStrictEqual(els.removed.map((e) => [e.id, e.type]), [[pin.id, 'comment']]),
  };
  for (const { name, a, b } of steps) {
    const local = (await diffOf(api, a, b)).elements;
    assert.ok(count(local) > 0, `${name}: a non-empty element diff for the local browser (${JSON.stringify(local)})`);
    expect[name](local);
    textFree(local, `${name} (local)`);
    const changed = local.changed[0];
    if (changed) assert.ok(changed.to_v > changed.from_v, `${name}: a newer version`);

    const claude = (await tool(a, b)).elements;
    textFree(claude, `${name} (diff_nodes)`);
    if (name === 'to-private') {
      assert.equal(count(claude), 0, 'the step that made it private is withheld from Claude');
    } else {
      assert.ok(count(claude) > 0, `${name}: a non-empty element diff for diff_nodes`);
      expect[name](claude);
    }
  }
});

// ── the other types ─────────────────────────────────────────────────────────

test('a highlight added between two nodes is in added with type highlight; a box grab removed is in removed with type box-grab; a highlight edit is edited', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'm1');
  const g = await addGrab(api);
  const n1 = await commit(api, 'grab');
  const h = await addHighlight(api);
  await ok(api.del(`/api/elements/${g.id}`), 'remove the grab');
  const n2 = await commit(api, 'highlight in, grab out');

  const d = (await diffOf(api, n1, n2)).elements;
  assert.deepStrictEqual(d.added, [{ id: h.id, type: 'highlight', v: 1, shared: true }]);
  assert.deepStrictEqual(d.removed, [{ id: g.id, type: 'box-grab', v: 1, shared: true }]);
  assert.deepStrictEqual(d.changed, []);
  assert.deepStrictEqual(d.orphaned, []);
  textFree(d, 'highlight/grab');

  await ok(api.patch(`/api/elements/${h.id}`, { payload: { color: 'green' } }), 'edit the highlight');
  const n3 = await commit(api, 'recolour');
  const e = (await diffOf(api, n2, n3)).elements;
  assert.deepStrictEqual(e.changed, [{ id: h.id, type: 'highlight', from_v: 1, to_v: 2, shared: true, changes: ['edited'] }]);
});

// ── orphaned: the side table's answer, never re-derived ─────────────────────

test('orphaned: an element the side table records orphaned on bNode is listed; with no such record, orphaned is empty; an exact answer is not orphaned', async (t) => {
  const { api, srv } = await withServer(t);
  await render(api, 'm1');
  const base = await commit(api, 'base');
  const pin = await addComment(api, { text: 'orphan me' });
  const h = await addHighlight(api);
  const node = await commit(api, 'two elements');

  assert.deepStrictEqual((await diffOf(api, base, node)).elements.orphaned, [], 'no record: orphaned is empty');

  const pins = srv.elements.pinsOf(node);
  const vOf = (id) => Number(pins.find((p) => p.startsWith(`${id}@`)).split('@')[1]);
  const item = (id, state) => ({
    id, v: vOf(id), mount: 'm1', state, gen: 1, surface: 1,
    qual: { spec: 'spec0', store: 'store0' }, source: { peer: 'local', device: 'desktop' },
  });
  srv.elements.log.appendAnswers({ node, items: [item(pin.id, 'orphaned'), item(h.id, 'exact')] });
  assert.equal(srv.sideTable.answerOf(node, pin.id, vOf(pin.id)).state, 'orphaned', 'the side table reads the record');

  const d = (await diffOf(api, base, node)).elements;
  assert.deepStrictEqual(d.orphaned, [{ id: pin.id, type: 'comment', v: vOf(pin.id), shared: true }]);
  // Read by bNode's id: the same node as `a` reports nothing orphaned on base.
  assert.deepStrictEqual((await diffOf(api, node, base)).elements.orphaned, []);
  // `live` has no recorded answers.
  assert.deepStrictEqual((await diffOf(api, node, 'live')).elements.orphaned, []);
});

// ── private: withheld from Claude and remote viewers, kept for the browser ──

test('private: a private comment\'s entries reach a local browser, not lib/client (the real diff_nodes handler) nor a remote read viewer; a shared one reaches all three', async (t) => {
  const root = tmpRoot('wc-u329-read-');
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(root)]: 'read' } } });
  const d = await withServer(t, { root, seed });
  const { api, port } = d;
  const tool = viaTool(t, port);
  await render(api, 'm1');
  const base = await commit(api, 'base');
  const shared = await addComment(api, { text: `${MARK} shared`, shared: true });
  const priv = await addComment(api, { text: `${MARK} private`, shared: false });
  const node = await commit(api, 'two pins');

  const local = (await diffOf(api, base, node)).elements;
  assert.deepStrictEqual(ids(local.added), [shared.id, priv.id], 'the local browser sees both');
  assert.equal(local.added.find((e) => e.id === priv.id).shared, false);

  const claude = (await tool(base, node)).elements;
  assert.deepStrictEqual(ids(claude.added), [shared.id], 'diff_nodes (lib/client) sees the shared one only');
  const lib = (await client.request(port, 'GET', `/api/graph/diff?a=${base}&b=${node}`, null, { timeout: 10000 })).body.elements;
  assert.deepStrictEqual(ids(lib.added), [shared.id], 'lib/client\'s raw request: the shared one only');

  const remote = await client.request(port, 'GET', `/api/graph/diff?a=${base}&b=${node}`, null, { headers: REMOTE, timeout: 10000 });
  assert.equal(remote.status, 200, JSON.stringify(remote.body));
  assert.deepStrictEqual(ids(remote.body.elements.added), [shared.id], 'a remote read viewer: the shared one only');

  // Reversed, the private one is a removal: still withheld.
  assert.deepStrictEqual(ids((await tool(node, base)).elements.removed), [shared.id]);
  assert.deepStrictEqual(ids((await diffOf(api, node, base)).elements.removed), [shared.id, priv.id]);
  for (const els of [local, claude, lib, remote.body.elements]) textFree(els, 'private');
});

// ── live: the live projection ───────────────────────────────────────────────

test('resolveNodeRef(\'live\') carries the live pins and the live references; diff_nodes(\'active\', \'live\') shows an uncommitted reply as changed: [\'replied\'] and an uncommitted highlight as added', async (t) => {
  const { api, port, srv } = await withServer(t);
  const tool = viaTool(t, port);
  await render(api, 'm1');
  const pin = await addComment(api);
  await commit(api, 'pinned');

  const h = await addHighlight(api);
  await ok(api.post(`/api/elements/${pin.id}/reply`, { text: `${MARK} live reply`, author: 'user' }), 'reply');

  const r = resolveNodeRef(srv.graph, 'live');
  assert.ok(r.ok && r.live);
  assert.deepStrictEqual(r.node.comments.map((c) => [c.id, c.v]), srv.state.comments.map((c) => [c.id, c.v]), 'the live pins');
  assert.equal(r.node.comments[0].replies.length, 1);
  assert.deepStrictEqual(r.node.elements, [`${h.id}@1`], 'the live references');

  for (const els of [(await diffOf(api, 'active', 'live')).elements, (await tool('active', 'live')).elements]) {
    assert.deepStrictEqual(els.changed.map((e) => [e.id, e.type, e.changes]), [[pin.id, 'comment', ['replied']]]);
    assert.deepStrictEqual(els.added, [{ id: h.id, type: 'highlight', v: 1, shared: true }]);
    assert.deepStrictEqual(els.removed, []);
    textFree(els, 'live');
  }
});

test('resolveNodeRef(\'live\') on a bare surface carries empty comments and elements', async (t) => {
  const { srv } = await withServer(t);
  const r = resolveNodeRef(srv.graph, 'live');
  assert.deepStrictEqual([r.node.comments, r.node.elements], [[], []]);
});

// ── diffNodes, the pure half ────────────────────────────────────────────────

// A fake element store: versions by id@v, a commit record per node.
function fakeStore({ versions = {}, pins = {}, types = {} } = {}) {
  return {
    version: (id, v) => versions[`${id}@${v}`] || null,
    typeOf: (id) => types[id] || null,
    pinsOf: (nodeId) => (Object.hasOwn(pins, nodeId) ? pins[nodeId].slice() : null),
  };
}
const cv = (payload) => ({ schema: 'comment@1', payload: { text: '', shared: true, replies: [], anchor: null, ...payload } });

test('diffNodes: no element store → no elements key, and the other sections keep their shapes', () => {
  const a = { mounts: [], store: {}, comments: [{ id: 'c1', v: 1 }] };
  const b = { mounts: [], store: {}, comments: [{ id: 'c1', v: 2 }] };
  const d = diffNodes(a, b);
  assert.ok(!('elements' in d));
  assert.deepStrictEqual(Object.keys(d), ['mounts', 'markdown', 'order', 'runs', 'store', 'theme']);
  const e = diffNodes(a, b, { elements: fakeStore() });
  assert.deepStrictEqual(Object.keys(e), ['mounts', 'markdown', 'order', 'runs', 'store', 'theme', 'elements']);
  assert.deepStrictEqual({ ...e, elements: undefined }, { ...d, elements: undefined });
});

test('diffNodes: a committed node reads its commit record; a node with none (or live) reads its copies\' v and its references; changes are named in CHANGE_KINDS order', () => {
  assert.deepStrictEqual(CHANGE_KINDS, ['replied', 'edited', 'shared', 'anchor']);
  const store = fakeStore({
    versions: {
      'c1@1': cv({ text: 'x' }),
      'c1@2': cv({ text: 'y', shared: false, replies: [{ author: 'user', text: 'r', at: 1 }], anchor: { v: 1, kind: 'element' } }),
      'h2@1': { schema: 'highlight@1', payload: { anchor: null, shared: true, color: 'gold', note: '' } },
    },
    pins: { n1: ['c1@1'] },
    types: { c1: 'comment', h2: 'highlight' },
  });
  // n1's commit record says c1@1 even though its copy (wrongly) says v 9.
  const a = { id: 'n1', comments: [{ id: 'c1', v: 9 }] };
  const live = { comments: [{ id: 'c1', v: 2 }, { id: 'c-no-v' }], elements: ['h2@1', 'not-a-pin'] };
  const d = diffNodes(a, live, { elements: store }).elements;
  assert.deepStrictEqual(d, {
    added: [{ id: 'h2', type: 'highlight', v: 1, shared: true }],
    removed: [],
    changed: [{ id: 'c1', type: 'comment', from_v: 1, to_v: 2, shared: false, changes: ['replied', 'edited', 'shared', 'anchor'] }],
    orphaned: [],
  });
  // A version the log does not hold reads private (fail closed), its changes empty.
  const lost = diffNodes({ comments: [{ id: 'c1', v: 1 }] }, { comments: [{ id: 'c1', v: 7 }] }, { elements: store }).elements;
  assert.deepStrictEqual(lost.changed, [{ id: 'c1', type: 'comment', from_v: 1, to_v: 7, shared: false, changes: [] }]);
});

test('diffNodes: orphaned reads sideTable.answersFor(bNode.id) and lists only bNode\'s elements answered orphaned at the version it carries', () => {
  const store = fakeStore({
    versions: { 'c1@1': cv({}), 'c2@1': cv({}), 'c3@1': cv({ shared: false }) },
    pins: { n2: ['c1@1', 'c2@1', 'c3@1'] },
  });
  const asked = [];
  const sideTable = {
    answersFor: (id) => {
      asked.push(id);
      return new Map([
        ['c1@1', { state: 'orphaned' }], ['c2@1', { state: 'exact' }], ['c3@1', { state: 'orphaned' }], ['c9@1', { state: 'orphaned' }],
      ]);
    },
  };
  const d = diffNodes({ comments: [] }, { id: 'n2' }, { elements: store, sideTable }).elements;
  assert.deepStrictEqual(asked, ['n2']);
  assert.deepStrictEqual(d.orphaned, [
    { id: 'c1', type: 'comment', v: 1, shared: true },
    { id: 'c3', type: 'comment', v: 1, shared: false },
  ]);
  assert.deepStrictEqual(diffNodes({}, { id: 'n2' }, { elements: store }).elements.orphaned, [], 'no side table: none');
  const throws = { answersFor: () => { throw new Error('boom'); } };
  assert.deepStrictEqual(diffNodes({}, { id: 'n2' }, { elements: store, sideTable: throws }).elements.orphaned, [], 'a side table that throws: none');
});

test('diff_nodes\' description names the elements section, its change kinds and that private elements are withheld', () => {
  const { description } = require('../lib/mcp/tools/diff_nodes');
  assert.match(description, /`elements` \(\{added, removed, changed, orphaned\}/);
  for (const k of CHANGE_KINDS) assert.ok(description.includes(`\`${k}\``), `names ${k}`);
  assert.match(description, /never text/);
  assert.match(description, /private element is withheld/);
});
