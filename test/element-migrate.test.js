// The v3→v4 comment migration: lib/core/element-migrate.js through the runner's
// v3-to-v4 step (PLAN.md 1A.4; DECISIONS C3 strict-b2, F3, F4, G4; GT-09; ruling
// A1's converted anchor). The fixture is test-support/v3-graph.js.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { v3Graph, ASIDE_SEQ } = require('../test-support/v3-graph');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { migrateComments, planMigration, readProject } = require('../lib/core/element-migrate');
const { createElementLog, convertAnchor, payloadOf, CONVERTED } = require('../lib/core/element-log');
const { createRedactor } = require('../lib/core/redact');
const { stableHash, stableStringify } = require('../lib/core/stable-json');
const { run } = require('../lib/update/migrations');
const v3ToV4 = require('../lib/update/migrations/v3-to-v4');

const CLOCK = () => 1760000100000;

function fixture(t, opts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-v3-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  return v3Graph(root, opts);
}

// The runner writes a line per step to stderr: keep the output readable and
// hand the text back for the tests that assert it.
function quiet(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => { out += chunk; return true; };
  try { return { value: fn(), stderr: out }; } finally { process.stderr.write = orig; }
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const size = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
const version = (g) => JSON.parse(fs.readFileSync(g.paths.version, 'utf8')).version;
const setVersion = (g, v) => fs.writeFileSync(g.paths.version, JSON.stringify({ version: v }) + '\n');

function openLog(t, g) {
  const log = createElementLog({ file: g.paths.elementsLog, redactor: createRedactor(), dryRun: true });
  t.after(() => log.close());
  log.load();
  return log;
}

// The declared normalisation: an absent `replies` equals [], a reply is
// {author, at, text}.
const norm = (c) => ({
  id: c.id, seq: c.seq, created_at: c.created_at, shared: c.shared, text: c.text ?? '', anchor: c.anchor ?? null,
  replies: (Array.isArray(c.replies) ? c.replies : []).map((r) => ({ author: r.author, at: r.at, text: r.text })),
});

// A node's comments rebuilt from its commit record's pins and the log alone:
// the payload, `original` as the anchor, the version's seq, the element's
// created_at.
function rebuild(log, nodeId) {
  return (log.pinsOf(nodeId) || []).map((iv) => {
    const at = iv.lastIndexOf('@');
    const id = iv.slice(0, at);
    const rec = log.version(id, Number(iv.slice(at + 1)));
    const p = rec.payload;
    return norm({ id, seq: rec.seq, created_at: log.element(id).created_at, shared: p.shared, text: p.text, anchor: rec.original, replies: p.replies });
  });
}

// Compare every node; a re-minted id's later copies are allowed one difference,
// their own created_at (the element keeps the first-visited copy's; reported as
// a suspect).
function diffNodes(log, nodes, suspects = new Set()) {
  let differ = 0;
  let missingReplies = 0;
  for (const n of nodes) {
    const want = (n.comments || []).map(norm);
    const got = rebuild(log, n.id);
    const fix = (list) => list.map((c) => (suspects.has(c.id) ? { ...c, created_at: null } : c));
    if (stableStringify(fix(got)) !== stableStringify(fix(want))) differ++;
    const have = new Set(got.flatMap((c) => c.replies.map((r) => `${c.id}|${stableStringify(r)}`)));
    for (const c of want) for (const r of c.replies) if (!have.has(`${c.id}|${stableStringify(r)}`)) missingReplies++;
  }
  return { differ, missingReplies };
}

const nonEpoch = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('{"t":"epoch"'));

// ── the dry run ─────────────────────────────────────────────────────────────

test('the dry run maps every copy, is deterministic, and predicts the real run\'s bytes exactly', (t) => {
  const g = fixture(t);
  const a = migrateComments(g.stateDir, { dryRun: true, bootId: 'boot-1', now: CLOCK });
  const b = migrateComments(g.stateDir, { dryRun: true, bootId: 'boot-1', now: CLOCK });
  assert.equal(a.dry_run, true);
  assert.deepEqual(a.report.unmapped, [], 'every copy mapped');
  assert.equal(a.report.copies, g.nodes.reduce((s, n) => s + n.comments.length, 0));
  const strip = (r) => stableStringify({ ...r, derive_ms: 0 });
  assert.equal(strip(a.report), strip(b.report), 'two dry runs give the same report');
  assert.equal(typeof a.report.derive_ms, 'number');
  assert.equal(fs.existsSync(g.paths.elementsDir), false, 'a dry run writes nothing, not even the directory');

  const r = migrateComments(g.stateDir, { bootId: 'boot-1', now: CLOCK });
  assert.equal(r.migrated, true);
  assert.equal(size(g.paths.elementsLog), a.report.would_append.bytes, 'would_append.bytes is what the real run appended');
  assert.equal(r.report.appended.bytes, a.report.would_append.bytes);
  assert.equal(r.report.appended.records, a.report.would_append.records);
});

test('the plan itself is pure and deterministic: two plans of one project are the same JSON', (t) => {
  const g = fixture(t);
  const project = readProject(g.stateDir);
  const plan = () => {
    const log = openLog(t, g);
    const p = planMigration({ nodes: project.nodes, meta: project.meta, draft: project.draft, log, asides: project.asides });
    return stableStringify({ ...p, detail: { pins: [...p.detail.pins], draft: p.detail.draft, states: [...p.detail.states] } });
  };
  assert.equal(plan(), plan());
});

// ── the real run, through the runner ────────────────────────────────────────

test('run(stateDir) migrates v3 to v4 losslessly, never touching a node file or the draft', (t) => {
  const g = fixture(t);
  const files = [...fs.readdirSync(g.paths.graphDir).map((f) => path.join(g.paths.graphDir, f)), g.paths.draft];
  const before = new Map(files.map((f) => [f, sha(f)]));
  const { value } = quiet(() => run(g.stateDir));
  assert.deepEqual(value, { ok: true, version: 4 });
  assert.equal(version(g), 4);
  for (const f of files) assert.equal(sha(f), before.get(f), `${path.basename(f)} is byte-identical`);
  assert.deepEqual(fs.readdirSync(g.paths.graphDir).sort(), files.slice(0, -1).map((f) => path.basename(f)).sort(), 'nothing added under graph/');

  const log = openLog(t, g);
  assert.ok(log.migration(), 'the migration record is written');
  assert.equal(log.migration().from, 3);
  assert.equal(log.migration().to, 4);
  const { differ, missingReplies } = diffNodes(log, g.nodes, new Set(['c9']));
  assert.equal(differ, 0, '0 nodes differ after the declared normalisation');
  assert.equal(missingReplies, 0, '0 replies missing');
  // Every node carrying pins has exactly one commit record, in graph order.
  assert.deepEqual(log.commits().map((c) => c.node), ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
});

test('idempotent: a second run (the version file reset to 3) appends 0 bytes', (t) => {
  const g = fixture(t);
  quiet(() => run(g.stateDir));
  const bytes = size(g.paths.elementsLog);
  setVersion(g, 3);
  const { value } = quiet(() => run(g.stateDir));
  assert.deepEqual(value, { ok: true, version: 4 });
  assert.equal(size(g.paths.elementsLog), bytes, '0 bytes appended');
  const again = migrateComments(g.stateDir);
  assert.equal(again.already, true);
  assert.equal(size(g.paths.elementsLog), bytes);
});

test('a crash mid-apply: the next run appends only the missing records and the migration record', (t) => {
  const g = fixture(t);
  const full = migrateComments(g.stateDir, { bootId: 'one', now: CLOCK });
  assert.equal(full.migrated, true);
  const records = nonEpoch(g.paths.elementsLog);
  const lines = fs.readFileSync(g.paths.elementsLog, 'utf8').split('\n').filter(Boolean);
  // The log as a crash leaves it: the first half of the records, no migration record.
  const keep = Math.floor(lines.length / 2);
  fs.writeFileSync(g.paths.elementsLog, lines.slice(0, keep).join('\n') + '\n');
  const kept = nonEpoch(g.paths.elementsLog);
  assert.ok(!kept.some((l) => l.includes('"t":"migration"')), 'no migration record survived');

  const again = migrateComments(g.stateDir, { bootId: 'two', now: CLOCK });
  assert.equal(again.migrated, true);
  const after = nonEpoch(g.paths.elementsLog);
  assert.deepEqual(after, records, 'exactly the missing records were appended, in order, then the migration record');
  assert.equal(again.report.appended.records, records.length - kept.length + 1, 'the missing records plus one epoch');

  const log = openLog(t, g);
  assert.equal(diffNodes(log, g.nodes, new Set(['c9'])).differ, 0, 'the rebuild still matches');
});

test('a crash with a torn tail: the tail is set aside and the rerun completes', (t) => {
  const g = fixture(t);
  migrateComments(g.stateDir, { bootId: 'one', now: CLOCK });
  const records = nonEpoch(g.paths.elementsLog);
  const buf = fs.readFileSync(g.paths.elementsLog);
  fs.writeFileSync(g.paths.elementsLog, buf.subarray(0, Math.floor(buf.length * 0.6)));
  const again = migrateComments(g.stateDir, { bootId: 'two', now: CLOCK });
  assert.equal(again.migrated, true);
  assert.deepEqual(nonEpoch(g.paths.elementsLog), records);
});

// ── strict ──────────────────────────────────────────────────────────────────

test('strict: a copy with no id refuses the migration — 0 bytes, v3 kept, the report names the copy', (t) => {
  const g = fixture(t, { unmappable: 'no-id' });
  const { value, stderr } = quiet(() => run(g.stateDir));
  assert.deepEqual(value, { refused: { from: 3, report: g.paths.migrationReport } });
  assert.match(stderr, /refused/);
  assert.match(stderr, /claude-web-chat migrate/);
  assert.equal(fs.existsSync(g.paths.elementsLog), false, 'the log file is absent (0 bytes appended)');
  assert.equal(version(g), 3, '_version.json stays at 3');
  const report = JSON.parse(fs.readFileSync(g.paths.migrationReport, 'utf8'));
  assert.equal(report.refused, true);
  assert.deepEqual(report.unmapped, [{ node: 'n2', id: null, reason: 'no-id' }]);
});

test('strict: each other unmapped reason refuses too, and is named', (t) => {
  for (const reason of ['duplicate-id-in-node', 'no-created_at', 'anchor-without-mount']) {
    const g = fixture(t, { unmappable: reason });
    const r = migrateComments(g.stateDir);
    assert.equal(r.refused, true, reason);
    assert.equal(r.report.unmapped.length, 1);
    assert.equal(r.report.unmapped[0].reason, reason);
    assert.equal(r.report.unmapped[0].node, 'n2');
    assert.equal(fs.existsSync(g.paths.elementsLog), false);
  }
});

// ── the fork (F4's reworded C-11) and C1 ────────────────────────────────────

test('the fork: conflicting siblings, the non-prefix edge and the C1-refused reuse are each mapped losslessly', (t) => {
  const g = fixture(t);
  const r = migrateComments(g.stateDir);
  const log = openLog(t, g);
  const vOf = (node, id) => Number(log.pinsOf(node).find((p) => p.startsWith(`${id}@`)).split('@')[1]);
  const { cases } = g;

  // Conflicting siblings: one parent version, two different children.
  const [a, b] = cases.conflict.nodes.map((n) => vOf(n, 'c1'));
  assert.notEqual(a, b);
  const forkV = vOf(cases.conflict.fork, 'c1');
  assert.equal(log.version('c1', a).parent_v, forkV);
  assert.equal(log.version('c1', b).parent_v, forkV);

  // The non-prefix edge: n4's replies do not extend n3's; it still chains to n3's version.
  const np = vOf(cases.nonPrefix.node, 'c1');
  assert.equal(log.version('c1', np).parent_v, vOf(cases.nonPrefix.parent, 'c1'));

  // The C1-refused reuse: n5's c5 mints its own version beside an equal-hash,
  // equal-parent_v twin homed on the other branch.
  const twin = vOf(cases.c1Refused.twin, 'c5');
  const mine = vOf(cases.c1Refused.node, 'c5');
  assert.notEqual(mine, twin);
  assert.equal(log.version('c5', mine).payload_hash, log.version('c5', twin).payload_hash);
  assert.equal(log.version('c5', mine).parent_v, log.version('c5', twin).parent_v);
  assert.equal(log.homeOf('c5', twin), 'n3');
  assert.equal(log.homeOf('c5', mine), 'n5');
  assert.deepEqual(r.report.refused_reuse, [{ id: 'c5', node: 'n5', v: mine }]);
  assert.equal(r.report.counters.reuse_refused_home_off_ancestry, 1);

  // Every version's home is in the ancestry of each node that pins it.
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const ancestry = (id) => { const out = []; for (let n = byId.get(id); n; n = byId.get(n.parent_id)) out.push(n.id); return out; };
  let cross = 0;
  for (const n of g.nodes) {
    for (const p of log.pinsOf(n.id)) {
      const [id, v] = [p.slice(0, p.lastIndexOf('@')), Number(p.slice(p.lastIndexOf('@') + 1))];
      if (!ancestry(n.id).includes(log.homeOf(id, v))) cross++;
    }
  }
  assert.equal(cross, 0, '0 cross-branch homes');
  assert.equal(diffNodes(log, g.nodes, new Set(['c9'])).differ, 0);
});

test('F3: the original locator is a sibling field outside both hashes; reuse needs the hash AND the siblings equal', (t) => {
  const g = fixture(t);
  // n2's c1 differs from n1's only beside the payload: an extra locator key
  // convertAnchor never reads (the converted anchor, so the hash, is unchanged),
  // and a seq bump on n3's (no other change).
  const n2 = JSON.parse(fs.readFileSync(path.join(g.paths.graphDir, 'n2.json'), 'utf8'));
  n2.comments[0].anchor = { ...n2.comments[0].anchor, extra: 'kept beside' };
  fs.writeFileSync(path.join(g.paths.graphDir, 'n2.json'), JSON.stringify(n2));
  const r = migrateComments(g.stateDir);
  assert.equal(r.migrated, true);
  const log = openLog(t, g);
  const v1 = Number(log.pinsOf('n1')[0].split('@')[1]);
  const v2 = Number(log.pinsOf('n2')[0].split('@')[1]);
  assert.notEqual(v2, v1, 'a sibling-only change mints its own version');
  assert.equal(log.version('c1', v2).payload_hash, log.version('c1', v1).payload_hash, 'the hash does not see the locator');
  assert.equal(log.version('c1', v2).src_hash, log.version('c1', v1).src_hash);
  assert.equal(log.version('c1', v2).original.extra, 'kept beside', 'the original rides beside, byte for byte');
  assert.ok(r.report.counters.beside_only_mints >= 1);
  assert.equal(diffNodes(log, [n2], new Set(['c9'])).differ, 0);
});

test('ruling A1: every converted version holds exactly convertAnchor\'s pin-locator@1 shape, with the copy\'s locator as `original`', (t) => {
  const g = fixture(t);
  migrateComments(g.stateDir);
  const log = openLog(t, g);
  let checked = 0;
  for (const n of g.nodes) {
    const pins = log.pinsOf(n.id);
    n.comments.forEach((c, i) => {
      const at = pins[i].lastIndexOf('@');
      const rec = log.version(pins[i].slice(0, at), Number(pins[i].slice(at + 1)));
      if (c.anchor == null) { assert.equal(rec.payload.anchor, null); assert.equal(rec.original, null); return; }
      const a = rec.payload.anchor;
      assert.deepEqual(Object.keys(a).sort(), ['fingerprint', 'form', 'kind', 'mount', 'ordinal', 'path', 'v']);
      assert.equal(a.v, 1);
      assert.equal(a.form, 'pin-locator@1');
      assert.equal(a.form, CONVERTED);
      assert.equal(a.kind, 'element');
      assert.deepEqual(Object.keys(a.path), ['selector']);
      assert.deepEqual(Object.keys(a.fingerprint).sort(), ['classes', 'tag', 'text']);
      assert.deepEqual(a, convertAnchor(c.anchor));
      assert.deepEqual(rec.original, c.anchor);
      checked++;
    });
  }
  assert.ok(checked > 10);
});

// ── park rule b2 ────────────────────────────────────────────────────────────

test('park rule b2 on the fixture: present, first-ghost and changed-ghost copies kept, the unchanged ghost parked', (t) => {
  const g = fixture(t);
  const project = readProject(g.stateDir);
  const log = openLog(t, g);
  const plan = planMigration({ nodes: project.nodes, meta: project.meta, draft: project.draft, log, asides: project.asides });
  const s = (node) => plan.detail.states.get(`${node}|${g.cases.ghosts.id}`);
  assert.equal(s(g.cases.ghosts.present), 'present');
  assert.equal(s(g.cases.ghosts.firstGhost), 'orphan');
  assert.equal(s(g.cases.ghosts.unchangedGhost), 'parked');
  assert.equal(s(g.cases.ghosts.changedGhost), 'orphan');
  assert.equal(plan.detail.states.get(`n4|${g.cases.pageNote.id}`), 'present', 'a page note has no mount to lose');
  assert.equal(plan.park.homeless_pin_ids, 0);
  assert.equal(plan.park.replies_lost, 0);
  assert.equal(typeof plan.park.median_orphans_per_node, 'number');
});

// ── the draft ───────────────────────────────────────────────────────────────

test('the draft on the active node: its copies become versions with no commit record', (t) => {
  const g = fixture(t);
  const r = migrateComments(g.stateDir);
  assert.equal(r.report.draft.state, 'migrated');
  assert.equal(r.report.draft.copies, g.draft.comments.length);
  const log = openLog(t, g);
  // The draft sits on n6: its copy's version is homed on n6's ancestry or nowhere.
  const onBase = new Set(['n6', 'n5', 'n2', 'n1']);
  for (const c of g.draft.comments) {
    const vs = log.byHash(c.id, stableHash(payloadOf(c)))
      .filter((v) => log.version(c.id, v).seq === c.seq)
      .filter((v) => log.homeOf(c.id, v) == null || onBase.has(log.homeOf(c.id, v)));
    assert.equal(vs.length, 1, `${c.id}: one version on the draft's ancestry holds its copy`);
    assert.deepEqual(log.version(c.id, vs[0]).original, c.anchor ?? null);
  }
  const fresh = g.cases.draft.newId;
  assert.ok(log.element(fresh), 'a pin only the draft holds is an element');
  assert.equal(log.homeOf(fresh, 1), null, 'its version has no home: no commit record names it');
  assert.equal(log.commitOf('draft'), null);
  assert.equal(log.commits().length, 6, 'one commit per pin-carrying node, none for the draft');
});

test('a stale draft (base_active is not the active node) is skipped and reported', (t) => {
  const g = fixture(t, { staleDraft: true });
  const r = migrateComments(g.stateDir);
  assert.equal(r.migrated, true);
  assert.equal(r.report.draft.state, 'draft-stale-skipped');
  assert.equal(r.report.draft.base_active, 'n4');
  assert.equal(r.report.draft.active, 'n6');
  const log = openLog(t, g);
  assert.equal(log.element(g.cases.draft.newId), null, 'none of its copies became a version');
  assert.ok(r.report.seq_floor >= 21, 'its seqs still count toward the floor');
});

// ── minting after the migration ─────────────────────────────────────────────

test('minting after migration starts above the corrupt aside and every copy\'s seq; a re-minted id is flagged, not refused', (t) => {
  const g = fixture(t);
  const r = migrateComments(g.stateDir);
  assert.equal(r.migrated, true);
  const maxCopy = Math.max(...g.nodes.flatMap((n) => n.comments.map((c) => c.seq)), ...g.draft.comments.map((c) => c.seq));
  assert.equal(r.report.seq_floor, Math.max(ASIDE_SEQ, maxCopy));
  const log = openLog(t, g);
  assert.ok(log.nextSeq() > ASIDE_SEQ, `nextSeq ${log.nextSeq()} > ${ASIDE_SEQ}`);
  assert.ok(log.nextSeq() > maxCopy);
  assert.notEqual(log.mintId(), `c${ASIDE_SEQ}`);
  const sus = r.report.suspects.find((s) => s.id === g.cases.reminted.id);
  assert.ok(sus, 'the re-minted id is reported');
  assert.equal(sus.reason, 'id-reminted-suspect');
  assert.equal(sus.created_at.length, 2);
});

// ── redaction ───────────────────────────────────────────────────────────────

test('redaction: a fake secret in a copy\'s text never reaches the log; src_hash is the raw payload\'s', (t) => {
  const fake = fakeSecrets({ seed: 0x204 }).find((f) => !f.context && !f.known && !f.text.includes('\n'));
  const g = fixture(t, { secret: fake.text });
  const r = migrateComments(g.stateDir);
  assert.equal(r.migrated, true);
  const bytes = fs.readFileSync(g.paths.elementsLog, 'utf8');
  assert.deepEqual(findLeaks(bytes, [fake]), [], '0 fake values in the log bytes');
  const log = openLog(t, g);
  const copy = g.nodes[0].comments[0];
  const rec = log.version('c1', Number(log.pinsOf('n1')[0].split('@')[1]));
  assert.equal(rec.src_hash, stableHash(payloadOf(copy)), 'src_hash is stableHash of the raw payload');
  assert.notEqual(rec.payload_hash, rec.src_hash);
});

// ── the runner's contexts ───────────────────────────────────────────────────

test('the install context defers the step: version 3, no log, and it says the daemon migrates', (t) => {
  const g = fixture(t);
  const { value, stderr } = quiet(() => run(g.stateDir, { context: 'install' }));
  assert.deepEqual(value, { deferred: 3 });
  assert.equal(version(g), 3);
  assert.equal(fs.existsSync(g.paths.elementsDir), false);
  assert.match(stderr, /runs in the daemon at its next boot/);
  assert.match(stderr, /claude-web-chat migrate/);
  assert.equal(v3ToV4.daemonOnly, true);
});

test('an empty v3 project (no graph files) migrates to 4 and writes nothing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-v3-empty-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const stateDir = path.join(root, '.web-chat');
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, '_version.json'), JSON.stringify({ version: 3 }));
  const { value } = quiet(() => run(stateDir));
  assert.deepEqual(value, { ok: true, version: 4 });
  assert.deepEqual(fs.readdirSync(stateDir), ['_version.json'], 'no elements directory');
});

test('a step that throws comes back as a refusal: v3 kept, the error named', (t) => {
  const g = fixture(t);
  fs.mkdirSync(g.paths.elementsDir, { recursive: true });
  fs.mkdirSync(g.paths.elementsLog); // a directory where the log goes: the open throws
  const { value, stderr } = quiet(() => run(g.stateDir));
  assert.deepEqual(value, { refused: { from: 3, report: null } });
  assert.match(stderr, /failed/);
  assert.equal(version(g), 3);
});

// ── the one-writer hand-off ─────────────────────────────────────────────────

test('every path closes its logs: the store can open the same log right after, in this process', (t) => {
  const reopen = (g) => {
    const log = createElementLog({ file: g.paths.elementsLog, redactor: createRedactor() });
    try { log.load(); } finally { log.close(); }
  };
  const migrated = fixture(t);
  assert.equal(migrateComments(migrated.stateDir).migrated, true);
  reopen(migrated);
  assert.equal(migrateComments(migrated.stateDir).already, true);
  reopen(migrated);
  const refused = fixture(t, { unmappable: true });
  assert.equal(migrateComments(refused.stateDir).refused, true);
  reopen(refused);
  const dry = fixture(t);
  assert.equal(migrateComments(dry.stateDir, { dryRun: true }).dry_run, true);
  reopen(dry);

  // A throw mid-apply: count the redactor's calls a whole run makes, then throw
  // half-way through the real apply.
  const thrown = fixture(t);
  const real = createRedactor();
  let calls = 0;
  const counting = { ...real, value: (x) => { calls++; return real.value(x); } };
  const probe = fixture(t);
  migrateComments(probe.stateDir, { redactor: counting });
  const whole = calls;
  calls = 0;
  const failing = { ...real, value: (x) => { if (++calls > Math.floor(whole * 0.75)) throw new Error('injected'); return real.value(x); } };
  assert.throws(() => migrateComments(thrown.stateDir, { redactor: failing }), /injected/);
  assert.ok(size(thrown.paths.elementsLog) > 0, 'the throw came mid-apply, after some records');
  reopen(thrown);
  // And the next run completes what the throw left.
  const done = migrateComments(thrown.stateDir);
  assert.equal(done.migrated, true);
  const log = openLog(t, thrown);
  assert.equal(diffNodes(log, thrown.nodes, new Set(['c9'])).differ, 0);
});

// ── scale ───────────────────────────────────────────────────────────────────

test('a seeded synthetic graph (200 × 14) maps every copy with 0 homeless pins and 0 replies lost', (t) => {
  const g = fixture(t, { scale: { nodes: 200, copies: 14, seed: 204 } });
  const r = migrateComments(g.stateDir);
  assert.equal(r.migrated, true);
  assert.equal(r.report.copies, 200 * 14);
  assert.deepEqual(r.report.unmapped, []);
  assert.equal(r.report.park.homeless_pin_ids, 0);
  assert.equal(r.report.park.replies_lost, 0);
  const log = openLog(t, g);
  assert.equal(diffNodes(log, g.nodes).differ, 0);
});
