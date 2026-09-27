// `tunnel setup --api-token` — the one-token Cloudflare setup (lib/tunnel/cf-api
// + cf-setup, driven by lib/cli/commands/tunnel), against the in-process fake
// API (test-support/fake-cloudflare). Nothing here reaches Cloudflare.
//
// What must hold:
//   * one run creates everything once — login method, tunnel, its routes, both
//     DNS records, the Access policy and application — and writes a
//     tunnel.json the portal accepts, with the team and AUD read back and the
//     sign-in recorded; the API token is never written anywhere.
//   * a re-run converges: it writes nothing at all.
//   * a record setup would clobber stops the run before ANY write, with the
//     reason; so does a same-named tunnel that is locally managed.
//   * independent MFA refused → the PIN alone, said and recorded.
//   * a token missing a permission is told which one.
//   * --dry-run reads, prints the plan, writes nothing (not even tunnel.json).
//   * a 429 is waited out; Google sign-in creates the IdP from the OAuth client.
//   * (s4l-1) a token that cannot list /accounts finds its account through the
//     zones; --account <id> is used without listing; a refusal names both the
//     classic and the newer permission label; a wildcard on the zone apex is
//     warned about in the plan, never refused.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const tunnel = require('../lib/cli/commands/tunnel');
const { withTempHome } = require('../test-support/helpers');
const { withFakeCloudflare } = require('../test-support/fake-cloudflare');
const { createFakeAccess } = require('../test-support/fake-access');
const { userPaths } = require('../lib/core/paths');
const { loadConfig } = require('../lib/tunnel/config');
const { createCfApi, PERMS } = require('../lib/tunnel/cf-api');
const outbound = require('../lib/util/outbound');

function capture() {
  const lines = [];
  return { log: (s) => lines.push(String(s)), lines, text: () => lines.join('\n') };
}
function quietPrompt(answers = {}) {
  return {
    line: async (q) => { for (const [k, v] of Object.entries(answers)) if (q.includes(k)) return v; return ''; },
    confirm: async (q, { def = false } = {}) => def,
    close() {},
  };
}

// One setup run against the fake, the token handed over in a file.
async function run(fake, extra = [], { prompt = quietPrompt(), access = createFakeAccess({ team: fake.team }) } = {}) {
  const tokFile = path.join(userPaths().root, 'cf-token');
  fs.mkdirSync(userPaths().root, { recursive: true });
  fs.writeFileSync(tokFile, `${fake.token}\n`);
  const c = capture();
  const env = { ...process.env, WEB_CHAT_CF_API: fake.base };
  const p = tunnel(['setup', '--api-token-file', tokFile, '--hostname', 'wc.example.test', '--email', 'Me@Example.test', ...extra],
    { log: c.log, prompt, env, fetchJwks: access.fetchJwks });
  return { c, p, tokFile };
}

// Every file under HOME, except the token file the test itself wrote.
function filesUnder(dir, skip) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(f, skip));
    else if (f !== skip) out.push(f);
  }
  return out;
}

test('one token: creates everything once, writes a config the portal accepts, never stores the API token', async (t) => {
  const home = withTempHome(t);
  const fake = await withFakeCloudflare(t);
  const { c, p, tokFile } = await run(fake);
  const config = await p;

  const { db } = fake;
  assert.equal(db.idps.length, 1);
  assert.equal(db.idps[0].type, 'onetimepin', 'the One-time PIN login method was created');
  assert.equal(db.tunnels.length, 1);
  const tid = db.tunnels[0].id;
  assert.equal(db.tunnels[0].remote_config, true, 'a remotely managed tunnel');
  assert.deepEqual(db.configs.get(tid).ingress, [
    { hostname: 'wc.example.test', service: 'http://127.0.0.1:5171' },
    { hostname: '*.example.test', service: 'http://127.0.0.1:5171' },
    { service: 'http_status:404' },
  ]);
  assert.deepEqual(db.dns.map((r) => [r.type, r.name, r.content, r.proxied]).sort(), [
    ['CNAME', '*.example.test', `${tid}.cfargotunnel.com`, true],
    ['CNAME', 'wc.example.test', `${tid}.cfargotunnel.com`, true],
  ]);
  assert.equal(db.policies.length, 1);
  assert.deepEqual(db.policies[0].include, [{ email: { email: 'me@example.test' } }]);
  assert.equal(db.policies[0].decision, 'allow');
  assert.ok(db.org.mfa_config && db.org.mfa_config.allowed_authenticators.includes('biometrics'), 'org-level independent MFA turned on');
  assert.equal(db.org.mfa_required_for_all_apps, false, 'and not forced on the account\'s other apps');
  assert.equal(db.apps.length, 1);
  const app = db.apps[0];
  assert.equal(app.type, 'self_hosted');
  assert.deepEqual(app.destinations.map((d) => d.uri), ['wc.example.test', 'wc-*.example.test']);
  assert.equal(app.session_duration, '720h');
  assert.deepEqual(app.allowed_idps, [db.idps[0].id]);
  assert.deepEqual(app.policies.map((x) => x.id), [db.policies[0].id]);
  assert.deepEqual(app.mfa_config, { mfa_disabled: false, allowed_authenticators: ['biometrics', 'security_key'], session_duration: '720h' });

  // What the portal will read.
  const loaded = loadConfig();
  assert.equal(loaded.access.team, fake.team, 'team name read back from the organization');
  assert.equal(loaded.access.aud, app.aud, 'AUD tag read back from the application');
  assert.deepEqual(loaded.allow.emails, ['me@example.test']);
  assert.deepEqual(loaded.tunnel, { kind: 'token', name: 'web-chat', credentialsFile: null, metricsPort: 5172 });
  assert.equal(loaded.signin, 'pin+biometric');
  assert.equal(config.signin, 'pin+biometric');
  assert.equal(fs.readFileSync(userPaths().tunnelToken, 'utf8'), `eyJ-connector-${tid}\n`, 'the connector token is stored, as before');
  assert.equal(fs.statSync(userPaths().tunnelToken).mode & 0o777, 0o600);

  // The API token went in the Authorization header and nowhere on disk.
  assert.ok(fake.calls.every((x) => x.auth === `Bearer ${fake.token}`));
  for (const f of filesUnder(home, tokFile)) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes(fake.token), `${f} holds the API token`);
  }
  const out = c.text();
  assert.match(out, /Sign-in: emailed one-time PIN \+ biometrics/);
  assert.match(out, /the API token was not saved/);
  assert.match(out, /Then: claude-web-chat tunnel up/);
});

test('one token: a re-run converges and writes nothing', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  await (await run(fake)).p;
  const before = fake.writes().length;
  const aud = loadConfig().access.aud;
  const { c, p } = await run(fake);
  await p;
  assert.deepEqual(fake.writes().slice(before), [], 'no write on the second run');
  assert.equal(fake.db.apps.length, 1);
  assert.equal(fake.db.tunnels.length, 1);
  assert.equal(fake.db.dns.length, 2);
  assert.equal(loadConfig().access.aud, aud);
  assert.match(c.text(), /keep {5}tunnel "web-chat"/);
});

test('one token: a new email converges the policy in place', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  await (await run(fake)).p;
  const before = fake.writes().length;
  await (await run(fake, ['--email', 'second@example.test'])).p;
  const writes = fake.writes().slice(before);
  assert.deepEqual(writes.map((w) => `${w.method} ${w.path.replace(/[0-9a-f-]{36}/, '<id>')}`), ['PUT /accounts/acc0000000000000000000000000001/access/policies/<id>']);
  assert.deepEqual(fake.db.policies[0].include.map((i) => i.email.email).sort(), ['me@example.test', 'second@example.test']);
});

test('one token: a DNS record in the way stops the run before any write', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  fake.db.dns.push({ id: 'r1', zone_id: 'zone000000000000000000000000001', type: 'A', name: 'wc.example.test', content: '192.0.2.7', proxied: false });
  const { c, p } = await run(fake);
  await assert.rejects(p, (e) => e.userFacing && /stopped before changing anything/.test(e.message));
  assert.match(c.text(), /DNS already has A wc\.example\.test → 192\.0\.2\.7 — setup never replaces a record you made/);
  assert.deepEqual(fake.writes(), []);
  assert.equal(fs.existsSync(userPaths().tunnelConfig), false);
});

test('one token: a same-named tunnel that is locally managed is a conflict, not a takeover', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  fake.db.tunnels.push({ id: '11111111-1111-4111-8111-111111111111', name: 'web-chat', remote_config: false, deleted_at: null });
  const { c, p } = await run(fake);
  await assert.rejects(p, /stopped before changing anything/);
  assert.match(c.text(), /managed from a local config file/);
  assert.deepEqual(fake.writes(), []);
});

test('one token: independent MFA refused → the emailed PIN alone, said and recorded', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  fake.sim.mfaRefused = true;
  const { c, p } = await run(fake);
  await p;
  assert.equal(loadConfig().signin, 'pin');
  assert.equal(fake.db.apps.length, 1);
  assert.equal(fake.db.apps[0].mfa_config, undefined, 'the application carries no MFA requirement');
  assert.equal(fake.db.apps[0].session_duration, '720h', 'a long session instead');
  assert.match(c.text(), /Sign-in: emailed one-time PIN — Cloudflare would not turn on independent MFA.*not available for this account.*PIN alone, with a 720h session/);
});

test('one token: a missing permission is named', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  fake.sim.missing = ['org'];
  const { p } = await run(fake);
  await assert.rejects(p, (e) => e.userFacing && e.message.includes(`missing a permission: ${PERMS.org}`));
  assert.deepEqual(fake.writes(), []);
});

test('one token: a token Cloudflare rejects says so', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  fake.sim.badToken = true;
  const { p } = await run(fake);
  await assert.rejects(p, /Cloudflare did not accept the API token.*Invalid API Token/);
});

test('one token: --dry-run prints the plan and writes nothing, not even tunnel.json', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  const { c, p } = await run(fake, ['--dry-run']);
  const r = await p;
  assert.equal(r.dryRun, true);
  assert.deepEqual(fake.writes(), []);
  assert.equal(fs.existsSync(userPaths().tunnelConfig), false);
  assert.equal(fs.existsSync(userPaths().tunnelToken), false);
  assert.match(c.text(), /create {3}DNS \*\.example\.test/);
  assert.match(c.text(), /--dry-run: nothing was changed/);
});

test('one token: a rate limit is waited out', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  fake.sim.rateLimit = 2;
  await (await run(fake)).p;
  assert.equal(fake.calls.filter((x) => x.path === '/user/tokens/verify').length, 3, 'two 429s, then through');
  assert.equal(fake.db.apps.length, 1);
});

test('one token: a user\'s own tunnel route survives, ahead of the wildcard', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  const id = '22222222-2222-4222-8222-222222222222';
  fake.db.tunnels.push({ id, name: 'web-chat', remote_config: true, deleted_at: null });
  fake.db.configs.set(id, { ingress: [{ hostname: 'blog.example.test', service: 'http://127.0.0.1:8080' }, { service: 'http_status:404' }], warp_routing: { enabled: false } });
  await (await run(fake)).p;
  const cfg = fake.db.configs.get(id);
  assert.deepEqual(cfg.ingress.map((r) => r.hostname || r.service), ['blog.example.test', 'wc.example.test', '*.example.test', 'http_status:404']);
  assert.deepEqual(cfg.warp_routing, { enabled: false }, 'the rest of the tunnel config is kept');
});

test('one token: --signin google prints the OAuth client values and creates the Google login method', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  const secret = path.join(userPaths().root, 'g-secret');
  fs.mkdirSync(userPaths().root, { recursive: true });
  fs.writeFileSync(secret, 'g-client-secret\n');
  const { c, p } = await run(fake, ['--signin', 'google', '--google-client-id', 'g-client.apps.googleusercontent.com', '--google-client-secret-file', secret]);
  await p;
  assert.match(c.text(), /Authorized redirect URIs: +https:\/\/testteam\.cloudflareaccess\.com\/cdn-cgi\/access\/callback/);
  assert.match(c.text(), /Authorized JavaScript origins: +https:\/\/testteam\.cloudflareaccess\.com/);
  const g = fake.db.idps.find((i) => i.type === 'google');
  assert.deepEqual(g.config, { client_id: 'g-client.apps.googleusercontent.com', client_secret: 'g-client-secret' });
  assert.deepEqual(fake.db.apps[0].allowed_idps, [g.id]);
  assert.equal(fake.db.org.mfa_config, undefined, 'Google sign-in leaves independent MFA alone');
  assert.equal(loadConfig().signin, 'google');
  assert.match(c.text(), /Sign-in: Google login/);
});

test('setup: the one-token and manual flags do not mix', async (t) => {
  withTempHome(t);
  await assert.rejects(tunnel(['setup', '--api-token-file', '/nope', '--team', 'x'], { log: () => {}, prompt: quietPrompt() }),
    (e) => e.userFacing && /do not go together/.test(e.message));
});

test('setup: a first run with no flags offers the one-token path, and a paste is required', async (t) => {
  withTempHome(t);
  const c = capture();
  await assert.rejects(tunnel(['setup'], { log: c.log, prompt: quietPrompt() }), /no Cloudflare API token/);
  assert.match(c.text(), /Create Custom Token, with these permissions:/);
  for (const perm of Object.values(PERMS)) assert.ok(c.text().includes(perm), perm);
  assert.equal(Object.keys(PERMS).length, 5, 'five permissions, Account Settings › Read among them');
  assert.match(c.text(), /Cloudflare Tunnel › Edit {3}\(newer dashboards: Cloudflare One Connector: cloudflared › Edit\)/);
  assert.match(c.text(), /Account Settings › Read lets setup list your account; without it, it finds the account through your zone/);
});

test('cf-api: WEB_CHAT_CF_API cannot send the token in cleartext off this machine', async () => {
  const api = createCfApi({ token: 't', env: { WEB_CHAT_CF_API: 'http://api.example.test/client/v4' } });
  await assert.rejects(api.verifyToken(), /refusing plaintext http to api\.example\.test/);
  assert.throws(() => outbound.transportFor(new URL('ftp://x.test/')), /unsupported scheme/);
  assert.equal(outbound.transportFor(new URL('http://127.0.0.1:1/')), require('http'));
  assert.equal(outbound.transportFor(new URL('https://api.cloudflare.com/')), require('https'));
});

// ── s3b-2: the rest of what the fake can simulate ───────────────────────────

// The account's state, minus bookkeeping — what a no-op re-run must leave alone.
const snapshot = (fake) => JSON.stringify({ ...fake.db, configs: [...fake.db.configs] });

// Account Settings › Read is recommended, not required (setup finds the
// account through the zones without it) — its own tests are below.
for (const [key, perm] of Object.entries(PERMS).filter(([k]) => k !== 'account')) {
  test(`one token: a token without ${perm} is told so, before any write`, async (t) => {
    withTempHome(t);
    const fake = await withFakeCloudflare(t);
    fake.sim.missing = [key];
    const { p } = await run(fake);
    await assert.rejects(p, (e) => e.userFacing && e.message.includes(`missing a permission: ${perm}`)
      && Object.values(PERMS).filter((x) => x !== perm).every((x) => !e.message.includes(x)));
    assert.deepEqual(fake.writes(), []);
    assert.equal(fs.existsSync(userPaths().tunnelConfig), false);
  });
}

test('one token: a hostname in no zone on the account stops the run and says what to add', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t, { zones: [{ id: 'zone000000000000000000000000009', name: 'other.test' }] });
  const { p } = await run(fake);
  await assert.rejects(p, (e) => e.userFacing && /no zone on account "Test Account" holds wc\.example\.test — add the domain to Cloudflare first/.test(e.message));
  assert.deepEqual(fake.writes(), []);
});

test('one token: Zero Trust never turned on is named, with where to turn it on', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  fake.sim.zeroTrust = false;
  const { p } = await run(fake);
  await assert.rejects(p, (e) => e.userFacing && /Zero Trust is not turned on.*one\.dash\.cloudflare\.com/.test(e.message));
  assert.deepEqual(fake.writes(), []);
});

test('one token: a rate limit that does not lift stops the run and says to wait', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  fake.sim.rateLimit = 100;
  const { p } = await run(fake);
  await assert.rejects(p, (e) => e.userFacing && /rate limited \(HTTP 429\) — wait a minute/.test(e.message));
  assert.equal(fake.calls.length, 4, 'three retries, then it gives up');
  assert.deepEqual(fake.writes(), []);
});

test('one token: --dry-run with a conflict still prints it, and still writes nothing', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  fake.db.dns.push({ id: 'r1', zone_id: 'zone000000000000000000000000001', type: 'CNAME', name: '*.example.test', content: 'elsewhere.example.net', proxied: true });
  const { c, p } = await run(fake, ['--dry-run']);
  await assert.rejects(p, /stopped before changing anything/);
  assert.match(c.text(), /✗ DNS already has CNAME \*\.example\.test → elsewhere\.example\.net/);
  assert.deepEqual(fake.writes(), []);
  assert.equal(fs.existsSync(userPaths().tunnelToken), false);
});

test('one token: --dry-run against a set-up account plans only keeps', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  await (await run(fake)).p;
  const before = fake.writes().length;
  const { c, p } = await run(fake, ['--dry-run']);
  const r = await p;
  assert.deepEqual(r.plan.steps.map((s) => s.action).filter((a) => a !== 'keep' && a !== 'converge'), []);
  assert.equal(fake.writes().length, before);
  assert.match(c.text(), /--dry-run: nothing was changed/);
});

test('one token: MFA taken by the organization but refused on the application → the PIN, said and recorded', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  fake.sim.mfaRefused = 'app';
  const { c, p } = await run(fake);
  await p;
  assert.equal(loadConfig().signin, 'pin');
  assert.equal(fake.db.apps.length, 1, 'one application, written once without MFA');
  assert.equal(fake.db.apps[0].mfa_config, undefined);
  assert.match(c.text(), /Sign-in: emailed one-time PIN — Cloudflare would not require independent MFA on the application:.*with a 720h session/);
});

test('one token: after an MFA refusal a re-run changes nothing, and a later plan that allows it upgrades in place', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  fake.sim.mfaRefused = true;
  await (await run(fake)).p;
  const snap = snapshot(fake);
  const aud = loadConfig().access.aud;
  await (await run(fake)).p;
  assert.equal(snapshot(fake), snap, 'the refused re-run left the account as it was');
  assert.equal(loadConfig().signin, 'pin');

  fake.sim.mfaRefused = false;
  const { c, p } = await run(fake);
  await p;
  assert.equal(fake.db.apps.length, 1, 'the same application, updated');
  assert.equal(fake.db.apps[0].aud, aud, 'so its AUD tag — and the portal config — stays');
  assert.equal(fake.db.apps[0].mfa_config.mfa_disabled, false);
  assert.equal(loadConfig().signin, 'pin+biometric');
  assert.match(c.text(), /Sign-in: emailed one-time PIN \+ biometrics/);
});

test('one token: a run that dies half way is finished by the next, with nothing duplicated', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  fake.sim.fail = [{ method: 'POST', path: /\/access\/policies$/ }];
  await assert.rejects((await run(fake)).p, /simulated failure/);
  assert.equal(fake.db.tunnels.length, 1, 'the tunnel was made before the failure');
  assert.equal(fake.db.apps.length, 0);
  assert.equal(fs.existsSync(userPaths().tunnelConfig), false, 'no config for a half-made setup');

  await (await run(fake)).p;
  assert.equal(fake.db.tunnels.length, 1);
  assert.equal(fake.db.dns.length, 2);
  assert.equal(fake.db.idps.length, 1);
  assert.equal(fake.db.policies.length, 1);
  assert.equal(fake.db.apps.length, 1);
  assert.equal(loadConfig().access.aud, fake.db.apps[0].aud);
});

test('one token: a token that sees two accounts needs --account, and takes it', async (t) => {
  withTempHome(t);
  const accounts = [
    { id: 'acc0000000000000000000000000001', name: 'Test Account' },
    { id: 'acc0000000000000000000000000002', name: 'Other Account' },
  ];
  const fake = await withFakeCloudflare(t, { accounts });
  await assert.rejects((await run(fake)).p, (e) => e.userFacing && /sees 2 accounts — pick one with --account/.test(e.message));
  assert.deepEqual(fake.writes(), []);
  await (await run(fake, ['--account', accounts[0].id])).p;
  assert.equal(fake.db.apps.length, 1);
});

test('one token: a pasted token, and one passed as a flag value, are not stored either', async (t) => {
  const home = withTempHome(t);
  const fake = await withFakeCloudflare(t);
  const env = { ...process.env, WEB_CHAT_CF_API: fake.base };
  const access = createFakeAccess({ team: fake.team });
  const base = ['setup', '--hostname', 'wc.example.test', '--email', 'me@example.test'];

  const pasted = capture();
  await tunnel(base, { log: pasted.log, env, fetchJwks: access.fetchJwks, prompt: quietPrompt({ 'Paste the Cloudflare API token': fake.token }) });
  assert.match(pasted.text(), /the API token was not saved/);

  const flagged = capture();
  await tunnel([...base, '--api-token', fake.token], { log: flagged.log, env, fetchJwks: access.fetchJwks, prompt: quietPrompt() });
  assert.match(flagged.text(), /--api-token puts the token in your shell history/);

  for (const f of filesUnder(home, null)) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes(fake.token), `${f} holds the API token`);
  }
  assert.equal(fake.db.apps.length, 1);
});

// ── s4l-1: account discovery, --account without listing, permission names,
// the apex-wildcard warning ────────────────────────────────────────────────

const ACC1 = 'acc0000000000000000000000000001';
const ACC2 = 'acc0000000000000000000000000002';

test('one token: /accounts empty (no Account Settings › Read) → the account is found through the zone', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  fake.sim.missing = ['account'];
  const { c, p } = await run(fake);
  await p;
  assert.ok(fake.calls.some((x) => x.path === '/accounts'), 'it tried to list accounts first');
  assert.equal(fake.db.apps.length, 1, 'and set up on the zone\'s account');
  assert.match(c.text(), /account Test Account · zone example\.test/);
  assert.match(c.text(), /found through the zone — the token cannot list accounts without Account › Account Settings › Read/);
});

test('one token: an account-owned token without Account Settings › Read still verifies, against its zone\'s account', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  fake.sim.missing = ['account'];
  fake.sim.accountOwned = true;
  await (await run(fake)).p;
  assert.ok(fake.calls.some((x) => x.path === `/accounts/${ACC1}/tokens/verify`));
  assert.equal(fake.db.apps.length, 1);
});

test('one token: zones on two accounts and no /accounts → needs --account, lists both', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t, {
    accounts: [{ id: ACC1, name: 'Test Account' }, { id: ACC2, name: 'Other Account' }],
    zones: [
      { id: 'zone000000000000000000000000001', name: 'example.test' },
      { id: 'zone000000000000000000000000002', name: 'other.test', account: { id: ACC2, name: 'Other Account' } },
    ],
  });
  fake.sim.missing = ['account'];
  await assert.rejects((await run(fake)).p,
    (e) => e.userFacing && /sees 2 accounts — pick one with --account <id>: Test Account \(acc0+1\), Other Account \(acc0+2\)/.test(e.message));
  assert.deepEqual(fake.writes(), []);
});

test('one token: --account <id> is used directly, without listing accounts', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t, { accounts: [{ id: ACC1, name: 'Test Account' }, { id: ACC2, name: 'Other Account' }] });
  const { c, p } = await run(fake, ['--account', ACC1]);
  await p;
  assert.equal(fake.calls.filter((x) => x.path === '/accounts').length, 0, 'no GET /accounts');
  assert.ok(fake.calls.some((x) => x.path === `/accounts/${ACC1}`), 'one cheap account-scoped read instead');
  assert.equal(fake.db.apps.length, 1);
  assert.match(c.text(), /account Test Account · zone example\.test/);
});

test('one token: --account <id> works without Account Settings › Read — a tunnel probe proves it, the zone names it', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  fake.sim.missing = ['account'];
  const { c, p } = await run(fake, ['--account', ACC1]);
  await p;
  assert.equal(fake.calls.filter((x) => x.path === '/accounts' || x.path === '/zones' && !x.query.name).length, 0, 'no listing of any kind');
  assert.ok(fake.calls.some((x) => x.path === `/accounts/${ACC1}/cfd_tunnel` && x.query.per_page === '1'), 'the probe');
  assert.match(c.text(), /account Test Account · zone example\.test/, 'the name, from the zone');
  assert.equal(fake.db.apps.length, 1);
});

test('one token: an --account the token cannot reach says so, with what it does see', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  await assert.rejects((await run(fake, ['--account', 'f'.repeat(32)])).p,
    (e) => e.userFacing && /cannot reach account "f{32}".*it sees: Test Account \(acc0+1\).*Copy account ID/.test(e.message));
  assert.deepEqual(fake.writes(), []);
});

test('one token: a token that can see no account and no zone names Account Settings › Read and --account', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t, { zones: [] });
  fake.sim.missing = ['account'];
  await assert.rejects((await run(fake)).p,
    (e) => e.userFacing && e.message.includes(`give it ${PERMS.account}`) && /or pass --account <id>/.test(e.message));
});

test('cf-api: a refused permission names the classic and the newer dashboard label', async (t) => {
  const { PERM_ALIASES } = require('../lib/tunnel/cf-api');
  const fake = await withFakeCloudflare(t);
  fake.sim.missing = ['tunnel'];
  const api = createCfApi({ token: fake.token, base: fake.base });
  await assert.rejects(api.createTunnel(ACC1, 'x'), (e) => e.message.includes(
    'missing a permission: Account › Cloudflare Tunnel › Edit (or, in newer dashboards: Account › Cloudflare One Connector: cloudflared › Edit)'));
  for (const k of ['tunnel', 'apps', 'org', 'dns']) assert.ok(PERM_ALIASES[PERMS[k]], `${k} has its newer name`);
});

test('one token: a wildcard on the zone apex is warned about in the plan, not refused', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  const { c, p } = await run(fake, ['--dry-run']);
  const r = await p;
  assert.deepEqual(r.plan.conflicts, []);
  assert.match(c.text(), /⚠ {2}DNS \*\.example\.test catches every undefined subdomain of example\.test; the portal refuses them \(421\) but they reach this machine/);
});

test('one token: a wildcard below the apex (nested style) carries no warning', async (t) => {
  withTempHome(t);
  const fake = await withFakeCloudflare(t);
  const { c, p } = await run(fake, ['--dry-run', '--style', 'nested']);
  const r = await p;
  assert.deepEqual(r.plan.warnings, []);
  assert.doesNotMatch(c.text(), /catches every undefined subdomain/);
});
