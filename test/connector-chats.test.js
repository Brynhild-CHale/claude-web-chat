// Chats (contract 06 C-06.14 to C-06.19, C-06.22, C-06.25; A-06.2's
// 06-chat-assignment.json; 11 C-11.4, C-11.6; U720): lib/connector/chats.js.
//
// Pins: a space root is <workdir>/spaces/<label>, 0700, and a repo root
// <workdir>/repos/<label> cloned through createGitRunner with exactly
// `clone [--branch <ref>] -- <url> <root>` from <workdir>/repos; both are then
// set up by the init child with exactly C-06.16's flags; the mapping is
// 06-connector-state's $defs/chat with instance = instanceId(root); every
// refusal C-06.15 to C-06.17 names is a code, with no path and no git text in
// the outcome or the log; assignments apply per chat in rev order and an
// applied rev is ignored; stopped, removed and a connector launch do what the
// schema and ruling U720@connector-launch-reason (a) say.
//
// Every case runs in a throwaway HOME (withTempHome, under
// test-support/sandbox.js) with a paired record for hub-one. No real git and
// no real init run: git is a stub script behind createGitRunner({bin}) that
// records its argv and cwd and makes <root>/.git; init is a stub function that
// records its argv and makes <root>/.web-chat/. The lifecycle is a stub. Nothing
// dials, nothing binds a port, no daemon starts.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { withTempHome } = require('../test-support/helpers');
const conn = require('../lib/setup/connector');
const { createChats, INIT_FLAGS, assignmentProblem } = require('../lib/connector/chats');
const { createGitRunner, GIT_FLAGS } = require('../lib/server/git-run');
const { instanceId } = require('../lib/util/registry');
const { userPaths } = require('../lib/core/paths');
const { createValidator } = require('../test-support/contracts-loader');

const validator = createValidator();

const REPO = path.resolve(__dirname, '..');
const HUB = 'hub-one';
const URL_OK = 'https://github.com/example/widgets';
const STDERR_TEXT = 'fatal: could-not-read-SECRETTEXT /private/where/it/lives';

const real = (p) => fs.realpathSync.native(p);
const recordFile = () => userPaths().connectorRecord(HUB);
const recordBytes = () => fs.readFileSync(recordFile(), 'utf8');
const recordNow = () => JSON.parse(recordBytes());
const modeOf = (p) => fs.statSync(p).mode & 0o777;

// A 26-character chat label in contract 03's alphabet.
const label = (tail) => `${'0'.repeat(26 - tail.length)}${tail}`;

function assignment(lbl, over = {}) {
  return {
    v: 1,
    chat_id: lbl,
    rev: 1,
    issued_at: 1793177400000,
    scope: { kind: 'space' },
    desired: 'running',
    agent: { want: 'session', launch: 'manual', requested_by: 'user' },
    origins: {
      surface: `https://chat-${lbl}.hub.example.com`,
      answer: `https://chat-${lbl}-a.hub.example.com`,
      shell: 'https://hub.example.com',
    },
    ...over,
  };
}

// A sandbox HOME holding a paired record for hub-one that accepts new chats.
function paired(t, { settings = {}, workdir } = {}) {
  const home = withTempHome(t);
  const record = conn.newRecord({ hubId: HUB, origin: 'https://hub.example.com', ...(workdir ? { workdir: workdir(home) } : {}) });
  record.credential = { state: 'paired', paired_at: 1793177400000 };
  record.settings = { ...record.settings, accept_new_chats: true, agents_at_once: 2, ...settings };
  conn.writeRecord(record);
  return { home, workdir: record.workdir };
}

function editRecord(fn) {
  conn.updateRecord(HUB, (r) => { fn(r); return r; });
}

// An offered folder (with a .web-chat/ unless `bare`), written into the record.
function offered(home, rel, { bare = false, id = 'f_0123456789abcdef' } = {}) {
  const dir = path.join(home, ...rel.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  if (!bare) fs.mkdirSync(path.join(dir, '.web-chat'));
  const p = real(dir);
  editRecord((r) => r.folders.push({ id, path: p, display: `~/${rel}`, access: 'read-write', offered_at: 1 }));
  return { dir: p, id };
}

// A stub git: records each call's argv and cwd in calls.json beside itself;
// exiting 0 it makes <last arg>/.git, else it writes STDERR_TEXT and exits.
function stubGit(t, { exit = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(userPaths().root, '..', 'stub-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'stub-git');
  const log = path.join(dir, 'calls.json');
  fs.writeFileSync(bin, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    "const path = require('path');",
    `const log = ${JSON.stringify(log)};`,
    "const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [];",
    'const argv = process.argv.slice(2);',
    'calls.push({ argv, cwd: process.cwd() });',
    'fs.writeFileSync(log, JSON.stringify(calls));',
    exit === 0
      ? "fs.mkdirSync(path.join(argv[argv.length - 1], '.git'), { recursive: true });"
      : `process.stderr.write(${JSON.stringify(STDERR_TEXT)}); process.exit(${exit});`,
  ].join('\n'), { mode: 0o755 });
  const calls = () => (fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : []);
  return { git: createGitRunner({ bin }), calls };
}

// A stub init: records each call and makes <root>/.web-chat/ (unless it fails).
function stubInit({ exit = 0 } = {}) {
  const calls = [];
  const fn = async (root, flags, opts) => {
    calls.push({ root, flags, opts });
    if (exit === 0) fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
    return exit;
  };
  fn.calls = calls;
  return fn;
}

const noGit = () => { throw new Error('git ran'); };
const noInit = async () => { throw new Error('init ran'); };

function stubLifecycle({ run = { state: 'running', port: 41000, pid: 4242, started_by: 'connector' } } = {}) {
  const calls = [];
  return {
    calls,
    run: async (chat) => { calls.push(['run', chat]); return typeof run === 'function' ? run(chat) : run; },
    stop: async (chat, mode) => { calls.push(['stop', chat, mode]); return { released: true, shutdown: mode === 'now' }; },
  };
}

function make(t, { git = noGit, runInit = noInit, lifecycle = stubLifecycle() } = {}) {
  const lines = [];
  const chats = createChats({ lifecycle, hubId: HUB, log: (l) => lines.push(l), deps: { git, runInit, now: () => 1793177500000 } });
  return { chats, lines, lifecycle };
}

const chatOf = (lbl) => recordNow().chats.find((c) => c.chat_id === lbl);

test('a space: <workdir>/spaces/<label> made 0700, init with exactly C-06.16\'s flags, the mapping recorded, the daemon run', async (t) => {
  const { workdir } = paired(t);
  const runInit = stubInit();
  const { chats, lifecycle } = make(t, { runInit });
  const lbl = label('a1');
  const a = assignment(lbl);
  const o = await chats.apply(a);
  assert.deepStrictEqual(o, { chat_id: lbl, rev: 1, state: 'running' });

  const root = path.join(workdir, 'spaces', lbl);
  assert.ok(fs.statSync(root).isDirectory());
  assert.strictEqual(modeOf(root), 0o700);
  assert.strictEqual(modeOf(path.join(workdir, 'spaces')), 0o700);
  assert.strictEqual(modeOf(workdir), 0o700);

  assert.strictEqual(runInit.calls.length, 1);
  assert.strictEqual(runInit.calls[0].root, real(root));
  assert.deepStrictEqual(runInit.calls[0].flags, ['--yes', '--no-input', '--no-open', '--no-tour', '--no-warm', '--register-mcp']);
  assert.deepStrictEqual([...INIT_FLAGS], runInit.calls[0].flags);
  assert.strictEqual(runInit.calls[0].opts.stdio, 'ignore');

  assert.deepStrictEqual(chatOf(lbl), {
    chat_id: lbl,
    rev: 1,
    scope_kind: 'space',
    root: real(root),
    instance: instanceId(real(root)),
    owned_root: true,
    desired: 'running',
    manual_attach_at: null,
    assigned_at: 1793177500000,
  });
  assert.strictEqual(lifecycle.calls.length, 1);
  assert.strictEqual(lifecycle.calls[0][0], 'run');
  assert.strictEqual(lifecycle.calls[0][1].chat_id, lbl);
  assert.strictEqual(lifecycle.calls[0][1].root, real(root));
  assert.strictEqual(lifecycle.calls[0][1].owned_root, true);

  assert.deepStrictEqual(chats.originsOf(lbl), a.origins);
  assert.ok(Object.isFrozen(chats.originsOf(lbl)));
  assert.deepStrictEqual(chats.statusOf(lbl), { chat_id: lbl, rev: 1, state: 'running' });
  // Nothing under the root but what init wrote.
  assert.deepStrictEqual(fs.readdirSync(root), ['.web-chat']);
});

test('a repo: the stub git clones with --branch from <workdir>/repos through createGitRunner, then init', async (t) => {
  const { workdir } = paired(t);
  const { git, calls } = stubGit(t);
  const runInit = stubInit();
  const { chats } = make(t, { git, runInit });

  const lbl = label('b1');
  const o = await chats.apply(assignment(lbl, { scope: { kind: 'repo', url: URL_OK, ref: 'v1' } }));
  assert.deepStrictEqual(o, { chat_id: lbl, rev: 1, state: 'running' });
  const root = path.join(workdir, 'repos', lbl);
  const [call] = calls();
  assert.deepStrictEqual(call.argv, [...GIT_FLAGS, 'clone', '--branch', 'v1', '--', URL_OK, root]);
  assert.strictEqual(real(call.cwd), real(path.join(workdir, 'repos')));
  assert.strictEqual(modeOf(path.join(workdir, 'repos')), 0o700);
  assert.deepStrictEqual(runInit.calls.map((c) => [c.root, c.flags]), [[real(root), [...INIT_FLAGS]]]);
  const chat = chatOf(lbl);
  assert.strictEqual(chat.scope_kind, 'repo');
  assert.strictEqual(chat.owned_root, true);
  assert.strictEqual(chat.instance, instanceId(real(root)));

  // No ref: no --branch.
  const lbl2 = label('b2');
  await chats.apply(assignment(lbl2, { scope: { kind: 'repo', url: URL_OK } }));
  assert.deepStrictEqual(calls()[1].argv, [...GIT_FLAGS, 'clone', '--', URL_OK, path.join(workdir, 'repos', lbl2)]);
});

test('a ref starting with - is refused clone-failed before git runs', async (t) => {
  const { workdir } = paired(t);
  const { git, calls } = stubGit(t);
  const { chats, lifecycle } = make(t, { git, runInit: noInit });
  const before = recordBytes();
  const lbl = label('c1');
  const o = await chats.apply(assignment(lbl, { scope: { kind: 'repo', url: URL_OK, ref: '-upload-pack=x' } }));
  assert.deepStrictEqual(o, { chat_id: lbl, rev: 0, state: 'refused', reason: 'clone-failed' });
  assert.deepStrictEqual(calls(), []);
  assert.strictEqual(recordBytes(), before);
  assert.strictEqual(fs.existsSync(path.join(workdir, 'repos', lbl)), false);
  assert.deepStrictEqual(lifecycle.calls, []);
});

test('a ref starting with - on a new rev of a mapped repo chat is refused, the record and the daemon untouched', async (t) => {
  paired(t);
  const { git, calls } = stubGit(t);
  const { chats, lifecycle } = make(t, { git, runInit: stubInit() });
  const lbl = label('c2');
  assert.deepStrictEqual(await chats.apply(assignment(lbl, { scope: { kind: 'repo', url: URL_OK } })),
    { chat_id: lbl, rev: 1, state: 'running' });
  const gitCalls = calls().length;
  const lifecycleCalls = lifecycle.calls.length;
  const before = recordBytes();
  const o = await chats.apply(assignment(lbl, { rev: 2, desired: 'stopped', stop_mode: 'now', scope: { kind: 'repo', url: URL_OK, ref: '-x' } }));
  assert.deepStrictEqual(o, { chat_id: lbl, rev: 1, state: 'refused', reason: 'other', code: 'invalid-assignment' });
  assert.strictEqual(recordBytes(), before);
  assert.strictEqual(chatOf(lbl).rev, 1);
  assert.strictEqual(chatOf(lbl).desired, 'running');
  assert.strictEqual(lifecycle.calls.length, lifecycleCalls);
  assert.strictEqual(calls().length, gitCalls);
});

test('git exiting 128 is clone-failed, with none of git\'s text in the outcome or the log', async (t) => {
  paired(t);
  const { git, calls } = stubGit(t, { exit: 128 });
  const { chats, lines, lifecycle } = make(t, { git, runInit: noInit });
  const before = recordBytes();
  const lbl = label('d1');
  const o = await chats.apply(assignment(lbl, { scope: { kind: 'repo', url: URL_OK } }));
  assert.deepStrictEqual(o, { chat_id: lbl, rev: 0, state: 'failed', reason: 'clone-failed' });
  assert.strictEqual(calls().length, 1);
  assert.strictEqual(recordBytes(), before);
  assert.deepStrictEqual(lifecycle.calls, []);
  const said = JSON.stringify([o, chats.statusOf(lbl), lines]);
  assert.ok(!said.includes('SECRETTEXT') && !said.includes('/private/where'), 'no git text');
  assert.ok(lines.some((l) => /clone failed: exit 128/.test(l)), 'the exit code is logged');
  for (const l of lines) assert.ok(!l.includes(path.sep + 'repos'), `no path in the log: ${l}`);
});

test('refusals: not-accepting, unknown-folder, init-needed (nothing written), root-in-use', async (t) => {
  const { home, workdir } = paired(t);
  const runInit = stubInit();
  const { chats, lines, lifecycle } = make(t, { runInit });

  // accept_new_chats false → not-accepting, record unchanged.
  editRecord((r) => { r.settings.accept_new_chats = false; });
  let before = recordBytes();
  const l1 = label('e1');
  assert.deepStrictEqual(await chats.apply(assignment(l1)), { chat_id: l1, rev: 0, state: 'refused', reason: 'not-accepting' });
  assert.strictEqual(recordBytes(), before);
  assert.strictEqual(fs.existsSync(path.join(workdir, 'spaces', l1)), false);
  editRecord((r) => { r.settings.accept_new_chats = true; });
  // The same rev again, now accepted, applies.
  assert.strictEqual((await chats.apply(assignment(l1))).state, 'running');

  // An unknown folder id.
  before = recordBytes();
  const l2 = label('e2');
  const o2 = await chats.apply(assignment(l2, { scope: { kind: 'folder', folder_id: 'f_ffffffffffffffff' } }));
  assert.deepStrictEqual(o2, { chat_id: l2, rev: 0, state: 'refused', reason: 'unknown-folder' });
  assert.strictEqual(recordBytes(), before);

  // A folder without .web-chat/: init-needed, and its listing unchanged.
  const bare = offered(home, 'projects/bare', { bare: true, id: 'f_00000000000000b1' });
  fs.writeFileSync(path.join(bare.dir, 'notes.txt'), 'x');
  const listing = fs.readdirSync(bare.dir).sort();
  before = recordBytes();
  const l3 = label('e3');
  const o3 = await chats.apply(assignment(l3, { scope: { kind: 'folder', folder_id: bare.id } }));
  assert.deepStrictEqual(o3, { chat_id: l3, rev: 0, state: 'refused', reason: 'init-needed' });
  assert.deepStrictEqual(fs.readdirSync(bare.dir).sort(), listing);
  assert.strictEqual(recordBytes(), before);

  // A folder with .web-chat/: mapped, not owned, no init.
  const ok = offered(home, 'projects/ok', { id: 'f_00000000000000c1' });
  const initsBefore = runInit.calls.length;
  const l4 = label('e4');
  assert.deepStrictEqual(await chats.apply(assignment(l4, { scope: { kind: 'folder', folder_id: ok.id } })), { chat_id: l4, rev: 1, state: 'running' });
  assert.strictEqual(runInit.calls.length, initsBefore);
  const c4 = chatOf(l4);
  assert.strictEqual(c4.root, ok.dir);
  assert.strictEqual(c4.folder_id, ok.id);
  assert.strictEqual(c4.owned_root, false);
  assert.strictEqual(c4.instance, instanceId(ok.dir));

  // A second chat naming the mapped folder → root-in-use.
  before = recordBytes();
  const l5 = label('e5');
  assert.deepStrictEqual(await chats.apply(assignment(l5, { scope: { kind: 'folder', folder_id: ok.id } })),
    { chat_id: l5, rev: 0, state: 'refused', reason: 'root-in-use' });
  assert.strictEqual(recordBytes(), before);

  // A label whose space root another chat already maps (a hand-edited record).
  const l6 = label('e6');
  const takenRoot = path.join(real(workdir), 'spaces', l6);
  editRecord((r) => r.chats.push({
    chat_id: label('e7'), rev: 1, scope_kind: 'space', root: takenRoot, instance: null, owned_root: true, desired: 'stopped',
  }));
  before = recordBytes();
  const initsBeforeL6 = runInit.calls.length;
  assert.deepStrictEqual(await chats.apply(assignment(l6)), { chat_id: l6, rev: 0, state: 'refused', reason: 'root-in-use' });
  assert.strictEqual(recordBytes(), before);
  // Refused before any preparation: no directory made, no init run on a root
  // another chat maps (the check inside the record's lock is the second one).
  assert.strictEqual(fs.existsSync(takenRoot), false);
  assert.strictEqual(runInit.calls.length, initsBeforeL6);

  // Every log line is codes and ids: no path.
  for (const l of lines) assert.ok(!l.includes(home) && !l.includes(path.sep), `no path in the log: ${l}`);
  assert.ok(lifecycle.calls.every(([what]) => what === 'run'));
});

test('an invalid body is refused other and nothing is applied', async (t) => {
  paired(t);
  const { chats, lifecycle } = make(t);
  const before = recordBytes();
  const lbl = label('f1');
  const otherHost = assignment(lbl, { scope: { kind: 'repo', url: 'https://gitlab.com/example/widgets' } });
  const noOrigins = assignment(lbl);
  delete noOrigins.origins;
  const cases = [
    ['a url on another host', otherHost],
    ['no origins', noOrigins],
    ['a path where a folder id goes', assignment(lbl, { scope: { kind: 'folder', folder_id: '/etc' } })],
    ['a path beside a folder id', assignment(lbl, { scope: { kind: 'folder', folder_id: 'f_0123456789abcdef', path: '/etc' } })],
    ['rev 0', assignment(lbl, { rev: 0 })],
    ['an unknown key', assignment(lbl, { root: '/tmp' })],
    ['a bad stop_mode', assignment(lbl, { stop_mode: 'kill' })],
    ['a credential in the url', assignment(lbl, { scope: { kind: 'repo', url: 'https://user:pw@github.com/a/b' } })],
    ['not an object', null],
  ];
  for (const [what, body] of cases) {
    assert.ok(assignmentProblem(body), what);
    const o = await chats.apply(body);
    assert.strictEqual(o.state, 'refused', what);
    assert.strictEqual(o.reason, 'other', what);
    assert.strictEqual(o.code, 'invalid-assignment', what);
  }
  assert.strictEqual(recordBytes(), before);
  assert.deepStrictEqual(lifecycle.calls, []);
  assert.strictEqual(chats.originsOf(lbl), null);
  assert.strictEqual(chats.statusOf(lbl), null);
});

test('the hand check agrees with the locked schema (A-06.2) on the examples and on each case', () => {
  const examples = [...validator.view.examples.keys()].filter((n) => n.startsWith('06-chat-assignment'));
  assert.ok(examples.length >= 3, `the contracts copy carries the assignment examples: ${examples}`);
  for (const name of examples) {
    const body = validator.view.examples.get(name).data;
    assert.strictEqual(validator.validateExample('06-chat-assignment', body).ok, true, name);
    assert.strictEqual(assignmentProblem(body), null, name);
  }
  const lbl = label('f2');
  const bodies = [
    assignment(lbl),
    assignment(lbl, { scope: { kind: 'repo', url: URL_OK, ref: 'release/1.2' } }),
    assignment(lbl, { scope: { kind: 'folder', folder_id: 'f_0123456789abcdef' }, stop_mode: 'now', title: 'x' }),
    assignment(lbl, { origins: { surface: `https://chat-${lbl}.hub.test:8443`, answer: `https://chat-${lbl}-a.hub.test:8443`, shell: 'https://hub.test:8443' } }),
    assignment(lbl, { scope: { kind: 'repo', url: 'https://github.com/a/b/c' } }),
    assignment(lbl, { scope: { kind: 'repo', url: URL_OK, ref: 'a b' } }),
    assignment(lbl, { scope: { kind: 'space', extra: 1 } }),
    assignment(lbl, { agent: { want: 'session' } }),
    assignment(lbl, { agent: { want: 'session', launch: 'tmux' } }),
    assignment(lbl, { origins: { surface: 'http://chat-x.hub', answer: 'x', shell: 'y' } }),
    assignment(lbl, { chat_id: 'cht_' + lbl }),
    assignment(lbl, { v: 2 }),
    assignment(lbl, { rev: 1.5 }),
    assignment(lbl, { issued_at: 'now' }),
    assignment(lbl, { desired: 'paused' }),
    assignment(lbl, { title: 'x'.repeat(121) }),
  ];
  for (const body of bodies) {
    const ajv = validator.validateExample('06-chat-assignment', body).ok;
    assert.strictEqual(assignmentProblem(body) === null, ajv, JSON.stringify(body.scope) + JSON.stringify(body.agent));
  }
  // The one departure: a ref that breaks the grammar by its leading '-' passes
  // the hand check, to be refused clone-failed before git runs (C-06.16).
  const dash = assignment(lbl, { scope: { kind: 'repo', url: URL_OK, ref: '-upload-pack=x' } });
  assert.strictEqual(validator.validateExample('06-chat-assignment', dash).ok, false);
  assert.strictEqual(assignmentProblem(dash), null);
  // Only the first character: a dash ref the grammar breaks elsewhere too (a
  // space, a NUL, a newline, its length) is refused by the hand check itself.
  for (const ref of ['-a b', '-a\u0000b', '-a\nb', '-' + 'a'.repeat(200), '-' + '\u0000 \n'.repeat(1667)]) {
    const bad = assignment(lbl, { scope: { kind: 'repo', url: URL_OK, ref } });
    assert.strictEqual(validator.validateExample('06-chat-assignment', bad).ok, false, JSON.stringify(ref.slice(0, 8)));
    assert.ok(assignmentProblem(bad), JSON.stringify(ref.slice(0, 8)));
  }
});

test('rev order: rev 3 then rev 2 applies rev 3 and ignores rev 2; rev 3 again is ignored', async (t) => {
  paired(t);
  const runInit = stubInit();
  const { chats, lifecycle } = make(t, { runInit });
  const lbl = label('g1');
  const [o3, o2] = await Promise.all([
    chats.apply(assignment(lbl, { rev: 3 })),
    chats.apply(assignment(lbl, { rev: 2, desired: 'stopped' })),
  ]);
  assert.deepStrictEqual(o3, { chat_id: lbl, rev: 3, state: 'running' });
  assert.deepStrictEqual(o2, { chat_id: lbl, rev: 3, ignored: true });
  const again = await chats.apply(assignment(lbl, { rev: 3, desired: 'stopped' }));
  assert.deepStrictEqual(again, { chat_id: lbl, rev: 3, ignored: true });
  assert.strictEqual(chatOf(lbl).rev, 3);
  assert.strictEqual(chatOf(lbl).desired, 'running');
  assert.deepStrictEqual(lifecycle.calls.map(([w]) => w), ['run']);
  assert.strictEqual(runInit.calls.length, 1);
  // The resend still refreshes the origins kept in memory.
  assert.strictEqual(chats.originsOf(lbl).surface, `https://chat-${lbl}.hub.example.com`);
});

test('desired stopped with stop_mode now stops now; manual_attach_at and assigned_at are kept', async (t) => {
  paired(t);
  const { chats, lifecycle } = make(t, { runInit: stubInit() });
  const lbl = label('h1');
  await chats.apply(assignment(lbl));
  editRecord((r) => { r.chats.find((c) => c.chat_id === lbl).manual_attach_at = 1793177600000; });
  const o = await chats.apply(assignment(lbl, { rev: 2, desired: 'stopped', stop_mode: 'now' }));
  assert.deepStrictEqual(o, { chat_id: lbl, rev: 2, state: 'stopping' });
  const [what, chat, mode] = lifecycle.calls[1];
  assert.strictEqual(what, 'stop');
  assert.strictEqual(mode, 'now');
  assert.strictEqual(chat.chat_id, lbl);
  const rec = chatOf(lbl);
  assert.strictEqual(rec.desired, 'stopped');
  assert.strictEqual(rec.rev, 2);
  assert.strictEqual(rec.manual_attach_at, 1793177600000);
  assert.strictEqual(rec.assigned_at, 1793177500000);
  // Without stop_mode: release.
  await chats.apply(assignment(lbl, { rev: 3, desired: 'stopped' }));
  assert.strictEqual(lifecycle.calls[2][2], 'release');
});

test('removed stops, forgets the mapping and leaves the root on disk', async (t) => {
  const { workdir } = paired(t);
  const { chats, lifecycle } = make(t, { runInit: stubInit() });
  const lbl = label('q1');
  await chats.apply(assignment(lbl));
  const root = path.join(workdir, 'spaces', lbl);
  const o = await chats.apply(assignment(lbl, { rev: 2, desired: 'removed' }));
  assert.deepStrictEqual(o, { chat_id: lbl, rev: 0, state: 'stopped', removed: true });
  assert.deepStrictEqual(lifecycle.calls.map(([w, , m]) => [w, m]), [['run', undefined], ['stop', 'release']]);
  assert.strictEqual(chatOf(lbl), undefined);
  assert.ok(fs.statSync(root).isDirectory(), 'the owned root stays');
  assert.strictEqual(chats.originsOf(lbl), null);
  assert.strictEqual(chats.statusOf(lbl), null);
  // A late older rev does not bring it back.
  const late = await chats.apply(assignment(lbl, { rev: 1 }));
  assert.strictEqual(late.ignored, true);
  assert.strictEqual(chatOf(lbl), undefined);
  // A newer rev reassigns it on the root left on disk.
  const back = await chats.apply(assignment(lbl, { rev: 3 }));
  assert.strictEqual(back.state, 'running');
  assert.strictEqual(chatOf(lbl).root, real(root));
});

test('launch connector: the daemon runs, and the reason is other with the attach sentence, or home-launch-off (H11 a)', async (t) => {
  paired(t, { settings: { let_home_start_agents: true } });
  const { chats, lifecycle } = make(t, { runInit: stubInit() });
  const lbl = label('j1');
  const o = await chats.apply(assignment(lbl, { agent: { want: 'session', launch: 'connector', requested_by: 'home' } }));
  assert.strictEqual(o.state, 'running');
  assert.strictEqual(o.reason, 'other');
  assert.ok(o.detail.includes(`\`claude-web-chat connect attach ${lbl}\``), o.detail);
  assert.ok(o.detail.length <= 280);
  assert.deepStrictEqual(lifecycle.calls.map(([w]) => w), ['run']);
  assert.deepStrictEqual(chats.statusOf(lbl), o);
  const status = { v: 1, chat_id: o.chat_id, rev: o.rev, boot: '1:2', seq: 1, at: 1, state: o.state, reason: o.reason, detail: o.detail };
  assert.strictEqual(validator.validateExample('06-chat-status', status).ok, true, 'the outcome fits 06-chat-status');

  // The setting off: home-launch-off, worked out as statusOf is asked.
  editRecord((r) => { r.settings.let_home_start_agents = false; });
  assert.deepStrictEqual(chats.statusOf(lbl), { chat_id: lbl, rev: 1, state: 'running', reason: 'home-launch-off' });
  const lbl2 = label('j2');
  const o2 = await chats.apply(assignment(lbl2, { agent: { want: 'session', launch: 'connector' } }));
  assert.deepStrictEqual(o2, { chat_id: lbl2, rev: 1, state: 'running', reason: 'home-launch-off' });

  // A manual launch carries no reason; a failed daemon keeps its own.
  const lbl3 = label('j3');
  assert.deepStrictEqual(await chats.apply(assignment(lbl3)), { chat_id: lbl3, rev: 1, state: 'running' });
});

test('a failed daemon reports the lifecycle\'s reason', async (t) => {
  paired(t);
  const lifecycle = stubLifecycle({ run: { state: 'failed', reason: 'daemon-timeout' } });
  const { chats } = make(t, { runInit: stubInit(), lifecycle });
  const lbl = label('k1');
  assert.deepStrictEqual(await chats.apply(assignment(lbl, { agent: { want: 'session', launch: 'connector' } })),
    { chat_id: lbl, rev: 1, state: 'failed', reason: 'daemon-timeout' });
});

test('an init that fails is init-failed and maps nothing', async (t) => {
  paired(t);
  const { chats, lifecycle } = make(t, { runInit: stubInit({ exit: 3 }) });
  const before = recordBytes();
  const lbl = label('r1');
  assert.deepStrictEqual(await chats.apply(assignment(lbl)), { chat_id: lbl, rev: 0, state: 'failed', reason: 'init-failed' });
  assert.strictEqual(recordBytes(), before);
  assert.deepStrictEqual(lifecycle.calls, []);

  // An init that exits 0 but leaves no .web-chat/ is init-failed too.
  const silent = make(t, { runInit: async () => 0 });
  const lbl2 = label('r2');
  assert.deepStrictEqual(await silent.chats.apply(assignment(lbl2)), { chat_id: lbl2, rev: 0, state: 'failed', reason: 'init-failed' });
  assert.strictEqual(recordBytes(), before);
  assert.deepStrictEqual(silent.lifecycle.calls, []);
});

test('a workdir under ~/.web-chat refuses every repo and space assignment', async (t) => {
  paired(t, { workdir: () => path.join(userPaths().root, 'wd') });
  const { git, calls } = stubGit(t);
  const { chats, lifecycle } = make(t, { git, runInit: noInit });
  const before = recordBytes();
  const l1 = label('m1');
  const l2 = label('m2');
  assert.deepStrictEqual(await chats.apply(assignment(l1)), { chat_id: l1, rev: 0, state: 'refused', reason: 'other', code: 'workdir-refused' });
  assert.deepStrictEqual(await chats.apply(assignment(l2, { scope: { kind: 'repo', url: URL_OK } })),
    { chat_id: l2, rev: 0, state: 'refused', reason: 'other', code: 'workdir-refused' });
  assert.deepStrictEqual(calls(), []);
  assert.strictEqual(fs.existsSync(path.join(userPaths().root, 'wd')), false);
  assert.strictEqual(recordBytes(), before);
  assert.deepStrictEqual(lifecycle.calls, []);
});

test('a workdir inside an offered folder is refused too', async (t) => {
  const { home } = paired(t, { workdir: (h) => path.join(h, 'projects', 'ok', 'wd') });
  offered(home, 'projects/ok');
  const { chats } = make(t, { runInit: noInit });
  const lbl = label('n1');
  assert.deepStrictEqual(await chats.apply(assignment(lbl)), { chat_id: lbl, rev: 0, state: 'refused', reason: 'other', code: 'workdir-refused' });
  assert.strictEqual(fs.existsSync(path.join(home, 'projects', 'ok', 'wd')), false);
});

test('an existing folder chat whose folder was withdrawn is refused folder-withdrawn and not run', async (t) => {
  const { home } = paired(t);
  const f = offered(home, 'projects/ok');
  const { chats, lifecycle } = make(t);
  const lbl = label('s1');
  await chats.apply(assignment(lbl, { scope: { kind: 'folder', folder_id: f.id } }));
  // Another folder id on the same chat: one chat keeps one root.
  assert.deepStrictEqual(await chats.apply(assignment(lbl, { rev: 2, scope: { kind: 'folder', folder_id: 'f_00000000000000d1' } })),
    { chat_id: lbl, rev: 1, state: 'refused', reason: 'other', code: 'scope-changed' });
  // Its .web-chat/ gone: init-needed, and the daemon is not run.
  fs.rmdirSync(path.join(f.dir, '.web-chat'));
  assert.deepStrictEqual(await chats.apply(assignment(lbl, { rev: 2, scope: { kind: 'folder', folder_id: f.id } })),
    { chat_id: lbl, rev: 1, state: 'refused', reason: 'init-needed' });
  fs.mkdirSync(path.join(f.dir, '.web-chat'));
  editRecord((r) => { r.folders = []; });
  const o = await chats.apply(assignment(lbl, { rev: 2, scope: { kind: 'folder', folder_id: f.id } }));
  assert.deepStrictEqual(o, { chat_id: lbl, rev: 1, state: 'refused', reason: 'folder-withdrawn' });
  assert.strictEqual(lifecycle.calls.length, 1);
  // A scope that changes kind is refused: one chat keeps one root.
  const o2 = await chats.apply(assignment(lbl, { rev: 3 }));
  assert.deepStrictEqual(o2, { chat_id: lbl, rev: 1, state: 'refused', reason: 'other', code: 'scope-changed' });
});

test('resume runs the record\'s running chats; install sets ctx.chats once', async (t) => {
  const { home } = paired(t);
  const f = offered(home, 'projects/ok');
  const first = make(t, { runInit: stubInit() });
  const l1 = label('p1');
  const l2 = label('p2');
  await first.chats.apply(assignment(l1, { scope: { kind: 'folder', folder_id: f.id } }));
  await first.chats.apply(assignment(l2, { desired: 'stopped' }));

  const later = make(t);
  const out = await later.chats.resume();
  assert.deepStrictEqual(out, [{ chat_id: l1, rev: 1, state: 'running' }]);
  assert.deepStrictEqual(later.lifecycle.calls.map(([w, c]) => [w, c.chat_id]), [['run', l1]]);
  // The hub's resend of the applied rev is ignored, and its origins kept.
  assert.strictEqual((await later.chats.apply(assignment(l1, { scope: { kind: 'folder', folder_id: f.id } }))).ignored, true);
  assert.strictEqual(later.chats.originsOf(l1).answer, `https://chat-${l1}-a.hub.example.com`);

  const ctx = {};
  const off = later.chats.install(ctx);
  assert.strictEqual(ctx.chats.apply, later.chats.apply);
  assert.throws(() => first.chats.install(ctx), /already installed/);
  off();
  assert.strictEqual(ctx.chats, undefined);
});

test('the source: no lib/cli, no child_process, no git of its own, nothing read inside .web-chat/', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'connector', 'chats.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const requires = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(requires.every((r) => !/(^|\/)cli(\/|$)/.test(r)), `no lib/cli: ${requires}`);
  assert.ok(!requires.includes('child_process'), 'no child_process');
  assert.ok(!/\b(execFile|execFileSync|spawn|spawnSync|exec)\s*\(/.test(code), 'spawns nothing itself');
  assert.ok(!/['"]git['"]/.test(code), 'no git literal');
  assert.ok(requires.includes('../server/git-run'));
  assert.ok(!/readFileSync|readdirSync|readJson\b|\.mcp\.json|['"]\.claude['"]/.test(code), 'reads no file and writes no Claude Code config');
});
