// The fences for paths read out of Claude Code's text, and the bounded window
// read (lib/core/claude-files, spec §5.6).
//
// A path in a hook envelope, a tool result or an ExitPlanMode call is text a
// model wrote, and a model's text can be steered into naming any file. So each
// fence must accept exactly its own kind of file and refuse everything else: a
// relative path, a `..`, a link (the file itself, or one along the way that
// leads out of its tree), a path outside its root, the wrong name, another
// user's task tree, and anything that is not a regular file. Every fence
// answers an absolute path or null, and never throws.
//
// readWindow must never read past its window, however large the file, and its
// two flags must say exactly which of the window's edges are cut:
// lib/core/redact's redactWindow drops the line at a cut edge (a secret cut in
// two there is no longer recognisable) and keeps a whole one.
//
// Everything is built in the test sandbox: a private Claude tier per test
// (test-support/claude-home with isolate: true, which also gives it its own
// stand-in for /tmp) and scratch directories beside it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { spawnSync } = require('child_process');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { withTempHome } = require('../test-support/helpers');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { redactWindow, PARTIAL_LINE } = require('../lib/core/redact');
const {
  transcriptFile, sessionDirFile, taskOutputFile, planFile, readWindow,
  WINDOW_BYTES, WINDOW_MAX_BYTES,
} = require('../lib/core/claude-files');

const SID = '0b6f7c1e-4c1d-4a8e-9a43-5d2f0e3c9b11'; // Claude Code session ids
const SID2 = '5e9d2c4b-1a7f-4e3c-8b6d-2f0a9c8e7d61';
const SID3 = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const SID4 = '3c2b1a09-8f7e-4d6c-9b5a-0123456789ab';
const SID5 = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';
// Task ids as V5 records them: shells and monitors `b` + 8, agents `a` + 16,
// workflows `w` + 8.
const SHELL_TASK = 'b3k9x2ab';
const AGENT_TASK = 'a0123456789abcdef';
const WORKFLOW_TASK = 'w7k2m9q4';
// What sits at ~/.ssh/id_rsa in these tests: a stand-in, never a key.
const STAND_IN = 'a stand-in for a private key, and not one\n';

// ── helpers ──────────────────────────────────────────────────────────────────

function scratch(t, prefix) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(file, data = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

// A symbolic link at `at` pointing to `target`; returns `at`.
function link(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at);
  return at;
}

// A FIFO at `p`, or false where mkfifo cannot make one.
function fifo(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return spawnSync('mkfifo', [p]).status === 0;
}

// A sparse file of `size` bytes: nothing is written but `tail` at its end.
function sparse(file, size, tail = '') {
  const fd = fs.openSync(file, 'w');
  try {
    fs.ftruncateSync(fd, size);
    if (tail) fs.writeSync(fd, tail, size - Buffer.byteLength(tail));
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

// A private Claude tier for one test, with a project its sessions run in.
function tier(t) {
  return claudeHome(t, { root: scratch(t, 'cf-proj-'), isolate: true });
}

// Set CLAUDE_CONFIG_DIR for one test.
function configDirFor(t, value) {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = value;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  });
}

// A path spelled by hand, so that path.join cannot normalise a `..`, a `.` or
// a doubled separator away.
const raw = (...parts) => parts.join('/');

const label = (v) => util.inspect(v, { maxStringLength: 60 });

// Which fs calls run while `fn` does (synchronously, so nothing else can).
function fsAsked(t, fn) {
  const asked = [];
  const mocks = ['lstatSync', 'statSync', 'realpathSync', 'existsSync', 'openSync', 'readdirSync'].map((name) => {
    const orig = fs[name];
    return t.mock.method(fs, name, function (...args) {
      asked.push(name);
      return orig.apply(this, args);
    });
  });
  try {
    return { result: fn(), asked };
  } finally {
    for (const m of mocks) m.mock.restore();
  }
}

// Not paths, or not paths Claude Code writes.
const JUNK = [
  undefined, null, 0, 42, NaN, true, {}, [], ['/etc/passwd'], () => '/etc/passwd',
  Buffer.from('/etc/passwd'), Object('/etc/passwd'), // a String object, not a string
  '', '.', '..', '/', 'relative/file', '~/.ssh/id_rsa',
  '/etc/passwd\0.jsonl', '/tmp/a\nb.jsonl', `/${'x'.repeat(5000)}`,
];

// ── every fence ──────────────────────────────────────────────────────────────

test('every fence answers an absolute path or null, and never throws', (t) => {
  const ch = tier(t);
  const dir = ch.sessionDir(SID);
  const output = ch.writeTaskOutput(SID, SHELL_TASK, 'building\n');
  const cases = [
    [transcriptFile, [ch.writeTranscript(SID, ['{}'])]],
    [sessionDirFile, [dir, put(path.join(dir, 'tool-results', 'r1.txt'), 'out\n')]],
    [taskOutputFile, [output]],
    [planFile, [ch.write('plans/quiet-river.md', '# Plan\n')]],
  ];
  for (const [fn, args] of cases) {
    const got = fn(...args);
    assert.ok(typeof got === 'string' && path.isAbsolute(got), `${fn.name} accepts its own kind of file`);
    assert.equal(got, args[args.length - 1], `${fn.name} answers the path as it was given`);
    for (const junk of JUNK) {
      assert.equal(fn(junk), null, `${fn.name}(${label(junk)})`);
      if (fn === sessionDirFile) {
        assert.equal(fn(dir, junk), null, `sessionDirFile(dir, ${label(junk)})`);
        assert.equal(fn(junk, args[1]), null, `sessionDirFile(${label(junk)}, file)`);
      }
    }
    assert.equal(fn(), null, `${fn.name}() with nothing`);
  }

  // An error a fence did not foresee is doubt, like any other.
  t.mock.method(process, 'getuid', () => { throw new Error('no uid here'); });
  assert.equal(taskOutputFile(output), null);
});

test('a fence takes its root in either spelling, as this process names it and by realpath, and no other', (t) => {
  // The Claude tier reached through a link, as a ~/.claude kept elsewhere is:
  // this process names it by the link, and a path can arrive spelled through
  // the real directory (macOS's /private/var, say). A second link to the same
  // directory is a spelling of neither.
  const base = scratch(t, 'cf-spell-');
  const real = path.join(base, 'claude-real');
  fs.mkdirSync(real);
  const named = link(real, path.join(base, 'claude-named'));
  const other = link(real, path.join(base, 'claude-other'));
  configDirFor(t, named);
  const canonical = fs.realpathSync(real);

  const sessionDir = (root) => path.join(root, 'projects', '-srv-acme', SID);
  const transcript = (root) => path.join(root, 'projects', '-srv-acme', `${SID}.jsonl`);
  const result = (root) => path.join(sessionDir(root), 'tool-results', 'r1.txt');
  const plan = (root) => path.join(root, 'plans', 'quiet-river.md');
  put(transcript(real), '{}\n');
  put(result(real), 'out\n');
  put(plan(real), '# Plan\n');

  for (const root of [named, canonical]) {
    assert.equal(transcriptFile(transcript(root)), transcript(root), root);
    assert.equal(sessionDirFile(sessionDir(root), result(root)), result(root), root);
    assert.equal(planFile(plan(root)), plan(root), root);
  }
  assert.equal(transcriptFile(transcript(other)), null);
  assert.equal(sessionDirFile(sessionDir(other), result(other)), null);
  assert.equal(planFile(plan(other)), null);
});

// ── transcriptFile ───────────────────────────────────────────────────────────

test('transcriptFile accepts <projects>/<slug>/<session id>.jsonl, written or not yet', (t) => {
  const ch = tier(t);
  const file = ch.writeTranscript(SID, [{ type: 'user', sessionId: SID }]);
  assert.equal(transcriptFile(file), file);

  // A hook's transcript_path arrives at SessionStart, before Claude Code has
  // written the file (V3)...
  const later = ch.transcript(SID2);
  assert.equal(fs.existsSync(later), false);
  assert.equal(transcriptFile(later), later);
  // ...and, for a project's first session, before its directory exists.
  const fresh = path.join(ch.projectsDir, '-srv-brand-new', `${SID}.jsonl`);
  assert.equal(transcriptFile(fresh), fresh);
});

test('transcriptFile refuses a relative path, a `..`, the wrong name and the wrong depth', (t) => {
  const ch = tier(t);
  const file = ch.writeTranscript(SID, ['{}']);
  const wrongNames = [
    `${SID}.json`, `${SID}.jsonl.bak`, `${SID}.JSONL`, '.jsonl', 'not an id.jsonl', 'a.b.jsonl', `${'x'.repeat(101)}.jsonl`,
  ].map((name) => put(path.join(ch.projectDir, name), '{}\n'));
  for (const p of [
    path.relative(process.cwd(), file),
    `${ch.slug}/${SID}.jsonl`,
    raw(ch.projectDir, '..', ch.slug, `${SID}.jsonl`), // normalises back to the file
    raw(ch.projectDir, '.', `${SID}.jsonl`),
    raw(ch.projectDir, '', `${SID}.jsonl`),
    `${file}/`,
    ...wrongNames,
    put(path.join(ch.projectsDir, `${SID}.jsonl`), '{}\n'), // directly under projects/
    put(path.join(ch.projectDir, SID, `${SID}.jsonl`), '{}\n'), // a level too deep
    put(path.join(ch.projectDir, SID, 'subagents', 'agent-a1.jsonl'), '{}\n'),
    `${ch.transcript(SID2)}/`, // not written yet, and spelled as a directory
    // A control character in a directory name: a real file, the right depth and
    // name, but no slug Claude Code makes (every such character becomes '-').
    put(path.join(ch.projectsDir, '-srv-line\nbreak', `${SID}.jsonl`), '{}\n'),
  ]) {
    assert.equal(transcriptFile(p), null, label(p));
  }
});

test('transcriptFile refuses a link, a path outside projects/ and anything but a regular file', (t) => {
  const ch = tier(t);
  const real = ch.writeTranscript(SID, ['{}']);
  const out = scratch(t, 'cf-out-');
  const secret = put(path.join(out, 'id_rsa'), STAND_IN);

  // The transcript itself a link: to another transcript, or out of the tree.
  assert.equal(transcriptFile(link(real, ch.transcript(SID2))), null);
  assert.equal(transcriptFile(link(secret, ch.transcript(SID3))), null);

  // A project directory that leads out of projects/, the file there or not
  // yet; and one that leads nowhere.
  put(path.join(out, 'proj', `${SID}.jsonl`), '{}\n');
  const away = link(path.join(out, 'proj'), path.join(ch.projectsDir, '-linked-away'));
  assert.equal(transcriptFile(path.join(away, `${SID}.jsonl`)), null);
  assert.equal(transcriptFile(path.join(away, `${SID2}.jsonl`)), null);
  const dangling = link(path.join(out, 'gone'), path.join(ch.projectsDir, '-dangling'));
  assert.equal(transcriptFile(path.join(dangling, `${SID}.jsonl`)), null);

  // Outside projects/ altogether.
  assert.equal(transcriptFile(path.join(out, 'proj', `${SID}.jsonl`)), null);
  assert.equal(transcriptFile(put(path.join(ch.sessionsDir, `${SID}.jsonl`), '{}\n')), null);

  // Named right, but not a regular file.
  fs.mkdirSync(path.join(ch.projectDir, `${SID4}.jsonl`));
  assert.equal(transcriptFile(path.join(ch.projectDir, `${SID4}.jsonl`)), null);
  const pipe = path.join(ch.projectDir, `${SID5}.jsonl`);
  if (fifo(pipe)) assert.equal(transcriptFile(pipe), null);
});

test('transcriptFile accepts nothing while there is no projects/ directory', (t) => {
  const config = path.join(scratch(t, 'cf-bare-'), '.claude');
  fs.mkdirSync(config);
  configDirFor(t, config);
  assert.equal(transcriptFile(path.join(config, 'projects', '-srv-acme', `${SID}.jsonl`)), null);
  fs.mkdirSync(path.join(config, 'projects'));
  assert.equal(transcriptFile(path.join(config, 'projects', '-srv-acme', `${SID}.jsonl`)),
    path.join(config, 'projects', '-srv-acme', `${SID}.jsonl`));
});

test('a path the filesystem will not answer about is refused, not taken for absent', (t) => {
  const ch = tier(t);
  const later = ch.transcript(SID2);
  assert.equal(transcriptFile(later), later);
  const lstatSync = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', function (p, ...rest) {
    if (p === later) throw Object.assign(new Error(`EACCES: permission denied, lstat '${p}'`), { code: 'EACCES' });
    return lstatSync.call(this, p, ...rest);
  });
  assert.equal(transcriptFile(later), null);
});

// ── sessionDirFile ───────────────────────────────────────────────────────────

test('sessionDirFile accepts a regular file in tool-results/, subagents/ or workflows/ of the session', (t) => {
  const ch = tier(t);
  const dir = ch.sessionDir(SID);
  for (const rel of [
    'tool-results/toolu_01AbCdEf.txt', // a result too large for the transcript (V1)
    `subagents/agent-${AGENT_TASK}.jsonl`, // an Agent's transcript and meta (V7)
    `subagents/agent-${AGENT_TASK}.meta.json`,
    'subagents/workflows/wfr-7/journal.jsonl', // a workflow's agents (V4)
    'subagents/workflows/wfr-7/agent-a1.jsonl',
    'workflows/scripts/review.js',
    'workflows/wf_wfr-7.json',
  ]) {
    const file = put(path.join(dir, rel), '{}\n');
    assert.equal(sessionDirFile(dir, file), file, rel);
  }
});

test('sessionDirFile refuses a path outside the three, another session\'s files, and a session directory that is not one', (t) => {
  const ch = tier(t);
  const dir = ch.sessionDir(SID);
  const result = put(path.join(dir, 'tool-results', 'r1.txt'), 'out\n');

  for (const p of [
    put(path.join(ch.sessionDir(SID2), 'tool-results', 'r1.txt'), 'theirs\n'), // another session's
    ch.writeTranscript(SID, ['{}']), // the session's own transcript, beside its directory
    put(path.join(dir, 'notes.txt'), 'x\n'), // in the session directory, but in none of the three
    put(path.join(dir, 'memory', 'm.md'), 'x\n'),
    path.join(dir, 'tool-results'), // one of the three itself
    dir,
    path.relative(process.cwd(), result),
    'tool-results/r1.txt',
    raw(dir, 'tool-results', '..', 'tool-results', 'r1.txt'),
    raw(dir, 'tool-results', '..', '..', `${SID}.jsonl`),
  ]) {
    assert.equal(sessionDirFile(dir, p), null, p);
  }

  // The directory handed in must be <projects>/<slug>/<session id>.
  const out = scratch(t, 'cf-out-');
  const outside = put(path.join(out, SID, 'tool-results', 'r1.txt'), 'x\n');
  const notAnId = path.join(ch.projectDir, 'not.an.id');
  const inNotAnId = put(path.join(notAnId, 'tool-results', 'r1.txt'), 'x\n');
  for (const [d, p] of [
    [path.join(out, SID), outside], // outside projects/
    [ch.projectDir, result], // the project directory
    [ch.projectsDir, result],
    [notAnId, inNotAnId],
    [path.relative(process.cwd(), dir), result],
    [`${dir}/`, result],
    [raw(ch.projectDir, '.', SID), result],
  ]) {
    assert.equal(sessionDirFile(d, p), null, `${d} | ${p}`);
  }
});

test('sessionDirFile refuses a link: the file, a subdirectory, or the session directory itself', (t) => {
  const ch = tier(t);
  const dir = ch.sessionDir(SID);
  const out = scratch(t, 'cf-out-');
  const secret = put(path.join(out, 'id_rsa'), STAND_IN);
  const result = put(path.join(dir, 'tool-results', 'r1.txt'), 'out\n');

  // The file a link, out of the tree or to a file the fence would accept.
  assert.equal(sessionDirFile(dir, link(secret, path.join(dir, 'tool-results', 'r2.txt'))), null);
  assert.equal(sessionDirFile(dir, link(result, path.join(dir, 'tool-results', 'r3.txt'))), null);

  // A subdirectory that leads out of the session.
  put(path.join(out, 'elsewhere', 'agent-a1.jsonl'), '{}\n');
  link(path.join(out, 'elsewhere'), path.join(dir, 'subagents'));
  assert.equal(sessionDirFile(dir, path.join(dir, 'subagents', 'agent-a1.jsonl')), null);

  // A subdirectory that leads back into the session, past the three; and one
  // outside the three that leads into them. Both spellings must be one of the
  // three: as given, and once the links are resolved.
  put(path.join(dir, 'notes.txt'), 'x\n');
  link('.', path.join(dir, 'workflows'));
  assert.equal(sessionDirFile(dir, path.join(dir, 'workflows', 'notes.txt')), null);
  link('tool-results', path.join(dir, 'memory'));
  assert.equal(sessionDirFile(dir, path.join(dir, 'memory', 'r1.txt')), null);

  // The session directory itself a link out of projects/.
  put(path.join(out, 'sess', 'tool-results', 'r1.txt'), 'x\n');
  const away = link(path.join(out, 'sess'), path.join(ch.projectDir, SID2));
  assert.equal(sessionDirFile(away, path.join(away, 'tool-results', 'r1.txt')), null);

  // Named right, but not a regular file, or not there.
  fs.mkdirSync(path.join(dir, 'tool-results', 'dir.txt'));
  assert.equal(sessionDirFile(dir, path.join(dir, 'tool-results', 'dir.txt')), null);
  const pipe = path.join(dir, 'tool-results', 'pipe.txt');
  if (fifo(pipe)) assert.equal(sessionDirFile(dir, pipe), null);
  assert.equal(sessionDirFile(dir, path.join(dir, 'tool-results', 'missing.txt')), null);
});

// ── taskOutputFile ───────────────────────────────────────────────────────────

test('taskOutputFile accepts <tmp>/claude-<uid>/<slug>/<session>/tasks/<id>.output in this user\'s own tree', (t) => {
  const ch = tier(t);
  for (const id of [SHELL_TASK, WORKFLOW_TASK, 'x', 'A_b-9'.padEnd(64, 'z')]) {
    const output = ch.writeTaskOutput(SID, id, 'building\n');
    assert.equal(taskOutputFile(output), output, id);
  }
  // After /clear a task still lands under the session its process started
  // with (V5), so the session directory is whatever the text names.
  const afterClear = ch.writeTaskOutput(SID2, SHELL_TASK, '');
  assert.equal(taskOutputFile(afterClear), afterClear);
  assert.equal(fs.lstatSync(path.join(ch.tmpDir, `claude-${ch.uid}`)).mode & 0o777, 0o700,
    'the fixture makes claude-<uid> as Claude Code does');
});

test('taskOutputFile refuses an Agent\'s .output, a link to the agent\'s transcript (V7); the agent is read from subagents/', (t) => {
  const ch = tier(t);
  const agent = put(path.join(ch.sessionDir(SID), 'subagents', `agent-${AGENT_TASK}.jsonl`), '{}\n');
  const outputFile = link(agent, path.join(ch.taskDir(SID), `${AGENT_TASK}.output`));
  assert.equal(taskOutputFile(outputFile), null);
  assert.equal(sessionDirFile(ch.sessionDir(SID), agent), agent);
});

test('taskOutputFile refuses another user\'s tree, and a tree this user does not hold alone', (t) => {
  const ch = tier(t);
  const uid = ch.uid;
  const mine = ch.writeTaskOutput(SID, SHELL_TASK, 'x\n');
  const top = path.join(ch.tmpDir, `claude-${uid}`);
  const below = path.relative(top, mine); // <slug>/<session>/tasks/<id>.output

  // A path into another uid's tree is refused before anything is asked of it.
  const theirsTop = path.join(ch.tmpDir, `claude-${uid + 1}`);
  const theirs = put(path.join(theirsTop, below), 'x\n');
  fs.chmodSync(theirsTop, 0o700);
  const { result, asked } = fsAsked(t, () => taskOutputFile(theirs));
  assert.equal(result, null);
  assert.deepEqual(asked, []);
  assert.equal(taskOutputFile(put(path.join(ch.tmpDir, `claude-0${uid}`, below), 'x\n')), null, 'the uid spelled with a leading zero');

  // This uid's name on a directory another uid owns. A test cannot chown, so
  // it changes which uid this process is instead: the tree it made is then
  // another user's.
  const getuid = t.mock.method(process, 'getuid', () => uid + 1);
  assert.equal(taskOutputFile(theirs), null, 'claude-<uid> owned by someone else');
  assert.equal(taskOutputFile(mine), null, 'named for someone else');
  getuid.mock.restore();
  assert.equal(taskOutputFile(mine), mine);

  // claude-<uid> that anyone else can write into.
  for (const mode of [0o777, 0o770, 0o720, 0o702]) {
    fs.chmodSync(top, mode);
    assert.equal(taskOutputFile(mine), null, mode.toString(8));
  }
  for (const mode of [0o700, 0o750, 0o755]) {
    fs.chmodSync(top, mode);
    assert.equal(taskOutputFile(mine), mine, mode.toString(8));
  }
  fs.chmodSync(top, 0o700);

  // A platform with no uids at all.
  const realGetuid = process.getuid;
  process.getuid = undefined;
  try {
    assert.equal(taskOutputFile(mine), null);
  } finally {
    process.getuid = realGetuid;
  }
  assert.equal(taskOutputFile(mine), mine);
});

test('taskOutputFile refuses a link along the way, the wrong shape and anything but a regular file', (t) => {
  const ch = tier(t);
  const uid = ch.uid;
  const mine = ch.writeTaskOutput(SID, SHELL_TASK, 'x\n');
  const top = path.join(ch.tmpDir, `claude-${uid}`);
  const tasks = path.dirname(mine);
  const out = scratch(t, 'cf-out-');
  const secret = put(path.join(out, 'id_rsa'), STAND_IN);

  // claude-<uid> reached through a link.
  const viaLink = link(top, path.join(out, 'tmp', `claude-${uid}`));
  assert.equal(taskOutputFile(path.join(viaLink, path.relative(top, mine))), null);
  // A tasks/ that leads out of claude-<uid>.
  put(path.join(out, 'tasks', `${SHELL_TASK}.output`), 'x\n');
  link(path.join(out, 'tasks'), path.join(top, ch.slug, SID2, 'tasks'));
  assert.equal(taskOutputFile(path.join(top, ch.slug, SID2, 'tasks', `${SHELL_TASK}.output`)), null);
  // The output file a link: out of the tree, or to another output inside it.
  assert.equal(taskOutputFile(link(secret, path.join(tasks, 'blinked1.output'))), null);
  assert.equal(taskOutputFile(link(mine, path.join(tasks, 'blinked2.output'))), null);

  // The wrong shape, each with a file there to find.
  for (const p of [
    path.join(tasks, `${SHELL_TASK}.txt`),
    path.join(tasks, `${SHELL_TASK}.output.bak`),
    path.join(tasks, '.output'),
    path.join(tasks, 'a.b.output'),
    path.join(tasks, `${'b'.repeat(65)}.output`),
    path.join(top, SID, 'tasks', `${SHELL_TASK}.output`), // a segment short
    path.join(top, ch.slug, SID, 'x', 'tasks', `${SHELL_TASK}.output`), // a segment over
    path.join(top, ch.slug, SID, 'task', `${SHELL_TASK}.output`),
  ]) {
    assert.equal(taskOutputFile(put(p, 'x\n')), null, p);
  }
  for (const p of [
    path.relative(process.cwd(), mine),
    raw(tasks, '..', 'tasks', `${SHELL_TASK}.output`),
    raw(top, '.', ch.slug, SID, 'tasks', `${SHELL_TASK}.output`),
    path.join(out, 'nowhere', `claude-${uid}`, ch.slug, SID, 'tasks', `${SHELL_TASK}.output`),
  ]) {
    assert.equal(taskOutputFile(p), null, p);
  }

  // Named right, but not a regular file, or not there.
  fs.mkdirSync(path.join(tasks, 'bdir0001.output'));
  assert.equal(taskOutputFile(path.join(tasks, 'bdir0001.output')), null);
  const pipe = path.join(tasks, 'bpipe001.output');
  if (fifo(pipe)) assert.equal(taskOutputFile(pipe), null);
  assert.equal(taskOutputFile(path.join(tasks, 'bgone001.output')), null);
  assert.equal(taskOutputFile(mine), mine, 'and the real one is still accepted');
});

// ── planFile ─────────────────────────────────────────────────────────────────

test('planFile accepts a regular *.md inside plans/', (t) => {
  const ch = tier(t);
  const plan = ch.write('plans/quiet-river.md', '# Plan\n');
  assert.equal(planFile(plan), plan);
  const nested = ch.write('plans/agents/quiet-river-agent-a1.md', '# Plan\n');
  assert.equal(planFile(nested), nested);
});

test('planFile refuses a planFilePath outside plans/, such as ~/.ssh/id_rsa', (t) => {
  const ch = tier(t);
  const home = withTempHome(t);
  const key = put(path.join(home, '.ssh', 'id_rsa'), STAND_IN);
  const plan = ch.write('plans/quiet-river.md', '# Plan\n');
  const plans = path.dirname(plan);
  for (const p of [
    key,
    put(path.join(home, '.ssh', 'id_rsa.md'), STAND_IN), // named like a plan, still outside
    put(path.join(home, 'notes', 'plan.md'), '# notes\n'),
    ch.write('settings.md', '{}'), // in the Claude tier, beside plans/
    raw(plans, '..', 'settings.md'),
    raw(plans, '..', 'plans', 'quiet-river.md'),
    raw(plans, '.', 'quiet-river.md'),
    '~/.ssh/id_rsa',
    'plans/quiet-river.md',
    path.relative(process.cwd(), plan),
  ]) {
    assert.equal(planFile(p), null, p);
  }
  // A link in plans/, named like a plan: to the key, or to another plan.
  assert.equal(planFile(link(key, path.join(plans, 'stolen.md'))), null);
  assert.equal(planFile(link(plan, path.join(plans, 'copy.md'))), null);
  // A subdirectory of plans/ that leads out.
  link(path.join(home, '.ssh'), path.join(plans, 'keys'));
  assert.equal(planFile(path.join(plans, 'keys', 'id_rsa.md')), null);
});

test('planFile refuses the wrong name and anything but a regular file', (t) => {
  const ch = tier(t);
  const plans = path.dirname(ch.write('plans/quiet-river.md', '# Plan\n'));
  for (const name of ['river.txt', 'loud-river.MD', 'river.md.bak', 'river.markdown', '.md', 'river']) {
    assert.equal(planFile(put(path.join(plans, name), '# Plan\n')), null, name);
  }
  fs.mkdirSync(path.join(plans, 'dir.md'));
  assert.equal(planFile(path.join(plans, 'dir.md')), null);
  const pipe = path.join(plans, 'pipe.md');
  if (fifo(pipe)) assert.equal(planFile(pipe), null);
  assert.equal(planFile(path.join(plans, 'missing.md')), null);
  assert.equal(planFile(plans), null, 'plans/ itself');
});

// Claude Code's `plansDirectory` setting moves plans into the project: it is
// resolved against the session's working directory, and used only while it
// stays inside it (2.1.287). The caller reads the setting; the fence takes the
// pair, under Claude Code's rule.
test('planFile takes a plan where a plansDirectory setting put it, only when asked to', (t) => {
  const ch = tier(t);
  const root = ch.root;
  const plan = put(path.join(root, 'docs', 'plans', 'quiet-river.md'), '# Plan\n');
  const setting = { projectRoot: root, plansDirectory: 'docs/plans' };

  assert.equal(planFile(plan), null, 'by default a plan lives in <config>/plans alone');
  assert.equal(planFile(plan, setting), plan);
  for (const plansDirectory of ['./docs/plans', 'docs/plans/', 'docs/../docs/plans', path.join(root, 'docs', 'plans')]) {
    assert.equal(planFile(plan, { projectRoot: root, plansDirectory }), plan, plansDirectory);
  }
  const nested = put(path.join(root, 'docs', 'plans', 'agents', 'quiet-river-agent-a1.md'), '# Plan\n');
  assert.equal(planFile(nested, setting), nested);

  // Claude Code records the physical path (macOS's /var is /private/var), and
  // a caller may hold the root in either spelling.
  const physical = path.join(ch.cwd, 'docs', 'plans', 'quiet-river.md');
  assert.equal(planFile(physical, setting), physical);
  assert.equal(planFile(physical, { projectRoot: ch.cwd, plansDirectory: 'docs/plans' }), physical);

  // <config>/plans is still a plans directory.
  const usual = ch.write('plans/loud-river.md', '# Plan\n');
  assert.equal(planFile(usual, setting), usual);
});

test('planFile refuses a plansDirectory that leaves the project or names all of it, and keeps every other rule inside one', (t) => {
  const ch = tier(t);
  const root = ch.root;
  const home = withTempHome(t);
  const key = put(path.join(home, '.ssh', 'id_rsa.md'), STAND_IN);
  const outside = put(path.join(scratch(t, 'cf-out-'), 'plans', 'quiet-river.md'), '# Plan\n');
  const readme = put(path.join(root, 'README.md'), '# A project file, not a plan\n');
  const plan = put(path.join(root, 'docs', 'plans', 'quiet-river.md'), '# Plan\n');
  const plans = path.dirname(plan);
  const setting = { projectRoot: root, plansDirectory: 'docs/plans' };

  // A setting that leads out of the project names no plans directory, as in
  // Claude Code, which writes to <config>/plans then.
  for (const [plansDirectory, p] of [
    ['..', outside],
    [path.relative(root, path.dirname(outside)), outside],
    [path.dirname(outside), outside],
    [path.join(home, '.ssh'), key],
    ['/', key],
  ]) {
    assert.equal(planFile(p, { projectRoot: root, plansDirectory }), null, plansDirectory);
  }
  // Nor does one that leads out through a link inside the project.
  link(path.dirname(outside), path.join(root, 'linked-plans'));
  assert.equal(planFile(path.join(root, 'linked-plans', 'quiet-river.md'), { projectRoot: root, plansDirectory: 'linked-plans' }), null);

  // A setting that names the project root itself would make every markdown
  // file in the project a plan: refused, spelled out or through a link.
  for (const plansDirectory of ['.', './', 'docs/..', root]) {
    assert.equal(planFile(readme, { projectRoot: root, plansDirectory }), null, plansDirectory);
  }
  link('.', path.join(root, 'loop'));
  assert.equal(planFile(path.join(root, 'loop', 'README.md'), { projectRoot: root, plansDirectory: 'loop' }), null);
  // And a root at the top of the filesystem is no project.
  assert.equal(planFile(plan, { projectRoot: path.parse(root).root, plansDirectory: path.relative(path.parse(root).root, plans) }), null);

  // Inside the moved directory every other rule holds.
  for (const p of [
    readme, // in the project, beside the plans directory
    put(path.join(root, 'docs', 'notes.md'), '# notes\n'),
    put(path.join(plans, 'river.txt'), '# Plan\n'),
    put(path.join(plans, 'river.md.bak'), '# Plan\n'),
    raw(plans, '..', 'plans', 'quiet-river.md'),
    raw(plans, '.', 'quiet-river.md'),
    path.relative(process.cwd(), plan),
    'docs/plans/quiet-river.md',
    path.join(plans, 'missing.md'),
    plans,
  ]) {
    assert.equal(planFile(p, setting), null, p);
  }
  assert.equal(planFile(link(key, path.join(plans, 'stolen.md')), setting), null, 'a link named like a plan');
  assert.equal(planFile(link(plan, path.join(plans, 'copy.md')), setting), null, 'a link to a plan');
  link(path.join(home, '.ssh'), path.join(plans, 'keys'));
  assert.equal(planFile(path.join(plans, 'keys', 'id_rsa.md'), setting), null, 'a subdirectory that leads out');
  fs.mkdirSync(path.join(plans, 'dir.md'));
  assert.equal(planFile(path.join(plans, 'dir.md'), setting), null, 'a directory');
  const pipe = path.join(plans, 'pipe.md');
  if (fifo(pipe)) assert.equal(planFile(pipe, setting), null, 'a FIFO');
  assert.equal(planFile(plan, setting), plan, 'and the plan itself is still taken');
});

test('a plansDirectory option that is not a clean pair adds nothing, and takes nothing away', (t) => {
  const ch = tier(t);
  const root = ch.root;
  const plan = put(path.join(root, 'docs', 'plans', 'quiet-river.md'), '# Plan\n');
  const usual = ch.write('plans/loud-river.md', '# Plan\n');
  for (const opts of [
    undefined, null, 'docs/plans', 42, [], ['docs/plans'], {},
    { projectRoot: root },
    { plansDirectory: 'docs/plans' },
    { projectRoot: path.relative(process.cwd(), root), plansDirectory: 'docs/plans' },
    { projectRoot: `${root}/`, plansDirectory: 'docs/plans' },
    { projectRoot: raw(root, '.'), plansDirectory: 'docs/plans' },
    { projectRoot: root, plansDirectory: '' },
    { projectRoot: root, plansDirectory: 7 },
    { projectRoot: root, plansDirectory: ['docs/plans'] },
    { projectRoot: root, plansDirectory: `${'./'.repeat(2100)}docs/plans` }, // past PATH_MAX, though it resolves to docs/plans
    { projectRoot: Buffer.from(root), plansDirectory: 'docs/plans' },
  ]) {
    assert.equal(planFile(plan, opts), null, label(opts));
    assert.equal(planFile(usual, opts), usual, `<config>/plans with ${label(opts)}`);
  }
  // An option that throws when read is doubt, like any other.
  const throwing = { get projectRoot() { throw new Error('no root here'); }, plansDirectory: 'docs/plans' };
  assert.equal(planFile(plan, throwing), null);
});

// ── readWindow ───────────────────────────────────────────────────────────────

// 1,000 ASCII lines, so a byte offset is a character offset.
const DATA = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n') + '\n';
const DATA_SIZE = Buffer.byteLength(DATA);

test('readWindow reads a small file whole, from either end', (t) => {
  const dir = scratch(t, 'cf-win-');
  const file = put(path.join(dir, 'small.txt'), 'one\ntwo\n');
  for (const opts of [undefined, {}, { maxBytes: 8 }, { maxBytes: 100 }, { from: 0 }, { maxBytes: 8, fromEnd: true }, { maxBytes: 100, fromEnd: true }]) {
    assert.deepEqual(readWindow(file, opts),
      { text: 'one\ntwo\n', startsMidFile: false, complete: true, from: 0, to: 8, next: 8, size: 8 }, label(opts));
  }
  assert.deepEqual(readWindow(put(path.join(dir, 'empty.txt'), ''), { fromEnd: true }),
    { text: '', startsMidFile: false, complete: true, from: 0, to: 0, next: 0, size: 0 });
});

test('a window from the start stops at maxBytes, and is not complete', (t) => {
  const file = put(path.join(scratch(t, 'cf-win-'), 'data.txt'), DATA);
  assert.deepEqual(readWindow(file, { maxBytes: 1000 }), {
    text: DATA.slice(0, 1000), startsMidFile: false, complete: false,
    from: 0, to: 1000, next: DATA.lastIndexOf('\n', 999) + 1, size: DATA_SIZE,
  });
});

test('a window from the end holds the last maxBytes bytes, starts mid-file and is complete', (t) => {
  const file = put(path.join(scratch(t, 'cf-win-'), 'data.txt'), DATA);
  assert.notEqual(DATA[DATA_SIZE - 1001], '\n', 'the window opens partway through a line');
  assert.deepEqual(readWindow(file, { maxBytes: 1000, fromEnd: true }), {
    text: DATA.slice(DATA_SIZE - 1000), startsMidFile: true, complete: true,
    from: DATA_SIZE - 1000, to: DATA_SIZE, next: DATA_SIZE, size: DATA_SIZE,
  });
});

test('readWindow pages through a file from `from`, each window\'s `to` the next one\'s `from`', (t) => {
  const file = put(path.join(scratch(t, 'cf-win-'), 'data.txt'), DATA);
  const pages = [];
  let aligned = 0;
  let from = 0;
  for (let i = 0; i < 100; i++) {
    const w = readWindow(file, { from, maxBytes: 1000 });
    assert.equal(w.from, from);
    assert.equal(w.startsMidFile, from > 0 && DATA[from - 1] !== '\n', `the window at ${from}`);
    if (from > 0 && !w.startsMidFile) aligned++;
    assert.equal(w.complete, w.to === DATA_SIZE);
    assert.equal(w.next, w.text.includes('\n') ? from + w.text.lastIndexOf('\n') + 1 : w.to);
    pages.push(w.text);
    if (w.complete) break;
    from = w.to;
  }
  assert.equal(pages.length, Math.ceil(DATA_SIZE / 1000));
  assert.equal(pages.join(''), DATA);
  assert.equal(aligned, 1, 'one page (at 7000) starts just after a newline');

  assert.deepEqual(readWindow(file, { from: DATA_SIZE - 3, maxBytes: 10 }),
    { text: DATA.slice(-3), startsMidFile: true, complete: true, from: DATA_SIZE - 3, to: DATA_SIZE, next: DATA_SIZE, size: DATA_SIZE });
  assert.deepEqual(readWindow(file, { from: DATA_SIZE + 50, maxBytes: 10 }),
    { text: '', startsMidFile: false, complete: true, from: DATA_SIZE, to: DATA_SIZE, next: DATA_SIZE, size: DATA_SIZE }, 'past the end');
});

test('startsMidFile says whether the window\'s first line is cut, from the byte before it', (t) => {
  const dir = scratch(t, 'cf-win-');
  const file = put(path.join(dir, 'abc.txt'), 'aaa\nbbb\nccc\n');
  const shown = (opts) => {
    const w = readWindow(file, opts);
    return [w.text, w.startsMidFile, redactWindow(w.text, w)];
  };
  assert.deepEqual(shown({ from: 1, maxBytes: 4 }), ['aa\nb', true, PARTIAL_LINE]);
  assert.deepEqual(shown({ from: 3, maxBytes: 5 }), ['\nbbb\n', true, 'bbb\n']);
  // A window that starts just after a newline starts a line, and keeps it:
  // the first line of a page is not lost because the page is not the first.
  assert.deepEqual(shown({ from: 4, maxBytes: 4 }), ['bbb\n', false, 'bbb\n']);
  assert.deepEqual(shown({ from: 4, maxBytes: 6 }), ['bbb\ncc', false, 'bbb\n']);
  assert.deepEqual(shown({ from: 5, maxBytes: 7 }), ['bb\nccc\n', true, 'ccc\n']);
  assert.deepEqual(shown({ maxBytes: 8, fromEnd: true }), ['bbb\nccc\n', false, 'bbb\nccc\n']);
  assert.deepEqual(shown({ maxBytes: 7, fromEnd: true }), ['bb\nccc\n', true, 'ccc\n']);

  // Byte 0 is the first byte before any window that starts at 1.
  const blank = put(path.join(dir, 'blank-first.txt'), '\nabc\n');
  const w = readWindow(blank, { from: 1 });
  assert.deepEqual([w.text, w.startsMidFile, redactWindow(w.text, w)], ['abc\n', false, 'abc\n']);
});

test('a byte before the window that the read cannot reach counts as a cut', (t) => {
  const file = put(path.join(scratch(t, 'cf-win-'), 'abc.txt'), 'aaa\nbbb\nccc\n');
  assert.equal(readWindow(file, { from: 4, maxBytes: 4 }).startsMidFile, false);
  // The file shrinks between the measure and the read of byte 3.
  const readSync = fs.readSync;
  t.mock.method(fs, 'readSync', function (fd, buf, off, len, pos) {
    return pos === 3 ? 0 : readSync.call(this, fd, buf, off, len, pos);
  });
  const w = readWindow(file, { from: 4, maxBytes: 4 });
  assert.deepEqual([w.text, w.startsMidFile], ['bbb\n', true]);
  assert.equal(redactWindow(w.text, w), PARTIAL_LINE, 'a line not known to be whole is not shown');
});

test('a reader that pages by `next` and redacts each page shows every line once', (t) => {
  const dir = scratch(t, 'cf-win-');
  const pageThrough = (file, maxBytes) => {
    const pages = [];
    let from = 0;
    for (let i = 0; i < 10000; i++) {
      const w = readWindow(file, { from, maxBytes });
      pages.push(redactWindow(w.text, w));
      if (w.complete) return pages;
      assert.ok(w.next > from, `page ${i} moves on`);
      from = w.next;
    }
    assert.fail('the pages never ended');
  };

  const data = put(path.join(dir, 'data.txt'), DATA);
  assert.equal(pageThrough(data, 1000).join(''), DATA);
  assert.equal(pageThrough(data, 13).join(''), DATA, 'a window barely longer than a line');

  // Characters of two, three and four bytes, cut at every page edge: a page
  // starts on a line, so none is cut at a page's start, and the line cut at a
  // page's end is the next page's first.
  const wide = Array.from({ length: 200 }, (_, i) => `ünïcödé ${i} 東京 𝄞`).join('\n') + '\n';
  const widePath = put(path.join(dir, 'wide.txt'), wide);
  for (const maxBytes of [40, 41, 42, 43, 97]) {
    assert.equal(pageThrough(widePath, maxBytes).join(''), wide, `pages of ${maxBytes} bytes`);
  }

  // A line longer than a page is read on in pieces, each shown as a partial
  // line; the lines around it are shown whole, once.
  const long = put(path.join(dir, 'long.txt'), `short\n${'x'.repeat(50)}\nend\n`);
  const pages = pageThrough(long, 20);
  assert.equal(pages[0], 'short\n');
  assert.equal(pages[pages.length - 1], 'end\n');
  assert.ok(pages.slice(1, -1).length > 0 && pages.slice(1, -1).every((p) => p === PARTIAL_LINE), label(pages));

  // Paging by `to` instead loses the line cut between two pages: each page
  // drops its own half of it.
  const byTo = [];
  for (let from = 0, w; ; from = w.to) {
    w = readWindow(data, { from, maxBytes: 1000 });
    byTo.push(redactWindow(w.text, w));
    if (w.complete) break;
  }
  assert.ok(byTo.join('').length < DATA.length, 'paging by `to` loses lines');
});

test('readWindow never reads past its window, however large the file (task outputs have no cap, V5)', (t) => {
  const size = 64 * 1024 * 1024;
  const big = sparse(path.join(scratch(t, 'cf-win-'), 'big.output'), size, '[exited with code 0]\n');
  const readSync = fs.readSync;
  const reads = [];
  t.mock.method(fs, 'readSync', function (fd, buf, off, len, pos) {
    reads.push({ pos, len });
    return readSync.call(this, fd, buf, off, len, pos);
  });
  // The window, and the one byte before it (which says whether the window's
  // first line is whole) when there is one: nothing else.
  const within = (what, lo, hi) => {
    assert.ok(reads.length > 0, `${what}: read something`);
    const before = reads.filter((r) => r.pos === lo - 1 && r.len === 1);
    assert.equal(before.length, lo > 0 ? 1 : 0, `${what}: the byte before the window, once`);
    const rest = reads.filter((r) => !before.includes(r));
    for (const r of rest) assert.ok(r.pos >= lo && r.pos + r.len <= hi, `${what}: read ${r.len} at ${r.pos}, outside [${lo}, ${hi})`);
    assert.ok(rest.reduce((n, r) => n + r.len, 0) <= hi - lo, `${what}: read no more than the window`);
    reads.length = 0;
  };

  const tail = readWindow(big, { maxBytes: 64, fromEnd: true });
  within('the tail', size - 64, size);
  assert.ok(tail.text.endsWith('[exited with code 0]\n'));
  assert.equal(Buffer.byteLength(tail.text), 64);
  assert.deepEqual({ ...tail, text: undefined },
    { text: undefined, startsMidFile: true, complete: true, from: size - 64, to: size, next: size, size });

  const head = readWindow(big, { maxBytes: 4096 });
  within('the head', 0, 4096);
  assert.equal(head.complete, false);

  const middle = readWindow(big, { from: 1 << 20, maxBytes: 100 });
  within('a page', 1 << 20, (1 << 20) + 100);
  assert.deepEqual([middle.from, middle.to, middle.next, middle.startsMidFile, middle.complete],
    [1 << 20, (1 << 20) + 100, (1 << 20) + 100, true, false]);
});

test('readWindow reads WINDOW_BYTES unless told otherwise, and never more than WINDOW_MAX_BYTES', (t) => {
  assert.ok(WINDOW_BYTES > 0 && WINDOW_BYTES <= WINDOW_MAX_BYTES);
  const size = WINDOW_MAX_BYTES + 4096;
  const huge = sparse(path.join(scratch(t, 'cf-win-'), 'huge.output'), size);

  const all = readWindow(huge, { maxBytes: size * 2 });
  assert.deepEqual([all.from, all.to, all.text.length, all.complete], [0, WINDOW_MAX_BYTES, WINDOW_MAX_BYTES, false]);
  const tail = readWindow(huge, { maxBytes: Number.MAX_SAFE_INTEGER, fromEnd: true });
  assert.deepEqual([tail.from, tail.to, tail.startsMidFile, tail.complete], [size - WINDOW_MAX_BYTES, size, true, true]);
  const byDefault = readWindow(huge);
  assert.deepEqual([byDefault.from, byDefault.to, byDefault.complete], [0, WINDOW_BYTES, false]);
});

test('readWindow reads only a regular file of its own, and never waits on a FIFO', (t) => {
  const dir = scratch(t, 'cf-win-');
  const file = put(path.join(dir, 'real.txt'), 'real\n');
  assert.equal(readWindow(file).text, 'real\n');
  assert.equal(readWindow(link(file, path.join(dir, 'link.txt'))), null, 'a link, even to a regular file');
  fs.mkdirSync(path.join(dir, 'sub'));
  assert.equal(readWindow(path.join(dir, 'sub')), null, 'a directory');
  assert.equal(readWindow(path.join(dir, 'missing.txt')), null, 'nothing there');
  for (const p of [path.relative(process.cwd(), file), 'real.txt', raw(dir, '..', path.basename(dir), 'real.txt'), `${file}/`, ...JUNK]) {
    assert.equal(readWindow(p), null, label(p));
  }
  // An open that waited for a writer would hang the test here.
  const pipe = path.join(dir, 'pipe');
  if (fifo(pipe)) assert.equal(readWindow(pipe), null, 'a FIFO');
});

test('readWindow takes its options as byte counts, or throws a TypeError', (t) => {
  const file = put(path.join(scratch(t, 'cf-win-'), 'data.txt'), DATA);
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, '4096', null, 2 ** 53]) {
    assert.throws(() => readWindow(file, { maxBytes }), TypeError, label(maxBytes));
  }
  for (const from of [-1, 0.5, NaN, '0', null]) {
    assert.throws(() => readWindow(file, { from }), TypeError, label(from));
  }
  assert.throws(() => readWindow(file, { fromEnd: true, from: 0 }), TypeError, 'from and fromEnd together');
  assert.throws(() => readWindow('/nowhere/at/all.txt', { maxBytes: 0 }), TypeError, 'the options before the file');
});

test('a file that shrinks while it is read ends the window where the read stopped', (t) => {
  const file = put(path.join(scratch(t, 'cf-win-'), 'data.txt'), DATA);
  const readSync = fs.readSync;
  let calls = 0;
  t.mock.method(fs, 'readSync', function (fd, buf, off, len, pos) {
    calls++;
    return calls === 1 ? readSync.call(this, fd, buf, off, Math.min(len, 100), pos) : 0;
  });
  assert.deepEqual(readWindow(file, { maxBytes: 1000 }), {
    text: DATA.slice(0, 100), startsMidFile: false, complete: true,
    from: 0, to: 100, next: DATA.lastIndexOf('\n', 99) + 1, size: 100,
  });
});

test('a window is assembled from as many reads as the file takes to give it', (t) => {
  const file = put(path.join(scratch(t, 'cf-win-'), 'data.txt'), DATA);
  const whole = [
    readWindow(file, { maxBytes: 1000 }),
    readWindow(file, { maxBytes: 1000, fromEnd: true }),
    readWindow(file, { from: 4321, maxBytes: 999 }),
  ];
  // A read may return fewer bytes than asked for while more remain (a pipe, a
  // network filesystem, a signal): at most 7 a call here.
  const readSync = fs.readSync;
  let calls = 0;
  t.mock.method(fs, 'readSync', function (fd, buf, off, len, pos) {
    calls++;
    return readSync.call(this, fd, buf, off, Math.min(len, 7), pos);
  });
  assert.deepEqual(readWindow(file, { maxBytes: 1000 }), whole[0]);
  assert.deepEqual(readWindow(file, { maxBytes: 1000, fromEnd: true }), whole[1]);
  assert.deepEqual(readWindow(file, { from: 4321, maxBytes: 999 }), whole[2]);
  assert.ok(calls >= 3 * Math.ceil(999 / 7), `${calls} reads`);
});

test('the window\'s flags feed redactWindow: a cut edge goes with its line, a whole one stays', (t) => {
  const fake = fakeSecrets({ seed: 21 }).find((f) => f.id === 'sk-anthropic-api');
  const key = fake.secrets[0];
  const text = `first line\n${fake.text}\nlast line\n`;
  const file = put(path.join(scratch(t, 'cf-win-'), 'out.txt'), text);
  const size = Buffer.byteLength(text);
  const keyAt = text.indexOf(key); // ASCII: a byte offset too

  // A window that opens inside the key: what it holds of the key no longer
  // looks like one, so only the flag keeps it off the screen.
  const tail = readWindow(file, { maxBytes: size - (keyAt + 24), fromEnd: true });
  assert.deepEqual([tail.startsMidFile, tail.complete], [true, true]);
  assert.notDeepEqual(findLeaks(tail.text, [fake]), [], 'the raw window holds part of the key');
  assert.equal(redactWindow(tail.text, tail), 'last line\n');

  // A window that closes inside the key.
  const head = readWindow(file, { maxBytes: keyAt + 24 });
  assert.deepEqual([head.startsMidFile, head.complete], [false, false]);
  assert.equal(redactWindow(head.text, head), 'first line\n');

  // The whole file: nothing is cut, every line stays, the key is masked where it stood.
  const whole = readWindow(file, { maxBytes: size });
  assert.deepEqual([whole.startsMidFile, whole.complete], [false, true]);
  const shown = redactWindow(whole.text, whole);
  assert.deepEqual(findLeaks(shown, [fake]), []);
  assert.ok(shown.startsWith('first line\ncalling the API with ') && shown.endsWith(' today\nlast line\n'), shown);
});

test('a character cut in two at a window\'s edge goes with the cut line', (t) => {
  const text = 'naïve café\nplain\nrésumé ünïcode\n';
  const file = put(path.join(scratch(t, 'cf-win-'), 'utf8.txt'), text);
  const bytes = Buffer.from(text);

  const inCafe = bytes.indexOf(Buffer.from('é')) + 1; // between the two bytes of café's é
  const tail = readWindow(file, { maxBytes: bytes.length - inCafe, fromEnd: true });
  assert.equal(tail.from, inCafe);
  assert.ok(tail.text.startsWith('�'), label(tail.text));
  assert.equal(redactWindow(tail.text, tail), 'plain\nrésumé ünïcode\n');

  const inU = bytes.indexOf(Buffer.from('ü')) + 1;
  const head = readWindow(file, { maxBytes: inU });
  assert.ok(head.text.endsWith('�'), label(head.text));
  assert.equal(redactWindow(head.text, head), 'naïve café\nplain\n');

  // A window holding no whole line at all shows nothing of it.
  const sliver = readWindow(file, { from: inCafe, maxBytes: 4 });
  assert.equal(redactWindow(sliver.text, sliver), PARTIAL_LINE);
});

// ── the module ───────────────────────────────────────────────────────────────

test('lib/core/claude-files imports nothing but fs, path and ./paths', () => {
  const src = fs.readFileSync(require.resolve('../lib/core/claude-files'), 'utf8');
  const required = [...src.matchAll(/\brequire\s*\(([^)]*)\)/g)].map((m) => m[1].trim()).sort();
  assert.deepEqual(required, ["'./paths'", "'fs'", "'path'"]);
  assert.doesNotMatch(src, /\bimport\s*\(/, 'no dynamic import');
  assert.doesNotMatch(src, /^\s*import[\s{*]/m, 'no static import');
});
