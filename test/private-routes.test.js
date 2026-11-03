// 'Private' enforced at the routes (PLAN.md 1B.3, decision A2; U213): a
// private pin (`shared === false`) is hidden from Claude's tools and from every
// remote viewer; a local browser on this machine sees it; there is no viewer
// identity. lib/server/audience seesPrivate(req) is the one test — a local
// level AND browser fetch metadata — and every route that serves pins or a
// whole node drops them through lib/core/remote-policy's PRIVATE_RULES.routes
// (dropPrivate) when it answers false. The `comments` frame's half is U211's
// (projectFrame); this file proves the routes, the queue carrier (stripItemText
// in queue.list and GET /api/queue/pending), S-11's shape end to end, a census
// ratchet over lib/server/routes, and the chrome's 403 read.
//
// Who is who. A local browser is Node's `fetch` (withServer's `api`): it sends
// `sec-fetch-mode: cors`, as a browser does. lib/client (Claude's MCP tools, the
// hooks, the CLI) sends no fetch metadata. A remote viewer is a loopback
// request carrying the portal's `X-WC-Remote: 1`, at the project's opt-in in
// the sandbox's tunnel.json; a network peer is a request whose socket's
// remoteAddress is stubbed before the app sees it (test/comments-remote's).
//
// Residuals A2 leaves outside its boundary (the MCP tools and remote viewers),
// stated in lib/server/audience.js: the committed node files on disk
// (.web-chat/graph/*.json) still carry private pins, and a local process that
// forges an Origin header passes the browser test. Neither is a tool path.

const test = require('node:test');
const { describe, before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withServer, tmpRoot, waitUntil, commentBody } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const { PRIVATE_RULES } = require('../lib/core/remote-policy');
const client = require('../lib/client');

const REPO_ROOT = path.resolve(__dirname, '..');

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const PEER = Object.freeze({ 'x-test-peer': '10.0.0.5' });

const SHARED = 'wc-u213-shared-mark';
const PRIVATE = 'wc-u213-private-mark';
const PUSH_NOTE = 'wc-u401-parked-push-note';

// Requests (and upgrades) carrying x-test-peer arrive from that address.
function stubPeers(server) {
  const onRequest = (req, res) => {
    const addr = req.headers['x-test-peer'];
    if (!addr) return;
    Object.defineProperty(req.socket, 'remoteAddress', { value: addr, configurable: true });
    res.once('close', () => { delete req.socket.remoteAddress; });
  };
  const onUpgrade = (req) => {
    const addr = req.headers['x-test-peer'];
    if (addr) Object.defineProperty(req.socket, 'remoteAddress', { value: addr, configurable: true });
  };
  server.prependListener('request', onRequest);
  server.prependListener('upgrade', onUpgrade);
  return () => { server.off('request', onRequest); server.off('upgrade', onUpgrade); };
}

// Three daemons on one sandbox HOME, their remote viewers opted in at nothing
// (basic), `read` and `full`. Each gets `call` (lib/client's raw request: no
// fetch metadata) and the network-peer stub.
async function boot(t, levels = ['basic', 'read', 'full']) {
  const roots = { read: tmpRoot('wc-pr-read-'), full: tmpRoot('wc-pr-full-') };
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, {
    ...TUNNEL, remote: { mirror: { [path.resolve(roots.read)]: 'read', [path.resolve(roots.full)]: 'full' } },
  });
  const out = {};
  let seeded = false;
  for (const level of levels) {
    const opts = level === 'basic' ? {} : { root: roots[level] };
    if (!seeded) { opts.seed = seed; seeded = true; }
    const d = await withServer(t, opts);
    t.after(stubPeers(d.server));
    d.call = (method, p, body, headers) => client.request(d.port, method, p, body, { headers, timeout: 10000 });
    out[level] = d;
  }
  return out;
}

async function ok(p, what) {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text || JSON.stringify(r.body)}`);
  return r.json !== undefined ? r.json : r.body;
}

// One shared and one private pin on pane `m1`, made as the chrome makes them.
async function twoPins(api, { shared = SHARED, priv = PRIVATE, mount = 'm1' } = {}) {
  await ok(api.post('/api/render', { id: mount, html: `<p class="x">${mount}</p>` }), `render ${mount}`);
  const a = await ok(api.post('/api/elements', commentBody({ text: shared, shared: true, anchor: { mount, selector: 'p.x', text: mount, ordinal: 0 } })), 'shared pin');
  const b = await ok(api.post('/api/elements', commentBody({ text: priv, shared: false, anchor: { mount, selector: 'p.x', text: mount, ordinal: 0 } })), 'private pin');
  return { shared: a.pin.id, priv: b.pin.id };
}

async function commit(api, message) {
  await ok(api.post('/api/turn-begin', { message }), 'turn-begin');
  const e = await ok(api.post('/api/turn-end', { author: 'claude', summary: message }), 'turn-end');
  assert.ok(e.node_id, `a node was committed: ${JSON.stringify(e)}`);
  return e.node_id;
}

const texts = (body) => body.elements.map((c) => c.text);
const has = (body, mark) => (typeof body === 'string' ? body : JSON.stringify(body)).includes(mark);

// ── GET /api/elements?type=comment (U327a: /api/comments replaced) ──────────

test('GET /api/elements?type=comment: a local browser gets the private pin; lib/client, a remote viewer at read and full, and shared_only do not; basic is 403; next_cursor is the same for all', async (t) => {
  const d = await boot(t);
  for (const level of ['basic', 'read', 'full']) await twoPins(d[level].api);

  const cursors = [];
  for (const level of ['basic', 'read', 'full']) {
    const { api, port, call } = d[level];
    const browser = await ok(api.get('/api/elements?type=comment'), `${level}: browser`);
    assert.deepStrictEqual(texts(browser), [SHARED, PRIVATE], `${level}: a local browser (Node fetch) sees both`);
    cursors.push(browser.next_cursor);

    const tool = await client.get('/api/elements?type=comment', { port, noSpawn: true });
    assert.deepStrictEqual(texts(tool), [SHARED], `${level}: lib/client (no fetch metadata) sees the shared pin only`);
    assert.ok(!has(tool, PRIVATE));
    cursors.push(tool.next_cursor);

    const sharedOnly = await ok(api.get('/api/elements?type=comment&shared_only=1'), `${level}: shared_only`);
    assert.deepStrictEqual(texts(sharedOnly), [SHARED], `${level}: shared_only from the browser`);
    cursors.push(sharedOnly.next_cursor);

    const remote = await call('GET', '/api/elements?type=comment', null, REMOTE);
    if (level === 'basic') {
      assert.equal(remote.status, 403, 'remote basic: U211\'s requireMirror');
      assert.ok(!has(remote.body, PRIVATE) && !has(remote.body, SHARED));
    } else {
      assert.equal(remote.status, 200, `${level}: ${JSON.stringify(remote.body)}`);
      assert.deepStrictEqual(texts(remote.body), [SHARED], `remote ${level}: the shared pin only`);
      cursors.push(remote.body.next_cursor);
      // A remote viewer's browser sends fetch metadata too: still not local.
      const remoteBrowser = await call('GET', '/api/elements?type=comment', null, { ...REMOTE, 'Sec-Fetch-Mode': 'cors', Origin: 'https://wc.example.test' });
      assert.deepStrictEqual(texts(remoteBrowser.body), [SHARED], `remote ${level} browser: the shared pin only`);
    }

    const peer = await call('GET', '/api/elements?type=comment', null, { ...PEER, 'Sec-Fetch-Mode': 'cors' });
    assert.equal(peer.status, 403, `${level}: a network peer`);
    assert.ok(!has(peer.body, PRIVATE));
  }
  assert.ok(cursors.length >= 11);
  assert.ok(cursors.every((c) => c === 2), `next_cursor is the max seq over every pin, for every caller: ${cursors}`);
});

// ── the node read and the node preview ──────────────────────────────────────

test('GET /api/graph/node/:id and GET /preview/node/:id: a local browser gets the private pin; lib/client and a remote viewer do not; below read the text strip composes', async (t) => {
  const d = await boot(t, ['basic', 'read']);
  const PROMPT = 'wc-u213-prompt-mark';
  for (const level of ['basic', 'read']) {
    const { api, call } = d[level];
    await twoPins(api);
    const id = await commit(api, PROMPT);
    for (const route of [`/api/graph/node/${id}`, `/preview/node/${id}`]) {
      const browser = await api.get(route);
      assert.equal(browser.status, 200);
      assert.ok(browser.text.includes(PRIVATE), `${level} ${route}: a local browser gets the private pin`);
      assert.ok(browser.text.includes(SHARED) && browser.text.includes(PROMPT), `${level} ${route}: and everything else`);

      const local = await call('GET', route);
      assert.equal(local.status, 200);
      assert.ok(!has(local.body, PRIVATE), `${level} ${route}: lib/client gets no private pin`);
      assert.ok(has(local.body, SHARED) && has(local.body, PROMPT), `${level} ${route}: lib/client is local: the shared pin and the prompt stay`);

      const remote = await call('GET', route, null, REMOTE);
      assert.equal(remote.status, 200);
      assert.ok(!has(remote.body, PRIVATE), `remote ${level} ${route}: no private pin`);
      // Below read the node's element rows go whole, the shared pin's too
      // (K.2-117: every anchor carries pane text; test/remote-policy-text-routes).
      assert.equal(has(remote.body, SHARED), level !== 'basic',
        `remote ${level} ${route}: the shared pin ${level === 'basic' ? 'goes with the element rows (TEXT_RULES)' : 'stays at read'}`);
      assert.equal(has(remote.body, PROMPT), level !== 'basic',
        `remote ${level} ${route}: the conversation text ${level === 'basic' ? 'is stripped (TEXT_RULES) as well' : 'stays at read'}`);

      const peer = await call('GET', route, null, { ...PEER, 'Sec-Fetch-Mode': 'cors' });
      assert.equal(peer.status, 200);
      assert.ok(!has(peer.body, PRIVATE) && !has(peer.body, PROMPT), `${level} ${route}: a network peer gets neither`);
    }
    // The node read's JSON: the pin list itself, not just the absence of a string.
    const remote = (await call('GET', `/api/graph/node/${id}`, null, REMOTE)).body;
    if (level === 'basic') assert.equal('comments' in remote, false, 'basic: no pin list at all (K.2-117)');
    else assert.deepStrictEqual(remote.comments.map((c) => c.text), [SHARED]);
    assert.deepStrictEqual((await api.get(`/api/graph/node/${id}`)).json.comments.map((c) => c.text), [SHARED, PRIVATE]);
  }
});

// graph.js's privateFor fails closed: an audience with no seesPrivate (a
// test's fake, a half-wired ctx) or one whose seesPrivate throws hides the
// private pin even from a request that reads as a local browser. The routes
// on a bare app over one registered node, read with Node's fetch (browser
// fetch metadata), so only the audience decides.
test('the node read and the node preview fail closed: no seesPrivate, or one that throws, sees no private pin', async (t) => {
  const http = require('http');
  const express = require('express');
  const { resolvePaths } = require('../lib/server/paths');
  const { createState } = require('../lib/server/state');
  const { createGraph } = require('../lib/server/graph');
  const { createBus } = require('../lib/core/bus');
  const { projectPaths } = require('../lib/core/paths');
  const { createAudience } = require('../lib/server/audience');
  const { mountGraphRoutes } = require('../lib/server/routes/graph');

  const root = tmpRoot('wc-pr-closed-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolvePaths(root);
  const graph = createGraph({ paths, state: createState(), draftPath: projectPaths(root).draft });
  const pin = (id, text, shared) => ({ id, seq: Number(id.slice(1)), created_at: 1, shared, text, anchor: { mount: 'a', selector: 'p', text: 'a', ordinal: 0 } });
  graph.registerNode({
    id: 'n0', parent_id: null, created_at: 1000, author: 'claude', store: {}, captures: [],
    mounts: [{ id: 'a', html: '<p>a</p>', target: null, params: {}, component: null, pane_state: {}, form_state: {}, theme: null, owner: null }],
    comments: [pin('c1', SHARED, true), pin('c2', PRIVATE, false)],
  });
  graph.active = 'n0';
  const ctx = { graph, paths, bus: createBus(), broadcastReset: () => {} };
  const app = express();
  app.use(express.json());
  mountGraphRoutes(app, ctx);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = async (p) => (await fetch(base + p)).text();

  const cases = [
    ['the real audience (control)', () => createAudience({ configFile: null }), true],
    ['no audience yet (the no-opt-in fallback is a real audience)', () => undefined, true],
    ['a fake with no seesPrivate', () => ({ levelOf: () => 'local', isHost: () => false }), false],
    ['a seesPrivate that throws', () => ({ levelOf: () => 'local', seesPrivate: () => { throw new Error('boom'); } }), false],
    ['a seesPrivate that answers a non-boolean', () => ({ levelOf: () => 'local', seesPrivate: () => 'yes' }), false],
  ];
  for (const [what, audience, sees] of cases) {
    ctx.audience = audience();
    for (const route of ['/api/graph/node/n0', '/preview/node/n0']) {
      const text = await read(route);
      assert.ok(text.includes(SHARED), `${what} ${route}: the shared pin stays`);
      assert.equal(text.includes(PRIVATE), sees, `${what} ${route}: the private pin ${sees ? 'is seen' : 'is not'}`);
    }
  }
});

// ── the queue carrier ───────────────────────────────────────────────────────

async function socket(t, port, headers) {
  const ws = new (require('ws'))(`ws://localhost:${port}/ws`, headers ? { headers } : undefined);
  t.after(() => { try { ws.terminate(); } catch {} });
  const raw = [];
  ws.on('message', (m) => raw.push(m.toString()));
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await waitUntil(() => raw.some((s) => s.includes('"type":"hello"')), { timeout: 10000, interval: 5, what: 'the hello' });
  return { ws, raw };
}

// Renders a throwaway pane and waits until every socket has its frame: frames
// arrive in order, so what a socket lacks by then was never sent to it.
let settleSeq = 0;
async function settle(api, sockets) {
  const id = `u213-settle-${++settleSeq}`;
  await ok(api.post('/api/render', { id, html: '<i>s</i>' }), 'settle render');
  await waitUntil(() => sockets.every((s) => s.raw.some((f) => f.includes(id))), { timeout: 15000, interval: 5, what: `${id} on every socket` });
}

test('the queue: below read a comment item\'s quote is the text-free label on GET /api/queue, GET /api/queue/pending and the queue frame; a capture and a message item are unchanged', async (t) => {
  const d = await boot(t, ['basic', 'read']);
  const QUOTE = 'wc-u213-queue-quote';
  const MSG = 'wc-u213-message-words';
  for (const level of ['basic', 'read']) {
    const { api, call, port } = d[level];
    const local = await socket(t, port);
    const remoteWs = await socket(t, port, REMOTE);

    await ok(api.post('/api/render', { id: 'm1', html: '<p class="x">m1</p>' }), 'render');
    await ok(api.post('/api/elements', commentBody({ text: QUOTE, shared: true, anchor: { mount: 'm1', selector: 'p.x', text: 'm1', ordinal: 0 } })), 'pin');
    await ok(api.post('/api/capture', { url: 'https://example.com/page', title: 'Ex', html: '<html><body><p>captured</p></body></html>' }), 'capture');
    const m = await ok(api.post('/api/queue/message', { text: MSG, send: 'hold' }), 'message');
    assert.equal(m.ok, true, JSON.stringify(m));

    const mine = (await ok(api.get('/api/queue'), 'local queue')).items;
    const theirs = (await call('GET', '/api/queue', null, REMOTE)).body.items;
    // U423: a shared pin's item is the comment's element group (kind 'element', type 'comment').
    const byKind = (items, kind) => items.filter((it) => (kind === 'comment' ? it.kind === 'element' && it.type === 'comment' : it.kind === kind));
    assert.equal(byKind(mine, 'comment').length, 1, JSON.stringify(mine));
    assert.ok(byKind(mine, 'comment')[0].summary.includes(QUOTE), 'local: the quote');
    const c = byKind(theirs, 'comment')[0];
    if (level === 'basic') {
      assert.equal(c.summary, 'm1 · comment', 'K.2-163: the type names the label');
      assert.equal(c.text_hidden, true);
      assert.ok(!has(theirs, QUOTE), 'remote basic: no quote anywhere on GET /api/queue');
    } else {
      assert.deepStrictEqual(c, byKind(mine, 'comment')[0], 'remote read: the item itself');
    }
    assert.deepStrictEqual(byKind(theirs, 'capture'), byKind(mine, 'capture'), `${level}: a capture item is unchanged`);
    assert.equal(byKind(mine, 'capture').length, 1);
    const msgMine = mine.find((it) => has(it, MSG));
    assert.ok(msgMine, 'local: the message item carries its words');
    const msgTheirs = theirs.find((it) => it.id === msgMine.id);
    assert.ok(msgTheirs);
    if (level === 'basic') {
      assert.equal(msgTheirs.text_hidden, true, 'a message item below read: its publicItem (C34), as before');
      assert.ok(!has(msgTheirs, MSG));
    } else {
      assert.deepStrictEqual(msgTheirs, msgMine, 'remote read: the message item whole, as before');
    }

    // Push → parked (no channel), with a Push note: GET /api/queue/pending's
    // items rows, and the park's note (J1, K1, U401).
    const push = await ok(api.post('/api/queue/push', { note: PUSH_NOTE }), 'push');
    assert.equal(push.mode, 'parked', JSON.stringify(push));
    const pMine = (await ok(api.get('/api/queue/pending'), 'local pending')).pending;
    const pTheirs = (await call('GET', '/api/queue/pending', null, REMOTE)).body.pending;
    const rowMine = pMine.items.find((it) => it.type === 'comment');
    const rowTheirs = pTheirs.items.find((it) => it.type === 'comment');
    assert.ok(rowMine && rowMine.summary.includes(QUOTE), `local pending: the quote (${JSON.stringify(pMine.items)})`);
    assert.ok(!('text_hidden' in rowMine));
    if (level === 'basic') {
      assert.equal(rowTheirs.summary, 'm1 · comment', 'K.2-163: the type names the label');
      assert.equal(rowTheirs.text_hidden, true);
      assert.ok(!has(pTheirs, QUOTE), 'remote basic: no quote anywhere in the parked delivery');
    } else {
      assert.deepStrictEqual(rowTheirs, rowMine, 'remote read: the row itself');
    }
    // The Push note is the user's own text: the local read (the turn-begin
    // hook's path) and a remote read get it byte-equal; below read it is null,
    // the park says note_hidden, and it is nowhere in the body.
    assert.strictEqual(pMine.note, PUSH_NOTE, 'local pending: the Push note');
    assert.ok(!('note_hidden' in pMine), 'local pending: no note_hidden');
    assert.ok(has(pMine.envelope, PUSH_NOTE), 'local pending: the envelope Claude gets carries the note');
    if (level === 'basic') {
      assert.strictEqual(pTheirs.note, null, 'remote basic: the park\'s note is null');
      assert.equal(pTheirs.note_hidden, true, 'remote basic: note_hidden');
      assert.ok(!has(pTheirs, PUSH_NOTE), 'remote basic: the Push note nowhere in the parked delivery, envelope included');
      const pPeer = (await call('GET', '/api/queue/pending', null, PEER)).body.pending;
      assert.strictEqual(pPeer.note, null, 'a network peer: the park\'s note is null');
      assert.equal(pPeer.note_hidden, true, 'a network peer: note_hidden');
      assert.ok(!has(pPeer, PUSH_NOTE), 'a network peer: the Push note nowhere');
    } else {
      assert.strictEqual(pTheirs.note, PUSH_NOTE, 'remote read: the Push note byte-equal');
      assert.ok(!('note_hidden' in pTheirs), 'remote read: no note_hidden');
    }
    const capMine = pMine.items.filter((it) => it.kind === 'capture');
    assert.deepStrictEqual(pTheirs.items.filter((it) => it.kind === 'capture'), capMine, `${level}: a parked capture row is unchanged`);
    assert.equal(capMine.length, 1);

    // The `queue` frame (U211's row): the remote socket never got the quote below read.
    await settle(api, [local, remoteWs]);
    assert.ok(local.raw.some((f) => f.includes(QUOTE)), 'the local socket got the quote');
    assert.equal(remoteWs.raw.some((f) => f.includes(QUOTE)), level !== 'basic', `remote ${level} socket`);
  }
});

// ── S-11's shape, as a unit test ────────────────────────────────────────────

test('S-11: after two committed turns, each adding a private pin, no remote-basic socket or read, network peer or Claude tool returns the private text; the local browser does', async (t) => {
  const { basic: d } = await boot(t, ['basic']);
  const { api, call, port } = d;
  const MARK = 'wc-u213-s11-private';
  const local = await socket(t, port);
  const remoteWs = await socket(t, port, REMOTE);
  const peerWs = await socket(t, port, { ...PEER });

  const ids = [];
  for (const n of [1, 2]) {
    const pins = await twoPins(api, { shared: `wc-u213-s11-shared-${n}`, priv: `${MARK}-${n}`, mount: `s11-${n}` });
    await ok(api.post(`/api/elements/${pins.priv}/reply`, { text: `${MARK}-reply-${n}` }), 'a reply on the private pin');
    ids.push(await commit(api, `s11 turn ${n}`));
  }
  await settle(api, [local, remoteWs, peerWs]);

  const leaks = [];
  const check = (who, body) => { if (has(body, MARK)) leaks.push(who); };
  check('remote basic socket', remoteWs.raw.join('\n'));
  check('network peer socket', peerWs.raw.join('\n'));

  const reads = [
    '/api/elements?type=comment', '/api/elements?type=comment&shared_only=1', '/api/graph', '/api/mounts', '/api/store', '/api/events',
    '/api/queue', '/api/queue/pending', `/api/graph/diff?a=${ids[0]}&b=${ids[1]}`, '/api/export?node=active',
    ...ids.flatMap((id) => [`/api/graph/node/${id}`, `/preview/node/${id}`]),
  ];
  for (const r of reads) {
    check(`remote basic GET ${r}`, (await call('GET', r, null, REMOTE)).body);
    check(`network peer GET ${r}`, (await call('GET', r, null, { ...PEER, 'Sec-Fetch-Mode': 'cors' })).body);
    check(`lib/client GET ${r}`, (await call('GET', r)).body);
  }

  // Claude through its MCP tools (lib/mcp/client → lib/client, WEB_CHAT_PORT).
  const prev = process.env.WEB_CHAT_PORT;
  process.env.WEB_CHAT_PORT = String(port);
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_PORT; else process.env.WEB_CHAT_PORT = prev; });
  const tool = (name) => require(`../lib/mcp/tools/${name}`);
  check('get_comments', await tool('get_comments').handler({}));
  check('get_events', await tool('get_events').handler({}));
  check('list_mounts', await tool('list_mounts').handler());
  check('get_graph', await tool('get_graph').handler());
  check('get_active', await tool('get_active').handler({}));
  check('diff_nodes', await tool('diff_nodes').handler({ a: ids[0], b: ids[1] }));
  for (const node of [ids[0], ids[1]]) {
    const r = await tool('export').handler({ node });
    assert.ok(r.ok && r.path, JSON.stringify(r));
    check(`export ${node}`, fs.readFileSync(r.path, 'utf8'));
  }
  assert.deepStrictEqual(leaks, [], 'the private text reached these');

  // The local browser does see it: live, in each node, and on its socket.
  assert.ok(has((await api.get('/api/elements?type=comment')).json, `${MARK}-2`));
  for (const [i, id] of ids.entries()) {
    assert.ok(has((await api.get(`/api/graph/node/${id}`)).json, `${MARK}-${i + 1}`), `node ${id}: the local browser`);
    assert.ok((await api.get(`/preview/node/${id}`)).text.includes(`${MARK}-${i + 1}`), `preview ${id}: the local browser`);
  }
  assert.ok(local.raw.some((f) => f.includes(`${MARK}-1`)), 'the local socket got the element:comment frame whole');
});

// ── the census ratchet ──────────────────────────────────────────────────────
// Every `.comments` read, and every whole-node body (a `node` handed whole to
// res.json / .send / renderNodePreview), in lib/server/routes/*.js sits either
// in a GET route PRIVATE_RULES.routes keys — whose handler applies dropPrivate
// (or graph.js's privateFor over it) — in a frame PRIVATE_RULES.frames keys, or
// in a place reviewed below as not serving private pins. Every GET counts, not
// only those a remote viewer may reach: a host-only GET is lib/client's, which
// is Claude's tools' transport, and A2 hides private pins from them too.

// Reviewed: 'file carrier' → why it does not serve a private pin to anyone
// but a local browser.
const REVIEWED = new Map([
  // The element API (U325, routes/elements.js): the comment's writes (moved
  // from routes/comments.js, which answers only its 410 since U327a), every type.
  ['elements.js fn:find', 'finds the element a write names (a pin or a reference) for the write routes to gate; never serves'],
  ['elements.js fn:memberOn', 'the chain label (F.6, U406): reads a node copy\'s shared flag for a chain member, never serves the pin; a member private now reads "a private element" to anyone who does not see private records'],
  ['elements.js POST /api/elements', 'a write: answers the element it just made, to its maker'],
  ['elements.js fn:editOf', 'the one edit PATCH and POST /api/elements/:id/send call (F.5, U405): writes the pin it found by id back into state.comments; it answers that pin only to those two routes, each gated first — a private element answers 404 to anyone but a local browser (C-16-2)'],
  ['elements.js PATCH /api/elements/:id', 'a write (edit, re-anchor): answers the element it found by id — gated: a private element answers 404 to anyone but a local browser (C-16-2)'],
  ['elements.js POST /api/elements/:id/reply', 'a write (reply): answers the pin it found by id — gated: a private pin answers 404 to anyone but a local browser (C-16-2)'],
  ['graph.js fn:privateFor', 'the node reads\' private filter (U406a, Q8 a): reads the body\'s comments[] only to name each chained copy\'s private members (domain/elements chainPrivate) for dropPrivate to null; it serves nothing itself — its callers are the PRIVATE_RULES.routes handlers'],
  ['graph.js fn:execWipe', 'deletes the pins whose item is gone (deleteComment); never serves'],
  ['graph.js fn:execNewGraph', 'deletes every pin (deleteComment); never serves'],
]);

// The document routes U521 keyed in PRIVATE_RULES.routes (their element
// payload's `doc_elements.items[]`, applied by lib/server/document-elements.js
// documentElements through readerOf) before their owners wire them: each may
// be keyed but not found, or found with no projection, until its owner's
// unit lands. An entry whose route now passes is stale and fails, as a stale
// REVIEWED entry does — so the list only shrinks.
const PENDING_DOCUMENTS = new Map([
  // U523 (the pane preview draws its elements).
  ['graph.js GET /preview/pane/:node/:mount', 'U523'],
  // U524 (the export draws its elements).
  ['export.js GET /api/export/:ref', 'U524'],
]);

// Source with comments and string/template contents blanked to spaces
// (offsets kept), so a brace, paren or match inside either never counts.
function blank(src) {
  const out = src.split('');
  const n = src.length;
  const wipe = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      const stop = e === -1 ? n : e;
      wipe(i, stop);
      i = stop;
    } else if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const stop = e === -1 ? n : e + 2;
      wipe(i, stop);
      i = stop;
    } else if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      wipe(i + 1, j);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

// The offset of the bracket closing the one opened at `open` in blanked `b`.
function closeOf(b, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let k = open; k < b.length; k++) {
    const ch = b[k];
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1;
      if (!stack.length) return k;
    }
  }
  return -1;
}

// Every route registration in a file: its 'VERB /path' and the span of its
// call, from `app.<verb>(` to the paren that closes it.
function routeSpans(src, b, rel, problems) {
  const spans = [];
  for (const m of b.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*(['"`])/g)) {
    const q = m.index + m[0].length;
    const route = `${m[1].toUpperCase()} ${src.slice(q, src.indexOf(m[2], q))}`;
    const open = m.index + m[0].indexOf('(');
    const end = closeOf(b, open);
    if (end === -1) { problems.push(`${rel}: the scan found no end to ${route}`); continue; }
    spans.push({ route, start: m.index, end });
  }
  for (let k = 1; k < spans.length; k++) {
    if (spans[k].start < spans[k - 1].end) problems.push(`${rel}: ${spans[k].route} sits inside ${spans[k - 1].route} — the scan has drifted`);
  }
  return spans;
}

// The frame type of the object literal around `at`, if its top level says one.
function frameAt(src, b, at) {
  let open = -1;
  for (let k = at - 1, d = 0; k >= 0; k--) {
    if (b[k] === '}') d++;
    else if (b[k] === '{') { if (d === 0) { open = k; break; } d--; }
  }
  if (open === -1) return null;
  let top = '';
  for (let k = open + 1, d = 0; k < b.length; k++) {
    if (b[k] === '{') d++;
    else if (b[k] === '}') { if (d === 0) break; d--; }
    top += d === 0 ? src[k] : ' ';
  }
  const t = /\btype\s*:\s*(['"`])([^'"`]+)\1/.exec(top);
  return t ? t[2] : null;
}

// A sink handed a whole node: `node` (or `x.node`) itself, not a field of it
// and not a key named node.
const WHOLE_NODE = /\bnode\b(?!\s*(?:\.|\[|\?\.|:))/;
const SINK = /\bres\.json\(|\.send\(|\brenderNodePreview\(/g;
// A document builder: it hands the document element records whatever its
// arguments (U521), so a GET that calls one is a carrier.
const DOC_SINK = /\b(?:documentElements|buildExportHtml|writeExport|buildReplay)\(/g;
// What a keyed handler applies: dropPrivate, graph.js's privateFor over it, or
// readerOf (documentElements applies dropPrivate through the route's row).
const PROJECTION = /\b(?:dropPrivate|privateFor|readerOf)\(/;

// The census of `files` (absolute paths): what it found, and what is missing.
// `pending` (PENDING_DOCUMENTS by default) tolerates a keyed document route
// with no projection yet; one of its entries found WITH a projection is stale.
function privateCensus(files, pending = PENDING_DOCUMENTS) {
  const problems = [];
  const found = [];
  const projected = new Set();
  for (const file of files) {
    const rel = path.basename(file);
    const src = fs.readFileSync(file, 'utf8');
    const b = blank(src);
    const spans = routeSpans(src, b, rel, problems);
    const spanAt = (at) => spans.find((s) => at > s.start && at < s.end) || null;
    const fnAt = (at) => {
      let last = null;
      for (const f of b.slice(0, at).matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) last = f[1];
      return last ? `fn:${last}` : 'module';
    };
    const line = (at) => src.slice(0, at).split('\n').length;
    const place = (at, what) => {
      const frame = frameAt(src, b, at);
      if (frame) {
        found.push({ key: `${rel} frame:${frame}`, what });
        if (!Object.hasOwn(PRIVATE_RULES.frames, frame)) problems.push(`${rel}:${line(at)}: ${what} in frame '${frame}', which PRIVATE_RULES.frames does not key`);
        return;
      }
      const span = spanAt(at);
      const carrier = span ? span.route : fnAt(at);
      const key = `${rel} ${carrier}`;
      found.push({ key, what });
      if (span && span.route.startsWith('GET ') && Object.hasOwn(PRIVATE_RULES.routes, span.route)) {
        const body = b.slice(span.start, span.end);
        if (PROJECTION.test(body)) projected.add(key);
        else if (!pending.has(key)) problems.push(`${rel}:${line(at)}: ${span.route} is keyed in PRIVATE_RULES.routes but its handler applies no dropPrivate`);
        return;
      }
      if (!REVIEWED.has(key)) problems.push(`${rel}:${line(at)}: ${what} in ${carrier}, which neither PRIVATE_RULES.routes keys nor this test reviews`);
    };
    for (const m of b.matchAll(/\.comments\b/g)) place(m.index, 'a .comments read');
    for (const m of b.matchAll(SINK)) {
      const span = spanAt(m.index);
      if (!span || !span.route.startsWith('GET ')) continue;
      const open = m.index + m[0].length - 1;
      const end = closeOf(b, open);
      if (end === -1) { problems.push(`${rel}:${line(m.index)}: the scan found no end to a sink`); continue; }
      if (WHOLE_NODE.test(b.slice(open + 1, end))) place(m.index, 'a whole node served');
    }
    for (const m of b.matchAll(DOC_SINK)) {
      const span = spanAt(m.index);
      if (span && span.route.startsWith('GET ')) place(m.index, 'a document builder');
    }
  }
  for (const key of pending.keys()) {
    if (projected.has(key)) problems.push(`PENDING_DOCUMENTS names ${JSON.stringify(key)}, which now applies its projection — drop it`);
  }
  return { problems, found };
}

const routeFiles = (dir = path.join(REPO_ROOT, 'lib/server/routes')) => fs.readdirSync(dir)
  .filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));

// ── the write routes (U214c; U213's open issue, DECISIONS A2) ──────────────
// PATCH, POST /:id/reply and DELETE find a pin by id and answer it (or act on
// it). On a private pin, a caller that does not see private pins
// (audience.seesPrivate false: a remote viewer at any level, lib/client) gets
// the GET's answer — 404 {error:'not found', id}, the claude-reply gate's
// 404-not-403 rule — and the pin is left exactly as it was.
test('the write routes: on a private pin, a remote full viewer\'s PATCH {}, PATCH {shared:true}, user reply and DELETE (and lib/client\'s) answer 404; nothing carries the text; the pin is unchanged', async (t) => {
  const d = await boot(t, ['full']);
  const { api, call } = d.full;
  const ids = await twoPins(api);
  const pinOf = async () => (await ok(api.get('/api/elements?type=comment'), 'local read')).elements.find((c) => c.id === ids.priv);
  const before = await pinOf();
  assert.ok(before && before.text === PRIVATE && before.shared === false, 'the private pin is there');
  const shape = (c) => ({ id: c.id, text: c.text, shared: c.shared, replies: c.replies || null, seq: c.seq });

  const attempts = [
    ['PATCH {}', 'PATCH', `/api/elements/${ids.priv}`, {}],
    ['PATCH {shared:true}', 'PATCH', `/api/elements/${ids.priv}`, { shared: true }],
    ['user reply', 'POST', `/api/elements/${ids.priv}/reply`, { text: 'a remote reply', author: 'user' }],
    ['DELETE', 'DELETE', `/api/elements/${ids.priv}`, null],
  ];
  for (const [label, method, p, body] of attempts) {
    for (const [who, headers] of [['remote full', REMOTE], ['lib/client', {}]]) {
      const r = await call(method, p, body, headers);
      assert.equal(r.status, 404, `${who} ${label}: ${r.status} ${JSON.stringify(r.body)}`);
      assert.deepStrictEqual(r.body, { error: 'not found', id: ids.priv }, `${who} ${label}: the GET's answer`);
      assert.ok(!has(r.body, PRIVATE), `${who} ${label}: no private text`);
      const now = await pinOf();
      assert.ok(now, `${who} ${label}: the pin is still there`);
      assert.deepStrictEqual(shape(now), shape(before), `${who} ${label}: the pin is unchanged`);
    }
  }
  // The shared pin is not gated: a remote full viewer still edits it.
  const sharedEdit = await call('PATCH', `/api/elements/${ids.shared}`, { text: 'edited remotely' }, REMOTE);
  assert.equal(sharedEdit.status, 200, JSON.stringify(sharedEdit.body));
  // The local browser still acts on the private pin.
  await ok(api.patch(`/api/elements/${ids.priv}`, { text: PRIVATE + '-2' }), 'local edit of the private pin');
});

test('census: every .comments read and whole-node body in lib/server/routes is keyed in PRIVATE_RULES or reviewed; the scan is live', (t) => {
  const { problems, found } = privateCensus(routeFiles());
  assert.deepStrictEqual(problems, [],
    'a route serves comment pins or a whole node with no PRIVATE_RULES entry, so a private pin would reach Claude\'s tools or a remote viewer. '
    + 'Key it in PRIVATE_RULES.routes (lib/core/remote-policy) and apply dropPrivate unless audience.seesPrivate(req) — '
    + 'or, if it does not serve pins, review it in REVIEWED here with why');
  const keys = new Set(found.map((f) => f.key));
  for (const k of REVIEWED.keys()) assert.ok(keys.has(k), `REVIEWED names ${JSON.stringify(k)}, which the scan no longer finds — drop it`);
  // Today's carriers are found: each PRIVATE_RULES.routes key. (The comment
  // frame left lib/server/routes with U327a: domain/comments emitComments sends
  // it as element:comment, projected through element-policy's private paths —
  // test/ws-projection.test.js.)
  for (const k of ['elements.js GET /api/elements', 'graph.js GET /api/graph/node/:id', 'graph.js GET /preview/node/:id', 'graph.js GET /api/graph/diff', 'element-search.js GET /api/elements/search']) {
    assert.ok(keys.has(k), `the scan found no ${k}`);
  }
  for (const route of Object.keys(PRIVATE_RULES.routes)) {
    if ([...PENDING_DOCUMENTS.keys()].some((k) => k.endsWith(` ${route}`))) continue; // its owner's unit wires it
    assert.ok(found.some((f) => f.key.endsWith(` ${route}`)), `PRIVATE_RULES.routes keys ${route}, which no route file serves pins or a node from`);
  }

  // A planted serving read in a scratch copy is reported: a whole node, and a
  // pin list, each from a new GET route.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-private-census-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planted = path.join(dir, 'graph.js');
  const real = fs.readFileSync(path.join(REPO_ROOT, 'lib/server/routes/graph.js'), 'utf8');
  const at = real.lastIndexOf('\n}');
  fs.writeFileSync(planted, `${real.slice(0, at)}
  app.get('/api/planted/:id', (req, res) => { const node = graph.nodes.get(req.params.id); res.json(node); });
  app.get('/api/planted-pins', (req, res) => { res.json({ pins: state.comments }); });${real.slice(at)}`);
  const p = privateCensus([planted]).problems;
  assert.equal(p.length, 2, p.join('\n'));
  assert.ok(p.some((l) => /a whole node served in GET \/api\/planted\/:id,/.test(l)), p.join('\n'));
  assert.ok(p.some((l) => /a \.comments read in GET \/api\/planted-pins,/.test(l)), p.join('\n'));
  // And a keyed route whose handler stops applying dropPrivate is reported.
  const unwired = path.join(dir, 'elements.js');
  const elements = fs.readFileSync(path.join(REPO_ROOT, 'lib/server/routes/elements.js'), 'utf8');
  const cut = elements.replace(/dropPrivate\('routes', 'GET \/api\/elements', body\)/, 'body');
  assert.notEqual(cut, elements, 'the planted copy lost its dropPrivate');
  fs.writeFileSync(unwired, cut);
  assert.match(privateCensus([unwired]).problems.join('\n'), /GET \/api\/elements is keyed in PRIVATE_RULES\.routes but its handler applies no dropPrivate/);
});

// The documents' half of the census (U521): a document builder in a GET is a
// carrier; a keyed one applies readerOf (or dropPrivate); PENDING_DOCUMENTS
// tolerates its four entries and fails on a stale one.
test('census: a document builder in a GET is a carrier; readerOf is its projection; a pending entry that now passes is stale', (t) => {
  const { problems, found } = privateCensus(routeFiles());
  assert.deepStrictEqual(problems, []);
  const keys = new Set(found.filter((f) => f.what === 'a document builder').map((f) => f.key));
  for (const k of ['export.js GET /api/export/:ref', 'replay.js GET /replay', 'replay.js GET /api/replay/html']) {
    assert.ok(keys.has(k), `the scan found the document builder in ${k}`);
  }
  for (const k of PENDING_DOCUMENTS.keys()) {
    const route = k.slice(k.indexOf(' ') + 1);
    assert.ok(Object.hasOwn(PRIVATE_RULES.routes, route), `${k}: PRIVATE_RULES.routes keys it`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-private-census-docs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A GET that calls buildExportHtml with no readerOf, in a route no row keys
  // and no pending entry names, and the same under a keyed route of a file
  // PENDING_DOCUMENTS does not name: both reported.
  const planted = path.join(dir, 'planted.js');
  fs.writeFileSync(planted, `function mountPlanted(app, ctx) {
  app.get('/api/planted-doc/:ref', (req, res) => { res.send(buildExportHtml(ctx, req.params.ref).html); });
  app.get('/api/export/:ref', (req, res) => { res.send(buildExportHtml(ctx, req.params.ref).html); });
}
module.exports = { mountPlanted };
`);
  const p = privateCensus([planted]).problems;
  assert.equal(p.length, 2, p.join('\n'));
  assert.ok(p.some((l) => /a document builder in GET \/api\/planted-doc\/:ref, which neither PRIVATE_RULES\.routes keys nor this test reviews/.test(l)), p.join('\n'));
  assert.ok(p.some((l) => /GET \/api\/export\/:ref is keyed in PRIVATE_RULES\.routes but its handler applies no dropPrivate/.test(l)), p.join('\n'));
  // With readerOf in the handler, the keyed one passes.
  fs.writeFileSync(planted, `function mountPlanted(app, ctx) {
  app.get('/api/export/:ref', (req, res) => { const reader = readerOf(ctx.audience, req); res.send(buildExportHtml(ctx, req.params.ref, reader).html); });
}
`);
  assert.deepStrictEqual(privateCensus([planted]).problems, []);
  // export.js wired (its handler names readerOf) while PENDING_DOCUMENTS still
  // names it: stale.
  const wired = path.join(dir, 'export.js');
  const real = fs.readFileSync(path.join(REPO_ROOT, 'lib/server/routes/export.js'), 'utf8');
  const cut = real.replace('const opts = { mode: modeParam(req.query.mode) };', 'const opts = { mode: modeParam(req.query.mode), reader: readerOf(ctx.audience, req) };');
  assert.notEqual(cut, real, 'the planted copy names readerOf');
  fs.writeFileSync(wired, cut);
  assert.match(privateCensus([wired]).problems.join('\n'), /PENDING_DOCUMENTS names "export\.js GET \/api\/export\/:ref", which now applies its projection/);
  assert.deepStrictEqual(privateCensus([wired], new Map()).problems, [], 'with no pending entry, the wired copy passes');
  // And unwired, with no pending entry, it is reported.
  assert.match(privateCensus([path.join(REPO_ROOT, 'lib/server/routes/export.js')], new Map()).problems.join('\n'),
    /GET \/api\/export\/:ref is keyed in PRIVATE_RULES\.routes but its handler applies no dropPrivate/);
});

// ── the chrome: a 403 read (a remote basic shell) ───────────────────────────
// Last in the file: the shell replaces the globals (fetch among them) from its
// before() to its after(), and the server tests above use Node's own fetch.

describe('chrome: GET /api/elements?type=comment answering 403', () => {
  let shell;
  let W;
  const PANE = { id: 'notes', html: '<ul><li>one</li><li>two</li></ul>', target: 'main', params: {} };
  // The anchor in the resolver's form; the overlay draws the pin (U327b).
  const PIN = { id: 'c1', text: 'a pin', shared: true, replies: [],
    anchor: require('../lib/core/element-log').convertAnchor({ mount: 'notes', selector: 'li', text: 'two', ordinal: 1 }) };
  const markers = () => [...W.document.getElementById('el-layer').querySelectorAll('.pin-marker')];

  before(async () => {
    const { bootShell, helloFrame } = require('../test-support/chrome-shell');
    shell = await bootShell();
    W = shell.window;
    await shell.frame(helloFrame({ mounts: [PANE] }));
  });
  after(() => shell && shell.restore());

  test('refresh() throws nothing and leaves no markers when the read is refused', async () => {
    const { respond } = require('../test-support/chrome-shell');
    // A pin is drawn first (the frame path), so the 403's effect is visible.
    shell.setRoutes({ '/api/elements?type=comment': { elements: [PIN] } });
    await shell.frame({ type: 'element:comment', elements: [PIN] });
    await waitUntil(() => markers().length === 1, { what: 'precondition: one marker' });

    shell.setRoutes({ '/api/elements?type=comment': respond({ ok: false, mirror: 'basic', remote: true, hint: 'tunnel mirror on' }, { status: 403 }) });
    // A reset frame is one refresh (U304: the 30 s fallback poll is gone).
    const { helloFrame } = require('../test-support/chrome-shell');
    await shell.frame({ ...helloFrame({ mounts: [PANE] }), type: 'reset' });
    await shell.tick();
    assert.ok(shell.calls.some((c) => c.url === '/api/elements?type=comment' && c.method === 'GET'));
    await waitUntil(() => markers().length === 0, { what: 'a refused read renders no markers' });
  });
});
