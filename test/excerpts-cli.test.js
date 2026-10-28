// `claude-web-chat excerpts on|off|status` (U422; DECISIONS.md L.4 P3 = a):
// the host's one writer of the project's excerpt switch (lib/core/excerpts).
// status says on or off and whether that is this project's record or the
// default, and names a corrupt or invalid record; on/off write {v: 1, on}; a
// bad verb prints the usage and exits 1; outside a project it refuses as
// `mod` does (resolveRoot's userFacing refusal, reported by main()).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const excerpts = require('../lib/cli/commands/excerpts');
const { main } = require('../lib/cli');
const { projectPaths } = require('../lib/core/paths');
const { readSwitch } = require('../lib/core/excerpts');
const { withTempHome, tmpRoot } = require('../test-support/helpers');

function sink() {
  const lines = [];
  const log = (s = '') => lines.push(String(s));
  log.lines = lines;
  log.text = () => lines.join('\n');
  return log;
}
// A project: a folder with a .web-chat/ (what resolveRoot's 'existing' mode finds).
function project(t) {
  withTempHome(t);
  const root = fs.realpathSync(tmpRoot('wc-u422-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const recordOf = (root) => JSON.parse(fs.readFileSync(projectPaths(root).excerpts, 'utf8'));

test('excerpts status on a fresh project says off, the default', (t) => {
  const root = project(t);
  const log = sink();
  const r = excerpts(['status'], { cwd: root, log });
  assert.equal(r.ok, true);
  assert.equal(r.on, false);
  assert.equal(r.source, 'default');
  assert.equal(r.state, 'absent');
  assert.deepEqual(log.lines, [
    'excerpts: off (the default; this project has no record)',
    '  Claude receives the passages you pin by id only, never their words',
  ]);
  assert.equal(fs.existsSync(projectPaths(root).excerpts), false, 'status writes nothing');
});

test('excerpts on, then status, says on from this project\'s record; off writes {v:1,on:false}', (t) => {
  const root = project(t);
  let log = sink();
  const on = excerpts(['on'], { cwd: root, log });
  assert.equal(on.ok, true);
  assert.deepEqual(recordOf(root), { v: 1, on: true });
  assert.deepEqual(log.lines, [
    'excerpts: on (this project\'s record, .web-chat/excerpts.json)',
    '  Claude receives the words of the passages you pin, quoted as data',
    `  ${excerpts.APPLIES_LINE}`,
  ]);
  assert.match(excerpts.APPLIES_LINE, /next Push/);

  log = sink();
  const st = excerpts(['status'], { cwd: root, log });
  assert.equal(st.on, true);
  assert.equal(st.source, 'record');
  assert.equal(log.lines[0], 'excerpts: on (this project\'s record, .web-chat/excerpts.json)');

  log = sink();
  excerpts(['off'], { cwd: root, log });
  assert.deepEqual(recordOf(root), { v: 1, on: false });
  assert.equal(log.lines[0], 'excerpts: off (this project\'s record, .web-chat/excerpts.json)');
  assert.equal(log.lines[1], '  Claude receives the passages you pin by id only, never their words');
  log = sink();
  assert.equal(excerpts(['status'], { cwd: root, log }).source, 'record');
  assert.equal(log.lines[0], 'excerpts: off (this project\'s record, .web-chat/excerpts.json)');
});

test('a corrupt or invalid record: status names it (reads as off) and leaves it; on rewrites it', (t) => {
  const root = project(t);
  const file = projectPaths(root).excerpts;
  for (const [bytes, state] of [['{"v":1,"on":', 'corrupt'], ['{"v":1,"on":"yes"}', 'invalid']]) {
    fs.writeFileSync(file, bytes);
    const log = sink();
    const r = excerpts(['status'], { cwd: root, log });
    assert.equal(r.on, false);
    assert.equal(r.state, state);
    assert.equal(log.lines[0], `excerpts: off (the default; .web-chat/excerpts.json is ${state}: reads as off; \`excerpts on|off\` rewrites it)`);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'status leaves the record as it is');
  }
  excerpts(['on'], { cwd: root, log: sink() });
  assert.deepEqual(recordOf(root), { v: 1, on: true });
  assert.deepEqual(readSwitch(root), { on: true, source: 'record', state: 'ok' });
});

test('a subdirectory of a project reaches the project\'s record', (t) => {
  const root = project(t);
  const sub = path.join(root, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  const r = excerpts(['on'], { cwd: sub, log: sink() });
  assert.equal(r.root, root);
  assert.deepEqual(recordOf(root), { v: 1, on: true });
  assert.equal(fs.existsSync(path.join(sub, '.web-chat')), false);
});

test('a bad verb (or none, or a trailing word) prints the usage and exits 1, writing nothing', (t) => {
  const root = project(t);
  for (const args of [[], ['yes'], ['ON'], ['toggle'], ['on', 'please']]) {
    const log = sink();
    const prev = process.exitCode;
    const r = excerpts(args, { cwd: root, log });
    const code = process.exitCode;
    process.exitCode = prev;
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.equal(r.exitCode, 1);
    assert.equal(code, 1);
    assert.deepEqual(log.lines, ['usage: claude-web-chat excerpts on|off|status']);
  }
  assert.equal(fs.existsSync(projectPaths(root).excerpts), false);
});

test('outside a project it refuses as mod does: one line from main(), exit 1, nothing written', (t) => {
  withTempHome(t);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u422-none-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => excerpts(['on'], { cwd: dir, log: sink() }), (e) => e.userFacing === true && /no \.web-chat\/ in .* — run `claude-web-chat init` first/.test(e.message));

  const prevCwd = process.cwd();
  const prevExit = process.exitCode;
  const errs = [];
  const prevErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  process.chdir(dir);
  try {
    main(['excerpts', 'on']);
    assert.equal(process.exitCode, 1);
  } finally {
    process.chdir(prevCwd);
    process.exitCode = prevExit;
    console.error = prevErr;
  }
  assert.equal(errs.length, 1, 'one line, not a stack trace');
  assert.match(errs[0], /no \.web-chat\/ in .* — run `claude-web-chat init` first/);
  assert.equal(fs.existsSync(path.join(dir, '.web-chat')), false);
});

test('the command is registered, in showHelp, and its guide row is in the plain command block', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cli', 'index.js'), 'utf8');
  assert.match(src, /^ {2}excerpts: require\('\.\/commands\/excerpts'\),$/m);
  assert.match(src, /^ {2}excerpts on\|off\|status$/m);
  const guide = fs.readFileSync(path.join(__dirname, '..', 'docs', 'guide.md'), 'utf8');
  assert.match(guide, /^excerpts \[verb\] {2,}on \| off \| status: whether Claude receives the words of the$/m);
});
