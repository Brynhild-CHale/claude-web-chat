// `claude-web-chat init` run as a CHILD of the managed bin — the connector's
// one way to set a folder up (contract 06 C-06.13, C-06.16; INIT@child-process).
//
//   runInit(root, flags, { stdio, deps }) → Promise<exit code>
//
// It spawns `<node> <CLI_BIN> init <root> ...flags` with the folder as its cwd,
// no shell, and the inherited environment. Two callers, one home:
//
//   * `connect offer` (lib/connector/folders.js) runs it INTERACTIVELY, with
//     `stdio: 'inherit'`, when the folder has no .web-chat/: offering is the
//     terminal consent for web-chat's writes into that folder, so the user
//     answers init's own questions there and then;
//   * the chats module (U720) runs it with the non-interactive flags on a root
//     it prepared (a clone or a space).
//
// Never in-process and never a require of lib/cli: lib/connector is an entry
// point and reaches no other entry point's internals (test/dependency-
// direction.test.js), and init's prompts, its process.exitCode and its writes
// belong to a process of their own. CLI_BIN is lib/util/daemon's — the same
// bin every detached child is started from.
//
// The answer is the child's exit code; a child killed by a signal, or one that
// cannot be spawned at all, answers 1 (never a throw: the caller turns a
// non-zero code into its own refusal). Nothing here logs: the argv is a path
// and init's flags, and the child's output is the caller's stdio.
//
// deps (tests): `spawn` (child_process.spawn's signature), `bin` (stands in
// for CLI_BIN), `execPath` (stands in for process.execPath), `env`.

const childProcess = require('child_process');
const { CLI_BIN } = require('../util/daemon');

function runInit(root, flags = [], { stdio = 'inherit', deps = {} } = {}) {
  if (typeof root !== 'string' || !root) return Promise.reject(new TypeError('runInit: root must be a path'));
  if (!Array.isArray(flags) || !flags.every((f) => typeof f === 'string')) {
    return Promise.reject(new TypeError('runInit: flags must be an array of strings'));
  }
  const spawn = deps.spawn || childProcess.spawn;
  const bin = deps.bin || CLI_BIN;
  const execPath = deps.execPath || process.execPath;
  const opts = { cwd: root, stdio, shell: false };
  if (deps.env) opts.env = deps.env;
  return new Promise((resolve) => {
    let settled = false;
    const done = (code) => { if (!settled) { settled = true; resolve(code); } };
    let child;
    try {
      child = spawn(execPath, [bin, 'init', root, ...flags], opts);
    } catch {
      done(1);
      return;
    }
    child.once('error', () => done(1));
    child.once('close', (code) => done(Number.isInteger(code) ? code : 1));
  });
}

module.exports = { runInit };
