// The graph's conversation text below `read` (spec §5.2-5.3, ruling Q2; Q9 for
// a peer on a network bind): GET /api/graph, GET /api/graph/node/:id and the
// node GET /preview/node/:id embeds in its document drop exactly their
// TEXT_RULES.routes paths (lib/core/remote-policy) for a request whose level
// (ctx.audience.levelOf) is below `read`, and a local request — or one at
// `read` or `full` — gets the graph byte-identical to what it always got.
// POST /api/turn-begin's 409, which names the lock it ran into, is held to the
// same rule.
//
// The routes are mounted on a BARE Express app with a fake ctx (spec §10.1),
// over a graph whose every carrier holds a marked string: the lock's prompt and
// 0.8.5's session fields on it, each node's trigger (prompt, summary, reply,
// error), a turn folded onto a node, a node's link to the chat mirror's turns,
// and the trigger_summary a collapsed node's survivor reports in `absorbed`.
// Tranche 1's code writes none of the 0.8.5 fields yet (the lock's session
// fields, `trigger.error`, `mirror`: U30 and U44); the graph here carries them,
// so their paths are proved now.
//
// The audience is the real one (lib/server/audience) with no opt-in for the
// local, basic and network-peer cases, and a fake for `read` and `full`. A
// remote viewer is `X-WC-Remote: 1` from loopback, as the portal sends; a
// network peer is a stubbed `req.socket.remoteAddress` (the first middleware,
// as test/audience.test.js does it).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { tmpRoot } = require('../test-support/helpers');
const { projectPaths } = require('../lib/core/paths');
const { createBus } = require('../lib/core/bus');
const { TEXT_RULES } = require('../lib/core/remote-policy');
const { resolvePaths } = require('../lib/server/paths');
const { createState } = require('../lib/server/state');
const { createGraph } = require('../lib/server/graph');
const { createAudience } = require('../lib/server/audience');
const { mountGraphRoutes } = require('../lib/server/routes/graph');

const MARK = 'wc-graph-text-mark';

// ── the graph ───────────────────────────────────────────────────────────────

const PANE = (id) => ({
  id, html: `<p>${id}</p>`, target: null, params: {}, component: null, pane_state: {}, form_state: {}, theme: null, owner: null,
});

let clock = 1000;
function node(id, parent_id, extra = {}) {
  clock += 1000;
  return { id, parent_id, created_at: clock, author: 'claude', mounts: [], store: {}, comments: [], captures: [], ...extra };
}

//   n0  [a]      root
//   n1  [a]      the same surface as n0, one child: collapsed, absorbed by n2
//   n2  [a, b]   active; a failed turn with one turn folded onto it, and its
//                link to the chat mirror's turns
// plus a running turn's lock with its session fields.
function markedGraph(root) {
  const paths = resolvePaths(root);
  const graph = createGraph({ paths, state: createState(), draftPath: projectPaths(root).draft });
  clock = 1000;
  graph.registerNode(node('n0', null, {
    mounts: [PANE('a')],
    trigger: { kind: 'turn', message: `${MARK} prompt 0`, summary: `${MARK} summary 0`, reply: `${MARK} reply 0` },
  }));
  graph.registerNode(node('n1', 'n0', {
    mounts: [PANE('a')],
    trigger: { kind: 'turn', message: `${MARK} prompt 1`, summary: `${MARK} summary 1` },
  }));
  graph.registerNode(node('n2', 'n1', {
    mounts: [PANE('a'), PANE('b')],
    trigger: {
      kind: 'turn', message: `${MARK} prompt 2`, summary: `${MARK} summary 2`, reply: `${MARK} reply 2`,
      error: `${MARK} error 2`, ended: 'failed',
    },
    folded: [{
      at: 1500, author: 'claude', kind: 'turn', message: `${MARK} folded prompt`, summary: `${MARK} folded summary`,
      reply: `${MARK} folded reply`, error: `${MARK} folded error`, ended: 'failed',
    }],
    folded_count: 1,
    mirror: { v: 1, turns: [{ conversation_id: 'c1', session_id: 'sess-1', turn_id: `${MARK}-turn`, seq: 1, role: 'commit', from: 0, to: 120 }] },
  }));
  graph.active = 'n2';
  graph.lock = {
    base: 'n2', started_at: Date.now(), message: `${MARK} the running prompt`, author: 'user',
    session_id: 'sess-1', claude_pid: 4242, prompt_id: 'prm-1',
  };
  return { graph, paths };
}

// ── the host ────────────────────────────────────────────────────────────────

// A request with x-test-peer has its socket report that address while the
// routes run (they answer synchronously); the real socket is put back after.
async function graphHost(t, ctxExtra = {}) {
  const root = tmpRoot('wc-graph-text-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { graph, paths } = markedGraph(root);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const addr = req.headers['x-test-peer'];
    if (!addr) return next();
    const real = req.socket;
    req.socket = { remoteAddress: addr };
    try { next(); } finally { req.socket = real; }
  });
  const ctx = { graph, paths, bus: createBus(), broadcastReset: () => {}, ...ctxExtra };
  mountGraphRoutes(app, ctx);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const port = server.address().port;
  // A request as a local process sends it (no Origin, no Sec-Fetch-*), read
  // back as the raw text as well as the parsed body: byte-identity is a claim
  // about the text, which lib/client's request does not hand back.
  const raw = (method, p, body, headers) => new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(headers || {}) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  return { ctx, graph, port, get: (p, headers) => raw('GET', p, null, headers), post: (p, body, headers) => raw('POST', p, body, headers) };
}

// The levels, and how each is asked for. `audience` is what ctx holds for it.
const NO_OPT_IN = () => createAudience({ configFile: null });
const fakeAt = (level) => ({ levelOf: () => level, isHost: () => false });
const LEVELS = {
  local: { audience: NO_OPT_IN, headers: {} },
  remote: { audience: NO_OPT_IN, headers: { 'X-WC-Remote': '1' } }, // a project that has not opted in: basic
  network: { audience: NO_OPT_IN, headers: { 'x-test-peer': '10.0.0.7', 'X-WC-Remote': '1' } }, // basic whatever it sends (Q9)
  read: { audience: () => fakeAt('read'), headers: { 'X-WC-Remote': '1' } },
  full: { audience: () => fakeAt('full'), headers: { 'X-WC-Remote': '1' } },
};
const BELOW_READ = ['remote', 'network'];
const AT_READ_OR_MORE = ['local', 'read', 'full'];

async function getAt(h, level, p) {
  h.ctx.audience = LEVELS[level].audience();
  return h.get(p, LEVELS[level].headers);
}

// ── an independent reading of a TEXT_RULES path ─────────────────────────────
// `a.b`, `a[].b`: dot-separated keys, `[]` stepping into every element.

function segments(p) {
  return p.split('.').map((s) => (s.endsWith('[]') ? { key: s.slice(0, -2), each: true } : { key: s, each: false }));
}

// Every value the path reaches in `value`.
function valuesAt(value, p) {
  let here = [value];
  for (const { key, each } of segments(p)) {
    const next = [];
    for (const v of here) {
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, key)) continue;
      if (each) { if (Array.isArray(v[key])) next.push(...v[key]); } else next.push(v[key]);
    }
    here = next;
  }
  return here;
}

// A deep copy of `value` without what each path reaches.
function dropPaths(value, paths) {
  const copy = JSON.parse(JSON.stringify(value));
  for (const p of paths) {
    const segs = segments(p);
    const last = segs.pop();
    let here = [copy];
    for (const { key, each } of segs) {
      const next = [];
      for (const v of here) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, key)) continue;
        if (each) { if (Array.isArray(v[key])) next.push(...v[key]); } else next.push(v[key]);
      }
      here = next;
    }
    for (const v of here) if (v !== null && typeof v === 'object') delete v[last.key];
  }
  return copy;
}

const near = (text) => { const i = text.indexOf(MARK); return text.slice(Math.max(0, i - 60), i + 40); };

// ── GET /api/graph and GET /api/graph/node/:id ──────────────────────────────

for (const [route, url] of [['GET /api/graph', '/api/graph'], ['GET /api/graph/node/:id', '/api/graph/node/n2']]) {
  test(`${route}: below read it drops exactly its TEXT_RULES paths; local, read and full get it byte-identical`, async (t) => {
    const h = await graphHost(t);
    const paths = TEXT_RULES.routes[route];
    assert.ok(Array.isArray(paths) && paths.length, `TEXT_RULES.routes has an entry for ${route}`);

    const local = await getAt(h, 'local', url);
    assert.equal(local.status, 200);
    // The fixture is live: every path the rule names reaches a value in the
    // local body, and the local body carries the conversation text.
    for (const p of paths) assert.ok(valuesAt(local.json, p).length > 0, `${route}: the local body has ${p}`);
    assert.ok(local.text.includes(MARK));

    // Never projected at local, read or full: the same bytes every time.
    for (const level of AT_READ_OR_MORE) {
      const r = await getAt(h, level, url);
      assert.equal(r.status, 200, level);
      assert.equal(r.text, local.text, `${level}: byte-identical to the local body`);
    }
    // And the same bytes before the server hands over an audience at all: a
    // loopback request without the portal's label is local.
    h.ctx.audience = undefined;
    assert.equal((await h.get(url)).text, local.text, 'no audience on ctx: a local request is still local');

    // Below read: exactly those paths gone, nothing else touched, no text left.
    for (const level of BELOW_READ) {
      const r = await getAt(h, level, url);
      assert.equal(r.status, 200, level);
      assert.deepStrictEqual(r.json, dropPaths(local.json, paths), `${level}: the local body without exactly ${paths.join(', ')}`);
      assert.ok(!r.text.includes(MARK), `${level}: no conversation text left: …${near(r.text)}…`);
    }
    // Before the server hands over an audience, the portal's label is a remote
    // viewer with no opt-in — basic: narrower, never wider.
    h.ctx.audience = undefined;
    const unwired = await h.get(url, { 'X-WC-Remote': '1' });
    assert.deepStrictEqual(unwired.json, dropPaths(local.json, paths), 'no audience on ctx: the portal\'s label is basic');
    // A level that cannot be read is basic too.
    h.ctx.audience = { levelOf: () => { throw new Error('boom'); }, isHost: () => false };
    assert.deepStrictEqual((await h.get(url)).json, dropPaths(local.json, paths), 'an audience that throws: basic');
    h.ctx.audience = fakeAt('no-such-level');
    assert.deepStrictEqual((await h.get(url)).json, dropPaths(local.json, paths), 'a level that is not one: basic');
  });
}

test('GET /api/graph below read: the surface stays — labels, times, authors, the collapse, the lock\'s own state', async (t) => {
  const h = await graphHost(t);
  const local = (await getAt(h, 'local', '/api/graph')).json;
  const basic = (await getAt(h, 'remote', '/api/graph')).json;
  assert.deepStrictEqual(local.lock, h.graph.lock && { ...h.graph.lock, stale: false }, 'a local request gets the lock whole');
  assert.deepStrictEqual(basic.lock, { base: 'n2', started_at: h.graph.lock.started_at, author: 'user', stale: false },
    'below read: no prompt, no session fields — but a turn is still seen running');
  const byId = (body) => new Map(body.nodes.map((n) => [n.id, n]));
  const [l, b] = [byId(local), byId(basic)];
  assert.deepStrictEqual([...b.keys()], ['n0', 'n1', 'n2']);
  for (const id of ['n0', 'n1', 'n2']) {
    assert.ok(l.get(id).trigger_summary.includes(MARK), `${id}: the local topology names the prompt`);
    assert.equal(b.get(id).trigger_summary, undefined, `${id}: below read it does not`);
    for (const k of ['label', 'created_at', 'author', 'parent_id', 'display_parent', 'folded_count']) {
      assert.deepStrictEqual(b.get(id)[k], l.get(id)[k], `${id}.${k} stays`);
    }
  }
  assert.equal(b.get('n1').collapsed, true);
  assert.deepStrictEqual(b.get('n2').absorbed.map((a) => [a.id, a.label]), [['n1', l.get('n1').label]], 'the collapse stays, its text does not');
  assert.equal(b.get('n2').absorbed[0].trigger_summary, undefined);
  for (const k of ['active', 'active_label', 'collapsed_count', 'pending_folded', 'pending_reaim', 'pending_bookmark']) {
    assert.deepStrictEqual(basic[k], local[k], `${k} stays`);
  }
});

test('GET /api/graph/node/:id below read: the node\'s page and its turn\'s outcome stay; a missing node is still a 404', async (t) => {
  const h = await graphHost(t);
  const local = await getAt(h, 'local', '/api/graph/node/n2');
  // Byte-identical to the node as it is stored, with its label: 0.8.0's body.
  const stored = h.graph.nodes.get('n2');
  assert.equal(local.text, JSON.stringify({ ...stored, label: local.json.label }), 'the local body is the stored node and its label');
  const basic = (await getAt(h, 'network', '/api/graph/node/n2')).json;
  assert.deepStrictEqual(basic.mounts, stored.mounts, 'the page stays');
  assert.deepStrictEqual(basic.trigger, { kind: 'turn', ended: 'failed' }, 'the trigger keeps its kind and outcome');
  assert.deepStrictEqual(basic.folded, [{ at: 1500, author: 'claude', kind: 'turn', ended: 'failed' }]);
  assert.equal(basic.folded_count, 1);
  assert.equal(basic.mirror, undefined, 'no link to the conversation\'s turns');
  assert.equal(stored.trigger.message, `${MARK} prompt 2`, 'the stored node is untouched');
  for (const level of ['local', 'remote']) {
    const miss = await getAt(h, level, '/api/graph/node/n9');
    assert.deepStrictEqual([miss.status, miss.json], [404, { error: 'not found' }], level);
  }
});

// ── GET /preview/node/:id ───────────────────────────────────────────────────

test('GET /preview/node/:id below read embeds the node without its conversation text; local, read and full are unchanged', async (t) => {
  const h = await graphHost(t);
  const local = await getAt(h, 'local', '/preview/node/n2');
  assert.equal(local.status, 200);
  assert.ok(local.text.includes(`${MARK} prompt 2`), 'the document embeds the node it is handed — locally, the whole of it');
  assert.ok(local.text.includes(`${MARK} folded reply`));
  for (const level of AT_READ_OR_MORE) assert.equal((await getAt(h, level, '/preview/node/n2')).text, local.text, level);
  for (const level of BELOW_READ) {
    const r = await getAt(h, level, '/preview/node/n2');
    assert.equal(r.status, 200, level);
    assert.ok(!r.text.includes(MARK), `${level}: …${near(r.text)}…`);
    // The node rides the document as JSON with every `<` escaped
    // (lib/server/preview previewNodeJson): its panes are still there to draw.
    assert.ok(r.text.includes('\\u003cp>b\\u003c/p>'), `${level}: the page itself is still drawn`);
  }
  assert.equal((await getAt(h, 'remote', '/preview/node/n9')).status, 404);
});

// ── POST /api/turn-begin's 409 ──────────────────────────────────────────────

test('POST /api/turn-begin: the 409 names the held lock whole locally, and without its text below read', async (t) => {
  const h = await graphHost(t);
  const held = { ...h.graph.lock };
  const local = await getAt(h, 'local', '/api/graph'); // the lock as it stands
  assert.equal(local.json.lock.message, held.message);

  h.ctx.audience = NO_OPT_IN();
  const page = await h.post('/api/turn-begin', { message: 'another prompt' });
  assert.equal(page.status, 409);
  assert.deepStrictEqual(page.json, { error: 'already locked', lock: held }, 'a local caller gets 0.8.0\'s refusal');
  for (const level of BELOW_READ) {
    h.ctx.audience = LEVELS[level].audience();
    const r = await h.post('/api/turn-begin', { message: 'another prompt' }, LEVELS[level].headers);
    assert.equal(r.status, 409, level);
    assert.deepStrictEqual(r.json, { error: 'already locked', lock: { base: 'n2', started_at: held.started_at, author: 'user' } }, level);
  }
  assert.deepStrictEqual(h.graph.lock, held, 'nobody took or changed the lock');
});
