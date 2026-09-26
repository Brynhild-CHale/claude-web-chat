// `claude-web-chat tunnel <setup|up|down|status|logs>` (lib/cli/commands/tunnel)
// and doctor's tunnel section.
//
// What must hold:
//   * setup writes a config the portal will accept (the one normaliser), 0600,
//     keeps the connector token out of argv/flags, refuses an unverifiable team
//     and an empty allowlist, and says loudly what an allowlisted account can do.
//   * up REFUSES everything that would make the tunnel unsafe or broken: no
//     config, an empty allowlist, a quick tunnel, daemons bound off loopback, no
//     (or too old a) cloudflared, no token.
//   * up → a real detached portal supervising a (fake) cloudflared that got the
//     token in its env; status reads it all back; down stops both.
// cloudflared is test-support/fake-cloudflared.js on PATH, and the detached
// portal is preloaded with test-support/no-outbound.js, so no test here reaches
// Cloudflare or needs an account.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const tunnel = require('../lib/cli/commands/tunnel');
const doctor = require('../lib/cli/commands/doctor');
const { main } = require('../lib/cli');
const { withTempHome, waitUntil, freePort, fakeCloudflared } = require('../test-support/helpers');
const { createFakeAccess } = require('../test-support/fake-access');
const { userPaths } = require('../lib/core/paths');
const { isPidAlive } = require('../lib/core/portfiles');
const { registerInstance, deregisterRole } = require('../lib/util/registry');

const NO_OUTBOUND = path.join(__dirname, '..', 'test-support', 'no-outbound.js');

function capture() {
  const lines = [];
  return { log: (s) => lines.push(String(s)), lines, text: () => lines.join('\n') };
}

// A prompt that is never interactive (as in CI) — every question takes its
// default, the way the real engine does with no TTY.
function quietPrompt() {
  return { line: async () => '', confirm: async (q, { def = false } = {}) => def, close() {} };
}

function writeConfig(raw) {
  fs.mkdirSync(userPaths().tunnelDir, { recursive: true });
  fs.writeFileSync(userPaths().tunnelConfig, JSON.stringify(raw));
}

function goodRaw(access, tunnelOver = {}) {
  return access.config({ tunnel: { kind: 'token', metricsPort: 5172, ...tunnelOver } });
}

function writeToken(v = 'connector-token-123') {
  fs.mkdirSync(userPaths().tunnelDir, { recursive: true });
  fs.writeFileSync(userPaths().tunnelToken, `${v}\n`, { mode: 0o600 });
}

// ── help ────────────────────────────────────────────────────────────────────

test('help lists the tunnel command', (t) => {
  const out = [];
  const prev = console.log;
  console.log = (s) => out.push(String(s));
  t.after(() => { console.log = prev; });
  main(['help']);
  console.log = prev;
  assert.match(out.join('\n'), /^ {2}tunnel <setup\|up\|down\|status\|logs>/m);
  assert.doesNotMatch(out.join('\n'), /^ {2}portal /m, 'portal run stays hidden');
});

test('tunnel with no subcommand prints its usage; an unknown one is a userFacing error', async () => {
  const c = capture();
  await tunnel([], { log: c.log });
  assert.match(c.text(), /usage: claude-web-chat tunnel <setup\|up\|down\|status\|logs>/);
  await assert.rejects(tunnel(['sideways'], { log: c.log }), (e) => e.userFacing && /unknown tunnel subcommand/.test(e.message));
});

// ── setup ───────────────────────────────────────────────────────────────────

test('setup (flags, non-interactive): verifies the team, writes 0600 config + token, warns, prints the steps', async (t) => {
  withTempHome(t);
  const access = createFakeAccess();
  const tokFile = path.join(userPaths().root, 'pasted-token');
  fs.mkdirSync(userPaths().root, { recursive: true });
  fs.writeFileSync(tokFile, '  eyJ-the-token  \n');
  const c = capture();
  const config = await tunnel(['setup', '--hostname', 'WC.Example.Test', '--team', access.team, '--aud', access.aud,
    '--email', 'Me@Example.com', '--kind', 'token', '--token-file', tokFile], { log: c.log, prompt: quietPrompt(), fetchJwks: access.fetchJwks });

  assert.equal(access.state.calls, 1, 'the team\'s signing keys were fetched once');
  const written = JSON.parse(fs.readFileSync(userPaths().tunnelConfig, 'utf8'));
  assert.equal(written.hostname, 'wc.example.test');
  assert.equal(written.style, 'flat', 'flat is the default');
  assert.deepEqual(written.allow.emails, ['me@example.com']);
  assert.deepEqual(written.tunnel, { kind: 'token', metricsPort: 5172 });
  assert.equal(config.hostname, 'wc.example.test');
  assert.equal(fs.statSync(userPaths().tunnelConfig).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(userPaths().tunnelToken, 'utf8'), 'eyJ-the-token\n');
  assert.equal(fs.statSync(userPaths().tunnelToken).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(written).includes('eyJ-the-token'), 'the token is not in tunnel.json');

  const out = c.text();
  assert.match(out, /WHO YOU ALLOWLIST CAN ACT AS YOU ON THIS MACHINE/);
  assert.match(out, /Public Hostnames → add wc\.example\.test AND \*\.example\.test/);
  assert.match(out, /service {2}http:\/\/127\.0\.0\.1:5171/);
  assert.match(out, /covering\n? *wc\.example\.test and wc-\*\.example\.test/);
  assert.match(out, /Emails →\n? *me@example\.com/);
  assert.match(out, /Then: claude-web-chat tunnel up/);
});

test('setup: a second run keeps what it was not asked to change, and >1 email is called out', async (t) => {
  withTempHome(t);
  const access = createFakeAccess();
  writeConfig({ ...access.config({ showRoots: true, remote: { allowDestructive: true } }), tunnel: { kind: 'local', name: 'wc-home' } });
  const c = capture();
  await tunnel(['setup', '--email', 'a@example.com,b@example.com', '--skip-verify'], { log: c.log, prompt: quietPrompt() });
  const written = JSON.parse(fs.readFileSync(userPaths().tunnelConfig, 'utf8'));
  assert.equal(written.hostname, 'wc.example.test');
  assert.equal(written.showRoots, true);
  assert.equal(written.remote.allowDestructive, true);
  assert.deepEqual(written.tunnel, { kind: 'local', name: 'wc-home', metricsPort: 5172 });
  assert.deepEqual(written.allow.emails, ['a@example.com', 'b@example.com']);
  assert.match(c.text(), /2 accounts are allowlisted/);
  assert.match(c.text(), /cloudflared tunnel route dns wc-home wc\.example\.test/, 'local tunnels get the DNS commands');
  assert.equal(fs.existsSync(userPaths().tunnelToken), false, 'a local tunnel has no connector token');
});

test('setup refuses an unreachable team and an empty allowlist — and writes nothing', async (t) => {
  withTempHome(t);
  const access = createFakeAccess();
  access.state.down = true;
  const base = ['setup', '--hostname', 'wc.example.test', '--team', access.team, '--aud', access.aud, '--kind', 'local', '--name', 'x'];
  await assert.rejects(tunnel([...base, '--email', 'me@example.com'], { log: () => {}, prompt: quietPrompt(), fetchJwks: access.fetchJwks }),
    (e) => e.userFacing && /could not fetch the Access signing keys for team "testteam".*--skip-verify/.test(e.message));
  await assert.rejects(tunnel(base, { log: () => {}, prompt: quietPrompt(), fetchJwks: access.fetchJwks }),
    (e) => e.userFacing && /at least one allowed Google account/.test(e.message));
  await assert.rejects(tunnel([...base, '--email', 'me@example.com', '--kind', 'quick', '--skip-verify'], { log: () => {}, prompt: quietPrompt() }),
    (e) => e.userFacing && /quick tunnel/.test(e.message));
  assert.equal(fs.existsSync(userPaths().tunnelConfig), false);
});

// ── up: the refusals ────────────────────────────────────────────────────────

test('up refuses: no config, empty allowlist, quick tunnel, no tunnel, non-loopback host, no/old cloudflared, no token', async (t) => {
  withTempHome(t);
  const access = createFakeAccess();
  const env = { ...process.env, WEB_CHAT_PORTAL_PORT: String(await freePort()) };
  delete env.WEB_CHAT_HOST;
  const up = (e = env) => tunnel(['up'], { log: () => {}, env: e, waitMs: 500 });
  const refuses = async (re, e) => assert.rejects(up(e), (err) => err.userFacing && re.test(err.message), String(re));

  await refuses(/none at .*tunnel\.json — run `claude-web-chat tunnel setup`/);
  writeConfig(access.config({ allow: { emails: [] }, tunnel: { kind: 'token' } }));
  await refuses(/allow\.emails is empty/);
  writeConfig(access.config({ tunnel: { kind: 'quick' } }));
  await refuses(/quick tunnel/);
  writeConfig(access.config());
  await refuses(/names no tunnel/);

  writeConfig(goodRaw(access));
  await refuses(/WEB_CHAT_HOST=0\.0\.0\.0 — your daemons are listening on the network/, { ...env, WEB_CHAT_HOST: '0.0.0.0' });

  const emptyDir = fs.mkdtempSync(path.join(userPaths().root, '..', 'nopath-'));
  await refuses(/cloudflared is not on your PATH — install it/, { ...env, PATH: emptyDir });
  // The fake reads its version from ITS env, so each case hands a fresh one.
  const fake = fakeCloudflared(t, { version: '2023.1.0' });
  await refuses(/older than 2024\.1\.0/, { ...process.env, WEB_CHAT_PORTAL_PORT: env.WEB_CHAT_PORTAL_PORT });
  process.env.FAKE_CF_VERSION = '2025.8.1';
  await refuses(/no connector token/, { ...process.env, WEB_CHAT_PORTAL_PORT: env.WEB_CHAT_PORTAL_PORT });
  assert.equal(fake.calls().length, 0, 'nothing ever launched');
  assert.equal(fs.existsSync(userPaths().portalLog), false, 'no portal was spawned');
});

// ── up → status → down, for real ────────────────────────────────────────────

test('up starts a real portal that supervises cloudflared (token in env only); status reads it; down stops both', async (t) => {
  withTempHome(t);
  const access = createFakeAccess();
  const fake = fakeCloudflared(t);
  const metricsPort = await freePort();
  writeConfig(goodRaw(access, { metricsPort }));
  writeToken('SEKRIT-connector');
  const port = await freePort();
  const env = { ...process.env, WEB_CHAT_PORTAL_PORT: String(port), NODE_OPTIONS: `--require ${JSON.stringify(NO_OUTBOUND)}` };
  delete env.WEB_CHAT_HOST;

  // A running project to expose.
  const projectRoot = fs.mkdtempSync(path.join(userPaths().root, '..', 'proj-'));
  registerInstance({ root: projectRoot, port: 65001, pid: process.pid, url: 'http://localhost:65001', title: 'proj' });

  let health = null;
  t.after(() => {
    // Whatever happened above, nothing detached outlives the test.
    for (const pid of [health && health.pid, health && health.cloudflared && health.cloudflared.pid]) {
      if (pid && isPidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    deregisterRole('portal', {});
  });

  const c = capture();
  const r = await tunnel(['up'], { log: c.log, env, waitMs: 15000 });
  health = r.health;
  assert.equal(r.already, false);
  assert.equal(health.role, 'portal');
  assert.notEqual(health.pid, process.pid, 'detached — its own process');
  assert.match(c.text(), /✓ portal up — pid \d+ on 127\.0\.0\.1:\d+ \(cloudflared 2025\.8\.1, token tunnel\)/);
  assert.match(c.text(), /picker: https:\/\/wc\.example\.test\//);

  await waitUntil(() => fake.calls().length === 1, { timeout: 10000, what: 'the portal launched cloudflared' });
  const [call] = fake.calls();
  assert.equal(call.token, 'SEKRIT-connector', 'TUNNEL_TOKEN carried the token');
  assert.ok(!call.argv.join(' ').includes('SEKRIT'), 'argv never did');
  assert.deepEqual(call.argv, ['tunnel', '--no-autoupdate', '--metrics', `127.0.0.1:${metricsPort}`, 'run']);

  const again = await tunnel(['up'], { log: () => {}, env });
  assert.equal(again.already, true, 'a second up finds the first');

  const s = capture();
  let st;
  await waitUntil(async () => {
    st = await tunnel(['status'], { log: () => {}, env });
    return st.cloudflared && st.cloudflared.ready;
  }, { timeout: 10000, what: 'the connector reports ready' });
  health = { ...health, cloudflared: { pid: st.cloudflared.pid } };
  assert.equal(st.portal.running, true);
  assert.equal(st.portal.pid, r.health.pid);
  assert.equal(st.cloudflared.state, 'running');
  assert.equal(st.cloudflared.pid, call.pid);
  assert.equal(st.allowlist.emails, 1);
  assert.equal(st.sessions.length, 1);
  assert.match(st.sessions[0].url, /^https:\/\/wc-[0-9a-f]{8}\.example\.test\/$/);
  await tunnel(['status'], { log: s.log, env });
  assert.match(s.text(), /cloudflared: running — pid \d+ · ready \(4 connections\)/);
  assert.match(s.text(), new RegExp(`sessions \\(1\\):\\n {2}[0-9a-f]{8} {2}${path.basename(projectRoot)} {2}→ {2}https://wc-`));

  const d = capture();
  const down = await tunnel(['down'], { log: d.log, env });
  assert.equal(down.stopped, true);
  assert.match(d.text(), /✓ tunnel down — portal pid \d+ stopped; cloudflared \(pid \d+\) stopped with it/);
  await waitUntil(() => !isPidAlive(r.health.pid), { timeout: 5000, what: 'the portal exited' });
  await waitUntil(() => !isPidAlive(call.pid), { timeout: 5000, what: 'cloudflared exited with it' });

  const after = await tunnel(['status'], { log: () => {}, env });
  assert.equal(after.portal.running, false);
  assert.equal(after.cloudflared.ready, false);
  const d2 = capture();
  assert.deepEqual(await tunnel(['down'], { log: d2.log, env }), { stopped: false });
  assert.match(d2.text(), /tunnel is not up/);
});

// ── logs ────────────────────────────────────────────────────────────────────

test('logs prints both tails; --follow streams what is appended until aborted', async (t) => {
  withTempHome(t);
  fs.mkdirSync(userPaths().tunnelDir, { recursive: true });
  fs.writeFileSync(userPaths().portalLog, 'p1\np2\np3\n');
  fs.writeFileSync(userPaths().cloudflaredLog, 'c1\n');
  const c = capture();
  await tunnel(['logs', '--lines', '2'], { log: c.log });
  assert.deepEqual(c.lines.filter((l) => !l.startsWith('──')), ['p2', 'p3', 'c1']);
  assert.match(c.lines[0], /── portal \(.*portal\.log\)/);

  const f = capture();
  const ac = new AbortController();
  const done = tunnel(['logs', '--follow', '--cloudflared'], { log: f.log, signal: ac.signal, pollMs: 20 });
  await waitUntil(() => f.lines.includes('c1'));
  fs.appendFileSync(userPaths().cloudflaredLog, 'c2 new\n');
  await waitUntil(() => f.lines.includes('c2 new'), { what: 'the appended line' });
  ac.abort();
  await done;
  assert.ok(!f.text().includes('p3'), '--cloudflared shows only that log');
});

// ── doctor ──────────────────────────────────────────────────────────────────

function doctorProject(t) {
  withTempHome(t);
  const dir = fs.mkdtempSync(path.join(userPaths().root, '..', 'doc-'));
  fs.mkdirSync(path.join(dir, '.web-chat', 'graph'), { recursive: true });
  return dir;
}

test('doctor: no tunnel section at all until setup has run', async (t) => {
  const root = doctorProject(t);
  const s = await doctor([], { cwd: root, runClaude: () => ({ ok: true }), log: () => {} });
  assert.ok(!s.checks.some((c) => /tunnel|cloudflared/i.test(c.m)), s.checks.map((c) => c.m).join('\n'));
});

test('doctor: reports the tunnel config, cloudflared, the token and a down tunnel', async (t) => {
  const root = doctorProject(t);
  const access = createFakeAccess();
  writeConfig(goodRaw(access));
  fakeCloudflared(t);
  const env = { ...process.env, WEB_CHAT_PORTAL_PORT: String(await freePort()) };
  delete env.WEB_CHAT_HOST;
  let s = await doctor([], { cwd: root, runClaude: () => ({ ok: true }), log: () => {}, env });
  const has = (status, re) => s.checks.some((c) => c.status === status && re.test(c.m));
  assert.ok(has('ok', /tunnel config is valid \(wc\.example\.test, 1 allowlisted email/));
  assert.ok(has('ok', /cloudflared 2025\.8\.1 at /));
  assert.ok(has('problem', /no connector token/));
  assert.ok(has('note', /the tunnel is down/));

  writeToken();
  writeConfig(access.config({ allow: { emails: [] }, tunnel: { kind: 'token' } }));
  s = await doctor([], { cwd: root, runClaude: () => ({ ok: true }), log: () => {}, env: { ...env, WEB_CHAT_HOST: '0.0.0.0' } });
  assert.ok(has('problem', /allow\.emails is empty.*tunnel setup/));
  assert.ok(has('problem', /WEB_CHAT_HOST=0\.0\.0\.0/));
});
