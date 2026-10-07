// The 0.8.5 hook template and the engine that registers it (spec §1.1–1.2):
// twelve events, fourteen handlers; handlers matched by SUBCOMMAND, so one event
// can carry two of ours (PreToolUse and PostToolUse hold the mirror's and the
// halt's); the per-handler fields the template owns (MANAGED_HOOK_KEYS); the
// `stale` state; roles for honest copy; and the MCP server's startup line.
//
// Every project here is a throwaway root under a throwaway HOME, and no test
// shells out to a real `claude` or starts a daemon.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const reg = require('../lib/setup/registration');
const mf = require('../lib/update/managed-files');
const { claudePaths, installPaths, PACKAGE_ROOT } = require('../lib/core/paths');
const { withTempHome, waitUntil } = require('../test-support/helpers');

// doctor probes the capture hub on the fixed hub port: pin it, for the whole
// file, at a port nothing listens on (as test/doctor.test.js does).
process.env.WEB_CHAT_HUB_PORT = '65533';

// `install` pre-warms a daemon through spawnDaemon, which it destructures at
// module load — so the patch goes in before the first require (the pattern
// test/install.test.js uses), and no test here forks a background server.
const daemonMod = require('../lib/util/daemon');
const realSpawnDaemon = daemonMod.spawnDaemon;
daemonMod.spawnDaemon = async () => null;
const install = require('../lib/cli/commands/install');
daemonMod.spawnDaemon = realSpawnDaemon;
const doctor = require('../lib/cli/commands/doctor');

// §1.2's template, exactly as the spec writes it.
const SPEC_TEMPLATE = {
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-begin' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-end' }] }],
    StopFailure: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-end', timeout: 30 }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook mirror', async: true, timeout: 10 }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook mirror' }] }],
    PreToolUse: [{ hooks: [
      { type: 'command', command: 'claude-web-chat-hook mirror', async: true, timeout: 10 },
      { type: 'command', command: 'claude-web-chat-hook halt pre', timeout: 5 },
    ] }],
    PostToolUse: [{ hooks: [
      { type: 'command', command: 'claude-web-chat-hook mirror', async: true, timeout: 10 },
      { type: 'command', command: 'claude-web-chat-hook halt post', timeout: 5 },
    ] }],
    PostToolUseFailure: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook mirror', async: true, timeout: 10 }] }],
    SubagentStop: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook mirror', async: true, timeout: 10 }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook mirror', async: true, timeout: 10 }] }],
    PermissionRequest: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook ask', timeout: 600 }] }],
    PostToolBatch: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook halt batch', timeout: 5 }] }],
  },
};

const HOOK_BIN = path.join(PACKAGE_ROOT, 'bin', 'claude-web-chat-hook.js');
const HALT_SCRIPT = path.join(PACKAGE_ROOT, 'lib', 'hooks', 'claude-web-chat-hook-halt.sh');

function tmpRoot(prefix = 'wc-hooks-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// A project findProjectRoot recognises: one with a .web-chat/.
function installedRoot(t) {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.web-chat', 'graph'), { recursive: true });
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  return root;
}

function fakeClaude() {
  const calls = [];
  return { fn: (argv) => { calls.push(argv); return { ok: true }; }, calls };
}

function settingsPath(root) {
  return claudePaths(root).settings;
}

function readSettings(root) {
  return JSON.parse(fs.readFileSync(settingsPath(root), 'utf8'));
}

function writeSettings(root, value) {
  fs.mkdirSync(path.dirname(settingsPath(root)), { recursive: true });
  fs.writeFileSync(settingsPath(root), JSON.stringify(value, null, 2) + '\n');
}

// The template with every command resolved to this tree — what a project holds
// once the engine has registered it.
function resolvedTemplate() {
  const out = {};
  for (const [event, groups] of Object.entries(mf.hookTemplate().hooks)) {
    out[event] = groups.map((g) => ({ ...g, hooks: g.hooks.map((h) => ({ ...h, command: mf.resolveHookCommand(h.command) })) }));
  }
  return out;
}

// The web-chat handlers on one event, in order, wherever their groups are.
function webChatHandlers(settings, event) {
  const out = [];
  for (const g of settings.hooks[event] || []) for (const h of g.hooks || []) if (mf.isWebChatHookCommand(h.command)) out.push(h);
  return out;
}

// What a project 0.8.0's install left behind: two events, resolved.
const V080_HOOKS = () => ({
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node "${HOOK_BIN}" turn-begin` }] }],
  Stop: [{ hooks: [{ type: 'command', command: `node "${HOOK_BIN}" turn-end` }] }],
});

const ALL_EVENTS = Object.keys(SPEC_TEMPLATE.hooks);
const HANDLER_COUNT = Object.values(SPEC_TEMPLATE.hooks).reduce((n, gs) => n + gs.reduce((m, g) => m + g.hooks.length, 0), 0);

// ── the template ─────────────────────────────────────────────────────────────

test('the template is §1.2 exactly: twelve events, fourteen handlers, in order', () => {
  const tpl = mf.hookTemplate();
  assert.deepStrictEqual(tpl, SPEC_TEMPLATE);
  assert.deepStrictEqual(Object.keys(tpl.hooks), ALL_EVENTS, 'event order is the spec\'s');
  assert.equal(ALL_EVENTS.length, 12);
  assert.equal(HANDLER_COUNT, 14);
  assert.deepStrictEqual(reg.hookEvents(), ALL_EVENTS, 'hookEvents() is the template\'s keys');
  assert.equal(reg.hookHandlers().length, 14);
  // §1.1's "on purpose" rules, pinned: no matcher anywhere, no http hook, and
  // PostToolBatch carries only the halt.
  for (const groups of Object.values(tpl.hooks)) {
    for (const g of groups) {
      assert.equal(g.matcher, undefined, 'there is no matcher anywhere');
      for (const h of g.hooks) assert.equal(h.type, 'command', 'never a type:"http" hook — the daemon\'s port walks');
    }
  }
  assert.deepStrictEqual(tpl.hooks.PostToolBatch[0].hooks.map((h) => h.command), ['claude-web-chat-hook halt batch']);
  // The turn lifecycle keeps 0.8.0's shape, so an existing install is not "stale" for it.
  const old = V080_HOOKS();
  for (const e of ['UserPromptSubmit', 'Stop']) {
    assert.deepStrictEqual(tpl.hooks[e].flatMap((g) => g.hooks).map((h) => Object.keys(h)), old[e].flatMap((g) => g.hooks).map((h) => Object.keys(h)));
  }
});

test('roles: every template handler has exactly one role, and every role is used', () => {
  const used = new Set();
  for (const h of reg.hookHandlers()) {
    const roles = Object.entries(reg.HOOK_ROLES).filter(([, r]) => r.subcommands.includes(h.sub)).map(([n]) => n);
    assert.equal(roles.length, 1, `${h.event} ${h.sub} has exactly one role (got ${roles.join(', ') || 'none'})`);
    assert.equal(h.role, roles[0]);
    assert.equal(reg.hookRole(h.handler), roles[0], 'hookRole reads the handler');
    assert.equal(reg.hookRole(mf.resolveHookCommand(h.handler.command)), roles[0], 'and its resolved command');
    used.add(roles[0]);
  }
  assert.deepStrictEqual([...used].sort(), Object.keys(reg.HOOK_ROLES).sort(), 'no role without a handler');
  const count = (role) => reg.hookHandlers().filter((h) => h.role === role).length;
  assert.equal(count('lifecycle'), 3);
  assert.equal(count('mirror'), 7);
  assert.equal(count('bridge'), 1);
  assert.equal(count('halt'), 3);
  assert.equal(reg.hookRole({ type: 'command', command: 'some-other-tool notify' }), null);
  assert.equal(reg.hookRole('claude-web-chat-hook no-such-sub'), null);
});

// ── resolving a command ──────────────────────────────────────────────────────

test('resolveHookCommand: a checkout resolves halt to `sh "<root>/lib/hooks/…-halt.sh" <event>`, idempotently', (t) => {
  withTempHome(t);
  for (const ev of ['pre', 'post', 'batch']) {
    const out = mf.resolveHookCommand(`claude-web-chat-hook halt ${ev}`);
    assert.equal(out, `sh "${HALT_SCRIPT}" ${ev}`);
    assert.equal(mf.resolveHookCommand(out), out, 'the resolved form is recognised as resolved');
    assert.ok(reg.hookCommandResolvable(out), 'and it names the script this tree ships');
    assert.match(out, /claude-web-chat-hook/, 'the script\'s name keeps the token every reader keys on');
  }
  assert.ok(fs.existsSync(HALT_SCRIPT));
  for (const sub of ['mirror', 'turn-begin', 'turn-end', 'ask']) {
    const out = mf.resolveHookCommand(`claude-web-chat-hook ${sub}`);
    assert.equal(out, `node "${HOOK_BIN}" ${sub}`, `${sub} still resolves to node "<stable bin>"`);
    assert.equal(mf.resolveHookCommand(out), out);
  }
});

test('resolveHookCommand: a MANAGED layout resolves every form to ~/.web-chat/current, never the version directory', (t) => {
  const home = withTempHome(t);
  const paths = installPaths();
  const vdir = path.join(paths.versions, '0.8.5');
  fs.mkdirSync(path.join(vdir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(vdir, 'lib', 'hooks'), { recursive: true });
  const opts = { packageRoot: vdir, paths };
  const current = path.join(home, '.web-chat', 'current');

  assert.equal(mf.stableRoot(opts), current);
  assert.equal(mf.stableBin('claude-web-chat-hook', opts), path.join(current, 'bin', 'claude-web-chat-hook.js'));
  const halt = mf.resolveHookCommand('claude-web-chat-hook halt pre', opts);
  assert.equal(halt, `sh "${path.join(current, 'lib', 'hooks', 'claude-web-chat-hook-halt.sh')}" pre`);
  assert.doesNotMatch(halt, /versions/, 'pruneVersions deletes that directory three updates later');
  assert.equal(mf.resolveHookCommand(halt, opts), halt);
  for (const sub of ['mirror', 'turn-begin', 'turn-end', 'ask']) {
    const out = mf.resolveHookCommand(`claude-web-chat-hook ${sub}`, opts);
    assert.equal(out, `node "${path.join(current, 'bin', 'claude-web-chat-hook.js')}" ${sub}`, `${sub}: node "<stable bin>"`);
    assert.equal(mf.resolveHookCommand(out, opts), out);
  }

  // A halt handler pinned to a pruned version, and a halt handler written in
  // the Node form, both come back to the one resolved form.
  const pinned = `sh "${path.join(paths.versions, '0.8.4', 'lib', 'hooks', 'claude-web-chat-hook-halt.sh')}" post`;
  assert.equal(mf.resolveHookCommand(pinned, opts), `sh "${path.join(current, 'lib', 'hooks', 'claude-web-chat-hook-halt.sh')}" post`);
  const nodeForm = `node "${path.join(current, 'bin', 'claude-web-chat-hook.js')}" halt batch`;
  assert.equal(mf.resolveHookCommand(nodeForm, opts), `sh "${path.join(current, 'lib', 'hooks', 'claude-web-chat-hook-halt.sh')}" batch`);
});

test('parseHookCommand reads each shape, and only ours', () => {
  assert.deepStrictEqual(mf.parseHookCommand('claude-web-chat-hook halt pre'),
    { runner: '', file: 'claude-web-chat-hook', kind: 'bare', sub: 'halt', args: 'pre' });
  assert.deepStrictEqual(mf.parseHookCommand('sh "/a b/lib/hooks/claude-web-chat-hook-halt.sh" post'),
    { runner: 'sh', file: '/a b/lib/hooks/claude-web-chat-hook-halt.sh', kind: 'halt', sub: 'halt', args: 'post' });
  assert.deepStrictEqual(mf.parseHookCommand('node /x/bin/claude-web-chat-hook.js turn-end'),
    { runner: 'node', file: '/x/bin/claude-web-chat-hook.js', kind: 'bin', sub: 'turn-end', args: '' });
  // A directory that merely contains the token is not the file.
  const dev = mf.parseHookCommand('node "/Users/a/claude-web-chat-hook-dev/bin/claude-web-chat-hook.js" mirror');
  assert.equal(dev.file, '/Users/a/claude-web-chat-hook-dev/bin/claude-web-chat-hook.js');
  assert.equal(dev.sub, 'mirror');
  assert.equal(mf.parseHookCommand('some-other-tool notify'), null);
  assert.equal(mf.parseHookCommand('sh /opt/other/halt.sh pre'), null);
  assert.equal(mf.parseHookCommand(undefined), null);
  assert.equal(mf.resolveHookCommand('sh /opt/other/halt.sh pre'), 'sh /opt/other/halt.sh pre', 'not ours: untouched');
  // A path with a space inside its quotes resolves (and reads as resolvable).
  assert.equal(reg.hookCommandResolvable(`node "${HOOK_BIN}" mirror`), true);
  assert.equal(reg.hookCommandResolvable('sh "/nonexistent/lib/hooks/claude-web-chat-hook-halt.sh" pre'), false);
  assert.equal(reg.hookCommandResolvable('claude-web-chat-hook halt pre'), false, 'bare: a PATH lookup');
});

// ── apply / inspect / remove ─────────────────────────────────────────────────

test('apply then inspect: every event and every handler ok, holding exactly the resolved template', (t) => {
  withTempHome(t);
  const root = installedRoot(t);
  const claude = fakeClaude();
  const out = reg.apply(root, { runClaude: claude.fn });
  assert.equal(out.hooks.added, HANDLER_COUNT, 'apply reports the handlers it added');
  assert.deepStrictEqual(out.hooks.events, ALL_EVENTS);

  const st = reg.inspect(root);
  for (const e of ALL_EVENTS) assert.equal(st.hooks[e], 'ok', `${e} ok`);
  assert.equal(st.handlers.length, HANDLER_COUNT);
  assert.ok(st.handlers.every((r) => r.state === 'ok'), JSON.stringify(st.handlers.filter((r) => r.state !== 'ok')));
  assert.deepStrictEqual(reg.hookProblems(st), []);
  assert.equal(reg.driftLine(st), null, 'nothing to nudge about');
  assert.deepStrictEqual(readSettings(root).hooks, resolvedTemplate());

  const before = fs.readFileSync(settingsPath(root), 'utf8');
  assert.equal(reg.applyHooks(root).added, 0, 'a second pass adds nothing');
  assert.equal(fs.readFileSync(settingsPath(root), 'utf8'), before, 'and rewrites the file byte for byte');
});

test('ensureHooks returns the count of handlers ADDED: fresh, 0.8.0, again, and dry', (t) => {
  withTempHome(t);
  const fresh = installedRoot(t);
  assert.equal(mf.ensureHooks(fresh, { dryRun: true }), HANDLER_COUNT, 'a dry run reports what it would add');
  assert.equal(fs.existsSync(settingsPath(fresh)), false, 'and writes nothing');
  assert.equal(mf.ensureHooks(fresh), HANDLER_COUNT);
  assert.equal(mf.ensureHooks(fresh), 0);

  const old = installedRoot(t);
  writeSettings(old, { hooks: V080_HOOKS() });
  const before = fs.readFileSync(settingsPath(old), 'utf8');
  assert.equal(mf.ensureHooks(old, { dryRun: true }), HANDLER_COUNT - 2);
  assert.equal(fs.readFileSync(settingsPath(old), 'utf8'), before, 'dry: untouched');
  assert.equal(mf.ensureHooks(old), HANDLER_COUNT - 2, 'a 0.8.0 project gains the twelve it lacks');
  assert.equal(mf.ensureHooks(old), 0);
});

test('mergeHooks also counts the handlers it rewrote: a repair, a bare command, a command from another tree', (t) => {
  const home = withTempHome(t);

  // A bare 0.7-era project: two PATH lookups to resolve, twelve handlers to add.
  const bare = installedRoot(t);
  writeSettings(bare, { hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-begin' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-end' }] }],
  } });
  const before = fs.readFileSync(settingsPath(bare), 'utf8');
  assert.deepStrictEqual(mf.mergeHooks(bare, { dryRun: true }), { added: HANDLER_COUNT - 2, updated: 2 });
  assert.equal(fs.readFileSync(settingsPath(bare), 'utf8'), before, 'dry: untouched');
  assert.deepStrictEqual(mf.mergeHooks(bare), { added: HANDLER_COUNT - 2, updated: 2 });
  assert.deepStrictEqual(mf.mergeHooks(bare), { added: 0, updated: 0 }, 'a second pass changes nothing');

  // 0.8.0's two handlers, resolved to this tree, are already right.
  const old = installedRoot(t);
  writeSettings(old, { hooks: V080_HOOKS() });
  assert.deepStrictEqual(mf.mergeHooks(old), { added: HANDLER_COUNT - 2, updated: 0 });

  // A repair only: one managed field, one field the template does not set.
  const stale = installedRoot(t);
  reg.apply(stale, { runClaude: fakeClaude().fn });
  const s = readSettings(stale);
  s.hooks.PreToolUse[0].hooks[0].timeout = 3;
  s.hooks.SessionEnd[0].hooks[0].statusMessage = 'bye';
  s.hooks.Notification = [{ hooks: [{ type: 'command', command: 'say done', timeout: 1 }] }];
  writeSettings(stale, s);
  const applied = reg.applyHooks(stale);
  assert.deepStrictEqual({ added: applied.added, updated: applied.updated }, { added: 0, updated: 2 }, 'another tool\'s handler is never counted');
  assert.deepStrictEqual(applied.events, ALL_EVENTS);

  // Registered from ~/.web-chat/current while this build runs from a checkout:
  // inspect() reads it ok (the same shapes), but every command is re-pointed at
  // this tree, and the count says so.
  const elsewhere = installedRoot(t);
  const opts = { packageRoot: path.join(home, '.web-chat', 'versions', '0.8.5'), paths: installPaths() };
  const hooks = {};
  for (const [event, groups] of Object.entries(mf.hookTemplate().hooks)) {
    hooks[event] = groups.map((g) => ({ hooks: g.hooks.map((h) => ({ ...h, command: mf.resolveHookCommand(h.command, opts) })) }));
  }
  writeSettings(elsewhere, { hooks });
  assert.deepStrictEqual(reg.apply(elsewhere, { dryRun: true, runClaude: fakeClaude().fn }).hooks,
    { added: 0, updated: HANDLER_COUNT, events: ALL_EVENTS });
});

test('install names a repair: "N hook(s) updated", then "already up to date"', async (t) => {
  withTempHome(t);
  const root = installedRoot(t);
  reg.apply(root, { runClaude: fakeClaude().fn });
  const s = readSettings(root);
  s.hooks.PostToolUse[0].hooks[1].timeout = 60;                     // stale: a managed field
  s.hooks.Stop[0].hooks[0].command = 'claude-web-chat-hook turn-end'; // bare: a PATH lookup
  writeSettings(root, s);

  const settingsLine = async () => {
    const lines = [];
    const prevLog = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      await install([], { cwd: root, runClaude: fakeClaude().fn, restartIfStale: async () => ({ restarted: false }), nextSteps: false });
    } finally {
      console.log = prevLog;
    }
    return lines.find((l) => /^ {2}\.claude\/settings\.json /.test(l));
  };
  assert.match(await settingsLine(), /^ {2}\.claude\/settings\.json +2 hook\(s\) updated$/);
  assert.ok(reg.inspect(root).handlers.every((r) => r.state === 'ok'), 'both repaired');
  assert.match(await settingsLine(), /^ {2}\.claude\/settings\.json +already up to date$/, 'and then there is nothing to do');

  // The same two edits again, and the PostToolBatch handler gone as well.
  delete s.hooks.PostToolBatch;
  writeSettings(root, s);
  assert.match(await settingsLine(), /^ {2}\.claude\/settings\.json +1 hook\(s\) added, 2 hook\(s\) updated$/);
});

test('a project with only 0.8.0\'s two events reports the other ten missing', (t) => {
  withTempHome(t);
  const root = installedRoot(t);
  writeSettings(root, { hooks: V080_HOOKS() });
  const st = reg.inspect(root);
  assert.equal(st.hooks.UserPromptSubmit, 'ok');
  assert.equal(st.hooks.Stop, 'ok');
  for (const e of ALL_EVENTS.slice(2)) assert.equal(st.hooks[e], 'missing', `${e} missing`);
  assert.equal(st.handlers.filter((r) => r.state === 'ok').length, 2);
  assert.equal(st.handlers.filter((r) => r.state === 'missing').length, HANDLER_COUNT - 2);

  const problems = reg.hookProblems(st);
  const by = (role) => problems.find((p) => p.role === role);
  assert.deepStrictEqual(problems.map((p) => [p.role, p.state]), [['lifecycle', 'missing'], ['mirror', 'missing'], ['bridge', 'missing'], ['halt', 'missing']]);
  assert.deepStrictEqual(by('lifecycle').events, ['StopFailure']);
  assert.match(by('lifecycle').effect, /API error .* turn lock until it times out/,
    'StopFailure alone does not stop turns beginning or committing — the narrower cost is named');
  assert.deepStrictEqual(by('mirror').events, ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStop', 'PreCompact']);
  assert.deepStrictEqual(by('bridge').events, ['PermissionRequest']);
  assert.deepStrictEqual(by('halt').events, ['PreToolUse', 'PostToolUse', 'PostToolBatch']);
});

test('install and update upgrade a 0.8.0 project to exactly the template, leaving everything else alone', async (t) => {
  withTempHome(t);
  for (const via of ['install', 'update']) {
    const root = installedRoot(t);
    const other = { type: 'command', command: 'other-tool guard', timeout: 3 };
    const before = {
      permissions: { allow: ['Bash(ls:*)'] },
      env: { FOO: 'bar' },
      statusLine: { type: 'command', command: 'my-statusline' },
      hooks: {
        ...V080_HOOKS(),
        PreToolUse: [{ matcher: 'Bash', hooks: [other] }],
        Notification: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      },
    };
    before.hooks.Stop.push({ hooks: [{ type: 'command', command: 'other-tool on-stop' }] });
    writeSettings(root, before);

    if (via === 'install') {
      const prevLog = console.log;
      console.log = () => {};
      try {
        await install([], { cwd: root, runClaude: fakeClaude().fn, restartIfStale: async () => ({ restarted: false }), nextSteps: false });
      } finally {
        console.log = prevLog;
      }
    } else {
      // What `update` runs once it has loaded the new build's engine: apply(),
      // with a runClaude that records rather than runs (lib/cli/commands/update.js).
      const applied = reg.apply(root, { force: false, runClaude: () => ({ ok: false, stderr: 'not attempted by update' }) });
      assert.equal(applied.hooks.added, HANDLER_COUNT - 2, 'update: the twelve handlers 0.8.0 lacked');
    }

    const after = readSettings(root);
    for (const key of ['permissions', 'env', 'statusLine']) assert.deepStrictEqual(after[key], before[key], `${via}: ${key} untouched`);
    assert.deepStrictEqual(after.hooks.Notification, before.hooks.Notification, `${via}: an event the template does not name is untouched`);
    assert.deepStrictEqual(after.hooks.PreToolUse[0], { matcher: 'Bash', hooks: [other] }, `${via}: another tool's PreToolUse handler is untouched`);
    assert.deepStrictEqual(after.hooks.Stop[1], before.hooks.Stop[1], `${via}: another tool's Stop handler is untouched`);
    const want = resolvedTemplate();
    for (const e of ALL_EVENTS) {
      const wantHandlers = want[e].flatMap((g) => g.hooks);
      assert.deepStrictEqual(webChatHandlers(after, e), wantHandlers, `${via}: ${e} holds exactly the template's handlers`);
    }
    const st = reg.inspect(root);
    assert.ok(st.handlers.every((r) => r.state === 'ok'), `${via}: everything ok afterwards`);
  }
});

test('a mirror handler with a wrong timeout is stale, and apply repairs only the managed fields', (t) => {
  withTempHome(t);
  const root = installedRoot(t);
  reg.apply(root, { runClaude: fakeClaude().fn });
  const s = readSettings(root);
  const mirror = s.hooks.PreToolUse[0].hooks[0];
  assert.match(mirror.command, /mirror$/);
  mirror.timeout = 3;
  mirror.note = 'mine';                      // not a managed key: the user's
  const sessionStart = s.hooks.SessionStart[0].hooks[0];
  delete sessionStart.async;                 // a managed key the template sets, removed
  sessionStart.statusMessage = 'hello';      // a managed key the template does not set
  writeSettings(root, s);

  const st = reg.inspect(root);
  assert.equal(st.hooks.PreToolUse, 'stale');
  assert.equal(st.hooks.SessionStart, 'stale');
  const row = (event, sub) => st.handlers.find((r) => r.event === event && r.sub === sub);
  assert.equal(row('PreToolUse', 'mirror').state, 'stale');
  assert.deepStrictEqual(row('PreToolUse', 'mirror').differs, ['timeout']);
  assert.equal(row('PreToolUse', 'halt').state, 'ok', 'the other handler on the event is not dragged along');
  assert.deepStrictEqual(row('SessionStart', 'mirror').differs, ['async', 'statusMessage']);
  assert.match(reg.driftLine(st), /stale: SessionStart, PreToolUse \(mirror\)/);

  assert.equal(reg.applyHooks(root).added, 0, 'a repair adds nothing');
  const fixed = readSettings(root);
  assert.equal(fixed.hooks.PreToolUse[0].hooks[0].timeout, 10);
  assert.equal(fixed.hooks.PreToolUse[0].hooks[0].note, 'mine', 'other keys are the user\'s');
  assert.equal(fixed.hooks.SessionStart[0].hooks[0].async, true);
  assert.equal('statusMessage' in fixed.hooks.SessionStart[0].hooks[0], false, 'a managed key the template lacks is deleted');
  assert.ok(reg.inspect(root).handlers.every((r) => r.state === 'ok'));
});

test('an event holding the mirror handler but not the halt one is stale; apply adds only the halt (count 1)', (t) => {
  withTempHome(t);
  const root = installedRoot(t);
  reg.apply(root, { runClaude: fakeClaude().fn });
  const s = readSettings(root);
  s.hooks.PreToolUse[0].hooks = s.hooks.PreToolUse[0].hooks.filter((h) => !/halt/.test(h.command));
  writeSettings(root, s);

  const st = reg.inspect(root);
  assert.equal(st.hooks.PreToolUse, 'stale', 'an event missing one of its template handlers');
  assert.equal(st.handlers.find((r) => r.event === 'PreToolUse' && r.sub === 'mirror').state, 'ok');
  assert.equal(st.handlers.find((r) => r.event === 'PreToolUse' && r.sub === 'halt').state, 'missing');
  assert.deepStrictEqual(reg.hookProblems(st).map((p) => [p.role, p.state, p.events]), [['halt', 'missing', ['PreToolUse']]]);
  assert.match(reg.driftLine(st), /missing: PreToolUse \(halt\)/);

  assert.equal(reg.applyHooks(root).added, 1);
  assert.deepStrictEqual(readSettings(root).hooks.PreToolUse, resolvedTemplate().PreToolUse,
    'beside the mirror handler, in the template\'s own shape — not a second group');
  assert.ok(reg.inspect(root).handlers.every((r) => r.state === 'ok'));
});

test('a halt handler in the Node form is stale (its shape), and apply rewrites it to the script', (t) => {
  withTempHome(t);
  const root = installedRoot(t);
  reg.apply(root, { runClaude: fakeClaude().fn });
  const s = readSettings(root);
  s.hooks.PostToolBatch[0].hooks[0].command = `node "${HOOK_BIN}" halt batch`;
  writeSettings(root, s);
  const st = reg.inspect(root);
  const row = st.handlers.find((r) => r.event === 'PostToolBatch');
  assert.equal(row.state, 'stale', 'the bin exists, but the Node dispatcher ignores `halt`');
  assert.deepStrictEqual(row.differs, ['command']);
  reg.applyHooks(root);
  assert.equal(readSettings(root).hooks.PostToolBatch[0].hooks[0].command, `sh "${HALT_SCRIPT}" batch`);
});

test('a project registered from another tree reads ok: a different path to the same shape is not drift', (t) => {
  const home = withTempHome(t);
  const root = installedRoot(t);
  // The dogfooding case: settings point at ~/.web-chat/current, status runs from a checkout.
  const current = path.join(home, '.web-chat', 'current');
  fs.mkdirSync(path.join(current, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(current, 'lib', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(current, 'bin', 'claude-web-chat-hook.js'), '');
  fs.writeFileSync(path.join(current, 'lib', 'hooks', 'claude-web-chat-hook-halt.sh'), '');
  const opts = { packageRoot: path.join(home, '.web-chat', 'versions', '0.8.5'), paths: installPaths() };
  const hooks = {};
  for (const [event, groups] of Object.entries(mf.hookTemplate().hooks)) {
    hooks[event] = groups.map((g) => ({ hooks: g.hooks.map((h) => ({ ...h, command: mf.resolveHookCommand(h.command, opts) })) }));
  }
  writeSettings(root, { hooks });
  const st = reg.inspect(root);
  assert.ok(st.handlers.every((r) => r.state === 'ok'), JSON.stringify(st.handlers.filter((r) => r.state !== 'ok')));
});

test('a bare 0.7-era project reads bare, and apply resolves it and adds the rest', (t) => {
  withTempHome(t);
  const root = installedRoot(t);
  writeSettings(root, { hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-begin' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-end' }] }],
  } });
  const st = reg.inspect(root);
  assert.equal(st.hooks.UserPromptSubmit, 'bare');
  assert.deepStrictEqual(reg.hookProblems(st).filter((p) => p.state === 'bare').map((p) => [p.role, p.events]),
    [['lifecycle', ['UserPromptSubmit', 'Stop']]]);
  assert.match(reg.driftLine(st), /bare: UserPromptSubmit, Stop/);
  assert.equal(reg.applyHooks(root).added, HANDLER_COUNT - 2);
  assert.deepStrictEqual(readSettings(root).hooks, resolvedTemplate());
});

test('remove takes every web-chat handler and nothing else', (t) => {
  withTempHome(t);
  const root = installedRoot(t);
  const otherInOurGroup = { type: 'command', command: 'other-tool after-mirror' };
  writeSettings(root, {
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool guard' }] }],
      Notification: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    },
  });
  reg.apply(root, { runClaude: fakeClaude().fn });
  // Another tool's handler inside OUR group: it must survive its group losing ours.
  const s = readSettings(root);
  s.hooks.PostToolUse[0].hooks.push(otherInOurGroup);
  writeSettings(root, s);

  const out = reg.remove(root, { runClaude: fakeClaude().fn });
  assert.equal(out.hooks.removed, HANDLER_COUNT, 'every one of the fourteen');
  assert.deepStrictEqual(out.hooks.events, ALL_EVENTS);
  const after = readSettings(root);
  assert.deepStrictEqual(after.permissions, { allow: ['Bash(ls:*)'] });
  assert.deepStrictEqual(after.hooks, {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool guard' }] }],
    Notification: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    PostToolUse: [{ hooks: [otherInOurGroup] }],
  });
  for (const e of ALL_EVENTS) assert.equal(webChatHandlers(after, e).length, 0, `${e}: none of ours left`);
});

test('a malformed hooks list is refused, not silently replaced', (t) => {
  withTempHome(t);
  const root = installedRoot(t);
  writeSettings(root, { hooks: { PreToolUse: { not: 'a list' } } });
  assert.throws(() => mf.ensureHooks(root), (e) => e.userFacing === true && /hooks\.PreToolUse is not a list/.test(e.message));
  assert.deepStrictEqual(readSettings(root).hooks.PreToolUse, { not: 'a list' });
});

// ── doctor's words, per role ─────────────────────────────────────────────────

async function runDoctor(root, opts = {}) {
  return doctor([], { cwd: root, runClaude: fakeClaude().fn, log: () => {}, findChrome: () => null, findFfmpeg: () => null, ...opts });
}

// doctor's hook repair line, told apart by its own opening words. A bare /hook/
// also matched doctor's MCP repair line ('register web-chat at local scope:
// claude mcp add … <checkout>/bin/claude-web-chat-mcp.js') whenever the checkout
// path held 'hook', so these tests went red in a worktree named for a hook unit.
const HOOK_REPAIR = /^(?:rewrote the web-chat hook command\(s\)|registered the missing hook\(s\)|updated the outdated hook\(s\))/;

function hookRepair(summary) {
  const found = summary.checks.filter((c) => c.status === 'repaired' && HOOK_REPAIR.test(c.m));
  assert.equal(found.length, 1, `one hook repair in:\n${summary.checks.map((c) => `${c.status}: ${c.m}`).join('\n')}`);
  return found[0];
}

function seedMcp(root) {
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({
    mcpServers: { 'web-chat': { command: 'node', args: [path.join(PACKAGE_ROOT, 'bin', 'claude-web-chat-mcp.js')] } },
  }, null, 2));
}

test('doctor words each role: what a 0.8.0 project lacks, and what that costs', async (t) => {
  withTempHome(t);
  const root = installedRoot(t);
  seedMcp(root);
  writeSettings(root, { hooks: V080_HOOKS() });
  const before = fs.readFileSync(settingsPath(root), 'utf8');

  const summary = await runDoctor(root, { dryRun: true });
  const problems = summary.checks.filter((c) => c.status === 'problem').map((c) => c.m);
  const has = (re) => assert.ok(problems.some((m) => re.test(m)), `${re} in:\n${problems.join('\n')}`);
  has(/^lifecycle hook\(s\) missing for StopFailure — a turn that ends on an API error holds the turn lock until it times out$/);
  has(/^mirror hook\(s\) missing for SessionStart, SessionEnd, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStop, PreCompact — the chat mirror shows no live tool status$/);
  has(/^bridge hook\(s\) missing for PermissionRequest — prompts cannot be answered from the browser$/);
  has(/^halt hook\(s\) missing for PreToolUse, PostToolUse, PostToolBatch — "Stop after this step" from the browser does nothing$/);
  assert.ok(!problems.some((m) => /turns never begin/.test(m)), 'a 0.8.0 project still begins and commits its turns');
  const repair = hookRepair(summary);
  assert.ok(repair && repair.dry);
  assert.match(repair.m, /registered the missing hook\(s\): StopFailure, SessionStart, SessionEnd, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStop, PreCompact, PermissionRequest, PostToolBatch/);
  assert.match(repair.m, /then restart Claude Code \(or open \/hooks to review them\)$/);
  assert.equal(fs.readFileSync(settingsPath(root), 'utf8'), before, 'a dry run writes nothing');

  await runDoctor(root);
  assert.ok(reg.inspect(root).handlers.every((r) => r.state === 'ok'), 'a real run repairs it');
  const again = await runDoctor(root);
  assert.ok(again.checks.some((c) => c.status === 'ok' && c.m === '14 web-chat hook handlers on 12 events registered and resolvable (lifecycle, mirror, bridge, halt)'));
});

test('the hook repair is found by its wording, never by a checkout path that holds "hook"', async (t) => {
  withTempHome(t);
  const root = installedRoot(t);
  seedMcp(root);
  writeSettings(root, { hooks: V080_HOOKS() });
  const summary = await runDoctor(root, { dryRun: true });
  const mcp = summary.checks.find((c) => c.status === 'repaired' && /^register web-chat at local scope: /.test(c.m));
  assert.ok(mcp && mcp.m.includes(PACKAGE_ROOT), 'doctor\'s MCP repair line carries the checkout path');
  // The same line as doctor words it from a worktree like wc085-ask-hook.
  const hooky = mcp.m.split(PACKAGE_ROOT).join(path.join(path.dirname(PACKAGE_ROOT), 'wc085-ask-hook'));
  assert.ok(/hook/.test(hooky), 'the old bare /hook/ find would take it');
  assert.ok(!HOOK_REPAIR.test(hooky), 'the anchored find does not');
  assert.equal(hookRepair({ checks: [{ status: 'repaired', m: hooky }, ...summary.checks] }), hookRepair(summary));
});

test('doctor words lifecycle in full where turns really stop, and names stale and bare handlers', async (t) => {
  withTempHome(t);
  const root = installedRoot(t);
  seedMcp(root);
  reg.apply(root, { runClaude: fakeClaude().fn });
  const s = readSettings(root);
  delete s.hooks.Stop;
  s.hooks.UserPromptSubmit[0].hooks[0].command = 'claude-web-chat-hook turn-begin';
  s.hooks.PostToolUse[0].hooks[1].timeout = 60;
  s.hooks.PostToolBatch[0].hooks[0].command = `node "${HOOK_BIN}" halt batch`;
  writeSettings(root, s);

  const summary = await runDoctor(root, { dryRun: true });
  const problems = summary.checks.filter((c) => c.status === 'problem').map((c) => c.m);
  const has = (re) => assert.ok(problems.some((m) => re.test(m)), `${re} in:\n${problems.join('\n')}`);
  has(/^lifecycle hook\(s\) missing for Stop — turns never begin or never commit$/);
  has(/^lifecycle hook\(s\) use a bare PATH-dependent command \(UserPromptSubmit\) — it only runs where the package is on PATH, so turns never begin or never commit$/);
  has(/^halt hook\(s\) on PostToolUse, PostToolBatch differ from this build's template \(timeout, command\) — as registered, "Stop after this step" from the browser does nothing$/);
  const repair = hookRepair(summary);
  assert.match(repair.m, /^rewrote the web-chat hook command\(s\) to absolute paths; registered the missing hook\(s\): Stop; updated the outdated hook\(s\) on PostToolUse, PostToolBatch — then restart Claude Code/);
});

// ── the MCP server's startup line ────────────────────────────────────────────

test('driftLine names missing, bare and stale hooks, and leaves a healthy project alone', (t) => {
  withTempHome(t);
  const root = installedRoot(t);
  reg.apply(root, { runClaude: fakeClaude().fn });
  assert.equal(reg.driftLine(reg.inspect(root)), null);

  writeSettings(root, { hooks: V080_HOOKS() });
  assert.equal(reg.driftLine(reg.inspect(root)),
    'Claude Code hooks out of date (missing: StopFailure, SessionStart, SessionEnd, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStop, PreCompact, PermissionRequest, PostToolBatch) — run `claude-web-chat install`, then restart Claude Code (or open /hooks to review them)');

  // Managed-file drift alone keeps its own line, with no restart advice.
  assert.equal(reg.driftLine({ managed: [{ action: 'updated' }], hooksFile: 'ok', handlers: [] }),
    'managed files out of date — run `claude-web-chat install`');
  // A pending sidecar the user already knows about does not nudge.
  assert.equal(reg.driftLine({ managed: [{ action: 'kept-edited', pending: true }], hooksFile: 'ok', handlers: [] }), null);
  // An unparseable settings.json is doctor's and status's to report.
  fs.writeFileSync(settingsPath(root), '{ not json');
  const st = reg.inspect(root);
  assert.equal(st.hooksFile, 'unparseable');
  assert.equal(reg.driftLine(st), null);
});

test('the MCP server says so at startup: its stderr line names the missing and stale hooks', async (t) => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const home = tmpRoot('wc-hooks-home-');
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  // A fresh update-check record, so the server's throttled release check stays offline.
  fs.mkdirSync(path.join(home, '.web-chat'), { recursive: true });
  fs.writeFileSync(path.join(home, '.web-chat', 'update-check.json'), JSON.stringify({ last_check: Date.now(), latest: null }));
  const root = installedRoot(t);
  const hooks = V080_HOOKS();
  hooks.PreToolUse = [{ hooks: [{ type: 'command', command: `node "${HOOK_BIN}" mirror`, timeout: 10 }] }];
  writeSettings(root, { hooks });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PACKAGE_ROOT, 'bin', 'claude-web-chat-mcp.js')],
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, WEB_CHAT_CHANNEL: '' },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (c) => { stderr += c; });
  const client = new Client({ name: 'hook-drift-test', version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());

  const line = await waitUntil(() => stderr.split('\n').find((l) => /hooks out of date/.test(l)), { timeout: 10000, what: 'the drift line' });
  assert.match(line, /^\[claude-web-chat\] /);
  assert.match(line, /missing: StopFailure, SessionStart, SessionEnd, PreToolUse \(halt\), PostToolUse, /);
  assert.match(line, /stale: PreToolUse \(mirror\)/);
  assert.match(line, /run `claude-web-chat install`, then restart Claude Code \(or open \/hooks to review them\)$/);
});
