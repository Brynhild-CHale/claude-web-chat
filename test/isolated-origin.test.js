// The isolated-origin engine (lib/server/isolated-origin.js): the listener a
// page or an API no pane may script lives on — the remote-access setup page
// today, the answer surface next. What is pinned:
//   * the gates every request passes before handle() runs: the Host check
//     (421), the remote refusal (403, unless allowRemote), the preflight
//     refusal (403, no CORS header), the opt-in documents() Sec-Fetch-Dest
//     refusal (403); onRefused(req, 'host' | 'preflight' | 'dest'), called
//     after the refusal is sent and unable to change it;
//   * the headers every response carries, a refusal's included, and the CSP's
//     frame-ancestors (with X-Frame-Options only when framing is refused);
//   * the kit: the call gate's codes, keyed nonces (eviction, no consume, gone
//     on close, pools that never evict each other), the body reader, the asset server's fence, a handler's throw
//     that never echoes its message, and the theme tokens;
//   * the lifecycle: lazy start shared by concurrent callers, idle close with
//     keepAlive, a close racing a start, a failed listen that can be retried;
//   * `listen(0, LOOPBACK` is spelled in the engine and nowhere else in lib/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { waitUntil } = require('../test-support/helpers');
const { createIsolatedOrigin } = require('../lib/server/isolated-origin');

// One raw request, so the test controls Host, Origin and Sec-Fetch-*.
function req(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false,
      headers: { ...(data != null ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wc-iso-'));

// An engine with a spy handle; → { o, port, origin, kit, calls, get, call }.
async function boot(t, opts = {}) {
  const calls = [];
  let kit = null;
  const o = createIsolatedOrigin({
    name: 'answer',
    idleMs: 60_000,
    csp: "default-src 'none'; script-src 'self'",
    headers: { 'x-test-extra': 'yes' },
    ...opts,
    async handle(rq, rs, k) {
      kit = k;
      const u = new URL(rq.url, 'http://x');
      calls.push(`${rq.method} ${u.pathname}`);
      if (opts.handle) return opts.handle(rq, rs, k);
      if (u.pathname === '/page') return k.send(rs, 200, { 'content-type': 'text/html; charset=utf-8' }, `<meta content="${k.issueNonce(u.searchParams.get('key') || '')}">`);
      if (u.pathname === '/asset') return k.serveAsset(rs, u.searchParams.get('rel'), 'text/css; charset=utf-8');
      if (u.pathname === '/call') {
        const r = k.refusal(rq, { key: u.searchParams.get('key') || '', header: 'X-WC-Test' });
        return k.json(rs, r ? 403 : 200, { refusal: r });
      }
      if (u.pathname === '/body') {
        try { return k.json(rs, 200, { body: await k.readBody(rq) }); } catch (e) { return k.json(rs, e.status, { error: e.message }); }
      }
      if (u.pathname === '/throw') throw new Error('SECRET-TEXT');
      if (u.pathname === '/throw-late') { rs.writeHead(200, { 'content-type': 'text/plain' }); rs.write('partial '); throw new Error('SECRET-TEXT'); }
      return k.json(rs, 200, { ok: true });
    },
  });
  t.after(() => o.close());
  const { origin, port } = await o.ensure();
  const host = `127.0.0.1:${port}`;
  const get = (p, headers = {}) => req(port, { path: p, headers: { host, ...headers } });
  const good = (nonce, extra = {}) => ({ host, origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-wc-test': nonce, ...extra });
  const call = (headers, key = '') => req(port, { method: 'POST', path: `/call?key=${encodeURIComponent(key)}`, headers, body: {} });
  await get('/hello'); // hands the test the kit
  calls.length = 0;
  return { o, port, origin, host, kit, calls, get, good, call };
}

const nonceIn = (r) => /content="([^"]+)"/.exec(r.text)[1];

test('the Host gate: 127.0.0.1:<port> passes; localhost and a foreign Host get 421 before handle() runs', async (t) => {
  const { port, calls, get } = await boot(t);
  assert.equal((await get('/x')).status, 200);
  assert.deepEqual(calls, ['GET /x']);
  for (const host of [`localhost:${port}`, 'evil.example', `127.0.0.1:${port + 1}`, '127.0.0.1']) {
    const r = await req(port, { path: '/x', headers: { host } });
    assert.equal(r.status, 421, host);
    assert.deepEqual(r.json, { ok: false, error: 'host not allowed' });
  }
  assert.deepEqual(calls, ['GET /x'], 'handle() never saw a rebound Host');
});

test('X-WC-Remote is refused with the remote hint unless allowRemote answers true', async (t) => {
  {
    const { calls, get } = await boot(t, { remoteHint: 'answer on the host' });
    const r = await get('/x', { 'x-wc-remote': '1' });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { ok: false, remote: true, error: 'answer on the host' });
    assert.deepEqual(calls, []);
  }
  {
    const seen = [];
    const { calls, get } = await boot(t, { allowRemote: (rq) => { seen.push(rq.headers['x-wc-remote']); return true; } });
    const r = await get('/x', { 'x-wc-remote': '1' });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, ['GET /x']);
    assert.deepEqual(seen, ['1']);
  }
});

test('OPTIONS is 403 with no Access-Control-* header', async (t) => {
  const { port, host, calls } = await boot(t);
  const r = await req(port, {
    method: 'OPTIONS', path: '/call',
    headers: { host, origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-wc-test' },
  });
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { ok: false, error: 'no cross-origin calls' });
  for (const h of Object.keys(r.headers)) assert.ok(!h.startsWith('access-control-'), h);
  assert.deepEqual(calls, []);
});

// The Host and OPTIONS refusals are the engine's own; onRefused reports them
// to the caller (the answer surface's refusal audit). It runs after the
// response's end(), and a hook that throws or rejects changes nothing.
test('onRefused: called with (req, \'host\' | \'preflight\') after the response is sent; absent or throwing, the response is unchanged', async (t) => {
  const order = [];
  const end = http.ServerResponse.prototype.end;
  t.mock.method(http.ServerResponse.prototype, 'end', function (...a) {
    order.push(`end ${this.statusCode}`);
    return end.apply(this, a);
  });
  const preflight = (port, host) => req(port, {
    method: 'OPTIONS', path: '/call',
    headers: { host, origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-wc-test' },
  });
  const shape = (r) => ({ status: r.status, json: r.json, cors: Object.keys(r.headers).filter((h) => h.startsWith('access-control-')) });

  // Absent: the responses every refusal test above pins.
  const plain = await boot(t);
  const hostPlain = shape(await req(plain.port, { path: '/x', headers: { host: `localhost:${plain.port}` } }));
  const prePlain = shape(await preflight(plain.port, plain.host));
  assert.deepEqual(hostPlain, { status: 421, json: { ok: false, error: 'host not allowed' }, cors: [] });
  assert.deepEqual(prePlain, { status: 403, json: { ok: false, error: 'no cross-origin calls' }, cors: [] });

  // Present: called once per refusal, with the request and the code, after end().
  const seen = [];
  const hooked = await boot(t, {
    onRefused: (rq, code) => { order.push(`hook ${code}`); seen.push({ code, method: rq.method, url: rq.url }); },
  });
  order.length = 0;
  assert.deepEqual(shape(await req(hooked.port, { path: '/x?a=1', headers: { host: 'evil.example' } })), hostPlain);
  assert.deepEqual(shape(await preflight(hooked.port, hooked.host)), prePlain);
  assert.deepEqual(seen, [
    { code: 'host', method: 'GET', url: '/x?a=1' },
    { code: 'preflight', method: 'OPTIONS', url: '/call' },
  ]);
  assert.deepEqual(order, ['end 421', 'hook host', 'end 403', 'hook preflight'], 'the hook runs after the response is sent');
  assert.deepEqual(hooked.calls, [], 'handle() never ran');
  // Nothing else is reported: a passing request, a handler's own 403, and the
  // remote refusal (allowRemote's to note) never reach the hook.
  await hooked.get('/x');
  await hooked.call(hooked.good('forged'));
  await hooked.get('/x', { 'x-wc-remote': '1' });
  assert.equal(seen.length, 2);

  // Throwing, or rejecting: the same responses, and the engine keeps serving.
  for (const onRefused of [() => { throw new Error('hook broke'); }, async () => { throw new Error('hook broke'); }]) {
    const b = await boot(t, { onRefused });
    assert.deepEqual(shape(await req(b.port, { path: '/x', headers: { host: `localhost:${b.port}` } })), hostPlain);
    assert.deepEqual(shape(await preflight(b.port, b.host)), prePlain);
    assert.equal((await b.get('/x')).status, 200);
  }
});

test('frameAncestors null: frame-ancestors \'none\' and X-Frame-Options DENY', async (t) => {
  const { get } = await boot(t);
  const r = await get('/page');
  assert.equal(r.headers['content-security-policy'], "default-src 'none'; script-src 'self'; frame-ancestors 'none'");
  assert.equal(r.headers['x-frame-options'], 'DENY');
});

test('frameAncestors as a function: the CSP lists its origins and no X-Frame-Options is sent', async (t) => {
  let list = ['http://localhost:5173', 'http://127.0.0.1:5173'];
  const { get, kit } = await boot(t, { frameAncestors: () => list });
  const r = await get('/page');
  assert.equal(r.headers['content-security-policy'], "default-src 'none'; script-src 'self'; frame-ancestors http://localhost:5173 http://127.0.0.1:5173");
  assert.ok(!('x-frame-options' in r.headers));
  assert.ok(!('x-frame-options' in (await get('/nope', { host: 'evil' })).headers), 'nor on a refusal');
  list = [];
  assert.match(kit.csp({ headers: {} }), /frame-ancestors 'none'$/, 'an empty list is none');
  list = ['http://ok.test', "x' 'unsafe-inline", 'a;b'];
  assert.match(kit.csp({ headers: {} }), /frame-ancestors http:\/\/ok\.test$/, 'an origin that would break the directive is dropped');
});

test('the common headers and opts.headers are on every response, a refusal\'s included', async (t) => {
  const dir = tmp();
  const { port, host, get } = await boot(t, { publicDir: dir });
  const responses = [
    await get('/x'),
    await req(port, { path: '/x', headers: { host: 'evil' } }),
    await get('/x', { 'x-wc-remote': '1' }),
    await req(port, { method: 'OPTIONS', path: '/x', headers: { host } }),
    await get('/asset?rel=missing.css'),
    await get('/throw'),
    await get('/page'),
  ];
  for (const r of responses) {
    assert.equal(r.headers['x-test-extra'], 'yes', `${r.status}`);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
    assert.ok(!('cross-origin-opener-policy' in r.headers), 'COOP only when a surface asks for it');
  }
  assert.ok(!('content-security-policy' in responses[0].headers), 'JSON carries no CSP');
  assert.ok(responses[6].headers['content-security-policy'], 'HTML does');
});

test('refusal(): null for a good call; origin, site, type and nonce for the rest', async (t) => {
  const { port, origin, good, call, get, kit } = await boot(t, { nonce: { ttlMs: 30, max: 16, perKey: 8 } });
  const fresh = async (key = '') => nonceIn(await get(`/page?key=${key}`));
  const drop = (h, k) => { const o = { ...h }; delete o[k]; return o; };
  {
    const n = await fresh();
    const ok = await call(good(n));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.refusal, null);
  }
  const code = async (headers, key = '') => (await call(headers, key)).json.refusal.code;
  const n = await fresh();
  assert.equal(await code(good(n, { origin: 'http://localhost:5173' })), 'origin', 'the chrome\'s origin');
  assert.equal(await code(good(n, { origin: `http://127.0.0.1:${port + 1}` })), 'origin');
  assert.equal(await code(drop(good(n), 'origin')), 'origin', 'no Origin (a driver)');
  assert.equal(await code(good(n, { 'sec-fetch-site': 'cross-site' })), 'site');
  assert.equal(await code(good(n, { 'sec-fetch-site': 'same-site' })), 'site');
  assert.equal(await code(good(n, { 'content-type': 'application/x-www-form-urlencoded' })), 'type');
  assert.equal(await code(drop(good(n), 'x-wc-test')), 'nonce', 'missing');
  assert.equal(await code(good('A'.repeat(43))), 'nonce', 'forged');
  const other = await fresh('ask-1');
  assert.equal(await code(good(other), 'ask-2'), 'nonce', 'minted for another key');
  assert.equal((await call(good(other), 'ask-1')).status, 200, 'and good for its own');
  const old = await fresh();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await code(good(old)), 'nonce', 'expired');
  assert.ok(origin.startsWith('http://127.0.0.1:'));
  assert.ok(typeof kit.refusal({ headers: {} }).reason === 'string', 'every refusal has a reason');
});

test('nonces: perKey and max evict the oldest first; checking never consumes; close() forgets them', async (t) => {
  const { o, kit } = await boot(t, { nonce: { ttlMs: 60_000, max: 5, perKey: 2 } });
  const a1 = kit.issueNonce('a');
  const a2 = kit.issueNonce('a');
  const a3 = kit.issueNonce('a');
  assert.equal(kit.checkNonce(a1, 'a'), false, 'perKey evicted the key\'s oldest');
  assert.ok(kit.checkNonce(a2, 'a') && kit.checkNonce(a3, 'a'));
  assert.ok(kit.checkNonce(a2, 'a') && kit.checkNonce(a2, 'a'), 'checking never consumes');
  assert.equal(kit.checkNonce(a2, 'b'), false);
  assert.equal(kit.checkNonce(a2), false, 'the empty key is a key of its own');
  const b = [kit.issueNonce('b'), kit.issueNonce('c'), kit.issueNonce('d')];
  assert.ok(kit.checkNonce(a2, 'a'), 'five in the pool');
  kit.issueNonce('e');
  assert.equal(kit.checkNonce(a2, 'a'), false, 'max evicted the pool\'s oldest');
  assert.ok(kit.checkNonce(a3, 'a') && kit.checkNonce(b[0], 'b'));
  assert.equal(kit.checkNonce(undefined), false);
  assert.equal(kit.checkNonce(42), false);

  const before = kit.issueNonce('a');
  await o.close();
  await o.ensure();
  assert.equal(kit.checkNonce(before, 'a'), false, 'a nonce minted before a close fails after the next ensure()');
});

test('a nonce minted before an IDLE close fails after the next ensure()', async (t) => {
  const { o, kit, get } = await boot(t, { idleMs: 60 });
  const n = nonceIn(await get('/page'));
  assert.ok(kit.checkNonce(n));
  await waitUntil(() => o.port === null, { what: 'the idle close' });
  await o.ensure();
  assert.equal(kit.checkNonce(n), false);
});

test('nonce pools: 64 nonces in one pool never evict another pool\'s; each pool keeps its own caps', async (t) => {
  // The answer surface's caps: 64 a pool, 8 a key.
  const { kit } = await boot(t, { nonce: { ttlMs: 60_000, max: 64, perKey: 8, pools: { tiny: { max: 2 } } } });
  const control = kit.issueNonce('control:restore:t1', { pool: 'control' });
  const setup = kit.issueNonce();
  const asks = [];
  for (let i = 0; i < 64; i++) asks.push(kit.issueNonce(`ask:a${i % 8}`, { pool: 'ask' }));
  assert.ok(kit.checkNonce(control, 'control:restore:t1'), '64 ask-pool nonces leave the control pool\'s standing');
  assert.ok(kit.checkNonce(setup), '... and the default pool\'s');
  assert.ok(asks.every((n, i) => kit.checkNonce(n, `ask:a${i % 8}`)), 'the ask pool holds its 64');
  kit.issueNonce('ask:a0', { pool: 'ask' });
  assert.equal(kit.checkNonce(asks[0], 'ask:a0'), false, 'the 65th evicts the ask pool\'s oldest');
  assert.ok(kit.checkNonce(control, 'control:restore:t1'), 'and nothing of another pool');

  // And the other way: a control flood never touches an ask nonce.
  const ask = kit.issueNonce('ask:live', { pool: 'ask' });
  for (let i = 0; i < 64; i++) kit.issueNonce(`control:restore:x${i}`, { pool: 'control' });
  assert.equal(kit.checkNonce(control, 'control:restore:t1'), false, 'the control pool evicted its own oldest');
  assert.ok(kit.checkNonce(ask, 'ask:live'));

  // A key checks only for itself, whatever the pool.
  assert.equal(kit.checkNonce(ask, 'control:restore:t1'), false);
  // A declared pool's own caps.
  const t1 = kit.issueNonce('a', { pool: 'tiny' });
  kit.issueNonce('b', { pool: 'tiny' });
  kit.issueNonce('c', { pool: 'tiny' });
  assert.equal(kit.checkNonce(t1, 'a'), false, 'tiny holds two');
  assert.ok(kit.checkNonce(ask, 'ask:live'));
});

test('documents(): a document request whose Sec-Fetch-Dest is not iframe or document is 403 before handle(), and reported \'dest\'', async (t) => {
  const seen = [];
  const b = await boot(t, {
    documents: (rq) => rq.method === 'GET' && rq.url.startsWith('/page'),
    onRefused: (rq, code) => seen.push({ code, url: rq.url }),
  });
  for (const dest of ['image', 'empty', 'script', 'style', 'object', 'embed', 'frame', '']) {
    const r = await b.get('/page?key=k', { 'sec-fetch-dest': dest });
    assert.equal(r.status, 403, dest);
    assert.deepEqual(r.json, { ok: false, refused: 'dest', error: 'this document only loads in a frame or a window' });
    assert.equal(r.headers['cache-control'], 'no-store', 'the common headers, as on every refusal');
  }
  assert.deepEqual(b.calls, [], 'handle() never ran, so no nonce was minted');
  assert.equal(seen.length, 8);
  assert.deepEqual(seen[0], { code: 'dest', url: '/page?key=k' });

  for (const dest of ['iframe', 'document', null]) {
    const r = await b.get('/page?key=k', dest == null ? {} : { 'sec-fetch-dest': dest });
    assert.equal(r.status, 200, String(dest));
    assert.ok(b.kit.checkNonce(nonceIn(r), 'k'), `${dest}: served with a live nonce`);
  }
  // Not a document (an asset, an API): its Sec-Fetch-Dest is its own business.
  assert.equal((await b.get('/x', { 'sec-fetch-dest': 'image' })).status, 200);
  assert.equal(seen.length, 8);

  // A documents() that throws fails closed; none passed is today's engine.
  const thrower = await boot(t, { documents: () => { throw new Error('broke'); } });
  assert.equal((await thrower.get('/x', { 'sec-fetch-dest': 'image' })).status, 403);
  assert.equal((await thrower.get('/x', { 'sec-fetch-dest': 'iframe' })).status, 200);
  const plain = await boot(t);
  const r = await plain.get('/page', { 'sec-fetch-dest': 'image' });
  assert.equal(r.status, 200, 'no documents(): no Sec-Fetch-Dest gate');
  assert.ok(plain.kit.checkNonce(nonceIn(r)));
});

test('readBody: {} when empty, 400 for bad JSON, 413 over maxBody', async (t) => {
  const { port, host } = await boot(t, { maxBody: 1024 });
  const post = (body, extra = {}) => req(port, { method: 'POST', path: '/body', headers: { host, 'content-type': 'application/json', ...extra }, body });
  assert.deepEqual((await req(port, { method: 'POST', path: '/body', headers: { host } })).json, { body: {} });
  assert.deepEqual((await post({ a: 1 })).json, { body: { a: 1 } });
  assert.deepEqual((await post('[1,2]')).json, { body: {} }, 'a non-object is an empty body');
  const bad = await post('{nope');
  assert.equal(bad.status, 400);
  // Over the cap the engine stops reading and drops the socket, so the 413 may
  // or may not reach the client: what is pinned is that the reader refused.
  let seen = null;
  const big = await boot(t, {
    maxBody: 1024,
    async handle(rq, rs, k) { try { await k.readBody(rq); seen = 'read'; } catch (e) { seen = e.status; } k.json(rs, seen === 'read' ? 200 : 413, {}); },
  });
  seen = null; // boot's own first request was read
  await req(big.port, { method: 'POST', path: '/body', headers: { host: big.host, 'content-type': 'application/json' }, body: 'x'.repeat(4096) }).catch(() => null);
  await waitUntil(() => seen !== null, { what: 'the reader to refuse' });
  assert.equal(seen, 413);
});

test('serveAsset: a publicDir file with the CSP; a path that leaves it, or a missing file, is 404', async (t) => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'answer.css'), 'body{color:red}');
  fs.writeFileSync(path.join(path.dirname(dir), 'outside.css'), 'secret');
  fs.mkdirSync(path.join(dir, 'a'));
  fs.writeFileSync(path.join(dir, 'a', 'b'), 'nested');
  const { get } = await boot(t, { publicDir: dir });
  const ok = await get('/asset?rel=answer.css');
  assert.equal(ok.status, 200);
  assert.equal(ok.text, 'body{color:red}');
  assert.equal(ok.headers['content-security-policy'], "default-src 'none'; script-src 'self'; frame-ancestors 'none'");
  for (const rel of ['../outside.css', 'a/b', 'a\\b', path.join(dir, 'answer.css'), '/etc/hosts', 'missing.css', '..', '.', '']) {
    const r = await get(`/asset?rel=${encodeURIComponent(rel)}`);
    assert.equal(r.status, 404, rel);
    assert.deepEqual(r.json, { ok: false, error: 'not found' });
  }
  {
    const none = await boot(t);
    assert.equal((await none.get('/asset?rel=answer.css')).status, 404, 'no publicDir, no assets');
  }
});

test('a handle() that throws answers 500 \'<name> failed\' and never echoes the error', async (t) => {
  const { get } = await boot(t, { name: 'answer' });
  const r = await get('/throw');
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { ok: false, error: 'answer failed' });
  assert.ok(!r.text.includes('SECRET-TEXT'));
  const late = await get('/throw-late');
  assert.equal(late.status, 200, 'the head had gone out');
  assert.equal(late.text, 'partial ', 'the response is ended, not appended to');
  const sync = await boot(t, { name: 'tunnel-setup', handle() { throw new Error('SECRET-TEXT'); } });
  const s = await sync.get('/x');
  assert.deepEqual(s.json, { ok: false, error: 'tunnel-setup failed' });
});

test('idle: the listener closes after idleMs; keepAlive keeps it through two periods and lets go on false', async (t) => {
  {
    const { o, port, host } = await boot(t, { idleMs: 50 });
    await waitUntil(() => o.port === null, { what: 'the idle close' });
    assert.equal(o.origin, null);
    await assert.rejects(req(port, { path: '/x', headers: { host } }));
    const again = await o.ensure();
    assert.ok(Number.isInteger(again.port) && again.port > 0);
    assert.equal(again.origin, `http://127.0.0.1:${again.port}`);
    assert.equal((await req(again.port, { path: '/x', headers: { host: `127.0.0.1:${again.port}` } })).status, 200, 'a fresh listener answers');
  }
  {
    let keep = true;
    let asked = 0;
    const { o } = await boot(t, { idleMs: 40, keepAlive: () => { asked++; return keep; } });
    await waitUntil(() => asked >= 2, { what: 'two idle periods' });
    assert.ok(o.port, 'kept up through two idle periods');
    keep = false;
    await waitUntil(() => o.port === null, { what: 'the close once keepAlive answers false' });
    const at = asked;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(asked, at, 'no timer outlives the close');
  }
});

test('concurrency: three concurrent ensure() calls make one listener; close() is idempotent', async (t) => {
  const made = [];
  const real = http.createServer;
  t.mock.method(http, 'createServer', (...a) => { const s = real(...a); made.push(s); return s; });
  const o = createIsolatedOrigin({ name: 'answer', handle: (rq, rs, k) => k.json(rs, 200, {}) });
  t.after(() => o.close());
  const all = await Promise.all([o.ensure(), o.ensure(), o.ensure()]);
  assert.equal(made.length, 1);
  assert.equal(new Set(all.map((x) => x.port)).size, 1);
  assert.equal(o.port, all[0].port);
  await Promise.all([o.close(), o.close()]);
  await o.close();
  assert.equal(made[0].listening, false);
  assert.equal(o.port, null);
});

test('a close() racing a start leaves the engine closed, and the next ensure() starts afresh', async (t) => {
  const made = [];
  const real = http.createServer;
  t.mock.method(http, 'createServer', (...a) => { const s = real(...a); made.push(s); return s; });
  const o = createIsolatedOrigin({ name: 'answer', handle: (rq, rs, k) => k.json(rs, 200, {}) });
  t.after(() => o.close());
  const p = o.ensure();
  await o.close();
  await assert.rejects(p, (e) => e.code === 'closed');
  assert.equal(o.port, null);
  assert.equal(made[0].listening, false, 'the raced listener was closed once it listened');
  const again = await o.ensure();
  assert.ok(again.port);
  assert.equal(made.length, 2);
});

test('a listen error rejects, leaves the engine closed, and the next ensure() tries again', async (t) => {
  const real = http.createServer;
  let fail = true;
  t.mock.method(http, 'createServer', (...a) => {
    const s = real(...a);
    if (fail) {
      fail = false;
      s.listen = function () { process.nextTick(() => this.emit('error', Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' }))); return this; };
    }
    return s;
  });
  const o = createIsolatedOrigin({ name: 'answer', handle: (rq, rs, k) => k.json(rs, 200, {}) });
  t.after(() => o.close());
  await assert.rejects(o.ensure(), /EADDRINUSE/);
  assert.equal(o.port, null);
  assert.equal(o.origin, null);
  const ok = await o.ensure();
  assert.ok(ok.port);
});

// Captured from wc085/int (c037dcb) before the setup page was rebuilt on the
// engine: its /setup/tunnel/theme.css for this fixture theme.
const FIXTURE_THEME = {
  name: 'fixture',
  tokens: { '--wc-font': 'Inter, sans-serif', '--wc-radius': '6px' },
  modes: { light: { tokens: { '--wc-bg': '#fafaf7', '--wc-fg': '#222' } }, dark: { tokens: { '--wc-bg': '#111', '--wc-fg': '#eee', '--wc-accent': '#c96' } } },
  css: 'body{color:red}',
};
const CAPTURED_BOTH = ':root {\n  --wc-font: Inter, sans-serif;\n  --wc-radius: 6px;\n  --wc-bg: #fafaf7;\n  --wc-fg: #222;\n}\n@media (prefers-color-scheme: dark) {\n  :root {\n    --wc-font: Inter, sans-serif;\n    --wc-radius: 6px;\n    --wc-bg: #111;\n    --wc-fg: #eee;\n    --wc-accent: #c96;\n  }\n}\n';
const CAPTURED_NONE = ':root {\n\n}\n';

test('themeCss(): byte-identical to the setup page\'s; a mode puts that mode\'s tokens on :root', async (t) => {
  const dir = tmp();
  const THEME_PATH = path.join(dir, 'theme.json');
  fs.writeFileSync(THEME_PATH, JSON.stringify(FIXTURE_THEME));
  const { kit } = await boot(t, { paths: { THEME_PATH } });
  assert.equal(kit.themeCss(), CAPTURED_BOTH);
  assert.ok(!kit.themeCss().includes('color:red'), 'tokens only, never the theme\'s raw CSS');
  assert.equal(kit.themeCss('dark'), ':root {\n  --wc-font: Inter, sans-serif;\n  --wc-radius: 6px;\n  --wc-bg: #111;\n  --wc-fg: #eee;\n  --wc-accent: #c96;\n}\n');
  assert.equal(kit.themeCss('light'), ':root {\n  --wc-font: Inter, sans-serif;\n  --wc-radius: 6px;\n  --wc-bg: #fafaf7;\n  --wc-fg: #222;\n}\n');
  const bare = await boot(t, { paths: {} });
  assert.equal(bare.kit.themeCss(), CAPTURED_NONE);
});

// The setup page words its own refusals (kit.refusal hands it a code). Its
// own test files pin the statuses; these are the strings the page showed
// before it moved onto the engine, the expired-page line included.
test('the setup page keeps its refusal wording on the engine', async (t) => {
  const { createTunnelSetup } = require('../lib/server/tunnel-setup');
  const setup = createTunnelSetup({ paths: {} });
  t.after(() => setup.close());
  const { port } = await setup.ensure();
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const page = await req(port, { path: '/setup/tunnel', headers: { host } });
  const m = /<meta name="wc-setup-token" content="([^"]+)">/.exec(page.text);
  assert.ok(m, 'the page carries its nonce');
  const n = m[1];
  // The setup page passes no documents(): any Sec-Fetch-Dest loads the same
  // page (its own fetch-metadata rules, if any, are the page's).
  const strip = (r) => r.text.replace(/content="[A-Za-z0-9_-]{40,}"/g, 'content="N"');
  for (const dest of ['image', 'empty', 'document']) {
    const other = await req(port, { path: '/setup/tunnel', headers: { host, 'sec-fetch-dest': dest } });
    assert.equal(other.status, page.status, dest);
    assert.equal(strip(other), strip(page), dest);
  }
  const good = (extra = {}) => ({ host, origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-wc-setup': n, ...extra });
  const post = (headers) => req(port, { method: 'POST', path: '/setup/tunnel/status', headers, body: {} });
  const err = async (headers) => { const r = await post(headers); assert.equal(r.status, 403, r.text); return r.json.error; };
  assert.equal(await err(good({ origin: 'http://localhost:5173' })), 'this page only answers itself (Origin)');
  assert.equal(await err(good({ 'sec-fetch-site': 'cross-site' })), 'this page only answers itself (Sec-Fetch-Site)');
  assert.equal(await err(good({ 'content-type': 'text/plain' })), 'expected application/json');
  assert.equal(await err(good({ 'x-wc-setup': 'A'.repeat(43) })), 'this setup page has expired — reopen it from ⌘K "Set up remote access…"');
  const remote = await post(good({ 'x-wc-remote': '1' }));
  assert.deepEqual([remote.status, remote.json], [403, { ok: false, remote: true, error: 'remote access is set up on the host, never through the tunnel' }]);
  const rebound = await post(good({ host: `localhost:${port}` }));
  assert.deepEqual([rebound.status, rebound.json], [421, { ok: false, error: 'host not allowed' }]);
});

test('the source: `listen(0, LOOPBACK` is spelled in lib/server/isolated-origin.js and nowhere else in lib/', () => {
  const lib = path.resolve(__dirname, '..', 'lib');
  const hits = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.js')) {
        const n = fs.readFileSync(f, 'utf8').split('listen(0, LOOPBACK').length - 1;
        if (n) hits[path.relative(lib, f)] = n;
      }
    }
  };
  walk(lib);
  assert.deepEqual(hits, { [path.join('server', 'isolated-origin.js')]: 1 });
});
