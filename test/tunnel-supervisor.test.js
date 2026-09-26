// cloudflared, as the tunnel portal runs it (lib/tunnel/cloudflared) — and the
// `tunnel` section of tunnel.json that says which named tunnel to run
// (lib/tunnel/config).
//
// The launch is the security-relevant part: the connector token is the
// tunnel's whole credential, so it travels in TUNNEL_TOKEN and never in argv
// (which any local user can read with `ps`); a local tunnel's generated ingress
// must send only our hostnames to the portal, 404 the rest, and make cloudflared
// require an Access token for our AUD as well. The supervision is the
// reliability part: restart with backoff, reset after a healthy run, and a
// connector that never outlives the portal. Every spawn here is REAL, of
// test-support/fake-cloudflared.js on PATH — no Cloudflare account involved.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { withTempHome, waitUntil, freePort, fakeCloudflared } = require('../test-support/helpers');
const { createFakeAccess } = require('../test-support/fake-access');
const { normalizeConfig } = require('../lib/tunnel/config');
const { isPidAlive } = require('../lib/core/portfiles');
const cf = require('../lib/tunnel/cloudflared');

function cfg(over = {}, tunnel = { kind: 'token', metricsPort: 5172 }) {
  return normalizeConfig(createFakeAccess().config({ tunnel, ...over }));
}

// ── config ──────────────────────────────────────────────────────────────────

test('config: the tunnel section is optional, validated, and a quick tunnel is refused', () => {
  assert.equal(normalizeConfig(createFakeAccess().config()).tunnel, null, 'absent → the portal runs alone');
  assert.deepEqual(cfg().tunnel, { kind: 'token', name: null, credentialsFile: null, metricsPort: 5172 });
  assert.equal(cfg({}, { kind: 'local', name: 'my-tunnel' }).tunnel.metricsPort, 5172, 'metrics port defaults to 5172');

  const refuses = (tunnel, re) => assert.throws(() => cfg({}, tunnel), (e) => e.userFacing && re.test(e.message), JSON.stringify(tunnel));
  refuses({ kind: 'quick' }, /quick tunnel.*cannot sit behind Cloudflare Access/);
  refuses({ kind: 'token', url: 'https://random-words.trycloudflare.com' }, /quick tunnel/);
  refuses({ kind: 'tcp' }, /tunnel\.kind must be one of token\|local/);
  refuses({}, /tunnel\.kind must be/);
  refuses({ kind: 'local' }, /tunnel\.name is required for a local tunnel/);
  refuses({ kind: 'local', name: 'bad name; rm -rf' }, /is not a tunnel name/);
  refuses({ kind: 'token', metricsPort: 70000 }, /metricsPort must be a port/);
});

// ── launch ──────────────────────────────────────────────────────────────────

test('launch (token): the connector token rides in TUNNEL_TOKEN, never in argv', () => {
  const secret = 'eyJhIjoiU0VDUkVUIn0-connector-token';
  const { argv, env } = cf.buildLaunch(cfg(), { portalPort: 5171, token: secret, env: { PATH: '/bin', TUNNEL_TOKEN: 'ambient' } });
  assert.deepEqual(argv, ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:5172', 'run']);
  assert.ok(!argv.join(' ').includes(secret), 'not in argv');
  assert.equal(env.TUNNEL_TOKEN, secret, 'ours, replacing any ambient one');
  assert.equal(env.PATH, '/bin');
  assert.throws(() => cf.buildLaunch(cfg(), { portalPort: 5171, token: null }), (e) => e.userFacing && /no connector token/.test(e.message));
});

test('launch (local): the generated config, the tunnel name, and no token at all', () => {
  const c = cfg({}, { kind: 'local', name: 'wc-home', credentialsFile: '/creds/abc.json', metricsPort: 6001 });
  const { argv, env } = cf.buildLaunch(c, { portalPort: 5171, configFile: '/x/cloudflared.yml', env: { TUNNEL_TOKEN: 'ambient' } });
  assert.deepEqual(argv, ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:6001', '--config', '/x/cloudflared.yml', 'run', 'wc-home']);
  assert.equal(env.TUNNEL_TOKEN, undefined, 'an ambient token would override the named tunnel — dropped');
});

test('ingress: our hostnames → the portal, Access required for our AUD, everything else 404', () => {
  const flat = cfg({}, { kind: 'local', name: 'wc-home', credentialsFile: '/creds/abc.json' });
  const y = cf.renderIngress(flat, { portalPort: 5999 });
  assert.match(y, /^tunnel: "wc-home"$/m);
  assert.match(y, /^credentials-file: "\/creds\/abc\.json"$/m);
  assert.match(y, /^originRequest:\n {2}access:\n {4}required: true\n {4}teamName: "testteam"\n {4}audTag:\n {6}- "test-aud-0123456789"$/m);
  assert.match(y, /- hostname: "wc\.example\.test"\n {4}service: "http:\/\/127\.0\.0\.1:5999"/);
  assert.match(y, /- hostname: "\*\.example\.test"\n {4}service: "http:\/\/127\.0\.0\.1:5999"/, 'flat sessions are siblings of the picker');
  const rules = y.split('ingress:\n')[1].split('\n').filter((l) => l.startsWith('  - '));
  assert.equal(rules[rules.length - 1], '  - service: http_status:404', 'the catch-all is last and refuses');
  assert.equal(rules.length, 3);

  const nested = cfg({ style: 'nested' }, { kind: 'local', name: 'wc-home' });
  const n = cf.renderIngress(nested, { portalPort: 5171 });
  assert.match(n, /- hostname: "\*\.wc\.example\.test"/);
  assert.doesNotMatch(n, /credentials-file/);
});

// ── the binary ──────────────────────────────────────────────────────────────

test('checkBinary: missing → the install line; too old → refused; current → ok', (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-nocf-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const missing = cf.checkBinary({ env: { PATH: empty } });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not on your PATH/);
  assert.match(missing.hint, process.platform === 'darwin' ? /brew install cloudflared/ : /pkg\.cloudflare\.com/);

  const fake = fakeCloudflared(t, { version: '2023.2.1' });
  const old = cf.checkBinary();
  assert.equal(old.ok, false);
  assert.equal(old.bin, path.join(fake.dir, 'cloudflared'));
  assert.match(old.error, /2023\.2\.1 is older than 2024\.1\.0/);

  process.env.FAKE_CF_VERSION = '2025.8.1';
  const good = cf.checkBinary();
  assert.deepEqual(good, { ok: true, bin: path.join(fake.dir, 'cloudflared'), version: '2025.8.1' });
});

test('installHint names the platform\'s route, and the WSL caveat under WSL', () => {
  assert.match(cf.installHint({ platform: 'darwin' }), /brew install cloudflared/);
  assert.match(cf.installHint({ platform: 'linux', env: {}, release: '6.8.0-generic' }), /pkg\.cloudflare\.com/);
  assert.doesNotMatch(cf.installHint({ platform: 'linux', env: {}, release: '6.8.0-generic' }), /WSL/);
  assert.match(cf.installHint({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, release: '5.15' }), /WSL install the LINUX build/);
});

// ── supervision (real spawns of the fake) ───────────────────────────────────

async function supervised(t, config, opts = {}) {
  const home = withTempHome(t);
  const dir = path.join(home, '.web-chat', 'tunnel');
  const sup = cf.createSupervisor({
    config,
    portalPort: 5171,
    logFile: path.join(dir, 'cloudflared.log'),
    configFile: path.join(dir, 'cloudflared.yml'),
    tokenFile: path.join(dir, 'token'),
    ...opts,
  });
  t.after(() => sup.stop());
  return { sup, dir };
}

test('supervisor (token): spawns with the token in its env only, is ready, and stop kills it', async (t) => {
  const fake = fakeCloudflared(t);
  const metricsPort = await freePort();
  const config = cfg({}, { kind: 'token', metricsPort });
  const { sup, dir } = await supervised(t, config);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'token'), 'SEKRIT-token-value\n', { mode: 0o644 });

  sup.start();
  const pid = sup.status().pid;
  assert.ok(pid, 'running');
  await waitUntil(() => fake.calls().length === 1, { what: 'the fake recorded its launch' });
  const [call] = fake.calls();
  assert.equal(call.token, 'SEKRIT-token-value', 'the token arrived in TUNNEL_TOKEN');
  assert.ok(!call.argv.some((a) => a.includes('SEKRIT')), 'and nowhere in argv');
  assert.equal(fs.statSync(path.join(dir, 'token')).mode & 0o777, 0o600, 'a loose token file is tightened to 0600');

  await waitUntil(async () => (await cf.probeReady(metricsPort)).ready, { timeout: 5000, what: '/ready on the metrics port' });
  assert.deepEqual(await cf.probeReady(metricsPort), { ready: true, connections: 4 });

  await sup.stop();
  assert.equal(isPidAlive(pid), false, 'the connector is gone once stop resolves');
  assert.equal(sup.status().state, 'stopped');
  assert.equal((await cf.probeReady(metricsPort)).ready, false);
});

test('supervisor (local): writes the ingress file 0600 and runs the named tunnel', async (t) => {
  const fake = fakeCloudflared(t);
  const config = cfg({}, { kind: 'local', name: 'wc-home', metricsPort: await freePort() });
  const { sup, dir } = await supervised(t, config);
  sup.start();
  await waitUntil(() => fake.calls().length === 1, { what: 'launch recorded' });
  const [call] = fake.calls();
  assert.deepEqual(call.argv.slice(-4), ['--config', path.join(dir, 'cloudflared.yml'), 'run', 'wc-home']);
  assert.equal(call.token, null, 'a local tunnel gets no token');
  assert.match(call.config, /required: true/);
  assert.equal(fs.statSync(path.join(dir, 'cloudflared.yml')).mode & 0o777, 0o600);
});

test('supervisor: a crashing connector restarts on a doubling backoff, capped', async (t) => {
  const fake = fakeCloudflared(t, { exit: 1 });
  const { sup } = await supervised(t, cfg({}, { kind: 'local', name: 'x', metricsPort: await freePort() }), {
    backoff: { initialMs: 20, maxMs: 80, resetAfterMs: 60 * 60 * 1000 },
  });
  sup.start();
  await waitUntil(() => fake.calls().length >= 4, { timeout: 8000, what: 'four launches' });
  assert.equal(sup.delay, 80, 'doubled 20 → 40 → 80 and held at the cap');
  assert.ok(sup.status().restarts >= 3);
  assert.equal(sup.status().last_exit.code, 1);
  await sup.stop();
  const n = fake.calls().length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fake.calls().length, n, 'stop cancels the pending restart');
});

test('supervisor: a run that lasted resetAfterMs starts the ladder again', async (t) => {
  const fake = fakeCloudflared(t, { exit: 1 });
  const { sup } = await supervised(t, cfg({}, { kind: 'local', name: 'x', metricsPort: await freePort() }), {
    backoff: { initialMs: 20, maxMs: 80, resetAfterMs: 0 },
  });
  sup.start();
  await waitUntil(() => fake.calls().length >= 4, { timeout: 8000, what: 'four launches' });
  assert.equal(sup.delay, 40, 'every run counted as healthy, so the wait never climbs past the first step');
});

test('supervisor: a token that is not there yet is a retried error, not a crash', async (t) => {
  const fake = fakeCloudflared(t);
  const { sup } = await supervised(t, cfg({}, { kind: 'token', metricsPort: await freePort() }), {
    backoff: { initialMs: 20, maxMs: 40, resetAfterMs: 1e9 },
  });
  sup.start();
  assert.equal(sup.status().state, 'backoff');
  assert.match(sup.status().error, /no connector token/);
  assert.equal(fake.calls().length, 0, 'nothing launched without its credential');
});

test('the portal owns its connector: supervise(port) starts it after listen, health reports it, stop() kills it', async (t) => {
  withTempHome(t);
  const { createPortal } = require('../lib/portal');
  const { deregisterRole } = require('../lib/util/registry');
  const fake = fakeCloudflared(t);
  const access = createFakeAccess();
  const config = normalizeConfig(access.config({ tunnel: { kind: 'local', name: 'wc-home', metricsPort: await freePort() } }));
  const dir = path.join(os.homedir(), '.web-chat', 'tunnel');
  let boundPort = null;
  const portal = createPortal({
    port: 0,
    config,
    fetchJwks: access.fetchJwks,
    supervise: (port) => {
      boundPort = port;
      return cf.createSupervisor({ config, portalPort: port, logFile: path.join(dir, 'cf.log'), configFile: path.join(dir, 'cloudflared.yml') });
    },
  });
  t.after(async () => { await portal.stop(); deregisterRole('portal', { pid: process.pid }); });
  assert.equal(portal.health().cloudflared, null, 'nothing before start');
  await portal.start();
  assert.equal(boundPort, portal.server.address().port, 'the supervisor is built with the port actually bound');
  await waitUntil(() => fake.calls().length === 1, { what: 'launched' });
  assert.match(fake.calls()[0].config, new RegExp(`service: "http://127\\.0\\.0\\.1:${boundPort}"`), 'the ingress names that port');
  const h = portal.health().cloudflared;
  assert.equal(h.state, 'running');
  assert.equal(h.pid, fake.calls()[0].pid);
  await portal.stop();
  assert.equal(isPidAlive(h.pid), false, 'stopping the portal stopped cloudflared — no connector left answering with nothing behind it');
});
