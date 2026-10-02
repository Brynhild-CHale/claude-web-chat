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
const { spawnSync } = require('child_process');

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

function assertSilent(r, label) {
  assert.equal(r.error, undefined, `${label}: no spawn error (${r.error && r.error.code})`);
  assert.equal(r.status, 0, `${label}: exit 0`);
  assert.equal(r.stdout, '', `${label}: prints nothing`);
  assert.equal(r.stderr, '', `${label}: says nothing on stderr`);
}

test('the flag lives where the path engine says the halt flag lives', (t) => {
  const home = withTempHome(t);
  assert.equal(flagPath(), path.join(home, '.web-chat', 'halt', SID));
  // lib/core/paths gains userPaths().haltFlag(session_id) in the same release;
  // once it exists, the script and the engine must name one file.
  const { haltFlag } = userPaths();
  if (typeof haltFlag === 'function') assert.equal(haltFlag(SID), flagPath());
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

test('a 1 MB payload on stdin causes no error, with or without a flag', (t) => {
  const home = withTempHome(t);
  const big = JSON.stringify({ hook_event_name: 'PostToolUse', tool_response: { stdout: 'x'.repeat(1 << 20) } });
  for (const shell of SHELLS) {
    // Claude Code writes the whole payload; a hook that left without reading it
    // would hand the writer an EPIPE.
    assertSilent(fire(home, 'post', { input: big, shell }), `${shell} no flag`);
    writeFlag(`${nowS() + 600}\n`);
    const r = fire(home, 'post', { input: big, shell });
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
