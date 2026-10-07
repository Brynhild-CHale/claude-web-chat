// lib/mcp/interrupt.js — the Esc injector (spec §15.2, U82), against FAKES:
// a fake helper spawn, a fake clock, a fake event stream and a fake registry,
// so nothing here can ever type into a terminal. The one real-terminal check is
// the opt-in test/mcp-interrupt-tty-e2e.test.js (WEB_CHAT_E2E_TTY=1, the
// maintainer's run).
//
// What is pinned:
//   * the helper is ONE fixed program, run as `perl -e HELPER_SCRIPT <mode>`,
//     with no request data on its argv, in its environment or on its stdin;
//   * statically, the only byte the module can write is 0x1b (§10.2);
//   * the guards, each refusal named once in the log, and one helper run per
//     accepted event;
//   * the probe's reasons, and its answer reaching the presence row;
//   * the follower: no daemon is ever spawned to listen, the first connect is
//     live-only, a replayed id is dropped, and a session that cannot inject
//     opens no stream;
//   * stop() leaves nothing behind, and the real MCP server the suite launches
//     always answers null (its parent is the test runner, never Claude Code).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { spawn: realSpawn } = require('child_process');

const {
  HELPER_SCRIPT, helperArgv, probeInterrupt, guard, startInterrupt, isClaudeCommand,
  MAX_AGE_MS, INJECT_GAP_MS, HELPER_TIMEOUT_MS, EXPIRY_SLACK_MS, BACKOFF_MIN_MS,
} = require('../lib/mcp/interrupt');
const { startPresence } = require('../lib/mcp/presence');
const registry = require('../lib/util/registry');
const { writePortfileAt } = require('../lib/core/portfiles');
const { LISTEN_HOST } = require('../lib/core/cors');
const { withTempHome, waitUntil } = require('../test-support/helpers');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp', 'interrupt.js'), 'utf8');
const MCP_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');

// ── fakes ───────────────────────────────────────────────────────────────────

// A helper child. `exit` is the code it exits with (on the next tick), or null
// to keep running; `ignoreKill` keeps it running past a SIGKILL too.
function fakeChild({ exit = 0, stdout = '', error = null, ignoreKill = false } = {}) {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.kills = [];
  c.kill = (sig) => {
    c.kills.push(sig);
    if (!ignoreKill) setImmediate(() => c.emit('exit', null, sig));
    return true;
  };
  setImmediate(() => {
    if (error) { c.emit('error', error); return; }
    if (exit === null) return;
    if (stdout) c.stdout.write(stdout);
    c.stdout.end();
    setImmediate(() => c.emit('exit', exit, null));
  });
  return c;
}

// spawn(cmd, argv, opts), recording every call. `plan` maps a mode to the
// child's behaviour (an object, or a function returning one per call).
function fakeSpawn(plan = {}) {
  const calls = [];
  const children = [];
  const fn = (cmd, argv, opts) => {
    calls.push({ cmd, argv, opts });
    const mode = argv[argv.length - 1];
    const p = typeof plan[mode] === 'function' ? plan[mode](calls.length) : plan[mode];
    const c = fakeChild(p || {});
    children.push(c);
    return c;
  };
  fn.calls = calls;
  fn.children = children;
  fn.modes = () => calls.map((c) => c.argv[c.argv.length - 1]);
  return fn;
}

const PROBE_OK = { exit: 0, stdout: 'fg\n' };

// The stream: records each subscribe; the test pushes events through `push`.
function fakeStream() {
  const subs = [];
  const fn = (opts) => {
    const sub = { opts, closed: false, close() { sub.closed = true; } };
    subs.push(sub);
    if (opts.onOpen) opts.onOpen();
    return sub;
  };
  fn.subs = subs;
  fn.push = (e) => subs[subs.length - 1].opts.onEvent(e);
  return fn;
}

function fakePresence() {
  const p = { values: [], setInterrupt(v) { p.values.push(v); } };
  return p;
}

// A fully fake injector whose probe answers 'tty', parented by pid 4242.
async function ttyInjector(t, { spawn = fakeSpawn({ probe: PROBE_OK, inject: { exit: 0 } }), clock = { t: 1_000_000 }, parent = { pid: 4242 } } = {}) {
  const logs = [];
  const presence = fakePresence();
  const stream = fakeStream();
  const inj = startInterrupt({
    root: '/nonexistent/root',
    presence,
    subscribeSSE: stream,
    spawn,
    processCommand: () => '/Users/x/.local/bin/claude --dangerously-load-development-channels server:web-chat',
    platform: 'darwin',
    readFile: () => { throw new Error('not linux'); },
    now: () => clock.t,
    ppid: () => parent.pid,
    log: (m) => logs.push(m),
  });
  t.after(() => inj.stop());
  await waitUntil(() => stream.subs.length === 1, { what: 'the probe to answer and the stream to open' });
  return { inj, logs, presence, stream, spawn, clock, parent };
}

const event = (clock, over = {}) => ({
  kind: 'control', op: 'interrupt', id: `ctl-${Math.random().toString(36).slice(2)}`,
  conversation_id: 'conv-1', session_id: 'sess-1', via: 'tty', target_pid: 4242,
  expires_at: clock.t + 2000, ...over,
});

const refusals = (logs) => logs.filter((m) => m.startsWith('interrupt refused: ')).map((m) => m.slice('interrupt refused: '.length));
const outcomes = (logs) => logs.filter((m) => m === 'interrupt: Esc sent' || m.startsWith('interrupt refused: '));
const injects = (spawn) => spawn.modes().filter((m) => m === 'inject').length;

// ── the helper ──────────────────────────────────────────────────────────────

test('helperArgv: exactly [-e, HELPER_SCRIPT, mode] for the two modes; any other mode throws', () => {
  assert.deepEqual(helperArgv('probe'), ['-e', HELPER_SCRIPT, 'probe']);
  assert.deepEqual(helperArgv('inject'), ['-e', HELPER_SCRIPT, 'inject']);
  for (const bad of ['', 'Inject', 'inject ', 'type', undefined, null, 27, ['inject']]) {
    assert.throws(() => helperArgv(bad), /unknown mode/, `mode ${JSON.stringify(bad)}`);
  }
});

test('static: the only byte the module can write is 0x1b (§10.2)', () => {
  // HELPER_SCRIPT is the one String.raw literal in the source, and the module
  // exports exactly what it says.
  const m = SOURCE.match(/const HELPER_SCRIPT = String\.raw`([^`]*)`;/);
  assert.ok(m, 'HELPER_SCRIPT is a fixed literal');
  assert.equal(m[1], HELPER_SCRIPT);
  const outside = SOURCE.replace(m[0], '');

  // The input-injection request is named only inside the helper.
  assert.equal((outside.match(/TIOCSTI/g) || []).length, 0, 'named nowhere outside HELPER_SCRIPT');
  assert.ok(/TIOCSTI/.test(HELPER_SCRIPT));

  // Exactly one ioctl call in the module, inside the helper, carrying the
  // TIOCSTI request and a byte packed from 27 — the only byte the module packs.
  assert.equal((SOURCE.match(/\bioctl\s*\(/g) || []).length, 1, 'one ioctl call in the whole module');
  assert.deepEqual(HELPER_SCRIPT.match(/\bioctl\s*\([^;]*\)/g), ['ioctl($tty, $TIOCSTI, $esc)'], 'the one ioctl, on TIOCSTI');
  assert.equal((SOURCE.match(/\bpack\s*\(/g) || []).length, 1, 'one pack in the whole module');
  assert.deepEqual(HELPER_SCRIPT.match(/\$esc = pack\([^)]*\)/g), ["$esc = pack('c', 27)"], 'the one packed byte is 27');

  // Nothing else in the helper writes: no print/syswrite to the terminal, no
  // other way out; its one print is the probe's "fg" on stdout.
  assert.deepEqual(HELPER_SCRIPT.match(/\b(?:print|printf|syswrite|say|write)\b[^;]*/g), ['print "fg\\n"']);
  assert.doesNotMatch(HELPER_SCRIPT, /\$ARGV\[[1-9]|<STDIN>|\$ENV\{|system|exec|`/, 'it reads nothing but its mode');

  // The module spawns one program, the helper, through helperArgv; it never
  // signals a pid it read from somewhere (conventions: process.kill).
  assert.equal((SOURCE.match(/\bspawn\s*\(/g) || []).length, 1);
  assert.match(SOURCE, /spawn\('perl', helperArgv\(mode\), helperOptions\(\)\)/);
  assert.doesNotMatch(SOURCE, /process\.kill\(/);

  // It follows the daemon through subscribeSSE, which discovers a portfile and
  // never spawns — never the daemon-spawning get/post/api of lib/client.
  assert.match(SOURCE, /require\('\.\.\/client'\)\.subscribeSSE/);
  assert.doesNotMatch(SOURCE, /\.(get|post|api|request)\s*\(/, 'no daemon-spawning client call');
});

test('the helper program parses, and refuses a mode it does not know (exit 6)', { skip: process.platform === 'win32' }, async (t) => {
  // Neither run opens a terminal: -c only compiles, and a bad mode exits first.
  const run = (argv) => new Promise((resolve) => {
    const c = realSpawn('perl', argv, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', () => resolve({ code: null, err: 'no perl' }));
    c.on('exit', (code) => resolve({ code, err }));
    t.after(() => { try { c.kill('SIGKILL'); } catch {} });
  });
  const compiled = await run(['-c', '-e', HELPER_SCRIPT]);
  if (compiled.err === 'no perl') { t.skip('no perl on this machine'); return; }
  assert.equal(compiled.code, 0, compiled.err);
  assert.equal((await run(['-e', HELPER_SCRIPT, 'bogus'])).code, 6);
});

test('no request data reaches the helper: argv, environment and stdin are fixed', async (t) => {
  const { stream, spawn, clock } = await ttyInjector(t);
  const e = event(clock, {
    id: 'ID-MARKER-1', conversation_id: 'CONV-MARKER', session_id: 'SESS-MARKER',
    expires_at: clock.t + 1999,
  });
  stream.push(e);
  await waitUntil(() => spawn.children.length === 2, { what: 'the inject helper' });
  assert.deepEqual(spawn.modes(), ['probe', 'inject']);
  const fields = [e.id, e.conversation_id, e.session_id, String(e.target_pid), String(e.expires_at)];
  for (const { cmd, argv, opts } of spawn.calls) {
    assert.equal(cmd, 'perl');
    assert.deepEqual(argv, helperArgv(argv[2]));
    assert.equal(opts.stdio[0], 'ignore', 'no stdin');
    assert.deepEqual(Object.keys(opts.env).sort(), process.env.PATH ? ['PATH'] : [], 'PATH only');
    const seen = JSON.stringify({ argv, env: opts.env });
    for (const f of fields) assert.ok(!seen.includes(f), `${f} is not handed to the helper`);
  }
});

// ── the guards ──────────────────────────────────────────────────────────────

test('guard (pure): each refusal by name, in order; null when all hold', () => {
  const now = 50_000;
  const ok = { now, startPpid: 7, ppid: 7, lastInjectAt: -Infinity, inFlight: false };
  const e = (exp) => ({ expires_at: exp });
  assert.equal(guard(e(now + 2000), ok), null);
  assert.equal(guard(e(now + 1), ok), null);
  assert.equal(guard(e(now), ok), 'expired', 'now ≥ expires_at');
  assert.equal(guard(e(now - 1), ok), 'expired');
  assert.equal(guard(e(undefined), ok), 'expired', 'no expiry is no request');
  assert.equal(guard(e('soon'), ok), 'expired');
  assert.equal(guard(e(now + MAX_AGE_MS + EXPIRY_SLACK_MS), ok), null, 'the far edge still counts');
  assert.equal(guard(e(now + MAX_AGE_MS + EXPIRY_SLACK_MS + 1), ok), 'expired', 'dated too far ahead');
  assert.equal(guard(e(now + 2000), { ...ok, ppid: 1 }), 'not-parent');
  assert.equal(guard(e(now + 2000), { ...ok, lastInjectAt: now - INJECT_GAP_MS + 1 }), 'rate');
  assert.equal(guard(e(now + 2000), { ...ok, lastInjectAt: now - INJECT_GAP_MS }), null, '1.5 s on is fine');
  assert.equal(guard(e(now + 2000), { ...ok, inFlight: true }), 'in-flight');
  // Order: expired before not-parent before rate before in-flight.
  assert.equal(guard(e(now), { ...ok, ppid: 1, lastInjectAt: now, inFlight: true }), 'expired');
  assert.equal(guard(e(now + 2000), { ...ok, ppid: 1, lastInjectAt: now, inFlight: true }), 'not-parent');
  assert.equal(guard(e(now + 2000), { ...ok, lastInjectAt: now, inFlight: true }), 'rate');
  assert.deepEqual([MAX_AGE_MS, INJECT_GAP_MS, HELPER_TIMEOUT_MS, EXPIRY_SLACK_MS], [2000, 1500, 1000, 500]);
});

test('an event for another pid, or not a tty interrupt, is ignored without a word', async (t) => {
  const { stream, spawn, clock, logs } = await ttyInjector(t);
  stream.push(event(clock, { target_pid: 9999 }));
  stream.push(event(clock, { via: 'hook' }));
  stream.push(event(clock, { op: 'restore' }));
  stream.push(event(clock, { kind: 'store' }));
  stream.push(event(clock, { id: undefined }));
  stream.push(event(clock, { target_pid: '4242' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(injects(spawn), 0);
  assert.deepEqual(refusals(logs), []);
});

test('the guard matrix through the follower: each refusal logged once; a valid event spawns the helper once', async (t) => {
  const clock = { t: 1_000_000 };
  const parent = { pid: 4242 };
  // Inject #1 hangs past its kill (to hold in-flight), the rest exit 0.
  const spawn = fakeSpawn({ probe: PROBE_OK, inject: (n) => (n === 2 ? { exit: null, ignoreKill: true } : { exit: 0 }) });
  const { stream, logs } = await ttyInjector(t, { spawn, clock, parent });

  stream.push(event(clock, { expires_at: clock.t }));
  assert.deepEqual(refusals(logs), ['expired']);
  stream.push(event(clock, { expires_at: clock.t + MAX_AGE_MS + EXPIRY_SLACK_MS + 1 }));
  assert.deepEqual(refusals(logs), ['expired', 'expired'], 'too far in the future');

  // A valid event: exactly one helper run.
  stream.push(event(clock));
  assert.equal(injects(spawn), 1);

  // Rate: a second accepted event within 1.5 s.
  clock.t += 600;
  stream.push(event(clock));
  assert.deepEqual(refusals(logs).slice(2), ['rate']);
  assert.equal(injects(spawn), 1);

  // In-flight: the first helper is still running (it ignored the timeout's kill).
  await waitUntil(() => refusals(logs).includes('helper-timeout'), { timeout: 3000, what: 'the timeout' });
  assert.deepEqual(spawn.children[1].kills, ['SIGKILL'], 'killed through its handle at 1 s');
  clock.t += 2000;
  stream.push(event(clock));
  assert.deepEqual(refusals(logs).slice(3), ['helper-timeout', 'in-flight']);
  assert.equal(injects(spawn), 1);

  // It exits at last; the next valid event runs again.
  spawn.children[1].emit('exit', null, 'SIGKILL');
  stream.push(event(clock));
  assert.equal(injects(spawn), 2);

  // Not-parent: Claude Code went away and this process was adopted by a new
  // parent, which an event then names.
  clock.t += 2000;
  parent.pid = 1;
  stream.push(event(clock, { target_pid: 1 }));
  assert.deepEqual(refusals(logs).slice(5), ['not-parent']);
  assert.equal(injects(spawn), 2);
  const counts = {};
  for (const r of refusals(logs)) counts[r] = (counts[r] || 0) + 1;
  assert.deepEqual(counts, { expired: 2, rate: 1, 'helper-timeout': 1, 'in-flight': 1, 'not-parent': 1 }, 'each named once per refused event');
});

test('the inject helper\'s outcomes map to their names; one run per event, never a retry', async (t) => {
  const codes = [0, 2, 3, 5, 4];
  let i = 0;
  const spawn = fakeSpawn({ probe: PROBE_OK, inject: () => ({ exit: codes[i++] }) });
  const { stream, logs, clock } = await ttyInjector(t, { spawn });
  for (let k = 0; k < codes.length; k++) {
    stream.push(event(clock));
    await waitUntil(() => outcomes(logs).length === 1 + k, { what: `outcome ${k}` });
    clock.t += INJECT_GAP_MS;
  }
  assert.deepEqual(outcomes(logs), [
    'interrupt: Esc sent',
    'interrupt refused: no-tty',
    'interrupt refused: not-foreground',
    'interrupt refused: helper-failed',
    'interrupt refused: helper-failed',
  ]);
  assert.equal(injects(spawn), codes.length, 'one run each, no retry');

  // A spawn error (perl gone since the probe) is helper-failed too.
  const gone = fakeSpawn({ probe: PROBE_OK, inject: { error: Object.assign(new Error('spawn perl ENOENT'), { code: 'ENOENT' }) } });
  const g = await ttyInjector(t, { spawn: gone });
  g.stream.push(event(g.clock));
  await waitUntil(() => refusals(g.logs).length === 1, { what: 'the spawn error' });
  assert.deepEqual(refusals(g.logs), ['helper-failed']);
});

test('a helper still running at 1 s is killed and logged helper-timeout', async (t) => {
  const spawn = fakeSpawn({ probe: PROBE_OK, inject: { exit: null } });
  const { stream, logs, clock } = await ttyInjector(t, { spawn });
  const t0 = Date.now();
  stream.push(event(clock));
  await waitUntil(() => refusals(logs).length === 1, { timeout: 3000, what: 'the timeout' });
  assert.deepEqual(refusals(logs), ['helper-timeout']);
  assert.ok(Date.now() - t0 >= HELPER_TIMEOUT_MS - 50, 'not before the second');
  assert.deepEqual(spawn.children[1].kills, ['SIGKILL']);
});

test('a replayed event id is dropped silently', async (t) => {
  const { stream, spawn, clock, logs } = await ttyInjector(t);
  const e = event(clock);
  stream.push(e);
  clock.t += INJECT_GAP_MS;
  stream.push({ ...e, expires_at: clock.t + 2000 });
  assert.equal(injects(spawn), 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(refusals(logs), []);
});

// ── the probe ───────────────────────────────────────────────────────────────

test('probe: the first failing check names the answer; tty only when every one holds', async () => {
  const claude = () => 'claude';
  const base = { platform: 'darwin', processCommand: claude, ppid: () => 4242, readFile: () => '1' };
  const helper = (plan) => fakeSpawn({ probe: plan });

  const never = helper(PROBE_OK);
  assert.deepEqual(await probeInterrupt({ ...base, platform: 'win32', spawn: never }), { interrupt: null, reason: 'platform' });
  assert.deepEqual(await probeInterrupt({ ...base, platform: 'freebsd', spawn: never }), { interrupt: null, reason: 'platform' });

  const files = [];
  const off = await probeInterrupt({ ...base, platform: 'linux', readFile: (f) => { files.push(f); return '0\n'; }, spawn: never });
  assert.deepEqual(off, { interrupt: null, reason: 'tiocsti-off' });
  assert.deepEqual(files, ['/proc/sys/dev/tty/legacy_tiocsti']);

  for (const cmd of ['node /x/bin/cli.js', '/bin/zsh -l', '-zsh', 'node --test test/a.test.js', '', null, 'claudette', '/opt/claude-code/bin/node /x/other.js']) {
    assert.deepEqual(await probeInterrupt({ ...base, processCommand: () => cmd, spawn: never }), { interrupt: null, reason: 'not-claude' }, JSON.stringify(cmd));
  }
  assert.deepEqual(await probeInterrupt({ ...base, processCommand: () => { throw new Error('ps'); }, spawn: never }), { interrupt: null, reason: 'not-claude' });
  assert.equal(never.calls.length, 0, 'no helper runs before the parent is known to be Claude Code');

  const enoent = Object.assign(new Error('spawn perl ENOENT'), { code: 'ENOENT' });
  assert.deepEqual(await probeInterrupt({ ...base, spawn: helper({ error: enoent }) }), { interrupt: null, reason: 'no-helper' });
  assert.deepEqual(await probeInterrupt({ ...base, spawn: helper({ exit: 2 }) }), { interrupt: null, reason: 'no-tty' });
  assert.deepEqual(await probeInterrupt({ ...base, spawn: helper({ exit: 3 }) }), { interrupt: null, reason: 'not-foreground' });
  assert.deepEqual(await probeInterrupt({ ...base, spawn: helper({ exit: 0, stdout: 'bg\n' }) }), { interrupt: null, reason: 'no-helper' });
  assert.deepEqual(await probeInterrupt({ ...base, spawn: helper({ exit: 9 }) }), { interrupt: null, reason: 'no-helper' });

  const ok = helper(PROBE_OK);
  assert.deepEqual(await probeInterrupt({ ...base, spawn: ok }), { interrupt: 'tty', reason: 'ok' });
  assert.deepEqual(ok.modes(), ['probe']);
  // Linux with the legacy setting on, or a kernel without it.
  assert.equal((await probeInterrupt({ ...base, platform: 'linux', readFile: () => '1\n', spawn: helper(PROBE_OK) })).interrupt, 'tty');
  assert.equal((await probeInterrupt({ ...base, platform: 'linux', readFile: () => { throw new Error('ENOENT'); }, spawn: helper(PROBE_OK) })).interrupt, 'tty');
});

test('isClaudeCommand: argv0 `claude`, or node running Claude Code\'s cli.js', () => {
  for (const yes of [
    'claude',
    'claude --dangerously-load-development-channels server:web-chat',
    '/Users/x/.local/bin/claude -c',
    'claude bg-spare --bg-spare /tmp/x.sock',
    'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume',
  ]) assert.ok(isClaudeCommand(yes), yes);
  for (const no of ['node', 'node /x/claude', 'python3 claude', 'zsh', 'claude-web-chat open', '/x/claude2', 'node /x/@anthropic-ai/claude-code/cli.jsx']) {
    assert.ok(!isClaudeCommand(no), no);
  }
});

test('the probe\'s answer reaches presence.setInterrupt; a session that cannot inject opens no stream', async (t) => {
  for (const [processCommand, want] of [[() => 'claude', ['tty']], [() => 'node x.js', [null]]]) {
    const presence = fakePresence();
    const stream = fakeStream();
    const logs = [];
    const inj = startInterrupt({
      root: '/nonexistent', presence, subscribeSSE: stream, spawn: fakeSpawn({ probe: PROBE_OK }),
      processCommand, platform: 'darwin', ppid: () => 4242, log: (m) => logs.push(m),
    });
    t.after(() => inj.stop());
    await waitUntil(() => presence.values.length === 1, { what: 'the probe answer' });
    assert.deepEqual(presence.values, want);
    await new Promise((r) => setImmediate(r));
    assert.equal(stream.subs.length, want[0] === 'tty' ? 1 : 0);
    assert.deepEqual(stream.subs.map((s) => s.opts.kinds), want[0] === 'tty' ? [['control']] : []);
    assert.deepEqual(logs[0], want[0] === 'tty' ? 'interrupt: tty' : 'interrupt: off (not-claude)');
  }
});

// ── the presence row ────────────────────────────────────────────────────────

test('presence.setInterrupt: registers null, writes a change once, nothing on a repeat or after stop()', () => {
  const writes = [];
  const reg = {
    registerMcp: (row) => writes.push(['register', row]),
    updateMcp: (pid, patch) => writes.push(['update', pid, patch]),
    deregisterMcp: ({ pid }) => writes.push(['deregister', pid]),
  };
  const p = startPresence({ root: '/r', pid: 11, ppid: 10, reg });
  assert.equal(writes[0][1].interrupt, null, 'the probe is async: the row starts null');
  p.setInterrupt('tty');
  p.setInterrupt('tty');
  p.setInterrupt(null);
  p.setInterrupt(undefined);
  p.setInterrupt('bogus');
  p.setInterrupt('tty');
  assert.deepEqual(writes.slice(1), [
    ['update', 11, { interrupt: 'tty' }],
    ['update', 11, { interrupt: null }],
    ['update', 11, { interrupt: 'tty' }],
  ]);
  p.stop();
  p.setInterrupt(null);
  assert.deepEqual(writes.slice(4), [['deregister', 11]]);
});

test('presence.setInterrupt(\'tty\') → mcpSessionsFor(root) reports it (a real registry in the sandbox HOME)', (t) => {
  withTempHome(t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-int-root-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = startPresence({ root, pid: process.pid, ppid: process.ppid });
  t.after(() => p.stop());
  const row = () => registry.mcpSessionsFor(root).find((r) => r.pid === process.pid);
  assert.equal(row().interrupt, null);
  p.setInterrupt('tty');
  assert.equal(row().interrupt, 'tty');
  p.stop();
  assert.equal(row(), undefined);
});

// ── the follower ────────────────────────────────────────────────────────────

// A recording fake stream that fails to connect: it drives onClose on the next
// tick without an onOpen, so the follower's backoff grows (a successful open
// resets it, which is correct and not what this tests). Each call's time is kept.
function closingStream() {
  const calls = [];
  const fn = (opts) => {
    calls.push({ at: Date.now(), opts });
    const sub = { closed: false, close() { sub.closed = true; } };
    setImmediate(() => { if (!sub.closed && opts.onClose) opts.onClose(); });
    return sub;
  };
  fn.calls = calls;
  return fn;
}

test('follower: a dropped stream backs off (doubling), and stop() clears the reconnect timer', async (t) => {
  const stream = closingStream();
  const inj = startInterrupt({
    root: '/nonexistent', presence: fakePresence(), subscribeSSE: stream, spawn: fakeSpawn({ probe: PROBE_OK }),
    processCommand: () => 'claude', platform: 'darwin', ppid: () => 4242, log: () => {},
  });
  t.after(() => inj.stop());
  await waitUntil(() => stream.calls.length >= 3, { timeout: 5000, what: 'three connect attempts' });
  inj.stop();
  const gaps = [stream.calls[1].at - stream.calls[0].at, stream.calls[2].at - stream.calls[1].at];
  assert.ok(gaps[0] >= BACKOFF_MIN_MS - 60, `first backoff ${gaps[0]} ms`);
  assert.ok(gaps[1] >= 2 * BACKOFF_MIN_MS - 60, `doubling: ${gaps[1]} ms`);
  assert.equal(stream.calls[0].opts.since, undefined, 'the first connect is live-only');
  const n = stream.calls.length;
  await new Promise((r) => setTimeout(r, BACKOFF_MIN_MS * 3));
  assert.equal(stream.calls.length, n, 'stop() cleared the reconnect timer');
});

test('follower: with no portfile the client never spawns a daemon', async (t) => {
  // The module\'s own default client (no injected subscribeSSE): subscribeSSE
  // discovers a portfile and, finding none, never spawns — unlike get/post.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-int-nod-'));
  fs.mkdirSync(path.join(root, '.web-chat'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inj = startInterrupt({
    root, presence: fakePresence(), spawn: fakeSpawn({ probe: PROBE_OK }),
    processCommand: () => 'claude', platform: 'darwin', ppid: () => 4242, log: () => {},
  });
  t.after(() => inj.stop());
  await new Promise((r) => setTimeout(r, BACKOFF_MIN_MS + 200));
  assert.equal(fs.existsSync(path.join(root, '.web-chat', 'server.json')), false, 'no daemon was spawned to listen');
});

// A bare SSE endpoint standing in for the daemon's /api/events/stream, so the
// test can serve control events (U81, which emits them, is a later unit): it
// records each request's query, replays what it is told, and can drop streams.
async function fakeDaemon(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-int-sse-'));
  fs.mkdirSync(path.join(root, '.web-chat'));
  const requests = [];
  const streams = new Set();
  const server = http.createServer((req, res) => {
    requests.push(new URL(req.url, 'http://x'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('retry: 2000\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
  });
  await new Promise((r) => server.listen(0, LISTEN_HOST, r));
  writePortfileAt(path.join(root, '.web-chat'), { pid: process.pid, port: server.address().port });
  const d = {
    root,
    requests,
    send: (e) => { for (const s of streams) s.write(`id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`); },
    drop: () => { for (const s of streams) s.destroy(); },
    open: () => streams.size,
  };
  t.after(async () => {
    for (const s of streams) s.destroy();
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return d;
}

test('follower: dedupes a replayed id across a reconnect, which resumes from the last seq', async (t) => {
  const d = await fakeDaemon(t);
  const clock = { t: Date.now() };
  const logs = [];
  const spawn = fakeSpawn({ probe: PROBE_OK, inject: { exit: 0 } });
  const inj = startInterrupt({
    root: d.root, presence: fakePresence(), spawn,
    processCommand: () => 'claude', platform: 'darwin', now: () => clock.t, ppid: () => 4242, log: (m) => logs.push(m),
  });
  t.after(() => inj.stop());
  await waitUntil(() => d.open() === 1, { what: 'the first stream' });
  assert.equal(d.requests[0].searchParams.get('kinds'), 'control');
  assert.equal(d.requests[0].searchParams.has('since'), false, 'the first connect is live-only');

  const e = { seq: 7, ...event(clock) };
  d.send(e);
  await waitUntil(() => injects(spawn) === 1, { what: 'the injection' });

  d.drop();
  await waitUntil(() => d.open() === 1 && d.requests.length === 2, { timeout: 4000, what: 'the reconnect' });
  assert.equal(d.requests[1].searchParams.get('since'), '7', 'a reconnect resumes from the last seq');
  clock.t += INJECT_GAP_MS;
  d.send({ ...e, expires_at: clock.t + 2000 }); // the same id, replayed
  d.send({ seq: 8, kind: 'control', op: 'restore', id: 'r1' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(injects(spawn), 1, 'the replay ran nothing');
  assert.deepEqual(refusals(logs), []);
  inj.stop();
  await waitUntil(() => d.open() === 0, { what: 'stop() to close the stream' });
});

test('stop(): closes the stream, clears the timers, kills a running helper, and ignores what follows', async (t) => {
  const spawn = fakeSpawn({ probe: PROBE_OK, inject: { exit: null, ignoreKill: true } });
  const { inj, stream, clock, logs } = await ttyInjector(t, { spawn });
  stream.push(event(clock));
  assert.equal(injects(spawn), 1);
  inj.stop();
  assert.equal(stream.subs[0].closed, true);
  assert.deepEqual(spawn.children[1].kills, ['SIGKILL']);
  clock.t += 5000;
  stream.subs[0].opts.onEvent(event(clock));
  assert.equal(injects(spawn), 1);
  inj.stop(); // idempotent
  // The helper's own 1 s timer went with it: no second kill comes.
  await new Promise((r) => setTimeout(r, HELPER_TIMEOUT_MS + 100));
  assert.deepEqual(spawn.children[1].kills, ['SIGKILL'], 'the helper timer was cleared by stop()');
  // A stop before the probe answers: no answer is published, nothing spawned.
  const presence = fakePresence();
  const early = fakeSpawn({ probe: PROBE_OK });
  const s2 = startInterrupt({ root: '/x', presence, subscribeSSE: fakeStream(), spawn: early, processCommand: () => 'claude', platform: 'darwin', ppid: () => 1, log: () => {} });
  s2.stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([presence.values, early.calls.length], [[], 0]);
  assert.ok(!logs.includes('interrupt refused: helper-timeout'), 'the killed helper is not reported after stop');
});

// ── the real MCP server under the suite ─────────────────────────────────────

test('the real MCP server the suite launches answers interrupt null (its parent is the test runner) and exits when stdin closes', async (t) => {
  withTempHome(t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-int-mcp-')));
  fs.mkdirSync(path.join(root, '.web-chat'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = realSpawn(process.execPath, [MCP_BIN], {
    cwd: root,
    env: { ...process.env, WEB_CHAT_PORT: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.resume();
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));

  await waitUntil(() => /interrupt: off \(/.test(stderr), { timeout: 15_000, what: 'the probe answer on stderr' });
  assert.match(stderr, /\[claude-web-chat\] interrupt: off \(not-claude\)/);
  assert.doesNotMatch(stderr, /interrupt: tty|following control events/);
  const row = registry.readMcpEntries().find((e) => e.pid === child.pid);
  assert.ok(row, 'its presence row');
  assert.equal(row.interrupt, null);

  child.stdin.end();
  const { code, signal } = await exited;
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.equal(registry.readMcpEntries().find((e) => e.pid === child.pid), undefined);
});
