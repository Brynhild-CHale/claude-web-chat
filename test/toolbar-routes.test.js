// The toolbar's routes (lib/server/routes/toolbar.js; annotation engine 2D.2,
// rulings H-6 and U332@project-chrome-rebind): GET /api/toolbar at every level,
// PATCH /api/toolbar (the project record) locally or from a remote viewer at
// full, PATCH /api/toolbar/user (the user record) locally only. Records are
// read honestly (a corrupt one is named, never read as empty), written through
// fsjson, and each write is one `toolbar` frame on the bus with no event-log
// entry.
//
// Who is who (test/element-routes-private.test.js's terms): Node's fetch
// (withServer's anonApi) is a local browser; lib/client is a local process; a
// remote viewer is a loopback request carrying the portal's X-WC-Remote: 1, at
// the project's opt-in in the sandbox's tunnel.json; a network peer is a request
// whose socket's remoteAddress is stubbed before the app sees it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { withServer, tmpRoot, waitUntil } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths, projectPaths } = require('../lib/core/paths');
const { emptyProject, emptyUser } = require('../lib/core/toolbar-record');
const { TOOLBAR_BODY_MAX } = require('../lib/server/routes/toolbar');
const client = require('../lib/client');

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const PEER = '10.0.0.5';
const HOST_HINT = 'hotkeys and settings for every project are set on the host';

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

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}

const readFile = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const exists = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };
const plain = (v) => JSON.parse(JSON.stringify(v));
// The default `pinned` of a project record that names none (U337).
const BUILTIN_PINNED = ['comment', 'highlight', 'box-grab'];

test('GET with no records answers the defaults, a local caller may write both tiers', async (t) => {
  const d = await withServer(t);
  for (const api of [d.anonApi, d.api]) {
    const body = await ok(api.get('/api/toolbar'), 'GET');
    // U337: the default `pinned` (the built-in pack's listed types) and the
    // tools[] listing (test/toolbar-tools-route.test.js pins its rows).
    const { tools, ...rest } = plain(body);
    assert.deepEqual(rest, {
      ok: true, v: 1, project: { ...emptyProject(), pinned: BUILTIN_PINNED }, user: emptyUser(), merged: { bindings: {}, settings: {} },
      canWrite: true, canWriteUser: true,
    });
    assert.deepEqual(tools.map((x) => x.type), BUILTIN_PINNED);
  }
  const viaClient = await client.request(d.port, 'GET', '/api/toolbar', null, { timeout: 10000 });
  assert.deepEqual([viaClient.status, viaClient.body.canWrite, viaClient.body.canWriteUser], [200, true, true]);
  assert.ok(!exists(projectPaths(d.root).toolbar), 'a read writes nothing');
  assert.ok(!exists(userPaths().toolbar), 'a read writes nothing');
});

test('PATCH /api/toolbar: pin, hide, order, settings, a profile and a binding round-trip and land in .web-chat/toolbar.json; the user file is untouched', async (t) => {
  const d = await withServer(t);
  const file = projectPaths(d.root).toolbar;
  await ok(d.anonApi.patch('/api/toolbar', { pinned: ['comment', 'highlight'], hidden: ['box-grab'] }), 'pin + hide');
  await ok(d.anonApi.patch('/api/toolbar', { pinned: ['highlight', 'comment'] }), 'order');
  await ok(d.anonApi.patch('/api/toolbar', { settings: { highlight: { color: 'rust', snap: 'words' } } }), 'settings');
  await ok(d.anonApi.patch('/api/toolbar', { profiles: { highlight: [{ name: 'Gold', settings: { color: 'gold' } }] } }), 'profile');
  const last = await ok(d.anonApi.patch('/api/toolbar', { bindings: { h: { kind: 'tool', type: 'highlight', profile: 'Gold' }, 1: { kind: 'slot', n: 1 }, P: null } }), 'bindings');
  const want = {
    v: 1, pinned: ['highlight', 'comment'], hidden: ['box-grab'],
    settings: { highlight: { color: 'rust', snap: 'words' } },
    profiles: { highlight: [{ name: 'Gold', settings: { color: 'gold' } }] },
    bindings: { 1: { kind: 'slot', n: 1 }, H: { kind: 'tool', type: 'highlight', profile: 'Gold' }, P: null },
  };
  assert.deepEqual(last.project, want, 'the PATCH answers the new view');
  assert.deepEqual((await ok(d.anonApi.get('/api/toolbar'))).project, want, 'and GET reads it back');
  assert.deepEqual(readFile(file), want, 'the file parses and holds the record');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('toolbar.json.')), [], 'no temp file left behind');
  assert.ok(!exists(userPaths().toolbar), 'the user record was never written');
  // A validation error is a 400 naming the field; nothing is written.
  const bad = await d.anonApi.patch('/api/toolbar', { bindings: { P: { kind: 'chrome', action: 'chrome.push' } } });
  assert.equal(bad.status, 400);
  assert.deepEqual([bad.json.ok, bad.json.field], [false, 'bindings.P']);
  assert.equal(typeof bad.json.error, 'string');
  assert.deepEqual(readFile(file), want);
  const tooBig = await d.anonApi.patch('/api/toolbar', { settings: { x: { s: 'x'.repeat(TOOLBAR_BODY_MAX) } } });
  assert.equal(tooBig.status, 413);
  assert.deepEqual(readFile(file), want);
});

test('PATCH /api/toolbar/user writes ~/.web-chat/toolbar.json under the sandbox HOME, never the project file', async (t) => {
  const d = await withServer(t);
  const user = userPaths().toolbar;
  assert.ok(user.startsWith(d.home), 'the sandbox HOME, never the developer\'s');
  const body = await ok(d.anonApi.patch('/api/toolbar/user', {
    bindings: { P: { kind: 'chrome', action: 'chrome.push' } }, fingerDraws: true, settings: { highlight: { color: 'gold' } },
  }), 'user PATCH');
  const want = { v: 1, bindings: { P: { kind: 'chrome', action: 'chrome.push' } }, fingerDraws: true, settings: { highlight: { color: 'gold' } } };
  assert.deepEqual(body.user, want);
  assert.deepEqual(readFile(user), want);
  assert.ok(!exists(projectPaths(d.root).toolbar), 'the project record was never written');
  // The project tier overrides it key by key: a project null unbinds P.
  await ok(d.anonApi.patch('/api/toolbar', { bindings: { P: null }, settings: { highlight: { color: 'rust' } } }), 'project');
  const merged = (await ok(d.anonApi.get('/api/toolbar'))).merged;
  assert.deepEqual(merged.bindings.P, { value: null, tier: 'project', shadows: [{ tier: 'user', value: { kind: 'chrome', action: 'chrome.push' } }] });
  assert.deepEqual(merged.settings.highlight.color, { value: 'rust', tier: 'project', shadows: [{ tier: 'user', value: 'gold' }] });
  // lib/client (a local process) may write it too; a pack source is the user tier's.
  const r = await client.request(d.port, 'PATCH', '/api/toolbar/user',
    { bindings: { G: { kind: 'tool', type: 'box-grab', pack: { name: 'grabs', source: 'https://example.test/g.git' } } } }, { timeout: 10000 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(readFile(user).bindings.G.pack.name, 'grabs');
});

test('a corrupt project record reads as the defaults AND corrupt:[project]; the next PATCH moves it aside and writes a fresh one', async (t) => {
  const d = await withServer(t);
  const file = projectPaths(d.root).toolbar;
  fs.writeFileSync(file, '{"pinned": ["comment"');
  let body = await ok(d.anonApi.get('/api/toolbar'), 'GET torn');
  assert.deepEqual([body.project, body.corrupt], [{ ...emptyProject(), pinned: BUILTIN_PINNED }, ['project']]);
  // A record that parses but fails the validator is named the same way.
  fs.writeFileSync(file, JSON.stringify({ pinned: ['a'], hidden: ['a'] }));
  body = await ok(d.anonApi.get('/api/toolbar'), 'GET invalid');
  assert.deepEqual(body.corrupt, ['project']);
  // Unknown top-level fields are tolerated and listed.
  fs.writeFileSync(file, JSON.stringify({ pinned: ['comment'], later: 1 }));
  body = await ok(d.anonApi.get('/api/toolbar'), 'GET unknown field');
  assert.deepEqual([body.project.pinned, body.ignored, body.corrupt], [['comment'], ['project.later'], undefined]);
  fs.writeFileSync(file, '{"pinned": ["comment"');
  body = await ok(d.anonApi.patch('/api/toolbar', { pinned: ['highlight'] }), 'PATCH over a torn file');
  assert.equal(body.corrupt, undefined);
  const aside = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('toolbar.json.corrupt-'));
  assert.equal(aside.length, 1, 'a .corrupt sibling holds the torn bytes');
  assert.equal(fs.readFileSync(path.join(path.dirname(file), aside[0]), 'utf8'), '{"pinned": ["comment"');
  assert.deepEqual(readFile(file), { ...emptyProject(), pinned: ['highlight'] });
  // The user tier the same way.
  fs.mkdirSync(path.dirname(userPaths().toolbar), { recursive: true });
  fs.writeFileSync(userPaths().toolbar, 'not json');
  assert.deepEqual((await ok(d.anonApi.get('/api/toolbar'))).corrupt, ['user']);
});

test('a previewed node never refuses a toolbar write: toolbar state is not node content', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'm1', html: '<p>one</p>' }), 'render');
  await ok(d.api.post('/api/commit', { message: 'one' }), 'commit one');
  await ok(d.api.post('/api/render', { id: 'm1', html: '<p>two</p>' }), 'render');
  await ok(d.api.post('/api/commit', { message: 'two' }), 'commit two');
  const graph = await ok(d.api.get('/api/graph'), 'graph');
  assert.ok(graph.nodes.length >= 2);
  const first = graph.nodes[0].id;
  assert.notEqual(graph.active, first);
  await ok(d.anonApi.post('/api/graph/active', { id: first }), 'active moved back');
  assert.equal((await ok(d.api.get('/api/graph'))).active, first);
  const body = await ok(d.anonApi.patch('/api/toolbar', { pinned: ['comment'] }), 'PATCH while previewed');
  assert.deepEqual(body.project.pinned, ['comment']);
  await ok(d.anonApi.patch('/api/toolbar/user', { fingerDraws: true }), 'user PATCH while previewed');
  // And it folds into no node: the store and the graph are as they were.
  const after = await ok(d.api.get('/api/graph'));
  assert.deepEqual([after.active, after.nodes.length], [first, graph.nodes.length]);
});

async function remotes(t) {
  const roots = { read: tmpRoot('wc-tb-read-'), full: tmpRoot('wc-tb-full-') };
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, {
    ...TUNNEL, remote: { mirror: { [path.resolve(roots.read)]: 'read', [path.resolve(roots.full)]: 'full' } },
  });
  const out = {};
  for (const level of ['basic', 'read', 'full']) {
    const opts = level === 'basic' ? { seed } : { root: roots[level] };
    const d = await withServer(t, opts);
    t.after(stubPeers(d.server));
    d.call = (method, p, body, headers = {}) => client.request(d.port, method, p, body, { headers, timeout: 10000 });
    out[level] = d;
  }
  return out;
}

test('remote: every level reads; below full PATCH is 403; full writes the project record but never the user record; a network peer writes nothing', async (t) => {
  const d = await remotes(t);
  for (const level of ['basic', 'read']) {
    const g = await d[level].call('GET', '/api/toolbar', null, REMOTE);
    assert.equal(g.status, 200, level);
    assert.deepEqual([g.body.canWrite, g.body.canWriteUser], [false, false], level);
    const p = await d[level].call('PATCH', '/api/toolbar', { pinned: ['comment'] }, REMOTE);
    assert.equal(p.status, 403, level);
    assert.equal(p.body.ok, false);
    assert.equal(p.body.mirror, level);
    assert.ok(!exists(projectPaths(d[level].root).toolbar), `${level}: nothing written`);
  }
  const g = await d.full.call('GET', '/api/toolbar', null, REMOTE);
  assert.deepEqual([g.status, g.body.canWrite, g.body.canWriteUser], [200, true, false]);
  const p = await d.full.call('PATCH', '/api/toolbar', { pinned: ['comment'], bindings: { 1: { kind: 'slot', n: 2 } } }, REMOTE);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual([p.body.canWrite, p.body.canWriteUser], [true, false]);
  assert.deepEqual(readFile(projectPaths(d.full.root).toolbar).pinned, ['comment']);
  for (const level of ['basic', 'read', 'full']) {
    const u = await d[level].call('PATCH', '/api/toolbar/user', { fingerDraws: true }, REMOTE);
    assert.equal(u.status, 403, level);
    assert.deepEqual(u.body, { ok: false, remote: true, hint: HOST_HINT }, level);
  }
  assert.ok(!exists(userPaths().toolbar), 'no remote viewer wrote the user record');
  // A network peer (a WEB_CHAT_HOST bind) is basic whatever it sends: it reads, and writes nothing.
  for (const level of ['basic', 'full']) {
    const peer = { 'x-test-peer': PEER };
    assert.equal((await d[level].call('GET', '/api/toolbar', null, peer)).body.canWrite, false);
    for (const [m, p2] of [['PATCH', '/api/toolbar'], ['PATCH', '/api/toolbar/user']]) {
      const r = await d[level].call(m, p2, { hidden: ['x'] }, { ...peer, ...REMOTE });
      assert.equal(r.status, 403, `${level} network peer ${m} ${p2}`);
      const r2 = await d[level].call(m, p2, { hidden: ['x'] }, peer);
      assert.equal(r2.status, 403, `${level} network peer ${m} ${p2} (no label)`);
    }
  }
  assert.ok(!exists(projectPaths(d.basic.root).toolbar));
  assert.ok(!exists(userPaths().toolbar));
});

test('bus: one PATCH is exactly one `toolbar` frame on a local socket, carrying the new view, and no event-log entry', async (t) => {
  const d = await withServer(t);
  const ws = d.ws();
  t.after(() => { try { ws.terminate(); } catch {} });
  const frames = [];
  let hello = false;
  ws.on('message', (data) => {
    let msg = null;
    try { msg = JSON.parse(data.toString()); } catch {}
    if (!msg) return;
    if (msg.type === 'hello') hello = true;
    if (msg.type === 'toolbar') frames.push(msg);
  });
  await waitUntil(() => hello, { what: 'hello' });
  const before = (await ok(d.api.get('/api/events?since=0'))).events.length;
  const body = await ok(d.anonApi.patch('/api/toolbar', { pinned: ['highlight'] }), 'PATCH');
  await waitUntil(() => frames.length >= 1, { what: 'the toolbar frame' });
  // A user write, then a refused one: still one frame each for the accepted writes.
  await ok(d.anonApi.patch('/api/toolbar/user', { fingerDraws: true }), 'user PATCH');
  assert.equal((await d.anonApi.patch('/api/toolbar', { pinned: ['a', 'a'] })).status, 400);
  await waitUntil(() => frames.length >= 2, { what: 'the second frame' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(frames.length, 2, 'one frame per accepted write, none for a refusal');
  const [first, second] = frames;
  assert.deepEqual(Object.keys(first).sort(), ['merged', 'project', 'type', 'user', 'v']);
  assert.deepEqual(first.project, body.project);
  assert.deepEqual(first.project.pinned, ['highlight']);
  assert.equal(second.user.fingerDraws, true);
  assert.deepEqual(second.project.pinned, ['highlight']);
  const after = (await ok(d.api.get('/api/events?since=0'))).events.length;
  assert.equal(after, before, 'no event-log entry: toolbar state is not surface content');
});
