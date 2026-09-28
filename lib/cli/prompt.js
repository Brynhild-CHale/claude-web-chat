// The ONE interactive-terminal prompt engine.
//
// Every CLI question in this package goes through here, so there is exactly one
// place that knows how to open a readline, how a default is printed, and — the
// part that matters — when NOT to ask at all. `test/conventions.test.js` ratchets
// the readline require to this file: a second prompt engine growing inside
// `trust`/`doctor`/`init` fails the build.
//
// The non-interactive gate lives INSIDE the engine, never at the call sites. A
// call site that has to remember `if (process.stdin.isTTY)` before every question
// is a call site that will eventually forget, and a CLI that blocks on a closed
// stdin in CI (or inside a hook, or on the far end of a pipe) hangs forever.
// Here: no TTY, `CI` set, `--no-input`, or `--yes` and the question resolves to
// its printed default immediately, having said out loud what it assumed and which
// flag would have changed the answer. A piped transcript stays honest.
//
// The readline interface is created LAZILY and kept for the next question, so a
// non-interactive run never opens one — nothing to leak, nothing holding the
// event loop open. `close()` belongs in a `finally`.
//
// `secret()` is `line()` for a pasted credential: the characters typed never
// reach the terminal, so a token does not sit in the scrollback or a screen
// recording. It reads through its own short-lived interface in terminal (raw)
// mode whose output goes nowhere — and closes the visible one first, because an
// open interface on the same stdin keeps its own keypress listener and would
// echo every character of the paste itself. The next question reopens it.

const { Writable } = require('node:stream');

const DEFAULT_LOG = (s) => console.log(s);

// Where a hidden read's own echo goes: nowhere.
function mutedOutput() {
  return new Writable({ write(_chunk, _enc, cb) { cb(); } });
}

function normalize(answer) {
  const a = String(answer == null ? '' : answer).trim().toLowerCase();
  if (a === '') return null;                       // empty → take the default
  if (a === 'y' || a === 'yes') return true;
  if (a === 'n' || a === 'no') return false;
  return undefined;                                // unparseable → ask again
}

// opts: { log, noInput, yes, stdin, stdout }
function createPrompt(opts = {}) {
  const log = opts.log || DEFAULT_LOG;
  const stdin = opts.stdin || process.stdin;
  const stdout = opts.stdout || process.stdout;
  const noInput = opts.noInput === true;
  const yes = opts.yes === true;
  const ci = Boolean(opts.env ? opts.env.CI : process.env.CI);
  const isTty = Boolean(stdin && stdin.isTTY);
  const interactive = isTty && !ci && !noInput && !yes;

  let rl = null;
  let opened = 0;

  function open(output, extra) {
    // The single readline require in lib/ (conventions ratchet). Lazy so a
    // non-interactive run never constructs one.
    const readline = require('node:readline/promises');
    opened++;
    return readline.createInterface({ input: stdin, output, ...extra });
  }

  function iface() {
    if (!rl) rl = open(stdout);
    return rl;
  }

  function why() {
    if (yes) return '--yes';
    if (noInput) return '--no-input';
    if (ci) return 'CI';
    return 'no terminal';
  }

  // One line naming the assumption and the flag that would change it. The
  // "pass --yes / --no-input" tail is only useful when the user did not already
  // pass one of them.
  function assumed(word) {
    const reason = why();
    const tail = (reason === 'no terminal' || reason === 'CI')
      ? '; pass --yes to accept, --no-input to silence'
      : '';
    log(`  (${reason} — assuming ${word}${tail})`);
  }

  async function confirm(question, { def = false } = {}) {
    const q = `${question} ${def ? '[Y/n]' : '[y/N]'}`;
    if (!interactive) {
      log(`  ${q}`);
      assumed(def ? 'yes' : 'no');
      return def;
    }
    for (;;) {
      const raw = await iface().question(`  ${q} `);
      const v = normalize(raw);
      if (v === null) return def;
      if (v === true || v === false) return v;
      log('  please answer y or n.');
    }
  }

  // No one to ask a free-text question: print it, say so, answer ''.
  function unasked(question) {
    log(`  ${question}`);
    assumed('nothing');
    return '';
  }

  async function line(question) {
    if (!interactive) return unasked(question);
    const raw = await iface().question(`  ${question} `);
    return String(raw == null ? '' : raw).trim();
  }

  // A line read without echo. Same gate and same answer as line() when there
  // is no one to ask (a piped or CI run gets '' and says so — nothing to mask).
  async function secret(question) {
    if (!interactive) return unasked(question);
    close();
    stdout.write(`  ${question} `);
    // terminal:true puts stdin in raw mode, so the tty does not echo either;
    // historySize:0 keeps the value out of the interface's history.
    const hidden = open(mutedOutput(), { terminal: true, historySize: 0 });
    try {
      const raw = await hidden.question('');
      return String(raw == null ? '' : raw).trim();
    } finally {
      try { hidden.close(); } catch {}
      stdout.write('\n');
    }
  }

  function close() {
    if (!rl) return;
    try { rl.close(); } catch {}
    rl = null;
  }

  return {
    confirm,
    line,
    secret,
    close,
    interactive,
    // Test seam: proves a non-interactive run never constructed a readline.
    get opened() { return opened; },
  };
}

// Convenience delegates over a lazily-created default engine, for call sites
// with no flags of their own.
let fallback = null;
function def() { return (fallback = fallback || createPrompt()); }

module.exports = {
  createPrompt,
  confirm: (q, o) => def().confirm(q, o),
  line: (q) => def().line(q),
  secret: (q) => def().secret(q),
  close: () => { if (fallback) fallback.close(); },
};
