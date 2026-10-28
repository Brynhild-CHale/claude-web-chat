// The diff-line chat anchor (PLAN.md 3A.4; DECISIONS.md L1, L4, L5; RULED Q7
// and S1-confirm): lib/server/mirror/chat-anchors-diff.js, the resolver's
// diff-line kind, plugged into the chat-anchors SOURCES row through `kinds`.
//
// Pinned, through a real facade (createMirror with every built-in SOURCE, the
// transcripts source on a short poll) over a scratch repository from
// test-support/treesnap-fixture, turns run as v1 hook envelopes the way
// test/mirror-codediff.test.js runs them, anchors made with mirror.recordAnchor
// and answered by mirror.resolveAnchors:
//   * the wiring: the SOURCES row registers 'diff-line', and chat-anchors.js
//     names no diff-line code (the kind plugs in, the resolver is unedited);
//   * GT-13's PEM-mid-hunk fixture: a turn adds a fake PEM block in the middle
//     of a hunk; one anchor per row of that hunk (20) resolves exact, 20/20;
//     the key rows' quotes hold marks and no key bytes (findLeaks);
//   * S1-confirm: a diff-line record is the common head plus file, side, line,
//     line_fp {h}, node_id?, in the stated order, with no fp (checked as stated
//     here, never through U415's validator);
//   * a record rewritten with two rows inserted above the anchored row: the row
//     re-resolves by its fingerprint at the new line; a run of rows sharing one
//     fingerprint answers the nearest (how 'position'); a row whose context
//     changed but whose text is unique answers how 'text';
//   * a value learned after create answers masked, never exact;
//   * U413's re-key followed: an anchor made on the hook id (before and after
//     the opener binds) answers placed with the transcript's turn id, the
//     record found under the header's replaces;
//   * a pre-tranche-1 record (a multi-line secret collapsed to one row, every
//     number after it shifted): the key rows answer unavailable how
//     'line-not-found'; a record removed under a ready header answers
//     unavailable with its rule and note;
//   * Q7: a pending diff answers indexing with its own note; a record on it is
//     refused 'pending';
//   * node_id is a hint: an anchor whose turn resolves nowhere answers
//     unavailable although its node_id names a node whose diff has that file.
//
// A test never requires design/ (CI has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { claudeHome } = require('../test-support/claude-home');
const { withTempHome, waitUntil } = require('../test-support/helpers');
const { createRecords, jsonl } = require('../test-support/claude-records');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { treesnapRepo } = require('../test-support/treesnap-fixture');
const { createRedactor, marksIn, MASK } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { projectPaths } = require('../lib/core/paths');
const { VISIBLE, EXPLAIN } = require('../lib/core/anchor-states');
const { createHookTap } = require('../lib/server/hook-tap');
const { runGit } = require('../lib/server/git-run');
const { createMirror, SOURCES } = require('../lib/server/mirror');
const { createTranscriptsSource } = require('../lib/server/mirror/transcripts');
const { createIndexStore } = require('../lib/server/mirror/index-store');
const { createCodediffSource } = require('../lib/server/mirror/codediff');
const { FP_HEX } = require('../lib/server/mirror/chat-anchors');
const { diffLineKind, PENDING_NOTE } = require('../lib/server/mirror/chat-anchors-diff');

const S1 = '11111111-1111-4111-8111-111111111111';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PEM = fakeSecrets().find((f) => f.id === 'pem-rsa');
const EMAIL = fakeSecrets().find((f) => f.id === 'known-email');
const KEY_MASK = MASK('private-key');

// The file the PEM turn edits: twenty lines, line 10 changed and a key block
// (the PEM carrier's ten lines between `const key = \`` and `\`;`) added after
// it, so one hunk of 20 rows: 3 context, 1 deleted, 14 added, 3 context.
const BEFORE = Array.from({ length: 20 }, (_, i) => `const v${i + 1} = ${i + 1};`);
const AFTER = [...BEFORE.slice(0, 9), 'const v10 = 100;', 'const key = `', ...PEM.text.split('\n'), '`;', ...BEFORE.slice(10)];
const FILE = 'src/config.js';

// A runner over the real one that can hold every `write-tree` while `gate.held`
// is a promise (a snapshot then waits, and its turn's code stays pending).
function gatedRunner(gate) {
  const wrap = (fn) => async (args, opts) => {
    if (gate.held && args.includes('write-tree')) await gate.held;
    return fn(args, opts);
  };
  const r = wrap(runGit);
  r.exclusive = (fn) => runGit.exclusive((git) => fn(wrap(git)));
  r.features = () => runGit.features();
  return r;
}

// A real facade over the repository's root: every built-in SOURCE (so the
// chat-anchors row is the one index.js builds), the transcripts source on a
// short poll, optionally codediff over a gated runner, and a probe that hands
// the test the engine.
async function boot(t, repo, { gate = null, graph = null } = {}) {
  withTempHome(t);
  const root = repo.root;
  const ch = claudeHome(t, { root, isolate: true });
  const hooks = createHookTap();
  const mirrorBus = createBus({ maxEvents: 5000 });
  const frames = [];
  mirrorBus.setBroadcaster((f) => frames.push(f));
  const redactor = createRedactor();
  const box = { engine: null };
  const probe = { name: 'probe', attach: (engine) => { box.engine = engine; return { start: async () => {}, stop: async () => {} }; } };
  const sources = SOURCES.map((s) => {
    if (s.name === 'transcripts') return { name: 'transcripts', attach: createTranscriptsSource({ createStore: createIndexStore, pollMs: 40 }).attach };
    if (s.name === 'codediff' && gate) return { name: 'codediff', attach: createCodediffSource({ runGit: gatedRunner(gate) }).attach };
    return s;
  });
  const mirror = createMirror({
    root, hooks, mainBus: createBus(), mirrorBus, redactor, graph, log: () => {},
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    isPidAlive: () => true,
    sources: [...sources, probe],
  });
  t.after(() => mirror.stop());
  await mirror.start();
  let ts = 0;
  const h = { repo, root, ch, mirror, redactor, frames, box };
  h.env = (event, extra = {}) => {
    ts = Math.max(Date.now(), ts + 1);
    return {
      v: 1, event, ts, session_id: S1, transcript_path: ch.transcript(S1), cwd: ch.cwd,
      prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
      result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...extra,
    };
  };
  h.publish = (event, extra) => hooks.publish(h.env(event, extra));
  h.tool = (event, useId) => h.publish(event, {
    tool: { name: 'Edit', kind: 'Edit', use_id: useId, label: 'Edit', call: 'Edit', input: {}, input_hash: `h-${useId}` },
    ...(event === 'PreToolUse' ? {} : { result: { ok: true, duration_ms: 3, interrupted: false, error: null, fields: {} } }),
  });
  h.turn = (id) => h.box.engine.model.turn(h.box.engine.model.resolveTurn(id) || id);
  h.snapshots = () => { const g = mirror.snapshot({ level: 'local' }).diagnostics.git; return g ? g.snapshots : 0; };
  h.code = (id) => waitUntil(() => {
    const c = h.turn(id) && h.turn(id).code;
    return c && c.status !== 'pending' ? c : null;
  }, { timeout: 20000, what: `turn ${id}'s code` });
  // One whole turn: open, wait for the before, edit between a PreToolUse and its
  // PostToolUse, stop; with `settle` (the default) wait for the code to settle.
  h.run = async (id, edit, { settle = true, text = `prompt ${id}` } = {}) => {
    const before = h.snapshots();
    h.publish('UserPromptSubmit', { prompt_id: id, prompt: { author: 'user', text } });
    await waitUntil(() => h.snapshots() >= before + 1, { timeout: 20000, what: `${id}'s before snapshot` });
    h.tool('PreToolUse', `tu-${id}`);
    await edit();
    h.tool('PostToolUse', `tu-${id}`);
    h.publish('Stop', { stop: { last_assistant_message: 'Done.', agent_transcript_path: null, background_tasks: [], error: null } });
    return settle ? h.code(id) : null;
  };
  h.diffFile = (id) => projectPaths(root).mirrorDiff(id);
  h.rewrite = (id, fn) => {
    const rec = JSON.parse(fs.readFileSync(h.diffFile(id), 'utf8'));
    rec.patch = fn(rec.patch);
    writeJsonAtomic(h.diffFile(id), rec);
  };
  h.record = (input) => mirror.recordAnchor({ kind: 'diff-line', ...input });
  h.resolve = (anchors) => mirror.resolveAnchors(anchors.map((anchor, i) => ({ id: `k${i}`, v: 1, anchor })));
  // Started, the session known, its (empty) transcript followed.
  fs.writeFileSync(ch.transcript(S1), '');
  h.publish('SessionStart', { session: { source: 'startup' } });
  await waitUntil(() => frames.some((f) => f.type === 'mirror:reset' && f.conversation_id === S1), { timeout: 8000, what: 'the session followed' });
  await sleep(100);
  return h;
}

// The rows of the turn's served patch, numbered as renderDiff numbers them
// (the test's own reading of the unified format, to choose rows to pin).
function hunkRows(patch) {
  const rows = [];
  let o = 0; let n = 0; let left = 0;
  for (const l of patch.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m) { o = Number(m[1]); n = Number(m[3]); left = Number(m[2] ?? 1) + Number(m[4] ?? 1); continue; }
    if (left <= 0) continue;
    if (l[0] === '+') { rows.push({ text: l, side: 'new', line: n++ }); left -= 1; }
    else if (l[0] === '-') { rows.push({ text: l, side: 'old', line: o++ }); left -= 1; }
    else { rows.push({ text: l, side: 'new', line: n, old: o }); o++; n++; left -= 2; }
  }
  return rows;
}

// The PEM turn, and an anchor per row of its one hunk (context rows pinned on
// the old side before the key, on the new side after it).
async function pemWorld(t, opts) {
  const repo = treesnapRepo(t, { files: { [FILE]: BEFORE.join('\n') + '\n' } });
  const h = await boot(t, repo, opts);
  assert.equal((await h.run('pKey', async () => repo.write(FILE, AFTER.join('\n') + '\n'))).status, 'ready');
  const served = await h.mirror.diff({ turn: 'pKey' });
  h.rows = hunkRows(served.patch).map((r) => (r.old !== undefined && r.line < 10 ? { ...r, side: 'old', line: r.old } : r));
  return h;
}

// S1-confirm's diff-line row, as stated.
const SHAPE = ['v', 'kind', 'conversation_id', 'session_id', 'turn_id', 'file', 'side', 'line', 'line_fp', 'quote', 'marks', 'label'];
function assertShape(rec) {
  assert.deepEqual(Object.keys(rec), 'node_id' in rec ? [...SHAPE, 'node_id'] : SHAPE, 'the common head and the diff-line fields, in order');
  assert.ok(!('fp' in rec) && !('item_id' in rec) && !('pos' in rec) && !('field' in rec), 'no field another kind owns');
  assert.equal(rec.v, 1);
  assert.equal(rec.kind, 'diff-line');
  for (const k of ['conversation_id', 'session_id', 'turn_id', 'file', 'label']) assert.equal(typeof rec[k], 'string', k);
  assert.ok(rec.side === 'new' || rec.side === 'old');
  assert.ok(Number.isSafeInteger(rec.line) && rec.line >= 1);
  assert.deepEqual(Object.keys(rec.line_fp), ['h']);
  assert.match(rec.line_fp.h, new RegExp(`^[0-9a-f]{${FP_HEX}}$`));
  assert.deepEqual(Object.keys(rec.quote), ['exact', 'prefix', 'suffix']);
  assert.ok(rec.quote.exact.length >= 1 && rec.quote.exact.length <= 2000);
  assert.ok(rec.quote.prefix.length <= 32 && rec.quote.suffix.length <= 32, 'prefix/suffix ≤ 32');
  assert.equal(rec.marks, marksIn(rec.quote.exact).length);
  assert.equal(rec.label, `diff line ${rec.file}:${rec.line}`);
}

function assertVisible(a) {
  assert.equal(a.visible, VISIBLE[a.state]);
  assert.equal(a.explain, EXPLAIN[a.visible]);
}

// ── the wiring ───────────────────────────────────────────────────────────────

test('the chat-anchors SOURCES row registers diff-line; the resolver names no diff-line code', async (t) => {
  const repo = treesnapRepo(t);
  const h = await boot(t, repo);
  const kinds = h.mirror.snapshot({ level: 'local' }).diagnostics.chat_anchors.kinds;
  assert.deepEqual(kinds, ['turn', 'item', 'item-range', 'diff-line']);
  assert.deepEqual(Object.keys(diffLineKind), ['kind', 'record', 'resolve']);
  const resolver = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'mirror', 'chat-anchors.js'), 'utf8');
  assert.ok(!/require\([^)]*chat-anchors-diff/.test(resolver), 'chat-anchors.js does not load the kind');
  assert.ok(!/diffRows|line_fp/.test(resolver), 'chat-anchors.js holds no diff-line code');
  const index = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'mirror', 'index.js'), 'utf8');
  assert.match(index, /createChatAnchorsSource\(\{ kinds: \[diffLineKind\] \}\)/);
});

// ── GT-13: the PEM-mid-hunk fixture ──────────────────────────────────────────

test('GT-13: twenty anchors, one per row of a hunk with a PEM block in its middle, resolve exact 20/20; the key rows quote marks, never key bytes', async (t) => {
  const h = await pemWorld(t);
  assert.equal(h.rows.length, 20, 'one hunk of 20 rows');
  const keyRows = h.rows.filter((r) => r.text === `+${KEY_MASK}`);
  assert.equal(keyRows.length, PEM.secrets.length + 2, 'BEGIN, every body line and END: one masked row each');
  const anchors = [];
  for (const r of h.rows) {
    const made = await h.record({ turn_id: 'pKey', file: FILE, side: r.side, line: r.line });
    assert.ok(made.anchor, `row ${r.side} ${r.line}: ${JSON.stringify(made)}`);
    assertShape(made.anchor);
    assert.equal(made.anchor.turn_id, 'pKey');
    assert.equal(made.anchor.conversation_id, S1);
    assert.equal(made.anchor.session_id, S1);
    assert.equal(made.anchor.quote.exact, r.text, `row ${r.side} ${r.line}: the row's text`);
    anchors.push(made.anchor);
  }
  assert.equal(new Set(anchors.map((a) => `${a.side}:${a.line}`)).size, 20);
  const keyAnchors = anchors.filter((a) => a.quote.exact === `+${KEY_MASK}`);
  assert.equal(keyAnchors.length, keyRows.length);
  for (const a of keyAnchors) assert.equal(a.marks, 1, 'a key row holds one mark');
  // Four key rows sit wholly among key rows: one fingerprint between them.
  const fps = new Map();
  for (const a of keyAnchors) fps.set(a.line_fp.h, (fps.get(a.line_fp.h) || 0) + 1);
  assert.equal(Math.max(...fps.values()), 4, 'the run of masked rows shares a fingerprint');
  assert.deepEqual(findLeaks(JSON.stringify(anchors), [PEM]), [], 'no key bytes in any anchor');
  const answers = await h.resolve(anchors);
  const exact = answers.filter((a) => a.state === 'exact');
  assert.equal(exact.length, 20, `20/20 exact: ${JSON.stringify(answers.filter((a) => a.state !== 'exact'))}`);
  answers.forEach((a, i) => {
    assertVisible(a);
    assert.equal(a.visible, 'placed');
    assert.equal(a.how, 'line');
    assert.equal(a.turn_id, 'pKey');
    assert.deepEqual(a.at, { file: FILE, side: anchors[i].side, line: anchors[i].line });
  });
  assert.deepEqual(findLeaks(JSON.stringify(answers), [PEM]), [], 'no key bytes in any answer');
  assert.ok(!JSON.stringify(answers).includes('const v'), 'an answer carries no diff text');
});

test('a bad request, a file outside the diff and a line with no row are invalid; a node_id is kept as a hint', async (t) => {
  const h = await pemWorld(t);
  for (const bad of [{ side: 'new', line: 0 }, { side: 'both', line: 11 }, { side: 'new', line: 1.5 }, { side: 'new' }, { file: '', side: 'new', line: 11 }]) {
    const r = await h.record({ turn_id: 'pKey', file: FILE, ...bad });
    assert.equal(r.invalid, true, JSON.stringify(bad));
  }
  assert.equal((await h.record({ turn_id: 'pKey', file: 'nope.js', side: 'new', line: 11 })).invalid, true);
  assert.equal((await h.record({ turn_id: 'pKey', file: FILE, side: 'new', line: 2 })).invalid, true, 'line 2 is outside the hunk');
  assert.equal((await h.record({ turn_id: 'pKey', file: FILE, side: 'old', line: 14 })).invalid, true, 'old line 14 is outside the hunk');
  assert.equal((await h.record({ turn_id: 'pKey', file: FILE, side: 'new', line: 11, node_id: 'bad id!' })).invalid, true);
  assert.deepEqual(await h.record({ turn_id: 'no-such-turn', file: FILE, side: 'new', line: 11 }), { unavailable: true, rule: 'gone' });
  const made = await h.record({ turn_id: 'pKey', file: FILE, side: 'new', line: 11, node_id: 'n-hint.1' });
  assertShape(made.anchor);
  assert.equal(made.anchor.node_id, 'n-hint.1');
});

// ── moved, duplicated, changed context, learned value ────────────────────────

test('a record rewritten with two rows above the anchor: re-resolved by fingerprint at the new line; shared fingerprints answer the nearest; a unique text answers how text', async (t) => {
  const h = await pemWorld(t);
  const byText = (text) => h.rows.find((r) => r.text === text);
  const tail = byText('+that is all');
  const key = h.rows.filter((r) => r.text === `+${KEY_MASK}`)[3];
  const v100 = byText('+const v10 = 100;');
  const mk = async (r) => (await h.record({ turn_id: 'pKey', file: FILE, side: r.side, line: r.line })).anchor;
  const [aTail, aKey, aV100] = [await mk(tail), await mk(key), await mk(v100)];
  // Two rows inserted right after `+const key = \`` (the hunk's new count + 2).
  h.rewrite('pKey', (p) => p
    .replace(/^(@@ -\d+,\d+ \+\d+,)(\d+)( @@)/m, (_, a, n, b) => `${a}${Number(n) + 2}${b}`)
    .replace('+const key = `\n', '+const key = `\n+// moved one\n+// moved two\n'));
  const [rt, rk, rv] = await h.resolve([aTail, aKey, aV100]);
  for (const a of [rt, rk, rv]) assertVisible(a);
  assert.deepEqual([rt.state, rt.how, rt.at.line], ['re-resolved', 'fingerprint', tail.line + 2], 'the moved line, by its fingerprint');
  // The key row's fingerprint is shared by the run of masked rows: the nearest.
  assert.deepEqual([rk.state, rk.how, rk.at.line], ['re-resolved', 'position', key.line + 1], 'the nearest row holding the fingerprint');
  // `+const v10 = 100;` now has new rows after it: its fingerprint changed, its text is unique.
  assert.deepEqual([rv.state, rv.how, rv.at.line], ['re-resolved', 'text', v100.line], 'a unique text, its context changed');
});

test('a duplicated row: of two rows holding the fingerprint, the one nearest the recorded line answers (how position), not the first', async (t) => {
  const h = await pemWorld(t);
  const i = h.rows.findIndex((r) => r.text === '+that is all');
  const tail = h.rows[i];
  const made = (await h.record({ turn_id: 'pKey', file: FILE, side: tail.side, line: tail.line })).anchor;
  // The tail row's five-row window copied to the hunk's start: one context row
  // (old and new count + 1) and four added rows (new count + 4).
  const copy = h.rows.slice(i - 2, i + 3).map((r) => r.text);
  assert.equal(copy.filter((x) => x[0] === ' ').length, 1);
  h.rewrite('pKey', (p) => p.replace(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@.*$/m,
    (_, a, b, c, d) => `@@ -${a},${Number(b) + 1} +${c},${Number(d) + 5} @@\n${copy.join('\n')}`));
  const [a] = await h.resolve([made]);
  assertVisible(a);
  const start = h.rows[0].line;
  assert.ok(Math.abs(start + 2 - tail.line) > 5, 'the copy is the farther one');
  assert.deepEqual([a.state, a.how, a.at.line], ['re-resolved', 'position', tail.line + 5], 'the nearest copy: the original, moved down five');
});

test('a row\'s fingerprint and quote stop at its hunk: a change in the hunk before leaves the first row of the next exact', async (t) => {
  const lines = Array.from({ length: 30 }, (_, i) => `const v${i + 1} = ${i + 1};`);
  const repo = treesnapRepo(t, { files: { 'two.js': lines.join('\n') + '\n' } });
  const h = await boot(t, repo);
  const after = lines.slice();
  after[2] = 'const v3 = 33;';
  after[24] = 'const v25 = 2525;';
  assert.equal((await h.run('pTwo', async () => repo.write('two.js', after.join('\n') + '\n'))).status, 'ready');
  const served = await h.mirror.diff({ turn: 'pTwo' });
  assert.equal(served.patch.split('\n').filter((l) => l.startsWith('@@')).length, 2, 'two hunks');
  // The second hunk's first row: no row of the first hunk is its context.
  const made = await h.record({ turn_id: 'pTwo', file: 'two.js', side: 'new', line: 22 });
  assertShape(made.anchor);
  assert.equal(made.anchor.quote.exact, ' const v22 = 22;');
  assert.equal(made.anchor.quote.prefix, '', 'no row before it inside its hunk');
  // The first hunk's last row rewritten: the anchored row's own hunk is unchanged.
  h.rewrite('pTwo', (p) => p.replace('\n const v6 = 6;\n', '\n const v6 = 66;\n'));
  const [a] = await h.resolve([made.anchor]);
  assertVisible(a);
  assert.deepEqual([a.state, a.how, a.at.line], ['exact', 'line', 22]);
});

test('each file section is walked alone, as the chrome draws it: a section after a first one past 5,000 lines records and resolves exact', async (t) => {
  const repo = treesnapRepo(t, { files: { 'a-big.txt': 'one\ntwo\n', 'b-small.txt': 'alpha\nbeta\ngamma\n' } });
  const h = await boot(t, repo);
  assert.equal((await h.run('pBig', async () => {
    repo.write('a-big.txt', 'one\ntwo\nthree\n');
    repo.write('b-small.txt', 'alpha\nbeta two\ngamma\n');
  })).status, 'ready');
  const served = await h.mirror.diff({ turn: 'pBig' });
  assert.ok(served.patch.indexOf('diff --git a/a-big.txt') < served.patch.indexOf('diff --git a/b-small.txt'), 'the big file first');
  const before = (await h.record({ turn_id: 'pBig', file: 'b-small.txt', side: 'new', line: 2 })).anchor;
  assertShape(before);
  // The first file's hunk grown past diffRows's 5,000-line cap, in place.
  const PAD = 5200;
  const pad = Array.from({ length: PAD }, (_, i) => `+pad ${i + 1}`).join('\n');
  h.rewrite('pBig', (p) => {
    const cut = p.indexOf('diff --git a/b-small.txt');
    const head = p.slice(0, cut).replace(/^(@@ -\d+(?:,\d+)? \+\d+,)(\d+)( @@.*)$/m, (_, a, n, b) => `${a}${Number(n) + PAD}${b}\n${pad}`);
    return head + p.slice(cut);
  });
  const grown = await h.mirror.diff({ turn: 'pBig' });
  assert.ok(grown.patch.indexOf('diff --git a/b-small.txt') > 0 && grown.patch.split('\n').length > 5000 + 10, 'the second section starts past line 5,000');
  const made = await h.record({ turn_id: 'pBig', file: 'b-small.txt', side: 'new', line: 2 });
  assert.equal(made.invalid, undefined, JSON.stringify(made));
  assertShape(made.anchor);
  assert.equal(made.anchor.quote.exact, '+beta two');
  assert.equal(made.anchor.line_fp.h, before.line_fp.h);
  const answers = await h.resolve([before, made.anchor]);
  for (const a of answers) {
    assertVisible(a);
    assert.deepEqual([a.state, a.how, a.at], ['exact', 'line', { file: 'b-small.txt', side: 'new', line: 2 }]);
  }
});

test('the text-alone match needs a unique row: a quote whose text now appears twice answers line-not-found', async (t) => {
  const h = await pemWorld(t);
  const v100 = h.rows.find((r) => r.text === '+const v10 = 100;');
  const made = (await h.record({ turn_id: 'pKey', file: FILE, side: v100.side, line: v100.line })).anchor;
  // A copy of the row and one more row after `+const key = \``: the anchored
  // row's fingerprint breaks (its context changed) and its text is no longer unique.
  h.rewrite('pKey', (p) => p
    .replace(/^(@@ -\d+,\d+ \+\d+,)(\d+)( @@)/m, (_, a, n, b) => `${a}${Number(n) + 2}${b}`)
    .replace('+const key = `\n', '+const key = `\n+const v10 = 100;\n+// moved\n'));
  const [a] = await h.resolve([made]);
  assertVisible(a);
  assert.deepEqual([a.state, a.how], ['unavailable', 'line-not-found'], JSON.stringify(a));
});

test('a value learned after create inside the anchored row answers masked, never exact', async (t) => {
  const repo = treesnapRepo(t, { files: { 'notes.md': 'one\ntwo\nthree\n' } });
  const h = await boot(t, repo);
  const line = `owner: ${EMAIL.secrets[0]} (rotate yearly)`;
  assert.equal((await h.run('pMail', async () => repo.write('notes.md', `one\n${line}\ntwo\nthree\n`))).status, 'ready');
  const made = await h.record({ turn_id: 'pMail', file: 'notes.md', side: 'new', line: 2 });
  assert.equal(made.anchor.marks, 0);
  assert.equal(made.anchor.quote.exact, `+${line}`);
  assert.equal((await h.resolve([made.anchor]))[0].state, 'exact');
  h.redactor.addKnown(EMAIL.secrets[0], EMAIL.known);
  const [a] = await h.resolve([made.anchor]);
  assertVisible(a);
  assert.equal(a.state, 'masked');
  assert.equal(a.visible, 'masked');
  assert.deepEqual(a.at, { file: 'notes.md', side: 'new', line: 2 });
  assert.ok(!JSON.stringify(a).includes(EMAIL.secrets[0]));
});

// ── re-keys ──────────────────────────────────────────────────────────────────

test('a re-key is followed: an anchor on the hook id answers placed with the transcript turn id, its record found under replaces', async (t) => {
  const repo = treesnapRepo(t, { files: { 'a.txt': 'alpha\nbeta\ngamma\n' } });
  const h = await boot(t, repo);
  assert.equal((await h.run('hook-a', async () => repo.write('a.txt', 'alpha\nbeta two\ngamma\n'), { text: 'turn a' })).status, 'ready');
  assert.equal(h.turn('hook-a').provisional, true, 'no opener bound yet');
  const early = await h.record({ turn_id: 'hook-a', file: 'a.txt', side: 'new', line: 2 });
  assertShape(early.anchor);
  assert.equal(early.anchor.turn_id, 'hook-a', 'made on the hook id');
  // The transcript's opener binds the hook turn: the id becomes rec-a.
  const r = createRecords({ seed: 41, sessionId: S1, cwd: h.ch.cwd, start: Date.now(), step: 10 });
  r.prompt('turn a', { promptId: 'rec-a' });
  r.assistant(['reply a']);
  r.turnDuration({ durationMs: 40 });
  fs.appendFileSync(h.ch.transcript(S1), jsonl(r.records));
  await waitUntil(() => h.box.engine.model.resolveTurn('hook-a') === 'rec-a', { timeout: 8000, what: 'the re-key' });
  assert.equal(h.turn('rec-a').replaces, 'hook-a');
  assert.ok(fs.existsSync(h.diffFile('hook-a')) && !fs.existsSync(h.diffFile('rec-a')), 'the record stays under the hook id');
  const late = await h.record({ turn_id: 'hook-a', file: 'a.txt', side: 'new', line: 2 });
  assert.equal(late.anchor.turn_id, 'rec-a', 'a record names the turn\'s current id');
  assert.equal(late.anchor.line_fp.h, early.anchor.line_fp.h);
  const answers = await h.resolve([early.anchor, late.anchor]);
  for (const a of answers) {
    assertVisible(a);
    assert.deepEqual([a.state, a.how, a.turn_id, a.at], ['exact', 'line', 'rec-a', { file: 'a.txt', side: 'new', line: 2 }]);
  }
});

// ── unavailable: a collapsed record, a removed one, node_id ──────────────────

test('a pre-tranche-1 record (a multi-line secret collapsed to one row, the numbers after it shifted): the key rows answer line-not-found', async (t) => {
  const h = await pemWorld(t);
  const keyRows = h.rows.filter((r) => r.text === `+${KEY_MASK}`);
  const anchors = [];
  for (const r of keyRows) anchors.push((await h.record({ turn_id: 'pKey', file: FILE, side: r.side, line: r.line })).anchor);
  const lines = keyRows.length;
  // What redactText made of a patch before tranche 1: the key block one row.
  h.rewrite('pKey', (p) => p.replace(new RegExp(`(\\+${KEY_MASK}\\n){${lines}}`), `+${KEY_MASK}\n`));
  const served = await h.mirror.diff({ turn: 'pKey' });
  assert.equal(served.patch.split(KEY_MASK).length - 1, 1, 'one masked row left');
  const answers = await h.resolve(anchors);
  for (const a of answers) {
    assertVisible(a);
    assert.deepEqual([a.state, a.visible, a.how], ['unavailable', 'unavailable', 'line-not-found'], JSON.stringify(a));
    assert.ok(!('at' in a));
  }
});

test('a record removed under a ready header answers unavailable with its rule and note; record answers it too', async (t) => {
  const h = await pemWorld(t);
  const made = await h.record({ turn_id: 'pKey', file: FILE, side: 'new', line: 11 });
  fs.rmSync(h.diffFile('pKey'));
  const served = await h.mirror.diff({ turn: 'pKey' });
  assert.equal(served.status, 'expired');
  assert.ok(served.rule && served.note, 'codediff names the rule and its note');
  const [a] = await h.resolve([made.anchor]);
  assertVisible(a);
  assert.deepEqual([a.state, a.rule, a.note, a.turn_id], ['unavailable', served.rule, served.note, 'pKey']);
  assert.deepEqual(await h.record({ turn_id: 'pKey', file: FILE, side: 'new', line: 11 }), { unavailable: true, rule: served.rule });
});

test('node_id is a hint only: an anchor whose turn resolves nowhere answers unavailable although its node names a diff with the file', async (t) => {
  const graph = {
    nodes: new Map([['n5', { id: 'n5', mirror: { v: 1, turns: [{ turn_id: 'pN1' }] } }]]),
    topology: new Map([['n5', { id: 'n5', parent_id: null, children: [], created_at: 1 }]]),
    active: 'n5',
    snapshotLive: () => ({}),
  };
  const repo = treesnapRepo(t, { files: { 'a.txt': 'one\ntwo\nthree\n' } });
  const h = await boot(t, repo, { graph });
  assert.equal((await h.run('pN1', async () => repo.write('a.txt', 'one\nTWO\nthree\n'))).status, 'ready');
  const made = await h.record({ turn_id: 'pN1', file: 'a.txt', side: 'new', line: 2, node_id: 'n5' });
  assert.equal(made.anchor.node_id, 'n5');
  const node = await h.mirror.diff({ node: 'n5' });
  assert.match(node.combined.patch, /\+TWO/, 'the node\'s diff has the file and the line');
  const [a] = await h.resolve([{ ...made.anchor, turn_id: 'no-such-turn' }]);
  assertVisible(a);
  assert.deepEqual([a.state, a.rule], ['unavailable', 'gone']);
  assert.ok(!('at' in a), 'nothing placed through the node');
  assert.equal((await h.record({ turn_id: 'no-such-turn', file: 'a.txt', side: 'new', line: 2, node_id: 'n5' })).unavailable, true);
});

// ── Q7: a pending diff ───────────────────────────────────────────────────────

test('Q7: a pending diff answers indexing with its own note; a record on it is refused pending; once ready both place', async (t) => {
  const gate = { held: null };
  const repo = treesnapRepo(t, { files: { 'a.txt': 'one\ntwo\n' } });
  const h = await boot(t, repo, { gate });
  assert.equal((await h.run('pA', async () => repo.write('a.txt', 'one\n2\n'))).status, 'ready');
  const shape = (await h.record({ turn_id: 'pA', file: 'a.txt', side: 'new', line: 2 })).anchor;
  let release;
  await h.run('pB', async () => {
    gate.held = new Promise((r) => { release = r; });
    repo.write('a.txt', 'one\n2\nthree\n');
  }, { settle: false });
  await waitUntil(() => h.turn('pB') && h.turn('pB').code && h.turn('pB').code.status === 'pending', { timeout: 8000, what: 'pB pending' });
  assert.deepEqual(await h.record({ turn_id: 'pB', file: 'a.txt', side: 'new', line: 3 }),
    { refused: 'pending', hint: 'the diff for this turn is still being prepared' });
  const [a] = await h.resolve([{ ...shape, turn_id: 'pB' }]);
  assert.deepEqual([a.state, a.visible, a.how, a.note, a.turn_id], ['indexing', 'indexing', 'diff-pending', PENDING_NOTE, 'pB']);
  assert.equal(a.note, 'the code diff for this turn is still being prepared');
  assert.equal(a.explain, EXPLAIN.indexing, 'the EXPLAIN line stays; the chrome shows the note instead');
  gate.held = null;
  release();
  assert.equal((await h.code('pB')).status, 'ready');
  const made = await h.record({ turn_id: 'pB', file: 'a.txt', side: 'new', line: 3 });
  assert.equal((await h.resolve([made.anchor]))[0].state, 'exact');
});
