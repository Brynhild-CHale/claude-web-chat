// The comment routes check the mirror level in the daemon (PLAN.md 1B.1, R6
// today-bug 1): reading the pins needs `read`, writing one needs `full`, as
// lib/core/remote-policy's RULES rows say — and the daemon checks again
// (audience.requireMirror in lib/server/routes/comments.js), because a network
// peer on a WEB_CHAT_HOST bind never reaches the portal's table, and a portal
// older than protocol 11 lets every comment route through.
//
// Three projects on one sandbox HOME, opted in (tunnel.json, as `tunnel mirror
// on` writes it) at nothing, `read` and `full`. A remote viewer is a loopback
// request carrying the portal's `X-WC-Remote: 1`; a network peer is a request
// whose socket's remoteAddress is stubbed to 10.0.0.5 before the app sees it
// (test/t1-e2e.test.js's). A local request is unchanged (test/comments.test.js
// runs untouched).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { withServer, tmpRoot } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const client = require('../lib/client');

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const PEER = '10.0.0.5';

// Requests carrying x-test-peer arrive from that address: their socket's
// remoteAddress is stubbed before the app sees them, and put back once the
// response has gone.
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

// The three daemons, one per opt-in, with one pin each (made locally).
async function boot(t) {
  const roots = { read: tmpRoot('wc-cr-read-'), full: tmpRoot('wc-cr-full-') };
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, {
    ...TUNNEL, remote: { mirror: { [path.resolve(roots.read)]: 'read', [path.resolve(roots.full)]: 'full' } },
  });
  const out = {};
  out.basic = await withServer(t, { seed });
  out.read = await withServer(t, { root: roots.read });
  out.full = await withServer(t, { root: roots.full });
  for (const d of Object.values(out)) {
    t.after(stubPeers(d.server));
    const r = await d.api.post('/api/comments', { text: 'a local note', shared: true, anchor: { mount: 'm1' } });
    assert.equal(r.status, 200, r.text);
    d.call = (method, p, body, headers) => client.request(d.port, method, p, body, { headers, timeout: 10000 });
  }
  return out;
}

const WRITES = [
  ['POST', '/api/comments', { text: 'from afar', shared: true, anchor: { mount: 'm1' } }],
  ['PATCH', '/api/comments/c1', { text: 'edited from afar' }],
  ['POST', '/api/comments/c1/reply', { text: 'a reply from afar' }],
  ['DELETE', '/api/comments/c1', undefined],
];

test('a remote viewer: GET needs read (basic 403 with mirror basic), every write needs full', async (t) => {
  const d = await boot(t);

  const basicGet = await d.basic.call('GET', '/api/comments', null, REMOTE);
  assert.equal(basicGet.status, 403);
  assert.equal(basicGet.body.mirror, 'basic');
  assert.equal(basicGet.body.remote, true);
  assert.match(basicGet.body.hint, /claude-web-chat tunnel mirror on/);
  assert.ok(!JSON.stringify(basicGet.body).includes('a local note'));

  for (const level of ['read', 'full']) {
    const r = await d[level].call('GET', '/api/comments', null, REMOTE);
    assert.equal(r.status, 200, `${level}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.comments.length, 1);
  }

  for (const level of ['basic', 'read']) {
    for (const [m, p, body] of WRITES) {
      const r = await d[level].call(m, p, body, REMOTE);
      assert.equal(r.status, 403, `${level}: ${m} ${p}`);
      assert.equal(r.body.mirror, level, `${level}: ${m} ${p}`);
      assert.match(r.body.hint, /without --read-only/, 'the hint names the full opt-in');
    }
    const after = await d[level].api.get('/api/comments');
    assert.deepStrictEqual(after.json.comments.map((c) => [c.id, c.text, (c.replies || []).length]), [['c1', 'a local note', 0]],
      `${level}: no remote write landed`);
  }

  // full: each write lands.
  const add = await d.full.call('POST', '/api/comments', WRITES[0][2], REMOTE);
  assert.equal(add.status, 200, JSON.stringify(add.body));
  for (const [m, p, body] of WRITES.slice(1)) {
    const r = await d.full.call(m, p, body, REMOTE);
    assert.equal(r.status, 200, `full: ${m} ${p} → ${JSON.stringify(r.body)}`);
  }
  const left = await d.full.api.get('/api/comments');
  assert.deepStrictEqual(left.json.comments.map((c) => c.text), ['from afar']);
});

test('a network peer is refused every comment route, whatever the project opted into', async (t) => {
  const d = await boot(t);
  for (const level of ['basic', 'read', 'full']) {
    for (const [m, p, body] of [['GET', '/api/comments', null], ...WRITES]) {
      const r = await d[level].call(m, p, body, { 'x-test-peer': PEER });
      assert.equal(r.status, 403, `${level}: ${m} ${p} → ${JSON.stringify(r.body)}`);
      assert.equal(r.body.mirror, 'basic', 'a network peer is basic');
      assert.equal(r.body.remote, false);
    }
    const after = await d[level].api.get('/api/comments');
    assert.equal(after.json.comments.length, 1, `${level}: nothing changed`);
  }
});

test('a local request is unchanged: read, add, edit, reply and delete', async (t) => {
  const { api } = await withServer(t);
  const add = await api.post('/api/comments', { text: 'here', shared: false });
  assert.equal(add.status, 200);
  assert.equal((await api.get('/api/comments')).json.comments.length, 1, 'locally, a private pin is read too');
  assert.equal((await api.patch('/api/comments/c1', { text: 'there' })).status, 200);
  assert.equal((await api.post('/api/comments/c1/reply', { text: 'and back' })).status, 200);
  assert.equal((await api.del('/api/comments/c1')).status, 200);
});
