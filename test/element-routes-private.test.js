// The element API's private rules (decision A2; C-16-2; U325): a record with
// shared === false is seen by a local browser only. lib/client (Claude's tools,
// with Claude's token or none), a remote viewer at any opt-in, and the event
// ring never carry one; a write naming a private element answers the GET's
// 404 and changes nothing. Also here: the WEB_CHAT_HOST-bound network peer,
// refused at every element route, and learned-later masking (A3) on GET.
//
// Who is who (test/private-routes.test.js's terms): a local browser is Node's
// fetch (withServer's `api`/`anonApi`: fetch metadata); lib/client sends none;
// a remote viewer is a loopback request carrying the portal's X-WC-Remote: 1,
// at the project's opt-in in the sandbox's tunnel.json; a network peer is a
// request whose socket's remoteAddress is stubbed before the app sees it.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { withServer, tmpRoot, waitUntil } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths, projectPaths } = require('../lib/core/paths');
const { WRITER_HEADER } = require('../lib/core/writer-token');
const client = require('../lib/client');

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const PEER = '10.0.0.5';
const LOCATOR = { mount: 'm1', selector: 'p', text: 'p', ordinal: 0 };
const RANGE = { v: 1, kind: 'range', mount: 'm1', quote: { exact: 'Hello', prefix: '', suffix: '' }, pos: { start: 0, end: 5 } };
const PRIVATE = 'wc-u325-private-mark';
const SHARED = 'wc-u325-shared-mark';

const logBytes = (root) => { try { return fs.readFileSync(projectPaths(root).elementsLog, 'utf8'); } catch { return ''; } };
const has = (v, s) => JSON.stringify(v).includes(s);

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

// Daemons on one sandbox HOME, remote viewers opted in at nothing (basic),
// `read` and `full`. Each has a pane m1, a shared and a private comment and a
// shared and a private highlight, and `call` (lib/client: no fetch metadata;
// `token: true` sends Claude's writer token).
async function boot(t, levels = ['basic', 'read', 'full']) {
  const roots = { read: tmpRoot('wc-erp-read-'), full: tmpRoot('wc-erp-full-') };
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
    await ok(d.api.post('/api/render', { id: 'm1', html: '<p>Hello</p>' }), 'render');
    const post = (body) => ok(d.anonApi.post('/api/elements', body), 'POST');
    d.ids = {
      shared: (await post({ type: 'comment', anchor: LOCATOR, payload: { text: SHARED, shared: true } })).element.id,
      priv: (await post({ type: 'comment', anchor: LOCATOR, payload: { text: PRIVATE, shared: false } })).element.id,
      hShared: (await post({ type: 'highlight', anchor: RANGE, payload: { note: SHARED } })).element.id,
      hPriv: (await post({ type: 'highlight', anchor: RANGE, payload: { note: PRIVATE, shared: false } })).element.id,
    };
    d.call = (method, p, body, headers = {}, { token = false } = {}) => client.request(d.port, method, p, body, {
      headers: { ...headers, ...(token ? { [WRITER_HEADER]: d.writerToken() } : {}) }, timeout: 10000,
    });
    out[level] = d;
  }
  return out;
}

test('C-16-2: on a private comment (and a private highlight), PATCH {}, PATCH {shared:true}, reply and DELETE from a remote full viewer and from lib/client (Claude\'s token) answer 404 and change nothing: state, log bytes, events', async (t) => {
  const { full: d } = await boot(t, ['full']);
  const { ids } = d;
  const snapshot = async () => ({
    get: (await ok(d.api.get('/api/elements'), 'local GET')).elements.map((e) => [e.id, e.v, e.seq, e.shared, e.text ?? e.note]),
    log: logBytes(d.root),
    ring: (await ok(d.api.get('/api/events?since=0'), 'events')).events.length,
    refs: d.srv.state.elements.slice(),
  });
  const before = await snapshot();
  assert.ok(before.get.some(([id, , , shared, text]) => id === ids.priv && shared === false && text === PRIVATE), 'the private pin is there');
  for (const id of [ids.priv, ids.hPriv]) {
    const attempts = [
      ['PATCH {}', 'PATCH', `/api/elements/${id}`, {}],
      ['PATCH {shared:true}', 'PATCH', `/api/elements/${id}`, { shared: true }],
      ['reply', 'POST', `/api/elements/${id}/reply`, { text: 'a reply', author: 'user' }],
      ['DELETE', 'DELETE', `/api/elements/${id}`, null],
    ];
    for (const [label, method, p, body] of attempts) {
      for (const [who, headers, opts] of [['remote full', REMOTE, {}], ['lib/client (Claude\'s token)', {}, { token: true }], ['lib/client (no token)', {}, {}]]) {
        const r = await d.call(method, p, body, headers, opts);
        assert.equal(r.status, 404, `${who} ${label} ${id}: ${r.status} ${JSON.stringify(r.body)}`);
        assert.deepStrictEqual(r.body, { error: 'not found', id }, `${who} ${label}: the GET's answer`);
        assert.deepStrictEqual(await snapshot(), before, `${who} ${label} ${id}: nothing changed`);
      }
    }
  }
  // The shared ones are not gated: a remote full viewer edits them.
  assert.equal((await d.call('PATCH', `/api/elements/${ids.shared}`, { text: 'edited remotely' }, REMOTE)).status, 200);
  assert.equal((await d.call('PATCH', `/api/elements/${ids.hShared}`, { note: 'edited remotely' }, REMOTE)).status, 200);
  // The local browser still acts on the private ones.
  await ok(d.anonApi.patch(`/api/elements/${ids.priv}`, { text: PRIVATE + '-2' }), 'local edit');
  await ok(d.anonApi.del(`/api/elements/${ids.hPriv}`), 'local delete');
});

test('private: GET /api/elements from lib/client (with or without Claude\'s token) and from a remote read or full viewer carries no shared:false record; a local browser gets them', async (t) => {
  const d = await boot(t, ['read', 'full']);
  for (const level of ['read', 'full']) {
    const { ids } = d[level];
    for (const [who, headers, opts] of [['remote', REMOTE, {}], ['lib/client', {}, {}], ['lib/client + token', {}, { token: true }]]) {
      for (const q of ['', '?type=comment', '?type=highlight', '?shared_only=0']) {
        const r = await d[level].call('GET', `/api/elements${q}`, null, headers, opts);
        assert.equal(r.status, 200, `${level} ${who} ${q}: ${JSON.stringify(r.body)}`);
        assert.ok(!r.body.elements.some((e) => e.shared === false), `${level} ${who} ${q}: no private record`);
        assert.ok(!has(r.body, PRIVATE), `${level} ${who} ${q}: no private text`);
      }
      const all = (await d[level].call('GET', '/api/elements', null, headers, opts)).body.elements.map((e) => e.id);
      assert.deepStrictEqual(all, [ids.shared, ids.hShared], `${level} ${who}: the shared ones only`);
    }
    const local = (await ok(d[level].anonApi.get('/api/elements'), 'local')).elements;
    assert.deepStrictEqual(local.map((e) => e.id), [ids.shared, ids.priv, ids.hShared, ids.hPriv], `${level}: a local browser gets them all`);
  }
});

test('a remote read socket gets the element:highlight frame without the private record; a local socket gets it whole', async (t) => {
  const { read: d } = await boot(t, ['read']);
  const listen = async (headers) => {
    const got = [];
    const sock = new WebSocket(`ws://localhost:${d.port}/ws`, { headers });
    sock.on('message', (data) => { try { got.push(JSON.parse(data.toString())); } catch {} });
    await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
    t.after(() => { try { sock.close(); } catch {} });
    await waitUntil(() => got.some((f) => f.type === 'hello'), { timeout: 5000, what: 'hello' });
    return got;
  };
  const remote = await listen({ ...REMOTE });
  const local = await listen({});
  await ok(d.anonApi.post('/api/elements', { type: 'highlight', anchor: RANGE, payload: { note: 'one more' } }), 'POST');
  const lf = await waitUntil(() => local.find((f) => f.type === 'element:highlight'), { timeout: 5000, what: 'local frame' });
  assert.equal(lf.elements.length, 3);
  assert.ok(has(lf, PRIVATE), 'a local socket sees the private record');
  const rf = await waitUntil(() => remote.find((f) => f.type === 'element:highlight'), { timeout: 5000, what: 'remote frame' });
  assert.equal(rf.elements.length, 2);
  assert.ok(!rf.elements.some((e) => e.shared === false));
  assert.ok(!has(rf, PRIVATE));
});

test('the event ring holds no private text after add, edit, reply and delete (comment and highlight)', async (t) => {
  const { api, anonApi } = await withServer(t);
  await ok(api.post('/api/render', { id: 'm1', html: '<p>Hello</p>' }), 'render');
  const c = (await ok(anonApi.post('/api/elements', { type: 'comment', anchor: LOCATOR, payload: { text: PRIVATE, shared: false } }), 'add')).element;
  await ok(anonApi.patch(`/api/elements/${c.id}`, { text: PRIVATE + '-edit' }), 'edit');
  await ok(anonApi.post(`/api/elements/${c.id}/reply`, { text: PRIVATE + '-reply' }), 'reply');
  const h = (await ok(anonApi.post('/api/elements', { type: 'highlight', anchor: RANGE, payload: { note: PRIVATE, shared: false } }), 'add h')).element;
  await ok(anonApi.patch(`/api/elements/${h.id}`, { note: PRIVATE + '-note' }), 'edit h');
  await ok(anonApi.del(`/api/elements/${h.id}`), 'delete h');
  await ok(anonApi.del(`/api/elements/${c.id}`), 'delete c');
  const ring = (await ok(api.get('/api/events?since=0'), 'events')).events;
  const mine = ring.filter((e) => e.kind === 'comment' || e.kind === 'element');
  assert.deepStrictEqual(mine.map((e) => `${e.kind}:${e.op}`),
    ['comment:add', 'comment:edit', 'comment:reply', 'element:add', 'element:edit', 'element:delete', 'comment:delete']);
  assert.ok(!has(ring, PRIVATE), 'no private text anywhere in the ring');
  for (const e of mine.filter((x) => x.kind === 'element')) {
    assert.deepStrictEqual(Object.keys(e).filter((k) => !['id', 'kind', 'type', 'op', 'v', 'shared', 'mount', 'was_shared'].includes(k) && !/^(seq|ts|at|t)$/.test(k)), [],
      `an element event carries ids, numbers and flags only: ${JSON.stringify(e)}`);
    assert.equal(e.shared, false);
  }
});

test('a network peer (WEB_CHAT_HOST bind) is refused at every element route, whatever the project opted into', async (t) => {
  const d = await boot(t);
  for (const level of ['basic', 'read', 'full']) {
    const { ids } = d[level];
    const routes = [
      ['GET', '/api/elements', null],
      ['GET', '/api/elements?type=highlight', null],
      ['POST', '/api/elements', { type: 'highlight', anchor: RANGE, payload: {} }],
      ['PATCH', `/api/elements/${ids.hShared}`, { note: 'x' }],
      ['PATCH', `/api/elements/${ids.shared}`, { text: 'x' }],
      ['POST', `/api/elements/${ids.shared}/reply`, { text: 'x' }],
      ['DELETE', `/api/elements/${ids.hShared}`, null],
      ['DELETE', '/api/elements/h99999', null],
    ];
    const before = logBytes(d[level].root);
    for (const [m, p, body] of routes) {
      for (const opts of [{}, { token: true }]) {
        const r = await d[level].call(m, p, body, { 'x-test-peer': PEER }, opts);
        assert.equal(r.status, 403, `${level}: ${m} ${p} → ${JSON.stringify(r.body)}`);
        assert.equal(r.body.mirror, 'basic', 'a network peer is basic');
        assert.ok(!has(r.body, SHARED) && !has(r.body, PRIVATE));
      }
    }
    assert.equal(logBytes(d[level].root), before, `${level}: nothing written`);
  }
  // And a remote basic viewer the same, a remote read viewer for every write.
  assert.equal((await d.basic.call('GET', '/api/elements', null, REMOTE)).status, 403);
  assert.equal((await d.read.call('POST', '/api/elements', { type: 'highlight', anchor: RANGE, payload: {} }, REMOTE)).status, 403);
  assert.equal((await d.read.call('GET', '/api/elements', null, REMOTE)).status, 200);
});

test('A3 learned later: a value written into a comment and a highlight note, then learned by the redactor (the capture token), is masked on GET while the log bytes are unchanged', async (t) => {
  const { api, anonApi, root } = await withServer(t);
  await ok(api.post('/api/render', { id: 'm1', html: '<p>Hello</p>' }), 'render');
  const value = `wclearned${crypto.randomBytes(16).toString('hex')}`;
  const c = (await ok(anonApi.post('/api/elements', { type: 'comment', anchor: LOCATOR, payload: { text: `the token is ${value}` } }), 'comment')).element;
  await ok(anonApi.post(`/api/elements/${c.id}/reply`, { text: `again ${value}` }), 'reply');
  const h = (await ok(anonApi.post('/api/elements', { type: 'highlight', anchor: RANGE, payload: { note: `note ${value}` } }), 'highlight')).element;
  assert.ok(h.note.includes(value), 'not known at the write: stored as typed');
  const before = logBytes(root);
  assert.ok(before.includes(value));
  fs.writeFileSync(projectPaths(root).captureToken, value + '\n');
  const masked = await waitUntil(async () => {
    const body = (await anonApi.get('/api/elements')).json;
    return has(body, value) ? null : body;
  }, { timeout: 6000, what: 'GET /api/elements masks the learned value' });
  assert.equal(masked.elements.length, 2);
  const mc = masked.elements.find((e) => e.id === c.id);
  assert.ok(mc.text.length > 0 && !mc.text.includes(value));
  assert.ok(!mc.replies[0].text.includes(value));
  assert.ok(!masked.elements.find((e) => e.id === h.id).note.includes(value));
  assert.equal(logBytes(root), before, 'the log bytes are unchanged');
});
