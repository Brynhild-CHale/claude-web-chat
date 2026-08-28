// `claude-web-chat init` — the one entry point, two auto-detected modes.
//
// What is actually load-bearing here, and therefore what is tested:
//   * mode detection, including "I ran it in a subdirectory of an installed
//     project" (which must repair the PARENT, not create a second install);
//   * the non-interactive gate — a fresh install must write NOTHING without an
//     explicit --yes, because `/web-chat init` and CI both reach this code with
//     no terminal to answer a prompt;
//   * --report / --json being genuinely read-only (doctor gets dryRun, and not
//     one byte under .web-chat/ moves);
//   * the tour landing as UNOWNED mounts with the declared signal — the whole
//     reason it goes over /use rather than lib/driver.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const init = require('../lib/cli/commands/init');
const { createPrompt } = require('../lib/cli/prompt');
const { deriveRouting } = require('../lib/server/domain/signals');
const { withTempHome, withServer } = require('../test-support/helpers');
const { writePortfileAt } = require('../lib/core/portfiles');

// doctor probes the capture hub on the fixed hub port; pin it somewhere nothing
// listens so any real-doctor run in this file is deterministic.
process.env.WEB_CHAT_HUB_PORT = '65532';

function tmpDir(prefix = 'wc-init-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function installedProject(t) {
  withTempHome(t);
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.web-chat', 'graph'), { recursive: true });
  fs.writeFileSync(path.join(root, '.web-chat', '_version.json'), JSON.stringify({ version: 3 }));
  return root;
}

// A log sink that also lets a test read the whole transcript as one string.
function sink() {
  const lines = [];
  const log = (s) => lines.push(String(s));
  log.lines = lines;
  log.text = () => lines.join('\n');
  return log;
}

// A doctor stub that records how it was invoked. Its summary shape matches the
// real one, so gatherState composes it identically.
function fakeDoctor(summary = { ok: 3, repaired: 0, problems: 0, checks: [] }) {
  const calls = [];
  const fn = async (args, opts) => { calls.push(opts || {}); return summary; };
  fn.calls = calls;
  return fn;
}

// Deps that keep a test entirely off the network, off the daemon, and off npm.
function inertDeps(extra = {}) {
  return {
    doctor: fakeDoctor(),
    collectRows: async () => [],
    // Nothing in this suite may signal or unlink another project's daemon.
    reap: async () => ({ stopped: 0, cleared: 0, skipped: [] }),
    client: {
      get: async () => { throw new Error('no daemon'); },
      post: async () => { throw new Error('no daemon'); },
    },
    viewerWaitMs: 0,
    // Never let a test reach out to GitHub for the release check.
    latest: null,
    ...extra,
  };
}

// ---------------------------------------------------------------- mode ------

test('init detects fresh mode when there is no .web-chat/ up-tree', async (t) => {
  withTempHome(t);
  const root = tmpDir();
  const log = sink();
  const state = await init(['--json'], { cwd: root, log, ...inertDeps() });
  assert.equal(state.mode, 'fresh');
  assert.equal(state.root, root);
});

test('init detects existing mode from an installed root', async (t) => {
  const root = installedProject(t);
  const log = sink();
  const state = await init(['--json'], { cwd: root, log, ...inertDeps() });
  assert.equal(state.mode, 'existing');
  assert.equal(state.root, root);
  assert.equal(state.schema, 3);
});

test('init run from a SUBDIR of an installed project resolves to the parent, not a second install', async (t) => {
  const root = installedProject(t);
  const sub = path.join(root, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });

  const log = sink();
  const state = await init(['--json'], { cwd: sub, log, ...inertDeps() });
  assert.equal(state.mode, 'existing', 'a subdir of an installed project is NOT a fresh install');
  assert.equal(state.root, root, 'the resolved root is the installed parent');
  assert.equal(fs.existsSync(path.join(sub, '.web-chat')), false, 'no second .web-chat/ in the subdir');
});

// ------------------------------------------------------- non-interactive ----

test('fresh + no TTY + no --yes: prints the write list and writes NOTHING', async (t) => {
  withTempHome(t);
  const root = tmpDir();
  const log = sink();
  const install = fakeDoctor(); // reuse the call recorder — shape does not matter

  await init([], { cwd: root, log, ...inertDeps({ install }), noOpenGuard: true });

  assert.equal(install.calls.length, 0, 'install must not run without an explicit --yes');
  assert.equal(fs.existsSync(path.join(root, '.web-chat')), false, 'nothing created');
  const text = log.text();
  assert.match(text, /\.mcp\.json/, 'the write list is still printed');
  assert.match(text, /Not a terminal — nothing written\. Re-run with --yes/);
});

test('fresh + --yes: installs, opens nothing, mounts no tour', async (t) => {
  withTempHome(t);
  const root = tmpDir();
  const log = sink();
  const installCalls = [];
  const openCalls = [];
  const install = async (args, opts) => {
    installCalls.push(opts || {});
    fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  };

  await init(['--yes'], {
    cwd: root,
    log,
    ...inertDeps({ install, open: async (a) => { openCalls.push(a); } }),
  });

  assert.equal(installCalls.length, 1, 'install ran');
  assert.equal(installCalls[0].nextSteps, false, 'init suppresses install\'s trailing checklist');
  assert.equal(fs.existsSync(path.join(root, '.web-chat')), true);
  // --yes takes the printed DEFAULTS. "Open the browser?" defaults to yes, but
  // there is no terminal, so the prompt engine resolves it without asking and
  // the tour (TTY-only) never runs.
  const text = log.text();
  assert.match(text, /\/exit and reopen Claude Code/);
  assert.doesNotMatch(text, /Your tour is on the surface/);
});

test('fresh + --yes in $HOME still asks about the disable-marker collision and takes the No default', async (t) => {
  const home = withTempHome(t);
  const log = sink();
  const install = fakeDoctor();

  // cwd IS the home directory: projectPaths(root).disabled === userPaths().disabled.
  await init(['--yes'], { cwd: home, log, ...inertDeps({ install }) });

  assert.equal(install.calls.length, 0, '--yes must not install into $HOME — the printed default is No');
  const text = log.text();
  assert.match(text, /home directory/);
  assert.match(text, /disable web-chat for EVERY project/);
});

// -------------------------------------------------------------- --report ----

test('--report runs doctor with dryRun and never installs', async (t) => {
  const root = installedProject(t);
  const log = sink();
  const doctor = fakeDoctor({ ok: 2, repaired: 1, problems: 0, checks: [] });
  const install = fakeDoctor();

  await init(['--report'], { cwd: root, log, ...inertDeps({ doctor, install }) });

  assert.equal(doctor.calls.length, 1);
  assert.equal(doctor.calls[0].dryRun, true, 'doctor MUST be told not to repair');
  assert.equal(install.calls.length, 0);
  assert.match(log.text(), /--- WEB-CHAT-STATE ---/);
});

test('--report touches nothing on disk under .web-chat/', async (t) => {
  const root = installedProject(t);
  const webChat = path.join(root, '.web-chat');
  // A deliberately broken install: a portfile pointing at a dead pid, and an
  // orphaned graph lock. A repairing doctor would delete/rewrite both.
  fs.writeFileSync(path.join(webChat, 'server.json'), JSON.stringify({ pid: 999999999, port: 65111 }));
  fs.writeFileSync(path.join(webChat, 'graph', '_meta.json'), JSON.stringify({ active: null, lock: { base: null, started_at: 0, author: 'user' } }));

  const before = {};
  for (const f of ['server.json', 'graph/_meta.json', '_version.json']) {
    before[f] = fs.statSync(path.join(webChat, f)).mtimeMs;
  }

  const log = sink();
  // The REAL doctor this time, in dryRun — this is the assertion that matters.
  // A deliberately broken install makes doctor report problems, which sets a
  // non-zero exit code on the whole process; put it back or the test FILE fails.
  const prevExit = process.exitCode;
  t.after(() => { process.exitCode = prevExit; });
  await init(['--report'], { cwd: root, log, collectRows: async () => [], viewerWaitMs: 0 });

  for (const f of ['server.json', 'graph/_meta.json', '_version.json']) {
    assert.equal(fs.existsSync(path.join(webChat, f)), true, `${f} still exists`);
    assert.equal(fs.statSync(path.join(webChat, f)).mtimeMs, before[f], `${f} was not rewritten`);
  }
  const meta = JSON.parse(fs.readFileSync(path.join(webChat, 'graph', '_meta.json'), 'utf8'));
  assert.ok(meta.lock, 'the orphaned lock is still there — a read-only run repairs nothing');
  assert.match(log.text(), /would repair/, 'the repairs it declined are still reported');
});

test('--json emits ONLY the state object, and it round-trips', async (t) => {
  const root = installedProject(t);
  const log = sink();
  const returned = await init(['--json'], { cwd: root, log, ...inertDeps() });

  assert.equal(log.lines.length, 1, '--json prints exactly one thing: the JSON');
  const parsed = JSON.parse(log.lines[0]);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(returned)), 'what is printed is what is returned');

  for (const k of ['mode', 'root', 'version', 'latest', 'toggle', 'schema', 'nodes', 'daemon',
    'viewers', 'restart', 'channel_connected', 'drift', 'pending_services', 'surfaces', 'doctor']) {
    assert.ok(k in parsed, `state.${k} is part of the contract`);
  }
  assert.deepEqual(Object.keys(parsed.toggle).sort(), ['effective', 'project', 'user']);
  assert.deepEqual(Object.keys(parsed.daemon).sort(), ['port', 'running', 'url']);
  assert.deepEqual(Object.keys(parsed.doctor).sort(), ['checks', 'ok', 'problems', 'repaired']);
  assert.ok(Array.isArray(parsed.drift) && Array.isArray(parsed.surfaces) && Array.isArray(parsed.pending_services));
});

test('--json exits non-zero when doctor found problems (a usable CI health gate)', async (t) => {
  const root = installedProject(t);
  const prev = process.exitCode;
  try {
    const log = sink();
    await init(['--json'], {
      cwd: root, log,
      ...inertDeps({ doctor: fakeDoctor({ ok: 1, repaired: 0, problems: 2, checks: [{ status: 'problem', m: 'bad' }] }) }),
    });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = prev;
  }
});

test('--report on a healthy install leaves the exit code alone', async (t) => {
  const root = installedProject(t);
  const prev = process.exitCode;
  try {
    process.exitCode = 0;
    const log = sink();
    await init(['--report'], { cwd: root, log, ...inertDeps() });
    assert.notEqual(process.exitCode, 1);
  } finally {
    process.exitCode = prev;
  }
});

// ------------------------------------------------------- the prompt engine --

test('the prompt engine returns defaults on a non-TTY stdin and never opens a readline', async () => {
  const log = sink();
  const p = createPrompt({ log, stdin: { isTTY: false }, env: {} });
  assert.equal(p.interactive, false);
  assert.equal(await p.confirm('Continue?', { def: true }), true);
  assert.equal(await p.confirm('Reap other daemons?', { def: false }), false);
  assert.equal(await p.line('anything?'), '');
  assert.equal(p.opened, 0, 'a non-interactive run must never construct a readline interface');
  p.close();

  const text = log.text();
  assert.match(text, /\[Y\/n\]/, 'the default is printed');
  assert.match(text, /\[y\/N\]/);
  assert.match(text, /no terminal — assuming yes/);
  assert.match(text, /no terminal — assuming no/);
  assert.match(text, /--no-input to silence/);
});

test('--yes resolves prompts to their default without a readline, and CI counts as non-interactive', async () => {
  const yes = createPrompt({ log: () => {}, stdin: { isTTY: true }, yes: true, env: {} });
  assert.equal(yes.interactive, false);
  assert.equal(await yes.confirm('Stop other surfaces?', { def: false }), false, '--yes means "take the printed default", not "say yes"');
  assert.equal(yes.opened, 0);

  const ci = createPrompt({ log: () => {}, stdin: { isTTY: true }, env: { CI: '1' } });
  assert.equal(ci.interactive, false);
  assert.equal(ci.opened, 0);
});

// ----------------------------------------------------------- the tour ------

test('the tour mounts as two UNOWNED panes, routed auto, with the declared signal', async (t) => {
  await withServer(t, async (ctx) => {
    // A portfile so init's own portfile read finds this server, plus a client
    // shim that speaks to it. (withServer binds an ephemeral port.)
    writePortfileAt(ctx.webChatDir, { pid: process.pid, port: ctx.port });
    const http = {
      get: async (p) => {
        const r = await ctx.api.get(p);
        if (r.status >= 400) throw new Error(`${p} -> ${r.status}`);
        return r.json;
      },
      post: async (p, body) => {
        const r = await ctx.api.post(p, body);
        if (r.status >= 400) throw new Error(`${p} -> ${r.status}`);
        return r.json;
      },
    };

    const log = sink();
    await init(['--tour'], {
      cwd: ctx.root,
      log,
      client: http,
      collectRows: async () => [],
      viewerWaitMs: 0,
      latest: null,
    });

    const mounts = (await ctx.api.get('/api/mounts')).json.mounts;
    const byId = Object.fromEntries(mounts.map((m) => [m.id, m]));
    assert.ok(byId[init.TOUR_MOUNT], 'the guide pane landed');
    assert.ok(byId[init.TOUR_MIRROR_MOUNT], 'the mirror pane landed');

    // THE point of using /use instead of lib/driver: no owner. An owner of
    // `service:init` would flip routing to 'none' (killing the activity layer
    // the tour teaches) and clobber-guard Claude out of clearing its own tour.
    assert.equal(byId[init.TOUR_MOUNT].owner, null);
    assert.equal(byId[init.TOUR_MIRROR_MOUNT].owner, null);

    // params ride on the mount record; read them off the ws hello frame.
    const hello = await ctx.wsHello();
    const helloById = Object.fromEntries(hello.mounts.map((m) => [m.id, m]));
    const guide = helloById[init.TOUR_MOUNT];
    assert.equal(guide.params.role, 'guide');
    assert.deepEqual(guide.params.signals, [
      { key: 'web_chat_init', wake: 'queue', why: 'first-run tour handoff' },
    ]);
    assert.equal(helloById[init.TOUR_MIRROR_MOUNT].params.routing, 'none');

    const routing = deriveRouting({ mounts: new Map(hello.mounts.map((m) => [m.id, m])) });
    assert.equal(routing[init.TOUR_MOUNT], 'auto', 'the guide keeps the default activity routing');
    assert.equal(routing[init.TOUR_MIRROR_MOUNT], 'none', 'the mirror is deliberately silent');
  });
});

test('web-chat-tour is a seeded builtin whose description warns Claude off general rendering', async (t) => {
  await withServer(t, async (ctx) => {
    const list = (await ctx.api.get('/api/components')).json.components;
    const tour = list.find((c) => c.name === 'web-chat-tour');
    assert.ok(tour, 'web-chat-tour is seeded as a builtin');
    assert.match(tour.description, /Do NOT pick this for general rendering/);
    assert.match(tour.description, /web_chat_init/);
    // No service.js: a host-code consent prompt in the first 60 seconds of the
    // first install is the wrong place for that decision.
    assert.equal(tour.has_service, false);
  });
});

// ------------------------------------------------- existing, no terminal ----
// The subtle one. A prompt with a Yes default resolves to Yes when there is no
// terminal — and "no terminal" must NOT mean "quietly refresh this person's
// managed files and flip their toggles". Without a TTY (and without an explicit
// --yes) every remediation prints its command instead of running.

test('existing + no TTY: remediations PRINT their command, they do not run', async (t) => {
  const root = installedProject(t);
  fs.writeFileSync(path.join(root, '.web-chat', 'disabled'), '');

  const installCalls = [];
  const onCalls = [];
  const log = sink();
  await init([], {
    cwd: root, log,
    ...inertDeps({
      install: async (...a) => { installCalls.push(a); },
      on: (...a) => { onCalls.push(a); },
      reconcile: () => [{ dest: '.claude/rules/web-chat.md', tpl: 'rules/web-chat.md', action: 'updated' }],
    }),
  });

  assert.equal(installCalls.length, 0, 'no silent managed-file refresh without a terminal');
  assert.equal(onCalls.length, 0, 'no silent toggle flip without a terminal');
  const text = log.text();
  assert.match(text, /not a terminal — run `claude-web-chat install` yourself/);
  assert.match(text, /not a terminal — run `claude-web-chat on` yourself/);
});

test('existing + --yes: the SAFE defaults are taken, the dangerous ones still are not', async (t) => {
  const root = installedProject(t);
  fs.writeFileSync(path.join(root, '.web-chat', 'disabled'), '');

  const installCalls = [];
  const onCalls = [];
  const lsCalls = [];
  const updateCalls = [];
  const log = sink();
  await init(['--yes'], {
    cwd: root, log,
    ...inertDeps({
      install: async (...a) => { installCalls.push(a); },
      on: (...a) => { onCalls.push(a); },
      ls: async (...a) => { lsCalls.push(a); },
      update: (...a) => { updateCalls.push(a); },
      reconcile: () => [{ dest: '.claude/rules/web-chat.md', tpl: 'rules/web-chat.md', action: 'updated' }],
      // A live surface for ANOTHER project, and a newer release: both default No.
      collectRows: async () => [{ root: '/somewhere/else', title: 'else', url: 'http://127.0.0.1:5199', port: 5199, pid: process.pid, pid_alive: true, reachable: true }],
      latest: { latest: '99.0.0', updateAvailable: true, releaseUrl: 'https://example.invalid' },
    }),
    // inRoot must not really chdir in a test.
    inRoot: async (r, fn) => fn(),
  });

  assert.equal(installCalls.length, 1, '--yes takes the Yes default: refresh drifted managed files');
  assert.equal(onCalls.length, 1, '--yes takes the Yes default: re-enable the disabled scope');
  assert.equal(lsCalls.length, 0, '--yes must NEVER reap another project\'s daemon');
  assert.equal(updateCalls.length, 0, '--yes must NEVER rewrite the global install');
});

test('existing mode prints the machine inventory and the terminal-only trust command', async (t) => {
  const root = installedProject(t);
  const log = sink();
  await init([], {
    cwd: root, log,
    ...inertDeps({
      collectRows: async () => [
        { root, title: 'mine', url: 'http://127.0.0.1:5311', port: 5311, pid: process.pid, pid_alive: true, reachable: true },
        { root: '/other/proj', title: 'other', url: 'http://127.0.0.1:5312', port: 5312, pid: process.pid, pid_alive: true, reachable: true },
      ],
    }),
  });
  const text = log.text();
  assert.match(text, /Surfaces on this machine:/);
  assert.match(text, /http:\/\/127\.0\.0\.1:5311/);
  assert.match(text, /http:\/\/127\.0\.0\.1:5312/);
  assert.match(text, /← is this project\./);
  assert.match(text, /1 live surface for OTHER projects/);
});

test('existing mode announces doctor\'s `claude mcp add` shell-out BEFORE running it', async (t) => {
  const root = installedProject(t);
  const order = [];
  const log = (s) => order.push(String(s));
  log.lines = order;
  log.text = () => order.join('\n');
  const doctor = async () => { order.push('<<doctor ran>>'); return { ok: 1, repaired: 0, problems: 0, checks: [] }; };

  await init([], { cwd: root, log, ...inertDeps({ doctor }) });

  const announce = order.findIndex((l) => /claude mcp add/.test(l));
  const ran = order.indexOf('<<doctor ran>>');
  assert.ok(announce >= 0, 'the shell-out is named');
  assert.ok(announce < ran, 'and it is named BEFORE doctor is allowed to do it');
});

// ------------------------------------------------ honesty of the report -----

test('a FRESH project reads as "not installed", not as "DISABLED by the project scope"', async (t) => {
  withTempHome(t);
  const root = tmpDir();
  const log = sink();
  const state = await init(['--report'], { cwd: root, log, ...inertDeps() });

  // The toggle policy genuinely reports the project scope as disabled when there
  // is no .web-chat/ (opt-in per project). True, but on a first-run report it
  // reads as an alarm, so the state object names the real situation instead.
  assert.equal(state.toggle.project, 'not-installed');
  assert.equal(state.toggle.effective, 'not-installed');
  const text = log.text();
  assert.match(text, /not installed here yet/);
  assert.doesNotMatch(text, /DISABLED by the project scope/);
});

test('--report says "would be repaired", never "repaired", for work it declined to do', async (t) => {
  const root = installedProject(t);
  const log = sink();
  await init(['--report'], {
    cwd: root, log,
    ...inertDeps({
      doctor: fakeDoctor({
        ok: 1, repaired: 2, problems: 0,
        checks: [
          { status: 'repaired', dry: true, m: 'removed stale portfile (the process it pointed at is gone)' },
          { status: 'repaired', dry: true, m: 'cleared an orphaned graph lock' },
        ],
      }),
    }),
  });
  const text = log.text();
  assert.match(text, /2 would be repaired/);
  assert.doesNotMatch(text, /2 repaired/);
});

test('a failed `open` does not abort init before the onboarding stamp and restart instructions', async (t) => {
  withTempHome(t);
  const root = tmpDir();
  const log = sink();
  // `open` calls its injected exit(1) when the daemon never binds — and that
  // injection defaults to the real process.exit, which killed init mid-sequence,
  // losing the two things the user actually needs next. So init must hand `open`
  // its own exit, and must keep going afterwards.
  let openDeps = null;
  const open = async (args, deps) => { openDeps = deps; if (deps && deps.exit) deps.exit(1); };

  await init(['--yes'], {
    cwd: root, log,
    ...inertDeps({
      open,
      install: async () => { fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true }); },
    }),
  });

  assert.ok(openDeps && typeof openDeps.exit === 'function',
    'init must give `open` an exit it controls, not let it call process.exit');
  const text = log.text();
  assert.match(text, /\/exit and reopen Claude Code/, 'the restart instruction still printed');
  assert.match(text, /\/web-chat init/, 'the handoff still printed');
  const onboarded = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.web-chat', 'onboarded.json'), 'utf8'));
  assert.ok(onboarded.projects[root], 'the project was still stamped as onboarded');
});

test('the inventory legend never claims a surface is this project when none is', async (t) => {
  const root = installedProject(t);
  const log = sink();
  await init([], {
    cwd: root, log,
    ...inertDeps({
      // One live surface, belonging to a DIFFERENT project.
      collectRows: async () => [
        { root: '/other/proj', title: 'other', url: 'http://127.0.0.1:5312', port: 5312, pid: process.pid, pid_alive: true, reachable: true },
      ],
    }),
  });
  const text = log.text();
  assert.match(text, /1 live surface for OTHER projects/);
  assert.doesNotMatch(text, /← is this project\./,
    'the legend contradicted the remediation two paragraphs later');
  assert.match(text, /none of these is this project/);
});

// The remediation that used to be unreachable. `readInstances` pruned dead-pid
// entries as it read, so no row init ever saw had `pid_alive:false` and this
// branch could not fire — and if it had, it unlinked the OTHER project's
// portfile and reported "cleared", leaving ~/.web-chat untouched. It now goes
// through the one reaper, which for a ghost row removes the registry entry the
// question actually named. `--yes` takes the printed Yes default here (as it
// does for install/on), which is what drives the branch without a terminal.
test('a stale registry entry is reaped through the shared reaper, not by hand', async (t) => {
  const root = installedProject(t);
  const ghost = { root: '/gone/proj', title: 'ghost', url: 'http://127.0.0.1:5399', port: 5399, pid: 2 ** 30, pid_alive: false, reachable: false };
  const reapCalls = [];
  const log = sink();
  await init(['--yes'], {
    cwd: root, log,
    ...inertDeps({
      collectRows: async () => [ghost],
      reap: async (rows, opts) => { reapCalls.push({ rows, opts }); return { stopped: 0, cleared: rows.length, skipped: [] }; },
      // --yes takes every printed Yes default, so every OTHER offer has to be
      // inert too. Left real, `install` rewrote this repo's own .mcp.json and
      // pre-warmed a daemon in the checkout — a test may touch neither.
      install: async () => {},
      reconcile: () => [],
      open: async () => {},
    }),
    inRoot: async (r, fn) => fn(),
  });

  assert.equal(reapCalls.length, 1, 'the remediation ran, through deps.reap');
  assert.deepEqual(reapCalls[0].rows, [ghost], 'and was handed exactly the stale row');
  const text = log.text();
  assert.match(text, /1 stale registry entry/);
  assert.match(text, /cleared 1 entry\./);
  assert.match(text, /\(dead — registry entry is stale\)/,
    'the annotation that could never print before rows() read the registry raw');
});

// ------------------------------------------------ the tour pane, mounted ----
// The tour is the ONE piece of this feature that runs in a browser, on a fresh
// install, before Claude exists to notice anything is wrong. If its script
// throws at mount the user gets a dead card and no explanation, so it is mounted
// for real here — same shadow root, same runtime, same `new Function` — and both
// roles are driven through their evidence-based step transitions.

const { JSDOM } = require('jsdom');
const mountRuntime = require('../public/mount-runtime.js');

const TOUR_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'templates', 'components', 'web-chat-tour', 'component.html'), 'utf8');

function withDom(t) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const saved = { window: global.window, document: global.document, CustomEvent: global.CustomEvent, Event: global.Event };
  global.window = dom.window;
  global.document = dom.window.document;
  global.CustomEvent = dom.window.CustomEvent;
  global.Event = dom.window.Event;
  t.after(() => Object.assign(global, saved));
  return dom.window.document;
}

// Mount one tour pane into a shared store, exactly as public/app/mounts.js does.
function mountPane(document, store, params) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const { root, scripts } = mountRuntime.attachAndExtract(host, TOUR_HTML);
  const errors = [];
  mountRuntime.runScripts(root, scripts, store, params, params.role, (e) => errors.push(e));
  return { root, errors };
}

test('the tour pane mounts without throwing, in BOTH roles', (t) => {
  const document = withDom(t);
  const store = mountRuntime.createStore({});
  const guide = mountPane(document, store, { role: 'guide', step: 1, root: '/p', url: 'http://x', channel_connected: false });
  const mirror = mountPane(document, store, { role: 'mirror' });
  assert.deepEqual(guide.errors, [], 'guide script threw at mount');
  assert.deepEqual(mirror.errors, [], 'mirror script threw at mount');
  // The guide must be visible and on step 1; the mirror must be the other card.
  assert.equal(guide.root.getElementById('guide').style.display, 'block');
  assert.ok(guide.root.getElementById('c1').classList.contains('show'), 'step 1 is showing');
  assert.equal(mirror.root.getElementById('mirror').style.display, 'block');
});

test('tour step 1 advances only on the OTHER pane acknowledging through the store', (t) => {
  const document = withDom(t);
  const store = mountRuntime.createStore({});
  // Deliberately mount the guide ALONE first: with nothing subscribed to the
  // key, a click must not be mistaken for a completed round trip. (Mounting both
  // up front hides the difference — the mirror's ack lands in the same tick.)
  const guide = mountPane(document, store, { role: 'guide', root: '/p', url: 'http://x' });
  assert.ok(guide.root.getElementById('c1').classList.contains('show'), 'precondition: on step 1');

  guide.root.getElementById('tour_title').value = 'hello';
  guide.root.querySelector('.sw').dispatchEvent(new global.Event('click', { bubbles: true }));

  assert.ok(guide.root.getElementById('c1').classList.contains('show'),
    'writing the key is not the lesson — a second pane READING it is');
  const written = store.get('tour_scratch');
  assert.equal(written.color, '#0969da');
  assert.notEqual(written.ack, written.seq, 'nothing has acknowledged it yet');

  // Now the other pane appears. It repaints from the STORE — it holds no
  // reference to the guide — and its acknowledgement is what moves the guide on.
  const mirror = mountPane(document, store, { role: 'mirror' });
  assert.equal(mirror.root.getElementById('mbox').style.background, 'rgb(9, 105, 218)');
  assert.equal(mirror.root.getElementById('mtext').textContent, 'hello');
  const scratch = store.get('tour_scratch');
  assert.equal(scratch.ack, scratch.seq);
  assert.ok(guide.root.getElementById('c2').classList.contains('show'), 'advanced to step 2');
});

test('tour step 2 advances on a REMOUNT with the typed value restored — never on typing alone', (t) => {
  const document = withDom(t);
  const store = mountRuntime.createStore({ tour_scratch: { done: { s1: true } } });

  // First mount: type, but do not reload. Step 2 must NOT complete.
  const first = mountPane(document, store, { role: 'guide' });
  const note = first.root.getElementById('tour_note');
  note.value = 'my note';
  note.dispatchEvent(new global.Event('input', { bubbles: true }));
  assert.ok(first.root.getElementById('c2').classList.contains('show'), 'still on step 2 — typing alone proves nothing');

  // Second mount = the page reload. The shell rehydrates form_state AFTER the
  // script runs and dispatches `input`; that is the evidence the step waits for.
  const second = mountPane(document, store, { role: 'guide' });
  assert.equal(store.get('tour_scratch').mounts, 2, 'the mount counter saw the reload');
  const note2 = second.root.getElementById('tour_note');
  note2.value = 'my note';
  note2.dispatchEvent(new global.Event('input', { bubbles: true }));
  assert.ok(second.root.getElementById('c3').classList.contains('show'), 'advanced to step 3');
});

test('tour step 3 writes the declared web_chat_init signal, once, with a seq', (t) => {
  const document = withDom(t);
  const store = mountRuntime.createStore({ tour_scratch: { done: { s1: true, s2: true } } });
  const guide = mountPane(document, store, { role: 'guide', channel_connected: false });

  const send = guide.root.getElementById('send');
  assert.equal(send.disabled, true, 'Send is inert until a choice is made');

  guide.root.querySelector('.choice[data-choice="architecture"]').dispatchEvent(new global.Event('click', { bubbles: true }));
  assert.equal(send.disabled, false);
  send.dispatchEvent(new global.Event('click', { bubbles: true }));

  const sig = store.get('web_chat_init');
  assert.equal(sig.done, true);
  assert.equal(sig.choice, 'architecture');
  assert.ok(Number.isFinite(sig.seq), 'a bumping seq, so repeats are distinguishable');
  assert.ok(guide.root.getElementById('c4').classList.contains('show'), 'the closing card');
});

test('the tour tells the truth about Push when no channel is connected', (t) => {
  const document = withDom(t);
  const connected = mountPane(document, mountRuntime.createStore({}), { role: 'guide', channel_connected: true });
  const parked = mountPane(document, mountRuntime.createStore({}), { role: 'guide', channel_connected: false });
  assert.match(connected.root.getElementById('pushline').textContent, /Claude wakes up now/);
  assert.match(parked.root.getElementById('pushline').textContent, /delivers with your next message/);
});

test('every tour step offers a skip, so no step can dead-end', (t) => {
  const document = withDom(t);
  const store = mountRuntime.createStore({});
  const guide = mountPane(document, store, { role: 'guide' });
  for (const n of ['1', '2', '3']) {
    const card = guide.root.getElementById('c' + n);
    assert.ok(card.classList.contains('show'), `on step ${n}`);
    guide.root.querySelector(`.skip[data-skip="${n}"]`).dispatchEvent(new global.Event('click', { bubbles: true }));
  }
  assert.ok(guide.root.getElementById('c4').classList.contains('show'), 'skipping through reaches the closing card');
});

test('the tour pane script never touches `document` (it would not see the shadow root)', () => {
  const body = TOUR_HTML
    .slice(TOUR_HTML.indexOf('<script>'))
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))   // the rule is about code, not the comment explaining it
    .join('\n');
  assert.equal(/\bdocument\s*\./.test(body), false,
    'a pane script that queries `document` cannot see into its own shadow root and dies at mount');
});
