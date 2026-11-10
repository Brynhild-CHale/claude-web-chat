// The interactive session command and `connect attach` (contract 06 C-06.26,
// the manual row; 10 C-10.5; U732). Pins:
//   * lib/core/claude-cli sessionCommand is PURE and exact: the findClaude
//     binary, argv ['--dangerously-load-development-channels', 'server:web-chat'],
//     cwd the root, claudeEnv's scrubbed environment plus WEB_CHAT_CHANNEL=1
//     and WEB_CHAT_SUPERVISED=<root> — never WEB_CHAT_PORT, another WEB_CHAT_*
//     or a CLAUDE_CODE_*; exe null when there is no claude;
//   * runSession answers the child's exit code (128 + the signal's number when
//     a signal ended it) and ignores SIGINT/SIGTERM only while the child runs;
//   * `connect attach <label>` (through the subcommand table) runs the session
//     in the chat's root, answers its code, records the FIRST manual attach as
//     manual_attach_at and keeps it; an unknown label, a vanished root and no
//     claude each answer 1 and run nothing.
// Nothing here runs the claude program: the stand-in is a node script named
// `claude` in a temp dir, found through PATH (never named at a spawn site).
// Every case runs in a throwaway HOME (withTempHome, under sandbox.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { withTempHome } = require('../test-support/helpers');
const cli = require('../lib/core/claude-cli');
const table = require('../lib/connector/cli');
const setup = require('../lib/setup/connector');
const { userPaths } = require('../lib/core/paths');

const REPO = path.resolve(__dirname, '..');
const HUB = 'hale-hub';
const LABEL = '01jbz9a1b2c3d4e5f6g7h8j9k0';
const SYSTEM_PATH = '/usr/bin:/bin';

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A stand-in `claude`: a node script with a shebang, in its own temp dir.
// It writes what it was handed to `outFile` and ends as `body` says.
function stubClaude(t, { outFile, body = 'process.exit(7);' }) {
  const dir = tmpDir(t, 'wc-u732-bin-');
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('fs');
const e = process.env;
fs.writeFileSync(${JSON.stringify(outFile || path.join(dir, 'ran.json'))}, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(),
  channel: e.WEB_CHAT_CHANNEL, supervised: e.WEB_CHAT_SUPERVISED,
  port: e.WEB_CHAT_PORT, x: e.WEB_CHAT_X, y: e.CLAUDE_CODE_Y,
  webChat: Object.keys(e).filter((k) => k.startsWith('WEB_CHAT_')).sort(),
  claudeCode: Object.keys(e).filter((k) => k.startsWith('CLAUDE_CODE_')),
}));
${body}
`);
  fs.chmodSync(file, 0o755);
  return { dir, file };
}

// The environment the CLI runs under in these tests: the stub first on PATH,
// and the variables a calling Claude Code session would leak.
function callerEnv(stubDir) {
  return {
    PATH: `${stubDir}:${SYSTEM_PATH}`,
    HOME: process.env.HOME,
    WEB_CHAT_PORT: '5199',
    WEB_CHAT_X: 'x',
    CLAUDE_CODE_Y: 'y',
  };
}

// A paired record (06-connector-state's example shape) whose one chat, LABEL,
// has `root`; manual_attach_at null unless given.
function writePaired(root, { manualAttachAt = null } = {}) {
  setup.writeRecord({
    v: 1,
    hub: { id: HUB, origin: 'https://hub.example.com', name: 'Test hub' },
    machine: { id: 'mch_01jbz3k9q4w8r2t6v0x5m7n8p1', name: 'studio-mbp' },
    credential: {
      state: 'paired',
      algorithm: 'ed25519',
      key_file: userPaths().connectorKey(HUB),
      key_id: 'mky_y4881352x9v335ap1wtpd4q6ef',
      public_key: 'kTCi0MViCOcU8LqIYhIzSR1xC7jW0kmKgaBHqjV2eo4',
      fingerprint: 'SHA256:8RCAjKLqdjGVVg81ZpLmc+7/fOPgiDSG8BRyRVXXMGs',
      paired_at: 1793177460000,
      revoked_at: null,
    },
    workdir: userPaths().defaultWorkdir(HUB),
    ceiling: 'full',
    settings: { agents_at_once: 2, local_cap: null, accept_new_chats: true, let_home_start_agents: false, paused: false, rev: 4 },
    folders: [],
    chats: [{
      chat_id: LABEL, rev: 3, scope_kind: 'space', root, instance: null, owned_root: true,
      desired: 'running', manual_attach_at: manualAttachAt, assigned_at: 1793177700000,
    }],
    service: null,
    last_reported: null,
  });
}

function chatOf() {
  const read = setup.readRecord(HUB);
  assert.ok(read.ok, 'the record still reads');
  return read.value.chats.find((c) => c.chat_id === LABEL);
}

// `connect attach …` through the subcommand table, stdio piped (no terminal
// in a test), with output captured and runSession spied on.
async function connect(args, { env, now } = {}) {
  const out = [];
  const err = [];
  const runs = [];
  const deps = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env,
    stdio: 'pipe',
    runSession: (cmd, opts) => { runs.push({ cmd, opts }); return cli.runSession(cmd, opts); },
  };
  if (now) deps.now = now;
  const code = await table.main(['attach', ...args], deps);
  return { code, out: out.join('\n'), err: err.join('\n'), runs };
}

// ── sessionCommand ─────────────────────────────────────────────────────────

test('sessionCommand: the channel flag, the root, and only the two variables set explicitly', (t) => {
  withTempHome(t);
  const { dir, file } = stubClaude(t, {});
  const root = tmpDir(t, 'wc-u732-root-');
  const env = callerEnv(dir);
  const before = JSON.stringify(env);
  const cmd = cli.sessionCommand({ root, env });
  assert.deepEqual(cmd.argv, ['--dangerously-load-development-channels', 'server:web-chat']);
  assert.equal(cmd.cwd, root);
  assert.equal(cmd.exe, file, 'the stub, found through PATH');
  assert.equal(cmd.env.WEB_CHAT_CHANNEL, '1');
  assert.equal(cmd.env.WEB_CHAT_SUPERVISED, root);
  for (const k of ['WEB_CHAT_PORT', 'WEB_CHAT_X', 'CLAUDE_CODE_Y']) {
    assert.equal(Object.prototype.hasOwnProperty.call(cmd.env, k), false, `${k} is not carried`);
  }
  assert.deepEqual(Object.keys(cmd.env).filter((k) => k.startsWith('WEB_CHAT_')).sort(),
    ['WEB_CHAT_CHANNEL', 'WEB_CHAT_SUPERVISED']);
  assert.equal(cmd.env.PATH, env.PATH);
  assert.equal(cmd.env.HOME, env.HOME);
  assert.equal(JSON.stringify(env), before, 'the caller\'s environment is not touched');
  assert.notStrictEqual(cmd.argv, cli.SESSION_ARGV, 'a fresh argv each time');
});

test('sessionCommand: exe is null with an empty PATH and no fallback install', (t) => {
  withTempHome(t);
  const root = tmpDir(t, 'wc-u732-root-');
  for (const p of cli.fallbackLocations()) assert.equal(fs.existsSync(p), false, `${p} is in the throwaway HOME`);
  const cmd = cli.sessionCommand({ root, env: { PATH: '' } });
  assert.equal(cmd.exe, null);
  assert.equal(cmd.env.WEB_CHAT_SUPERVISED, root);
});

test('sessionCommand refuses a root that is not an absolute path', () => {
  assert.throws(() => cli.sessionCommand({ root: 'relative/dir', env: {} }), TypeError);
  assert.throws(() => cli.sessionCommand({ env: {} }), TypeError);
});

// ── runSession ─────────────────────────────────────────────────────────────

test('runSession: the child\'s code; SIGINT and SIGTERM ignored only while it runs', async (t) => {
  withTempHome(t);
  const { dir } = stubClaude(t, { body: 'setTimeout(() => process.exit(3), 200);' });
  const root = tmpDir(t, 'wc-u732-root-');
  const cmd = cli.sessionCommand({ root, env: callerEnv(dir) });
  const base = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
  const p = cli.runSession(cmd, { stdio: 'pipe' });
  assert.equal(process.listenerCount('SIGINT'), base.int + 1, 'SIGINT held while the session runs');
  assert.equal(process.listenerCount('SIGTERM'), base.term + 1, 'SIGTERM held while the session runs');
  assert.equal(await p, 3);
  assert.equal(process.listenerCount('SIGINT'), base.int, 'released after');
  assert.equal(process.listenerCount('SIGTERM'), base.term, 'released after');
});

test('runSession: a stub ended by SIGTERM gives 143', async (t) => {
  withTempHome(t);
  const { dir } = stubClaude(t, { body: 'process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 5000);' });
  const root = tmpDir(t, 'wc-u732-root-');
  const code = await cli.runSession(cli.sessionCommand({ root, env: callerEnv(dir) }), { stdio: 'pipe' });
  assert.equal(code, 143);
});

test('runSession: inherit by default, an argv and no shell, through the injected spawn', async () => {
  const calls = [];
  const { EventEmitter } = require('events');
  const spawn = (exe, argv, opts) => {
    calls.push({ exe, argv, opts });
    const child = new EventEmitter();
    child.pid = 4242;
    setImmediate(() => child.emit('exit', null, 'SIGINT'));
    return child;
  };
  const cmd = { exe: '/stub/claude', argv: ['a'], env: { A: '1' }, cwd: '/r' };
  assert.equal(await cli.runSession(cmd, { spawn }), 130);
  assert.deepEqual(calls, [{ exe: '/stub/claude', argv: ['a'], opts: { cwd: '/r', env: { A: '1' }, stdio: 'inherit', shell: false } }]);
});

test('runSession rejects a command with no claude, and a child that cannot start, releasing the signals', async (t) => {
  const base = process.listenerCount('SIGINT');
  await assert.rejects(cli.runSession({ exe: null, argv: [], env: {}, cwd: '/' }), TypeError);
  const missing = path.join(tmpDir(t, 'wc-u732-none-'), 'claude');
  await assert.rejects(cli.runSession({ exe: missing, argv: [], env: {}, cwd: '/' }, { stdio: 'pipe' }), /ENOENT/);
  assert.equal(process.listenerCount('SIGINT'), base);
});

// ── connect attach ─────────────────────────────────────────────────────────

test('connect attach runs the session in the chat\'s root, answers its code, and records the first manual attach', async (t) => {
  withTempHome(t);
  const scratch = tmpDir(t, 'wc-u732-out-');
  const outFile = path.join(scratch, 'ran.json');
  const { dir, file } = stubClaude(t, { outFile });
  const root = tmpDir(t, 'wc-u732-root-');
  writePaired(root);
  assert.equal(chatOf().manual_attach_at, null);

  const r = await connect([LABEL], { env: callerEnv(dir), now: () => 1800000000000 });
  assert.equal(r.code, 7, r.err);
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].cmd.exe, file);
  const ran = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.deepEqual(ran.argv, ['--dangerously-load-development-channels', 'server:web-chat']);
  assert.equal(ran.cwd, fs.realpathSync(root));
  assert.equal(ran.channel, '1');
  assert.equal(ran.supervised, root);
  assert.deepEqual([ran.port, ran.x, ran.y], [undefined, undefined, undefined]);
  assert.deepEqual(ran.webChat, ['WEB_CHAT_CHANNEL', 'WEB_CHAT_SUPERVISED']);
  assert.deepEqual(ran.claudeCode, []);
  assert.equal(chatOf().manual_attach_at, 1800000000000, 'the first attach is recorded');

  fs.rmSync(outFile);
  const again = await connect([LABEL], { env: callerEnv(dir), now: () => 1900000000000 });
  assert.equal(again.code, 7);
  assert.ok(fs.existsSync(outFile), 'the second attach runs the session too');
  assert.equal(chatOf().manual_attach_at, 1800000000000, 'a later attach keeps the first');
});

test('connect attach: an unknown label answers 1 and runs nothing', async (t) => {
  withTempHome(t);
  const { dir } = stubClaude(t, {});
  const root = tmpDir(t, 'wc-u732-root-');
  writePaired(root);
  const r = await connect(['01jbz9a1b2c3d4e5f6g7h8j9zz'], { env: callerEnv(dir) });
  assert.equal(r.code, 1);
  assert.match(r.err, /no chat 01jbz9a1b2c3d4e5f6g7h8j9zz on this machine/);
  assert.equal(r.runs.length, 0);
  assert.equal(chatOf().manual_attach_at, null, 'nothing recorded');
});

test('connect attach: a mapped root that no longer exists answers 1 and runs nothing', async (t) => {
  withTempHome(t);
  const { dir } = stubClaude(t, {});
  const root = tmpDir(t, 'wc-u732-root-');
  writePaired(root);
  fs.rmSync(root, { recursive: true });
  const r = await connect([LABEL], { env: callerEnv(dir) });
  assert.equal(r.code, 1);
  assert.match(r.err, /is not there any more/);
  assert.equal(r.runs.length, 0);
  assert.equal(chatOf().manual_attach_at, null);
});

test('connect attach: no claude found answers 1 naming the reason, and records nothing', async (t) => {
  withTempHome(t);
  const root = tmpDir(t, 'wc-u732-root-');
  writePaired(root);
  const r = await connect([LABEL], { env: { PATH: '', HOME: process.env.HOME } });
  assert.equal(r.code, 1);
  assert.match(r.err, /claude not found \(not on PATH, in ~\/\.local\/bin or in ~\/\.claude\/local\)/);
  assert.equal(r.runs.length, 0);
  assert.equal(chatOf().manual_attach_at, null);
});

test('connect attach: not paired, or no label, answers 1 and writes nothing', async (t) => {
  const home = withTempHome(t);
  const r = await connect([LABEL], { env: { PATH: '' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /not paired/);
  assert.equal(fs.existsSync(path.join(home, '.web-chat')), false, 'nothing under ~/.web-chat');
  const bare = await connect([], { env: { PATH: '' } });
  assert.equal(bare.code, 1);
  assert.match(bare.err, /usage: claude-web-chat connect attach <chat-label>/);
  assert.equal(bare.runs.length, 0);
});

test('the table lists `connect attach <chat-label>`', () => {
  const row = table.ROWS.find((r) => r.name === 'attach');
  assert.ok(row);
  assert.equal(row.usage, 'connect attach <chat-label>');
  assert.match(table.usageText(), /claude-web-chat connect attach <chat-label>/);
  assert.equal(table.ROWS[0].name, 'status', 'status stays first');
});

test('no literal claude program and no WEB_CHAT_PORT in the session command\'s files', () => {
  const literal = /\b(?:execFile|execFileSync|spawn|spawnSync)\(\s*['"`]claude['"`]/;
  for (const rel of ['lib/core/claude-cli.js', 'lib/connector/attach.js']) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, literal, rel);
    assert.doesNotMatch(code, /WEB_CHAT_PORT/, `${rel} sets no WEB_CHAT_PORT`);
    assert.doesNotMatch(code, /shell:\s*true/, rel);
    assert.doesNotMatch(code, /\btmux\b/, `${rel} names no tmux session`);
  }
});
