// The prompt engine's hidden read (lib/cli/prompt.js `secret()`), driven over a
// fake terminal: a PassThrough stdin that claims to be a TTY (and records raw
// mode) and a stdout that records every byte written to it. No pty needed —
// readline in terminal mode does its own echo through the output stream, so
// "nothing typed reached stdout" is exactly "nothing typed reached the screen".
//
// What must hold:
//   * the question is written; the typed characters are not; the value comes
//     back trimmed; the line ends (a newline after Enter), and stdin is left
//     out of raw mode.
//   * a secret asked after a visible question does not leak through the
//     visible interface's own echo, and the next visible question still works.
//   * with no one to ask (no TTY, CI, --no-input, --yes) it answers '' the way
//     line() does, says so, and never opens a readline.
//   * Ctrl+C rejects the read and still ends the line and leaves raw mode.
// The rest of the engine's non-interactive gate is covered in test/init.test.js.

const test = require('node:test');
const assert = require('node:assert');
const { PassThrough, Writable } = require('node:stream');

const { createPrompt } = require('../lib/cli/prompt');

function fakeTerminal() {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const raw = [];
  stdin.setRawMode = (on) => { raw.push(on); return stdin; };
  let written = '';
  const stdout = new Writable({ write(chunk, _enc, cb) { written += String(chunk); cb(); } });
  stdout.isTTY = true;
  stdout.columns = 80;
  const lines = [];
  return {
    stdin, stdout, raw,
    out: () => written,
    lines,
    log: (s) => lines.push(String(s)),
    // Type into the terminal once the question is up (readline is listening by
    // the time the prompt's synchronous part returns).
    type: (s) => setImmediate(() => stdin.write(s)),
  };
}

test('secret() writes the question, never the typed value, and returns it trimmed', async () => {
  const term = fakeTerminal();
  const p = createPrompt({ log: term.log, stdin: term.stdin, stdout: term.stdout, env: {} });
  assert.equal(p.interactive, true);

  const pending = p.secret('Paste the token:');
  term.type('  cf-SECRET-1234xyz  \r');
  assert.equal(await pending, 'cf-SECRET-1234xyz');
  p.close();

  assert.ok(term.out().includes('  Paste the token: '), 'the question is shown');
  assert.ok(!term.out().includes('SECRET'), `the typed value reached the terminal: ${JSON.stringify(term.out())}`);
  assert.ok(term.out().endsWith('\n'), 'Enter ends the line');
  assert.equal(term.raw[0], true, 'raw mode, so the tty does not echo either');
  assert.equal(term.raw[term.raw.length - 1], false, 'stdin is left out of raw mode');
  assert.deepEqual(term.lines, [], 'nothing about the read is logged');
});

test('secret() still edits like a line: backspace removes a character, and nothing is echoed', async () => {
  const term = fakeTerminal();
  const p = createPrompt({ log: term.log, stdin: term.stdin, stdout: term.stdout, env: {} });
  const pending = p.secret('Secret:');
  term.type('abcX\x7fdef\r');
  assert.equal(await pending, 'abcdef');
  p.close();
  assert.ok(!/abc|def/.test(term.out()), JSON.stringify(term.out()));
});

test('a secret after a visible question is not echoed by the visible interface, and the next question works', async () => {
  const term = fakeTerminal();
  const p = createPrompt({ log: term.log, stdin: term.stdin, stdout: term.stdout, env: {} });

  const host = p.line('Picker hostname:');
  term.type('wc.example.com\r');
  assert.equal(await host, 'wc.example.com');
  assert.ok(term.out().includes('wc.example.com'), 'a visible answer is echoed as before');

  const tok = p.secret('Paste the Cloudflare API token:');
  term.type('tok-AFTER-VISIBLE-9\r');
  assert.equal(await tok, 'tok-AFTER-VISIBLE-9');
  assert.ok(!term.out().includes('AFTER-VISIBLE'), `the open visible interface echoed the paste: ${JSON.stringify(term.out())}`);

  const email = p.line('Email:');
  term.type('me@example.com\r');
  assert.equal(await email, 'me@example.com');
  p.close();
  assert.ok(term.out().includes('me@example.com'), 'the visible prompt reopens after a secret');
  assert.equal(p.opened, 3, 'visible, hidden, visible again');
});

test('secret() with no one to ask answers "" like line(), says so, and opens no readline', async () => {
  const lines = [];
  const log = (s) => lines.push(String(s));
  const piped = createPrompt({ log, stdin: { isTTY: false }, env: {} });
  assert.equal(await piped.secret('Paste the Cloudflare API token:'), '');
  assert.equal(piped.opened, 0);
  assert.deepEqual(lines, ['  Paste the Cloudflare API token:', '  (no terminal — assuming nothing; pass --yes to accept, --no-input to silence)']);

  for (const opts of [{ noInput: true, env: {} }, { yes: true, env: {} }, { env: { CI: '1' } }]) {
    const p = createPrompt({ log: () => {}, stdin: { isTTY: true }, ...opts });
    assert.equal(p.interactive, false, JSON.stringify(opts));
    assert.equal(await p.secret('Secret:'), '');
    assert.equal(p.opened, 0, JSON.stringify(opts));
  }
});

test('Ctrl+C during secret() rejects, ends the line and leaves raw mode', async () => {
  const term = fakeTerminal();
  const p = createPrompt({ log: term.log, stdin: term.stdin, stdout: term.stdout, env: {} });
  const pending = p.secret('Secret:');
  term.type('half-TYPED\x03');
  await assert.rejects(pending);
  p.close();
  assert.ok(!term.out().includes('TYPED'), JSON.stringify(term.out()));
  assert.ok(term.out().endsWith('\n'));
  assert.equal(term.raw[term.raw.length - 1], false);
});

// A command with no --yes by design (`trust`: nothing non-interactive grants
// host execution) must not tell the user to pass one.
test('with yesFlag:false the non-interactive line points at a terminal, not at --yes', async () => {
  const lines = [];
  const p = createPrompt({ log: (s) => lines.push(s), stdin: { isTTY: false }, env: {}, yesFlag: false });
  assert.equal(await p.confirm('Approve it?', { def: false }), false);
  assert.deepEqual(lines, ['  Approve it? [y/N]', '  (no terminal — assuming no; run it in a terminal to answer)']);
  const ci = [];
  const q = createPrompt({ log: (s) => ci.push(s), stdin: { isTTY: true }, env: { CI: '1' }, yesFlag: false });
  assert.equal(await q.confirm('Approve it?', { def: false }), false);
  assert.equal(ci[1], '  (CI — assuming no; run it in a terminal to answer)');
  // Every other command keeps its flags in the line.
  const other = [];
  await createPrompt({ log: (s) => other.push(s), stdin: { isTTY: false }, env: {} }).confirm('Install?', { def: false });
  assert.equal(other[1], '  (no terminal — assuming no; pass --yes to accept, --no-input to silence)');
});
