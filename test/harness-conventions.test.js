// The HARNESS tripwire — a deliberately separate file from
// test/conventions.test.js, which scans lib/ + public/ and says in as many words
// that test/ and test-support/ are NOT scanned so the harness may use raw
// http/ws/fetch. That policy still holds for the general case: adding test/ to
// conventions.test.js's patterns would fire `http.request(` and `os.homedir()`
// across ~20 files at once and teach everyone to ignore the ratchet.
//
// What this file scans is much narrower — five constructs that HAVE a single
// home in test-support/helpers.js and can therefore reach zero outside it:
//
//   the deadline loop        -> waitUntil
//   a poll helper definition -> waitUntil
//   an SSE stream opener     -> openSSE
//   booting the daemon       -> withServer
//   listening on an owner    -> withServer / withHub
//
// Each of those had between two and nine copies before the harness grew the
// engine, and the copies were not merely redundant: three SSE openers could not
// report failure at all (a transport hiccup hung the whole run), the eight
// deadline polls disagreed on whether a timeout throws or returns false, and the
// hand-booted servers stopped at the END of the test body, so a failed assertion
// leaked a listening handle.
//
// Explicitly NOT ratcheted here, and this is a decision rather than an
// oversight:
//
//   * fixed `setTimeout` sleeps. ~89 of them across the suite, and a good number
//     ARE the assertion ("give an erroneous second wake a chance to arrive") —
//     there is no predicate to poll for a non-event. A count can't tell those
//     apart from the lazy ones.
//   * `process.env.HOME =`. Per-test sandboxes (client-respawn, install) and
//     subprocess `env:` objects are legitimate, and test-support/sandbox is a
//     floor under the process, not a replacement for per-test isolation.
//
// Both would be permanent tables of numbers that are "correct forever", which is
// the weaker contract this file's siblings deliberately avoid.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOTS = ['test', 'test-support'];

const PATTERNS = [
  {
    // The deadline loop itself. At ZERO everywhere: helpers' waitUntil is the
    // only poll left, and it is not spelled this way. Nine files carried one
    // (hub.test.js twice), under four names and three incompatible timeout
    // contracts — throw-with-a-label vs return-false vs re-check-then-return,
    // boolean vs first-truthy-value, one calling its predicate synchronously —
    // which is why ~17 `assert.ok(await waitUntil(…))` call sites could not
    // simply be pointed at any one of them.
    name: 'while (Date.now()',
    home: 'test-support/helpers.js — `waitUntil(pred, { timeout, interval, what })`',
    what: 'a hand-rolled deadline poll loop',
    roots: ROOTS,
    re: /while\s*\(\s*Date\.now\(\)/g,
    baseline: {},
  },
  {
    // The DECLARATION spelling, which catches a copy written as a `for(;;)` or a
    // recursive setTimeout that the loop pattern above would miss. Only function
    // declarations match: a file that binds its own budget onto the engine
    // (`const waitUntil = (fn, o) => harnessWaitUntil(fn, {timeout: 4000, ...o})`,
    // as services-supervisor and git-dashboard-service do for child processes)
    // is an alias, not an implementation, and is fine.
    name: 'function waitUntil / waitFor / until (',
    home: 'test-support/helpers.js — `waitUntil`',
    what: 'defining a second deadline-poll helper',
    roots: ROOTS,
    re: /function\s+(?:waitUntil|waitFor|until)\s*\(/g,
    baseline: {
      'test-support/helpers.js': 1,
    },
  },
  {
    // Opening an event stream. The three private openers all passed `onOpen`
    // alone, so every failure path in lib/client's subscribeSSE — non-200, a
    // request 'error', a close — left the promise pending FOREVER. openSSE
    // rejects on all three plus a deadline.
    name: 'subscribeSSE(',
    home: 'test-support/helpers.js — `openSSE(port, { kinds, since, onEvent, timeout, awaitChannel })`',
    what: 'opening an SSE stream in a test',
    roots: ROOTS,
    re: /subscribeSSE\(/g,
    baseline: {
      'test-support/helpers.js': 1,
      // NOT test-side openers. These build the fake/wrapping `client` object
      // that is INJECTED INTO the channel bridge under test — the bridge does
      // the subscribing, and the point of the wrapper is to expose an onOpen
      // promise so the test can emit a wake only once the bridge is listening.
      // openSSE cannot stand in for a dependency of the code under test.
      'test/channel-ack.test.js': 2,
      'test/channel-bridge.test.js': 7,
    },
  },
  {
    // Booting the daemon by hand. withServer exists because teardown has to be
    // on t.after: three files stopped their servers at the END of the test body,
    // so a failing assertion leaked the port and the handle, and (with no
    // --test-force-exit, deliberately) a red test became a hung run.
    name: 'createServer({ root',
    home: 'test-support/helpers.js — `withServer(t, opts, fn)`',
    what: 'booting the web-chat server in a test',
    roots: ROOTS,
    re: /createServer\(\{\s*root/g,
    baseline: {
      // Both are template STRINGS, not calls: the source of a real daemon run as
      // a CHILD PROCESS. Neither can go through withServer, because the code
      // under test is a production gracefulShutdown / portfile release that
      // calls process.exit — it has to be a process that can actually exit.
      'test/daemon-portfile-ownership.test.js': 1,
      'test/stop-cli.test.js': 1,
    },
  },
  {
    // `.server.listen(` is the fingerprint of hand-rolling the boot of an OWNER
    // object (what createServer and createHub return), as opposed to the plain
    // http/net stubs several tests legitimately stand up. Four hub boots and
    // three server boots used to spell it; the two remaining are the engine.
    name: '.server.listen(',
    home: 'test-support/helpers.js — `withServer` (daemon) / `withHub` (capture hub)',
    what: 'listening on a server/hub owner object by hand',
    roots: ROOTS,
    re: /\.server\.listen\(/g,
    baseline: {
      // withServer's listen(0) and withHub's listen(port, LISTEN_HOST).
      'test-support/helpers.js': 2,
    },
  },
];

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile() && e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const relPosix = (abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

function census({ roots, re }) {
  const map = {};
  for (const r of roots) {
    const abs = path.join(REPO_ROOT, r);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs, [])) {
      // This file quotes every construct it bans; counting itself would make the
      // baseline a table of its own comments.
      if (path.resolve(f) === path.resolve(__filename)) continue;
      const m = fs.readFileSync(f, 'utf8').match(re);
      if (m && m.length) map[relPosix(f)] = m.length;
    }
  }
  return map;
}

for (const p of PATTERNS) {
  test(`harness: \`${p.name}\` (${p.what}) is confined to the harness`, () => {
    const actual = census(p);

    // (a) tripwire — no new or grown occurrences.
    for (const [file, n] of Object.entries(actual)) {
      const allowed = p.baseline[file] || 0;
      assert.ok(
        n <= allowed,
        `${file} has ${n} \`${p.name}\` (baseline ${allowed}). Copy N+1 of a harness primitive — use ${p.home}. If it is genuinely unavoidable, raise the baseline in test/harness-conventions.test.js with a justifying comment.`,
      );
    }

    // (b) ratchet — the baseline may only shrink.
    for (const [file, n] of Object.entries(p.baseline)) {
      const cur = actual[file] || 0;
      assert.ok(
        cur >= n,
        `STALE baseline: ${file} now has ${cur} \`${p.name}\` but the baseline says ${n}. Lower or remove this entry in test/harness-conventions.test.js.`,
      );
    }
  });
}
