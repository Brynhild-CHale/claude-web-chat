// `claude-web-chat migrate` — the v3→v4 comment migration's dry run
// (lib/cli/commands/migrate.js). It prints the report, writes nothing, exits 2
// when the daemon would refuse, and says so when the project is already
// migrated. Spawned as the real CLI, so the exit codes are the real ones.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { v3Graph } = require('../test-support/v3-graph');
const { run, SCHEMA_VERSION } = require('../lib/update/migrations');
const { projectPaths } = require('../lib/core/paths');

const BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat.js');

function fixture(t, opts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-migrate-cli-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  return v3Graph(root, opts);
}

function cli(cwd, args = []) {
  const r = spawnSync(process.execPath, [BIN, 'migrate', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 30000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// Every entry under a directory: its path, its kind, its size and its bytes' hash.
function listing(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.lstatSync(full);
      const rel = path.relative(dir, full);
      if (st.isDirectory()) { out.push(`${rel}/`); walk(full); } else {
        out.push(`${rel} ${st.size} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
      }
    }
  };
  walk(dir);
  return out;
}

test('migrate prints the report and leaves the project byte-identical', (t) => {
  const g = fixture(t);
  const before = listing(g.root);
  const r = cli(g.root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /dry run/);
  assert.match(r.out, /copies\s+23 on nodes, 5 in the draft/);
  assert.match(r.out, /versions\s+\d+ to mint/);
  assert.match(r.out, /unmapped\s+none/);
  assert.match(r.out, /park \(b2\)/);
  assert.match(r.out, /draft\s+5 copies on n6/);
  assert.match(r.out, /would append \d+ records, \d+ bytes/);
  assert.match(r.out, /derive\s+[\d.]+ ms/);
  assert.match(r.out, /c9: id-reminted-suspect/);
  assert.deepEqual(listing(g.root), before, 'nothing written: no log, no report, no directory');
});

test('migrate --json prints the report as JSON', (t) => {
  const g = fixture(t);
  const r = cli(g.root, ['--json']);
  assert.equal(r.code, 0, r.err);
  const body = JSON.parse(r.out);
  assert.equal(body.state, 'would-migrate');
  assert.equal(body.version, 3);
  assert.equal(body.report.refused, false);
  assert.equal(body.report.copies, 23);
  assert.ok(body.report.would_append.bytes > 0);
  assert.equal(typeof body.report.derive_ms, 'number');
});

test('migrate exits 2 when the migration would refuse, and names each copy', (t) => {
  const g = fixture(t, { unmappable: 'no-id' });
  const before = listing(g.root);
  const r = cli(g.root);
  assert.equal(r.code, 2);
  assert.match(r.out, /UNMAPPED\s+1 copies/);
  assert.match(r.out, /n2 \(no id\): no-id/);
  assert.deepEqual(listing(g.root), before, 'a refusing dry run writes no report either');
  const j = cli(g.root, ['--json']);
  assert.equal(j.code, 2);
  assert.equal(JSON.parse(j.out).state, 'would-refuse');
});

test('migrate on an already-migrated project says so and exits 0', (t) => {
  const g = fixture(t);
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  try { assert.deepEqual(run(g.stateDir), { ok: true, version: 4 }); } finally { process.stderr.write = orig; }
  const before = listing(g.root);
  const r = cli(g.root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Already migrated/);
  assert.deepEqual(listing(g.root), before);
  assert.equal(JSON.parse(cli(g.root, ['--json']).out).state, 'current');
});

test('migrate outside a project refuses like every project command', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-migrate-none-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const r = cli(dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /no \.web-chat\//);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('migrate refuses an unknown argument', (t) => {
  const g = fixture(t);
  const r = cli(g.root, ['--apply']);
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown argument --apply/);
});

// A .web-chat/ that holds a graph but no _version.json (a lost version file, a
// hand-copied state directory): the daemon reads it as v3 and migrates it
// (lib/update/migrations run(), graphPresent), so the dry run answers what that
// migration will do — never 'fresh'. Only a project with no graph is fresh.

test('migrate --json reads a graph with no _version.json as v3 and dry-runs it', (t) => {
  const g = fixture(t, { version: null });
  assert.equal(fs.existsSync(g.paths.version), false);
  const before = listing(g.root);
  const r = cli(g.root, ['--json']);
  assert.equal(r.code, 0, r.err);
  const body = JSON.parse(r.out);
  assert.equal(body.state, 'would-migrate');
  assert.equal(body.version, 0, 'the recorded version: none');
  assert.equal(body.assumed, 3, 'the version the daemon reads it as');
  assert.equal(body.report.copies, 23);
  assert.equal(body.report.draft.copies, 5);
  assert.deepEqual(listing(g.root), before, 'nothing written: no version file, no log, no report');
});

test('migrate in text says the daemon reads a graph with no _version.json as v3, then the report', (t) => {
  const g = fixture(t, { version: null });
  const before = listing(g.root);
  const r = cli(g.root);
  assert.equal(r.code, 0, r.err);
  const out = r.out.split('\n');
  assert.equal(out[0], 'This project has no _version.json but holds a graph: the daemon reads it as v3 and migrates it at its next boot.');
  assert.match(out[1], /dry run/);
  assert.match(r.out, /would append \d+ records, \d+ bytes/);
  assert.doesNotMatch(r.out, /nothing to migrate/);
  assert.deepEqual(listing(g.root), before);
});

test('migrate exits 2 for a graph with no _version.json that would refuse', (t) => {
  const g = fixture(t, { unmappable: 'no-id', version: null });
  const before = listing(g.root);
  const r = cli(g.root, ['--json']);
  assert.equal(r.code, 2);
  const body = JSON.parse(r.out);
  assert.equal(body.state, 'would-refuse');
  assert.equal(body.version, 0);
  assert.equal(body.assumed, 3);
  const text = cli(g.root);
  assert.equal(text.code, 2);
  assert.match(text.out, /^This project has no _version.json but holds a graph/);
  assert.match(text.out, /UNMAPPED\s+1 copies/);
  assert.deepEqual(listing(g.root), before, 'a refusing dry run writes nothing');
});

test('migrate answers empty, assumed v3, for a graph with no pins and no _version.json', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-migrate-cli-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const paths = projectPaths(root);
  fs.mkdirSync(paths.graphDir, { recursive: true });
  for (const [id, parent] of [['n1', null], ['n2', 'n1']]) {
    fs.writeFileSync(path.join(paths.graphDir, `${id}.json`), JSON.stringify({
      id, parent_id: parent, created_at: 1760000000000, mounts: [], store: {}, comments: [],
    }));
  }
  fs.writeFileSync(paths.meta, JSON.stringify({ active: 'n2', lock: null }));
  const before = listing(root);
  const r = cli(root, ['--json']);
  assert.equal(r.code, 0, r.err);
  const body = JSON.parse(r.out);
  assert.equal(body.state, 'empty');
  assert.equal(body.version, 0);
  assert.equal(body.assumed, 3);
  const text = cli(root);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /^This project has no _version.json but holds a graph: the daemon reads it as v3/);
  assert.match(text.out, /No comment pins in this project/);
  assert.deepEqual(listing(root), before);
});

for (const [label, seed] of [
  ['an empty graph/ (as ensureProjectDirs leaves it)', (paths) => fs.mkdirSync(paths.graphDir, { recursive: true })],
  ['no graph/ at all', (paths) => fs.mkdirSync(paths.dir, { recursive: true })],
]) {
  test(`migrate answers fresh for a project with no _version.json and ${label}`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-migrate-cli-'));
    t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
    const paths = projectPaths(root);
    seed(paths);
    const before = listing(root);
    const r = cli(root, ['--json']);
    assert.equal(r.code, 0, r.err);
    const body = JSON.parse(r.out);
    assert.equal(body.state, 'fresh');
    assert.equal(body.version, 0);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'assumed'), false, 'no assumed key');
    const text = cli(root);
    assert.equal(text.code, 0, text.err);
    assert.equal(text.out, `This project has no _version.json yet: its first daemon boot stamps it at v${SCHEMA_VERSION} with nothing to migrate.\n`);
    assert.deepEqual(listing(root), before);
  });
}
