// lib/core/claude-cli runClaudeAsync: the daemon's asynchronous `claude` runner
// (spec §15.6; notes-B Q5 (a); B-confirm (5): spawn with stdin ignored, never
// execFile).
//
// What is load-bearing, and so tested:
//   * notFound for no `claude` at all, and for a bin that does not exist;
//   * ok with stdout for an exit of 0, an argv and no shell, from the cwd it is
//     given, with claudeEnv's environment (no CLAUDE_CODE_* or WEB_CHAT_*,
//     CLAUDE_CONFIG_DIR kept); ok false with the exit code and stderr otherwise;
//   * timedOut past timeoutMs, with the child killed;
//   * stdin is /dev/null: a child that reads it sees EOF at once and exits
//     well before the timeout (an execFile child would hold an open pipe);
//   * the event loop runs while the child does (a setInterval ticks);
//   * maxBytes: stdout past it fails the run, stderr past it is cut;
//   * an AbortSignal kills the child and answers aborted; it never rejects;
//   * runClaude, the synchronous runner, is still execFileSync's, and the
//     asynchronous one never calls execFile.
// Nothing here runs a real `claude`: the stand-ins are fakeBin scripts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withTempHome, fakeBin, waitUntil } = require('../test-support/helpers');
const { isPidAlive } = require('../lib/core/portfiles');
const cli = require('../lib/core/claude-cli');
const { runClaudeAsync, runClaude } = cli;

function scriptFile(t, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-claude-async-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'stub.js');
  fs.writeFileSync(file, code);
  return file;
}

function stub(t, code, env) {
  return fakeBin(t, { name: 'claude', script: scriptFile(t, code), env }).bin;
}

const ECHO = `
const fs = require('fs');
const rec = { argv: process.argv.slice(2), cwd: process.cwd(), env: process.env };
process.stdout.write(JSON.stringify(rec));
`;

test('no claude anywhere answers notFound, without a spawn', async (t) => {
  withTempHome(t);
  const r = await runClaudeAsync(['--version'], { env: { PATH: '' } });
  assert.equal(r.ok, false);
  assert.equal(r.notFound, true);
  assert.equal(r.timedOut, false);
  assert.match(r.stderr, /claude not found/);
});

test('a bin that does not exist answers notFound and never rejects', async () => {
  const r = await runClaudeAsync(['--version'], { bin: path.join(os.tmpdir(), 'wc-no-such-dir', 'claude') });
  assert.equal(r.ok, false);
  assert.equal(r.notFound, true);
  assert.equal(r.timedOut, false);
});

test('ok with stdout: the argv as given (no shell), the cwd, and the scrubbed environment', async (t) => {
  const bin = stub(t, ECHO);
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-claude-async-cwd-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: 'leak',
    WEB_CHAT_CHANNEL: '1',
    CLAUDE_CONFIG_DIR: '/tmp/wc-profile',
    KEEP_ME: 'yes',
  };
  const argv = ['-p', '/rename fork of n1.2', '$(touch nope)', 'a;b', '"q"'];
  const r = await runClaudeAsync(argv, { bin, cwd, env });
  assert.equal(r.ok, true, JSON.stringify(r));
  const rec = JSON.parse(r.stdout);
  assert.deepEqual(rec.argv, argv, 'every argument arrives verbatim: no shell');
  assert.equal(rec.cwd, cwd);
  assert.equal(rec.env.CLAUDE_CONFIG_DIR, '/tmp/wc-profile');
  assert.equal(rec.env.KEEP_ME, 'yes');
  for (const k of Object.keys(rec.env)) {
    assert.ok(!k.startsWith('CLAUDE_CODE_') && !k.startsWith('WEB_CHAT_'), `${k} is not inherited`);
  }
  assert.equal(fs.existsSync(path.join(cwd, 'nope')), false);
});

test('a non-zero exit answers ok false with its code and stderr', async (t) => {
  const bin = stub(t, "process.stderr.write('boom\\n'); process.stdout.write('half'); process.exit(3);");
  const r = await runClaudeAsync([], { bin });
  assert.deepEqual([r.ok, r.code, r.timedOut, r.notFound], [false, 3, false, false]);
  assert.match(r.stderr, /boom/);
  assert.equal(r.stdout, undefined, 'a failed run hands back no stdout');
});

test('past timeoutMs the run answers timedOut and the child is killed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-claude-async-pid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'pid');
  const bin = stub(t, `
require('fs').writeFileSync(process.env.PID_FILE, String(process.pid));
setTimeout(() => process.stdout.write('late'), 20000);
`, { PID_FILE: pidFile });
  const r = await runClaudeAsync([], { bin, timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.notFound, false);
  // A box so loaded that the stub never reached its first line still timed out.
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    await waitUntil(() => !isPidAlive(pid), { timeout: 5000, interval: 25 });
  }
});

test('a child that ignores SIGTERM is killed with SIGKILL a second later', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-claude-async-pid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'pid');
  const bin = stub(t, `
process.on('SIGTERM', () => {});
require('fs').writeFileSync(process.env.PID_FILE, String(process.pid));
setInterval(() => {}, 1000);
`, { PID_FILE: pidFile });
  // 1.5 s gives the stub time to install its handler before the SIGTERM; on a
  // box so loaded that it has not, the SIGTERM alone ends it (no pid file).
  const r = await runClaudeAsync([], { bin, timeoutMs: 1500 });
  assert.deepEqual([r.ok, r.timedOut], [false, true]);
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await waitUntil(() => !isPidAlive(pid), { timeout: 5000, interval: 25 });
  }
});

test('stdin is /dev/null: a child that reads it sees EOF at once and exits before the timeout', async (t) => {
  const bin = stub(t, `
const fs = require('fs');
const data = fs.readFileSync(0);
const st = fs.fstatSync(0);
process.stdout.write(JSON.stringify({ len: data.length, rdev: st.rdev, devnull: fs.statSync('/dev/null').rdev, chr: st.isCharacterDevice() }));
`);
  // An open stdin pipe would hold readFileSync(0) until this timeout fired.
  const r = await runClaudeAsync([], { bin, timeoutMs: 20_000 });
  assert.equal(r.ok, true, `the child did not wait on its stdin: ${JSON.stringify(r)}`);
  const seen = JSON.parse(r.stdout);
  assert.equal(seen.len, 0);
  assert.equal(seen.chr, true);
  assert.equal(seen.rdev, seen.devnull, 'fd 0 is /dev/null');
});

test('the event loop runs while the child does: a setInterval ticks during a 300 ms stub', async (t) => {
  const bin = stub(t, "setTimeout(() => process.stdout.write('done'), 300);");
  let ticks = 0;
  const iv = setInterval(() => { ticks += 1; }, 20);
  t.after(() => clearInterval(iv));
  const r = await runClaudeAsync([], { bin });
  clearInterval(iv);
  assert.equal(r.ok, true);
  assert.equal(r.stdout, 'done');
  assert.ok(ticks >= 1, `the loop ticked ${ticks} times while the child ran`);
});

test('maxBytes: stdout past it fails the run (the child killed); stderr past it is cut', async (t) => {
  const loud = stub(t, "process.stdout.write('x'.repeat(200000)); setTimeout(() => {}, 20000);");
  const r = await runClaudeAsync([], { bin: loud, maxBytes: 1000, timeoutMs: 20_000 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, false, 'the overflow ended it, not the timeout');
  assert.match(r.stderr, /output over 1000 bytes/);

  const chatty = stub(t, "process.stderr.write('e'.repeat(5000)); process.stdout.write('{}');");
  const ok = await runClaudeAsync([], { bin: chatty, maxBytes: 1000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.stdout, '{}');

  const failing = stub(t, "process.stderr.write('e'.repeat(5000)); process.exit(1);");
  const bad = await runClaudeAsync([], { bin: failing, maxBytes: 1000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.stderr.length, 1000);
});

test('an AbortSignal kills the child and answers aborted; an aborted signal spawns nothing', async (t) => {
  const bin = stub(t, "setTimeout(() => process.stdout.write('late'), 20000);");
  const ac = new AbortController();
  const p = runClaudeAsync([], { bin, signal: ac.signal, timeoutMs: 20_000 });
  setTimeout(() => ac.abort(), 100);
  const r = await p;
  assert.deepEqual([r.ok, r.aborted, r.timedOut], [false, true, false]);

  const pre = new AbortController();
  pre.abort();
  const r2 = await runClaudeAsync([], { bin, signal: pre.signal });
  assert.deepEqual([r2.ok, r2.aborted], [false, true]);
});

test('a bad argv answers ok false and never rejects', async (t) => {
  const bin = stub(t, ECHO);
  const r = await runClaudeAsync([1, 2], { bin });
  assert.equal(r.ok, false);
  assert.equal(r.notFound, false);
});

test('one synchronous runner and one asynchronous one: runClaude is execFileSync\'s, runClaudeAsync spawns', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core', 'claude-cli.js'), 'utf8');
  const sync = src.slice(src.indexOf('function runClaude('), src.indexOf('function runClaudeAsync('));
  const async = src.slice(src.indexOf('function runClaudeAsync('), src.indexOf('module.exports'));
  const body = (name) => (name === 'runClaude' ? sync : async);
  assert.match(body('runClaude'), /execFileSync\(exe, argv/);
  assert.match(body('runClaudeAsync'), /spawn\(exe, argv/);
  assert.doesNotMatch(body('runClaudeAsync'), /execFile/);
  assert.match(body('runClaudeAsync'), /stdio: \['ignore', 'pipe', 'pipe'\]/);
  assert.equal(require('../lib/setup/registration').defaultRunClaude, runClaude, 'registration still runs the synchronous runner');
  // A lib/core leaf: fs, path, child_process and ./paths only.
  const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(reqs, ['./paths', 'child_process', 'fs', 'path']);
});
