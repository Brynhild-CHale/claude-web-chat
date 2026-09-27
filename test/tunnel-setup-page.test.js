// The remote-access setup page (lib/server/tunnel-setup) and its launcher
// (GET /tunnel/setup, lib/server/routes/tunnel.js), against the in-process
// fake Cloudflare API. Nothing here reaches Cloudflare.
//
// What is pinned is the security boundary, then the run:
//   * the page lives on its OWN origin — 127.0.0.1 on a port that is not the
//     daemon's — so no document that runs pane code is ever same-origin with it;
//   * every setup call is refused unless it comes from that origin, with this
//     load's nonce, as JSON: a pane-origin fetch (localhost:<daemon>), a
//     127.0.0.1:<daemon> one (where the replay renderer runs panes), no Origin,
//     no or a forged nonce, a form-encoded body, a cross-site Sec-Fetch-Site, a
//     preflight, a rebound Host and a tunnelled request all fail — and the fake
//     Cloudflare sees NO request from any of them;
//   * a same-origin call with the nonce plans, applies (the same lines as the
//     CLI), and brings the tunnel up through lib/tunnel/control;
//   * the API token never appears in a response or in the daemon's output,
//     and is never written to disk.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { withServer, freePort } = require('../test-support/helpers');
const { withFakeCloudflare } = require('../test-support/fake-cloudflare');
const { createFakeAccess } = require('../test-support/fake-access');
const { userPaths } = require('../lib/core/paths');
const { loadConfig } = require('../lib/tunnel/config');
const { PERMS } = require('../lib/tunnel/cf-api');
const { createServer } = require('../lib/server');
const { createTunnelSetup } = require('../lib/server/tunnel-setup');

// One raw request — raw so the test controls Host, Origin and Sec-Fetch-*.
function req(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port, method, path: p,
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

// The NDJSON a streamed step answers with → { lines, final }.
function ndjson(text) {
  const objs = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { lines: objs.filter((o) => typeof o.line === 'string').map((o) => o.line), final: objs.find((o) => o.done) || null };
}

// Boot a daemon whose setup page talks to `fake` (and `control`, when given),
// open the page through the launcher, and hand back what a same-origin page
// would send.
async function boot(t, { fake, control, access } = {}) {
  // A portal port nothing answers on: this machine may run a real tunnel, and
  // the page's status must not read (or `up` find) that one.
  const tunnelSetup = { env: { ...process.env, WEB_CHAT_PORTAL_PORT: String(await freePort()) } };
  if (fake) {
    tunnelSetup.env.WEB_CHAT_CF_API = fake.base;
    tunnelSetup.fetchJwks = (access || createFakeAccess({ team: fake.team })).fetchJwks;
  }
  if (control) tunnelSetup.control = control;
  const s = await withServer(t, { createServer: (o) => createServer({ ...o, tunnelSetup }) });
  const launch = await req(s.port, { path: '/tunnel/setup', headers: { host: `localhost:${s.port}` } });
  assert.equal(launch.status, 302, 'the launcher redirects the new tab to the setup page');
  const url = new URL(launch.headers.location);
  const sp = Number(url.port);
  const origin = `http://127.0.0.1:${sp}`;
  const page = await req(sp, { path: url.pathname, headers: { host: `127.0.0.1:${sp}` } });
  const nonce = /<meta name="wc-setup-token" content="([^"]+)">/.exec(page.text)[1];
  const good = (extra = {}) => ({ host: `127.0.0.1:${sp}`, origin, 'content-type': 'application/json', 'x-wc-setup': nonce, 'sec-fetch-site': 'same-origin', ...extra });
  const call = (name, body = {}, headers = good()) => req(sp, { method: 'POST', path: `/setup/tunnel/${name}`, headers, body });
  return { s, sp, url, origin, page, nonce, good, call };
}

const FORM = (fake, extra = {}) => ({ token: fake.token, hostname: 'wc.example.test', email: 'Me@Example.test', signin: 'pin+biometric', ...extra });

test('the launcher opens the page on its own origin: 127.0.0.1, a port that is not the daemon\'s', async (t) => {
  const { s, url, sp, page } = await boot(t);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/setup/tunnel');
  assert.notEqual(sp, s.port, 'NOT the daemon\'s port — the replay renderer runs pane code on 127.0.0.1:<daemon>');
  assert.equal(page.status, 200);
  const csp = page.headers['content-security-policy'];
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, 'no inline script on the page that takes the token');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin', 'the surface tab keeps no handle on it');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.doesNotMatch(page.text, /<script>|<script [^>]*>[^<]/, 'no inline script body');
  // a second load mints a different nonce
  const again = await req(sp, { path: '/setup/tunnel', headers: { host: `127.0.0.1:${sp}` } });
  assert.notEqual(/content="([^"]+)">\n<title/.exec(again.text)[1], /content="([^"]+)">\n<title/.exec(page.text)[1]);
});

test('the launcher is refused to a tunnelled (remote) request and starts nothing', async (t) => {
  const s = await withServer(t);
  const r = await req(s.port, { path: '/tunnel/setup', headers: { host: `localhost:${s.port}`, 'x-wc-remote': '1' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.remote, true);
  assert.match(r.json.hint, /host/);
});

test('every setup route refuses a pane-origin, foreign, nonce-less or preflighted call — and Cloudflare hears nothing', async (t) => {
  const fake = await withFakeCloudflare(t);
  const { s, sp, good, call, origin } = await boot(t, { fake });
  const body = FORM(fake);
  const drop = (h, k) => { const o = { ...h }; delete o[k]; return o; };
  const cases = [
    ['no Origin', drop(good(), 'origin'), 403],
    ['the surface\'s origin (a pane\'s fetch)', good({ origin: `http://localhost:${s.port}` }), 403],
    ['127.0.0.1 on the DAEMON port (a replay frame\'s pane)', good({ origin: `http://127.0.0.1:${s.port}` }), 403],
    ['a website', good({ origin: 'https://evil.example' }), 403],
    ['no nonce', drop(good(), 'x-wc-setup'), 403],
    ['a forged nonce', good({ 'x-wc-setup': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }), 403],
    ['a form-encoded body', good({ 'content-type': 'text/plain' }), 403],
    ['a cross-site fetch', good({ 'sec-fetch-site': 'cross-site' }), 403],
    ['a same-site (other port) fetch', good({ 'sec-fetch-site': 'same-site' }), 403],
    ['a rebound Host', good({ host: `localhost:${sp}` }), 421],
    ['a tunnelled request', good({ 'x-wc-remote': '1' }), 403],
  ];
  for (const name of ['status', 'plan', 'apply', 'up']) {
    for (const [what, headers, status] of cases) {
      const r = await call(name, body, headers);
      assert.equal(r.status, status, `${name}: ${what} → ${r.status} ${r.text}`);
      assert.ok(!r.headers['access-control-allow-origin'], `${name}: ${what} carries no CORS allowance`);
      assert.ok(!r.text.includes(fake.token));
    }
    // The preflight a cross-origin fetch with X-WC-Setup must send first.
    const pre = await req(sp, {
      method: 'OPTIONS', path: `/setup/tunnel/${name}`,
      headers: {
        host: `127.0.0.1:${sp}`, origin: `http://localhost:${s.port}`,
        'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-wc-setup',
      },
    });
    assert.equal(pre.status, 403, `${name}: the preflight is refused`);
    for (const h of Object.keys(pre.headers)) assert.ok(!h.startsWith('access-control-'), `${name}: preflight answered with ${h}`);
  }
  assert.deepEqual(fake.calls, [], 'no refused call reached Cloudflare');
  assert.ok(!fs.existsSync(userPaths().tunnelConfig), 'and nothing was written');
  // the same page, with its own origin and nonce, is answered
  const ok = await call('status');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.ok(origin.startsWith('http://127.0.0.1:'));
});

test('status: the permissions come from cf-api PERMS (the one list), with the dashboard links, before any setup', async (t) => {
  const { call } = await boot(t);
  const r = await call('status');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.perms, Object.values(PERMS));
  assert.match(r.json.links.token, /^https:\/\/dash\.cloudflare\.com\//);
  assert.match(r.json.links.zeroTrust, /^https:\/\/one\.dash\.cloudflare\.com/);
  assert.equal(r.json.status.configured, false);
  assert.equal(r.json.status.portal.running, false);
  assert.ok(!('sessions' in r.json.status && Array.isArray(r.json.status.sessions)), 'no other projects\' names on the page');
});

test('plan → apply → status: the one-token setup from the page, the CLI\'s lines, the token never echoed or stored', async (t) => {
  const fake = await withFakeCloudflare(t);
  const { call } = await boot(t, { fake });
  const out = [];
  for (const m of ['log', 'error', 'warn']) t.mock.method(console, m, (...a) => { out.push(a.join(' ')); });

  const plan = await call('plan', FORM(fake));
  assert.equal(plan.status, 200);
  assert.equal(plan.json.ok, true, plan.text);
  assert.ok(plan.json.lines.some((l) => l === 'The plan (nothing is changed with --dry-run):'), 'the CLI\'s plan text');
  assert.ok(plan.json.plan.steps.length > 3);
  assert.equal(plan.json.team, fake.team);
  assert.deepEqual(fake.writes(), [], 'a plan writes nothing');
  assert.ok(!fs.existsSync(userPaths().tunnelConfig));

  const apply = await call('apply', FORM(fake));
  assert.equal(apply.status, 200);
  assert.match(apply.headers['content-type'], /ndjson/);
  const { lines, final } = ndjson(apply.text);
  assert.equal(final.ok, true, apply.text);
  assert.equal(final.signin, 'pin+biometric');
  assert.equal(final.picker, 'https://wc.example.test/');
  assert.ok(lines.includes('Applying:'));
  assert.ok(lines.includes('  ✓ the API token was not saved'));
  assert.ok(lines.some((l) => l.startsWith('Then: claude-web-chat tunnel up')));

  const cfg = loadConfig();
  assert.equal(cfg.hostname, 'wc.example.test');
  assert.deepEqual(cfg.allow.emails, ['me@example.test']);
  assert.equal(cfg.access.team, fake.team);
  assert.equal(cfg.signin, 'pin+biometric');
  assert.equal(fs.statSync(userPaths().tunnelConfig).mode & 0o777, 0o600);
  const connector = fs.readFileSync(userPaths().tunnelToken, 'utf8').trim();
  assert.ok(connector && connector !== fake.token, 'the CONNECTOR token is stored, not the API token');

  const st = await call('status');
  assert.equal(st.json.status.configured, true);
  assert.equal(st.json.status.picker, 'https://wc.example.test/');
  assert.equal(st.json.status.signin, 'pin+biometric');
  assert.deepEqual(st.json.defaults, { hostname: 'wc.example.test', emails: ['me@example.test'] });

  // Never echoed, never logged, never on disk.
  for (const r of [plan, apply, st]) assert.ok(!r.text.includes(fake.token), 'a response carries the API token');
  assert.ok(!out.join('\n').includes(fake.token), 'the daemon logged the API token');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(userPaths().root)) assert.ok(!fs.readFileSync(f, 'utf8').includes(fake.token), `${f} holds the API token`);

  // A re-run from the page converges: nothing written.
  const before = fake.writes().length;
  const again = ndjson((await call('apply', FORM(fake))).text);
  assert.equal(again.final.ok, true);
  assert.equal(fake.writes().length, before, 'a second apply changes nothing in Cloudflare');
});

test('a conflict stops the page\'s plan and apply before any write, with the CLI\'s explanation', async (t) => {
  const fake = await withFakeCloudflare(t);
  fake.db.dns.push({ id: 'r1', zone_id: 'zone000000000000000000000000001', type: 'A', name: 'wc.example.test', content: '192.0.2.7', proxied: false });
  const { call } = await boot(t, { fake });
  const plan = await call('plan', FORM(fake));
  assert.equal(plan.json.ok, false);
  assert.match(plan.json.error, /setup stopped before changing anything/);
  assert.ok(plan.json.lines.some((l) => /✗ DNS already has A wc\.example\.test/.test(l)));
  const apply = ndjson((await call('apply', FORM(fake))).text);
  assert.equal(apply.final.ok, false);
  assert.deepEqual(fake.writes(), []);
});

test('a token pasted into the wrong field is scrubbed from the answer, in any case', async (t) => {
  const fake = await withFakeCloudflare(t);
  const { call } = await boot(t, { fake });
  // the config check echoes a bad hostname back — lowercased
  const r = await call('plan', FORM(fake, { hostname: fake.token }));
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /‹API token›/, 'the echo is there, with the token taken out');
  assert.ok(!r.text.toLowerCase().includes(fake.token.toLowerCase()), 'no spelling of the token survives');
  const a = await call('apply', FORM(fake, { hostname: fake.token }));
  assert.ok(!a.text.toLowerCase().includes(fake.token.toLowerCase()));
});

test('a token that sees several accounts gets a choice, and the chosen one is used', async (t) => {
  const fake = await withFakeCloudflare(t, {
    accounts: [{ id: 'acc0000000000000000000000000001', name: 'Test Account' }, { id: 'acc0000000000000000000000000002', name: 'Other' }],
  });
  const { call } = await boot(t, { fake });
  const r = await call('plan', FORM(fake));
  assert.equal(r.json.ok, false);
  assert.deepEqual(r.json.accounts.map((a) => a.name), ['Test Account', 'Other']);
  const chosen = await call('plan', FORM(fake, { account: 'acc0000000000000000000000000001' }));
  assert.equal(chosen.json.ok, true, chosen.text);
  assert.equal(chosen.json.account.id, 'acc0000000000000000000000000001');
});

test('bad input is refused before Cloudflare is asked: no token, no email, Google sign-in (the terminal\'s)', async (t) => {
  const fake = await withFakeCloudflare(t);
  const { call } = await boot(t, { fake });
  const cases = [
    [FORM(fake, { token: '' }), /API token/],
    [FORM(fake, { email: '' }), /email/],
    [FORM(fake, { hostname: '' }), /hostname/],
    [FORM(fake, { signin: 'google' }), /tunnel setup --signin google/],
  ];
  for (const [body, re] of cases) {
    const r = await call('plan', body);
    assert.equal(r.status, 400);
    assert.match(r.json.error, re);
  }
  assert.deepEqual(fake.calls, []);
});

test('Bring it up runs lib/tunnel/control up — its preflight refuses a machine with no setup, and a running one streams its lines', async (t) => {
  // The REAL control: with no tunnel.json, up's own preflight refuses.
  {
    const { call } = await boot(t);
    const r = ndjson((await call('up')).text);
    assert.equal(r.final.ok, false);
    assert.match(r.final.error, /tunnel setup|tunnel\.json/);
  }
  // A stand-in for control (starting a real portal is tunnel-cli.test's job):
  // the page hands up() its log and reports what it said.
  {
    const seen = [];
    const control = {
      ...require('../lib/tunnel/control'),
      up: async (flags, { log }) => { seen.push(flags); log('✓ portal up — pid 1 on 127.0.0.1:5171'); return { already: false }; },
    };
    const { call } = await boot(t, { control });
    const r = ndjson((await call('up')).text);
    assert.deepEqual(r.lines, ['✓ portal up — pid 1 on 127.0.0.1:5171']);
    assert.equal(r.final.ok, true);
    assert.equal(seen.length, 1);
  }
});

test('one step at a time: a second plan/apply/up while one runs is refused', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const control = { ...require('../lib/tunnel/control'), up: async () => { await gate; return { already: true }; } };
  const { call } = await boot(t, { control });
  const first = call('up');
  await new Promise((r) => setTimeout(r, 50));
  const second = await call('up');
  assert.equal(second.status, 409);
  const st = await call('status');
  assert.equal(st.status, 200, 'status is still answered');
  assert.equal(st.json.busy, true);
  release();
  assert.equal(ndjson((await first).text).final.ok, true);
});

test('the listener closes when idle, and its nonces die with it', async (t) => {
  const setup = createTunnelSetup({ paths: {}, idleMs: 60 });
  t.after(() => setup.close());
  const { port } = await setup.ensure();
  const page = await req(port, { path: '/setup/tunnel', headers: { host: `127.0.0.1:${port}` } });
  assert.equal(page.status, 200);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(setup.port, null, 'closed after the idle window');
  await assert.rejects(req(port, { path: '/setup/tunnel', headers: { host: `127.0.0.1:${port}` } }));
  const again = await setup.ensure();
  assert.ok(again.port);
});

test('the daemon\'s stop closes the setup listener', async (t) => {
  const { s, sp } = await boot(t);
  await s.stop();
  await assert.rejects(req(sp, { path: '/setup/tunnel', headers: { host: `127.0.0.1:${sp}` } }));
});
