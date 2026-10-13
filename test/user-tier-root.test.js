// The user tier is never a project root, whatever HOME says (U114).
//
// THE LEAK (2026-10-08): with HOME overridden — this suite's sandbox, the alpha
// smoke, a user's own HOME=… — a CLI or daemon run from a folder under the REAL
// home walked up through findProjectRoot to the real ~/.web-chat (the user
// tier: versions/, current, the registry) and, because isHomeDir asked only
// about $HOME's path, took the real home for a project. A test run booted a
// daemon rooted at the developer's home that way, which wrote _version.json,
// theme-default.json and server.log into the user tier.
//
// The fix teaches the ONE home test (lib/core/paths isHomeDir) to recognise a
// folder whose .web-chat/ holds the user tier, so every existing "never a
// project" guard covers it. Here a scratch "real home" in a tmp dir plays the
// part: it holds a user-tier .web-chat/ while HOME (the sandbox's) points
// elsewhere. Nothing boots a daemon or probes a port: every daemon seam is
// stubbed and records what it was asked.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../lib/core/paths');
const { findProjectRoot, isHomeDir, holdsUserTier } = paths;
const { setupRoot } = require('../lib/setup/registration');
const registry = require('../lib/util/registry');
const { withTempHome } = require('../test-support/helpers');

// install destructures spawnDaemon at load: patch it out BEFORE the require,
// so an install that goes ahead (the cases that must, and HEAD's leak) never
// forks a background server.
const daemonMod = require('../lib/util/daemon');
const realSpawnDaemon = daemonMod.spawnDaemon;
const spawned = [];
daemonMod.spawnDaemon = async (root) => { spawned.push(root); return null; };
const install = require('../lib/cli/commands/install');
daemonMod.spawnDaemon = realSpawnDaemon;
const init = require('../lib/cli/commands/init');
const start = require('../lib/cli/commands/start');
const open = require('../lib/cli/commands/open');

// doctor probes the capture hub on the fixed hub port; pin it somewhere nothing
// listens (init's existing-mode path is exactly what HEAD's leak reached).
process.env.WEB_CHAT_HUB_PORT = '65532';

const HOME_MSG = /is your home directory — web-chat does not install here/;
const INIT_HOME_MSG = /This is your home directory, and web-chat does not install here/;

function tmpDir(t, prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// A scratch "real home": a user-tier .web-chat/ (versions/ and instances.json,
// what install.sh and the first daemon leave on every machine) with a
// project-less folder below it. HOME is NOT this directory.
function scratchHome(t) {
  const home = tmpDir(t, 'wc-realhome-');
  const wc = path.join(home, '.web-chat');
  fs.mkdirSync(path.join(wc, 'versions', '0.8.2'), { recursive: true });
  fs.writeFileSync(path.join(wc, 'instances.json'), JSON.stringify({ instances: [] }));
  const folder = path.join(home, 'Dev', 'scratch');
  fs.mkdirSync(folder, { recursive: true });
  assert.notEqual(path.resolve(process.env.HOME), home, 'HOME points elsewhere, as in the leak');
  return { home, wc, folder };
}

const tierListing = (wc) => fs.readdirSync(wc).sort();

function chdirFor(t, dir) {
  const prev = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(prev));
}

async function captureInstall(args, cwd, opts = {}) {
  const prevLog = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  const stale = [];
  try {
    await install(args, {
      cwd,
      runClaude: () => ({ ok: true }),
      restartIfStale: async (r) => { stale.push(r); return { restarted: false }; },
      ...opts,
    });
  } finally {
    console.log = prevLog;
  }
  return { out: lines.join('\n'), stale };
}

function sink() {
  const lines = [];
  const log = (s) => lines.push(String(s));
  log.text = () => lines.join('\n');
  return log;
}

function recorder(ret) {
  const calls = [];
  const fn = async (...a) => { calls.push(a); return typeof ret === 'function' ? ret(...a) : ret; };
  fn.calls = calls;
  return fn;
}

// start's seams: nothing is bound, spawned or probed; each records its root.
function startDeps(extra = {}) {
  const created = [];
  const spawnedProc = [];
  return {
    created,
    spawnedProc,
    deps: {
      log: () => {},
      errlog: () => {},
      exit: (c) => { throw new Error(`exit(${c})`); },
      daemonFor: async () => null,
      restartIfStale: async () => ({ restarted: false }),
      createServer: ({ root }) => {
        created.push(root);
        return { start: async () => ({}), installSignalHandlers() {} };
      },
      spawnDaemonProcess: (root) => { spawnedProc.push(root); return { pid: 1 }; },
      waitForDaemon: async (root) => ({ url: 'http://127.0.0.1:1/', pid: 1, root }),
      ...extra,
    },
  };
}

// ── (1) (2) the walk, the home test, the known-projects list ───────────────

test('the upward walk passes a folder whose .web-chat/ holds the user tier', (t) => {
  const { home, folder } = scratchHome(t);
  assert.equal(findProjectRoot(folder), null, 'the project-less folder has no root (HEAD: the scratch home)');
  assert.equal(findProjectRoot(home), null, 'nor is the scratch home one itself');
  assert.equal(isHomeDir(home), true, 'the scratch home answers as $HOME does');
  assert.equal(isHomeDir(folder), false, 'the folder below it is not home');
  assert.equal(holdsUserTier(home), true);
});

test('a folder holding the user tier is never a known project', (t) => {
  withTempHome(t);
  const { home, wc } = scratchHome(t);
  const before = tierListing(wc);
  assert.equal(registry.rememberProject({ root: home }), null, 'isKnowable refuses it (HEAD: remembered)');
  assert.equal(fs.existsSync(registry.knownPath()), false, 'nothing was written');
  // A legacy entry naming it is pruned on read.
  fs.mkdirSync(path.dirname(registry.knownPath()), { recursive: true });
  fs.writeFileSync(registry.knownPath(), JSON.stringify({ projects: [
    { id: registry.instanceId(home), root: home, title: 'home', last_seen_at: 1 },
  ] }));
  assert.deepEqual(registry.sessions().map((r) => r.root), []);
  assert.deepEqual(tierListing(wc), before, 'the scratch user tier is untouched');
});

// ── (3) install and init aimed at it ───────────────────────────────────────

test('install aimed at a folder holding the user tier refuses with the home message and writes nothing', async (t) => {
  withTempHome(t);
  const { home, wc } = scratchHome(t);
  const elsewhere = tmpDir(t, 'wc-elsewhere-');
  const before = tierListing(wc);
  spawned.length = 0;
  const runs = [
    [[], home],
    [['--nearest-parent'], home],
    [[home], elsewhere],
    [[home, '--nearest-parent'], elsewhere],
  ];
  for (const [args, cwd] of runs) {
    const what = `${JSON.stringify(args)} from ${cwd}`;
    let result = null;
    await assert.rejects(
      async () => { result = await captureInstall(args, cwd); },
      (e) => e.userFacing === true && HOME_MSG.test(e.message),
      what,
    );
    assert.equal(result, null, what);
  }
  assert.deepEqual(fs.readdirSync(home).sort(), ['.web-chat', 'Dev'], 'no .claude/, no .mcp.json, no .gitignore');
  assert.deepEqual(tierListing(wc), before, 'and the user tier is not first-touched');
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.deepEqual(spawned, [], 'no daemon pre-warmed');
});

test('init aimed at a folder holding the user tier is refused in every rule and runs neither doctor nor install', async (t) => {
  withTempHome(t);
  const { home, wc } = scratchHome(t);
  const elsewhere = tmpDir(t, 'wc-elsewhere-');
  const before = tierListing(wc);
  const prevExit = process.exitCode;
  t.after(() => { process.exitCode = prevExit; });
  const runs = [
    [['--yes'], home],
    [['--yes', home], elsewhere],
    [['--yes', '--nearest-parent'], home],
    [['--yes', '--nearest-parent', home], elsewhere],
  ];
  for (const [args, cwd] of runs) {
    process.exitCode = 0;
    const what = `${JSON.stringify(args)} from ${cwd}`;
    const log = sink();
    const doctor = recorder({ ok: 3, repaired: 0, problems: 0, checks: [] });
    const fakeInstall = recorder({});
    const opened = recorder(undefined);
    const prompt = { interactive: true, confirm: async () => true, line: async () => '', close: () => {} };
    await init(args, {
      cwd, log, prompt, doctor, install: fakeInstall, open: opened,
      collectRows: async () => [],
      reap: async () => ({ stopped: 0, cleared: 0, skipped: [] }),
      client: { get: async () => { throw new Error('no daemon'); }, post: async () => { throw new Error('no daemon'); } },
      viewerWaitMs: 0,
      latest: null,
    });
    assert.equal(doctor.calls.length, 0, `doctor never runs on it: ${what}`);
    assert.equal(fakeInstall.calls.length, 0, `nor install: ${what}`);
    assert.equal(opened.calls.length, 0, `nor open: ${what}`);
    assert.equal(process.exitCode, 1, what);
    assert.match(log.text(), INIT_HOME_MSG, what);
  }
  assert.deepEqual(fs.readdirSync(home).sort(), ['.web-chat', 'Dev']);
  assert.deepEqual(tierListing(wc), before);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

// ── (4) install in the project-less folder below it ────────────────────────

test('install in a project-less folder below it sets up that folder, with no enclosing install named', async (t) => {
  withTempHome(t);
  const { home, wc, folder } = scratchHome(t);
  const before = tierListing(wc);
  assert.equal(setupRoot([], { cwd: folder }).enclosing, null, 'here: no enclosing (HEAD: the scratch home)');
  assert.equal(setupRoot(['--nearest-parent'], { cwd: folder }).root, folder, 'nearest-parent: the folder itself');
  const { out } = await captureInstall([], folder);
  assert.match(out, /web-chat installed for/);
  assert.doesNotMatch(out, /has its own web-chat/, 'the user tier is not named as an install above');
  assert.ok(fs.existsSync(path.join(folder, '.web-chat', '_version.json')), 'the folder is the install');
  assert.deepEqual(tierListing(wc), before, 'the scratch user tier is untouched');
  assert.equal(findProjectRoot(path.join(folder, 'src')), folder, 'and it is now found from below');
  assert.equal(fs.existsSync(path.join(home, '.claude')), false);
});

// ── (5) start and open refuse it ───────────────────────────────────────────

test('start from a project-less folder below it refuses through the existing rule and starts nothing', async (t) => {
  const { wc, folder } = scratchHome(t);
  const before = tierListing(wc);
  chdirFor(t, folder);
  for (const args of [[], ['--daemon']]) {
    const s = startDeps();
    await assert.rejects(() => start(args, s.deps),
      (e) => e.userFacing === true && /no \.web-chat\/ in .* — run `claude-web-chat init` first/.test(e.message),
      JSON.stringify(args));
    assert.deepEqual(s.created, [], `no server created (${JSON.stringify(args)})`);
    assert.deepEqual(s.spawnedProc, [], `no daemon spawned (${JSON.stringify(args)})`);
  }
  assert.deepEqual(tierListing(wc), before, 'nothing written into the user tier');
});

test('start handed a root that is home (restart, update --restart-all) refuses before writing anything', async (t) => {
  const { home, wc } = scratchHome(t);
  const before = tierListing(wc);
  const trueHome = withTempHome(t);
  for (const root of [home, trueHome]) {
    for (const args of [[], ['--daemon']]) {
      const s = startDeps();
      const asked = [];
      s.deps.daemonFor = async (r) => { asked.push(r); return null; };
      await assert.rejects(() => start(args, { ...s.deps, root }),
        (e) => e.userFacing === true && /is your home directory/.test(e.message) && /no surface can be rooted there/.test(e.message),
        `${root} ${JSON.stringify(args)}`);
      assert.deepEqual(asked, [], 'no daemon is asked about');
      assert.deepEqual(s.created, []);
      assert.deepEqual(s.spawnedProc, []);
    }
  }
  assert.deepEqual(tierListing(wc), before);
  assert.deepEqual(fs.readdirSync(trueHome), [], 'nothing written in the true $HOME');
});

test('open from a project-less folder below it refuses and spawns no daemon', async (t) => {
  const { folder } = scratchHome(t);
  chdirFor(t, folder);
  const errs = [];
  const codes = [];
  const spawnedOpen = [];
  const browsed = [];
  await open([], {
    log: () => {},
    errlog: (m) => errs.push(m),
    exit: (c) => { codes.push(c); },
    launchBrowser: (u) => { browsed.push(u); },
    daemonFor: async () => null,
    spawnDaemonProcess: (r) => { spawnedOpen.push(r); return { pid: 1 }; },
    waitForDaemon: async () => null,
    restartIfStale: async () => ({ restarted: false }),
  });
  assert.deepEqual(codes, [1]);
  assert.match(errs.join('\n'), /no web-chat project here/);
  assert.deepEqual(spawnedOpen, [], 'no daemon spawned (HEAD: one rooted at the scratch home)');
  assert.deepEqual(browsed, []);
});

// ── (6) a real project below it still resolves ─────────────────────────────

test('a project below the folder holding the user tier still resolves, and start and install accept it', async (t) => {
  withTempHome(t);
  const { home } = scratchHome(t);
  const project = path.join(home, 'Dev', 'app');
  fs.mkdirSync(path.join(project, '.web-chat', 'graph'), { recursive: true });
  fs.mkdirSync(path.join(project, 'src', 'deep'), { recursive: true });
  assert.equal(findProjectRoot(path.join(project, 'src', 'deep')), project);
  assert.equal(isHomeDir(project), false);

  chdirFor(t, path.join(project, 'src'));
  const s = startDeps();
  await start(['--daemon'], s.deps);
  assert.deepEqual(s.spawnedProc, [project], 'start --daemon spawns for the project');
  const f = startDeps();
  await start([], f.deps);
  assert.deepEqual(f.created, [project], 'foreground start serves the project');
  const r = startDeps();
  await start(['--daemon'], { ...r.deps, root: project });
  assert.deepEqual(r.spawnedProc, [project], 'and a handed-in project root is accepted');

  const { out } = await captureInstall(['--nearest-parent'], path.join(project, 'src'));
  assert.match(out, /web-chat installed for/);
  assert.ok(fs.existsSync(path.join(project, '.claude')), 'install wrote into the project');
  assert.equal(fs.existsSync(path.join(home, '.claude')), false, 'not into the scratch home');
});

// ── (7) the markers ────────────────────────────────────────────────────────

test('each user-tier marker alone is enough; a project .web-chat/ without them is not home', (t) => {
  const markers = {
    versions: (wc) => fs.mkdirSync(path.join(wc, 'versions')),
    'current (a dangling symlink)': (wc) => fs.symlinkSync(path.join('versions', '0.0.0'), path.join(wc, 'current')),
    'current (a live symlink)': (wc) => {
      fs.mkdirSync(path.join(wc, 'versions', '0.8.2'), { recursive: true });
      fs.symlinkSync(path.join('versions', '0.8.2'), path.join(wc, 'current'));
    },
    'instances.json': (wc) => fs.writeFileSync(path.join(wc, 'instances.json'), '{}'),
    'projects.json': (wc) => fs.writeFileSync(path.join(wc, 'projects.json'), '{"projects":[]}'),
  };
  for (const [name, make] of Object.entries(markers)) {
    const home = tmpDir(t, 'wc-marker-');
    const wc = path.join(home, '.web-chat');
    fs.mkdirSync(wc);
    make(wc);
    const below = path.join(home, 'below');
    fs.mkdirSync(below);
    assert.equal(isHomeDir(home), true, name);
    assert.equal(findProjectRoot(below), null, name);
    assert.equal(holdsUserTier(home), true, name);
  }

  // A project's .web-chat/ as install and a running daemon leave it.
  const project = tmpDir(t, 'wc-project-');
  const pwc = path.join(project, '.web-chat');
  fs.mkdirSync(path.join(pwc, 'graph'), { recursive: true });
  fs.mkdirSync(path.join(pwc, 'components'), { recursive: true });
  fs.writeFileSync(path.join(pwc, '_version.json'), '{"version":3}');
  fs.writeFileSync(path.join(pwc, 'server.json'), '{}');
  fs.writeFileSync(path.join(pwc, 'theme.json'), '{}');
  assert.equal(isHomeDir(project), false);
  fs.mkdirSync(path.join(project, 'src'));
  assert.equal(findProjectRoot(path.join(project, 'src')), project);
  assert.equal(holdsUserTier(project), false);

  // A folder with no .web-chat/ at all, and a .web-chat that is a file.
  const bare = tmpDir(t, 'wc-bare-');
  assert.equal(holdsUserTier(bare), false);
  fs.writeFileSync(path.join(bare, '.web-chat'), 'not a dir');
  assert.equal(holdsUserTier(bare), false);
});

test('the true $HOME is still refused as before, by path alone', async (t) => {
  const home = withTempHome(t);
  fs.mkdirSync(path.join(home, '.web-chat'));
  fs.mkdirSync(path.join(home, 'code', 'app'), { recursive: true });
  assert.equal(isHomeDir(home), true);
  assert.equal(isHomeDir(fs.realpathSync(home)), true);
  // By path alone: a bare user tier holds none of the markers yet.
  assert.equal(findProjectRoot(path.join(home, 'code', 'app')), null);
  await assert.rejects(() => captureInstall([], home), (e) => e.userFacing === true && HOME_MSG.test(e.message));
  assert.deepEqual(fs.readdirSync(home).sort(), ['.web-chat', 'code']);
});
