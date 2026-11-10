// lib/relay: the relay code the tunnel portal and the connector share (C-06.4
// step 7, 05 §4), moved out of lib/portal byte-identical (U711). Pinned here:
//   * every moved name is exported by lib/relay and DEFINED once, under it;
//   * the portal re-exports the very same objects (nothing copied);
//   * the bytes the portal answers with: proxyHttp's 502 body, and
//     responseHeaders for four inputs — the baseline a later option must leave
//     untouched;
//   * lib/relay's own requires stay in its layer;
//   * the identity engine: the portal's role-and-pid probe, and the memo.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { builtinModules } = require('module');
const { freePort } = require('../test-support/helpers');

const relay = require('../lib/relay');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIB = path.join(REPO_ROOT, 'lib');
const RELAY_DIR = path.join(LIB, 'relay');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join('/');

// name → how its definition is spelled.
const MOVED = {
  FORWARD: 'const', HOP_BY_HOP: 'const', NOT_ANSWERING: 'const',
  PORT_MEMO_MS: 'const', PORT_TIMEOUT_MS: 'const',
  START_EVERY_MS: 'const', START_WAIT_MS: 'const', IDENTITY_TIMEOUT_MS: 'const',
  forwardHeaders: 'function', responseHeaders: 'function', securityHeaders: 'function',
  answerSecurityHeaders: 'function', isPreviewPath: 'function', pathnameOf: 'function',
  proxyHttp: 'function', createAnswerPorts: 'function',
  probeHealthIdentity: 'function', createIdentityCheck: 'function',
};

test('relay: every moved name is exported by lib/relay and defined once, under lib/relay', () => {
  const files = walk(LIB).map((f) => [rel(f), fs.readFileSync(f, 'utf8')]);
  for (const [name, kind] of Object.entries(MOVED)) {
    assert.ok(Object.prototype.hasOwnProperty.call(relay, name), `lib/relay exports ${name}`);
    assert.notEqual(relay[name], undefined, `lib/relay's ${name} is defined`);
    const re = kind === 'const'
      ? new RegExp(`\\bconst ${name} =`, 'g')
      : new RegExp(`\\b(?:async )?function ${name}\\(`, 'g');
    const hits = [];
    for (const [f, src] of files) for (const _ of src.matchAll(re)) hits.push(f);
    assert.equal(hits.length, 1, `${name} defined exactly once under lib/ (found in: ${hits.join(', ') || 'nowhere'})`);
    assert.ok(hits[0].startsWith('lib/relay/'), `${name} is defined under lib/relay/ (found in ${hits[0]})`);
  }
});

test('relay: the portal re-exports the same objects', () => {
  const proxy = require('../lib/portal/proxy');
  const EIGHT = ['proxyHttp', 'forwardHeaders', 'responseHeaders', 'securityHeaders',
    'answerSecurityHeaders', 'pathnameOf', 'isPreviewPath', 'FORWARD'];
  assert.deepStrictEqual(Object.keys(proxy).sort(), [...EIGHT].sort(), 'lib/portal/proxy keeps exactly its eight names');
  for (const n of EIGHT) assert.strictEqual(proxy[n], relay[n], `lib/portal/proxy ${n} is lib/relay's`);

  const answer = require('../lib/portal/answer');
  assert.strictEqual(answer.createAnswerPorts, relay.createAnswerPorts);
  assert.strictEqual(answer.PORT_MEMO_MS, relay.PORT_MEMO_MS);
  assert.strictEqual(relay.PORT_MEMO_MS, 1000);
  assert.strictEqual(relay.PORT_TIMEOUT_MS, 3000);

  const start = require('../lib/portal/start');
  assert.strictEqual(start.START_EVERY_MS, 10000);
  assert.strictEqual(start.START_WAIT_MS, 15000);
  assert.strictEqual(start.START_EVERY_MS, relay.START_EVERY_MS);
  assert.strictEqual(start.START_WAIT_MS, relay.START_WAIT_MS);

  assert.strictEqual(relay.IDENTITY_TIMEOUT_MS, 5000);
});

const NOT_ANSWERING_BYTES = '{"ok":false,"remote":true,"error":"this session\'s daemon is not answering — it may have just stopped"}';

test('relay: proxyHttp to a closed loopback port writes the 502 and its exact bytes', async (t) => {
  const closed = await freePort();
  let upstreamErrors = 0;
  const front = http.createServer((req, res) => {
    relay.proxyHttp(req, res, { port: closed, origin: false, onUpstreamError: () => { upstreamErrors += 1; } });
  });
  await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => front.close(resolve)));
  const r = await fetch(`http://127.0.0.1:${front.address().port}/api/health`);
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 502);
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(bytes.equals(Buffer.from(NOT_ANSWERING_BYTES, 'utf8')), `502 body bytes: ${bytes.toString('utf8')}`);
  assert.equal(JSON.stringify(relay.NOT_ANSWERING), NOT_ANSWERING_BYTES);
  assert.equal(upstreamErrors, 1);

  // One spelling of the text under lib/.
  const text = 'daemon is not answering — it may have just stopped';
  const hits = [];
  for (const f of walk(LIB)) {
    const src = fs.readFileSync(f, 'utf8');
    for (const _ of src.matchAll(new RegExp(text, 'g'))) hits.push(rel(f));
  }
  assert.deepStrictEqual(hits, ['lib/relay/http.js']);
});

// Literal expected objects, key order included (writeHead writes them in this
// order). These are the portal's bytes at 089783b9.
test('relay: responseHeaders is pinned for four inputs', () => {
  const pin = (got, want) => {
    assert.deepStrictEqual(got, want);
    assert.deepStrictEqual(Object.keys(got), Object.keys(want), 'header order');
  };

  // 1. A session document.
  pin(relay.responseHeaders({
    'Content-Type': 'text/html; charset=utf-8',
    Connection: 'keep-alive',
    'Set-Cookie': ['s=1; HttpOnly'],
    'Transfer-Encoding': 'chunked',
    ETag: '"abc"',
  }, '/'), {
    'content-type': 'text/html; charset=utf-8',
    etag: '"abc"',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
  });

  // 2. A preview document: framed by the same origin, the daemon's CSP kept
  // beside the portal's.
  pin(relay.responseHeaders({
    'content-type': 'text/html',
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'",
  }, '/preview/node/n1'), {
    'content-type': 'text/html',
    'content-security-policy': ["default-src 'none'; script-src 'unsafe-inline'", "frame-ancestors 'self'"],
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'cache-control': 'no-store',
  });

  // 3. An API path, with the portal's extra header.
  pin(relay.responseHeaders({
    'content-type': 'application/json',
    'cache-control': 'max-age=60',
    'keep-alive': 'timeout=5',
  }, '/api/health', { extraHeaders: { 'X-WC-Answer-Origin': 'https://s1-a.example.com' } }), {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-wc-answer-origin': 'https://s1-a.example.com',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
  });

  // 4. The answer mode: no X-Frame-Options, the daemon's frame-ancestors
  // replaced by the session host's, no-store.
  pin(relay.responseHeaders({
    'content-type': 'text/html',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; frame-ancestors http://127.0.0.1:4100",
  }, '/answer/ask/a1', { mode: 'answer', sessionHost: 's1.example.com' }), {
    'content-type': 'text/html',
    'content-security-policy': "default-src 'self'; frame-ancestors https://s1.example.com",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
});

// The request leg's bytes: the allowlist's members and forwardHeaders' output
// in both modes, as literal expected objects (key order included).
test('relay: the request allowlist and forwardHeaders are pinned', () => {
  assert.deepStrictEqual([...relay.FORWARD], [
    'accept', 'accept-language', 'content-type', 'content-length',
    'if-none-match', 'if-modified-since', 'range', 'user-agent', 'last-event-id',
  ]);
  const incoming = {
    Accept: 'text/event-stream',
    'Last-Event-ID': '41',
    'Sec-Fetch-Site': 'same-origin',
    Cookie: 'CF_Authorization=x',
    Authorization: 'Bearer y',
    'X-WC-Token': 't',
    'X-WC-Remote': '0',
    'X-WC-Answer': 'nonce',
    'CF-Connecting-IP': '1.2.3.4',
    'X-Forwarded-For': '1.2.3.4',
    Range: null,
  };
  const session = relay.forwardHeaders(incoming, { port: 5999, origin: true });
  assert.deepStrictEqual(session, {
    accept: 'text/event-stream',
    'last-event-id': '41',
    'sec-fetch-site': 'same-origin',
    origin: 'http://localhost:5999',
    'x-wc-remote': '1',
  });
  assert.deepStrictEqual(Object.keys(session), ['accept', 'last-event-id', 'sec-fetch-site', 'origin', 'x-wc-remote']);
  const answer = relay.forwardHeaders(incoming, { port: 4100, origin: true, mode: 'answer' });
  assert.deepStrictEqual(Object.keys(answer), ['accept', 'last-event-id', 'sec-fetch-site', 'x-wc-answer', 'origin', 'x-wc-remote']);
  assert.equal(answer['x-wc-answer'], 'nonce');
  assert.equal(answer.origin, 'http://127.0.0.1:4100');
  assert.equal(answer['x-wc-remote'], '1');
  assert.deepStrictEqual(Object.keys(relay.forwardHeaders(incoming, { port: 5999 })),
    ['accept', 'last-event-id', 'sec-fetch-site', 'x-wc-remote'], 'no origin unless the caller matched it');
});

test('relay: lib/relay requires node builtins, ws, lib/client and lib/core only', () => {
  const builtins = new Set(builtinModules);
  const files = fs.readdirSync(RELAY_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 6, 'lib/relay holds its files');
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(RELAY_DIR, f), 'utf8');
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1];
      const ok = spec.startsWith('node:') || builtins.has(spec) || spec === 'ws'
        || spec === '../client' || /^\.\.\/client\//.test(spec) || /^\.\.\/core\//.test(spec)
        || /^\.\/[\w-]+(\.js)?$/.test(spec);
      if (!ok) offenders.push(`lib/relay/${f} => ${spec}`);
    }
  }
  assert.deepStrictEqual(offenders, []);
});

async function healthStub(t, answer) {
  const srv = http.createServer((req, res) => {
    const a = answer(req);
    res.writeHead(a.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(a.body || {}));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  return srv.address().port;
}

test('relay: probeHealthIdentity is the portal\'s role-and-pid rule', async (t) => {
  const P = 424242;
  const okPort = await healthStub(t, (req) => (req.url === '/api/health'
    ? { body: { ok: true, role: 'instance', pid: P } } : { status: 404 }));
  assert.equal(await relay.probeHealthIdentity({ id: 'a', port: okPort, pid: P }), 'ok');
  assert.equal(await relay.probeHealthIdentity({ id: 'a', port: okPort, pid: P + 1 }), 'mismatch');
  const hubPort = await healthStub(t, () => ({ body: { ok: true, role: 'hub', pid: P } }));
  assert.equal(await relay.probeHealthIdentity({ id: 'a', port: hubPort, pid: P }), 'mismatch');
  const errPort = await healthStub(t, () => ({ status: 500, body: { ok: false } }));
  assert.equal(await relay.probeHealthIdentity({ id: 'a', port: errPort, pid: P }), 'mismatch');
  const closed = await freePort();
  assert.equal(await relay.probeHealthIdentity({ id: 'a', port: closed, pid: P }), 'down');
});

test('relay: createIdentityCheck memoises per id:port:pid, fresh asks anew, down is never kept', async () => {
  let at = 1000;
  const calls = [];
  let next = 'ok';
  const probe = (target) => { calls.push(target); return Promise.resolve(next); };
  const id = relay.createIdentityCheck({ probe, memoMs: 1000, now: () => at });
  const target = { id: 'abcd1234', port: 5999, pid: 77 };

  assert.equal(await id.confirm(target), 'ok');
  assert.equal(await id.confirm(target), 'ok');
  assert.equal(calls.length, 1, 'two confirms within memoMs probe once');
  assert.strictEqual(calls[0], target, 'the probe receives the target object as given');

  // fresh probes again, and neither reads nor writes the memo.
  next = 'mismatch';
  assert.equal(await id.confirm(target, { fresh: true }), 'mismatch');
  assert.equal(calls.length, 2);
  assert.equal(await id.confirm(target), 'ok', 'the memoised answer survives a fresh call');
  assert.equal(calls.length, 2);

  // Another pid is another key.
  assert.equal(await id.confirm({ ...target, pid: 78 }), 'mismatch');
  assert.equal(calls.length, 3);

  // An entry memoMs old is dropped.
  at += 1000;
  next = 'ok';
  assert.equal(await id.confirm(target), 'ok');
  assert.equal(calls.length, 4);

  // clear() empties the memo.
  id.clear();
  assert.equal(await id.confirm(target), 'ok');
  assert.equal(calls.length, 5);

  // 'down' is never kept.
  id.clear();
  next = 'down';
  assert.equal(await id.confirm(target), 'down');
  await new Promise((resolve) => setImmediate(resolve));
  next = 'ok';
  assert.equal(await id.confirm(target), 'ok');
  assert.equal(calls.length, 7);

  // An in-flight probe is shared.
  id.clear();
  let release;
  const slow = relay.createIdentityCheck({
    probe: (tg) => { calls.push(tg); return new Promise((resolve) => { release = resolve; }); },
    memoMs: 1000,
    now: () => at,
  });
  const before = calls.length;
  const a = slow.confirm(target);
  const b = slow.confirm(target);
  assert.strictEqual(a, b);
  release('ok');
  assert.equal(await a, 'ok');
  assert.equal(calls.length, before + 1);
});

test('relay: createIdentityCheck needs a memoMs', () => {
  assert.throws(() => relay.createIdentityCheck({}), TypeError);
});
