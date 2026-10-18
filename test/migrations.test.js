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

test('SCHEMA_VERSION is 4 (v3→v4 moved comment pins into the element log)', () => {
  assert.equal(SCHEMA_VERSION, 4);
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

test('v1 → v2: removes the orphaned server.pid, and the run stamps the current schema', () => {
  const { stateDir, versionFile } = tmpState();
  writeVersion(versionFile, 1);
  const pid = path.join(stateDir, 'server.pid');
  fs.writeFileSync(pid, '999');
  run(stateDir);
  assert.equal(readVersion(versionFile), SCHEMA_VERSION);
  assert.ok(!fs.existsSync(pid), 'orphaned server.pid removed');
});

test('idempotent: re-running an already-migrated dir is a no-op and never throws', () => {
  const { stateDir, versionFile } = tmpState();
  writeVersion(versionFile, 1);
  fs.writeFileSync(path.join(stateDir, 'server.pid'), '1');
  run(stateDir);
  assert.equal(readVersion(versionFile), SCHEMA_VERSION);
  run(stateDir); // second pass: nothing to do
  assert.equal(readVersion(versionFile), SCHEMA_VERSION);
});

test('v1 → v2 with no server.pid present still migrates through (unlink of a missing file is a no-op)', () => {
  const { stateDir, versionFile } = tmpState();
  writeVersion(versionFile, 1);
  run(stateDir);
  assert.equal(readVersion(versionFile), SCHEMA_VERSION);
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
  assert.equal(readVersion(versionFile), SCHEMA_VERSION, 'and the stamp is repaired on the way through');
});

test('a `{}` _version.json is unusable, not version-undefined falling out of both branches', () => {
  const { stateDir, versionFile } = tmpState();
  fs.writeFileSync(versionFile, '{}');
  const pid = path.join(stateDir, 'server.pid');
  fs.writeFileSync(pid, '1');

  captureStderr(() => run(stateDir));
  assert.ok(!fs.existsSync(pid));
  assert.equal(readVersion(versionFile), SCHEMA_VERSION, 'the stamp is no longer left unwritten');
});

test('a non-integer version is unusable too, and does not migrate from NaN', () => {
  const { stateDir, versionFile } = tmpState();
  fs.writeFileSync(versionFile, JSON.stringify({ version: 'two' }));
  captureStderr(() => run(stateDir));
  assert.equal(readVersion(versionFile), SCHEMA_VERSION);
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
  // A first touch also seeds the new-project look (theme-default.json).
  assert.deepEqual(fs.readdirSync(stateDir).sort(), ['_version.json', 'theme-default.json'], 'no temp file left behind');
});

// ── the runner's contexts, refusals and return values (v3→v4, U204) ──────────

test('a daemon-only step is deferred outside the daemon: nothing stamped, one line, {deferred}', () => {
  const { stateDir, versionFile } = tmpState();
  writeVersion(versionFile, 1);
  let ran = [];
  const only = Object.assign((d) => { ran.push(2); }, { daemonOnly: true, what: 'test step' });
  const steps = { 1: () => { ran.push(1); }, 2: only };
  const warned = captureStderr(() => {
    const out = run(stateDir, { steps, target: 3, context: 'install' });
    assert.deepEqual(out, { deferred: 2 });
  });
  assert.deepEqual(ran, [1], 'the step before it ran; the daemon-only one did not');
  assert.equal(readVersion(versionFile), 2, 'stamped up to the deferred step, not past it');
  assert.match(warned, /v2→v3 test step runs in the daemon at its next boot/);
  ran = [];
  captureStderr(() => assert.deepEqual(run(stateDir, { steps, target: 3 }), { ok: true, version: 3 }));
  assert.deepEqual(ran, [2], 'the default context is the daemon\'s: it runs');
});

test('a refused step stops the run, leaves the version, and names the report', () => {
  const { stateDir, versionFile } = tmpState();
  writeVersion(versionFile, 2);
  const steps = { 2: () => ({ refused: true, report_file: '/x/migration-report.json' }) };
  const warned = captureStderr(() => {
    assert.deepEqual(run(stateDir, { steps, target: 3 }), { refused: { from: 2, report: '/x/migration-report.json' } });
  });
  assert.equal(readVersion(versionFile), 2);
  assert.match(warned, /refused \(see \/x\/migration-report\.json\)/);
  assert.match(warned, /claude-web-chat migrate/);
});

test('run() answers what it did: current, first touch, newer, gap', () => {
  const a = tmpState();
  captureStderr(() => assert.deepEqual(run(a.stateDir), { ok: true, version: SCHEMA_VERSION }));
  captureStderr(() => assert.deepEqual(run(a.stateDir), { ok: true, version: SCHEMA_VERSION }));
  writeVersion(a.versionFile, SCHEMA_VERSION + 1);
  captureStderr(() => assert.deepEqual(run(a.stateDir), { ok: true, version: SCHEMA_VERSION + 1 }));
  const b = tmpState();
  writeVersion(b.versionFile, 1);
  captureStderr(() => assert.deepEqual(run(b.stateDir, { steps: {}, target: 3 }), { gap: 1 }));
});

test('the real v3→v4 step is registered, daemon-only, and migrates an empty v3 project to 4 writing nothing', () => {
  const { stateDir, versionFile } = tmpState();
  writeVersion(versionFile, 3);
  assert.equal(require('../lib/update/migrations/v3-to-v4').daemonOnly, true);
  captureStderr(() => assert.deepEqual(run(stateDir, { context: 'install' }), { deferred: 3 }));
  assert.equal(readVersion(versionFile), 3);
  captureStderr(() => assert.deepEqual(run(stateDir), { ok: true, version: 4 }));
  assert.equal(readVersion(versionFile), 4);
  assert.deepEqual(fs.readdirSync(stateDir), ['_version.json']);
});
