// lib/relay's embedded-mode options (U712; C-06.30 to C-06.33, C-06.31 as
// A-06.2 replaces it, C-06.29a). Each is an OPTION the connector passes and
// the portal never does, so:
//   * with none given, every function returns exactly U711's pinned objects
//     (the portal's bytes, RELAY@portal-bytes);
//   * `ancestors` frames the surface, the previews and the answer host by the
//     assignment's origins verbatim, port included, with no X-Frame-Options,
//     and writes only the ENFORCED policy (the daemon's report-only one passes
//     through untouched);
//   * forwardHeaders' `stamp` is set after the allowlist, X-WC-Remote last;
//   * embedHeaders rides proxyHttp's extraHeaders seam on a health read;
//   * csrfRefusal's `embedded` admits the shell's same-site iframe navigation
//     to / and nothing else.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const relay = require('../lib/relay');
const { csrfRefusal } = require('../lib/portal');
const { SURFACE_CSP_REPORT_ONLY } = require('../lib/core/cors');

const pin = (got, want) => {
  assert.deepStrictEqual(got, want);
  assert.deepStrictEqual(Object.keys(got), Object.keys(want), 'header order');
};

const SHELL = 'https://hub.test:8443';
const SURFACE = 'https://chat-01jc3h5k7m9n1p3q5r7s9t1v3w.hub.test:8443';

// ---------------------------------------------------------------------------
// 1. No option: U711's pins, unchanged.

test('relay-embed: with no option every function returns U711\'s pinned objects', () => {
  for (const opts of [{}, { ancestors: null }, { ancestors: undefined }]) {
    // 1. A session document.
    pin(relay.responseHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      Connection: 'keep-alive',
      'Set-Cookie': ['s=1; HttpOnly'],
      'Transfer-Encoding': 'chunked',
      ETag: '"abc"',
    }, '/', opts), {
      'content-type': 'text/html; charset=utf-8',
      etag: '"abc"',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
    });
    // 2. A preview document.
    pin(relay.responseHeaders({
      'content-type': 'text/html',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'",
    }, '/preview/node/n1', opts), {
      'content-type': 'text/html',
      'content-security-policy': ["default-src 'none'; script-src 'unsafe-inline'", "frame-ancestors 'self'"],
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'cache-control': 'no-store',
    });
    // 3. An API path with the portal's extra header.
    pin(relay.responseHeaders({
      'content-type': 'application/json',
      'cache-control': 'max-age=60',
      'keep-alive': 'timeout=5',
    }, '/api/health', { ...opts, extraHeaders: { 'X-WC-Answer-Origin': 'https://s1-a.example.com' } }), {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-wc-answer-origin': 'https://s1-a.example.com',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
    });
    // 4. The answer mode.
    pin(relay.responseHeaders({
      'content-type': 'text/html',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors http://127.0.0.1:4100",
    }, '/answer/ask/a1', { ...opts, mode: 'answer', sessionHost: 's1.example.com' }), {
      'content-type': 'text/html',
      'content-security-policy': "default-src 'self'; frame-ancestors https://s1.example.com",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
  }

  // securityHeaders, as the portal's picker and refusals call it.
  pin(relay.securityHeaders('/'), {
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  });
  pin(relay.securityHeaders('/api/x'), {
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'cache-control': 'no-store',
  });
  pin(relay.securityHeaders('/replay'), {
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN', 'cache-control': 'no-store',
  });
  pin(relay.securityHeaders('/', { frameSelf: true }), {
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN',
  });

  // forwardHeaders, with no stamp (null and undefined alike).
  const incoming = {
    Accept: 'text/event-stream', 'Last-Event-ID': '41', 'Sec-Fetch-Site': 'same-origin',
    Cookie: 'CF_Authorization=x', 'X-WC-Token': 't', 'X-WC-Remote': '0', 'X-WC-Answer': 'nonce',
  };
  for (const stamp of [undefined, null]) {
    pin(relay.forwardHeaders(incoming, { port: 5999, origin: true, stamp }), {
      accept: 'text/event-stream', 'last-event-id': '41', 'sec-fetch-site': 'same-origin',
      origin: 'http://localhost:5999', 'x-wc-remote': '1',
    });
    pin(relay.forwardHeaders(incoming, { port: 4100, origin: true, mode: 'answer', stamp }), {
      accept: 'text/event-stream', 'last-event-id': '41', 'sec-fetch-site': 'same-origin',
      'x-wc-answer': 'nonce', origin: 'http://127.0.0.1:4100', 'x-wc-remote': '1',
    });
  }
});

// ---------------------------------------------------------------------------
// 2. The ancestors option.

test('relay-embed: a surface document and a preview are framed by the shell, port included, with no X-Frame-Options', () => {
  const root = relay.responseHeaders({
    'content-type': 'text/html',
    'x-frame-options': 'DENY',
  }, '/', { ancestors: { shell: SHELL } });
  pin(root, {
    'content-type': 'text/html',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'frame-ancestors https://hub.test:8443',
  });
  assert.equal(root['x-frame-options'], undefined, 'the daemon\'s X-Frame-Options is gone');

  const preview = relay.responseHeaders({
    'content-type': 'text/html',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'",
  }, '/preview/node/n1', { ancestors: { shell: SHELL } });
  pin(preview, {
    'content-type': 'text/html',
    'content-security-policy': ["default-src 'none'; script-src 'unsafe-inline'", "frame-ancestors 'self' https://hub.test:8443"],
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  // The appended policy is the LAST one (added beside the daemon's, never
  // loosening it).
  assert.equal(preview['content-security-policy'].at(-1), "frame-ancestors 'self' https://hub.test:8443");

  // Every preview path takes 'self' <shell>.
  for (const p of ['/preview/pane/n1/p1', '/replay']) {
    const h = relay.responseHeaders({}, p, { ancestors: { shell: SHELL } });
    assert.equal(h['content-security-policy'], "frame-ancestors 'self' https://hub.test:8443", p);
    assert.equal(h['x-frame-options'], undefined, p);
    assert.equal(h['cache-control'], 'no-store', p);
  }

  // An API path is a surface response like the root.
  const api = relay.responseHeaders({ 'content-type': 'application/json' }, '/api/graph', { ancestors: { shell: SHELL } });
  pin(api, {
    'content-type': 'application/json',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'content-security-policy': 'frame-ancestors https://hub.test:8443',
  });

  // A hub on 443 has no port (A-06.2: the serializer drops it) — used verbatim.
  const prod = relay.responseHeaders({}, '/', { ancestors: { shell: 'https://hub.example.org' } });
  assert.equal(prod['content-security-policy'], 'frame-ancestors https://hub.example.org');
  assert.equal(prod['x-frame-options'], undefined);
  const prodPreview = relay.responseHeaders({}, '/preview/node/n1', { ancestors: { shell: 'https://hub.example.org' } });
  assert.equal(prodPreview['content-security-policy'], "frame-ancestors 'self' https://hub.example.org");
});

test('relay-embed: the answer host is framed by the surface then the shell, one directive, no X-Frame-Options', () => {
  pin(relay.responseHeaders({
    'content-type': 'text/html',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; frame-ancestors http://127.0.0.1:5199",
  }, '/answer/ask/a1', { mode: 'answer', sessionHost: 's1.example.com', ancestors: { surface: SURFACE, shell: SHELL } }), {
    'content-type': 'text/html',
    'content-security-policy': `default-src 'self'; frame-ancestors ${SURFACE} ${SHELL}`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  // No daemon CSP: the directive alone.
  pin(relay.responseHeaders({}, '/answer/ask/a1', { mode: 'answer', ancestors: { surface: SURFACE, shell: SHELL } }), {
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'content-security-policy': `frame-ancestors ${SURFACE} ${SHELL}`,
  });
  // The answer mode needs the surface.
  assert.throws(() => relay.responseHeaders({}, '/x', { mode: 'answer', ancestors: { shell: SHELL } }), TypeError);
});

test('relay-embed: the daemon\'s report-only CSP passes through once, byte-equal, never written to', () => {
  for (const [p, opts] of [
    ['/', { ancestors: { shell: SHELL } }],
    ['/preview/node/n1', { ancestors: { shell: SHELL } }],
    ['/', {}],
  ]) {
    const h = relay.responseHeaders({
      'content-type': 'text/html',
      'Content-Security-Policy-Report-Only': SURFACE_CSP_REPORT_ONLY,
    }, p, opts);
    assert.strictEqual(h['content-security-policy-report-only'], SURFACE_CSP_REPORT_ONLY, p);
    assert.equal(Object.keys(h).filter((k) => k === 'content-security-policy-report-only').length, 1);
    assert.ok(!/frame-ancestors/.test(h['content-security-policy-report-only']), 'no frame-ancestors in the report-only policy');
    assert.equal(typeof h['content-security-policy'], 'string', 'the enforced policy is the one written');
  }
});

test('relay-embed: isAncestorOrigin admits https origins with a 1–65535 port, and responseHeaders throws on anything else', () => {
  for (const ok of [SHELL, SURFACE, 'https://hub.example.org', 'https://a.test:1', 'https://a.test:65535']) {
    assert.equal(relay.isAncestorOrigin(ok), true, ok);
  }
  const BAD = [
    'https://hub.test:08443', 'https://hub.test:0', 'https://hub.test:123456', 'https://hub.test/',
    'http://hub.test', "https://a.test 'unsafe-inline'", 'https://a.test;b',
    'https://a.test:65536', 'https://a.test,https://b.test', 'https://a.test?x', 'https://a.test\n',
    'https://a.test:', '"https://a.test"', 'https://A.test', '', null, undefined, 42, {},
  ];
  for (const bad of BAD) {
    assert.equal(relay.isAncestorOrigin(bad), false, JSON.stringify(bad));
    assert.throws(() => relay.responseHeaders({}, '/', { ancestors: { shell: bad } }), TypeError, `shell ${JSON.stringify(bad)}`);
    assert.throws(() => relay.responseHeaders({}, '/x', { mode: 'answer', ancestors: { surface: bad, shell: SHELL } }), TypeError, `surface ${JSON.stringify(bad)}`);
    assert.throws(() => relay.embedHeaders({ shell: bad }), TypeError);
  }
  assert.throws(() => relay.responseHeaders({}, '/', { ancestors: 'https://hub.test' }), TypeError);
});

// ---------------------------------------------------------------------------
// 3. The upstream stamp.

test('relay-embed: forwardHeaders sets the caller\'s stamp after the allowlist, X-WC-Remote last', () => {
  const incoming = {
    Accept: 'application/json',
    'Sec-Fetch-Site': 'same-origin',
    'X-WC-Level': 'full',
    'x-wc-decision': 'viewer-made',
    'X-WC-Remote': '0',
  };
  const stamp = { 'x-wc-level': 'read', 'x-wc-decision': 'dec_01jc3h5k7m9n1p3q5r7s9t1v3w' };
  const out = relay.forwardHeaders(incoming, { port: 5999, origin: true, stamp });
  pin(out, {
    accept: 'application/json',
    'sec-fetch-site': 'same-origin',
    origin: 'http://localhost:5999',
    'x-wc-level': 'read',
    'x-wc-decision': 'dec_01jc3h5k7m9n1p3q5r7s9t1v3w',
    'x-wc-remote': '1',
  });
  assert.equal(Object.keys(out).at(-1), 'x-wc-remote', 'X-WC-Remote is the last key');

  // The answer mode takes the stamp the same way.
  const answer = relay.forwardHeaders({ ...incoming, 'X-WC-Answer': 'n' }, { port: 4100, origin: true, mode: 'answer', stamp });
  assert.deepStrictEqual(Object.keys(answer),
    ['accept', 'sec-fetch-site', 'x-wc-answer', 'origin', 'x-wc-level', 'x-wc-decision', 'x-wc-remote']);

  for (const bad of [
    { 'x-wc-remote': '0' }, { 'X-Foo': '1' }, { 'X-WC-Level': 'read' }, { 'x-foo': '1' },
    { 'x-wc-': '1' }, { 'x-wc-l3vel': '1' }, { 'x-wc-level': 1 }, { 'x-wc-level': ['read'] }, 'x-wc-level', [],
  ]) {
    assert.throws(() => relay.forwardHeaders(incoming, { port: 5999, stamp: bad }), TypeError, JSON.stringify(bad));
  }
});

test('relay-embed: lib/relay spells no 03/04 header name', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'lib', 'relay');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/x-wc-(relay|actor|level|grants|decision)\b/i.test(src), `lib/relay/${f} spells a 03/04 header`);
  }
});

// ---------------------------------------------------------------------------
// 4. The health embed headers, through proxyHttp.

test('relay-embed: embedHeaders and isHealthRead', () => {
  pin(relay.embedHeaders({ shell: SHELL }), { 'x-wc-embedded': '1', 'x-wc-embed-parent': SHELL });
  pin(relay.embedHeaders({ shell: 'https://hub.example.org' }), { 'x-wc-embedded': '1', 'x-wc-embed-parent': 'https://hub.example.org' });
  assert.throws(() => relay.embedHeaders(), TypeError);
  assert.equal(relay.isHealthRead('GET', '/api/health'), true);
  assert.equal(relay.isHealthRead('HEAD', '/api/health'), true);
  assert.equal(relay.isHealthRead('POST', '/api/health'), false);
  assert.equal(relay.isHealthRead('GET', '/api/health/x'), false);
  assert.equal(relay.isHealthRead('GET', '/api/healthz'), false);
  assert.equal(relay.isHealthRead('GET', '/'), false);
});

async function listen(t, handler) {
  const srv = http.createServer(handler);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  return srv.address().port;
}

test('relay-embed: proxyHttp carries the embed headers over the daemon\'s, the stamp upstream, and the ancestors downstream', async (t) => {
  let seen = null;
  const daemon = await listen(t, (req, res) => {
    seen = req.headers;
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-wc-embedded': '0',
      'x-frame-options': 'DENY',
    });
    res.end('{"ok":true}');
  });
  const front = await listen(t, (req, res) => {
    const pathname = relay.pathnameOf(req.url);
    relay.proxyHttp(req, res, {
      port: daemon,
      origin: false,
      ancestors: { shell: SHELL },
      stamp: { 'x-wc-level': 'read' },
      extraHeaders: relay.isHealthRead(req.method, pathname) ? relay.embedHeaders({ shell: SHELL }) : null,
    });
  });
  const r = await fetch(`http://127.0.0.1:${front}/api/health`, { headers: { 'x-wc-level': 'full', 'x-wc-remote': '0' } });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '{"ok":true}');
  assert.equal(r.headers.get('x-wc-embedded'), '1', 'the daemon\'s own x-wc-embedded is replaced');
  assert.equal(r.headers.get('x-wc-embed-parent'), SHELL);
  assert.equal(r.headers.get('x-frame-options'), null);
  assert.equal(r.headers.get('content-security-policy'), `frame-ancestors ${SHELL}`);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(seen['x-wc-level'], 'read', 'the stamp reached the daemon, not the viewer\'s value');
  assert.equal(seen['x-wc-remote'], '1');

  // A non-health path gets no embed headers.
  const r2 = await fetch(`http://127.0.0.1:${front}/api/graph`);
  await r2.text();
  assert.equal(r2.headers.get('x-wc-embedded'), '0', 'the daemon\'s header is passed through untouched off health');
  assert.equal(r2.headers.get('x-wc-embed-parent'), null);
});

test('relay-embed: proxyHttp\'s 502 in the embedded mode has no X-Frame-Options; a bad option is never a 502', async (t) => {
  const { freePort } = require('../test-support/helpers');
  const closed = await freePort();
  let upstreamErrors = 0;
  const front = await listen(t, (req, res) => {
    relay.proxyHttp(req, res, {
      port: closed, origin: false, ancestors: { shell: SHELL }, onUpstreamError: () => { upstreamErrors += 1; },
    });
  });
  const r = await fetch(`http://127.0.0.1:${front}/api/health`);
  assert.equal(r.status, 502);
  assert.equal(await r.text(), JSON.stringify(relay.NOT_ANSWERING));
  assert.equal(r.headers.get('x-frame-options'), null);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(upstreamErrors, 1);

  // A malformed stamp or ancestors rejects before anything is sent.
  const fakeReq = { method: 'GET', url: '/', headers: {} };
  const fakeRes = { headersSent: false, writeHead() { throw new Error('written'); }, end() {}, destroy() {}, on() {} };
  let errors = 0;
  await assert.rejects(relay.proxyHttp(fakeReq, fakeRes, {
    port: closed, stamp: { 'x-wc-remote': '0' }, onUpstreamError: () => { errors += 1; },
  }), TypeError);
  await assert.rejects(relay.proxyHttp(fakeReq, fakeRes, {
    port: closed, ancestors: { shell: 'http://hub.test' }, onUpstreamError: () => { errors += 1; },
  }), TypeError);
  assert.equal(errors, 0, 'a programming error is not a daemon that is down');
});

// ---------------------------------------------------------------------------
// 5. csrfRefusal's iframe admission.

test('relay-embed: csrfRefusal admits the same-site iframe navigation to / only with {embedded: true}', () => {
  const ORIGIN = 'https://chat-01jc3h5k7m9n1p3q5r7s9t1v3w.hub.test:8443';
  const req = (over = {}, headers = {}) => ({
    method: 'GET',
    url: '/',
    ...over,
    headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-site', ...headers },
  });
  const SAME_SITE = { status: 403, body: { ok: false, remote: true, error: 'same-site request refused' } };

  assert.deepStrictEqual(csrfRefusal(req(), ORIGIN), SAME_SITE, 'refused without the option');
  assert.deepStrictEqual(csrfRefusal(req(), ORIGIN, {}), SAME_SITE);
  assert.equal(csrfRefusal(req(), ORIGIN, { embedded: true }), null, 'admitted with it');
  assert.equal(csrfRefusal(req({ method: 'HEAD' }), ORIGIN, { embedded: true }), null);
  assert.equal(csrfRefusal(req({ url: '/?x=1' }), ORIGIN, { embedded: true }), null, 'the query is not the path');

  // dest document: today's top-level rule, both ways.
  assert.equal(csrfRefusal(req({}, { 'sec-fetch-dest': 'document' }), ORIGIN), null);
  assert.equal(csrfRefusal(req({}, { 'sec-fetch-dest': 'document' }), ORIGIN, { embedded: true }), null);

  // Refused even with the option.
  assert.ok(csrfRefusal(req({ method: 'POST' }), ORIGIN, { embedded: true }), 'a POST');
  assert.ok(csrfRefusal(req({ method: 'POST' }, { origin: ORIGIN }), ORIGIN, { embedded: true }), 'a POST with the origin');
  assert.deepStrictEqual(csrfRefusal(req({ url: '/api/x' }), ORIGIN, { embedded: true }), SAME_SITE, 'a path other than /');
  assert.deepStrictEqual(csrfRefusal(req({}, { 'sec-fetch-site': 'cross-site' }), ORIGIN, { embedded: true }),
    { status: 403, body: { ok: false, remote: true, error: 'cross-site request refused' } }, 'cross-site');
  assert.ok(csrfRefusal(req({}, { origin: ORIGIN }), ORIGIN, { upgrade: true, embedded: true }), 'an upgrade');
  assert.ok(csrfRefusal(req({}, { 'sec-fetch-mode': 'no-cors' }), ORIGIN, { embedded: true }), 'not a navigation');
  assert.ok(csrfRefusal(req({}, { 'sec-fetch-dest': 'embed' }), ORIGIN, { embedded: true }), 'not an iframe');
  assert.ok(csrfRefusal(req({}, { origin: 'https://hub.test:8443' }), ORIGIN, { embedded: true }), 'a foreign Origin');
});

test('relay-embed: the portal passes no option and keeps protocol 12', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'portal', 'index.js'), 'utf8');
  assert.ok(!/\bembedded\s*:\s*true/.test(src), 'the portal never passes embedded');
  assert.ok(!/\bancestors\s*:/.test(src), 'the portal never passes ancestors');
  assert.ok(!/\bstamp\s*:/.test(src), 'the portal never passes a stamp');
  const { PORTAL_PROTOCOL_VERSION } = require('../lib/core/versions');
  assert.equal(PORTAL_PROTOCOL_VERSION, 12);
});
