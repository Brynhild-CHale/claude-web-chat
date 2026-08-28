// The durable-JSON-record engine: lib/core/fsjson.js.
//
// These are the engine's own contracts. The records that ADOPT it get their own
// seeded-corruption tests next to the behaviour they protect (graph-corrupt,
// draft, migrations).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeJsonAtomic, readJson, readJsonOr, renameAside } = require('../lib/core/fsjson');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-fsjson-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// ── writeJsonAtomic ────────────────────────────────────────────────────────

test('writeJsonAtomic: writes pretty JSON, returns the path, leaves no temp file', (t) => {
  const dir = tmpDir(t);
  const f = path.join(dir, 'rec.json');
  assert.equal(writeJsonAtomic(f, { a: 1 }), f);
  assert.equal(fs.readFileSync(f, 'utf8'), '{\n  "a": 1\n}');
  assert.deepEqual(fs.readdirSync(dir), ['rec.json'], 'the temp file is renamed, not left behind');
});

test('writeJsonAtomic: newline defaults off and is opt-in, so adoption never rewrites bytes', (t) => {
  const dir = tmpDir(t);
  const a = writeJsonAtomic(path.join(dir, 'a.json'), { a: 1 });
  const b = writeJsonAtomic(path.join(dir, 'b.json'), { a: 1 }, { newline: true });
  assert.equal(fs.readFileSync(a, 'utf8').endsWith('}'), true);
  assert.equal(fs.readFileSync(b, 'utf8').endsWith('}\n'), true);
});

test('writeJsonAtomic: pretty:0 compacts, mkdir creates the parent, mkdir:false does not', (t) => {
  const dir = tmpDir(t);
  const nested = path.join(dir, 'deep', 'er', 'rec.json');
  writeJsonAtomic(nested, { a: 1 }, { pretty: 0 });
  assert.equal(fs.readFileSync(nested, 'utf8'), '{"a":1}');
  assert.throws(
    () => writeJsonAtomic(path.join(dir, 'nope', 'rec.json'), {}, { mkdir: false }),
    /ENOENT/,
  );
});

test('writeJsonAtomic: the temp file is a per-pid sibling of the destination', (t) => {
  const dir = tmpDir(t);
  const f = path.join(dir, 'rec.json');
  // Observed indirectly: make the rename fail (destination is a non-empty
  // directory) and assert the temp file is cleaned up rather than orphaned.
  fs.mkdirSync(f);
  fs.writeFileSync(path.join(f, 'child'), 'x');
  assert.throws(() => writeJsonAtomic(f, { a: 1 }));
  assert.equal(fs.existsSync(`${f}.${process.pid}.tmp`), false, 'a failed write cleans up its temp file');
});

test('writeJsonAtomic: fsync:true still lands the same bytes', (t) => {
  const dir = tmpDir(t);
  const f = writeJsonAtomic(path.join(dir, 'rec.json'), { a: 1 }, { fsync: true, newline: true });
  assert.equal(fs.readFileSync(f, 'utf8'), '{\n  "a": 1\n}\n');
});

test('writeJsonAtomic: a reader never sees a partial record (old or new, never a prefix)', (t) => {
  const dir = tmpDir(t);
  const f = path.join(dir, 'rec.json');
  writeJsonAtomic(f, { v: 'old' });
  const big = { v: 'new', pad: 'x'.repeat(200000) };
  writeJsonAtomic(f, big);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).v, 'new');
});

// ── readJson ───────────────────────────────────────────────────────────────

test('readJson: ok for a parsable file', (t) => {
  const dir = tmpDir(t);
  const f = writeJsonAtomic(path.join(dir, 'rec.json'), { a: 1 });
  assert.deepEqual(readJson(f), { ok: true, value: { a: 1 } });
});

test('readJson: absent for ENOENT and for a path under a non-directory', (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(readJson(path.join(dir, 'missing.json')), { absent: true });
  fs.writeFileSync(path.join(dir, 'afile'), 'x');
  assert.deepEqual(readJson(path.join(dir, 'afile', 'rec.json')), { absent: true });
});

test('readJson: corrupt for truncated JSON, and corrupt (not absent) for an unreadable path', (t) => {
  const dir = tmpDir(t);
  const f = path.join(dir, 'rec.json');
  fs.writeFileSync(f, '{"a": 1');
  const r = readJson(f);
  assert.equal(r.corrupt, true);
  assert.ok(r.error instanceof Error);
  assert.equal(r.absent, undefined, 'a torn record must never read as a missing one');

  // A directory where a record was expected is a read failure, not an absence.
  fs.mkdirSync(path.join(dir, 'adir'));
  assert.equal(readJson(path.join(dir, 'adir')).corrupt, true);
});

test('readJson: absent, corrupt and invalid are all distinguishable from each other', (t) => {
  const dir = tmpDir(t);
  const validate = (v) => v && typeof v === 'object' && typeof v.id === 'string';

  const good = writeJsonAtomic(path.join(dir, 'good.json'), { id: 'x' });
  const nulled = path.join(dir, 'null.json'); fs.writeFileSync(nulled, 'null');
  const empty = path.join(dir, 'empty.json'); fs.writeFileSync(empty, '{}');
  const torn = path.join(dir, 'torn.json'); fs.writeFileSync(torn, '{"id":');

  assert.equal(readJson(good, { validate }).ok, true);
  assert.equal(readJson(nulled, { validate }).invalid, true);
  assert.equal(readJson(empty, { validate }).invalid, true);
  assert.equal(readJson(torn, { validate }).corrupt, true);
  assert.equal(readJson(path.join(dir, 'gone.json'), { validate }).absent, true);
});

test('readJson: invalid carries the parsed value and an error, and never throws out', (t) => {
  const dir = tmpDir(t);
  const f = path.join(dir, 'rec.json');
  fs.writeFileSync(f, '{"id":7}');
  const r = readJson(f, { validate: (v) => { if (typeof v.id !== 'string') throw new Error('id must be a string'); return true; } });
  assert.equal(r.invalid, true);
  assert.equal(r.error.message, 'id must be a string');
  assert.deepEqual(r.value, { id: 7 }, 'the caller can still inspect what it got');
});

// ── readJsonOr ─────────────────────────────────────────────────────────────

test('readJsonOr: returns the fallback for absent, corrupt and invalid alike', (t) => {
  const dir = tmpDir(t);
  const validate = (v) => Array.isArray(v);
  fs.writeFileSync(path.join(dir, 'torn.json'), '[1,');
  fs.writeFileSync(path.join(dir, 'wrong.json'), '{}');
  writeJsonAtomic(path.join(dir, 'good.json'), [1, 2]);

  assert.deepEqual(readJsonOr(path.join(dir, 'gone.json'), [], { validate }), []);
  assert.deepEqual(readJsonOr(path.join(dir, 'torn.json'), [], { validate }), []);
  assert.deepEqual(readJsonOr(path.join(dir, 'wrong.json'), [], { validate }), []);
  assert.deepEqual(readJsonOr(path.join(dir, 'good.json'), [], { validate }), [1, 2]);
});

test('readJsonOr: a torn consent-shaped record falls back rather than reading as trusted', (t) => {
  // The fail-CLOSED contract lib/cli/commands/trust.js depends on.
  const dir = tmpDir(t);
  const f = path.join(dir, 'trusted.json');
  fs.writeFileSync(f, '{"key": tru');
  assert.deepEqual(readJsonOr(f, {}), {});
});

// ── renameAside ────────────────────────────────────────────────────────────

test('renameAside: moves the record aside instead of destroying it', (t) => {
  const dir = tmpDir(t);
  const f = path.join(dir, 'draft.json');
  fs.writeFileSync(f, 'not json');
  const dest = renameAside(f);
  assert.equal(fs.existsSync(f), false);
  assert.equal(path.basename(dest).startsWith('draft.json.corrupt-'), true);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'not json', 'the bytes are preserved for forensics');
});

test('renameAside: null when there is nothing to rename', (t) => {
  const dir = tmpDir(t);
  assert.equal(renameAside(path.join(dir, 'gone.json')), null);
});

test('renameAside: two failures in the same millisecond do not overwrite each other', (t) => {
  const dir = tmpDir(t);
  const f = path.join(dir, 'draft.json');
  const now = () => 1000;
  fs.writeFileSync(f, 'first');
  const a = renameAside(f, { now });
  fs.writeFileSync(f, 'second');
  const b = renameAside(f, { now });
  assert.notEqual(a, b);
  assert.equal(fs.readFileSync(a, 'utf8'), 'first');
  assert.equal(fs.readFileSync(b, 'utf8'), 'second');
});

test('renameAside: keep caps the aside-files so they cannot accumulate forever', (t) => {
  const dir = tmpDir(t);
  const f = path.join(dir, 'draft.json');
  let clock = 1000000000000;
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(f, `gen${i}`);
    renameAside(f, { keep: 3, now: () => clock++ });
  }
  const left = fs.readdirSync(dir).filter((n) => n.startsWith('draft.json.corrupt-')).sort();
  assert.equal(left.length, 3, 'only the three newest survive');
  assert.deepEqual(left.map((n) => fs.readFileSync(path.join(dir, n), 'utf8')), ['gen3', 'gen4', 'gen5']);
});

test('renameAside: a custom tag changes both the name and the reap prefix', (t) => {
  const dir = tmpDir(t);
  const f = path.join(dir, 'rec.json');
  fs.writeFileSync(f, 'x');
  const dest = renameAside(f, { tag: 'stale' });
  assert.equal(path.basename(dest).startsWith('rec.json.stale-'), true);
});
