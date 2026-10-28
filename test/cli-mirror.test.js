// `claude-web-chat mirror budget <size>|unlimited|status` (U455; DECISIONS.md
// L.4 P4 = c; RULED R2 = a): the host's one writer of the chat mirror's disk
// budget (lib/core/mirror-settings, .web-chat/mirror.json).
//
// Pinned:
//   * `mirror budget 2GiB` writes {v: 1, disk_budget_bytes: 2147483648} at
//     projectPaths().mirrorSettings and says when a running server applies it;
//   * `mirror budget status` prints the budget (or unlimited), whether that is
//     this project's record or the default (a corrupt record named, left as it
//     is) and the measured size of .web-chat/mirror/ with its three parts;
//   * `mirror budget unlimited` writes null;
//   * a bad size (under 64 MiB, negative, an unknown unit) exits non-zero with
//     the hint and writes nothing; a bad verb prints the usage;
//   * no HTTP request and no socket is opened: no daemon is needed or reached;
//   * main() routes `mirror` (the commands map) and refuses outside a project.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

const mirror = require('../lib/cli/commands/mirror');
const { main } = require('../lib/cli');
const { projectPaths } = require('../lib/core/paths');
const { readMirrorSettings } = require('../lib/core/mirror-settings');
const { withTempHome, tmpRoot } = require('../test-support/helpers');

function sink() {
  const lines = [];
  const log = (s = '') => lines.push(String(s));
  log.lines = lines;
  return log;
}
function project(t) {
  withTempHome(t);
  const root = fs.realpathSync(tmpRoot('wc-u455-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const recordOf = (root) => JSON.parse(fs.readFileSync(projectPaths(root).mirrorSettings, 'utf8'));
// Run fn with process.exitCode saved and restored; answers [result, exitCode].
function withExit(fn) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  try {
    const r = fn();
    return [r, process.exitCode];
  } finally {
    process.exitCode = prev;
  }
}
// Fail the test on any outbound HTTP request or socket while fn runs.
function noNetwork(fn) {
  const saved = { request: http.request, get: http.get, connect: net.connect, createConnection: net.createConnection };
  const calls = [];
  const trap = (name) => (...a) => { calls.push(name); throw new Error(`no network: ${name}`); };
  http.request = trap('http.request');
  http.get = trap('http.get');
  net.connect = trap('net.connect');
  net.createConnection = trap('net.createConnection');
  try {
    return fn();
  } finally {
    Object.assign(http, { request: saved.request, get: saved.get });
    Object.assign(net, { connect: saved.connect, createConnection: saved.createConnection });
    assert.deepEqual(calls, [], 'no daemon call');
  }
}

test('mirror budget 2GiB writes {v: 1, disk_budget_bytes: 2147483648} and says when a running server applies it; no daemon is reached', (t) => {
  const root = project(t);
  const log = sink();
  const r = noNetwork(() => mirror(['budget', '2GiB'], { cwd: root, log }));
  assert.equal(r.ok, true);
  assert.deepEqual(recordOf(root), { v: 1, disk_budget_bytes: 2147483648 });
  assert.deepEqual(readMirrorSettings(projectPaths(root)), { v: 1, disk_budget_bytes: 2147483648 });
  assert.equal(fs.readFileSync(projectPaths(root).mirrorSettings, 'utf8').endsWith('\n'), true);
  assert.deepEqual(log.lines, [
    'mirror budget: 2 GiB (2147483648 bytes); this project\'s record, .web-chat/mirror.json',
    `  ${mirror.ORDER_LINE}`,
    `  ${mirror.APPLIES_LINE}`,
  ]);
  assert.match(mirror.APPLIES_LINE, /every 6 hours/);
  assert.match(mirror.APPLIES_LINE, /claude-web-chat restart/);
});

test('mirror budget status prints the budget and the measured sizes of .web-chat/mirror/ and its three parts', (t) => {
  const root = project(t);
  const p = projectPaths(root);
  // A fresh project: unlimited, the default; nothing written.
  let log = sink();
  let r = noNetwork(() => mirror(['budget', 'status'], { cwd: root, log }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings, { v: 1, disk_budget_bytes: null });
  assert.equal(r.state, 'absent');
  assert.deepEqual(log.lines, [
    'mirror budget: unlimited; the default, this project has no record',
    '  .web-chat/mirror/ holds 0 B: index 0 B, diffs 0 B, shadow store 0 B',
    `  ${mirror.UNLIMITED_LINE}`,
  ]);
  assert.equal(fs.existsSync(p.mirrorSettings), false, 'status writes nothing');

  // A mirror with files in each part, and a budget set.
  fs.mkdirSync(p.mirrorIndexDir, { recursive: true });
  fs.mkdirSync(p.mirrorDiffsDir, { recursive: true });
  fs.mkdirSync(path.join(p.mirrorGit, 'objects', 'ab'), { recursive: true });
  fs.writeFileSync(path.join(p.mirrorIndexDir, 's.json'), Buffer.alloc(2048));
  fs.writeFileSync(path.join(p.mirrorDiffsDir, 't.json'), Buffer.alloc(1024));
  fs.writeFileSync(path.join(p.mirrorGit, 'objects', 'ab', 'cd'), Buffer.alloc(3 * 1024 * 1024));
  fs.writeFileSync(p.mirrorConversations, Buffer.alloc(100));
  mirror(['budget', '500MB'], { cwd: root, log: sink() });
  log = sink();
  r = noNetwork(() => mirror(['budget', 'status'], { cwd: root, log }));
  assert.deepEqual(r.measured, { total: 2048 + 1024 + 3 * 1024 * 1024 + 100, index: 2048, diffs: 1024, shadow: 3 * 1024 * 1024 });
  assert.deepEqual(log.lines, [
    'mirror budget: 476.8 MiB (500000000 bytes); this project\'s record, .web-chat/mirror.json',
    '  .web-chat/mirror/ holds 3.0 MiB: index 2 KiB, diffs 1 KiB, shadow store 3 MiB',
    `  ${mirror.ORDER_LINE}`,
  ]);
});

test('mirror budget unlimited writes null; a corrupt record reads as unlimited, status names it and leaves it', (t) => {
  const root = project(t);
  const file = projectPaths(root).mirrorSettings;
  mirror(['budget', '1GiB'], { cwd: root, log: sink() });
  const log = sink();
  mirror(['budget', 'unlimited'], { cwd: root, log });
  assert.deepEqual(recordOf(root), { v: 1, disk_budget_bytes: null });
  assert.deepEqual(log.lines, [
    'mirror budget: unlimited; this project\'s record, .web-chat/mirror.json',
    `  ${mirror.UNLIMITED_LINE}`,
    `  ${mirror.APPLIES_LINE}`,
  ]);
  for (const [bytes, state] of [['{"v":1,"disk_budget_bytes":', 'corrupt'], ['{"v":2,"disk_budget_bytes":null}', 'invalid']]) {
    fs.writeFileSync(file, bytes);
    const l = sink();
    const r = mirror(['budget', 'status'], { cwd: root, log: l });
    assert.equal(r.state, state);
    assert.equal(r.settings.disk_budget_bytes, null);
    assert.equal(l.lines[0], `mirror budget: unlimited; the default, .web-chat/mirror.json is ${state} and reads as unlimited (\`mirror budget <size>|unlimited\` rewrites it)`);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'status leaves the record as it is');
  }
});

test('a bad size exits non-zero with the hint and writes nothing; a bad verb prints the usage', (t) => {
  const root = project(t);
  const file = projectPaths(root).mirrorSettings;
  for (const [size, code, re] of [['10MB', 'under-floor', /under the smallest budget, 64 MiB/], ['-1', 'bad-size', /not a size/], ['2XB', 'bad-size', /not a size/]]) {
    const log = sink();
    const errs = sink();
    const [r, exit] = withExit(() => noNetwork(() => mirror(['budget', size], { cwd: root, log, error: errs })));
    assert.equal(r.ok, false, size);
    assert.equal(r.code, code, size);
    assert.equal(exit, 1, size);
    assert.match(errs.lines.join('\n'), re, size);
    assert.deepEqual(log.lines, [mirror.USAGE]);
    assert.equal(fs.existsSync(file), false, `${size}: nothing written`);
  }
  for (const args of [[], ['budget'], ['status'], ['budget', '2GiB', 'now'], ['on']]) {
    const log = sink();
    const [r, exit] = withExit(() => mirror(args, { cwd: root, log }));
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.equal(exit, 1);
    assert.deepEqual(log.lines, ['usage: claude-web-chat mirror budget <size>|unlimited|status']);
  }
  assert.equal(fs.existsSync(file), false);
});

test('main() routes `mirror`; a subdirectory reaches the project\'s record; outside a project it refuses', (t) => {
  const root = project(t);
  const sub = path.join(root, 'src');
  fs.mkdirSync(sub);
  const r = mirror(['budget', '64MiB'], { cwd: sub, log: sink() });
  assert.equal(r.root, root);
  assert.deepEqual(recordOf(root), { v: 1, disk_budget_bytes: 64 * 1024 * 1024 });
  assert.equal(fs.existsSync(path.join(sub, '.web-chat')), false);

  const cwd = process.cwd();
  const out = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (s = '') => out.push(String(s));
  console.error = (s = '') => out.push(String(s));
  try {
    process.chdir(root);
    const [, exit] = withExit(() => main(['mirror', 'budget', 'status']));
    assert.equal(exit, undefined);
    assert.match(out[0], /^mirror budget: 64 MiB \(67108864 bytes\); this project's record/);
    const away = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'wc-u455-none-')));
    t.after(() => fs.rmSync(away, { recursive: true, force: true }));
    process.chdir(away);
    out.length = 0;
    const [, exit2] = withExit(() => main(['mirror', 'budget', 'status']));
    assert.equal(exit2, 1);
    assert.match(out.join('\n'), /no \.web-chat\/ in .* run `claude-web-chat init` first/);
  } finally {
    process.chdir(cwd);
    console.log = origLog;
    console.error = origErr;
  }
});
