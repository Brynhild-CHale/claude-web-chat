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
    readPortfile: () => ({ port: 5999, url: 'http://localhost:5999' }),
    probeReachable: async () => true,
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
  const { calls, deps: d } = deps(root, { readPortfile: () => null });
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
