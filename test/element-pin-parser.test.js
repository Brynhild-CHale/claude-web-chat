// The one id@v parser (U353; plan 2E.3): lib/core/element-log.js's parsePin and
// pinMapOf, the reader of every pin string in lib/. The five private copies (the
// log's own commit index, the store's pin map, element-scope's, the boot
// reconcile's and the migration's two inline splits) are gone; isPinKey (U352's
// close grammar) is parsePin plus the no-text id check. The conventions ratchet
// holds the split at the last '@' to its home.
//
// The boot probe at the end writes a commit record by hand with malformed pins
// beside good ones and boots it: the report, the restored live pins and the
// repaired version's parent_v are the values recorded at 39b52f8, before the
// private copies were replaced.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { withServer } = require('../test-support/helpers');
const { projectPaths } = require('../lib/core/paths');
const { createRedactor } = require('../lib/core/redact');
const {
  parsePin, pinMapOf, isPinKey, createElementLog, payloadOf, ID_PREFIX,
} = require('../lib/core/element-log');
const { heldCopies } = require('../lib/server/domain/elements');

// ── parsePin ────────────────────────────────────────────────────────────────

test('parsePin: an id@v splits at the last @ into {id, v}', () => {
  assert.deepEqual(parsePin('c3@2'), { id: 'c3', v: 2 });
  assert.deepEqual(parsePin('a@b@3'), { id: 'a@b', v: 3 });
  assert.deepEqual(parsePin('c1@9007199254740991'), { id: 'c1', v: Number.MAX_SAFE_INTEGER });
});

test('parsePin: null for a v that is not a positive safe integer, no @, an @ at 0, or a non-string', () => {
  for (const s of ['c3@0', 'c3@-1', 'c3@1.5', 'c3@x', 'c3@', '@2', 'c3', '', 7, null, undefined]) {
    assert.equal(parsePin(s), null, JSON.stringify(s) ?? String(s));
  }
  // A v written other than as its own decimal is not one either.
  for (const s of ['c3@02', 'c3@ 3', 'c3@3 ', 'c3@1e3', 'c3@0x3', 'c3@+3', 'c3@9007199254740992', {}, ['c3@2']]) {
    assert.equal(parsePin(s), null, JSON.stringify(s));
  }
});

test('parsePin: every type letter of the shared counter parses alike, and every writer\'s template reads back', () => {
  for (const letter of Object.values(ID_PREFIX)) {
    const id = `${letter}17`;
    assert.deepEqual(parsePin(`${id}@4`), { id, v: 4 });
  }
  for (const [id, v] of [['c1', 1], ['h20', 3], ['g5', 12], ['legacy-id_x', 7], ['a@b', 2]]) {
    assert.deepEqual(parsePin(`${id}@${v}`), { id, v });
  }
});

// ── pinMapOf ────────────────────────────────────────────────────────────────

test('pinMapOf: order kept, a later duplicate wins, non-strings and unparseable entries skipped', () => {
  const m = pinMapOf(['c1@1', 'h2@3', 7, null, 'c3@x', '@2', 'c1@4', 'g5@1', 'c9@0', { id: 'c8' }]);
  assert.deepEqual([...m], [['c1', 4], ['h2', 3], ['g5', 1]]);
  assert.deepEqual([...pinMapOf(['c1@x', 'c1@2'])], [['c1', 2]]);
  assert.deepEqual([...pinMapOf(['c1@2', 'c1@x'])], [['c1', 2]], 'an unparseable later entry does not overwrite');
});

test('pinMapOf: a non-array answers an empty Map', () => {
  for (const x of [null, undefined, 'c1@1', 7, { 0: 'c1@1', length: 1 }, new Set(['c1@1'])]) {
    const m = pinMapOf(x);
    assert.ok(m instanceof Map);
    assert.equal(m.size, 0);
  }
});

// ── isPinKey: parsePin plus the no-text id check ────────────────────────────

// U352's close grammar as it stood before this unit, kept here to prove the
// grammar did not move.
const U352_GRAMMAR = (s) => typeof s === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}@[1-9][0-9]{0,15}$/.test(s)
  && Number.isSafeInteger(Number(s.slice(s.lastIndexOf('@') + 1)));

const REFUSED_BY_ID = ['a@b@3', 'a.b@3', '3c@1', '-c@1', 'c 3@1', 'c3:x@1', `c${'x'.repeat(64)}@1`, 'é3@1', 'c3‮@1'];

test('isPinKey: an id parsePin accepts but the id check refuses is refused', () => {
  for (const s of REFUSED_BY_ID) {
    assert.ok(parsePin(s), `parsePin reads ${s}`);
    assert.equal(isPinKey(s), false, s);
  }
  for (const s of ['c3@2', 'h1@1', 'g9@40', `c${'x'.repeat(63)}@1`, 'legacy_id-1@3']) assert.equal(isPinKey(s), true, s);
});

test('isPinKey: the same answer as U352\'s grammar on every case', () => {
  const corpus = [
    ...REFUSED_BY_ID, 'c3@2', 'c3@0', 'c3@02', 'c3@x', 'c3@', '@2', 'c3', '', 'c3@1.5', 'c3@-1', 'c3@1e3', 'c3@ 3',
    'c1@9007199254740991', 'c1@9007199254740992', 'c1@99999999999999999', `c${'x'.repeat(63)}@1`, 'h1@1', 'g9@40',
    7, null, undefined, {},
  ];
  for (const s of corpus) assert.equal(isPinKey(s), U352_GRAMMAR(s), JSON.stringify(s) ?? String(s));
});

test('the census (heldCopies) refuses what isPinKey refuses, and keeps what it keeps', () => {
  const held = heldCopies({ elements: [...REFUSED_BY_ID, 'c3@x', '@2', 'h5@1', 'g2@3'] });
  assert.deepEqual(held, ['h5@1', 'g2@3']);
  assert.deepEqual(heldCopies({ comments: [{ id: 'a.b', v: 3 }, { id: 'c1', v: 2 }] }), ['c1@2']);
});

// ── the log's commit index reads through parsePin ───────────────────────────

test('the log\'s home index: a malformed pin homes nothing, a good one beside it homes as before', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-pin-parser-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const file = projectPaths(dir).elementsLog;
  const open = () => { const l = createElementLog({ file, redactor: createRedactor() }); t.after(() => l.close()); l.load(); return l; };
  const log = open();
  const copy = { text: 't', shared: true, replies: [], anchor: null };
  log.appendVersion({ id: 'c3', payload: payloadOf(copy), at: 1 });
  log.appendVersion({ id: 'c3', payload: payloadOf({ ...copy, text: 'u' }), parent_v: 1, at: 2 });
  const node = (id, parent_id) => ({ id, parent_id, created_at: 1, comments: [] });
  log.appendCommit({ node: node('n1', null), pins: ['c3@x', '@2', 'c3@02', 'c3@0', 'c3@1'] });
  log.appendCommit({ node: node('n2', 'n1'), pins: ['c3@2'] });
  const check = (l) => {
    assert.equal(l.homeOf('c3', 1), 'n1');
    assert.equal(l.homeOf('c3', 2), 'n2', 'c3@02 on n1 is not c3@2');
    assert.deepEqual(l.pinsOf('n1'), ['c3@x', '@2', 'c3@02', 'c3@0', 'c3@1'], 'the record is kept as written');
    assert.deepEqual([...pinMapOf(l.pinsOf('n1'))], [['c3', 1]]);
  };
  check(log);
  log.close();
  check(open());
});

// ── the boot probe: a hand-edited commit record changes no outcome ──────────

const anchor = (m) => ({ mount: m, selector: 'p', text: m, ordinal: 0 });
const render = (api, id) => api.post('/api/render', { id, html: `<p>${id}</p>` });
async function turn(api, message, work) {
  await api.post('/api/turn-begin', { message });
  if (work) await work();
  return api.post('/api/turn-end', { author: 'claude' });
}
function addPin(srv, text, mount) {
  const pin = srv.elements.add({ text, anchor: anchor(mount) });
  srv.state.comments = [...(srv.state.comments || []), pin];
  return pin;
}
function replyPin(srv, id, text) {
  const cur = srv.state.comments.find((p) => p.id === id);
  const next = srv.elements.reply(cur, { text });
  srv.state.comments = srv.state.comments.map((p) => (p.id === id ? next : p));
  return next;
}
const readLog = (root) => fs.readFileSync(projectPaths(root).elementsLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('a commit record hand-edited to pin c4@x, @2, c2@0, c9@0 and c8@1.5 beside good pins boots to 39b52f8\'s outcome', async (t) => {
  const s1 = await withServer(t);
  let one = null;
  let two = null;
  let three = null;
  const A = (await turn(s1.api, 'A', async () => {
    await render(s1.api, 'm1');
    one = addPin(s1.srv, 'one', 'm1');
    two = addPin(s1.srv, 'two', 'm1');
  })).json.node_id;
  const B = (await turn(s1.api, 'B', async () => {
    replyPin(s1.srv, one.id, 'r');
    three = addPin(s1.srv, 'three', 'm1');
  })).json.node_id;
  await s1.stop();
  const root = s1.root;
  assert.deepEqual([A, B, one.id, two.id, three.id], ['n0', 'n1', 'c1', 'c2', 'c4']);

  // A's record gains two malformed pins after its good ones; B's gains a
  // malformed pin of an id it also pins well (before the good one, which wins
  // in every reader), and three of ids nothing holds. c1@2, which B pins, is
  // lost from the log, so the reconcile repairs it with a parent_v read from
  // A's pins.
  const out = readLog(root).map((r) => {
    if (r.t === 'commit' && r.node === A) return { ...r, pins: [...r.pins, 'c4@x', '@2'] };
    if (r.t === 'commit' && r.node === B) return { ...r, pins: ['c4@x', 'c2@0', ...r.pins, '@2', 'c9@0', 'c8@1.5'] };
    return r;
  }).filter((r) => !(r.t === 'ver' && r.id === 'c1' && r.v === 2));
  fs.writeFileSync(projectPaths(root).elementsLog, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.deepEqual(out.filter((r) => r.t === 'commit').map((r) => r.pins), [
    ['c1@1', 'c2@1', 'c4@x', '@2'],
    ['c4@x', 'c2@0', 'c1@2', 'c2@1', 'c4@1', '@2', 'c9@0', 'c8@1.5'],
  ]);

  const s2 = await withServer(t, { root });
  const report = JSON.parse(fs.readFileSync(projectPaths(root).elementsBootReport, 'utf8'));
  // 39b52f8's report, its at/boot/timings aside.
  assert.equal(report.clean, false);
  assert.deepEqual(report.states, {
    'node-pins-missing-version': { count: 1, examples: ['n1:c1@2'], detail: [{ node: 'n1', pin: 'c1@2', repaired: true }] },
  });
  assert.deepEqual(report.ack, { appended: 0, keys: 0 });
  assert.deepEqual(report.migration, { state: 'ok', version: 4 });
  // 39b52f8's restored live pins.
  assert.deepEqual(s2.srv.state.comments.map((p) => ({ id: p.id, v: p.v, text: p.text, replies: (p.replies || []).length })), [
    { id: 'c1', v: 2, text: 'one', replies: 1 },
    { id: 'c2', v: 1, text: 'two', replies: 0 },
    { id: 'c4', v: 1, text: 'three', replies: 0 },
  ]);
  // 39b52f8's repair: c1@2 re-appended on c1@1, the version A pins.
  const v2 = s2.srv.elements.version('c1', 2);
  assert.equal(v2.v, 2);
  assert.equal(v2.parent_v, 1);
  const tail = readLog(root).slice(-2).map((r) => ({ t: r.t, id: r.id, v: r.v, parent_v: r.parent_v }));
  assert.deepEqual(tail, [{ t: 'epoch', id: undefined, v: undefined, parent_v: undefined }, { t: 'ver', id: 'c1', v: 2, parent_v: 1 }]);
});
