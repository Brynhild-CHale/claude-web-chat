// OPT-IN: drives a REAL pseudo-terminal and the REAL perl helper
// (WEB_CHAT_E2E_TTY=1). This is the one test that lets lib/mcp/interrupt.js
// actually inject a byte, so it never runs by default and no seat runs it — the
// MAINTAINER runs it, on macOS (or Linux), with perl and python3 on PATH:
//
//   WEB_CHAT_E2E_TTY=1 node --test --test-timeout=60000 \
//     --import ./test-support/sandbox.js test/mcp-interrupt-tty-e2e.test.js
//
// CI never sets the variable (test/e2e-gate.test.js holds that).
//
// How it proves the byte: python3's pty.fork() gives a child a fresh controlling
// terminal of which it is the session leader and the foreground process group —
// exactly the shape the helper checks for (POSIX::tcgetpgrp(/dev/tty) ==
// getpgrp()). The child execs a Node harness that puts that terminal into raw
// mode, reads every byte that arrives on it, then runs the real injector through
// startInterrupt (its parent check and ppid injected so the probe answers 'tty'
// and a synthetic event is addressed to it) and pushes two synthetic control
// events 1.5 s apart. The first injects one 0x1b, which comes back on the
// terminal's input; the second is refused by the rate guard, so nothing more
// arrives. The harness prints its tally on V34E2E lines, which the pty echoes
// back for this test to assert on.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { e2eGate } = require('../test-support/helpers');

const e2e = e2eGate(['tty']);
const REPO = path.join(__dirname, '..');
const INTERRUPT = path.join(REPO, 'lib', 'mcp', 'interrupt.js');

// The Node harness, run inside the pty. It needs the terminal to be its
// controlling one (pty.fork gives it that), reads it raw, and injects through
// the real module. It reports and exits 0 whatever it finds; the test judges.
const HARNESS = `
'use strict';
const { startInterrupt } = require(${JSON.stringify(INTERRUPT)});
const PPID = 4242;
const got = [];
try { process.stdin.setRawMode(true); } catch (e) { console.log('V34E2E error no-raw ' + e.message); process.exit(0); }
process.stdin.on('data', (b) => { for (const x of b) got.push(x); });

let push = null;
const stream = (opts) => { if (opts.onOpen) opts.onOpen(); push = opts.onEvent; return { close() {} }; };
let probeAnswer = 'pending';

const inj = startInterrupt({
  root: '/nonexistent/v34',
  presence: { setInterrupt(v) { probeAnswer = v; } },
  subscribeSSE: stream,
  processCommand: () => 'claude',       // the injected parent check: probe passes
  platform: process.platform,
  ppid: () => PPID,
  now: Date.now,
  log: (m) => console.log('V34E2E log ' + m),
});

const event = (over) => ({
  kind: 'control', op: 'interrupt', id: 'e2e-' + Math.random().toString(36).slice(2),
  conversation_id: 'c', session_id: 's', via: 'tty', target_pid: PPID,
  expires_at: Date.now() + 2000, ...over,
});
const hex = (a) => a.map((n) => n.toString(16).padStart(2, '0')).join(' ');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Wait for the async probe to answer and open the stream.
  for (let i = 0; i < 200 && push === null; i++) await wait(25);
  console.log('V34E2E probe ' + probeAnswer);
  if (push === null) { console.log('V34E2E error no-stream'); inj.stop(); process.exit(0); }

  push(event());                 // accepted → one 0x1b
  await wait(700);
  const first = got.slice();
  push(event());                 // within 1.5 s → rate-refused, nothing
  await wait(700);
  const second = got.slice(first.length);

  console.log('V34E2E first count=' + first.length + ' bytes=' + hex(first));
  console.log('V34E2E second count=' + second.length + ' bytes=' + hex(second));
  inj.stop();
  // Give stdout a tick to flush through the pty before the child exits.
  await wait(50);
  process.exit(0);
})();
`;

// The python3 driver: pty.fork(), exec Node on the harness in the child, drain
// the master in the parent, echo it, and exit with the child's status.
const DRIVER = `
import os, pty, sys, select
node = sys.argv[1]
harness = sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.execv(node, [node, '-e', open(harness).read()])
out = b''
while True:
    try:
        r, _, _ = select.select([fd], [], [], 15)
    except OSError:
        break
    if not r:
        break
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    out += data
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.stdout.flush()
sys.exit(0 if (os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0) else 2)
`;

function run(t, python3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-v34-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const driver = path.join(dir, 'driver.py');
  const harness = path.join(dir, 'harness.js');
  fs.writeFileSync(driver, DRIVER);
  fs.writeFileSync(harness, HARNESS);
  return new Promise((resolve) => {
    const child = spawn(python3, [driver, process.execPath, harness], {
      cwd: REPO,
      env: { ...process.env, PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { try { child.kill('SIGKILL'); } catch {} });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

const grep = (out, key) => out.split(/\r?\n/).find((l) => l.includes('V34E2E ' + key));

test('one 0x1b reaches a real pty reader, and a second event within 1.5 s delivers nothing', { skip: e2e.skip }, async (t) => {
  const { code, out, err } = await run(t, e2e.tty.python3);
  assert.equal(code, 0, `driver exited ${code}\n${out}\n${err}`);

  assert.ok(grep(out, 'probe tty'), `the probe answered tty on a real pty\n${out}`);

  const first = grep(out, 'first');
  assert.ok(first, `a first tally\n${out}`);
  assert.match(first, /count=1 bytes=1b\b/, `exactly one 0x1b from the accepted event\n${out}`);

  const second = grep(out, 'second');
  assert.ok(second, `a second tally\n${out}`);
  assert.match(second, /count=0 bytes=\s*$/, `the rate-refused second event injects nothing\n${out}`);
});
