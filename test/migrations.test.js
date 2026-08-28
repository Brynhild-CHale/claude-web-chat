const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { run, SCHEMA_VERSION } = require('../lib/update/migrations');
const v1ToV2 = require('../lib/update/migrations/v1-to-v2');

// A stateDir must be named `.web-chat` under a root, because the runner mints the
// _version.json path from projectPaths(dirname(stateDir)).
function tmpState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-mig-'));
  const stateDir = path.join(root, '.web-chat');
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, stateDir, versionFile: path.join(stateDir, '_version.json') };
}
const readVersion = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).version;
const writeVersion = (f, v) => fs.writeFileSync(f, JSON.stringify({ version: v }, null, 2) + '\n');

test('SCHEMA_VERSION is 2 (first real migration landed)', () => {
  assert.equal(SCHEMA_VERSION, 2);
});

test('first-touch: a stateDir with no _version.json is stamped at SCHEMA_VERSION without migrating', () => {
  const { stateDir, versionFile } = tmpState();
  // A stray server.pid must survive first-touch: an unversioned dir is treated as
  // the current baseline, not as v1 needing the v1→v2 migration.
  const pid = path.join(stateDir, 'server.pid');
  fs.writeFileSync(pid, '12345');
  run(stateDir);
  assert.equal(readVersion(versionFile), SCHEMA_VERSION);
  assert.ok(fs.existsSync(pid), 'first-touch does not run migrations against a fresh baseline');
});

test('v1 → v2: removes the orphaned server.pid and stamps version 2', () => {
  const { stateDir, versionFile } = tmpState();
  writeVersion(versionFile, 1);
  const pid = path.join(stateDir, 'server.pid');
  fs.writeFileSync(pid, '999');
  run(stateDir);
  assert.equal(readVersion(versionFile), 2);
  assert.ok(!fs.existsSync(pid), 'orphaned server.pid removed');
});

test('idempotent: re-running an already-migrated dir is a no-op and never throws', () => {
  const { stateDir, versionFile } = tmpState();
  writeVersion(versionFile, 1);
  fs.writeFileSync(path.join(stateDir, 'server.pid'), '1');
  run(stateDir);
  assert.equal(readVersion(versionFile), 2);
  run(stateDir); // second pass: nothing to do
  assert.equal(readVersion(versionFile), 2);
});

test('v1 → v2 with no server.pid present still stamps 2 (unlink of a missing file is a no-op)', () => {
  const { stateDir, versionFile } = tmpState();
  writeVersion(versionFile, 1);
  run(stateDir);
  assert.equal(readVersion(versionFile), 2);
});

test('the v1-to-v2 migration is directly idempotent', () => {
  const { stateDir } = tmpState();
  // No file, then a file — both must leave no server.pid and not throw.
  v1ToV2(stateDir);
  const pid = path.join(stateDir, 'server.pid');
  fs.writeFileSync(pid, 'x');
  v1ToV2(stateDir);
  assert.ok(!fs.existsSync(pid));
  v1ToV2(stateDir); // already gone
});

test('fresh-dir skip: a non-existent stateDir is left untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-mig-'));
  const stateDir = path.join(root, '.web-chat'); // never created
  run(stateDir);
  assert.ok(!fs.existsSync(stateDir), 'runner does not create a missing stateDir');
});

test('forward-version: state newer than this build is used as-is, not downgraded', () => {
  const { stateDir, versionFile } = tmpState();
  writeVersion(versionFile, SCHEMA_VERSION + 5);
  run(stateDir);
  assert.equal(readVersion(versionFile), SCHEMA_VERSION + 5, 'newer state left as-is');
});

test('missing-migration: stops at the gap without bumping past it', () => {
  // Inject a gapped map (test seam): target 3, but only v1→v2 registered. From v1
  // it applies v1→v2, then finds no v2→v3 and stops at 2.
  const { stateDir, versionFile } = tmpState();
  writeVersion(versionFile, 1);
  let ranV1 = false;
  const steps = { 1: (dir) => { ranV1 = true; } };
  run(stateDir, { steps, target: 3 });
  assert.equal(ranV1, true, 'the registered step ran');
  assert.equal(readVersion(versionFile), 2, 'stopped at the missing v2→v3 gap');
});

// ── unreadable _version.json ───────────────────────────────────────────────
// readVersion used to return the literal 0 for a MISSING file and for a torn one
// alike, and run() reads 0 as "fresh project" — so a v1 project whose version
// file was lost to a crash got stamped at the current schema with every pending
// migration silently skipped. Nothing covered it; these are that coverage.

// The runner writes to stderr for the corrupt case. Swallow it so the suite's
// output stays readable, and return what was written so the warning itself can
// be asserted.
function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => { out += chunk; return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return out;
}

test('corrupt _version.json: warns, treats the project as v1, and RUNS the pending migration', () => {
  const { stateDir, versionFile } = tmpState();
  fs.writeFileSync(versionFile, '{"version": 1');   // torn mid-write
  const pid = path.join(stateDir, 'server.pid');
  fs.writeFileSync(pid, '999');

  const warned = captureStderr(() => run(stateDir));
  assert.match(warned, /unreadable/, 'the operator is told, not silently stamped');
  assert.ok(!fs.existsSync(pid), 'v1→v2 actually ran instead of being skipped');
  assert.equal(readVersion(versionFile), 2, 'and the stamp is repaired on the way through');
});

test('a `{}` _version.json is unusable, not version-undefined falling out of both branches', () => {
  const { stateDir, versionFile } = tmpState();
  fs.writeFileSync(versionFile, '{}');
  const pid = path.join(stateDir, 'server.pid');
  fs.writeFileSync(pid, '1');

  captureStderr(() => run(stateDir));
  assert.ok(!fs.existsSync(pid));
  assert.equal(readVersion(versionFile), 2, 'the stamp is no longer left unwritten');
});

test('a non-integer version is unusable too, and does not migrate from NaN', () => {
  const { stateDir, versionFile } = tmpState();
  fs.writeFileSync(versionFile, JSON.stringify({ version: 'two' }));
  captureStderr(() => run(stateDir));
  assert.equal(readVersion(versionFile), 2);
});

test('an ABSENT _version.json still first-touches — absent is not conflated with corrupt', () => {
  const { stateDir, versionFile } = tmpState();
  const pid = path.join(stateDir, 'server.pid');
  fs.writeFileSync(pid, '12345');
  const warned = captureStderr(() => run(stateDir));
  assert.equal(warned, '', 'a fresh project warns about nothing');
  assert.equal(readVersion(versionFile), SCHEMA_VERSION);
  assert.ok(fs.existsSync(pid), 'and runs no migrations');
});

test('_version.json is written atomically and keeps its trailing newline', () => {
  const { stateDir, versionFile } = tmpState();
  run(stateDir);
  assert.equal(fs.readFileSync(versionFile, 'utf8'), `{\n  "version": ${SCHEMA_VERSION}\n}\n`);
  assert.deepEqual(fs.readdirSync(stateDir), ['_version.json'], 'no temp file left behind');
});
