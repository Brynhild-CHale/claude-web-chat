// The connector's versions record and machine facts (tranche 6, U725):
// lib/connector/facts.js, its program runner lib/connector/exec.js, and the
// tool names lib/setup/registration claudeToolNames reads (05 C-05.18 as
// A-05.2 replaces it; 12 C-12.12; 11 C-11.6). Every schema check is against
// the locked contracts copy (test-support/contracts, U734's loader).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { createValidator } = require('../test-support/contracts-loader');
const { redactHostPaths, realpath } = require('../lib/core/paths');
const versions = require('../lib/core/versions');
const facts = require('../lib/connector/facts');
const exec = require('../lib/connector/exec');
const { claudeToolNames } = require('../lib/setup/registration');

const validator = createValidator();
const COMPAT = 'https://web-chat-contracts/schemas/12-compat.json';
const validDef = (def, value) => {
  const v = validator.ajv.getSchema(`${COMPAT}#/$defs/${def}`);
  assert.ok(v, `no schema at 12-compat#/$defs/${def}`);
  const ok = v(value);
  return { ok, errors: v.errors };
};
const asFrame = (body) => ({ ch: 'control', kind: 'machine.facts', id: 'f-1', seq: 1, ...body });

const CHAT = '01hz3k5m7n9p1q3r5s7t9v1w3x';

function tmpDir(t, prefix) {
  const d = fs.mkdtempSync(path.join(SANDBOX, prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// Every string inside `value`, with the JSON path that leads to it.
function strings(value, at = '$', out = []) {
  if (typeof value === 'string') out.push({ at, value });
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, `${at}.${k}`, out);
  return out;
}

// ── the versions record ─────────────────────────────────────────────────────

test('versionsRecord with a stub claude version validates against 12-compat versions, from lib/core/versions', async () => {
  const claudeVersion = await facts.readClaudeVersion({ runClaude: async (argv, opts) => {
    assert.deepStrictEqual(argv, ['--version']);
    assert.strictEqual(opts.timeoutMs, 10000);
    return { ok: true, stdout: '2.1.300 (Claude Code)\n' };
  } });
  assert.strictEqual(claudeVersion, '2.1.300');
  const rec = facts.versionsRecord({ claudeVersion });
  const r = validDef('versions', rec);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(rec.kind, 'versions');
  assert.strictEqual(rec.package_version, versions.packageVersion());
  assert.deepStrictEqual(rec.protocol, { min: versions.CONNECTOR_PROTOCOL_MIN, max: versions.CONNECTOR_PROTOCOL_VERSION });
  assert.strictEqual(rec.policy_protocol, versions.PORTAL_PROTOCOL_VERSION);
  assert.strictEqual(rec.policy_protocol, 12);
  assert.strictEqual(rec.schema_version, versions.SCHEMA_VERSION);
  assert.strictEqual(rec.schema_version, 4);
  assert.strictEqual(rec.node, process.versions.node);
  assert.strictEqual(rec.platform, process.platform);
  assert.strictEqual(rec.arch, process.arch);
  assert.strictEqual(rec.claude_code_version, '2.1.300');
  assert.ok(!('daemons' in rec), 'no daemons: the key is absent');
});

test('versionsRecord maps describeInstall onto the install def', () => {
  const rec = facts.versionsRecord({ describe: () => ({ kind: 'managed', linkMismatch: true, packageRoot: '/x' }) });
  assert.deepStrictEqual(rec.install, { kind: 'managed', link_mismatch: true });
  const odd = facts.versionsRecord({ describe: () => { throw new Error('boom'); } });
  assert.deepStrictEqual(odd.install, { kind: 'unmanaged', link_mismatch: false });
  assert.ok(validDef('versions', odd).ok);
  // The real describeInstall of this tree (a checkout: dev).
  const real = facts.versionsRecord({});
  assert.ok(['managed', 'dev', 'unmanaged'].includes(real.install.kind));
  assert.ok(validDef('versions', real).ok);
});

test('a stub runner reporting claude not found gives claude_code_version null, still valid', async () => {
  const runClaude = async () => ({ ok: false, notFound: true, stderr: 'claude not found' });
  const v = await facts.readClaudeVersion({ runClaude });
  assert.strictEqual(v, null);
  const rec = facts.versionsRecord({ claudeVersion: v });
  assert.strictEqual(rec.claude_code_version, null);
  assert.ok(validDef('versions', rec).ok);
  // A run that fails, prints no version, or throws: null as well.
  assert.strictEqual(await facts.readClaudeVersion({ runClaude: async () => ({ ok: false, code: 1 }) }), null);
  assert.strictEqual(await facts.readClaudeVersion({ runClaude: async () => ({ ok: true, stdout: 'hello' }) }), null);
  assert.strictEqual(await facts.readClaudeVersion({ runClaude: async () => { throw new Error('x'); } }), null);
  // A version the schema cannot carry is not passed on.
  assert.strictEqual(facts.versionsRecord({ claudeVersion: '1234567.0.0' }).claude_code_version, null);
});

test('versionsRecord carries the daemons it is handed, each a valid daemon_versions', () => {
  const d = facts.daemonVersions(CHAT, { package_version: '0.9.0-alpha.7', version: 3, boot: 'b-1' }, 0);
  const rec = facts.versionsRecord({ claudeVersion: null, daemons: [d] });
  assert.deepStrictEqual(rec.daemons, [d]);
  assert.ok(validDef('versions', rec).ok);
});

// ── daemon_versions ─────────────────────────────────────────────────────────

test('daemonVersions from a canned health body validates and carries no pid or port', () => {
  const health = {
    ok: true,
    pid: 4242,
    port: 5199,
    root: '/Users/someone/project',
    instance: 'abcd',
    package_version: '0.9.0-alpha.7',
    catalogue: { version: '1.0.0', sha256: 'a'.repeat(64) },
    version: 3,
    boot: 'k3j4h5g6',
    viewers: 2,
  };
  const now = Date.UTC(2026, 10, 10, 12, 0, 0);
  const rec = facts.daemonVersions(CHAT, health, now);
  const r = validDef('daemon_versions', rec);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(rec, {
    kind: 'daemon_versions',
    chat: CHAT,
    package_version: '0.9.0-alpha.7',
    instance_protocol: 3,
    boot: 'k3j4h5g6',
    observed_at: '2026-11-10T12:00:00.000Z',
    catalogue_sha256: 'a'.repeat(64),
  });
  const text = JSON.stringify(rec);
  assert.ok(!/pid|port|4242|5199|\/Users/.test(text), text);
  // No catalogue reported: the key is absent and the record still valid.
  const pre = facts.daemonVersions(CHAT, { package_version: '0.9.0-alpha.6', version: 3, boot: 'b' }, now);
  assert.ok(!('catalogue_sha256' in pre));
  assert.ok(validDef('daemon_versions', pre).ok);
  // A body that cannot make a valid record is null, never half a record.
  assert.strictEqual(facts.daemonVersions('not-a-chat', health, now), null);
  assert.strictEqual(facts.daemonVersions(CHAT, { ...health, version: 0 }, now), null);
  assert.strictEqual(facts.daemonVersions(CHAT, { ...health, boot: '' }, now), null);
  assert.strictEqual(facts.daemonVersions(CHAT, null, now), null);
});

// ── machine facts ───────────────────────────────────────────────────────────

test('machineFacts with two offered folders validates against A-05.2; HOME appears only in the folders\' paths', (t) => {
  const home = os.homedir(); // the sandbox's HOME (test-support/sandbox.js)
  assert.ok(home.startsWith(SANDBOX) || (realpath(home) || home).startsWith(realpath(SANDBOX) || SANDBOX));
  const a = fs.mkdtempSync(path.join(home, 'facts-a-'));
  const b = fs.mkdtempSync(path.join(home, 'facts-b-'));
  t.after(() => { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); });
  const folder = (p, id, extra = {}) => ({
    id, path: realpath(p), display: redactHostPaths(realpath(p)), access: 'read-write', offered_at: 1731240000000, ...extra,
  });
  const record = {
    v: 1,
    hub: { id: 'hub-one', origin: 'https://hub.example' },
    workdir: path.join(home, 'web-chat-hub', 'hub-one'),
    settings: { agents_at_once: 2, accept_new_chats: true, let_home_start_agents: false, paused: false, rev: 7, local_cap: 1 },
    folders: [folder(a, 'f_0123456789abcdef', { label: 'Work' }), folder(b, 'f_fedcba9876543210')],
    chats: [{ id: CHAT, root: path.join(home, 'web-chat-hub', 'hub-one', 'chat') }],
    service: { path_env: `${path.join(home, 'bin')}:/usr/bin` },
    ceiling: 'read',
  };
  const body = facts.machineFacts({
    record,
    tailnetName: 'studio-mbp.yak-bebop.ts.net',
    names: { mcp_servers: ['web-chat', 'gh-x', 'bad name!'], skills: ['alpha'] },
  });
  const r = validator.validateFrame(asFrame(body));
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(r.def, 'machine_facts');
  assert.strictEqual(body.hostname, os.hostname().slice(0, 253));
  assert.strictEqual(body.login, os.userInfo().username);
  assert.strictEqual(body.tailnet_name, 'studio-mbp.yak-bebop.ts.net');
  assert.strictEqual(body.ceiling, 'read');
  assert.deepStrictEqual(body.settings, record.settings);
  assert.deepStrictEqual(body.mcp_servers, ['gh-x', 'web-chat']);
  assert.deepStrictEqual(body.skills, ['alpha']);
  assert.deepStrictEqual(body.folders, record.folders);

  // HOME (either spelling) only inside folders[i].path; display is `~`.
  const homes = [...new Set([home, realpath(home)].filter(Boolean))];
  const hits = strings(asFrame(body)).filter((s) => homes.some((h) => s.value.includes(h)));
  assert.deepStrictEqual(hits.map((h) => h.at).sort(), ['$.folders[0].path', '$.folders[1].path']);
  for (const f of body.folders) assert.ok(f.display.startsWith('~'), f.display);
  // The workdir, the chats' roots and the captured PATH never ride along.
  assert.ok(!JSON.stringify(body).includes('web-chat-hub'));
  assert.ok(!JSON.stringify(body).includes(path.join(home, 'bin')));
});

test('machineFacts: no tailscale, no ceiling, no settings — still valid (null tailnet, full, defaults)', () => {
  const body = facts.machineFacts({ record: { folders: [] }, tailnetName: null, names: {} });
  assert.ok(validator.validateFrame(asFrame(body)).ok);
  assert.strictEqual(body.tailnet_name, null);
  assert.strictEqual(body.ceiling, 'full');
  assert.deepStrictEqual(body.settings, { agents_at_once: 0, accept_new_chats: false, let_home_start_agents: false, paused: false, rev: 0 });
  assert.deepStrictEqual(body.mcp_servers, []);
  // An invalid tailnet name never rides; settings passed explicitly win.
  const b2 = facts.machineFacts({ record: {}, tailnetName: 'Bad Name', settings: { agents_at_once: 3, paused: true } });
  assert.strictEqual(b2.tailnet_name, null);
  assert.strictEqual(b2.settings.agents_at_once, 3);
  assert.strictEqual(b2.settings.paused, true);
  assert.ok(validator.validateFrame(asFrame(b2)).ok);
});

// ── the tailnet name ────────────────────────────────────────────────────────

function fakeExec({ found = '/opt/ts/bin/tailscale', app = false, answer } = {}) {
  const calls = [];
  return {
    calls,
    findProgram: (name, pathEnv) => { calls.push({ find: name, pathEnv }); return found; },
    isExecutable: (file) => { calls.push({ isExecutable: file }); return app; },
    run: async (bin, argv, opts) => { calls.push({ run: bin, argv, opts }); return answer; },
  };
}
const statusOf = (dns) => ({ ok: true, code: 0, stdout: JSON.stringify({ Self: { DNSName: dns, HostName: 'x' }, MagicDNSSuffix: 'yak-bebop.ts.net' }) });

test('tailnetName through an injected exec: the trailing dot dropped, lowercased; argv exactly status --json, no shell', async () => {
  const ex = fakeExec({ answer: statusOf('Studio-MBP.yak-bebop.ts.net.') });
  assert.strictEqual(await facts.tailnetName({ exec: ex, pathEnv: '/opt/ts/bin:/usr/bin', platform: 'linux' }), 'studio-mbp.yak-bebop.ts.net');
  const run = ex.calls.find((c) => c.run);
  assert.strictEqual(run.run, '/opt/ts/bin/tailscale');
  assert.deepStrictEqual(run.argv, ['status', '--json']);
  assert.ok(!('shell' in run.opts), 'no shell option is passed');
  assert.strictEqual(run.opts.timeoutMs, 3000);
  assert.deepStrictEqual(ex.calls[0], { find: 'tailscale', pathEnv: '/opt/ts/bin:/usr/bin' });
});

test('tailnetName is null when not found, on a non-zero exit, a timeout, an empty or an invalid name', async () => {
  const none = fakeExec({ found: null, app: false, answer: statusOf('a.b.') });
  assert.strictEqual(await facts.tailnetName({ exec: none, pathEnv: '/usr/bin', platform: 'darwin' }), null);
  assert.ok(!none.calls.some((c) => c.run), 'nothing runs when no tailscale is found');
  assert.ok(none.calls.some((c) => c.isExecutable === facts.TAILSCALE_APP), 'the Mac app is looked for on darwin');
  const linux = fakeExec({ found: null, app: true });
  assert.strictEqual(await facts.tailnetName({ exec: linux, pathEnv: '/usr/bin', platform: 'linux' }), null);
  assert.ok(!linux.calls.some((c) => c.isExecutable), 'the Mac app path is not asked off macOS');

  const cases = [
    { ok: false, code: 1, stdout: '', reason: 'exit' },
    { ok: false, code: null, stdout: '', reason: 'timeout' },
    statusOf(''),
    statusOf('bad name!'),
    { ok: true, code: 0, stdout: 'not json' },
    { ok: true, code: 0, stdout: JSON.stringify({ Self: null }) },
  ];
  for (const answer of cases) {
    assert.strictEqual(await facts.tailnetName({ exec: fakeExec({ answer }), pathEnv: '/x', platform: 'linux' }), null, JSON.stringify(answer));
  }
  // The app's CLI on macOS when the PATH has none.
  const app = fakeExec({ found: null, app: true, answer: statusOf('m.ts.net.') });
  assert.strictEqual(await facts.tailnetName({ exec: app, pathEnv: '', platform: 'darwin' }), 'm.ts.net');
  assert.strictEqual(app.calls.find((c) => c.run).run, facts.TAILSCALE_APP);
});

test('tailnetName with the real runner over a stub tailscale on a given PATH', async (t) => {
  const dir = tmpDir(t, 'ts-bin-');
  const stub = path.join(dir, 'tailscale');
  fs.writeFileSync(stub, `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== 'status --json') process.exit(3);\nprocess.stdout.write(JSON.stringify({ Self: { DNSName: 'Box.Tail-Net.ts.net.' } }));\n`, { mode: 0o755 });
  assert.strictEqual(await facts.tailnetName({ pathEnv: `relative/dir${path.delimiter}${dir}`, platform: 'linux' }), 'box.tail-net.ts.net');
  assert.strictEqual(await facts.tailnetName({ pathEnv: 'relative/dir', platform: 'linux' }), null);
});

// ── the tool names ──────────────────────────────────────────────────────────

const SECRETS = ['SECRET-CMD', 'SECRET-ARG', 'SECRET-ENV', '/secret/path'];
const server = () => ({ command: 'SECRET-CMD', args: ['--token', 'SECRET-ARG', '/secret/path'], env: { TOKEN: 'SECRET-ENV' } });

test('claudeToolNames over a synthetic Claude tier: user-scope server keys and skill dirs, names only', (t) => {
  const root = tmpDir(t, 'names-root-');
  const ch = claudeHome(t, { root, isolate: true });
  ch.write('.claude.json', JSON.stringify({
    mcpServers: { 'web-chat': server(), 'gh-x': { type: 'http', url: 'https://x.example/SECRET-ARG' } },
    projects: { [root]: { mcpServers: { 'project-only': server() } } },
    oauthAccount: { emailAddress: 'someone@example.com' },
  }));
  ch.write('skills/alpha/SKILL.md', '---\nname: alpha\ndescription: SECRET-ARG\n---\n');
  ch.write('skills/beta/notes.md', 'no SKILL.md here');
  ch.write('skills/synced/org_acct/gamma/SKILL.md', '---\nname: gamma\n---\n');
  ch.write('skills/synced/SKILL.md', 'the bucket is never a skill');
  const out = claudeToolNames();
  assert.deepStrictEqual(out, { mcp_servers: ['gh-x', 'web-chat'], skills: ['alpha'] });
  const text = JSON.stringify(out);
  for (const s of [...SECRETS, 'someone@example.com', 'project-only', ch.dir]) assert.ok(!text.includes(s), s);
});

test('claudeToolNames: a missing tier gives empty lists; bad names are dropped; the cap holds', (t) => {
  const root = tmpDir(t, 'names-root-');
  const ch = claudeHome(t, { root, isolate: true });
  assert.deepStrictEqual(claudeToolNames(), { mcp_servers: [], skills: [] });
  const many = {};
  for (let i = 0; i < 300; i++) many[`s${String(i).padStart(3, '0')}`] = {};
  many['bad name'] = {};
  many['x'.repeat(129)] = {};
  ch.write('.claude.json', JSON.stringify({ mcpServers: many }));
  const out = claudeToolNames();
  assert.strictEqual(out.mcp_servers.length, 256);
  assert.strictEqual(out.mcp_servers[0], 's000');
  assert.ok(out.mcp_servers.every((n) => /^[A-Za-z0-9._@:-]{1,128}$/.test(n)));
  // A torn config file: no names, no throw.
  ch.write('.claude.json', '{ torn');
  assert.deepStrictEqual(claudeToolNames().mcp_servers, []);
});

test('claudeToolNames lists an enabled user-scope plugin\'s server and skill names beside the user-scope names', (t) => {
  const root = tmpDir(t, 'names-root-');
  const ch = claudeHome(t, { root, isolate: true });
  const pdir = (p) => path.join(ch.dir, 'plugins', 'cache', 'm', p, '1.0.0');
  ch.write('.claude.json', JSON.stringify({ mcpServers: { 'web-chat': server(), 'gh-x': server() } }));
  ch.write('skills/alpha/SKILL.md', '---\nname: alpha\n---\n');
  ch.write('settings.json', JSON.stringify({ enabledPlugins: { 'p1@m': true, 'p2@m': false, 'p3@m': true, 'p4@m': true, 'p5@m': true } }));
  ch.write('plugins/installed_plugins.json', JSON.stringify({
    version: 2,
    plugins: {
      'p1@m': [{ scope: 'user', installPath: pdir('p1'), version: '1.0.0' }],
      'p2@m': [{ scope: 'user', installPath: pdir('p2'), version: '1.0.0' }],
      // A project-scope install never counts (H9 (c) not taken).
      'p3@m': [{ scope: 'project', projectPath: root, installPath: pdir('p3'), version: '1.0.0' }],
      // v1's shape: one object, a projectPath and no scope — still a project's.
      'p5@m': { projectPath: root, installPath: pdir('p5'), version: '1.0.0' },
      // An install path outside pluginsDir is refused by the fence.
      'p4@m': [{ scope: 'user', installPath: path.join(ch.dir, '..', 'elsewhere', 'p4'), version: '1.0.0' }],
    },
  }));
  for (const p of ['p1', 'p2', 'p3', 'p5']) {
    ch.write(`plugins/cache/m/${p}/1.0.0/.mcp.json`, JSON.stringify({ mcpServers: { [`${p}-srv`]: server(), 'gh-x': server() } }));
    ch.write(`plugins/cache/m/${p}/1.0.0/skills/s1/SKILL.md`, '---\nname: s1\ndescription: SECRET-ARG\n---\n');
  }
  ch.write('plugins/cache/m/p1/1.0.0/.claude-plugin/plugin.json', JSON.stringify({ name: 'p1', mcpServers: { inline: server() } }));
  ch.write('plugins/cache/m/p1/1.0.0/skills/s1/SKILL.md', '---\nname: s1\n---\n');
  ch.write('plugins/cache/m/p1/1.0.0/skills/no-skill/readme.md', 'nothing');
  fs.mkdirSync(path.join(ch.dir, '..', 'elsewhere', 'p4', 'skills', 'sx'), { recursive: true });
  fs.writeFileSync(path.join(ch.dir, '..', 'elsewhere', 'p4', 'skills', 'sx', 'SKILL.md'), 'x');

  const out = claudeToolNames();
  assert.deepStrictEqual(out, {
    mcp_servers: ['gh-x', 'plugin:p1:gh-x', 'plugin:p1:inline', 'plugin:p1:p1-srv', 'web-chat'],
    skills: ['alpha', 'p1:s1'],
  });
  const text = JSON.stringify(out);
  for (const s of [...SECRETS, ch.dir, 'p2', 'p3', 'p4', 'p5']) assert.ok(!text.includes(s), s);

  // An unreadable installed_plugins.json: the user-scope names alone.
  ch.write('plugins/installed_plugins.json', '{ not json');
  assert.deepStrictEqual(claudeToolNames(), { mcp_servers: ['gh-x', 'web-chat'], skills: ['alpha'] });
});

test('machineFacts from claudeToolNames with an enabled plugin validates against A-05.2', (t) => {
  const root = tmpDir(t, 'names-root-');
  const ch = claudeHome(t, { root, isolate: true });
  const install = path.join(ch.dir, 'plugins', 'cache', 'm', 'p1', '1.0.0');
  ch.write('settings.json', JSON.stringify({ enabledPlugins: { 'p1@m': true } }));
  ch.write('plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'p1@m': [{ scope: 'user', installPath: install }] } }));
  ch.write('plugins/cache/m/p1/1.0.0/.mcp.json', JSON.stringify({ mcpServers: { srv: server() } }));
  ch.write('plugins/cache/m/p1/1.0.0/skills/s1/SKILL.md', '---\nname: s1\n---\n');
  const body = facts.machineFacts({ record: { folders: [] }, names: claudeToolNames() });
  assert.deepStrictEqual(body.mcp_servers, ['plugin:p1:srv']);
  assert.deepStrictEqual(body.skills, ['p1:s1']);
  assert.ok(validator.validateFrame(asFrame(body)).ok);
});

// ── the program runner ──────────────────────────────────────────────────────

test('exec.run refuses nothing silently: a missing program is notFound', async () => {
  const r = await exec.run(path.join(SANDBOX, 'no-such-program'), ['x']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.notFound, true);
  assert.strictEqual(r.reason, 'not-found');
  const rel = await exec.run('node', ['-v']);
  assert.deepStrictEqual([rel.ok, rel.notFound], [false, true], 'a bare name is never resolved by the runner');
  const bad = await exec.run(process.execPath, 'not a list');
  assert.deepStrictEqual([bad.ok, bad.reason], [false, 'argv']);
});

test('exec.run: an exit code, an argument list with no shell, stdin at EOF', async () => {
  const ok = await exec.run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '$(echo hi)', 'a b']);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.code, 0);
  assert.deepStrictEqual(JSON.parse(ok.stdout), ['$(echo hi)', 'a b']);
  const fail = await exec.run(process.execPath, ['-e', 'process.exit(7)']);
  assert.deepStrictEqual([fail.ok, fail.code, fail.reason], [false, 7, 'exit']);
  const stdin = await exec.run(process.execPath, ['-e', 'let n=0;process.stdin.on("data",(d)=>n+=d.length).on("end",()=>process.stdout.write("eof"+n))'], { timeoutMs: 5000 });
  assert.deepStrictEqual([stdin.ok, stdin.stdout], [true, 'eof0']);
});

test('exec.run: a program past timeoutMs is killed and resolves ok:false', async () => {
  const t0 = Date.now();
  const r = await exec.run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 200 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'timeout');
  assert.ok(Date.now() - t0 < 5000, 'settled well before the child would have exited');
});

test('exec.run: output past maxBytes is capped and the run fails', async () => {
  const r = await exec.run(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'], { maxBytes: 1000 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'overflow');
  assert.ok(r.stdout.length <= 1000, String(r.stdout.length));
});

test('exec.findProgram resolves a bare name on a given PATH string only', (t) => {
  const dir = tmpDir(t, 'find-');
  const prog = path.join(dir, 'prog-x');
  fs.writeFileSync(prog, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'not-exec'), 'x', { mode: 0o644 });
  fs.mkdirSync(path.join(dir, 'a-dir'));
  assert.strictEqual(exec.findProgram('prog-x', ['relative', dir].join(path.delimiter)), prog);
  assert.strictEqual(exec.findProgram('prog-x', 'relative'), null);
  assert.strictEqual(exec.findProgram('not-exec', dir), null);
  assert.strictEqual(exec.findProgram('a-dir', dir), null);
  assert.strictEqual(exec.findProgram('../prog-x', dir), null);
  assert.strictEqual(exec.findProgram('prog-x', ''), null);
  assert.strictEqual(exec.findProgram('prog-x', undefined), null);
  assert.ok(exec.isExecutable(prog));
  assert.ok(!exec.isExecutable('prog-x'));
});

// ── the running connector's holder (CONNECTOR@install-seam) ─────────────────

function fakeTimers() {
  const live = new Map();
  let n = 0;
  return {
    live,
    setInterval: (fn, ms) => { const id = { n: ++n, fn, ms, unref() {} }; live.set(id.n, id); return id; },
    clearInterval: (id) => { if (id) live.delete(id.n); },
  };
}

test('createFacts: versions memoised; install sets ctx.facts, re-reads on ready and on the timer, and tells the link only on a change', async () => {
  let dns = 'one.ts.net.';
  let runs = 0;
  const ex = {
    findProgram: () => '/stub/tailscale',
    isExecutable: () => false,
    run: async () => { runs++; return statusOf(dns); },
  };
  let claudeRuns = 0;
  const record = { v: 1, hub: { id: 'hub-one' }, folders: [], settings: { agents_at_once: 1, accept_new_chats: true, let_home_start_agents: false, paused: false, rev: 1 } };
  const timers = fakeTimers();
  const holder = facts.createFacts({
    hubId: 'hub-one',
    exec: ex,
    runClaude: async () => { claudeRuns++; return { ok: true, stdout: '2.1.301\n' }; },
    toolNames: () => ({ mcp_servers: ['web-chat'], skills: [] }),
    readRecord: () => ({ ok: true, value: record }),
    platform: 'linux',
    timers,
  });
  await holder.start();
  assert.strictEqual(holder.versions().claude_code_version, '2.1.301');
  holder.versions();
  assert.strictEqual(claudeRuns, 1, 'the claude version is read once and memoised');
  assert.ok(validDef('versions', holder.versions()).ok);

  const link = new EventEmitter();
  let told = 0;
  link.factsChanged = () => { told++; };
  const ctx = { link };
  const stop = holder.install(ctx);
  assert.strictEqual(typeof ctx.facts, 'function');
  assert.strictEqual(typeof ctx.versions, 'function');
  assert.strictEqual(timers.live.size, 1);
  assert.strictEqual([...timers.live.values()][0].ms, facts.REFRESH_MS);
  assert.strictEqual(facts.REFRESH_MS, 5 * 60 * 1000);

  const first = ctx.facts(); // what the link sends after hello.ack
  assert.strictEqual(first.tailnet_name, 'one.ts.net');
  assert.ok(validator.validateFrame(asFrame(first)).ok);

  // 'ready' with nothing changed: re-read, nothing told.
  const before = runs;
  assert.strictEqual(await stop.tick(), false);
  link.emit('ready');
  await new Promise((r) => setImmediate(r));
  assert.ok(runs > before, 'ready re-reads the tailnet name');
  assert.strictEqual(told, 0);

  // The name changes: the timer's re-read tells the link once.
  dns = 'two.ts.net.';
  await [...timers.live.values()][0].fn();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(told, 1);
  assert.strictEqual(ctx.facts().tailnet_name, 'two.ts.net');
  assert.strictEqual(await stop.tick(), false, 'once handed out, the same facts are no change');

  // A second holder cannot take the context; stop releases it all.
  assert.throws(() => facts.createFacts({ readRecord: () => ({ ok: false }) }).install(ctx), /already installed/);
  stop();
  assert.strictEqual(timers.live.size, 0);
  assert.strictEqual(ctx.facts, undefined);
  assert.strictEqual(link.listenerCount('ready'), 0);
});

test('createFacts: a torn record read keeps the last good one; the tailscale PATH is the record\'s captured one', async () => {
  let read = { ok: true, value: { folders: [], service: { path_env: '/captured/bin' }, ceiling: 'read' } };
  const seen = [];
  const holder = facts.createFacts({
    hubId: 'hub-one',
    exec: { findProgram: (name, p) => { seen.push(p); return null; }, isExecutable: () => false, run: async () => assert.fail('nothing runs') },
    runClaude: async () => ({ ok: false, notFound: true }),
    toolNames: () => ({ mcp_servers: [], skills: [] }),
    readRecord: () => read,
    platform: 'linux',
    timers: fakeTimers(),
  });
  await holder.start();
  assert.deepStrictEqual(seen, ['/captured/bin']);
  assert.strictEqual(holder.facts().ceiling, 'read');
  read = { ok: false, state: 'corrupt' };
  const body = holder.facts();
  assert.strictEqual(body.ceiling, 'read');
  assert.strictEqual(body.tailnet_name, null);
  assert.strictEqual(holder.versions().claude_code_version, null);
});
