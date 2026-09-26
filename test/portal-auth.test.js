// The tunnel portal's MANDATORY local JWT check (lib/portal/access-jwt.js +
// jwks.js), end to end through a live portal and at the verifier itself.
//
// Cloudflare Access is faked (test-support/fake-access.js): real RSA keys, a
// JWKS served through the injectable fetchJwks, tokens minted with whatever a
// test needs to get wrong. No network.
//
// The apex picker's /api/sessions is the probe for "admitted" — it is behind
// the same gate as every session request, and answers 200 with an empty list
// when no instance is registered.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { withPortal } = require('../test-support/helpers');
const { createFakeAccess } = require('../test-support/fake-access');
const { createVerifier, tokenFrom, emailAllowed } = require('../lib/portal/access-jwt');
const { createJwksCache, fetchJson, parseJwks, jwksUrl } = require('../lib/tunnel/jwks');
const { normalizeConfig } = require('../lib/tunnel/config');

// A clock a test can move. Both the fake's token times and the portal read it.
function clock(start = Date.now()) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

async function boot(t, { access, now, config } = {}) {
  now = now || clock();
  access = access || createFakeAccess({ now });
  const p = await withPortal(t, {
    config: config || access.config(),
    fetchJwks: access.fetchJwks,
    now,
    instances: () => [],
  });
  const get = (headers = {}) => p.request('/api/sessions', { headers });
  const withToken = (tok) => get({ 'cf-access-jwt-assertion': tok });
  return { ...p, access, now, get, withToken };
}

test('portal auth: a valid Access token is admitted; no token is 401', async (t) => {
  const p = await boot(t);
  const ok = await p.withToken(p.access.mint());
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.sessions, []);
  assert.equal(ok.json.email, 'me@example.com');

  const none = await p.get();
  assert.equal(none.status, 401);
  assert.equal(none.json.remote, true);
});

test('portal auth: the CF_Authorization cookie is the fallback', async (t) => {
  const p = await boot(t);
  const r = await p.get({ cookie: `other=1; CF_Authorization=${p.access.mint()}; x=y` });
  assert.equal(r.status, 200, r.text);
  // A cookie with a different name that merely CONTAINS the token name is not it.
  const wrong = await p.get({ cookie: `NOT_CF_Authorization=${p.access.mint()}` });
  assert.equal(wrong.status, 401);
});

test('portal auth: expired, not-yet-valid, wrong aud and wrong iss are 401', async (t) => {
  const p = await boot(t);
  const s = Math.floor(p.now() / 1000);
  const cases = {
    expired: p.access.mint({ exp: s - 120 }),
    'no exp': p.access.mint({ exp: undefined }),
    'nbf in the future': p.access.mint({ nbf: s + 120 }),
    'iat in the future': p.access.mint({ iat: s + 120 }),
    'wrong aud': p.access.mint({ aud: ['someone-elses-app'] }),
    'wrong iss': p.access.mint({ iss: 'https://evil.cloudflareaccess.com' }),
  };
  for (const [what, tok] of Object.entries(cases)) {
    const r = await p.withToken(tok);
    assert.equal(r.status, 401, `${what} must be refused`);
  }
  // …but inside the ±60s skew is fine.
  assert.equal((await p.withToken(p.access.mint({ exp: s - 30, nbf: s + 30 }))).status, 200);
  // aud as a bare string is accepted when it is ours.
  assert.equal((await p.withToken(p.access.mint({ aud: p.access.aud }))).status, 200);
});

test('portal auth: alg none and HS256-signed-with-the-public-key are refused', async (t) => {
  const p = await boot(t);
  assert.equal((await p.withToken(p.access.mint())).status, 200, 'the key set is loaded');
  assert.equal((await p.withToken(p.access.mintNone())).status, 401, 'alg none');
  assert.equal((await p.withToken(p.access.mintHs256WithPublicKey())).status, 401, 'HS256 with the RSA public key');
  // A valid-looking RS256 token signed by a key NOT in the set.
  const stranger = p.access.keyPair(5).privateKey;
  assert.equal((await p.withToken(p.access.mint({}, { signWith: stranger }))).status, 401, 'foreign signing key');
  // A tampered payload under a real signature.
  const [h, , sig] = p.access.mint().split('.');
  const forged = Buffer.from(JSON.stringify(p.access.claims({ email: 'boss@example.com' }))).toString('base64url');
  assert.equal((await p.withToken(`${h}.${forged}.${sig}`)).status, 401, 'tampered claims');
});

test('portal auth: an unknown kid refetches the key set, at most once a minute', async (t) => {
  const p = await boot(t);
  assert.equal((await p.withToken(p.access.mint())).status, 200);
  assert.equal(p.access.state.calls, 1, 'one cold load');

  // Key rotation: Cloudflare publishes k2 and starts signing with it.
  p.access.addKey('k2');
  p.now.advance(61 * 1000);
  assert.equal((await p.withToken(p.access.mint({}, { kid: 'k2' }))).status, 200, 'the rotated key is picked up');
  assert.equal(p.access.state.calls, 2);

  // A random kid refetches once more (a minute on)…
  p.now.advance(61 * 1000);
  assert.equal((await p.withToken(p.access.mint({}, { kid: 'nope-1', signWith: p.access.keyPair(0).privateKey }))).status, 401);
  assert.equal(p.access.state.calls, 3);
  // …but a burst of them inside the minute does not.
  for (const kid of ['nope-2', 'nope-3', 'nope-4']) {
    assert.equal((await p.withToken(p.access.mint({}, { kid, signWith: p.access.keyPair(0).privateKey }))).status, 401);
  }
  assert.equal(p.access.state.calls, 3, 'unknown kids inside the window never reach Cloudflare');
});

test('portal auth: a key set older than an hour is refetched, so a withdrawn key stops admitting', async (t) => {
  const p = await boot(t);
  assert.equal((await p.withToken(p.access.mint())).status, 200);
  assert.equal(p.access.state.calls, 1);

  // Cloudflare withdraws k1 (and signs with k2). k1 is still in the cache, so
  // inside the hour a k1 token is admitted without a fetch…
  p.access.addKey('k2');
  p.access.removeKey('k1');
  p.now.advance(30 * 60 * 1000);
  assert.equal((await p.withToken(p.access.mint({}, { signWith: p.access.keyPair(0).privateKey }))).status, 200);
  assert.equal(p.access.state.calls, 1, 'a known kid inside the hour never refetches');

  // …but once the cache is an hour old it refreshes before trusting k1 again.
  p.now.advance(31 * 60 * 1000);
  const k1Tok = p.access.mint({}, { kid: 'k1', signWith: p.access.keyPair(0).privateKey });
  assert.equal((await p.withToken(k1Tok)).status, 401, 'the withdrawn key no longer admits');
  assert.equal(p.access.state.calls, 2, 'the stale cache was refetched');
});

test('portal auth: the email allowlist — exact, case-insensitive; no email is refused', async (t) => {
  const now = clock();
  const access = createFakeAccess({ now });
  const p = await boot(t, {
    access,
    now,
    config: access.config({ allow: { emails: ['Me@Example.com', 'second@example.org'] } }),
  });
  assert.equal((await p.withToken(access.mint({ email: 'ME@EXAMPLE.COM' }))).status, 200, 'mixed case matches');
  assert.equal((await p.withToken(access.mint({ email: 'second@example.org' }))).status, 200);
  const other = await p.withToken(access.mint({ email: 'intruder@example.com' }));
  assert.equal(other.status, 403);
  assert.equal(other.json.remote, true);
  assert.equal((await p.withToken(access.mint({ email: 'me@example.com.evil.test' }))).status, 403, 'no suffix match');
  assert.equal((await p.withToken(access.mint({ email: 'x.me@example.com' }))).status, 403, 'no prefix match');
  // An Access SERVICE token carries no email — machine credentials never reach a surface.
  assert.equal((await p.withToken(access.mint({ email: undefined, common_name: 'svc.access' }))).status, 403);
});

test('portal auth: a cold JWKS failure is 503 (fail closed), retried after a pause', async (t) => {
  const p = await boot(t);
  p.access.state.down = true;
  const r = await p.withToken(p.access.mint());
  assert.equal(r.status, 503);
  assert.equal(p.access.state.calls, 1);

  p.access.state.down = false;
  assert.equal((await p.withToken(p.access.mint())).status, 503, 'inside the cold-retry pause');
  assert.equal(p.access.state.calls, 1, 'no fetch per request while cold');

  p.now.advance(6 * 1000);
  assert.equal((await p.withToken(p.access.mint())).status, 200, 'recovers once Cloudflare answers');
  assert.equal(p.access.state.calls, 2);

  // WARM failure keeps the keys already held.
  p.access.state.down = true;
  p.now.advance(2 * 60 * 60 * 1000);
  assert.equal((await p.withToken(p.access.mint())).status, 200, 'a failed refresh is not an outage');
});

test('verifier: each refusal names its reason', async () => {
  const now = clock();
  const access = createFakeAccess({ now });
  const jwks = createJwksCache({ team: access.team, fetchJwks: access.fetchJwks, now });
  const v = createVerifier({ team: access.team, aud: access.aud, allow: { emails: [access.email], domains: [] }, jwks, now });
  const s = Math.floor(now() / 1000);
  const want = [
    [undefined, 401, 'missing'],
    ['a.b', 401, 'malformed'],
    [access.mintNone(), 401, 'alg'],
    [access.mintHs256WithPublicKey(), 401, 'alg'],
    [access.mint({}, { header: { kid: undefined } }), 401, 'kid'],
    [access.mint({ exp: s - 120 }), 401, 'exp'],
    [access.mint({ nbf: s + 120 }), 401, 'nbf'],
    [access.mint({ iat: s + 120 }), 401, 'iat'],
    [access.mint({ aud: ['x'] }), 401, 'aud'],
    [access.mint({ iss: 'https://x.cloudflareaccess.com' }), 401, 'iss'],
    [access.mint({ email: '' }), 403, 'no-email'],
    [access.mint({ email: 'no@example.com' }), 403, 'not-allowed'],
  ];
  for (const [tok, status, reason] of want) {
    const r = await v.verify(tok);
    assert.deepEqual({ status: r.status, reason: r.reason }, { status, reason }, `expected ${reason}`);
  }
  const ok = await v.verify(access.mint());
  assert.equal(ok.ok, true);
  assert.equal(ok.email, access.email);
});

test('verifier helpers: tokenFrom prefers the header; emailAllowed domains are opt-in', () => {
  assert.equal(tokenFrom({ 'cf-access-jwt-assertion': 'H', cookie: 'CF_Authorization=C' }), 'H');
  assert.equal(tokenFrom({ cookie: 'CF_Authorization=C' }), 'C');
  assert.equal(tokenFrom({}), null);
  assert.equal(emailAllowed('a@corp.test', { emails: [], domains: [] }), false);
  assert.equal(emailAllowed('a@corp.test', { emails: [], domains: ['corp.test'] }), true);
  assert.equal(emailAllowed('a@evil.corp.test', { emails: [], domains: ['corp.test'] }), false, 'no subdomain match');
  assert.equal(emailAllowed('a@corp.test@evil.test', { emails: [], domains: ['corp.test'] }), false, 'last @ decides');
});

test('config: an empty allowlist, a bad style or a bare-domain flat hostname is refused', () => {
  const access = createFakeAccess();
  assert.throws(() => normalizeConfig(access.config({ allow: { emails: [] } })), /allow\.emails is empty/);
  assert.throws(() => normalizeConfig(access.config({ allow: {} })), /allow\.emails must be a list/);
  assert.throws(() => normalizeConfig(access.config({ style: 'deep' })), /style must be/);
  assert.throws(() => normalizeConfig(access.config({ hostname: 'example.com' })), /flat hostname needs a subdomain/);
  assert.throws(() => normalizeConfig(access.config({ access: { team: 'x', aud: '' } })), /AUD/);
  assert.throws(() => normalizeConfig(access.config({ access: { team: 'bad team', aud: 'a' } })), /team/);
  const c = normalizeConfig(access.config({ allow: { emails: [' Me@Example.COM '] } }));
  assert.deepEqual(c.allow.emails, ['me@example.com']);
  assert.equal(c.remote.allowDestructive, false);
  assert.equal(c.showRoots, false);
});

test('jwks: parseJwks admits only RSA signing keys', () => {
  const access = createFakeAccess();
  const good = access.jwks().keys[0];
  const map = parseJwks({ keys: [
    good,
    { ...good, kid: 'enc', use: 'enc' },
    { ...good, kid: 'es', alg: 'ES256' },
    { kty: 'EC', kid: 'ec', crv: 'P-256', x: 'a', y: 'b' },
    { ...good, kid: '' },
  ] });
  assert.deepEqual([...map.keys()], ['k1']);
  assert.equal(jwksUrl('myteam'), 'https://myteam.cloudflareaccess.com/cdn-cgi/access/certs');
  assert.throws(() => jwksUrl('evil.com/x?'), /invalid Access team/);
});

test('jwks: fetchJson is bounded — non-200, oversize and timeout all reject', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') { res.end(JSON.stringify({ keys: [] })); return; }
    if (req.url === '/big') { res.end('x'.repeat(4096)); return; }
    if (req.url === '/slow') return; // never answers
    res.statusCode = 500; res.end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const opts = { get: http.get, timeoutMs: 300, maxBytes: 1024 };
  assert.deepEqual(await fetchJson(`${base}/ok`, opts), { keys: [] });
  await assert.rejects(fetchJson(`${base}/err`, opts), /HTTP 500/);
  await assert.rejects(fetchJson(`${base}/big`, opts), /exceeds 1024 bytes/);
  await assert.rejects(fetchJson(`${base}/slow`, opts), /timed out/);
});
