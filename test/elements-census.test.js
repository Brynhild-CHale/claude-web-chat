// The delete-before-commit census (U352; plan 2E.2; alpha.1 finding K-2;
// DECISIONS F-DEL (c), C2; ruling U352@close-ack-scope (a)).
//
// Two records in the element log, both ids and keys only, never text:
//   close  {boot, at, held: [id@v …], complete}  a graceful stop's mark, after
//          the draft, written only when the boot appended anything or restored
//          a draft holding a version;
//   ack    {boot, at, keys: ['<state> <key>' …]}  the boot reconcile's
//          acknowledgement of the recurring states it reported.
// The census reads them: an unpinned version of an ended epoch that a complete
// later close does not hold is `discarded` (normal); an ack-eligible state an
// ack names is `acknowledged` (normal). A delete still appends nothing (C2).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { withServer } = require('../test-support/helpers');
const { v3Graph } = require('../test-support/v3-graph');
const { projectPaths } = require('../lib/core/paths');
const elementLog = require('../lib/core/element-log');
const { createRedactor } = require('../lib/core/redact');
const { createElementStore, heldCopies } = require('../lib/server/domain/elements');
const { createGraph } = require('../lib/server/graph');
const { createState } = require('../lib/server/state');
const { resolvePaths } = require('../lib/server/paths');
const { reconcileElements, NORMAL, ACK_KEYS } = require('../lib/server/domain/elements-reconcile');

// ── helpers ──────────────────────────────────────────────────────────────────

const bootReport = (root) => JSON.parse(fs.readFileSync(projectPaths(root).elementsBootReport, 'utf8'));
function records(root) {
  let text = '';
  try { text = fs.readFileSync(projectPaths(root).elementsLog, 'utf8'); } catch {}
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const ofType = (root, t) => records(root).filter((r) => r.t === t);
const unclean = (report) => Object.keys(report.states).filter((k) => !NORMAL.has(k)).sort();
const integrityEvents = (srv) => srv.bus.read({ since: 0, kinds: ['integrity'] }).events;
const DISAGREED = 'disagreed at boot';

// A boot with console.error captured: {ctx, errors}.
async function boot(t, opts) {
  const errors = [];
  const orig = console.error;
  console.error = (...a) => { errors.push(a.map(String).join(' ')); };
  let ctx;
  try { ctx = await withServer(t, opts); } finally { console.error = orig; }
  return { ctx, errors, lines: () => errors.filter((l) => l.includes(DISAGREED)) };
}

async function addPin(ctx, text) {
  const r = await ctx.anonApi.post('/api/comments', { text, shared: true, anchor: null });
  assert.equal(r.status, 200, r.text);
  return r.json.pin;
}
async function delPin(ctx, id) {
  assert.equal((await ctx.anonApi.del(`/api/comments/${id}`)).status, 200);
}
const render = (api, id) => api.post('/api/render', { id, html: `<p>${id}</p>` });
async function turn(api, message, work) {
  await api.post('/api/turn-begin', { message });
  if (work) await work();
  return api.post('/api/turn-end', { author: 'claude' });
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-census-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function openLog(t, dir, opts = {}) {
  const log = elementLog.createElementLog({ file: projectPaths(dir).elementsLog, redactor: createRedactor(), ...opts });
  log.load();
  t.after(() => { try { log.close(); } catch {} });
  return log;
}

// ── the log: close and ack ───────────────────────────────────────────────────

test('element-log: close and ack round-trip through a reopen (indexOf, closes, acked, stats)', (t) => {
  const dir = tmpDir(t);
  const a = openLog(t, dir, { bootId: 'b1' });
  a.ensureElement({ id: 'c1' });
  const v1 = a.appendVersion({ id: 'c1', payload: { text: 'one', shared: true, replies: [], anchor: null } });
  const v2 = a.appendVersion({ id: 'c1', payload: { text: 'two', shared: true, replies: [], anchor: null }, parent_v: 1 });
  const close = a.appendClose({ held: ['c1@2', 'h5@1', 'c1@2'], complete: true });
  assert.deepEqual(close.held, ['c1@2', 'h5@1'], 'each id@v once');
  assert.equal(close.boot, 'b1');
  const ack = a.appendAck({ keys: ['uncommitted-lost c1@1', 'bad-line @12'] });
  assert.deepEqual(ack.keys, ['uncommitted-lost c1@1', 'bad-line @12']);
  const iv1 = a.indexOf('c1', v1.v);
  const iv2 = a.indexOf('c1', v2.v);
  assert.ok(Number.isInteger(iv1) && iv2 > iv1);
  assert.equal(a.indexOf('c1', 9), null);
  a.close();

  const b = openLog(t, dir, { bootId: 'b2' });
  assert.equal(b.indexOf('c1', 1), iv1, 'the record index survives a reopen');
  assert.equal(b.indexOf('c1', 2), iv2);
  const closes = b.closes();
  assert.equal(closes.length, 1);
  assert.ok(closes[0].index > iv2, 'the close is after both versions');
  assert.deepEqual([...closes[0].held], ['c1@2', 'h5@1']);
  assert.equal(closes[0].complete, true);
  assert.equal(closes[0].boot, 'b1');
  assert.deepEqual([...b.acked()].sort(), ['bad-line @12', 'uncommitted-lost c1@1']);
  const st = b.stats();
  assert.equal(st.closes, 1);
  assert.equal(st.acks, 1);
  assert.equal(st.unknown, 0);
  assert.equal(st.skipped, 0);
  // The accessors hand out copies.
  b.closes()[0].held.add('x9@1');
  b.acked().add('x');
  assert.equal(b.closes()[0].held.has('x9@1'), false);
  assert.equal(b.acked().has('x'), false);
  // On disk: ids and keys only.
  const recs = fs.readFileSync(projectPaths(dir).elementsLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(Object.keys(recs.find((r) => r.t === 'close')).sort(), ['at', 'boot', 'complete', 'held', 't']);
  assert.deepEqual(Object.keys(recs.find((r) => r.t === 'ack')).sort(), ['at', 'boot', 'keys', 't']);
});

test('element-log: a malformed close or ack is skipped and counted, never fatal; an unknown type stays unknown', (t) => {
  const dir = tmpDir(t);
  const file = projectPaths(dir).elementsLog;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '{"t":"close","held":"c1@1","complete":true}',
    '{"t":"close","held":["c1@1"]}',
    '{"t":"close","held":["some text"],"complete":true}',
    '{"t":"ack","keys":["no-space"]}',
    '{"t":"ack"}',
    '{"t":"close","held":["c1@1"],"complete":false}',
    '{"t":"ack","keys":["uncommitted-lost c1@1"]}',
    '{"t":"tombstone","id":"c1"}',
  ].join('\n') + '\n');
  const log = openLog(t, dir);
  const st = log.stats();
  assert.equal(st.skipped, 5);
  assert.equal(st.unknown, 1);
  assert.equal(st.closes, 1);
  assert.equal(st.acks, 1);
  assert.equal(log.closes()[0].complete, false);
  assert.deepEqual([...log.acked()], ['uncommitted-lost c1@1']);
});

test('element-log: text in held or keys is refused with a TypeError, before anything is written', (t) => {
  const dir = tmpDir(t);
  const log = openLog(t, dir);
  const bad = [
    () => log.appendClose({ held: ['a secret note'], complete: true }),
    () => log.appendClose({ held: ['c1@0'], complete: true }),
    () => log.appendClose({ held: ['c1@x'], complete: true }),
    () => log.appendClose({ held: [{ id: 'c1', v: 1 }], complete: true }),
    () => log.appendClose({ held: ['c1@1'] }),
    () => log.appendClose({ held: 'c1@1', complete: true }),
    () => log.appendAck({ keys: ['uncommitted-lost the user typed this'] }),
    () => log.appendAck({ keys: ['uncommitted-lost'] }),
    () => log.appendAck({ keys: [] }),
    () => log.appendAck({ keys: ['Uncommitted c1@1'] }),
  ];
  for (const f of bad) assert.throws(f, TypeError);
  assert.equal(fs.existsSync(projectPaths(dir).elementsLog) ? fs.readFileSync(projectPaths(dir).elementsLog, 'utf8') : '', '');
});

test('element-log: a dry-run open (the migrate CLI\'s) loads a log holding a close and an ack', (t) => {
  const dir = tmpDir(t);
  const a = openLog(t, dir);
  a.ensureElement({ id: 'c1' });
  a.appendVersion({ id: 'c1', payload: { text: 'x', shared: true, replies: [], anchor: null } });
  a.appendClose({ held: ['c1@1'], complete: true });
  a.appendAck({ keys: ['uncommitted-lost c1@1'] });
  a.close();
  const bytes = fs.readFileSync(projectPaths(dir).elementsLog);
  const dry = openLog(t, dir, { dryRun: true });
  assert.equal(dry.stats().closes, 1);
  assert.equal(dry.stats().acks, 1);
  assert.equal(dry.closes()[0].held.has('c1@1'), true);
  assert.deepEqual(fs.readFileSync(projectPaths(dir).elementsLog), bytes, 'a dry run writes nothing');
});

// ── heldCopies (K.2-4) ───────────────────────────────────────────────────────

test('heldCopies reads value.comments\' id@v and value.elements\' valid id@v, a malformed entry skipped', () => {
  const value = {
    comments: [
      { id: 'c1', v: 2, text: 'not read' },
      { id: 'c3', text: 'no v: not held' },
      { id: 'c4', v: 0 },
      null,
      { id: '', v: 1 },
      { id: 'c1', v: 2 },
    ],
    elements: ['h5@1', 'h6@x', 7, 'g8@3', 'h5@1', 'a note@1'],
  };
  assert.deepEqual(heldCopies(value), ['c1@2', 'h5@1', 'g8@3']);
  assert.deepEqual(heldCopies({ comments: [{ id: 'c1', v: 1 }], elements: ['h5@1', 'h6@x'] }), ['c1@1', 'h5@1']);
  assert.deepEqual(heldCopies(null), []);
  assert.deepEqual(heldCopies({}), []);
});

test('a draft.json whose elements hold h5@1 (its version in the log) reads it draft-held; a close holds it', async (t) => {
  const s1 = await withServer(t);
  const log = s1.srv.elements.log;
  log.ensureElement({ id: 'h5', kind: 'highlight' });
  log.appendVersion({ id: 'h5', payload: { text: 'a highlight', shared: true, replies: [], anchor: null } });
  // The close reads elements through the same helper (U326e fills state.elements).
  const close = s1.srv.elements.noteGracefulClose({ live: { comments: [], elements: ['h5@1', 'h6@x'] }, draftWritten: true });
  assert.deepEqual(close.held, ['h5@1']);
  assert.equal(close.complete, true);
  await s1.stop();
  fs.writeFileSync(projectPaths(s1.root).draft, JSON.stringify({
    schema_version: 1, saved_at: Date.now(), base_active: null, mounts: [], markdown: [], order: [],
    store: { k: 1 }, comments: [], elements: ['h5@1'], captures: [], queue: [], pendingWake: null, pendingAck: null,
  }));
  const s2 = await withServer(t, { root: s1.root });
  const report = bootReport(s1.root);
  assert.equal(report.clean, true, JSON.stringify(report.states));
  assert.deepEqual(report.states['draft-pinned'], { count: 1, examples: ['h5@1'] });
  assert.equal(report.states.discarded, undefined);
  assert.equal(report.states['uncommitted-lost'], undefined);
  assert.equal(integrityEvents(s2.srv).length, 0);
});

// ── the census ───────────────────────────────────────────────────────────────

test('a pin carried through a graceful restart, then deleted: that boot appends exactly one close; the next boot is clean, the version discarded', async (t) => {
  const s1 = await withServer(t);
  // A pane keeps the surface non-empty, so s2's graceful stop writes a fresh
  // draft (an empty surface leaves s1's draft on disk, and the next boot
  // restores it: a pre-existing behaviour of writeDraft, U352 hand-off).
  assert.equal((await render(s1.api, 'm1')).status, 200);
  const pin = await addPin(s1, 'carried');
  await s1.graceful();
  const c1 = ofType(s1.root, 'close');
  assert.equal(c1.length, 1);
  assert.deepEqual(c1[0].held, [`${pin.id}@${pin.v}`], 'the draft held it');
  assert.equal(c1[0].complete, true);

  const s2 = await withServer(t, { root: s1.root });
  const r2 = bootReport(s1.root);
  assert.equal(r2.clean, true, JSON.stringify(r2.states));
  assert.deepEqual(r2.states['draft-pinned'], { count: 1, examples: [`${pin.id}@${pin.v}`] });
  const before = records(s1.root).length;
  await delPin(s2, pin.id);
  assert.equal(records(s1.root).length, before, 'a delete appends nothing (C2)');
  await s2.graceful();
  const added = records(s1.root).slice(before);
  assert.deepEqual(added.filter((r) => r.t !== 'epoch').map((r) => r.t), ['close'], `one close and nothing else: ${JSON.stringify(added)}`);
  const close = added.find((r) => r.t === 'close');
  assert.deepEqual(close.held, []);
  assert.equal(close.complete, true);

  const s3 = await boot(t, { root: s1.root });
  const r3 = bootReport(s1.root);
  assert.equal(r3.clean, true, JSON.stringify(r3.states));
  assert.deepEqual(r3.states.discarded, { count: 1, examples: [`${pin.id}@${pin.v}`] });
  assert.deepEqual(s3.lines(), []);
  assert.equal(integrityEvents(s3.ctx.srv).length, 0);
  assert.deepEqual(s3.ctx.srv.state.comments, [], 'the deleted pin stays deleted');
});

test('a hard stop with an uncommitted pin: uncommitted-lost once (one stderr line, one event), one ack; then acknowledged, clean, no new ack', async (t) => {
  const s1 = await withServer(t);
  const pin = await addPin(s1, 'lost to a crash');
  await s1.stop();
  const key = `${pin.id}@${pin.v}`;

  const s2 = await boot(t, { root: s1.root });
  const r2 = bootReport(s1.root);
  assert.deepEqual(unclean(r2), ['uncommitted-lost'], JSON.stringify(r2.states));
  assert.deepEqual(r2.states['uncommitted-lost'], { count: 1, examples: [key] });
  assert.equal(s2.lines().length, 1, 'one stderr line');
  assert.equal(integrityEvents(s2.ctx.srv).length, 1, 'one integrity event');
  const acks = ofType(s1.root, 'ack');
  assert.equal(acks.length, 1);
  assert.deepEqual(acks[0].keys, [`uncommitted-lost ${key}`]);
  assert.deepEqual(r2.ack, { appended: 1, keys: 1 }, 'the report on disk says so, counts only');
  assert.deepEqual(s2.ctx.srv.elements.integrity().ack, { appended: 1, keys: 1 });
  // A graceful stop after it: its close (the boot appended the ack) lacks the
  // version, and the version stays acknowledged, not discarded.
  await s2.ctx.graceful();

  const s3 = await boot(t, { root: s1.root });
  const r3 = bootReport(s1.root);
  assert.equal(r3.clean, true, JSON.stringify(r3.states));
  assert.deepEqual(r3.states.acknowledged, { count: 1, examples: [`uncommitted-lost ${key}`] });
  assert.equal(r3.states.discarded, undefined);
  assert.deepEqual(s3.lines(), []);
  assert.equal(integrityEvents(s3.ctx.srv).length, 0);
  assert.equal(ofType(s1.root, 'ack').length, 1, 'no new ack');
  assert.deepEqual(r3.ack, { appended: 0, keys: 0 });
});

test('a complete close appended BEFORE a version covers nothing: an earlier graceful stop, then a hard stop, still reports the loss', async (t) => {
  // The census reads only the closes after the version's record index: an
  // earlier boot's close (which could not hold a version not yet written) must
  // never turn a later crash's loss into `discarded`.
  const s1 = await withServer(t);
  await turn(s1.api, 'A', () => render(s1.api, 'm1'));
  await s1.graceful();
  const closes = ofType(s1.root, 'close');
  assert.equal(closes.length, 1, 's1 appended (its commit record), so it closed');
  assert.equal(closes[0].complete, true);

  const s2 = await withServer(t, { root: s1.root });
  const pin = await addPin(s2, 'lost to a crash after an earlier graceful stop');
  await s2.stop(); // a hard stop: no close
  assert.equal(ofType(s1.root, 'close').length, 1, 'no close after the version');
  const key = `${pin.id}@${pin.v}`;

  const s3 = await boot(t, { root: s1.root });
  const r3 = bootReport(s1.root);
  assert.deepEqual(unclean(r3), ['uncommitted-lost'], JSON.stringify(r3.states));
  assert.deepEqual(r3.states['uncommitted-lost'], { count: 1, examples: [key] });
  assert.equal(r3.states.discarded, undefined, 'the earlier close does not cover it');
  assert.equal(s3.lines().length, 1);
  assert.deepEqual(ofType(s1.root, 'ack').map((r) => r.keys), [[`uncommitted-lost ${key}`]]);
});

test('a draft that does not restore (base_active moved): uncommitted-lost as today, then acknowledged', async (t) => {
  const s1 = await withServer(t);
  const pin = await addPin(s1, 'in a draft that will not restore');
  await s1.graceful();
  const draftPath = projectPaths(s1.root).draft;
  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  fs.writeFileSync(draftPath, JSON.stringify({ ...draft, base_active: 'n999' }));
  const key = `${pin.id}@${pin.v}`;

  const s2 = await withServer(t, { root: s1.root });
  const r2 = bootReport(s1.root);
  assert.deepEqual(unclean(r2), ['uncommitted-lost'], JSON.stringify(r2.states));
  assert.deepEqual(r2.states['uncommitted-lost'].examples, [key], 's1\'s close held it, and no later close drops it');
  await s2.graceful();

  await withServer(t, { root: s1.root });
  const r3 = bootReport(s1.root);
  assert.equal(r3.clean, true, JSON.stringify(r3.states));
  assert.deepEqual(r3.states.acknowledged, { count: 1, examples: [`uncommitted-lost ${key}`] });
});

test('a close with complete:false covers nothing: the draft write failed', async (t) => {
  const s1 = await withServer(t);
  const pin = await addPin(s1, 'kept');
  const gone = await addPin(s1, 'deleted');
  await delPin(s1, gone.id);
  // The draft path is a directory: writeDraft returns false.
  fs.mkdirSync(projectPaths(s1.root).draft, { recursive: true });
  await s1.graceful();
  const close = ofType(s1.root, 'close');
  assert.equal(close.length, 1);
  assert.equal(close[0].complete, false);
  assert.deepEqual(close[0].held, [`${pin.id}@${pin.v}`]);

  await withServer(t, { root: s1.root });
  const r2 = bootReport(s1.root);
  assert.deepEqual(unclean(r2), ['uncommitted-lost'], JSON.stringify(r2.states));
  assert.deepEqual(r2.states['uncommitted-lost'].examples.sort(), [`${pin.id}@${pin.v}`, `${gone.id}@${gone.v}`].sort());
  assert.equal(r2.states.discarded, undefined);
});

test('a close with complete:false covers nothing: a v-less live pin', async (t) => {
  const s1 = await withServer(t);
  const gone = await addPin(s1, 'deleted');
  await delPin(s1, gone.id);
  // An attach mint that failed leaves a live pin without v.
  s1.srv.state.comments = [...s1.srv.state.comments, { id: 'c900', seq: 900, created_at: Date.now(), shared: true, text: 'no v', anchor: null, replies: [] }];
  await s1.graceful();
  const close = ofType(s1.root, 'close');
  assert.equal(close.length, 1);
  assert.equal(close[0].complete, false);
  assert.deepEqual(close[0].held, [], 'the v-less pin cannot be named');

  await withServer(t, { root: s1.root });
  const r2 = bootReport(s1.root);
  assert.deepEqual(unclean(r2), ['uncommitted-lost'], JSON.stringify(r2.states));
  assert.deepEqual(r2.states['uncommitted-lost'].examples, [`${gone.id}@${gone.v}`]);
});

test('no delete, Wipe or re-aim appends a record (C2)', async (t) => {
  const s1 = await withServer(t);
  const { api } = s1;
  const A = (await turn(api, 'A', () => render(api, 'm1'))).json.node_id;
  await addPin(s1, 'one');
  const two = await addPin(s1, 'two');
  await addPin(s1, 'three');
  const n = records(s1.root).length;
  await delPin(s1, two.id);
  assert.equal(records(s1.root).length, n, 'a delete');
  assert.equal((await api.post('/api/graph/wipe', {})).status, 200);
  assert.equal(s1.srv.state.comments.length, 0);
  // A Wipe's preserve node commits (a commit record); nothing else is appended.
  const afterWipe = records(s1.root).slice(n);
  assert.deepEqual(afterWipe.filter((r) => r.t !== 'commit' && r.t !== 'ver').map((r) => r.t), [], `a wipe: ${JSON.stringify(afterWipe.map((r) => r.t))}`);
  const m = records(s1.root).length;
  await addPin(s1, 'four');
  const k = records(s1.root).length;
  assert.equal((await api.post('/api/graph/active', { id: A })).status, 200);
  const afterAim = records(s1.root).slice(k);
  assert.ok(m < k);
  for (const r of afterAim) assert.ok(r.t === 'commit' || r.t === 'ver', `a re-aim appends only its preserve commit: ${r.t}`);
  assert.equal(ofType(s1.root, 'close').length + ofType(s1.root, 'ack').length, 0);
});

test('commit-record-without-node is reported once and acknowledged; a second orphan later is reported (a new key)', async (t) => {
  const s1 = await withServer(t);
  await turn(s1.api, 'A', () => render(s1.api, 'm1'));
  const B = (await turn(s1.api, 'B', () => render(s1.api, 'm2'))).json.node_id;
  await s1.stop();
  const graphDir = projectPaths(s1.root).graphDir;
  fs.unlinkSync(path.join(graphDir, `${B}.json`));

  const s2 = await boot(t, { root: s1.root });
  assert.deepEqual(unclean(bootReport(s1.root)), ['commit-record-without-node']);
  assert.equal(s2.lines().length, 1);
  assert.deepEqual(ofType(s1.root, 'ack').map((r) => r.keys), [[`commit-record-without-node ${B}`]]);
  const C = (await turn(s2.ctx.api, 'C', () => render(s2.ctx.api, 'm3'))).json.node_id;
  const D = (await turn(s2.ctx.api, 'D', () => render(s2.ctx.api, 'm4'))).json.node_id;
  assert.ok(C && D);
  await s2.ctx.stop();

  const s3 = await boot(t, { root: s1.root });
  const r3 = bootReport(s1.root);
  assert.equal(r3.clean, true, JSON.stringify(r3.states));
  assert.deepEqual(r3.states.acknowledged, { count: 1, examples: [`commit-record-without-node ${B}`] });
  assert.deepEqual(s3.lines(), []);
  await s3.ctx.stop();
  fs.unlinkSync(path.join(graphDir, `${C}.json`));

  const s4 = await boot(t, { root: s1.root });
  const r4 = bootReport(s1.root);
  assert.deepEqual(unclean(r4), ['commit-record-without-node'], JSON.stringify(r4.states));
  assert.equal(r4.states['commit-record-without-node'].count, 1);
  assert.deepEqual(r4.states['commit-record-without-node'].detail.map((d) => d.node), [C], 'the new orphan');
  assert.deepEqual(r4.states.acknowledged.examples, [`commit-record-without-node ${B}`]);
  assert.equal(s4.lines().length, 1);
  assert.equal(integrityEvents(s4.ctx.srv).length, 1);
  assert.deepEqual(ofType(s1.root, 'ack').map((r) => r.keys), [[`commit-record-without-node ${B}`], [`commit-record-without-node ${C}`]]);
});

test('a bad line is reported once, then acknowledged', async (t) => {
  const s1 = await withServer(t);
  await addPin(s1, 'p');
  await turn(s1.api, 'A', () => render(s1.api, 'm1'));
  await s1.stop();
  const file = projectPaths(s1.root).elementsLog;
  const offset = fs.statSync(file).size;
  fs.appendFileSync(file, '{garbage\n');

  const s2 = await boot(t, { root: s1.root });
  const r2 = bootReport(s1.root);
  assert.deepEqual(unclean(r2), ['bad-line'], JSON.stringify(r2.states));
  assert.deepEqual(r2.states['bad-line'], { count: 1, examples: [offset] });
  assert.deepEqual(ofType(s1.root, 'ack').map((r) => r.keys), [[`bad-line @${offset}`]]);
  await s2.ctx.stop();

  const s3 = await boot(t, { root: s1.root });
  const r3 = bootReport(s1.root);
  assert.equal(r3.clean, true, JSON.stringify(r3.states));
  assert.deepEqual(r3.states.acknowledged, { count: 1, examples: [`bad-line @${offset}`] });
  assert.deepEqual(s3.lines(), []);
  assert.equal(ofType(s1.root, 'ack').length, 1);
});

test('an idle boot (no element touched, no draft holding a version) appends nothing at its graceful stop', async (t) => {
  const s1 = await withServer(t);
  await turn(s1.api, 'A', () => render(s1.api, 'm1'));
  await s1.graceful(); // a draft with a pane and no pin
  assert.equal(ofType(s1.root, 'close').length, 1, 's1 appended (its commit record), so it closed');
  const bytes = fs.readFileSync(projectPaths(s1.root).elementsLog);

  const s2 = await withServer(t, { root: s1.root });
  assert.equal(bootReport(s1.root).clean, true);
  await s2.graceful();
  assert.deepEqual(fs.readFileSync(projectPaths(s1.root).elementsLog), bytes, 'nothing appended: no epoch, no close');

  // A fresh project that never touched an element has no log at all.
  const fresh = await withServer(t);
  await fresh.graceful();
  assert.equal(records(fresh.root).length, 0);
});

test('an idle boot over a committed pin with no draft on disk (after a hard stop) appends nothing at its graceful stop', async (t) => {
  // The active node's committed pins are restored into the live state whether
  // or not a draft was: only a draft that restored makes a version "held by a
  // restored draft" (ruling U352@close-ack-scope (a)).
  const s1 = await withServer(t);
  await turn(s1.api, 'A', () => addPin(s1, 'committed'));
  await s1.stop(); // a hard stop: no draft.json
  assert.equal(fs.existsSync(projectPaths(s1.root).draft), false, 'no draft on disk');
  const bytes = fs.readFileSync(projectPaths(s1.root).elementsLog);

  const s2 = await withServer(t, { root: s1.root });
  assert.equal(bootReport(s1.root).clean, true, JSON.stringify(bootReport(s1.root).states));
  await s2.graceful();
  assert.deepEqual(fs.readFileSync(projectPaths(s1.root).elementsLog), bytes, 'nothing appended: no epoch, no close');
});

test('a read-only store (migration refused) appends neither record and keeps reporting', async (t) => {
  const s1 = await withServer(t, { seed: ({ root }) => { v3Graph(root, { unmappable: true }); } });
  assert.equal(s1.srv.elements.readOnly, true);
  assert.deepEqual(unclean(bootReport(s1.root)), ['migration-refused']);
  assert.equal(s1.srv.elements.noteGracefulClose({ live: { comments: [{ id: 'c1', v: 1 }] }, draftWritten: true }), null);
  assert.equal(s1.srv.elements.acknowledge(['uncommitted-lost c1@1']), null);
  await s1.graceful();
  assert.equal(ofType(s1.root, 'close').length, 0);
  assert.equal(ofType(s1.root, 'ack').length, 0);

  await withServer(t, { root: s1.root });
  assert.deepEqual(unclean(bootReport(s1.root)), ['migration-refused'], 'still reported');
  assert.equal(ofType(s1.root, 'close').length + ofType(s1.root, 'ack').length, 0);
});

test('the ack-eligible states are the six recurring ones', () => {
  assert.deepEqual([...ACK_KEYS].sort(), [
    'bad-line', 'commit-record-without-node', 'copy-v-mismatch', 'dangling-commit-record',
    'node-pins-missing-version', 'uncommitted-lost',
  ]);
  for (const s of ['discarded', 'acknowledged']) assert.ok(NORMAL.has(s), `${s} is normal`);
});

// ── the clean boot's cost (GT-12) ────────────────────────────────────────────

test('a clean boot over a log with closes, acks and a discarded version redacts nothing and hashes no payload', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-census-cost-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolvePaths(root);
  const T0 = 1790000000000;
  for (let k = 0; k < 50; k++) {
    const comments = [{ id: 'c1', seq: 1, created_at: T0, shared: true, text: `pin ${k % 5}`, anchor: { mount: 'm1', selector: 'p', text: 'm1', ordinal: 0 }, replies: [] }];
    const node = { id: `n${k}`, parent_id: k ? `n${k - 1}` : null, created_at: T0 + k * 1000, author: 'claude', trigger: { kind: 'turn', message: '', summary: '' }, mounts: [], store: {}, comments, captures: [] };
    fs.writeFileSync(path.join(paths.GRAPH_DIR, `n${k}.json`), JSON.stringify(node));
  }
  fs.writeFileSync(paths.META_PATH, JSON.stringify({ active: 'n49', lock: null, last_node: 'n49' }));
  const bootIt = (redactor, id) => {
    const state = createState();
    const graph = createGraph({ paths, state, draftPath: projectPaths(root).draft });
    graph.elements = createElementStore({ paths: projectPaths(root), state, graph, redactor, bootId: id });
    graph.load();
    return graph;
  };
  const first = bootIt(createRedactor(), 'b1');
  reconcileElements({ graph: first, store: first.elements, paths });
  // A pin added and dropped before any commit, then a graceful close and an ack.
  const dropped = first.elements.add({ text: 'dropped', anchor: null });
  assert.ok(first.elements.noteGracefulClose({ live: { comments: [] }, draftWritten: false }));
  assert.ok(first.elements.acknowledge(['bad-line @1']));
  first.elements.close();

  const redactor = createRedactor();
  let redactions = 0;
  for (const k of Object.keys(redactor)) {
    if (typeof redactor[k] !== 'function' || /^add/.test(k)) continue;
    const orig = redactor[k];
    redactor[k] = (...a) => { redactions++; return orig.apply(redactor, a); };
  }
  const second = bootIt(redactor, 'b2');
  t.after(() => second.elements.close());
  redactions = 0;
  const counted = {};
  for (const name of ['copyMatches', 'payloadOf']) {
    const orig = elementLog[name];
    counted[name] = 0;
    elementLog[name] = (...a) => { counted[name]++; return orig(...a); };
    t.after(() => { elementLog[name] = orig; });
  }
  const r = reconcileElements({ graph: second, store: second.elements, paths });
  assert.equal(r.clean, true, JSON.stringify(r.states));
  assert.deepEqual(r.states.discarded, { count: 1, examples: [`${dropped.id}@${dropped.v}`] });
  assert.equal(redactions, 0, 'no redactor call');
  assert.deepEqual(counted, { copyMatches: 0, payloadOf: 0 }, 'no payload hashed');
  assert.equal(second.elements.stats().closes, 1);
  assert.equal(second.elements.stats().acks, 1);
});
