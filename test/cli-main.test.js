// The CLI dispatcher's ONE userFacing catch — lib/cli/index.js main().
//
// The registration engine and the commands on it throw `{userFacing:true}`
// instead of calling process.exit inside a library: install's exit killed
// `init` mid-sequence, before its closing lines and before prompt.close().
// That half is pinned by the command tests. This file pins the OTHER half —
// that main() turns such a throw into one line on stderr plus a non-zero
// process.exitCode, rather than a stack trace or a hard exit — for both shapes
// a command can take: a synchronous throw and a rejected promise.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { main } = require('../lib/cli');
const { withTempHome } = require('../test-support/helpers');

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cli-main-')));
}

// main() takes only argv, so the command's cwd IS the process's. Restore both
// the cwd and process.exitCode: leaving the exit code set would fail this test
// file as a whole, which is precisely the signal we are asserting on.
function inDir(t, dir) {
  const prevCwd = process.cwd();
  const prevExit = process.exitCode;
  const errs = [];
  const prevErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  process.chdir(dir);
  t.after(() => {
    process.chdir(prevCwd);
    process.exitCode = prevExit;
    console.error = prevErr;
  });
  return errs;
}

test('main reports a SYNCHRONOUS userFacing throw as one line and an exit code', (t) => {
  withTempHome(t);
  const errs = inDir(t, tmpDir());

  main(['off']);   // no .web-chat/ here or above → resolveRoot refuses

  assert.equal(errs.length, 1, 'one line, not a stack trace');
  assert.match(errs[0], /no \.web-chat\/ in .* — run `claude-web-chat init` first/);
  assert.equal(process.exitCode, 1);
});

test('main reports a REJECTED async command the same way', async (t) => {
  withTempHome(t);
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{ not json');
  const errs = inDir(t, root);

  // `install` is async: its userFacing error arrives as a rejection, which a
  // bare `return commands[cmd](args)` would have left unhandled.
  await main(['install']);

  assert.equal(errs.length, 1);
  assert.match(errs[0], /error parsing .*settings\.json/);
  assert.equal(process.exitCode, 1);
});
