// The HARNESS tripwire — a deliberately separate file from
// test/conventions.test.js, which scans lib/ + public/ and says in as many words
// that test/ and test-support/ are NOT scanned so the harness may use raw
// http/ws/fetch. That policy still holds for the general case: adding test/ to
// conventions.test.js's patterns would fire `http.request(` and `os.homedir()`
// across ~20 files at once and teach everyone to ignore the ratchet.
//
// What this file scans is much narrower — constructs that HAVE a single home and
// can therefore reach zero outside it:
//
//   the deadline loop        -> waitUntil
//   a poll helper definition -> waitUntil
//   an SSE stream opener     -> openSSE
//   booting the daemon       -> withServer
//   listening on an owner    -> withServer / withHub
//   a hand-written WS upgrade-> deafWs
//   a hardcoded tool count   -> test-support/doc-truth's mcpTools()
//
// The last two are a slightly different species from the first five: not a
// primitive the harness re-implements, but a TRUTH the harness re-states when a
// module already owns it. A test that hand-copies a number the code derives is
// the same defect as a test that hand-rolls a poll — it goes stale silently, and
// the stale copy passes.
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
      'test/channel-bridge.test.js': 8,
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
  {
    // Hand-writing the WebSocket upgrade over a raw socket. There is exactly one
    // legitimate reason to do it — you need a client that will NOT answer the
    // close frame, which the `ws` client always does — and exactly one home for
    // it. Two files carried the same twelve lines (grace-shutdown's
    // pinConnection ws branch and stop-cli's deafBrowser), which is copy #2 of a
    // construct whose whole subtlety is in the details it duplicated: the /101/
    // sniff before resolving, and destroying on t.after rather than at the end
    // of the body.
    name: 'Sec-WebSocket-Key:',
    home: 'test-support/helpers.js — `deafWs(t, port)`',
    what: 'hand-writing a WebSocket upgrade over a raw socket',
    roots: ROOTS,
    re: /Sec-WebSocket-Key:/g,
    baseline: {
      'test-support/helpers.js': 1,
    },
  },
  {
    // A number the code already derives. `assert.equal(tools.length, 23)` stood
    // in three tests beside doc-truth's mcpTools(), which reads lib/mcp/tools/ —
    // so adding a tool tripped three literals plus the doc count, and a literal
    // drifting from the directory is indistinguishable from the MCP server
    // dropping tools on the floor, which is the failure the assertion is for.
    // ZERO everywhere, including doc-truth: the engine counts a readdir, it does
    // not spell a number.
    name: 'tools.length, <n> (a hardcoded MCP tool count)',
    home: "test-support/doc-truth.js — `mcpTools()` (compare against `mcpTools().length`, or deepEqual the names)",
    what: 'restating the tool count the tools directory already answers',
    roots: ROOTS,
    re: /tools\.length\s*(?:,|===?|!==?|>=?|<=?)\s*\d/g,
    baseline: {},
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

// ── the wildcard bind ────────────────────────────────────────────────────────
//
// Not a second-copy pattern like the ones above — a correctness one — and it
// lives here because it is exactly as invisible in review.
//
// On macOS/BSD, `listen(0)` on the WILDCARD address can be handed an ephemeral
// port that another process already holds bound specifically to 127.0.0.1: the
// allocator consults the wildcard table only. The bind succeeds, so nothing
// looks wrong — but every client in this suite connects to 127.0.0.1 or
// localhost, and the kernel routes that to the MORE SPECIFIC listener. The test
// then talks to a stranger's server. Measured on one dev box carrying 92 such
// listeners: 17 collisions in 4000 wildcard binds, 0 in 4000 loopback binds.
//
// That is where the suite's intermittent
//   Parse Error: Expected HTTP/, RTSP/ or ICE/  (HPE_INVALID_CONSTANT, bytesParsed 0)
// came from — the bytes read were another server's protocol greeting (a MySQL
// wire-protocol banner, in the run that was finally captured). It surfaced on a
// different test every time, because which boot draws the unlucky port is pure
// chance, which is why it read as several unrelated flakes.
//
// Production binds LISTEN_HOST at every listen (lib/server/index.js,
// lib/hub/index.js). The harness must too.
const HOST_ARG = /^(['"`])(?:127\.0\.0\.1|localhost|::1)\1$|HOST/;

// Full-line comments only — this file's own prose quotes the banned call, and so
// does helpers.js's header. Trailing-comment stripping would have to understand
// `http://`, which is not worth the risk of eating a real call.
const stripLineComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

// The argument list of a call, split on TOP-LEVEL commas: an inline arrow
// callback is one argument, not three.
function callArgs(src, openIdx) {
  const out = [];
  let depth = 0;
  let arg = '';
  let quote = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { arg += c + src[++i]; continue; }
      if (c === quote) quote = null;
      arg += c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; arg += c; continue; }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      if (depth === 1) continue;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) { out.push(arg.trim()); return out; }
    } else if (c === ',' && depth === 1) { out.push(arg.trim()); arg = ''; continue; }
    arg += c;
  }
  return out;
}

test('harness: every server a test binds names LOOPBACK, never the wildcard', () => {
  const offenders = [];
  for (const r of ROOTS) {
    for (const f of walk(path.join(REPO_ROOT, r), [])) {
      if (path.resolve(f) === path.resolve(__filename)) continue;
      const src = stripLineComments(fs.readFileSync(f, 'utf8'));
      const re = /\.listen\s*\(/g;
      let m;
      while ((m = re.exec(src))) {
        const open = src.indexOf('(', m.index);
        const args = callArgs(src, open);
        if (args.length >= 2 && HOST_ARG.test(args[1])) continue;
        offenders.push(`${relPosix(f)}: .listen(${args.join(', ').replace(/\s+/g, ' ').slice(0, 60)})`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `a test bound the wildcard address. Pass the host: .listen(port, '127.0.0.1', cb) — or LISTEN_HOST from lib/core/cors — so the kernel cannot hand out a port another process already holds on loopback:\n  ${offenders.join('\n  ')}`);
});

// ── the shared-shell pseudo-test ─────────────────────────────────────────────
//
// A jsdom shell file boots ONCE (the ESM cache hands a second import the same
// already-initialised modules), and several of them do that boot inside a
// `test()` that asserts almost nothing and exists only to set up the tests
// below it. Three things follow, and all three were live in
// components-panel.test.js:
//
//   * `--test-name-pattern` cannot run a single case from the file. The pattern
//     filters out the boot too, so every remaining test runs against an unbooted
//     shell and fails. Measured before the fix: all 26 of components-panel's
//     cases failed when run alone.
//   * A test that mutates the shared fixture restores it at the END of its body,
//     which is precisely where a failing assertion never reaches. One broken
//     assertion in the cache test took the ⌘K palette test down with it — an
//     innocent bystander reported as a second failure, burying the real cause.
//   * Ordering becomes load-bearing invisibly: the palette case passed only
//     because the test above it happened to leave `deploy-board` in the cache.
//
// The fix is not a bigger fixture, it is `before` (boot, not counted as a test)
// + `beforeEach` (put the mutable state back BEFORE each test, so a throw cannot
// skip it) + `after` (teardown). components-panel.test.js is the worked example.
//
// Shrink-only, with a named baseline: seven shell files still do it, converting
// them is not this ratchet's job, and the baseline exists so the number can only
// go down.
const SHELL_BOOT = /^test\(\s*(['"`])(?:boot|set ?up)/gim;

// Gated on the file actually building a jsdom shell, so a genuine test ABOUT
// booting something else (lock-ttl's "boot clears a stale lock persisted in
// _meta.json") is not swept up by the name alone.
const SHELL_BOOT_BASELINE = {
  'test/graph-collapse-chrome.test.js': 1,
  'test/graph-nav-chrome.test.js': 1,
  'test/graph-view-chrome.test.js': 1,
  'test/leave-preview-chrome.test.js': 1,
  'test/service-trust-dismiss.test.js': 1,
  'test/shell-chrome.test.js': 1,
  'test/snapshot-applier.test.js': 1,
};

test('harness: a shared jsdom shell boots in a `before` hook, not in a test', () => {
  const actual = {};
  for (const f of walk(path.join(REPO_ROOT, 'test'), [])) {
    if (path.resolve(f) === path.resolve(__filename)) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes('new JSDOM(')) continue;
    const m = src.match(SHELL_BOOT);
    if (m && m.length) actual[relPosix(f)] = m.length;
  }

  for (const [file, n] of Object.entries(actual)) {
    const allowed = SHELL_BOOT_BASELINE[file] || 0;
    assert.ok(n <= allowed,
      `${file} boots its shared shell inside a test() (${n}, baseline ${allowed}). A boot registered as a test is skipped by --test-name-pattern, so no single case in the file can be run on its own. Move it to before(), reset the mutable fixture in beforeEach(), tear down in after() — see test/components-panel.test.js.`);
  }
  for (const [file, n] of Object.entries(SHELL_BOOT_BASELINE)) {
    const cur = actual[file] || 0;
    assert.ok(cur >= n,
      `STALE baseline: ${file} now has ${cur} shared-shell pseudo-tests but the baseline says ${n}. Lower or remove this entry in test/harness-conventions.test.js.`);
  }
});
