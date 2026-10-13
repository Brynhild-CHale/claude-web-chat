// `claude-web-chat open` names the managed files a project is behind on (H-6).
//
// `open` is the command a user runs in every project. A project they did not
// run `update` in keeps the rules file, the /web-chat command and the skills an
// older build shipped, and the only places that said so were `status` (which
// nobody runs unprompted) and the MCP server's stderr (which nobody sees). So
// `open` reads the registration model once — the same pure read `status` does —
// and prints one line naming the files `install` would refresh.
//
// These tests use a REAL project directory and the real managed-file reconcile,
// so a change to what counts as "behind" shows up here; only the daemon and the
// browser are stubbed. (The target/hint tests for `open` live in
// test/extensions.test.js.)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const open = require('../lib/cli/commands/open');
const { staleManagedLine } = open;
const {
  MANAGED_FILES, reconcileManagedFiles, hashContent, readBaselines, writeBaselines,
} = require('../lib/update/managed-files');
const { packageVersion } = require('../lib/core/versions');

function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-open-')));
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// A project whose managed files are exactly what this build ships.
function freshProject(t) {
  const root = project(t);
  reconcileManagedFiles(root);
  return root;
}

// Make one managed file look as an OLDER build shipped it, untouched since:
// the file and its recorded baseline agree, and the template has moved on.
function asOlderBuildShipped(root, dest) {
  const old = '# web-chat (an older build)\n';
  fs.writeFileSync(path.join(root, dest), old);
  const b = readBaselines(root);
  b[dest] = hashContent(old);
  writeBaselines(root, b);
}

function deps(root, overrides = {}) {
  const calls = { browsed: [], logs: [], errs: [], exits: [] };
  const d = {
    root,
    launchBrowser: (u) => calls.browsed.push(u),
    log: (m) => calls.logs.push(String(m)),
    errlog: (m) => calls.errs.push(String(m)),
    exit: (c) => calls.exits.push(c),
    // The one adoption seam: this project's live daemon, as lib/util/registry
    // daemonFor reports it. Nothing listens on 5999 and nothing probes it.
    daemonFor: async () => ({ pid: 1, port: 5999, url: 'http://localhost:5999', source: 'portfile' }),
    spawnDaemonProcess: () => {},
    waitForPortfile: async () => ({ port: 5999, url: 'http://localhost:5999', pid: 1 }),
    restartIfStale: async () => ({ restarted: false }),
    ...overrides,
  };
  return { calls, deps: d };
}

const managedLine = (logs) => logs.find((l) => /web-chat guidance for Claude is behind/.test(l));
const DESTS = MANAGED_FILES.map((f) => f.dest);

test('a project with none of the managed files: open names every one, with `claude-web-chat install`', async (t) => {
  const root = project(t);
  const { calls, deps: d } = deps(root);
  await open([], d);

  const line = managedLine(calls.logs);
  assert.ok(line, `open printed no managed-file line: ${JSON.stringify(calls.logs)}`);
  for (const dest of DESTS) assert.ok(line.includes(dest), `the line does not name ${dest}: ${line}`);
  assert.match(line, /`claude-web-chat install`/);
  assert.ok(line.includes(`v${packageVersion()}`), 'the line names the build the files are behind');
  assert.equal(calls.logs.filter((l) => /web-chat guidance/.test(l)).length, 1, 'one line, not one per file');
  assert.deepEqual(calls.browsed, ['http://localhost:5999'], 'the surface still opens');
});

test('a project whose managed files are current: open says nothing about them', async (t) => {
  const root = freshProject(t);
  const { calls, deps: d } = deps(root);
  await open([], d);
  assert.equal(managedLine(calls.logs), undefined, `unexpected line: ${JSON.stringify(calls.logs)}`);
  assert.deepEqual(calls.browsed, ['http://localhost:5999']);
});

test('only the file an older build shipped is named — the rules file after an update elsewhere', async (t) => {
  const root = freshProject(t);
  const rules = MANAGED_FILES.find((f) => f.tpl === 'rules/web-chat.md').dest;
  asOlderBuildShipped(root, rules);

  const { calls, deps: d } = deps(root);
  await open([], d);
  const line = managedLine(calls.logs);
  assert.ok(line, 'the untouched-but-older rules file is not reported');
  assert.ok(line.includes(rules));
  for (const dest of DESTS.filter((x) => x !== rules)) {
    assert.ok(!line.includes(dest), `${dest} is current but was named: ${line}`);
  }
  assert.match(line, /refresh it \(your edits are kept\)/, 'one file reads as "it"');
});

test('an edited file the template has since moved past (a conflict install will offer as .new) is named', async (t) => {
  const root = freshProject(t);
  const rules = MANAGED_FILES.find((f) => f.tpl === 'rules/web-chat.md').dest;
  asOlderBuildShipped(root, rules);
  fs.appendFileSync(path.join(root, rules), '\nmy own note\n');

  const row = require('../lib/setup/registration').inspect(root).managed.find((r) => r.dest === rules);
  assert.equal(row.action, 'conflict', 'the fixture is a conflict');

  const { calls, deps: d } = deps(root);
  await open([], d);
  const line = managedLine(calls.logs);
  assert.ok(line && line.includes(rules), `the edited, outdated rules file is not named: ${JSON.stringify(calls.logs)}`);
  assert.match(line, /your edits are kept/);
});

// A file that differs with NO recorded baseline (a project bootstrapped by
// hand, or a clone of someone else's edited .claude/) is bootstrap drift:
// plain `install` leaves it alone and only `install --force` adopts the shipped
// version — so the line must not send the user to a command that will never
// clear it, and must not promise their edits are kept by it.
test('a file that differs with no baseline names install --force, not a refresh that would repeat forever', async (t) => {
  const root = freshProject(t);
  const rules = MANAGED_FILES.find((f) => f.tpl === 'rules/web-chat.md').dest;
  fs.appendFileSync(path.join(root, rules), '\nmy own note\n');
  const b = readBaselines(root);
  delete b[rules];
  writeBaselines(root, b);

  const row = require('../lib/setup/registration').inspect(root).managed.find((r) => r.dest === rules);
  assert.equal(row.action, 'differs', 'the fixture is bootstrap drift');

  const { calls, deps: d } = deps(root);
  await open([], d);
  const line = managedLine(calls.logs);
  assert.ok(line && line.includes(rules), `the differing rules file is not named: ${JSON.stringify(calls.logs)}`);
  assert.match(line, /install --force/, 'names the only command that settles a differs file');
  assert.doesNotMatch(line, /your edits are kept/, 'does not promise a plain install keeps edits it will not touch');
  assert.doesNotMatch(line, /run `claude-web-chat install` to refresh/, 'does not name a refresh that would repeat on every open');

  // Running the plain install the old line pointed at changes nothing, and
  // the line would have come back identical — the repeat the wording avoids.
  reconcileManagedFiles(root);
  const { calls: again, deps: d2 } = deps(root);
  await open([], d2);
  assert.equal(managedLine(again.logs), line, 'a plain install does not settle a differs file');
});

// install cannot merge a .new for the user, so naming install over an offer
// they already have would be an unactionable line on every open. status, init,
// install and update still report the sidecar.
test('an unmerged .new beside an edited file, and nothing else, prints no line', async (t) => {
  const root = freshProject(t);
  const rules = MANAGED_FILES.find((f) => f.tpl === 'rules/web-chat.md').dest;
  const file = path.join(root, rules);
  fs.copyFileSync(file, file + '.new');
  fs.appendFileSync(file, '\nmy own note\n');

  const reg = require('../lib/setup/registration').inspect(root);
  const row = reg.managed.find((r) => r.dest === rules);
  assert.equal(row.action, 'kept-edited');
  assert.equal(row.pending, true, 'the fixture is an outstanding offer');

  const { calls, deps: d } = deps(root);
  await open([], d);
  assert.equal(managedLine(calls.logs), undefined, `a pending sidecar alone must not name install: ${JSON.stringify(calls.logs)}`);
});

test('a cold start reports it too, after the server and extension lines', async (t) => {
  const root = project(t);
  const { calls, deps: d } = deps(root, { daemonFor: async () => null });
  await open([], d);
  const started = calls.logs.findIndex((l) => /web-chat server started/.test(l));
  const extensions = calls.logs.findIndex((l) => /\/extensions$/.test(l));
  const managed = calls.logs.findIndex((l) => /web-chat guidance for Claude is behind/.test(l));
  assert.ok(started >= 0 && extensions > started && managed > extensions, `order was ${JSON.stringify(calls.logs)}`);
  assert.deepEqual(calls.browsed, ['http://localhost:5999']);
});

test('after bouncing a stale daemon, the managed line follows the restart', async (t) => {
  const root = project(t);
  const { calls, deps: d } = deps(root, {
    restartIfStale: async (r, { log }) => { log('Restarted the web-chat server on v9.9.9'); return { restarted: true }; },
  });
  await open([], d);
  const restarted = calls.logs.findIndex((l) => /^Restarted the web-chat server/.test(l));
  const managed = calls.logs.findIndex((l) => /web-chat guidance for Claude is behind/.test(l));
  assert.ok(restarted >= 0 && managed > restarted, `order was ${JSON.stringify(calls.logs)}`);
});

test('the check never gets in the way: a throwing read, or a root that is not installed, prints nothing', async (t) => {
  const root = project(t);
  const { calls, deps: d } = deps(root, { inspect: () => { throw new Error('boom'); } });
  await open([], d);
  assert.equal(managedLine(calls.logs), undefined);
  assert.deepEqual(calls.browsed, ['http://localhost:5999'], 'open still opens the surface');

  let asked = 0;
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-open-bare-')));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  assert.equal(staleManagedLine(bare, { inspect: () => { asked++; return { managed: [] }; } }), null);
  assert.equal(asked, 0, 'a directory with no .web-chat/ is not inspected');
  assert.equal(staleManagedLine(root, { inspect: () => ({ managed: [], managedError: 'unreadable' }) }), null);
});

// ── what `open` adopts (U105b; lifecycle-bugs.md bug 2) ──────────────────────
//
// `open` adopts only what lib/util/registry daemonFor returns: this root's
// daemon, found through its portfile or its registry entry, and accepted only
// once /api/health on that port names its pid and this root. A port that merely
// answers is not enough — a stale portfile whose port another project's daemon
// (or any HTTP server) now holds was browsed as ours.
//
// These cases use the REAL daemonFor against in-process servers on ephemeral
// ports this file opened (withServer, a loopback http.createServer); the spawn,
// the wait, the bounce and the browser are stubbed. No port in the 5173.. range,
// where the maintainer's daemons listen, is ever probed: the stub wait hands back
// a URL nothing reads, and every registry write goes to the sandbox HOME.

const http = require('http');
const { withServer } = require('../test-support/helpers');
const registry = require('../lib/util/registry');
const { projectPaths } = require('../lib/core/paths');
const { LISTEN_HOST } = require('../lib/core/cors');

const NEVER_PROBED = 'http://localhost:1'; // what the stub wait reports; only recorded

// The real daemonFor, recording the roots it was asked about.
function adoptDeps(root, extra = {}) {
  const calls = { browsed: [], logs: [], errs: [], exits: [], spawned: [], asked: [] };
  const d = {
    root,
    launchBrowser: (u) => calls.browsed.push(u),
    log: (m) => calls.logs.push(String(m)),
    errlog: (m) => calls.errs.push(String(m)),
    exit: (c) => calls.exits.push(c),
    daemonFor: async (r) => { calls.asked.push(r); return registry.daemonFor(r); },
    spawnDaemonProcess: (r) => calls.spawned.push(r),
    waitForPortfile: async () => ({ port: 1, url: NEVER_PROBED, pid: 1 }),
    restartIfStale: async () => ({ restarted: false }),
    ...extra,
  };
  return { calls, deps: d };
}

function writeServerJson(root, rec) {
  fs.writeFileSync(projectPaths(root).serverJson, JSON.stringify(rec));
}

test("a portfile naming another project's daemon: open does not browse it, and spawns this project's", async (t) => {
  const other = await withServer(t, { root: project(t) });
  registry.registerInstance({ root: other.root, port: other.port, pid: process.pid });
  const root = project(t);
  // The same pid (both in-process) and a port that answers /api/health: only
  // the instance id says it is not this root's.
  writeServerJson(root, { pid: process.pid, port: other.port, url: other.baseUrl });

  const { calls, deps: d } = adoptDeps(root);
  await open([], d);
  assert.deepEqual(calls.asked, [root]);
  assert.ok(!calls.browsed.some((u) => u.startsWith(other.baseUrl)), `browsed another project's daemon: ${JSON.stringify(calls.browsed)}`);
  assert.deepEqual(calls.spawned, [root], "this project's daemon is spawned");
  assert.deepEqual(calls.browsed, [NEVER_PROBED], 'the one it spawned is opened');
  assert.equal(calls.logs.some((l) => /already running/.test(l)), false, JSON.stringify(calls.logs));
});

test('a portfile naming a port any HTTP server answers is not adopted either', async (t) => {
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => srv.listen(0, LISTEN_HOST, r));
  t.after(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  const port = srv.address().port;
  await withServer(t); // a sandbox HOME with an empty registry
  const root = project(t);
  writeServerJson(root, { pid: process.pid, port, url: `http://localhost:${port}` });

  const { calls, deps: d } = adoptDeps(root);
  await open([], d);
  assert.deepEqual(calls.spawned, [root]);
  assert.deepEqual(calls.browsed, [NEVER_PROBED]);
});

test("this project's live daemon, known through its portfile: open adopts it and spawns nothing", async (t) => {
  const root = project(t);
  const { port } = await withServer(t, { root, writePortfile: true });
  const { calls, deps: d } = adoptDeps(root);
  await open([], d);
  assert.deepEqual(calls.spawned, []);
  assert.deepEqual(calls.browsed, [`http://localhost:${port}`]);
  assert.ok(calls.logs.includes(`web-chat server already running at http://localhost:${port}`), JSON.stringify(calls.logs));
});

test("this project's live daemon, known only through the registry: open adopts it and spawns nothing", async (t) => {
  const root = project(t);
  const { port } = await withServer(t, { root });
  registry.registerInstance({ root, port, pid: process.pid });
  assert.equal(fs.existsSync(projectPaths(root).serverJson), false, 'the fixture has no portfile');

  const { calls, deps: d } = adoptDeps(root);
  await open([], d);
  assert.deepEqual(calls.spawned, []);
  assert.deepEqual(calls.browsed, [`http://localhost:${port}`]);
});
