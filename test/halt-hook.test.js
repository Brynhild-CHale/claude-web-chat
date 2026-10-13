// lib/hooks/claude-web-chat-hook-halt.sh — "Stop after this step" (spec §1.2,
// §15.2). Registered synchronously on PreToolUse, PostToolUse and PostToolBatch,
// so it runs on every tool call of every session in an installed project. Its
// contract:
//
//   * nothing at all — no output, exit 0 — unless CLAUDE_CODE_SESSION_ID is set
//     and $HOME/.web-chat/halt/<that id> holds an epoch-seconds expiry later
//     than now;
//   * then exactly §1.2's JSON: `pre` denies the next tool and stops the turn,
//     `post` and `batch` stop it;
//   * it never errors, whatever arrives on stdin, and it is cheap: the no-flag
//     case is the hot path.
//
// Run through `sh`, as the registered command runs it, with an explicit
// environment: the developer's own Claude Code session sets
// CLAUDE_CODE_SESSION_ID in the environment this suite inherits, and the script
// must see only what each case gives it. Where dash is installed (macOS ships
// it), every case runs under it too: a strict POSIX shell, so a bashism fails
// here and not first on a Linux machine whose /bin/sh is dash.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { userPaths, PACKAGE_ROOT } = require('../lib/core/paths');
const { withTempHome } = require('../test-support/helpers');

const SCRIPT = path.join(PACKAGE_ROOT, 'lib', 'hooks', 'claude-web-chat-hook-halt.sh');
const PRE = '{"continue":false,"stopReason":"Stopped from the web-chat page","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The user stopped this turn from the web-chat page."}}';
const POST = '{"continue":false,"stopReason":"Stopped from the web-chat page"}';
const SID = '3f2b8c1e-0d4a-4c6e-9b7f-1a2b3c4d5e6f';
const SHELLS = ['sh', ...['/bin/dash'].filter((p) => fs.existsSync(p))];
const nowS = () => Math.floor(Date.now() / 1000);

function flagPath(sid = SID) {
  return path.join(userPaths().root, 'halt', sid);
}

function writeFlag(content, sid = SID) {
  fs.mkdirSync(path.dirname(flagPath(sid)), { recursive: true });
  fs.writeFileSync(flagPath(sid), content);
}

// One fire of the hook. `sid: null` leaves CLAUDE_CODE_SESSION_ID unset.
function fire(home, event, { sid = SID, input = '{"hook_event_name":"PreToolUse"}', shell = 'sh' } = {}) {
  const env = { PATH: process.env.PATH, HOME: home };
  if (sid !== null) env.CLAUDE_CODE_SESSION_ID = sid;
  const args = event === null ? [SCRIPT] : [SCRIPT, event];
  return spawnSync(shell, args, { env, input, encoding: 'utf8', timeout: 10000 });
}

// The test runner's budget for this file (`--test-timeout`, which `npm test`
// sets and the runner hands each file's process in its execArgv; 0 means none).
// A large-payload fire gets half of it as its own deadline, so a stalled child
// is killed and named before the runner's timeout cancels the test.
const TEST_BUDGET_MS = (() => {
  const flag = [...process.execArgv].reverse().find((a) => a.startsWith('--test-timeout='));
  const ms = flag ? Number(flag.slice('--test-timeout='.length)) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : 60000;
})();

// One fire with a large payload, written the way Claude Code writes a hook's
// stdin: an async spawn whose parent writes the payload, ends the stream and
// then closes it. NOT spawnSync: spawnSync ends its input with shutdown(SHUT_WR)
// and keeps the socket open until the child exits, and on macOS that EOF is
// sometimes never delivered to a reader already blocked in read() — the child's
// `cat` has every byte and waits for an EOF that only a close() brings, so the
// fire sat out its whole timeout (about 1 in 800 fires under a loaded machine,
// with the hook script and with a bare `exec cat`; never once the writer closes).
// Same contract as fire(): resolves {status, signal, stdout, stderr, error}.
function fireLarge(home, event, { sid = SID, input, shell = 'sh' } = {}) {
  const env = { PATH: process.env.PATH, HOME: home };
  if (sid !== null) env.CLAUDE_CODE_SESSION_ID = sid;
  return new Promise((resolve) => {
    const child = spawn(shell, [SCRIPT, event], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let error;
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (e) => { error = error || e; });
    // An EPIPE here is the writer meeting a hook that left without reading. It
    // reaches end()'s callback (and 'error', unless the destroy below beat it).
    child.stdin.on('error', (e) => { error = error || e; });
    child.stdin.end(input, (e) => {
      if (e) error = error || e;
      child.stdin.destroy();
    });
    const deadline = setTimeout(() => {
      error = error || Object.assign(new Error(`${shell} ${event}: no exit within ${TEST_BUDGET_MS / 2} ms`), { code: 'ETIMEDOUT' });
      child.kill('SIGKILL');
    }, TEST_BUDGET_MS / 2);
    child.on('close', (status, signal) => {
      clearTimeout(deadline);
      resolve({ status, signal, stdout, stderr, error });
    });
  });
}

function assertSilent(r, label) {
  assert.equal(r.error, undefined, `${label}: no spawn error (${r.error && r.error.code})`);
  assert.equal(r.status, 0, `${label}: exit 0`);
  assert.equal(r.stdout, '', `${label}: prints nothing`);
  assert.equal(r.stderr, '', `${label}: says nothing on stderr`);
}

test('the flag lives at $HOME/.web-chat/halt/<session id>', (t) => {
  const home = withTempHome(t);
  assert.equal(flagPath(), path.join(home, '.web-chat', 'halt', SID));
});

// lib/core/paths gains userPaths().haltFlag(session_id) in this release (U01),
// and the daemon's control domain writes the flag through it (U81). Until U01
// is on this branch the cross-check is SKIPPED, and says so in the run's
// output, rather than passing without asserting anything; it runs as soon as
// the accessor exists. The tranche's integration pass (U22a) drops the
// condition, so that a renamed accessor fails here instead of skipping.
const HALT_FLAG_PENDING = typeof userPaths().haltFlag === 'function'
  ? false
  : 'userPaths().haltFlag arrives with U01 (wc085/core-paths); U22a makes this check unconditional';

test('the script obeys the flag the path engine names, and the ids it refuses have none', { skip: HALT_FLAG_PENDING }, (t) => {
  const home = withTempHome(t);
  const { haltFlag } = userPaths();
  assert.equal(haltFlag(SID), flagPath(), 'one file for the script and the engine');
  fs.mkdirSync(path.dirname(haltFlag(SID)), { recursive: true });
  fs.writeFileSync(haltFlag(SID), `${nowS() + 600}\n`);
  for (const shell of SHELLS) assert.equal(fire(home, 'pre', { shell }).stdout, `${PRE}\n`, `${shell}: a flag written where the engine says`);
  // Every id the script refuses to look up, the engine names no flag for.
  for (const sid of ['', '../escape', '.', '..', 'a/b', 'x y', 'a'.repeat(101)]) {
    assert.equal(haltFlag(sid), null, `no flag for ${JSON.stringify(sid)}`);
  }
});

test('no CLAUDE_CODE_SESSION_ID: nothing, even with a live flag on disk', (t) => {
  const home = withTempHome(t);
  writeFlag(`${nowS() + 600}\n`);
  for (const shell of SHELLS) {
    for (const ev of ['pre', 'post', 'batch']) assertSilent(fire(home, ev, { sid: null, shell }), `${shell} ${ev}`);
    assertSilent(fire(home, 'pre', { sid: '', shell }), `${shell} empty id`);
  }
});

test('no flag: nothing', (t) => {
  const home = withTempHome(t);
  for (const shell of SHELLS) {
    for (const ev of ['pre', 'post', 'batch']) assertSilent(fire(home, ev, { shell }), `${shell} ${ev}`);
  }
});

test('an expired flag, or one that expires this second, is nothing', (t) => {
  const home = withTempHome(t);
  for (const shell of SHELLS) {
    writeFlag(`${nowS() - 1}\n`);
    assertSilent(fire(home, 'pre', { shell }), `${shell} expired`);
    // "later than date +%s": an expiry equal to now has already run out.
    writeFlag(`${nowS()}\n`);
    assertSilent(fire(home, 'post', { shell }), `${shell} now`);
  }
});

test('a malformed flag is nothing', (t) => {
  const home = withTempHome(t);
  const live = nowS() + 600;
  const bad = ['', '\n', 'soon\n', `${live}x\n`, `-${live}\n`, '1.79e9\n', `${live}.5\n`, '99999999999999999999\n', `0x${live.toString(16)}\n`];
  for (const shell of SHELLS) {
    for (const content of bad) {
      writeFlag(content);
      assertSilent(fire(home, 'pre', { shell }), `${shell} ${JSON.stringify(content)}`);
    }
    // A directory where the flag should be.
    fs.rmSync(flagPath(), { force: true });
    fs.mkdirSync(flagPath());
    assertSilent(fire(home, 'pre', { shell }), `${shell} a directory`);
    fs.rmSync(flagPath(), { recursive: true, force: true });
  }
});

test('a flag the hook cannot read is nothing, and says nothing', { skip: process.getuid && process.getuid() === 0 ? 'root reads any file' : false }, (t) => {
  const home = withTempHome(t);
  writeFlag(`${nowS() + 600}\n`);
  fs.chmodSync(flagPath(), 0o000);
  t.after(() => { try { fs.chmodSync(flagPath(), 0o600); } catch {} });
  for (const shell of SHELLS) assertSilent(fire(home, 'pre', { shell }), shell);
});

test('a live flag: exactly the pre JSON on PreToolUse, exactly the post JSON on PostToolUse and PostToolBatch', (t) => {
  const home = withTempHome(t);
  writeFlag(`${nowS() + 600}\n`);
  for (const shell of SHELLS) {
    const pre = fire(home, 'pre', { shell });
    assert.equal(pre.status, 0);
    assert.equal(pre.stderr, '');
    assert.equal(pre.stdout, `${PRE}\n`, `${shell}: the deny, byte for byte`);
    assert.deepStrictEqual(JSON.parse(pre.stdout), {
      continue: false,
      stopReason: 'Stopped from the web-chat page',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'The user stopped this turn from the web-chat page.',
      },
    });
    for (const ev of ['post', 'batch']) {
      const r = fire(home, ev, { shell });
      assert.equal(r.status, 0);
      assert.equal(r.stderr, '');
      assert.equal(r.stdout, `${POST}\n`, `${shell} ${ev}: continue:false, byte for byte`);
      assert.deepStrictEqual(JSON.parse(r.stdout), { continue: false, stopReason: 'Stopped from the web-chat page' });
    }
  }
  // The expiry may carry the whitespace a writer adds around it.
  writeFlag(`  ${nowS() + 600}  \n`);
  assert.equal(fire(home, 'post').stdout, `${POST}\n`);
});

test('a live flag stops only its own session, and only for the three registered events', (t) => {
  const home = withTempHome(t);
  writeFlag(`${nowS() + 600}\n`);
  for (const shell of SHELLS) {
    assertSilent(fire(home, 'pre', { sid: '0a1b2c3d-0000-4000-8000-000000000000', shell }), `${shell} another session`);
    for (const ev of [null, '', 'failure', 'PRE', 'pre post']) assertSilent(fire(home, ev, { shell }), `${shell} event ${JSON.stringify(ev)}`);
  }
});

test('a session id that could leave the halt directory is never followed', (t) => {
  const home = withTempHome(t);
  // A live flag one level up, where `../escape` would land.
  fs.mkdirSync(path.join(userPaths().root, 'halt'), { recursive: true });
  fs.writeFileSync(path.join(userPaths().root, 'escape'), `${nowS() + 600}\n`);
  fs.writeFileSync(path.join(home, 'top'), `${nowS() + 600}\n`);
  for (const shell of SHELLS) {
    for (const sid of ['../escape', '../../top', '.', '..', 'a/b', 'x y', '$(touch pwned)']) {
      assertSilent(fire(home, 'pre', { sid, shell }), `${shell} ${JSON.stringify(sid)}`);
    }
  }
  assert.equal(fs.existsSync(path.join(home, 'pwned')), false);
});

test('a session id longer than the path engine allows has no flag, even if a file has its name', (t) => {
  const home = withTempHome(t);
  const long = 'a'.repeat(101);            // isSafeId: 1–100 of [A-Za-z0-9_-]
  writeFlag(`${nowS() + 600}\n`, long);
  writeFlag(`${nowS() + 600}\n`, long.slice(1));
  for (const shell of SHELLS) {
    assertSilent(fire(home, 'pre', { sid: long, shell }), `${shell} 101 characters`);
    assert.equal(fire(home, 'pre', { sid: long.slice(1), shell }).stdout, `${PRE}\n`, `${shell}: 100 is still an id`);
  }
});

test('a 1 MB payload on stdin causes no error, with or without a flag', async (t) => {
  const home = withTempHome(t);
  const big = JSON.stringify({ hook_event_name: 'PostToolUse', tool_response: { stdout: 'x'.repeat(1 << 20) } });
  for (const shell of SHELLS) {
    // Claude Code writes the whole payload; a hook that left without reading it
    // would hand the writer an EPIPE.
    assertSilent(await fireLarge(home, 'post', { input: big, shell }), `${shell} no flag`);
    writeFlag(`${nowS() + 600}\n`);
    const r = await fireLarge(home, 'post', { input: big, shell });
    assert.equal(r.error, undefined, `${shell}: no EPIPE for the writer`);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, `${POST}\n`);
    fs.rmSync(flagPath(), { force: true });
  }
});

test('it writes nothing: HOME holds the same files before and after', (t) => {
  const home = withTempHome(t);
  writeFlag(`${nowS() + 600}\n`);
  const list = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? [p, ...list(p)] : [p];
  }).sort();
  const before = list(home);
  const flag = fs.readFileSync(flagPath(), 'utf8');
  for (const ev of ['pre', 'post', 'batch']) fire(home, ev);
  fire(home, 'pre', { sid: null });
  assert.deepStrictEqual(list(home), before);
  assert.equal(fs.readFileSync(flagPath(), 'utf8'), flag, 'the flag is the daemon\'s to remove');
});

// The cost of the hot path: every tool call runs it up to three times. Asserted
// only under WEB_CHAT_PERF=1 (a loaded machine stalls any process for longer);
// the default run logs it.
test('the no-flag case is cheap (asserted under WEB_CHAT_PERF=1: at most 10 ms)', (t) => {
  const home = withTempHome(t);
  const times = [];
  for (let i = 0; i < 21; i++) {
    const t0 = process.hrtime.bigint();
    const r = fire(home, 'pre');
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assertSilent(r, `run ${i}`);
  }
  times.sort((a, b) => a - b);
  const median = times[10];
  t.diagnostic(`no-flag fire, spawn included: median ${median.toFixed(2)} ms, max ${times[20].toFixed(2)} ms`);
  if (process.env.WEB_CHAT_PERF === '1') assert.ok(median <= 10, `median ${median.toFixed(2)} ms > 10 ms`);
});
