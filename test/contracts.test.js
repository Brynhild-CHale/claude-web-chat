// The contracts copy (contract 12 C-12.21, C-12.24; PLAN-T6 6A.8).
//
// test-support/contracts/ is the web-chat-contracts folder at the tag
// MANIFEST.json names: LOCK.md, schemas/, examples/ and the locked amendment
// folders. This file holds the copy to the lock — every file's sha256 against a
// LOCK.md row (contract 08's v2 drafts, counted in LOCK.md's validation lines but
// never sha-locked, against MANIFEST.json) — and reproduces LOCK.md's own
// validation lines with the same ajv the lock was validated with. Every expected
// number is read out of the copied LOCK.md, never written here: a later lock is
// a re-copy (and a new MANIFEST.json), and this file then checks it unchanged.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CONTRACTS_DIR, createValidator, checkCopy, lockValidation, lockOrder, loadContracts,
} = require('../test-support/contracts-loader');

const REPO_ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, 'MANIFEST.json'), 'utf8'));

// Every example of a view through validateExample: { ok, fail, failed: [names] }.
function runExamples(validator) {
  let ok = 0;
  const failed = [];
  for (const name of validator.view.examples.keys()) {
    if (validator.validateExample(name).ok) ok += 1; else failed.push(name);
  }
  return { ok, fail: failed.length, failed, schemas: validator.view.schemas.size };
}

test('every copied file is the lock\'s: a LOCK.md row, or a MANIFEST.json unlocked_present entry', () => {
  const r = checkCopy();
  assert.deepStrictEqual(r.failures, [], 'the copy differs from the lock');
  assert.ok(r.checked > 0);
  // The files outside LOCK.md's rows are contract 08's v2 drafts only.
  for (const e of manifest.unlocked_present) {
    assert.match(e.path, /^(schemas|examples)\/08-[^/]+\.json$/, `${e.path} is not a contract-08 draft`);
    assert.match(e.why, /contract 08 v2 draft/);
  }
  assert.match(manifest.commit, /^[0-9a-f]{40}$/);
  assert.ok(manifest.tag, 'MANIFEST.json names the contracts tag');
});

test('a copy with one byte changed in a schema and in an example fails the same check, naming both', (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-contracts-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.cpSync(CONTRACTS_DIR, tmp, { recursive: true });
  assert.deepStrictEqual(checkCopy(tmp).failures, [], 'the untouched temp copy passes');

  const flip = (rel) => {
    const file = path.join(tmp, rel);
    fs.chmodSync(file, 0o644);
    const buf = fs.readFileSync(file);
    buf[buf.length - 2] ^= 1;
    fs.writeFileSync(file, buf);
  };
  flip('schemas/05-heartbeat.json');
  flip('examples/05-heartbeat.json');
  const r = checkCopy(tmp);
  assert.equal(r.ok, false);
  assert.deepStrictEqual(r.failures.map((f) => f.path).sort(), ['examples/05-heartbeat.json', 'schemas/05-heartbeat.json']);

  // A file with no row and no manifest entry fails naming its path; so does a
  // LOCK.md that is not the one MANIFEST.json names.
  fs.writeFileSync(path.join(tmp, 'examples', '99-stray.json'), '{}\n');
  fs.appendFileSync(path.join(tmp, 'LOCK.md'), '\n');
  const paths = checkCopy(tmp).failures.map((f) => f.path);
  assert.ok(paths.includes('examples/99-stray.json'), paths.join(', '));
  assert.ok(paths.includes('LOCK.md'), paths.join(', '));
});

test('the amendment folders are exactly the ones LOCK.md\'s validation lines name, and nothing of round v1.5', () => {
  const present = fs.readdirSync(path.join(CONTRACTS_DIR, 'amendments')).sort();
  const named = [...lockOrder()].sort();
  assert.deepStrictEqual(present, named);
  assert.equal(named.length, new Set(lockValidation().amendments.map((a) => a.id)).size);
  // Round v1.5's folders (proposed, unlocked at the copy) never come in.
  for (const v15 of ['03-7', '03-8', '10-4', '10-5', '10-6', '11-3']) {
    assert.ok(!present.includes(v15), `amendment folder ${v15} is round v1.5's — not locked, not copied`);
  }
});

test('the base reproduces LOCK.md\'s `node tools/validate.js` line', () => {
  const { base } = lockValidation();
  assert.ok(base.length > 0, 'LOCK.md carries a base validation line');
  const got = runExamples(createValidator({ folders: [] }));
  assert.deepStrictEqual(got.failed, []);
  for (const line of base) {
    assert.deepStrictEqual({ ok: got.ok, fail: got.fail, schemas: got.schemas }, line);
  }
});

test('each locked folder overlaid alone on the base reproduces its own `amendment <id>:` line', () => {
  const { amendments } = lockValidation();
  assert.ok(amendments.length > 0);
  for (const line of amendments) {
    const got = runExamples(createValidator({ folders: [line.id] }));
    assert.deepStrictEqual(got.failed, [], `amendment ${line.id}`);
    assert.deepStrictEqual(
      { id: line.id, ok: got.ok, fail: got.fail, schemas: got.schemas },
      line,
      `amendment ${line.id} does not reproduce LOCK.md's line`,
    );
  }
});

test('the combined overlay, every locked folder in lock order, validates every example', () => {
  const names = new Set();
  const add = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) names.add(f);
  };
  add(path.join(CONTRACTS_DIR, 'examples'));
  for (const id of lockOrder()) add(path.join(CONTRACTS_DIR, 'amendments', id, 'examples'));

  const all = createValidator();
  assert.deepStrictEqual(all.view.folders, lockOrder());
  const got = runExamples(all);
  assert.deepStrictEqual(got.failed, []);
  assert.equal(got.ok, names.size);

  // Where two folders replace one path, the later lock's file wins.
  const fileOf = (name) => all.view.schemas.get(name).file;
  assert.equal(fileOf('03-activity-entry'), 'amendments/03-5/schemas/03-activity-entry.json');
  assert.equal(fileOf('03-credential'), 'amendments/03-2/schemas/03-credential.json');
  assert.equal(fileOf('10-hub-request'), 'amendments/10-3/schemas/10-hub-request.json');
  assert.equal(fileOf('11-retention-table'), 'amendments/11-2/schemas/11-retention-table.json');
  // The order a caller names folders in does not change that.
  const reversed = loadContracts({ folders: [...lockOrder()].reverse() });
  assert.equal(reversed.schemas.get('03-activity-entry').file, 'amendments/03-5/schemas/03-activity-entry.json');
  assert.throws(() => loadContracts({ folders: ['99-1'] }), /99-1/);
});

test('validateFrame maps every (ch, kind) of the 05 schemas to exactly one def', () => {
  const v = createValidator();
  const seen = new Map();
  for (const [name, s] of v.view.schemas) {
    if (!name.startsWith('05-')) continue;
    for (const [key, def] of Object.entries(s.data.$defs || {})) {
      const p = (def && def.properties) || {};
      if (!p.ch || !p.kind || p.ch.const === undefined || p.kind.const === undefined) continue;
      const pair = `${p.ch.const} ${p.kind.const}`;
      seen.set(pair, [...(seen.get(pair) || []), `${name}#${key}`]);
    }
  }
  assert.ok(seen.size > 0);
  for (const [pair, defs] of seen) {
    assert.equal(defs.length, 1, `${pair} maps to ${defs.join(', ')}`);
    const [ch, kind] = pair.split(' ');
    const e = v.frameIndex.get(`${ch}\u0000${kind}`);
    assert.equal(`${e.schema}#${e.def}`, defs[0]);
  }
  assert.equal(v.frameIndex.size, seen.size);
  for (const e of v.frameIndex.values()) assert.ok(!e.schema.startsWith('08-'), 'contract 08 is never a frame');

  // Every locked 05 example that is a frame passes as one.
  for (const [name, ex] of v.view.examples) {
    if (!name.startsWith('05-') || !ex.data || !ex.data.ch || !ex.data.kind) continue;
    const r = v.validateFrame(ex.data);
    assert.ok(r.ok, `${name}: ${JSON.stringify(r.errors)}`);
  }
});

test('a locked example frame passes, and the same frame with an extra top-level key fails', () => {
  const v = createValidator();
  const beat = JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, 'examples', '05-heartbeat.json'), 'utf8'));
  const ok = v.validateFrame(beat);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(`${ok.schema}#${ok.def}`, '05-heartbeat#heartbeat');
  assert.equal(v.validateFrame({ ...beat, extra: 1 }).ok, false);
  assert.equal(v.validateFrame({ ...beat, kind: 'no.such.kind' }).ok, false);
  assert.equal(v.validateFrame(null).ok, false);
});

test('validatePairing takes 05-pairing.json\'s HTTP bodies by their def', () => {
  const v = createValidator();
  const read = (n) => JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, 'examples', n), 'utf8'));
  assert.equal(v.validatePairing('start_request', read('05-pairing.json')).ok, true);
  assert.equal(v.validatePairing('start_response', read('05-pairing.start-response.json')).ok, true);
  assert.equal(v.validatePairing('poll_request', read('05-pairing.poll.json')).ok, true);
  assert.equal(v.validatePairing('start_request', read('05-pairing.poll.json')).ok, false);
  assert.equal(v.validatePairing('no_such_def', {}).ok, false);
});

test('the validator is ajv 8.20.0 with ajv-formats 3.0.1, both exact devDependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const ajv = require('ajv/package.json').version;
  const formats = require('ajv-formats/package.json').version;
  assert.equal(ajv, '8.20.0');
  assert.equal(formats, '3.0.1');
  assert.equal(pkg.devDependencies.ajv, ajv);
  assert.equal(pkg.devDependencies['ajv-formats'], formats);
  assert.ok(!Object.hasOwn(pkg.dependencies || {}, 'ajv'), 'ajv is never a runtime dependency of the package');
  assert.ok(!Object.hasOwn(pkg.dependencies || {}, 'ajv-formats'));
});
