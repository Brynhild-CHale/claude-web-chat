// The one reader of Claude Code's per-process state files,
// <sessions>/<pid>.json (lib/core/claude-sessions, spec §2.2).
//
// Pinned:
//   * a file reads into the fields the mirror reads, each checked for its type
//     and bounded; anything else in the file never leaves the module;
//   * only a positive integer pid names a file, the file must say it is that
//     pid's, and `sessionId` filters;
//   * listSessionPids lists exactly the digits-only `<pid>.json` names;
//   * THE `.key` BESIDE EACH FILE IS NEVER OPENED: every fs entry point that can
//     open a file is watched while the module lists and reads a sessions
//     directory full of keys, and a `<pid>.json` that is a symbolic or hard link
//     to a key reads as nothing — the key's sentinel never comes back;
//   * a FIFO, a directory or an oversized file named like a sessions file reads
//     as null, without blocking.
//
// Everything runs in a private Claude tier (test-support/claude-home with
// isolate: true), under the test sandbox.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome, FAKE_PEER_KEY, CLAUDE_CODE_VERSION } = require('../test-support/claude-home');
const { userClaudePaths } = require('../lib/core/paths');
const {
  readSessionState, listSessionPids, readAllSessionStates, pidOfName, MAX_BYTES,
} = require('../lib/core/claude-sessions');

const SID = '0b6f7c1e-4c1d-4a8e-9a43-5d2f0e3c9b11';
const SID2 = '5e9d2c4b-1a7f-4e3c-8b6d-2f0a9c8e7d61';
const SID3 = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const PROC_START = 'Fri Oct  2 04:22:15 2026';

function project(t) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-csess-'));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tier(t) {
  return claudeHome(t, { root: project(t), isolate: true });
}

// Write a sessions file by hand (the fixture's writer fills in defaults).
function rawSession(ch, name, body) {
  const file = path.join(ch.sessionsDir, name);
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

// Every fs entry point that can open a file, watched for the duration of fn().
function watchOpens(fn) {
  const opened = [];
  const names = ['openSync', 'readFileSync', 'open', 'readFile', 'createReadStream'];
  const saved = names.map((n) => [n, fs[n]]);
  const savedPromises = { open: fs.promises.open, readFile: fs.promises.readFile };
  const note = (p) => { if (typeof p === 'string' || Buffer.isBuffer(p) || p instanceof URL) opened.push(String(p)); };
  for (const [n, original] of saved) {
    fs[n] = function watched(p, ...rest) { note(p); return original.call(this, p, ...rest); };
  }
  fs.promises.open = function watched(p, ...rest) { note(p); return savedPromises.open.call(this, p, ...rest); };
  fs.promises.readFile = function watched(p, ...rest) { note(p); return savedPromises.readFile.call(this, p, ...rest); };
  try {
    return { result: fn(), opened };
  } finally {
    for (const [n, original] of saved) fs[n] = original;
    fs.promises.open = savedPromises.open;
    fs.promises.readFile = savedPromises.readFile;
  }
}

test('a sessions file reads into the fields the mirror reads, each checked and bounded', (t) => {
  const ch = tier(t);
  const { record } = ch.writeSession({
    pid: 4242,
    procStart: PROC_START,
    sessionId: SID,
    status: 'waiting',
    waitingFor: 'permission prompt',
    name: 'quiet-river',
    formerNames: [{ sessionId: SID2, name: 'first' }, { sessionId: SID3 }],
    // Not read: never handed on.
    token: 'SECRET-never-leaves',
    messagingSocketPath: '/tmp/x.sock',
  });
  const st = readSessionState({ pid: 4242 });
  assert.ok(Object.isFrozen(st), 'a frozen copy');
  assert.deepEqual(st, {
    pid: 4242,
    sessionId: SID,
    cwd: ch.cwd,
    procStart: PROC_START,
    startedAt: record.startedAt,
    version: CLAUDE_CODE_VERSION,
    kind: 'interactive',
    entrypoint: 'cli',
    status: 'waiting',
    waitingFor: 'permission prompt',
    updatedAt: record.updatedAt,
    statusUpdatedAt: record.statusUpdatedAt,
    name: 'quiet-river',
    formerNames: [{ sessionId: SID2, name: 'first' }, { sessionId: SID3, name: null }],
  });
  assert.ok(!JSON.stringify(st).includes('SECRET'), 'a field the mirror does not read is not handed on');

  // The sessionId filter.
  assert.equal(readSessionState({ pid: 4242, sessionId: SID }).sessionId, SID);
  assert.equal(readSessionState({ pid: 4242, sessionId: SID2 }), null, 'a file naming another session');
  assert.equal(readSessionState({ pid: 4242, sessionId: 'not/an/id' }), null);
});

test('each field is checked for its shape: a wrong one is null, never passed through', (t) => {
  const ch = tier(t);
  rawSession(ch, '5150.json', {
    pid: 5150,
    sessionId: '../../etc',
    cwd: 'relative/dir',
    procStart: 'Fri Oct  2 04:22:15 2026\n<script>',
    startedAt: -1,
    version: 'two point one',
    kind: 'Interactive Session',
    entrypoint: 'sdk cli',
    status: 42,
    waitingFor: 'x'.repeat(201),
    updatedAt: 'yesterday',
    statusUpdatedAt: Infinity,
    name: '',
    formerNames: 'first',
  });
  const st = readSessionState({ pid: 5150 });
  assert.deepEqual(st, {
    pid: 5150, sessionId: null, cwd: null, procStart: null, startedAt: null, version: null, kind: null,
    entrypoint: null, status: null, waitingFor: null, updatedAt: null, statusUpdatedAt: null, name: null, formerNames: [],
  });

  // cwd: absolute and normalised only.
  for (const cwd of ['/a/../b', '/a/./b', '/a//b', '/a/b/', 'a/b', '/a\0b']) {
    rawSession(ch, '5151.json', { pid: 5151, sessionId: SID, cwd });
    assert.equal(readSessionState({ pid: 5151 }).cwd, null, JSON.stringify(cwd));
  }
  rawSession(ch, '5151.json', { pid: 5151, sessionId: SID, cwd: '/a/b' });
  assert.equal(readSessionState({ pid: 5151 }).cwd, '/a/b');

  // formerNames: entries with a session id, each once, at most 100.
  const many = [];
  for (let i = 0; i < 150; i++) many.push({ sessionId: `s${String(i).padStart(4, '0')}`, name: `n${i}` });
  rawSession(ch, '5152.json', {
    pid: 5152, sessionId: SID,
    formerNames: [{ sessionId: SID2 }, { sessionId: SID2 }, 'name-only', { name: 'no id' }, { sessionId: '-x' }, null, ...many],
  });
  const former = readSessionState({ pid: 5152 }).formerNames;
  assert.equal(former[0].sessionId, SID2);
  assert.equal(former.filter((f) => f.sessionId === SID2).length, 1, 'deduplicated');
  assert.ok(former.every((f) => /^[A-Za-z0-9]/.test(f.sessionId)), 'only well-formed session ids');
  assert.equal(former.length, 100, 'bounded');
});

test('only a positive integer pid names a file, and the file must be that pid\'s', (t) => {
  const ch = tier(t);
  ch.writeSession({ pid: 4242, procStart: PROC_START, sessionId: SID });
  for (const pid of ['4242', 4242.5, -4242, 0, NaN, null, undefined, {}, [4242], 2 ** 53]) {
    assert.equal(readSessionState({ pid }), null, String(pid));
  }
  assert.equal(readSessionState(), null);
  assert.equal(readSessionState({ pid: 4243 }), null, 'no file');

  // A record whose own pid field names another process.
  rawSession(ch, '6000.json', { pid: 6001, sessionId: SID });
  assert.equal(readSessionState({ pid: 6000 }), null);
  // One without a pid field is taken as the file's.
  rawSession(ch, '6002.json', { sessionId: SID });
  assert.equal(readSessionState({ pid: 6002 }).pid, 6002);
  // Not JSON, or not an object.
  for (const body of ['{', '', 'null', '[1,2]', '"text"', '42']) {
    rawSession(ch, '6003.json', body);
    assert.equal(readSessionState({ pid: 6003 }), null, JSON.stringify(body));
  }
  // Larger than any sessions file.
  rawSession(ch, '6004.json', JSON.stringify({ pid: 6004, sessionId: SID, pad: 'x'.repeat(MAX_BYTES) }));
  assert.equal(readSessionState({ pid: 6004 }), null);
});

test('listSessionPids lists exactly the digits-only <pid>.json names', (t) => {
  const ch = tier(t);
  for (const pid of [123, 45, 99999]) ch.writeSession({ pid, procStart: null, sessionId: SID });
  for (const name of ['0123.json', '0.json', 'abc.json', '123.json.bak', '123.json.4242.tmp', '-5.json', '1e3.json',
    '124.JSON', ' 12.json', '12 .json', '12.jsonl', '.json', '7.key', 'x7.json', '+8.json', '9'.repeat(17) + '.json']) {
    rawSession(ch, name, { pid: 1, sessionId: SID });
  }
  fs.mkdirSync(path.join(ch.sessionsDir, '77.json')); // listed by its name; reads as nothing
  assert.deepEqual(listSessionPids(), [45, 77, 123, 99999]);
  assert.deepEqual(readAllSessionStates().map((s) => s.pid), [45, 123, 99999], 'the directory is no sessions file');

  for (const [name, pid] of [['123.json', 123], ['1.json', 1], ['0123.json', null], ['123.key', null], ['12.jsonl', null], [null, null]]) {
    assert.equal(pidOfName(name), pid, String(name));
  }

  // No directory at all.
  fs.rmSync(ch.sessionsDir, { recursive: true, force: true });
  assert.deepEqual(listSessionPids(), []);
  assert.deepEqual(readAllSessionStates(), []);
});

test('the .key beside each sessions file is never opened, through any name', (t) => {
  const ch = tier(t);
  // The fixture writes its decoy, FAKE_PEER_KEY, into a 0600 <pid>.key beside
  // each sessions file, as Claude Code writes a peer token.
  for (const pid of [111, 222, 333]) ch.writeSession({ pid, procStart: PROC_START, sessionId: SID });
  const SENTINEL = 'KEY-SENTINEL-6c2e1f9a';
  // A key whose sessions file is a symbolic link to it.
  fs.writeFileSync(path.join(ch.sessionsDir, '444.key'), JSON.stringify({ pid: 444, sessionId: SID, name: `${SENTINEL}-444` }));
  fs.symlinkSync('444.key', path.join(ch.sessionsDir, '444.json'));
  // A key whose sessions file is a hard link to it (one inode, two names).
  fs.writeFileSync(path.join(ch.sessionsDir, '555.key'), JSON.stringify({ pid: 555, sessionId: SID, name: `${SENTINEL}-555` }));
  fs.linkSync(path.join(ch.sessionsDir, '555.key'), path.join(ch.sessionsDir, '555.json'));
  // Another process's key, under a sessions-file name of its own.
  fs.symlinkSync(path.join(ch.sessionsDir, '111.key'), path.join(ch.sessionsDir, '666.json'));

  const { result, opened } = watchOpens(() => {
    const listed = listSessionPids();
    const all = readAllSessionStates();
    const one = listed.map((pid) => readSessionState({ pid }));
    return { listed, all, one };
  });

  assert.deepEqual(result.listed, [111, 222, 333, 444, 555, 666]);
  assert.deepEqual(result.all.map((s) => s.pid), [111, 222, 333], 'the linked names read as nothing');
  const out = JSON.stringify(result);
  assert.ok(!out.includes(SENTINEL) && !out.includes(FAKE_PEER_KEY), 'no key content came back');
  assert.ok(opened.length > 0, 'the watch saw the reads');
  assert.deepEqual(opened.filter((p) => p.endsWith('.key')), [], 'no .key was opened');
  for (const p of opened) assert.match(path.basename(p), /^[1-9][0-9]*\.json$/, `only <pid>.json names are opened: ${p}`);
  for (const pid of [111, 222, 333]) {
    assert.equal(fs.readFileSync(path.join(ch.sessionsDir, `${pid}.key`), 'utf8'), FAKE_PEER_KEY, 'the keys are as they were');
  }
});

test('a FIFO, a directory or an unreadable file named like a sessions file is nothing, at once', (t) => {
  const ch = tier(t);
  const fifo = path.join(ch.sessionsDir, '888.json');
  // A FIFO with no writer would block an ordinary open for ever (the test's
  // timeout is the failure); the reader opens without waiting and refuses it.
  if (spawnSync('mkfifo', [fifo]).status === 0) assert.equal(readSessionState({ pid: 888 }), null);
  fs.mkdirSync(path.join(ch.sessionsDir, '889.json'));
  assert.equal(readSessionState({ pid: 889 }), null);
  const locked = rawSession(ch, '890.json', { pid: 890, sessionId: SID });
  fs.chmodSync(locked, 0o000);
  t.after(() => { try { fs.chmodSync(locked, 0o600); } catch {} });
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    assert.equal(readSessionState({ pid: 890 }), null);
  }
});

test('the sessions directory follows CLAUDE_CONFIG_DIR', (t) => {
  const a = tier(t);
  a.writeSession({ pid: 4242, procStart: null, sessionId: SID });
  assert.equal(path.dirname(userClaudePaths().claudeSessionStateFile(4242)), a.sessionsDir);
  assert.equal(readSessionState({ pid: 4242 }).sessionId, SID);
  const b = tier(t); // a second private tier, now in force
  assert.notEqual(b.sessionsDir, a.sessionsDir);
  assert.equal(readSessionState({ pid: 4242 }), null, 'the other tier is not read');
  b.writeSession({ pid: 4242, procStart: null, sessionId: SID2 });
  assert.equal(readSessionState({ pid: 4242 }).sessionId, SID2);
});

test('the field checks are exported, and conversations.json is read back through them, not a second copy', () => {
  const claudeSessions = require('../lib/core/claude-sessions');
  const ctrl = String.fromCharCode(7);
  const cases = [
    ['entrypointOf', ['cli', 'sdk-cli', 'sdk-ts', 'claude-vscode'], ['', '-cli', 'a'.repeat(41), 'a b', 42, null]],
    ['wordOf', ['busy', 'interactive', 'bg'], ['Busy', '', 'a'.repeat(33), 7, null]],
    ['versionOf', ['2.1.287'], ['', '2.1 .287', 'a'.repeat(41), `2.1${ctrl}`, null]],
    ['procStartOf', [PROC_START], ['', `Fri${ctrl}`, 'a'.repeat(65), 1, null]],
    ['sessionIdOf', [SID, SID2], ['', '../x', '_x', 'a/b', null]],
  ];
  for (const [name, good, bad] of cases) {
    const check = claudeSessions[name];
    assert.equal(typeof check, 'function', name);
    for (const v of good) assert.equal(check(v), v, `${name}(${JSON.stringify(v)})`);
    for (const v of bad) assert.equal(check(v), null, `${name}(${JSON.stringify(v)})`);
  }
  // The conversation registry holds the same fields in conversations.json and
  // reads them back by these checks: one grammar per field, written once.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'mirror', 'conversations.js'), 'utf8');
  for (const name of ['ENTRYPOINT_RE', 'WORD_RE', 'VERSION_RE', 'PROC_START_RE']) {
    assert.ok(!src.includes(name), `conversations.js declares no ${name} of its own`);
  }
  assert.match(src, /\{ entrypointOf, wordOf, versionOf, procStartOf \} = claudeSessions/);
});
