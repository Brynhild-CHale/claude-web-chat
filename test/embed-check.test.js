// GET /api/embed-check — the one route that makes the daemon fetch a URL the
// caller names. Nothing tested it before: not classify(), not the HEAD→GET
// fallback, not the redirect follower, and not the (absent) target restriction
// that made it a port-probe for anything running in the page.
//
// The pure halves are unit-tested. The machinery (redirects, the fallback) is
// exercised against a local http.createServer through the injected fence — the
// route itself always uses the real one, which is what refuses loopback, so the
// two concerns are tested separately rather than by weakening the gate.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { URL } = require('url');
const {
  fetchHead, classify, refuseTarget, isPrivateAddress, publicOnlyLookup,
} = require('../lib/server/routes/embed');
const { withServer } = require('../test-support/helpers');

// The open fence: allow every target, resolve normally. Only tests pass this.
const OPEN = { refuse: () => null, lookup: undefined };

async function localServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

// --- the target fence --------------------------------------------------------

test('isPrivateAddress covers both families and the v4-mapped middle ground', () => {
  const table = [
    ['127.0.0.1', true], ['127.9.9.9', true], ['0.0.0.0', true],
    ['10.1.2.3', true], ['172.16.0.1', true], ['172.31.255.255', true],
    ['192.168.1.1', true], ['169.254.169.254', true], ['100.64.0.1', true],
    ['198.18.0.1', true], ['224.0.0.1', true], ['255.255.255.255', true],
    ['172.32.0.1', false], ['100.128.0.1', false], ['8.8.8.8', false], ['1.1.1.1', false],
    ['::1', true], ['[::1]', true], ['::', true],
    ['fc00::1', true], ['fd12:3456::1', true], ['fe80::1', true], ['ff02::1', true],
    ['::ffff:127.0.0.1', true], ['::ffff:8.8.8.8', false],
    // The spellings a table of text prefixes misses: WHATWG URL re-serialises
    // [::ffff:127.0.0.1] into hex form, and loopback may be written uncompressed.
    ['::ffff:7f00:1', true, 'the hex form of ::ffff:127.0.0.1'],
    ['::ffff:a9fe:a9fe', true, 'the hex form of the cloud metadata address'],
    ['::ffff:0808:0808', false, '…and the hex form of a public one is still public'],
    ['0:0:0:0:0:0:0:1', true, 'uncompressed loopback'],
    ['0:0:0:0:0:0:0:0', true, 'uncompressed unspecified'],
    ['2606:4700:4700::1111', false],
    ['1:2:3:4:5:6:7:8', false, 'a full public literal'],
    ['1:2:3:4:5:6:7:8:9', true, 'nine groups is not an address — fail closed'],
    ['::1::2', true, 'nor is a second :: — fail closed'],
    ['999.1.1.1', true, 'an unparseable literal fails closed'],
    [null, true, 'so does a non-string'],
  ];
  for (const [ip, want, why] of table) {
    assert.equal(isPrivateAddress(ip), want, `${ip} ${why || ''}`);
  }
});

test('refuseTarget: only public http(s) hosts survive', () => {
  const refuse = (u) => refuseTarget(new URL(u));
  assert.equal(refuse('https://example.com/x'), null);
  assert.equal(refuse('http://example.com:8080/x'), null);

  assert.match(refuse('file:///etc/passwd'), /unsupported protocol/);
  assert.match(refuse('ftp://example.com/'), /unsupported protocol/);

  // The port probe the finding is about, in every spelling the URL parser
  // normalises into a loopback literal.
  for (const u of [
    'http://127.0.0.1:5173/api/store',
    'http://2130706433:5173/api/store',
    'http://0177.0.0.1:5173/',
    'http://[::1]:5173/',
    'http://localhost:5173/',
    'http://anything.localhost/',
    'http://10.0.0.5/', 'http://192.168.0.1/', 'http://169.254.169.254/latest/meta-data/',
  ]) {
    assert.match(refuse(u), /not a public host/, u);
  }
});

test('publicOnlyLookup: a NAME that resolves to loopback never reaches the socket', async () => {
  // The half refuseTarget cannot see: `evil.example` is a perfectly ordinary
  // name until DNS answers 127.0.0.1. Filtering here rather than after the fact
  // is what makes it rebind-proof — the socket is only ever handed survivors.
  const lookup = (opts) => new Promise((resolve) => {
    publicOnlyLookup('localhost', opts, (err, address) => resolve({ err, address }));
  });

  const one = await lookup({ family: 4 });
  assert.ok(one.err, 'refused');
  assert.match(one.err.message, /not a public host/);

  // Node 20+ asks for every address at once (autoSelectFamily); an all-private
  // answer must still be a refusal, not an empty list handed to connect().
  const all = await lookup({ all: true });
  assert.ok(all.err, 'refused in the all:true shape too');

  // A public answer passes through untouched. An address literal resolves
  // without touching the network, so this stays hermetic.
  const ok = await new Promise((resolve) => {
    publicOnlyLookup('8.8.8.8', { family: 4 }, (err, address) => resolve({ err, address }));
  });
  assert.equal(ok.err, null);
  assert.equal(ok.address, '8.8.8.8');
});

test('the route refuses a private target and never connects to it', async (t) => {
  const { api, port } = await withServer(t);
  // Point it at the daemon's own port — the probe the finding describes.
  const r = await api.get('/api/embed-check?url=' + encodeURIComponent(`http://127.0.0.1:${port}/api/store`));
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.reachable, false);
  assert.match(r.json.reason, /not a public host/);
  assert.equal(r.json.status, undefined, 'no status leaks back, so it is not a port oracle');

  const scheme = await api.get('/api/embed-check?url=' + encodeURIComponent('file:///etc/passwd'));
  assert.match(scheme.json.reason, /unsupported protocol/);

  const missing = await api.get('/api/embed-check');
  assert.equal(missing.status, 400);
});

test('a redirect to a private host is refused on the hop, not followed', async (t) => {
  let reachedSecret = false;
  const secret = await localServer(t, (req, res) => { reachedSecret = true; res.end('nope'); });
  const hop = await localServer(t, (req, res) => {
    res.writeHead(302, { location: secret + '/inner' });
    res.end();
  });

  // The hop itself is allowed through the open fence; the REAL fence still
  // decides each hop, which is the property under test.
  const r = await fetchHead(hop + '/start', 'HEAD', 4, {
    refuse: (u) => (u.pathname === '/start' ? null : 'target is not a public host'),
    lookup: undefined,
  });
  assert.match(r.error, /not a public host/);
  assert.equal(reachedSecret, false, 'the second hop was never dialled');
});

// --- the machinery, pinned for the first time --------------------------------

test('classify: the X-Frame-Options and frame-ancestors table', () => {
  assert.equal(classify({}).blocked, false);
  assert.equal(classify({ 'x-frame-options': 'DENY' }).blocked, true);
  assert.match(classify({ 'x-frame-options': 'deny' }).reason, /DENY/);
  assert.equal(classify({ 'x-frame-options': 'SAMEORIGIN' }).blocked, true);
  assert.equal(classify({ 'x-frame-options': 'ALLOW-FROM https://x.example' }).blocked, true);
  assert.equal(classify({ 'content-security-policy': "frame-ancestors 'none'" }).blocked, true);
  assert.equal(classify({ 'content-security-policy': 'frame-ancestors *' }).blocked, false);
  assert.equal(classify({ 'content-security-policy': 'frame-ancestors http://localhost:5173' }).blocked, false);
  assert.equal(classify({ 'content-security-policy': 'frame-ancestors https://other.example' }).blocked, true);
  assert.equal(classify({ 'content-security-policy': "default-src 'self'" }).blocked, false,
    'a CSP without frame-ancestors says nothing about framing');
});

test('HEAD→GET fallback: a server that refuses HEAD is still classified', async (t) => {
  const seen = [];
  const base = await localServer(t, (req, res) => {
    seen.push(req.method);
    if (req.method === 'HEAD') { res.writeHead(405); return res.end(); }
    res.writeHead(200, { 'x-frame-options': 'DENY' });
    res.end('<html></html>');
  });

  const r = await fetchHead(base + '/p', 'HEAD', 4, OPEN);
  assert.equal(r.status, 405, 'HEAD alone reports the refusal…');
  const fallback = await fetchHead(base + '/p', 'GET', 4, OPEN);
  assert.equal(fallback.status, 200, '…and GET is what the route falls back to');
  assert.equal(classify(fallback.headers).blocked, true);
  assert.deepEqual(seen, ['HEAD', 'GET']);
});

test('userinfo credentials are stripped from the URL we report and follow', async (t) => {
  const base = await localServer(t, (req, res) => {
    assert.equal(req.headers.authorization, undefined, 'never turned into an Authorization header');
    res.writeHead(200);
    res.end();
  });
  const withCreds = base.replace('http://', 'http://user:secret@');
  const r = await fetchHead(withCreds + '/p', 'HEAD', 4, OPEN);
  assert.equal(r.status, 200);
  assert.ok(!/secret/.test(r.finalUrl), `finalUrl still carried credentials: ${r.finalUrl}`);
});
