// The per-session turn index (lib/server/mirror/index-store.js, spec §2.11, §2.3
// Resume), against THE STORE CONTRACT in lib/server/mirror/transcripts.js's
// header.
//
// Pinned:
//   * round trip: schedule then flush writes §2.11's shape, and load answers it,
//     every turns[] entry with its top-level id; conversations.js deletePruned,
//     run on a written index, deletes the diff files its turns name;
//   * a corrupt file is renamed aside and answers {ok:false, reason:'corrupt'};
//     a field of the wrong type answers 'invalid' (renamed aside too);
//   * the boot verification: a replaced transcript (new inode), a rewritten head
//     and a truncated file each answer 'stale'; an appended one still loads;
//   * the debounce: many schedules make one write per 2 s (fake timers); flush
//     and stop() write what is pending, and a stopped store writes nothing;
//   * no known value on disk: one registered with addKnown and slipped into the
//     meta (title, first prompt, away text, …) or a header is masked in the file,
//     and the caller's snapshot is not touched;
//   * 5,001 turns keep the newest 5,000; an unsafe id is never written;
//   * readRange: whole lines across readWindow pages, a sub-range exact, and
//     null for a range holding a line over 8 MiB;
//   * with the real createTranscriptsSource on a real createMirror: stop,
//     restart, append one turn — every turn exactly once and the transcript read
//     only from the stored resume; a first prompt and a title quoting a known
//     value are masked in index/<sid>.json while the in-memory meta is not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { withTempHome, waitUntil } = require('../test-support/helpers');
const { createRecords } = require('../test-support/claude-records');
const { createRedactor, MASK } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { projectPaths } = require('../lib/core/paths');
const claudeFiles = require('../lib/core/claude-files');
const { createHookTap } = require('../lib/server/hook-tap');
const { createMirror, SOURCES } = require('../lib/server/mirror');
const { createTailer } = require('../lib/server/mirror/tail');
const { createTranscriptsSource } = require('../lib/server/mirror/transcripts');
const { createConversations } = require('../lib/server/mirror/conversations');
const {
  createIndexStore, INDEX_VERSION, DEBOUNCE_MS, TURNS_MAX,
} = require('../lib/server/mirror/index-store');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const MASK_OPEN = MASK('x').slice(0, -'x›'.length);
const EMAIL = 'pat.indexed-user@example.com';
const ORG = '3c2b1a09-8f7e-4d6c-9b5a-493827160504';

// ── fixtures ─────────────────────────────────────────────────────────────────

function project(t) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-index-store-'));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Timers that fire only when a test advances them.
function fakeTimers() {
  let t = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { seq += 1; pending.set(seq, { at: t + ms, fn }); return seq; },
    clearTimeout(id) { pending.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, p] of pending) if (p.at <= end && (!next || p.at < next[1].at)) next = [id, p];
        if (!next) break;
        pending.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    size: () => pending.size,
  };
}

function storeFor(t, { root = project(t), timers = fakeTimers(), redactor = createRedactor(), files = claudeFiles, now = () => 1700000000000 } = {}) {
  const paths = projectPaths(root);
  const store = createIndexStore({ paths, timers, now, log: () => {}, files, redactor });
  t.after(() => store.stop());
  return { root, paths, timers, redactor, store };
}

// A transcript under the project (the store never fences: its caller does).
function transcript(root, sid, lines) {
  const file = path.join(root, `${sid}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  return file;
}

// The file and resume fields of a snapshot taken after `file`'s current bytes.
function pointOf(file) {
  const st = fs.statSync(file);
  const headLen = Math.min(256, st.size);
  const headHash = crypto.createHash('sha256').update(fs.readFileSync(file).subarray(0, headLen)).digest('hex');
  return {
    file: { dev: st.dev, ino: st.ino, size: st.size, head_len: headLen, head_hash: headHash },
    resume: { dev: st.dev, ino: st.ino, offset: st.size, lastUuid: null, afterUuid: 0, lastLineHash: null, headLen, headHash },
  };
}

function turnEntry(id, extra = {}) {
  return { id, header: { id, status: 'done', summary: `turn ${id}`, ...extra }, internal: { segment: { from: 0, to: 10 }, opener_uuid: null } };
}

function snapshotOf(sid, file, { turns = [turnEntry('t-1'), turnEntry('t-2')], meta = {} } = {}) {
  return {
    v: 1,
    session_id: sid,
    conversation_id: sid,
    slug: '-tmp-project',
    ...pointOf(file),
    turns,
    state: {
      meta: { v: 1, title: 'A title', first_prompt: 'first', ai_title: null, agent_name: null, away: null, ...meta },
      skills: { names: ['deploy'], descriptions: { deploy: 'ship it' } },
      sources: { transcripts: { v: 2, starts: [], known: [] } },
    },
  };
}

const LINES = [{ type: 'user', n: 1, text: 'hello' }, { type: 'assistant', n: 2, text: 'hi there' }];

// ── round trip ───────────────────────────────────────────────────────────────

test('round trip: schedule then flush writes §2.11\'s shape, and load answers it with every turn\'s id on top', async (t) => {
  const { root, paths, store } = storeFor(t);
  const file = transcript(root, S1, LINES);
  const snap = snapshotOf(S1, file);
  let calls = 0;
  store.schedule(S1, () => { calls += 1; return snap; });
  assert.equal(fs.existsSync(paths.mirrorIndex(S1)), false, 'nothing before the debounce or a flush');
  await store.flush(S1);
  assert.equal(calls, 1, 'the snapshot is taken when the store writes');
  const disk = JSON.parse(fs.readFileSync(paths.mirrorIndex(S1), 'utf8'));
  assert.deepEqual(Object.keys(disk), ['v', 'session_id', 'conversation_id', 'slug', 'file', 'resume', 'turns', 'state', 'saved_at']);
  assert.equal(disk.v, INDEX_VERSION);
  assert.equal(disk.saved_at, 1700000000000);
  assert.deepEqual(Object.keys(disk.file), ['dev', 'ino', 'size', 'head_len', 'head_hash']);
  assert.deepEqual(Object.keys(disk.state), ['meta', 'skills', 'sources']);
  const got = await store.load(S1, { file });
  assert.equal(got.ok, true);
  assert.deepEqual(got.index.turns.map((x) => x.id), ['t-1', 't-2']);
  assert.ok(got.index.turns.every((x) => x.header.id === x.id));
  assert.deepEqual(got.index.resume, snap.resume);
  assert.deepEqual(got.index.state, snap.state);
  assert.deepEqual(await store.load(S2, { file }), { ok: false, reason: 'absent' });
});

test('conversations.js deletePruned, run on a written index, deletes the diff files its turns name', async (t) => {
  withTempHome(t);
  const { root, paths, store } = storeFor(t);
  claudeHome(t, { root, isolate: true });
  const file = transcript(root, S1, LINES);
  store.schedule(S1, () => snapshotOf(S1, file, { turns: [turnEntry('turn-old-1'), turnEntry('turn-old-2')] }));
  await store.flush();
  for (const id of ['turn-old-1', 'turn-old-2', 'turn-new-1']) {
    fs.mkdirSync(path.dirname(paths.mirrorDiff(id)), { recursive: true });
    fs.writeFileSync(paths.mirrorDiff(id), '{}');
  }
  const at = Date.now() - 3600 * 1000;
  const stored = (id, when) => ({
    id, created_at: when - 1000, last_activity_at: when, ended_at: when, title: null, name: null, forked_from: null,
    current_session_id: id, sessions: [{ session_id: id, slug: null, reason: 'start', started_at: when - 1000, ended_at: null }], process: null,
  });
  fs.mkdirSync(path.dirname(paths.mirrorConversations), { recursive: true });
  fs.writeFileSync(paths.mirrorConversations, JSON.stringify({ v: 1, conversations: [stored(S1, at), stored(S2, at + 1000)] }));
  const reg = createConversations({
    root,
    log: () => {},
    maxConversations: 1,
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: false, startedAt: null, cpuMs: null, state: null }])),
    isPidAlive: () => false,
    watchFile: () => ({ trigger: async () => {}, stop: async () => {}, retarget: async () => {}, stats: {} }),
  });
  t.after(() => reg.stop());
  await reg.start();
  await reg.flush();
  assert.equal(reg.get(S1), null, 'the older conversation was pruned');
  assert.equal(fs.existsSync(paths.mirrorIndex(S1)), false, 'its index');
  assert.equal(fs.existsSync(paths.mirrorDiff('turn-old-1')), false, 'and the diffs its turns name');
  assert.equal(fs.existsSync(paths.mirrorDiff('turn-old-2')), false);
  assert.equal(fs.existsSync(paths.mirrorDiff('turn-new-1')), true, 'another turn\'s diff stays');
});

// ── a bad file ───────────────────────────────────────────────────────────────

test('a corrupt index is renamed aside and answers {ok:false, reason:"corrupt"}', async (t) => {
  const { root, paths, store } = storeFor(t);
  const file = transcript(root, S1, LINES);
  fs.mkdirSync(path.dirname(paths.mirrorIndex(S1)), { recursive: true });
  fs.writeFileSync(paths.mirrorIndex(S1), '{"v":1,"session_id":');
  assert.deepEqual(await store.load(S1, { file }), { ok: false, reason: 'corrupt' });
  assert.equal(fs.existsSync(paths.mirrorIndex(S1)), false, 'moved out of the way');
  const aside = fs.readdirSync(path.dirname(paths.mirrorIndex(S1))).filter((f) => f.startsWith(`${S1}.json.corrupt-`));
  assert.equal(aside.length, 1, 'kept aside');
  assert.deepEqual(await store.load(S1, { file }), { ok: false, reason: 'absent' });
});

test('a field of the wrong type answers invalid (renamed aside); every field is checked', async (t) => {
  const { root, paths, store } = storeFor(t);
  const file = transcript(root, S1, LINES);
  const bad = [
    (x) => { x.turns[0].id = 5; },
    (x) => { x.turns[1] = { header: { id: 't-2' } }; },
    (x) => { x.turns[0].header.id = 'another'; },
    (x) => { x.file.ino = 'inode'; },
    (x) => { x.file.head_hash = 'not a hash'; },
    (x) => { x.resume.offset = -1; },
    (x) => { x.resume = null; }, // file without resume
    (x) => { x.state.skills.names = 'deploy'; },
    (x) => { x.state.meta = []; },
    (x) => { x.state.sources = null; },
    (x) => { x.session_id = S2; },
    (x) => { x.conversation_id = 7; },
    (x) => { x.saved_at = 'yesterday'; },
    (x) => { x.v = 2; },
    (x) => { x.turns = Array.from({ length: TURNS_MAX + 1 }, (_, i) => turnEntry(`t-${i}`)); },
  ];
  for (const [i, spoil] of bad.entries()) {
    store.schedule(S1, () => snapshotOf(S1, file));
    await store.flush();
    const rec = JSON.parse(fs.readFileSync(paths.mirrorIndex(S1), 'utf8'));
    spoil(rec);
    fs.writeFileSync(paths.mirrorIndex(S1), JSON.stringify(rec));
    assert.deepEqual(await store.load(S1, { file }), { ok: false, reason: 'invalid' }, `case ${i}`);
    assert.equal(fs.existsSync(paths.mirrorIndex(S1)), false, `case ${i}: renamed aside`);
  }
  // Both null is the read-from-0 index, and valid.
  store.schedule(S1, () => ({ ...snapshotOf(S1, file), file: null, resume: null }));
  await store.flush();
  const ok = await store.load(S1, { file });
  assert.equal(ok.ok, true);
  assert.equal(ok.index.resume, null);
});

// ── the boot verification ────────────────────────────────────────────────────

test('boot verification: a replaced transcript, a rewritten head and a truncated file answer stale; an appended one loads', async (t) => {
  const { root, store } = storeFor(t);
  const file = transcript(root, S1, LINES);
  const save = async () => { store.schedule(S1, () => snapshotOf(S1, file)); await store.flush(); };

  await save();
  fs.appendFileSync(file, `${JSON.stringify({ type: 'user', n: 3 })}\n`);
  assert.equal((await store.load(S1, { file })).ok, true, 'grown since: still the file indexed');

  await save();
  const body = fs.readFileSync(file);
  const other = path.join(root, 'other.jsonl');
  fs.writeFileSync(other, body);
  fs.renameSync(other, file); // the same bytes under a new inode
  assert.deepEqual(await store.load(S1, { file }), { ok: false, reason: 'stale' }, 'a new inode');

  await save();
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, Buffer.from('['), 0, 1, 0); // same inode, same size, a new head
  fs.closeSync(fd);
  assert.deepEqual(await store.load(S1, { file }), { ok: false, reason: 'stale' }, 'a rewritten head');

  fs.writeFileSync(file, LINES.map((l) => `${JSON.stringify(l)}\n`).join(''));
  await save();
  fs.truncateSync(file, 10);
  assert.deepEqual(await store.load(S1, { file }), { ok: false, reason: 'stale' }, 'shorter than the resume offset');

  fs.rmSync(file);
  assert.deepEqual(await store.load(S1, { file }), { ok: false, reason: 'stale' }, 'gone');
});

test('the head hash survives a multi-byte character cut at head_len', async (t) => {
  const { root, store } = storeFor(t);
  const lines = [{ type: 'user', text: '漢字'.repeat(200) }];
  const file = transcript(root, S1, lines);
  const snap = snapshotOf(S1, file);
  // 256 bytes in: is that inside a three-byte character? (it is for this text)
  assert.notEqual(fs.readFileSync(file).subarray(0, 256).toString('utf8').at(-1), '字');
  store.schedule(S1, () => snap);
  await store.flush();
  assert.equal((await store.load(S1, { file })).ok, true);
});

// ── writing ──────────────────────────────────────────────────────────────────

test('the debounce: many schedules make one write per 2 s, with the newest snapshot', async (t) => {
  const { root, paths, timers, store } = storeFor(t);
  const file = transcript(root, S1, LINES);
  let taken = 0;
  for (let i = 1; i <= 10; i++) {
    store.schedule(S1, () => { taken += 1; return snapshotOf(S1, file, { meta: { title: `title ${i}` } }); });
  }
  assert.equal(timers.size(), 1, 'one timer for the session');
  timers.advance(DEBOUNCE_MS - 1);
  assert.equal(fs.existsSync(paths.mirrorIndex(S1)), false, 'nothing before 2 s');
  timers.advance(1);
  assert.equal(taken, 1, 'one write');
  assert.equal(JSON.parse(fs.readFileSync(paths.mirrorIndex(S1), 'utf8')).state.meta.title, 'title 10', 'the newest snapshot');
  for (let i = 11; i <= 15; i++) {
    store.schedule(S1, () => { taken += 1; return snapshotOf(S1, file, { meta: { title: `title ${i}` } }); });
    timers.advance(100);
  }
  assert.equal(taken, 1, 'a burst inside the next 2 s is not written yet');
  timers.advance(DEBOUNCE_MS);
  assert.equal(taken, 2, 'one more write');
  assert.equal(JSON.parse(fs.readFileSync(paths.mirrorIndex(S1), 'utf8')).state.meta.title, 'title 15');
  // A snapshot of null writes nothing.
  store.schedule(S1, () => { taken += 1; return null; });
  timers.advance(DEBOUNCE_MS);
  assert.equal(taken, 3);
  assert.equal(JSON.parse(fs.readFileSync(paths.mirrorIndex(S1), 'utf8')).state.meta.title, 'title 15');
  // drop forgets what is pending.
  store.schedule(S1, () => { taken += 1; return snapshotOf(S1, file); });
  store.drop(S1);
  timers.advance(DEBOUNCE_MS);
  assert.equal(taken, 3);
  assert.equal(timers.size(), 0);
});

test('stop() writes what is pending, cancels every timer, and a stopped store writes nothing more', async (t) => {
  const { root, paths, timers, store } = storeFor(t);
  const f1 = transcript(root, S1, LINES);
  const f2 = transcript(root, S2, LINES);
  store.schedule(S1, () => snapshotOf(S1, f1));
  store.schedule(S2, () => snapshotOf(S2, f2));
  assert.equal(timers.size(), 2);
  await store.stop();
  assert.ok(fs.existsSync(paths.mirrorIndex(S1)) && fs.existsSync(paths.mirrorIndex(S2)), 'both written at stop');
  assert.equal(timers.size(), 0, 'no timer left');
  fs.rmSync(paths.mirrorIndex(S1));
  store.schedule(S1, () => snapshotOf(S1, f1));
  await store.flush();
  timers.advance(DEBOUNCE_MS * 2);
  assert.equal(fs.existsSync(paths.mirrorIndex(S1)), false, 'nothing after stop');
});

test('no known value reaches the disk: one slipped into the meta or a header is masked; the caller\'s snapshot is untouched', async (t) => {
  const redactor = createRedactor();
  redactor.addKnown(EMAIL, 'account-email');
  redactor.addKnown(ORG, 'org-id');
  redactor.addKnown('Project Kestrel', 'known');
  const { root, paths, store } = storeFor(t, { redactor });
  const file = transcript(root, S1, LINES);
  const snap = snapshotOf(S1, file, {
    meta: {
      title: `Mail ${EMAIL}`,
      ai_title: `Org ${ORG}`,
      agent_name: 'Project Kestrel helper',
      first_prompt: `please write to ${EMAIL} about ${ORG} and Project Kestrel`,
      away: { text: `back soon, ${EMAIL}`, at: 5 },
    },
    turns: [turnEntry('t-1', { summary: `asked ${EMAIL}` })],
  });
  const before = JSON.parse(JSON.stringify(snap));
  store.schedule(S1, () => snap);
  await store.flush();
  const raw = fs.readFileSync(paths.mirrorIndex(S1), 'utf8');
  for (const v of [EMAIL, ORG, 'Project Kestrel']) assert.ok(!raw.includes(v), `no ${v} in the file`);
  const disk = JSON.parse(raw);
  for (const k of ['title', 'ai_title', 'agent_name', 'first_prompt']) assert.ok(disk.state.meta[k].includes(MASK_OPEN), `${k} masked`);
  assert.ok(disk.state.meta.away.text.includes(MASK_OPEN));
  assert.ok(disk.state.meta.first_prompt.startsWith('please write to '), 'the rest of the text kept');
  assert.equal(disk.state.meta.away.at, 5);
  assert.deepEqual(snap, before, 'the caller\'s snapshot (its meta above all) is not touched');
  assert.deepEqual(disk.file, snap.file, 'the verification fields survive the redactor');
  assert.deepEqual(disk.resume, snap.resume);
  assert.equal((await store.load(S1, { file })).ok, true);
});

test('5,001 turns keep the newest 5,000; an unsafe session id is never written', async (t) => {
  const { root, paths, store } = storeFor(t);
  const file = transcript(root, S1, LINES);
  const turns = Array.from({ length: TURNS_MAX + 1 }, (_, i) => turnEntry(`t-${i}`));
  const snap = snapshotOf(S1, file, { turns });
  store.schedule(S1, () => snap);
  await store.flush();
  const got = await store.load(S1, { file });
  assert.equal(got.ok, true);
  assert.equal(got.index.turns.length, TURNS_MAX);
  assert.equal(got.index.turns[0].id, 't-1', 'the oldest one went');
  assert.equal(got.index.turns.at(-1).id, `t-${TURNS_MAX}`);
  assert.deepEqual(got.index.resume, snap.resume, 'the resume is unaffected');

  const bad = '../escape';
  assert.equal(paths.mirrorIndex(bad), null);
  let taken = 0;
  store.schedule(bad, () => { taken += 1; return { ...snapshotOf(S1, file), session_id: bad }; });
  await store.flush();
  assert.equal(taken, 0, 'never even snapshotted');
  assert.deepEqual(await store.load(bad, { file }), { ok: false, reason: 'absent' });
  // A snapshot for another session is never written under this one's name.
  store.schedule(S2, () => snapshotOf(S1, file));
  await store.flush();
  assert.equal(fs.existsSync(paths.mirrorIndex(S2)), false);
});

// ── readRange ────────────────────────────────────────────────────────────────

test('readRange answers whole lines across readWindow pages, and null for a range holding a line over 8 MiB', async (t) => {
  const windows = [];
  const files = { ...claudeFiles, readWindow: (f, o) => { windows.push(o); return claudeFiles.readWindow(f, o); } };
  const { root, store } = storeFor(t, { files });
  const MiB = 1024 * 1024;
  const big = (c, n) => `${JSON.stringify({ pad: c.repeat(n) })}\n`;
  const lines = ['{"a":"short é"}\n', big('x', 3 * MiB), big('y', 3 * MiB), big('z', 3 * MiB), '{"b":"tail"}\n'];
  const file = path.join(root, 'paged.jsonl');
  fs.writeFileSync(file, lines.join(''));
  const total = Buffer.byteLength(lines.join(''));
  const whole = await store.readRange(file, { from: 0, to: total });
  assert.equal(whole, lines.join(''), 'every line, once, across pages');
  assert.ok(windows.length >= 2, 'more than one readWindow page');
  assert.ok(windows.every((o) => o.maxBytes <= claudeFiles.WINDOW_MAX_BYTES && Number.isInteger(o.from)));
  const at = (i) => Buffer.byteLength(lines.slice(0, i).join(''));
  assert.equal(await store.readRange(file, { from: at(2), to: at(4) }), lines[2] + lines[3], 'a sub-range, exact');
  assert.equal(await store.readRange(file, { from: at(4), to: total }), lines[4]);
  assert.equal(await store.readRange(file, { from: 5, to: 5 }), '');
  assert.equal(await store.readRange(file, { from: 0, to: total + 10 }), null, 'past the end of the file');
  assert.equal(await store.readRange(path.join(root, 'gone.jsonl'), { from: 0, to: 10 }), null, 'a file gone');

  const long = ['{"a":1}\n', big('w', 8 * MiB + 10), '{"b":2}\n'];
  const file2 = path.join(root, 'long.jsonl');
  fs.writeFileSync(file2, long.join(''));
  const end = Buffer.byteLength(long.join(''));
  assert.equal(await store.readRange(file2, { from: 0, to: end }), null, 'a line over 8 MiB cannot be read whole');
  const second = Buffer.byteLength(long[0]);
  assert.equal(await store.readRange(file2, { from: second, to: second + Buffer.byteLength(long[1]) }), null);
  assert.equal(await store.readRange(file2, { from: 0, to: second }), long[0], 'the lines around it still read');
  assert.equal(await store.readRange(file2, { from: end - Buffer.byteLength(long[2]), to: end }), long[2]);
});

// ── with the real source on a real facade ────────────────────────────────────

function setupMirror(t, { root = null, ch = null } = {}) {
  let mirror = null;
  t.after(async () => { if (mirror) await mirror.stop(); });
  if (!root) {
    withTempHome(t);
    root = project(t);
    ch = claudeHome(t, { root, isolate: true });
  }
  const tailers = [];
  const deliveries = [];
  const stores = [];
  const snaps = [];
  const createStore = (opts) => {
    const real = createIndexStore(opts);
    const s = {
      ...real,
      // Each snapshot the store takes, as the source handed it over.
      schedule: (sid, fn) => real.schedule(sid, () => { const v = fn(); if (v) snaps.push(v); return v; }),
    };
    stores.push(s);
    return s;
  };
  const source = createTranscriptsSource({
    createStore,
    pollMs: 40,
    createTailer: (opts) => {
      const rec = { file: opts.file, resume: opts.resume };
      tailers.push(rec);
      return createTailer({
        ...opts,
        onRecords: (recs, meta) => {
          for (const r of recs) deliveries.push({ file: path.basename(opts.file), start: r.start });
          return opts.onRecords(recs, meta);
        },
      });
    },
  });
  const hooks = createHookTap();
  const mirrorBus = createBus({ maxEvents: 2000 });
  const frames = [];
  mirrorBus.setBroadcaster((frame) => frames.push(frame));
  const redactor = createRedactor();
  mirror = createMirror({
    root, hooks, mainBus: createBus(), mirrorBus, redactor, log: () => {},
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    isPidAlive: () => true,
    sources: [...SOURCES, { name: 'transcripts', attach: source.attach }],
  });
  let ts = Date.now();
  const h = { root, ch, mirror, frames, redactor, tailers, deliveries, stores, snaps };
  h.sessionStart = (sid = S1, src = 'startup') => hooks.publish({
    v: 1, event: 'SessionStart', ts: (ts += 1), session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: { source: src }, compact: null, stop: null, prompt: null, ask: null,
  });
  h.records = () => createRecords({ seed: 1, sessionId: S1, cwd: ch.cwd, start: Date.now(), step: 10 });
  h.turnCount = (n) => waitUntil(async () => {
    const p = await mirror.turns(S1, { limit: 100 });
    return p && p.total === n && p.turns.every((x) => x.status !== 'open') ? p : null;
  }, { timeout: 8000, what: `${n} turns` });
  return h;
}

function closedTurn(r, promptId, text = `prompt ${promptId}`) {
  r.prompt(text, { promptId });
  r.assistant([`reply to ${promptId}`]);
  r.turnDuration({ durationMs: 50 });
}

test('real source, real facade: a restart resumes from the index — every turn once, read only from the stored resume; no known value on disk', async (t) => {
  const a = setupMirror(t);
  const r = a.records();
  r.sessionContext({ userEmail: EMAIL });
  r.credentialOrg(ORG);
  r.aiTitle(`Write to ${EMAIL}`);
  closedTurn(r, 'ix-1', `please mail ${EMAIL} about ${ORG}`);
  closedTurn(r, 'ix-2');
  a.ch.writeTranscript(S1, r.records);
  await a.mirror.start();
  a.sessionStart();
  await a.turnCount(2);
  // Written now, before stop, so the in-process meta can be looked at after.
  await waitUntil(() => a.stores.length === 1, { what: 'the store' });
  await a.stores[0].flush();
  const indexFile = projectPaths(a.root).mirrorIndex(S1);
  const raw = fs.readFileSync(indexFile, 'utf8');
  assert.ok(!raw.includes(EMAIL), 'no email in index/<sid>.json');
  assert.ok(!raw.includes(ORG), 'no org id in index/<sid>.json');
  const disk = JSON.parse(raw);
  assert.ok(disk.state.meta.first_prompt.startsWith('please mail ') && disk.state.meta.first_prompt.includes(MASK_OPEN), 'the first prompt, masked');
  assert.ok(disk.state.meta.ai_title.includes(MASK_OPEN), 'the title, masked');
  const handed = a.snaps.at(-1);
  assert.ok(handed.state.meta.first_prompt.includes(EMAIL), 'the snapshot the source handed over is untouched');
  // The meta fold in process is unchanged: a new snapshot still holds the raw text.
  await a.mirror.stop();
  const fresh = a.snaps.at(-1);
  assert.ok(fresh.state.meta.first_prompt.includes(EMAIL), 'the in-memory meta still holds the raw first prompt');
  assert.ok(fresh.state.meta.ai_title.includes(EMAIL), 'and the raw title');
  const saved = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  assert.ok(!JSON.stringify(saved).includes(EMAIL) && !JSON.stringify(saved).includes(ORG), 'nor in the index written at stop');
  assert.deepEqual(saved.turns.map((x) => x.id), ['ix-1', 'ix-2']);
  const resumeAt = saved.resume.offset;
  assert.equal(resumeAt, fs.statSync(a.ch.transcript(S1)).size, 'every turn closed: resume after the last record');

  const b = setupMirror(t, { root: a.root, ch: a.ch });
  await b.mirror.start();
  b.sessionStart(S1, 'resume');
  await b.turnCount(2);
  const tail = await waitUntil(() => b.tailers.find((x) => x.resume), { what: 'the resumed tailer' });
  assert.equal(tail.resume.offset, resumeAt, 'the tailer was handed the stored resume');
  const n0 = r.records.length;
  closedTurn(r, 'ix-3', `again for ${EMAIL}`);
  b.ch.appendTranscript(S1, r.records.slice(n0));
  const page = await b.turnCount(3);
  assert.deepEqual(page.turns.map((x) => x.id), ['ix-1', 'ix-2', 'ix-3'], 'no duplicate, no gap');
  assert.ok(b.deliveries.length > 0 && b.deliveries.every((d) => d.start >= resumeAt), 'the transcript read only from the stored resume');
  const s = JSON.stringify([await b.mirror.turns(S1, { items: 'full', limit: 100 }), b.frames]);
  assert.ok(s.includes('again for ') && !s.includes(EMAIL), 'the email is masked after the restart');
  await b.mirror.stop();
  const after = fs.readFileSync(indexFile, 'utf8');
  assert.ok(!after.includes(EMAIL) && !after.includes(ORG));
  assert.deepEqual(JSON.parse(after).turns.map((x) => x.id), ['ix-1', 'ix-2', 'ix-3']);
});
