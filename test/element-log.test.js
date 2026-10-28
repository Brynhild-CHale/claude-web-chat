// The element record layer: lib/core/element-log.js (PLAN.md 1A.2, 1A.4, 1A.5,
// 1A.6; DECISIONS C1, C3, F3; rulings A1 and A2).
//
// The one redacted writer of element text (nothing a rule masks reaches the
// file; both hashes; the sibling fields outside them; a value learned later
// masked on read), the boot that redacts nothing, minting from the log's max,
// the pure helpers (convertAnchor, payloadOf, copyMatches, nodeDigest, park
// rule b2, ancestryIndex, isGraphNode), homeOf, and the dry run.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const el = require('../lib/core/element-log');
const { createRedactor } = require('../lib/core/redact');
const { stableHash } = require('../lib/core/stable-json');
const { projectPaths } = require('../lib/core/paths');
const { fakeSecrets, findLeaks, mulberry32 } = require('../test-support/fake-secrets');

const {
  createElementLog, convertAnchor, payloadOf, copyMatches, nodeDigest,
  parkB2, parkMetrics, ancestryIndex, isGraphNode,
} = el;

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-element-log-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// A log in a fresh project's .web-chat/elements/, closed when the test ends.
function openIn(t, dir, opts = {}) {
  const file = opts.file || projectPaths(dir).elementsLog;
  const log = createElementLog({ file, redactor: opts.redactor || createRedactor(), ...opts });
  t.after(() => log.close());
  log.load();
  return log;
}

// A redactor that counts its calls (createRedactor's instance is frozen, so wrap it).
function spyRedactor() {
  const r = createRedactor();
  const calls = { value: 0, text: 0 };
  return {
    calls,
    addKnown: (...a) => r.addKnown(...a),
    value: (...a) => { calls.value++; return r.value(...a); },
    text: (...a) => { calls.text++; return r.text(...a); },
  };
}

const ANCHOR = { mount: 'm', selector: 'div.a.b', text: 'T', ordinal: 2 };
// The same literal U221's pin-locator@1 fixture uses (test/anchors.test.js).
const CONVERTED = {
  v: 1, kind: 'element', form: 'pin-locator@1', mount: 'm', path: { selector: 'div.a.b' }, fingerprint: { tag: 'div', classes: ['a', 'b'], text: 'T' }, ordinal: 2,
};

const copy = (over = {}) => ({ id: 'c1', seq: 1, created_at: 1000, shared: true, text: 'hello', anchor: ANCHOR, replies: [], ...over });

// ── the paths ────────────────────────────────────────────────────────────────

test('projectPaths names the element log, its boot report and the migration report under .web-chat/elements', () => {
  const p = projectPaths('/proj');
  assert.equal(p.elementsDir, path.join('/proj', '.web-chat', 'elements'));
  assert.equal(p.elementsLog, path.join(p.elementsDir, 'log.jsonl'));
  assert.equal(p.elementsBootReport, path.join(p.elementsDir, 'boot-report.json'));
  assert.equal(p.migrationReport, path.join(p.elementsDir, 'migration-report.json'));
});

// ── the one redacted writer ─────────────────────────────────────────────────

test('appendVersion: a rule-shaped secret in the text, a reply and original.text never reaches the file', (t) => {
  const dir = tmpDir(t);
  const log = openIn(t, dir);
  const fakes = fakeSecrets({ seed: 0xe1e }).filter((f) => !f.context && !f.known && !f.text.includes('\n')).slice(0, 12);
  assert.ok(fakes.length >= 8, 'enough one-line, context-free fakes');
  fakes.forEach((f, i) => {
    const id = `c${i + 1}`;
    log.ensureElement({ id, created_at: 1000 + i });
    const raw = payloadOf(copy({ id, text: `note: ${f.text}`, replies: [{ author: 'user', at: 5, text: f.text }] }));
    const rec = log.appendVersion({
      id, payload: raw, author: 'user', at: 2000 + i,
      original: { ...ANCHOR, text: f.text }, writer: { class: 'user', owner: null, verified: false }, provenance: null,
    });
    assert.equal(rec.payload_hash, stableHash(rec.payload), 'payload_hash is the stored (redacted) payload\'s');
    assert.equal(rec.src_hash, stableHash(raw), 'src_hash is the raw payload\'s');
    assert.notEqual(rec.payload_hash, rec.src_hash, `${f.id}: the redactor changed the payload`);
  });
  const bytes = fs.readFileSync(log.file, 'utf8');
  assert.deepEqual(findLeaks(bytes, fakes), [], 'no fake value (or 8 characters of one) is in the log');
  // Read back from disk, the stored payload still rehashes to its hash.
  log.close();
  const again = openIn(t, dir);
  for (let i = 0; i < fakes.length; i++) {
    const v = again.version(`c${i + 1}`, 1);
    assert.equal(stableHash(v.payload), v.payload_hash);
  }
});

test('the sibling fields: original, writer, provenance and owner sit outside both hashes, and each is stored redacted', (t) => {
  const dir = tmpDir(t);
  const log = openIn(t, dir);
  const secret = fakeSecrets({ seed: 7 }).find((f) => !f.context && !f.known && !f.text.includes('\n'));
  const payload = payloadOf(copy());
  const base = log.appendVersion({ id: 'c1', payload, at: 1 });
  const variants = [
    { original: { ...ANCHOR, text: secret.text } },
    { writer: { class: 'claude', owner: secret.text, verified: true } },
    { provenance: { via: 'mcp', note: secret.text } },
    { owner: { id: secret.text } },
  ];
  for (const sib of variants) {
    const rec = log.appendVersion({ id: 'c1', payload, at: 2, parent_v: 1, ...sib });
    assert.equal(rec.payload_hash, base.payload_hash, `${Object.keys(sib)[0]} leaves payload_hash alone`);
    assert.equal(rec.src_hash, base.src_hash, `${Object.keys(sib)[0]} leaves src_hash alone`);
    const k = Object.keys(sib)[0];
    assert.deepEqual(findLeaks(JSON.stringify(rec[k]), [secret]), [], `${k} is stored redacted`);
    assert.ok(rec[k], `${k} is stored`);
  }
  assert.deepEqual(findLeaks(fs.readFileSync(log.file, 'utf8'), [secret]), []);
  // A reply's writer and provenance are not payload: they ride the version (ruling A2).
  const withStamp = payloadOf(copy({ replies: [{ author: 'claude', at: 9, text: 'ok', writer: { class: 'claude' }, provenance: { via: 'x' } }] }));
  const without = payloadOf(copy({ replies: [{ author: 'claude', at: 9, text: 'ok' }] }));
  assert.equal(stableHash(withStamp), stableHash(without));
});

test('learned later (C-13): a value the redactor learns after the write is masked on every read, the bytes unchanged', (t) => {
  const dir = tmpDir(t);
  const redactor = createRedactor();
  const log = openIn(t, dir, { redactor });
  const value = 'plain-words-nobody-masks-4471';
  log.appendVersion({ id: 'c1', payload: payloadOf(copy({ text: `see ${value}` })), original: { text: value }, at: 1 });
  const before = fs.readFileSync(log.file);
  assert.ok(before.toString().includes(value), 'not a rule-shaped value: the write kept it');
  assert.ok(log.version('c1', 1).payload.text.includes(value));
  assert.ok(redactor.addKnown(value, 'known'));
  const masked = log.maskView(log.version('c1', 1));
  assert.ok(!JSON.stringify(masked).includes(value), 'maskView masks it now');
  assert.ok(!log.version('c1', 1).payload.text.includes(value), 'the view masks it at read time too');
  assert.ok(!JSON.stringify(log.latest('c1')).includes(value));
  assert.ok(!JSON.stringify(log.versionsOf('c1')).includes(value));
  assert.equal(masked.payload_hash, log.version('c1', 1).payload_hash, 'the hashes are the stored ones');
  assert.deepEqual(fs.readFileSync(log.file), before, 'the file is never rewritten');
});

test('boot redacts nothing: load() of a 2,000-version log makes no redactor call', (t) => {
  const dir = tmpDir(t);
  const writer = openIn(t, dir);
  for (let i = 1; i <= 400; i++) {
    const id = `c${i}`;
    writer.ensureElement({ id, created_at: i });
    for (let k = 1; k <= 5; k++) writer.appendVersion({ id, payload: payloadOf(copy({ id, text: `t${i}.${k}` })), parent_v: k > 1 ? k - 1 : null, at: k });
  }
  writer.close();
  const spy = spyRedactor();
  const log = createElementLog({ file: projectPaths(dir).elementsLog, redactor: spy });
  t.after(() => log.close());
  const st = log.load();
  assert.equal(st.versions, 2000);
  assert.equal(st.elements, 400);
  assert.deepEqual(spy.calls, { value: 0, text: 0 });
  // Reading a version's v, seq or hash costs no redaction either.
  const v = log.version('c7', 3);
  assert.equal(v.v, 3);
  assert.equal(typeof v.payload_hash, 'string');
  assert.deepEqual(spy.calls, { value: 0, text: 0 });
  assert.equal(v.payload.text, 't7.3');
  assert.equal(spy.calls.value, 1, 'the text is masked when it is read');
});

test('a view is read-only and never the indexed record', (t) => {
  const log = openIn(t, tmpDir(t));
  log.appendVersion({ id: 'c1', payload: payloadOf(copy()), at: 1 });
  const v = log.version('c1', 1);
  assert.ok(Object.isFrozen(v));
  v.payload.text = 'changed';
  assert.equal(log.version('c1', 1).payload.text, 'hello');
  const r = log.appendVersion({ id: 'c1', payload: payloadOf(copy({ text: 'x' })), parent_v: 1, at: 2 });
  r.payload.text = 'mutated';
  assert.equal(log.latest('c1').payload.text, 'x');
});

// ── minting ──────────────────────────────────────────────────────────────────

test('minting: nextSeq is 1 + the log\'s max seq, ids are c + seq, and both survive a reopen', (t) => {
  const dir = tmpDir(t);
  let log = openIn(t, dir);
  assert.equal(log.nextSeq(), 1);
  const a = log.mintId();
  assert.equal(a, 'c1');
  const b = log.mintId();
  assert.equal(b, 'c2', 'a second mint before any append is a new id');
  log.ensureElement({ id: a, created_at: 1 });
  assert.equal(log.appendVersion({ id: a, payload: payloadOf(copy({ id: a })), at: 1 }).seq, 1, 'the first version takes the id\'s seq');
  assert.equal(log.appendVersion({ id: b, payload: payloadOf(copy({ id: b })), at: 1 }).seq, 2);
  const edit = log.appendVersion({ id: a, payload: payloadOf(copy({ id: a, text: 'edited' })), parent_v: 1, at: 2 });
  assert.equal(edit.seq, 3);
  assert.equal(edit.v, 2);
  // A migrated copy keeps its own (older) seq; the max still rules.
  log.appendVersion({ id: 'c40', payload: payloadOf(copy({ id: 'c40' })), seq: 40, at: 3 });
  assert.equal(log.nextSeq(), 41);
  assert.equal(log.mintId(), 'c41');
  log.close();
  log = openIn(t, dir);
  assert.equal(log.nextSeq(), 41, 'only appended seqs survive a reopen (c41 was minted but never written)');
  assert.equal(log.nextV(a), 3);
  assert.equal(log.nextV(b), 2);
  assert.equal(log.nextV('c999'), 1, 'nextV is per element');
  assert.equal(log.bySeq(a, 3), 2);
  assert.equal(log.bySeq(a, 1), 1);
  assert.equal(log.bySeq(a, 99), null);
});

test('minting: a version appended between mintId and the minted id\'s first version never takes its seq', (t) => {
  const log = openIn(t, tmpDir(t));
  const a = log.mintId();
  assert.equal(log.nextSeq(), 2, 'the mint reserved its seq');
  const other = log.appendVersion({ id: 'c900', payload: payloadOf(copy({ id: 'c900' })), at: 1 });
  assert.equal(other.seq, 2, 'an unrelated version takes the next seq, not the minted one');
  const first = log.appendVersion({ id: a, payload: payloadOf(copy({ id: a })), at: 2 });
  assert.equal(`c${first.seq}`, a, 'the minted id is c + its first version\'s seq');
  assert.notEqual(first.seq, other.seq);
});

test('minting: a migration\'s seq_floor, a torn aside\'s "seq" and reserveSeq each raise nextSeq', (t) => {
  const dir = tmpDir(t);
  const file = projectPaths(dir).elementsLog;
  let log = openIn(t, dir);
  log.appendVersion({ id: 'c3', payload: payloadOf(copy({ id: 'c3' })), seq: 3, at: 1 });
  log.appendMigration({ from: 3, to: 4, seq_floor: 50, versions: 1 });
  assert.equal(log.nextSeq(), 51, '1 + the floor');
  assert.equal(log.migration().seq_floor, 50);
  log.close();
  // A crash mid-append leaves a torn tail holding seq 99; the next load sets it aside.
  fs.appendFileSync(file, '{"t":"ver","id":"c99","v":1,"parent_v":null,"seq":99,"sche');
  log = openIn(t, dir);
  assert.ok(log.stats().torn.aside, 'the tail went aside');
  assert.ok(log.nextSeq() >= 100, 'the torn seq is never minted again');
  log.close();
  log = openIn(t, dir);
  assert.ok(log.nextSeq() >= 100, 'nor after another reopen (the aside is rescanned)');
  log.reserveSeq(500);
  assert.equal(log.nextSeq(), 501);
  log.reserve('c3', 9);
  assert.equal(log.nextV('c3'), 10);
  assert.equal(log.appendVersion({ id: 'c3', payload: payloadOf(copy({ id: 'c3', text: 'x' })), parent_v: 1, at: 2 }).v, 10);
  log.close();
  log = openIn(t, dir);
  assert.equal(log.nextV('c3'), 11, 'monotone across close and reopen');
  assert.equal(log.nextSeq(), 502);
});

test('a dry run sees the torn tail still in the file and mints past it, moving nothing', (t) => {
  const dir = tmpDir(t);
  const file = projectPaths(dir).elementsLog;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"t":"ver","id":"c1","v":1,"parent_v":null,"seq":1,"payload":{},"payload_hash":"x"}\n{"t":"ver","seq":77,"id":"c2');
  const log = openIn(t, dir, { dryRun: true });
  assert.ok(log.nextSeq() >= 78);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['log.jsonl']);
});

// ── convertAnchor, payloadOf, copyMatches ──────────────────────────────────

test('convertAnchor: the legacy locator as pin-locator@1 (ruling A1), idempotent, refusing a locator with no mount', () => {
  assert.deepEqual(convertAnchor(ANCHOR), CONVERTED);
  assert.equal(convertAnchor(null), null);
  assert.equal(convertAnchor(undefined), null);
  assert.deepEqual(convertAnchor(CONVERTED), CONVERTED);
  assert.deepEqual(convertAnchor(convertAnchor(ANCHOR)), CONVERTED);
  for (const bad of [{ selector: 'div' }, { mount: '' }, { mount: 3 }]) {
    assert.throws(() => convertAnchor(bad), (e) => e.reason === 'anchor-without-mount');
  }
  assert.deepEqual(convertAnchor({ mount: 'm' }), {
    v: 1, kind: 'element', form: 'pin-locator@1', mount: 'm', path: { selector: '' }, fingerprint: { tag: '*', classes: [], text: '' }, ordinal: null,
  });
  assert.equal(convertAnchor({ mount: 'm', ordinal: 1.5 }).ordinal, null);
});

test('convertAnchor passes through only the full converted shape; a stored anchor that merely names the form is a legacy locator', () => {
  // The anchor is client data (a pane's POST stores it as sent), so naming the
  // form never skips the refusal or the conversion.
  assert.throws(() => convertAnchor({ form: 'pin-locator@1' }), (e) => e.reason === 'anchor-without-mount');
  assert.throws(() => convertAnchor({ form: 'pin-locator@1', heads: ['x'] }), (e) => e.reason === 'anchor-without-mount');
  const almost = [
    { ...CONVERTED, v: 2 },
    { ...CONVERTED, kind: 'range' },
    { ...CONVERTED, path: {} },
    { ...CONVERTED, path: null },
    { ...CONVERTED, fingerprint: { tag: 'div', classes: 'a b', text: 'T' } },
    { ...CONVERTED, fingerprint: { tag: 'div', classes: ['a'] } },
    { ...CONVERTED, fingerprint: null },
    { ...CONVERTED, ordinal: 1.5 },
    { ...CONVERTED, ordinal: undefined },
  ];
  for (const a of almost) {
    const out = convertAnchor(a);
    assert.notEqual(out, a, 'not passed through');
    assert.equal(out.form, 'pin-locator@1');
    assert.equal(out.mount, 'm', 'converted as a legacy locator');
    assert.deepEqual(out.path, { selector: '' });
  }
  const converted = convertAnchor(ANCHOR);
  assert.equal(convertAnchor(converted), converted, 'the full shape is returned as it is');
  assert.equal(convertAnchor({ ...CONVERTED, ordinal: null }).ordinal, null);
});

test('convertAnchor reads only the four locator fields (C-10)', () => {
  const read = new Set();
  const legacy = { ...ANCHOR, heads: ['row text'], state: 'exact', extra: 1 };
  const p = new Proxy(legacy, { get(o, k, r) { read.add(k); return Reflect.get(o, k, r); } });
  assert.deepEqual(convertAnchor(p), CONVERTED);
  assert.deepEqual([...read].sort(), ['mount', 'ordinal', 'selector', 'text']);
});

test('payloadOf: {text, shared, replies, anchor} under the declared normalisation', () => {
  const absent = copy();
  delete absent.replies;
  delete absent.text;
  const p = payloadOf(absent);
  assert.deepEqual(p.replies, [], 'an absent replies key gives []');
  assert.equal(p.text, '', 'an absent text gives \'\'');
  assert.deepEqual(Object.keys(p).sort(), ['anchor', 'replies', 'shared', 'text']);
  assert.deepEqual(p.anchor, CONVERTED);
  const r = payloadOf(copy({ replies: [{ author: 'user', at: 3, text: 'hi', writer: { class: 'user' }, provenance: { q: 1 }, id: 'r1' }] }));
  assert.deepEqual(r.replies, [{ author: 'user', at: 3, text: 'hi' }], 'extra reply keys are dropped');
  const noReplies = copy();
  delete noReplies.replies;
  assert.equal(stableHash(payloadOf(noReplies)), stableHash(payloadOf(copy({ replies: [] }))), 'absent replies and [] hash alike');
});

test('copyMatches: the raw copy against src_hash, the redacted copy against payload_hash; a one-character change matches neither', (t) => {
  const log = openIn(t, tmpDir(t));
  const secret = fakeSecrets({ seed: 11 }).find((f) => !f.context && !f.known && !f.text.includes('\n'));
  const raw = copy({ text: `key ${secret.text}` });
  const rec = log.appendVersion({ id: 'c1', payload: payloadOf(raw), at: 1 });
  assert.notEqual(rec.payload_hash, rec.src_hash);
  assert.ok(copyMatches(raw, rec), 'the raw copy (as 0.8.5 wrote it)');
  const redacted = { ...raw, text: rec.payload.text };
  assert.ok(copyMatches(redacted, rec), 'the redacted copy');
  assert.equal(copyMatches({ ...raw, text: raw.text + '!' }, rec), false);
  assert.equal(copyMatches({ ...redacted, text: redacted.text.slice(1) }, rec), false);
  assert.equal(copyMatches({ ...raw, anchor: { selector: 'x' } }, rec), false, 'an unconvertible anchor matches nothing');
  assert.deepEqual(log.byHash('c1', rec.src_hash), [1]);
  assert.deepEqual(log.byHash('c1', rec.payload_hash), [1]);
  assert.deepEqual(log.byHash('c1', 'nope'), []);
});

// ── commits, homeOf, nodeDigest ────────────────────────────────────────────

const node = (id, parent_id, comments, extra = {}) => ({ id, parent_id, created_at: Number(id.slice(1)) * 10, comments, ...extra });

test('homeOf: the node of the first commit pinning id@v; null for a version no commit pins; the same after reopen', (t) => {
  const dir = tmpDir(t);
  let log = openIn(t, dir);
  log.appendVersion({ id: 'c1', payload: payloadOf(copy()), at: 1 });
  log.appendVersion({ id: 'c1', payload: payloadOf(copy({ text: 'b' })), parent_v: 1, at: 2 });
  log.appendCommit({ node: node('n1', null, [{ id: 'c1', v: 1 }]), pins: ['c1@1'] });
  log.appendCommit({ node: node('n2', 'n1', [{ id: 'c1', v: 1 }]), pins: ['c1@1'] });
  log.appendCommit({ node: node('n3', 'n2', [{ id: 'c1', v: 2 }]), pins: ['c1@2'] });
  log.appendCommit({ node: node('n2', 'n1', []), pins: [] });
  const check = (l) => {
    assert.equal(l.homeOf('c1', 1), 'n1');
    assert.equal(l.homeOf('c1', 2), 'n3');
    assert.equal(l.homeOf('c1', 3), null);
    assert.deepEqual(l.commitOf('n2').pins, [], 'the last commit record per node');
    assert.deepEqual(l.pinsOf('n3'), ['c1@2']);
    assert.equal(l.commitOf('n9'), null);
    assert.equal(l.commits().length, 4);
    assert.equal(l.commitOf('n3').digest, nodeDigest(node('n3', 'n2', [{ id: 'c1', v: 2 }])));
  };
  check(log);
  log.close();
  log = openIn(t, dir);
  check(log);
});

test('nodeDigest: identity and pins only; a copy without v contributes id@', () => {
  const n = node('n4', 'n3', [{ id: 'c1', v: 2, text: 'a' }, { id: 'c2', v: 1 }], { trigger: { kind: 'prompt' } });
  const d = nodeDigest(n);
  for (const change of [{ trigger: { kind: 'wake', ended: 'stop' } }, { bookmark: true }, { name: 'Named' }, { theme: { tokens: { '--wc-bg': '#000' } } }]) {
    assert.equal(nodeDigest({ ...n, ...change }), d, `${Object.keys(change)[0]} leaves the digest`);
  }
  assert.equal(nodeDigest({ ...n, comments: [n.comments[1], { ...n.comments[0], text: 'edited' }] }), d, 'pin order and copy text are not digested');
  assert.notEqual(nodeDigest({ ...n, comments: [...n.comments, { id: 'c3', v: 1 }] }), d, 'a copy added');
  assert.notEqual(nodeDigest({ ...n, comments: [n.comments[0]] }), d, 'a copy removed');
  assert.notEqual(nodeDigest({ ...n, comments: [{ ...n.comments[0], v: 3 }, n.comments[1]] }), d, 'a v changed');
  const legacy = node('n4', 'n3', [{ id: 'c1' }, { id: 'c2', v: 1 }]);
  assert.equal(nodeDigest(legacy), stableHash({ id: 'n4', parent_id: 'n3', created_at: 40, pins: ['c1@', 'c2@1'] }));
  assert.equal(nodeDigest({ ...n, comments: undefined }), stableHash({ id: 'n4', parent_id: 'n3', created_at: 40, pins: [] }));
});

test('epochs: each boot that wrote records leaves one, with its log index', (t) => {
  const dir = tmpDir(t);
  let log = openIn(t, dir, { bootId: 'boot-1', now: () => 111 });
  log.ensureElement({ id: 'c1', created_at: 1 });
  log.appendVersion({ id: 'c1', payload: payloadOf(copy()), at: 1 });
  assert.deepEqual(log.epochs(), [{ boot: 'boot-1', at: 111, pid: process.pid, index: 0 }]);
  log.close();
  log = openIn(t, dir, { bootId: 'boot-2' });
  log.close();
  log = openIn(t, dir, { bootId: 'boot-3', now: () => 333 });
  log.appendVersion({ id: 'c1', payload: payloadOf(copy({ text: 'b' })), parent_v: 1, at: 2 });
  assert.deepEqual(log.epochs().map((e) => [e.boot, e.index]), [['boot-1', 0], ['boot-3', 3]], 'a boot that wrote nothing left none');
  log.close();
  log = openIn(t, dir);
  assert.deepEqual(log.epochs().map((e) => [e.boot, e.index]), [['boot-1', 0], ['boot-3', 3]]);
  assert.deepEqual(log.element('c1'), { t: 'el', id: 'c1', kind: 'comment', created_at: 1 });
  assert.deepEqual(log.ensureElement({ id: 'c1', created_at: 5 }).created_at, 1, 'identity is written once');
});

test('dryRun: no file is created; appended records are indexed and their bytes counted', (t) => {
  const dir = tmpDir(t);
  const log = openIn(t, dir, { dryRun: true });
  log.ensureElement({ id: 'c1', created_at: 1 });
  log.appendVersion({ id: 'c1', payload: payloadOf(copy()), at: 1 });
  log.appendCommit({ node: node('n1', null, [{ id: 'c1', v: 1 }]), pins: ['c1@1'] });
  assert.equal(fs.existsSync(projectPaths(dir).elementsDir), false);
  const st = log.stats();
  assert.equal(st.versions, 1);
  assert.equal(st.pending_records, 4, 'the epoch and three records');
  assert.ok(st.pending_bytes > 0);
  assert.equal(log.homeOf('c1', 1), 'n1');
  assert.equal(log.latest('c1').v, 1);
});

test('a malformed or unknown record is counted, never fatal', (t) => {
  const dir = tmpDir(t);
  const file = projectPaths(dir).elementsLog;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '{"t":"ver","id":"c1","v":"x","seq":1}',
    '{"t":"commit","node":"n1"}',
    '{"t":"future","x":1}',
    '{"t":"ver","id":"c2","v":1,"seq":4,"payload":{"text":"a"},"payload_hash":"h"}',
    '{"t":"ver","id":"c2","v":1,"seq":5,"payload":{"text":"b"},"payload_hash":"h2"}',
  ].join('\n') + '\n');
  const log = openIn(t, dir);
  const st = log.stats();
  assert.equal(st.skipped, 2);
  assert.equal(st.unknown, 1);
  assert.equal(st.dupes, 1);
  assert.equal(log.version('c2', 1).payload.text, 'a', 'the first record of an id@v wins');
  assert.equal(log.nextSeq(), 6, 'every version record\'s seq counts, a duplicate\'s too');
});

// ── park rule b2 ─────────────────────────────────────────────────────────────

test('parkB2: present, first-ghost and changed-ghost copies are kept; an unchanged ghost is parked', () => {
  // A chain n1 → n2 → n3 → n4 → n5; pin c1's pane is on n1 only. A reply lands on n4.
  const nodes = ['n1', 'n2', 'n3', 'n4', 'n5'].map((id, i) => ({ id, parent_id: i ? `n${i}` : null }));
  const parent = new Map(nodes.map((n) => [n.id, n.parent_id]));
  const topo = { parentOf: (id) => parent.get(id) || null };
  const reply = { author: 'claude', at: 7, text: 'answered' };
  const c = (nodeId, present, replies = []) => ({ node: nodeId, id: 'c1', anchor_mount_present: present, text: 't', shared: true, replies });
  const copies = [c('n1', true), c('n2', false), c('n3', false), c('n4', false, [reply]), c('n5', false, [reply]),
    // c2 is a ghost on n3 with no carrier above it: a first ghost.
    { node: 'n3', id: 'c2', anchor_mount_present: false, text: 'x', shared: true, replies: [] }];
  const { stateOf } = parkB2(copies, topo);
  assert.deepEqual(copies.map((x) => `${x.id}@${x.node}:${stateOf(x)}`), [
    'c1@n1:present', 'c1@n2:orphan', 'c1@n3:parked', 'c1@n4:orphan', 'c1@n5:parked', 'c2@n3:orphan',
  ]);
  const m = parkMetrics(copies, nodes, stateOf);
  assert.deepEqual(m, {
    kept_copies: 4, parked_copies: 2, orphans_total: 3, median_orphans_per_node: 1, max_orphans_per_node: 1,
    pin_carrying_nodes: 5, homeless_pin_ids: 0, homeless_ids: [], replies_lost: 0,
  });
});

// ── ancestryIndex, isGraphNode ──────────────────────────────────────────────

test('ancestryIndex answers ancestor-or-self exactly as lineage.ancestry does on a 500-node branchy graph', () => {
  const { ancestry } = require('../lib/server/domain/lineage');
  const rand = mulberry32(0xa11ce);
  const nodes = [];
  for (let i = 1; i <= 500; i++) {
    // Three roots; otherwise a parent among the earlier nodes, biased to the recent (long trunks, many forks).
    const parent_id = i <= 3 ? null : `n${Math.max(1, i - 1 - Math.floor(rand() * rand() * (i - 1)))}`;
    nodes.push({ id: `n${i}`, parent_id, created_at: i });
  }
  // A parent_id naming no node makes a root too.
  nodes.push({ id: 'n501', parent_id: 'n9999', created_at: 501 });
  const graph = { nodes: new Map(nodes.map((n) => [n.id, n])) };
  const ix = ancestryIndex(nodes);
  let yes = 0;
  for (const n of nodes) {
    const chain = new Set(ancestry(graph, n.id));
    for (const a of nodes) {
      const want = chain.has(a.id);
      if (want) yes++;
      if (ix.isAncestorOrSelf(a.id, n.id) !== want) assert.fail(`${a.id} ancestor-or-self of ${n.id}: index ${!want}, lineage ${want}`);
    }
  }
  assert.ok(yes > 2000, `a deep graph (${yes} ancestor pairs)`);
  assert.equal(ix.isAncestorOrSelf('n1', 'nope'), false);
  assert.equal(ix.isAncestorOrSelf('nope', 'nope'), false);
});

test('isGraphNode: graph.js\'s truth table', () => {
  assert.equal(isGraphNode({ id: 'n7', created_at: 5 }), true);
  for (const bad of [null, undefined, {}, { id: 'x7', created_at: 5 }, { id: 'n7', created_at: '5' }, { id: 'n7' }, 'n7', { id: 'n7x', created_at: 1 }]) {
    assert.equal(isGraphNode(bad), false, JSON.stringify(bad));
  }
});

test('isGraphNode is graph.js\'s predicate, copied verbatim', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const fn = (s) => s.match(/function isGraphNode\(n\) \{\n[^\n]*\n\}/)[0];
  const graphJs = src('lib/server/graph.js');
  const comment = (s) => s.match(/\/\/ The graph-node shape predicate[\s\S]*?placeholder file produces\.\n/)[0];
  // Until the daemon's loader requires the core copy, the two must stay equal.
  if (/function isGraphNode/.test(graphJs)) {
    assert.equal(fn(src('lib/core/element-log.js')), fn(graphJs));
    assert.equal(comment(src('lib/core/element-log.js')), comment(graphJs));
  }
});

test('appendVersion refuses a malformed version before anything is written', (t) => {
  const dir = tmpDir(t);
  const log = openIn(t, dir);
  const p = payloadOf(copy());
  assert.throws(() => log.appendVersion({ payload: p }), TypeError, 'no id');
  assert.throws(() => log.appendVersion({ id: 'c1', payload: 'text' }), TypeError, 'no payload object');
  assert.throws(() => log.appendVersion({ id: 'c1', payload: p, seq: 0 }), TypeError, 'a seq that is not positive');
  assert.throws(() => log.appendVersion({ id: 'c1', payload: p, parent_v: 1 }), TypeError, 'a parent_v not earlier than v');
  // Both hashes cover only {text, shared, replies, anchor}: a payload carrying
  // anything else (a seq, a writer) is refused, never hashed.
  assert.throws(() => log.appendVersion({ id: 'c1', payload: { ...p, seq: 3 } }), TypeError, 'a payload carrying seq');
  assert.throws(() => log.appendVersion({ id: 'c1', payload: { ...p, writer: { class: 'claude', owner: null, verified: false } } }), TypeError, 'a payload carrying writer');
  assert.throws(() => log.appendVersion({ id: 'c1', payload: { text: 'a', seq: 3 } }), TypeError, 'a bare payload carrying seq');
  assert.throws(() => log.appendCommit({ node: { id: 'n1' }, pins: [3] }), TypeError);
  assert.throws(() => log.appendMigration({ seq_floor: -1 }), TypeError);
  assert.equal(fs.existsSync(log.file), false, 'not even the epoch');
});

test('createElementLog needs an injected redactor', () => {
  assert.throws(() => createElementLog({ file: path.join(os.tmpdir(), 'x.jsonl') }), TypeError);
});

// ── comment@2: a chained comment (F.6, U406) ────────────────────────────────

test('comment@2: a chained version round-trips through a reopen, its node copy matches it (copyMatches), and a node copy holding a chain mints under comment@2 (a repair too)', (t) => {
  const { CHAIN_SCHEMA, SCHEMA, commentSchemaOf } = el;
  const { createElementStore } = require('../lib/server/domain/elements');
  const dir = tmpDir(t);
  const log = openIn(t, dir);
  const chained = copy({ chain: ['h7', 'g3'] });
  const payload = payloadOf(chained);
  const rec = log.appendVersion({ id: 'c1', schema: commentSchemaOf(payload), payload, at: 1 });
  assert.equal(rec.schema, CHAIN_SCHEMA);
  assert.deepEqual(rec.payload.chain, ['h7', 'g3']);
  assert.ok(copyMatches(chained, rec), 'the node copy (the pin with its chain) matches');
  assert.ok(copyMatches({ ...chained, v: 1, writer: { class: 'user' } }, rec), 'keys payloadOf does not read stay outside');
  assert.ok(!copyMatches(copy(), rec), 'the same copy with no chain is another payload');
  log.close();
  const again = openIn(t, dir);
  const back = again.version('c1', 1);
  assert.equal(back.schema, CHAIN_SCHEMA);
  assert.deepEqual(back.payload, payload);
  assert.ok(copyMatches(chained, back));
  again.close();

  // The store's mint (attachLive → resolveCopy): a copy with a chain and no
  // version in the log mints a comment@2 version; a chainless one comment@1.
  const dir2 = tmpDir(t);
  const store = createElementStore({ paths: projectPaths(dir2), state: { comments: [] }, graph: { active: null }, redactor: createRedactor(), bootId: 'test:1', now: () => 5 });
  t.after(() => store.close());
  const pins = store.attachLive([copy({ id: 'c4', seq: 4, chain: ['h2', 'c1'] }), copy({ id: 'c5', seq: 5 })]);
  assert.equal(store.version('c4', pins[0].v).schema, CHAIN_SCHEMA);
  assert.deepEqual(store.version('c4', pins[0].v).payload.chain, ['h2', 'c1']);
  assert.ok(copyMatches(pins[0], store.version('c4', pins[0].v)));
  assert.equal(store.version('c5', pins[1].v).schema, SCHEMA);
  // A repair of a lost chained version re-appends it under comment@2.
  const r = store.repair({ id: 'c9', v: 1, copy: copy({ id: 'c9', seq: 9, chain: ['g3'] }) });
  assert.equal(r.repaired, true);
  assert.equal(store.version('c9', 1).schema, CHAIN_SCHEMA);
  // An edit, a reply and a re-anchor of a chained pin keep comment@2 and the chain.
  const pin = store.project('c4', pins[0].v);
  assert.deepEqual(pin.chain, ['h2', 'c1']);
  const e = store.edit(pin, { text: 'edited' });
  assert.equal(store.version('c4', e.pin.v).schema, CHAIN_SCHEMA);
  const rp = store.reply(e.pin, { text: 'a reply' });
  assert.equal(store.version('c4', rp.v).schema, CHAIN_SCHEMA);
  const ra = store.reanchor(rp, { anchor: { mount: 'm2', selector: 'p', text: 'x', ordinal: 0 } });
  assert.equal(store.version('c4', ra.pin.v).schema, CHAIN_SCHEMA);
  assert.deepEqual(ra.pin.chain, ['h2', 'c1']);
  // The chainless pin's projection carries no chain key.
  assert.equal('chain' in store.project('c5', pins[1].v), false);
});
