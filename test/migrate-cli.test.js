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
const { run } = require('../lib/update/migrations');

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
