// `install --no-warm` and `init`'s pass-through of it (tranche 6, U755).
//
// Contracts 06 C-06.16 prepares a repo or space chat root with
//   claude-web-chat init <root> --yes --no-input --no-open --no-tour --no-warm --register-mcp
// and C-06.19 says why --no-warm: the first daemon on a prepared root is the
// connector's own spawn (the one it hands the relay secret and its record to).
// An install that pre-warmed — or restarted a stale daemon — would put a
// daemon there first, which the connector's spawnDaemon then adopts without
// either. So under --no-warm install starts and restarts NOTHING, and init
// hands the flag to every in-process install it runs.
//
// No test here may fork a daemon or run `claude`: spawnDaemon and
// restartIfStale are injected (and the module-level spawnDaemon is replaced by
// a recording guard before install is first required, so a path that forgot
// the injection is caught, not run), and runClaude / hasClaude are stubs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { withTempHome } = require('../test-support/helpers');

// The guard: install destructures spawnDaemon at module load.
const daemonMod = require('../lib/util/daemon');
const realSpawnDaemon = daemonMod.spawnDaemon;
const unguardedSpawns = [];
daemonMod.spawnDaemon = async (root) => { unguardedSpawns.push(root); return null; };
const install = require('../lib/cli/commands/install');
daemonMod.spawnDaemon = realSpawnDaemon;
const init = require('../lib/cli/commands/init');

// doctor (never reached in fresh mode, stubbed in existing mode) and anything
// else that might probe the capture hub: pin it where nothing listens.
process.env.WEB_CHAT_HUB_PORT = '65532';

// C-06.16's argv, after the root.
const C0616 = ['--yes', '--no-input', '--no-open', '--no-tour', '--no-warm', '--register-mcp'];

function tmpDir(prefix = 'wc-nowarm-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Every daemon-touching seam install has, recorded. runClaude answers ok and
// says nothing, so no `claude` is ever run.
function seams() {
  const calls = { spawn: [], restart: [], claude: [] };
  return {
    calls,
    opts: {
      spawnDaemon: async (root) => { calls.spawn.push(root); return null; },
      restartIfStale: async (root) => { calls.restart.push(root); return { restarted: false }; },
      runClaude: (argv) => { calls.claude.push(argv); return { ok: true }; },
    },
  };
}

async function quiet(fn) {
  const prev = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.log = prev; }
  return lines.join('\n');
}

// --------------------------------------------------------------- install ----

test('install --no-warm calls neither spawnDaemon nor restartIfStale', async (t) => {
  withTempHome(t);
  const root = tmpDir();
  const s = seams();
  const out = await quiet(() => install(['--no-warm'], { cwd: root, ...s.opts }));
  assert.deepEqual(s.calls.spawn, [], 'no daemon spawned');
  assert.deepEqual(s.calls.restart, [], 'no stale daemon restarted');
  assert.deepEqual(unguardedSpawns, [], 'and the module-level spawnDaemon was never reached');
  assert.match(out, /web-chat installed for/, 'the install itself ran');
  assert.ok(fs.existsSync(path.join(root, '.web-chat')), '.web-chat/ written');
  assert.match(out, /Server not started or restarted \(--no-warm\)/, 'the checklist line says so');
  assert.doesNotMatch(out, /pre-warmed/);
});

test('install([], {noWarm: true}) — init\'s spelling — calls neither', async (t) => {
  withTempHome(t);
  const root = tmpDir();
  const s = seams();
  const out = await quiet(() => install([], { cwd: root, noWarm: true, ...s.opts }));
  assert.deepEqual(s.calls.spawn, []);
  assert.deepEqual(s.calls.restart, []);
  assert.deepEqual(unguardedSpawns, []);
  assert.match(out, /Server not started or restarted \(--no-warm\)/);
});

test('without the flag install restarts a stale daemon and pre-warms, as today', async (t) => {
  withTempHome(t);
  const root = tmpDir();
  const s = seams();
  const out = await quiet(() => install([], { cwd: root, ...s.opts }));
  assert.deepEqual(s.calls.restart, [root], 'restartIfStale asked about this root');
  assert.deepEqual(s.calls.spawn, [root], 'spawnDaemon asked to pre-warm this root');
  assert.deepEqual(unguardedSpawns, [], 'through the injected seam');
  // The stub reports no daemon, so the line is the not-warmed one.
  assert.match(out, /Server will start on your first `claude-web-chat open`/);
  assert.doesNotMatch(out, /--no-warm/);
  const warmed = seams();
  warmed.opts.spawnDaemon = async (r) => { warmed.calls.spawn.push(r); return { pid: 1, port: 1 }; };
  const out2 = await quiet(() => install([], { cwd: tmpDir(), ...warmed.opts }));
  assert.match(out2, /Server pre-warmed in the background\./);
  // noWarm: false (explicitly) is the same as no flag.
  const s3 = seams();
  const root3 = tmpDir();
  await quiet(() => install([], { cwd: root3, noWarm: false, ...s3.opts }));
  assert.deepEqual(s3.calls.spawn, [root3]);
  assert.deepEqual(s3.calls.restart, [root3]);
});

// ------------------------------------------------------------------ init ----

// init's deps that keep it off the network, off any daemon and off a browser.
// install is the REAL install, wrapped so each call is recorded and handed the
// recording seams (init's own opts to install never carry them).
function initDeps({ s, installs, opens }) {
  return {
    install: async (args, opts) => {
      installs.push({ args, opts: { ...opts } });
      return install(args, { ...opts, ...s.opts });
    },
    open: async (args) => { opens.push(args); },
    doctor: async () => ({ ok: 1, repaired: 0, problems: 0, checks: [] }),
    collectRows: async () => [],
    reap: async () => ({ stopped: 0, cleared: 0, skipped: [] }),
    daemonFor: async () => null,
    client: {
      get: async () => { throw new Error('no daemon'); },
      post: async () => { throw new Error('no daemon'); },
    },
    hasClaude: () => true,
    viewerWaitMs: 0,
    latest: null,
    log: () => {},
  };
}

// Every file under a root, with its bytes, so two inits can be compared.
function tree(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else out[path.relative(root, f)] = fs.readFileSync(f, 'utf8').split(root).join('<ROOT>');
    }
  };
  walk(root);
  return out;
}

test('init <root> with C-06.16\'s exact argv passes noWarm to its install, opens nothing, starts no daemon', async (t) => {
  withTempHome(t);
  const cwd = tmpDir();
  const root = tmpDir();
  const s = seams();
  const installs = [];
  const opens = [];
  await quiet(() => init([root, ...C0616], { cwd, ...initDeps({ s, installs, opens }) }));

  assert.equal(installs.length, 1, 'fresh mode runs one in-process install');
  assert.equal(installs[0].opts.noWarm, true, 'noWarm passed through');
  assert.equal(installs[0].opts.registerMcp, true, '--register-mcp still passed through');
  assert.equal(installs[0].opts.cwd, root, 'pointed at the named root');
  assert.deepEqual(opens, [], '--no-open: nothing opened');
  assert.deepEqual(s.calls.spawn, [], 'no daemon spawned');
  assert.deepEqual(s.calls.restart, [], 'no daemon restarted');
  assert.deepEqual(unguardedSpawns, []);
  assert.ok(fs.existsSync(path.join(root, '.web-chat')), 'the root was installed');
  assert.deepEqual(fs.readdirSync(cwd), [], 'nothing in the cwd');
  // The flags parse as C-06.16 means them, and --no-warm changes no other one.
  const flags = init.parseFlags([root, ...C0616]);
  assert.deepEqual(
    { yes: flags.yes, noInput: flags.noInput, noOpen: flags.noOpen, tour: flags.tour, registerMcp: flags.registerMcp, noWarm: flags.noWarm, report: flags.report },
    { yes: true, noInput: true, noOpen: true, tour: false, registerMcp: true, noWarm: true, report: false },
  );
  const without = init.parseFlags([root, ...C0616.filter((f) => f !== '--no-warm')]);
  assert.deepEqual({ ...without, noWarm: true }, flags, 'the other flags parse the same without it');
  assert.equal(without.noWarm, false);
});

test('init --no-warm writes exactly what init writes without it', async (t) => {
  withTempHome(t);
  const run = async (argv) => {
    const root = tmpDir();
    const s = seams();
    const installs = [];
    const opens = [];
    await quiet(() => init([root, ...argv], { cwd: tmpDir(), ...initDeps({ s, installs, opens }) }));
    return { root, s, installs, opens };
  };
  const a = await run(C0616);
  const b = await run(C0616.filter((f) => f !== '--no-warm'));
  // The one difference: the pre-warm and the stale check, asked for in b only.
  assert.deepEqual(a.s.calls.spawn, []);
  assert.deepEqual(a.s.calls.restart, []);
  assert.deepEqual(b.s.calls.spawn, [b.root], 'without --no-warm init\'s install pre-warms as today');
  assert.deepEqual(b.s.calls.restart, [b.root]);
  assert.equal(b.installs[0].opts.noWarm, false);
  assert.deepEqual(a.opens, []);
  assert.deepEqual(b.opens, [], '--no-open holds either way');
  // The same Claude Code commands asked for (all stubbed, none run).
  assert.deepEqual(a.s.calls.claude, b.s.calls.claude);
  const ta = tree(a.root);
  const tb = tree(b.root);
  assert.deepEqual(Object.keys(ta).sort(), Object.keys(tb).sort(), 'the same files written');
  assert.ok(Object.keys(ta).includes(path.join('.claude', 'settings.json')), 'the hooks were written');
  assert.ok(Object.keys(ta).includes(path.join('.web-chat', '_version.json')), 'and .web-chat/ stamped');
  for (const f of Object.keys(ta)) assert.equal(ta[f], tb[f], `${f} has the same content`);
});

test('existing-mode init --no-warm passes noWarm to the managed-file refresh install', async (t) => {
  withTempHome(t);
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.web-chat', 'graph'), { recursive: true });
  fs.writeFileSync(path.join(root, '.web-chat', '_version.json'), JSON.stringify({ version: 3 }));
  const s = seams();
  const installs = [];
  const opens = [];
  const deps = {
    ...initDeps({ s, installs, opens }),
    // One managed file behind the package, so the refresh is offered (and
    // --yes takes it).
    reconcile: () => [{ action: 'updated', dest: '.claude/rules/web-chat.md' }],
    resolveToggle: () => ({ enabled: true }),
    dirSize: () => 0,
  };
  await quiet(() => init([root, ...C0616], { cwd: root, ...deps }));
  assert.equal(installs.length, 1, 'the refresh ran the in-process install');
  assert.equal(installs[0].opts.noWarm, true, 'with noWarm');
  assert.equal(installs[0].opts.registerMcp, true);
  assert.deepEqual(s.calls.spawn, [], 'no daemon spawned');
  assert.deepEqual(s.calls.restart, [], 'no daemon restarted');
  assert.deepEqual(opens, []);
  assert.deepEqual(unguardedSpawns, []);

  // And without the flag, the refresh's install is not told to skip.
  const s2 = seams();
  const installs2 = [];
  await quiet(() => init([root, ...C0616.filter((f) => f !== '--no-warm')], {
    cwd: root, ...deps, ...{ install: async (args, opts) => { installs2.push(opts); return install(args, { ...opts, ...s2.opts }); } },
  }));
  assert.equal(installs2.length, 1);
  assert.equal(installs2[0].noWarm, false);
  assert.deepEqual(s2.calls.spawn, [root]);
});

// ------------------------------------------------------------------ text ----

test('both USAGE strings name --no-warm', () => {
  assert.match(install.USAGE, /\[--no-warm\]/);
  assert.match(init.USAGE, /\[--no-warm\]/);
});

// The help text lives in lib/cli/index.js showHelp(), a product file outside
// U755's cell: the patch is in the unit's hand-off as an open issue. This
// assertion is a todo until it lands — then drop the todo.
test('the help text names --no-warm for install and init', { todo: 'lib/cli/index.js showHelp() needs the grant (U755 hand-off)' }, async () => {
  const { main } = require('../lib/cli');
  const out = await quiet(() => main(['help']));
  const block = (from, to) => {
    const at = out.indexOf(`\n  ${from} `);
    assert.ok(at >= 0, `the help has an \`${from}\` row`);
    return out.slice(at, out.indexOf(`\n  ${to} `, at));
  };
  assert.match(block('init', 'open'), /--no-warm/, 'init\'s help names --no-warm');
  assert.match(block('install', 'uninstall'), /--no-warm/, 'install\'s help names --no-warm');
});
