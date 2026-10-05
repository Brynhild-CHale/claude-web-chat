// lib/server/mirror/tail.js — the JSONL tailer (spec §2.3, U24).
//
// Transcripts are generated into the sandbox's fake Claude tier
// (test-support/claude-home.js) from seeded records (test-support/
// claude-records.js), never copied from a real ~/.claude.
//
// Most tests make the pumps deterministic: the tailer is handed lib/core/watch
// with the file watch off and an hour-long poll, so a pump happens only at
// start() and drain(). The live-trigger and handle tests use the real watch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createTailer, lineSplitter, HEAD_BYTES } = require('../lib/server/mirror/tail');
const { watchFile: coreWatch } = require('../lib/core/watch');
const { transcriptFile } = require('../lib/core/claude-files');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords, jsonl, chunksOf, appendChunkedAsync, randomSplits, midCharOffsets } = require('../test-support/claude-records');
const { mulberry32 } = require('../test-support/fake-secrets');
const { tmpRoot, waitUntil } = require('../test-support/helpers');

const TAIL_SRC = path.join(__dirname, '..', 'lib', 'server', 'mirror', 'tail.js');

// lib/core/watch with no file watch and an hour's poll: pumps come from
// start() and drain() alone. Counts the watches made and stopped.
function manualWatch({ live = false } = {}) {
  const calls = { made: [], stops: 0 };
  const fn = (file, onTrigger, opts) => {
    calls.made.push({ file, opts });
    const w = coreWatch(file, onTrigger, live ? opts : { ...opts, fileWatch: false, pollMs: 3_600_000 });
    return {
      trigger: (src) => w.trigger(src),
      retarget: (f) => w.retarget(f),
      stop: () => { calls.stops += 1; return w.stop(); },
      stats: w.stats,
    };
  };
  return { fn, calls };
}

function rig(t, defaults = {}) {
  const ch = claudeHome(t, { root: tmpRoot() });
  const sid = crypto.randomUUID();
  const file = ch.transcript(sid);
  const mw = manualWatch(defaults.live ? { live: true } : {});
  const got = { recs: [], resets: [], errors: [], batches: 0 };
  const { live, ...base } = defaults;
  const make = (more = {}) => {
    const tl = createTailer({
      file,
      watchFile: mw.fn,
      onRecords: (rs) => { got.batches += 1; got.recs.push(...rs); },
      onReset: (info) => { got.resets.push(info); },
      onError: (e) => { got.errors.push(e); },
      ...base,
      ...more,
    });
    t.after(() => tl.stop());
    return tl;
  };
  return { ch, sid, file, mw, got, make };
}

// A seeded run of chain records with some uuid-less metadata between them, and
// non-ASCII text so a split can land inside a character.
function sampleRecords(seed = 1, n = 6) {
  const r = createRecords({ seed });
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(r.prompt(`prompt ${i}: naïve café — 日本語 🙂`));
    out.push(...r.assistant([`answer ${i} ✓`]));
    if (i % 2) out.push(r.mode('default'));
  }
  return out;
}

const lineOf = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
const linesOf = (recs) => recs.map(lineOf);
const textOf = (recs) => jsonl(recs);
const bytes = (s) => Buffer.byteLength(s, 'utf8');

function assertContiguous(recs, file) {
  const buf = fs.readFileSync(file);
  let at = recs.length ? recs[0].start : 0;
  for (const rec of recs) {
    assert.equal(rec.start, at, 'each record starts where the one before ended');
    assert.equal(buf[rec.end - 1], 0x0a, 'a record ends just past its newline');
    if (!rec.oversize) assert.equal(buf.toString('utf8', rec.start, rec.end - 1), rec.line);
    at = rec.end;
  }
}

// ── splitting ────────────────────────────────────────────────────────────────

test('appends in uneven chunks with a partial last line: each record once, only after its newline, offsets contiguous', async (t) => {
  const { file, got, make } = rig(t);
  const records = sampleRecords(3, 8);
  const text = textOf(records);
  // Uneven cuts, some inside a multibyte character.
  const mids = midCharOffsets(text);
  const splits = [...randomSplits(text, { seed: 9, count: 25 }), mids[3], mids[17], mids[40]];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  const tl = make({ chunkBytes: 97 });
  await tl.start();

  let written = 0;
  const all = Buffer.from(text);
  await appendChunkedAsync(file, text, {
    splits,
    between: async (_i, chunk) => {
      written += chunk.length;
      await tl.drain();
      const complete = all.subarray(0, written).toString('latin1').split('\n').length - 1;
      assert.equal(got.recs.length, complete, 'every complete line, and nothing past the last newline');
      for (const rec of got.recs) assert.ok(rec.end <= written);
    },
  });
  await tl.drain();
  assert.deepEqual(got.recs.map((x) => x.line), linesOf(records));
  assert.equal(got.recs[0].start, 0);
  assert.equal(got.recs.at(-1).end, all.length);
  assertContiguous(got.recs, file);
  for (const rec of got.recs) {
    assert.equal(rec.bad, false);
    assert.equal(rec.oversize, false);
    assert.ok(rec.obj && typeof rec.obj === 'object');
  }
  assert.ok(tl.stats.partialTails > 0, 'some pump ended inside a line');
  assert.equal(tl.stats.offset, all.length);

  // A trailing partial line waits for its newline.
  const tail = JSON.stringify({ type: 'mode', mode: 'plan' });
  fs.appendFileSync(file, tail.slice(0, 10));
  await tl.drain();
  assert.equal(got.recs.length, records.length);
  fs.appendFileSync(file, `${tail.slice(10)}\n`);
  await tl.drain();
  assert.equal(got.recs.length, records.length + 1);
  assert.equal(got.recs.at(-1).line, tail);
  assert.deepEqual(got.errors, []);
});

test('a line holding U+2028 and U+2029 is one record', async (t) => {
  const { ch, sid, got, make } = rig(t);
  const r = createRecords({ seed: 4 });
  const odd = r.prompt('before between after \r and a lone CR');
  const recs = [odd, ...r.assistant(['next'])];
  const text = textOf(recs);
  assert.ok(text.includes(' ') && text.includes(' '), 'JSON.stringify keeps both raw');
  ch.writeTranscript(sid, recs);
  const tl = make();
  await tl.start();
  assert.equal(got.recs.length, 2);
  assert.equal(got.recs[0].obj.message.content, odd.message.content);
  assert.equal(got.recs[0].line, JSON.stringify(odd));
});

test('an over-long line is one oversize record and the line after it is intact', async (t) => {
  for (const chunkBytes of [256 * 1024, 64]) {
    await t.test(`chunkBytes ${chunkBytes}`, async (st) => {
      const { ch, sid, file, got, make } = rig(st);
      const r = createRecords({ seed: 5 });
      const before = r.prompt('short');
      const big = r.prompt('x'.repeat(5000));
      const after = r.assistant(['still here'])[0];
      ch.writeTranscript(sid, [before, big, after]);
      const tl = make({ maxLineBytes: 1500, chunkBytes });
      await tl.start();
      assert.equal(got.recs.length, 3);
      const [a, o, b] = got.recs;
      assert.equal(a.line, JSON.stringify(before));
      assert.deepEqual({ line: o.line, obj: o.obj, bad: o.bad, oversize: o.oversize },
        { line: null, obj: null, bad: true, oversize: true });
      assert.equal(o.start, a.end);
      assert.equal(o.end, a.end + bytes(JSON.stringify(big)) + 1);
      assert.equal(b.line, JSON.stringify(after));
      assert.deepEqual(b.obj, after);
      assertContiguous(got.recs, file);
      assert.equal(tl.stats.oversize, 1);
      // The oversize line counts toward the anchor.
      assert.deepEqual(o.anchor, { uuid: before.uuid, after: 1 });
      assert.deepEqual(b.anchor, { uuid: after.uuid, after: 0 });
    });
  }
});

test('a malformed or non-object line is a bad record, never a throw; an empty line is skipped', async (t) => {
  const { ch, sid, got, make } = rig(t);
  const r = createRecords({ seed: 6 });
  const good = r.prompt('ok');
  ch.writeTranscript(sid, ['{"broken', '[1,2]', '', good]);
  const tl = make();
  await tl.start();
  assert.deepEqual(got.recs.map((x) => [x.bad, x.obj === null]), [[true, true], [true, true], [false, false]]);
  assert.equal(tl.stats.badLines, 2);
  assert.equal(tl.stats.emptyLines, 1);
  assert.deepEqual(got.recs[1].anchor, { uuid: null, after: 2 });
});

test('lineSplitter keeps the carry across pushes and skips an oversize line to its newline', () => {
  const sp = lineSplitter(5);
  assert.deepEqual(sp.push(Buffer.from('ab')), []);
  assert.equal(sp.readPos, 2);
  const out = sp.push(Buffer.from('c\n0123456789\nxy'));
  assert.deepEqual(out.map((l) => [l.buf && l.buf.toString(), l.start, l.end]), [['abc', 0, 4], [null, 4, 15]]);
  assert.equal(sp.at, 15);
  assert.equal(sp.carryLen, 2);
  assert.deepEqual(sp.push(Buffer.from('zzzzzz')), []);
  assert.equal(sp.readPos, 23, 'skipped bytes still move the read position');
  assert.deepEqual(sp.push(Buffer.from('\nok\n')).map((l) => [l.buf && l.buf.toString(), l.start, l.end]),
    [[null, 15, 24], ['ok', 24, 27]]);
});

// ── discontinuities ──────────────────────────────────────────────────────────

// A..C: chain records ending in uuid-less lines, so the anchor carries an
// `after` count and is checked by the last line's hash.
function anchoredSet(seed) {
  const r = createRecords({ seed });
  const head = [r.prompt('first'), ...r.assistant(['one']), r.mode('default'), r.mode('default')];
  const more = [r.prompt('second'), ...r.assistant(['two'])];
  return { r, head, more };
}

test('truncated: a rolled-back partial line resumes at the anchor; a cut to zero re-reads the new content', async (t) => {
  const { ch, sid, file, got, make } = rig(t);
  const { head, more } = anchoredSet(7);
  ch.writeTranscript(sid, head);
  fs.appendFileSync(file, '{"type":"assistant","partial');
  const tl = make();
  await tl.start();
  assert.equal(got.recs.length, head.length);
  const headLen = bytes(textOf(head));

  fs.truncateSync(file, headLen);
  await tl.drain();
  assert.deepEqual(got.resets.map(({ reason, anchoredAt, anchored }) => ({ reason, anchoredAt, anchored })),
    [{ reason: 'truncated', anchoredAt: headLen, anchored: true }]);
  fs.appendFileSync(file, textOf(more));
  await tl.drain();
  assert.deepEqual(got.recs.map((x) => x.line), linesOf([...head, ...more]), 'nothing handed over twice');
  assertContiguous(got.recs, file);

  // Cut to zero and write something else: the anchor is gone, read from 0.
  const fresh = createRecords({ seed: 70 });
  const other = [fresh.prompt('a new file'), ...fresh.assistant(['new'])];
  fs.truncateSync(file, 0);
  fs.appendFileSync(file, textOf(other));
  await tl.drain();
  assert.deepEqual(got.resets.at(-1).reason, 'truncated');
  assert.equal(got.resets.at(-1).anchored, false);
  assert.equal(got.resets.at(-1).anchoredAt, 0);
  assert.deepEqual(got.recs.slice(head.length + more.length).map((x) => x.line), linesOf(other));
  assert.equal(got.recs.at(-1).anchor.uuid, other.at(-1).uuid);
  assert.equal(tl.stats.resets.truncated, 2);
});

test('rewritten in place (head changed): the anchor search resumes after the last record handed over', async (t) => {
  const { ch, sid, file, got, make } = rig(t);
  const { r, head, more } = anchoredSet(8);
  ch.writeTranscript(sid, head);
  const tl = make();
  await tl.start();
  const inode = fs.statSync(file).ino;
  const prefix = [r.meta('custom-title', { title: 'renamed' })];
  fs.writeFileSync(file, textOf([...prefix, ...head, ...more])); // same inode, new head
  assert.equal(fs.statSync(file).ino, inode);
  await tl.drain();
  assert.deepEqual(got.resets.map((x) => [x.reason, x.anchoredAt, x.anchored]),
    [['rewritten', bytes(textOf([...prefix, ...head])), true]]);
  assert.deepEqual(got.recs.map((x) => x.line), linesOf([...head, ...more]));
});

test('replaced by rename: the old file is read to its end, then the new inode is anchored', async (t) => {
  const { ch, sid, file, got, make } = rig(t);
  const { head, more } = anchoredSet(9);
  ch.writeTranscript(sid, head.slice(0, 2));
  const tl = make();
  await tl.start();
  assert.equal(got.recs.length, 2);
  fs.appendFileSync(file, textOf(head.slice(2))); // lands on the old inode, unread
  fs.writeFileSync(`${file}.new`, textOf([...head, ...more]));
  fs.renameSync(`${file}.new`, file);
  await tl.drain();
  assert.deepEqual(got.resets.map((x) => [x.reason, x.anchoredAt, x.anchored]),
    [['replaced', bytes(textOf(head)), true]]);
  assert.deepEqual(got.recs.map((x) => x.line), linesOf([...head, ...more]));
  // Later appends follow the new inode.
  const extra = createRecords({ seed: 90 }).prompt('after the swap');
  fs.appendFileSync(file, textOf([extra]));
  await tl.drain();
  assert.equal(got.recs.at(-1).line, JSON.stringify(extra));
  assert.equal(got.recs.at(-1).start, bytes(textOf([...head, ...more])));
});

test('deleted then re-created: waits while gone, then anchors and hands over only the new records', async (t) => {
  const { ch, sid, file, got, make } = rig(t);
  const { head, more } = anchoredSet(10);
  ch.writeTranscript(sid, head);
  const tl = make();
  await tl.start();
  fs.unlinkSync(file);
  await tl.drain();
  assert.equal(tl.stats.waiting, true);
  assert.deepEqual(got.resets, [], 'the reset waits for content to search');
  fs.writeFileSync(file, textOf([...head, ...more]));
  await tl.drain();
  assert.equal(tl.stats.waiting, false);
  assert.deepEqual(got.resets.map((x) => [x.reason, x.anchoredAt, x.anchored]),
    [['deleted', bytes(textOf(head)), true]]);
  assert.deepEqual(got.recs.map((x) => x.line), linesOf([...head, ...more]));
});

test('the anchor works before the first uuid: a file that opens with uuid-less records', async (t) => {
  const { ch, sid, file, got, make } = rig(t);
  const r = createRecords({ seed: 11 });
  const meta = [r.permissionMode('default'), r.mode('default')];
  ch.writeTranscript(sid, meta);
  const tl = make();
  await tl.start();
  assert.deepEqual(got.recs.at(-1).anchor, { uuid: null, after: 2 });
  const next = r.prompt('hello');
  fs.writeFileSync(`${file}.new`, textOf([...meta, next]));
  fs.renameSync(`${file}.new`, file);
  await tl.drain();
  assert.deepEqual(got.resets.map((x) => [x.reason, x.anchoredAt]), [['replaced', bytes(textOf(meta))]]);
  assert.deepEqual(got.recs.map((x) => x.line), linesOf([...meta, next]));
});

test('a rewrite whose last uuid-less line differs fails the hash check and re-reads from 0', async (t) => {
  const { ch, sid, file, got, make } = rig(t);
  const r = createRecords({ seed: 12 });
  const first = r.prompt('p');
  ch.writeTranscript(sid, [first, r.mode('default')]);
  const tl = make();
  await tl.start();
  fs.writeFileSync(`${file}.new`, textOf([first, r.mode('plan'), r.prompt('q')]));
  fs.renameSync(`${file}.new`, file);
  await tl.drain();
  assert.deepEqual(got.resets.map((x) => [x.reason, x.anchored, x.anchoredAt]), [['replaced', false, 0]]);
  assert.equal(got.recs.length, 2 + 3);
});

// ── resume ───────────────────────────────────────────────────────────────────

test('resume: honoured when valid, nothing before the offset is read, and a restart drops and duplicates nothing', async (t) => {
  const { ch, sid, file, make } = rig(t);
  const records = sampleRecords(13, 6);
  const cut = 7; // a turn boundary somewhere in the middle
  ch.writeTranscript(sid, records.slice(0, 10));

  const first = [];
  const t1 = make({ onRecords: (rs) => { first.push(...rs); } });
  await t1.start();
  assert.equal(first.length, 10);
  const stored = JSON.parse(JSON.stringify(t1.resumeAt(first[cut - 1]))); // as the index would keep it
  await t1.stop();

  ch.appendTranscript(sid, records.slice(10));
  const second = [];
  const resets = [];
  const t2 = make({ resume: stored, onRecords: (rs) => { second.push(...rs); }, onReset: (i) => { resets.push(i); } });
  await t2.start();
  assert.deepEqual(resets, []);
  assert.equal(t2.stats.resumed, 'offset');
  assert.equal(second[0].start, stored.offset);
  assert.equal(t2.stats.bytes, fs.statSync(file).size - stored.offset, 'nothing before the offset was read');
  assert.deepEqual([...first.slice(0, cut), ...second].map((x) => x.line), linesOf(records));
  assertContiguous([...first.slice(0, cut), ...second], file);
  // The anchor carried on from the resume.
  assert.equal(records.at(-1).uuid, undefined, 'the run ends on a uuid-less record');
  assert.deepEqual(second.at(-1).anchor, { uuid: records.at(-2).uuid, after: 1 });
});

test('resume: the stored anchor finds its place in a file rewritten while the daemon was down', async (t) => {
  const { ch, sid, file, make } = rig(t);
  const { head, more } = anchoredSet(14);
  ch.writeTranscript(sid, head);
  const first = [];
  const t1 = make({ onRecords: (rs) => { first.push(...rs); } });
  await t1.start();
  const stored = t1.resumeAt(first.at(-1));
  await t1.stop();
  fs.writeFileSync(`${file}.new`, textOf([...head, ...more])); // a rewrite-by-copy: a new inode
  fs.renameSync(`${file}.new`, file);

  const second = [];
  const resets = [];
  const t2 = make({ resume: stored, onRecords: (rs) => { second.push(...rs); }, onReset: (i) => { resets.push(i); } });
  await t2.start();
  // A new inode is a mismatch: re-read from 0 (the consumer's ids repeat).
  assert.deepEqual(resets.map((x) => [x.reason, x.anchoredAt]), [['resume-mismatch', 0]]);
  assert.equal(second.length, head.length + more.length);
  // A later swap anchors on what this tailer handed over.
  const extra = createRecords({ seed: 140 }).prompt('later');
  fs.writeFileSync(`${file}.new`, textOf([...head, ...more, extra]));
  fs.renameSync(`${file}.new`, file);
  await t2.drain();
  assert.deepEqual(resets.at(-1).reason, 'replaced');
  assert.equal(resets.at(-1).anchored, true);
  assert.equal(second.at(-1).line, JSON.stringify(extra));
  assert.equal(second.length, head.length + more.length + 1);
});

test('resume: each mismatch re-reads from 0 after onReset(resume-mismatch)', async (t) => {
  const { ch, sid, file, make } = rig(t);
  const records = sampleRecords(15, 4);
  ch.writeTranscript(sid, records);
  const first = [];
  const t1 = make({ onRecords: (rs) => { first.push(...rs); } });
  await t1.start();
  const good = t1.resumeAt(first[3]);
  await t1.stop();
  const size = fs.statSync(file).size;
  assert.ok(good.headLen === HEAD_BYTES && good.offset > 0);

  const cases = {
    inode: { ...good, ino: good.ino + 1 },
    'size below the offset': { ...good, offset: size + 10 },
    'head hash': { ...good, headHash: crypto.createHash('sha256').update('other').digest('hex') },
    'byte before the offset is not a newline': { ...good, offset: good.offset - 1 },
    'not a resume at all': { offset: 'twelve' },
  };
  for (const [name, resume] of Object.entries(cases)) {
    const seen = [];
    const resets = [];
    const tl = make({ resume, onRecords: (rs) => { seen.push(...rs); }, onReset: (i) => { resets.push(i); } });
    await tl.start();
    assert.deepEqual(resets.map((x) => [x.reason, x.anchoredAt, x.anchored]), [['resume-mismatch', 0, false]], name);
    assert.equal(tl.stats.resumed, 'mismatch', name);
    assert.equal(seen[0].start, 0, name);
    assert.deepEqual(seen.map((x) => x.line), linesOf(records), name);
    assert.equal(seen[0].anchor.uuid, records[0].uuid, `${name}: the stored anchor was dropped`);
    await tl.stop();
  }
});

test('resumeAt(rec) round-trips into a valid resume, and is null for a record it did not hand over', async (t) => {
  const { ch, sid, file, make } = rig(t);
  const r = createRecords({ seed: 16 });
  const records = [r.prompt('a'), ...r.assistant(['b']), r.mode('default'), r.prompt('c')];
  ch.writeTranscript(sid, records);
  const seen = [];
  const t1 = make({ onRecords: (rs) => { seen.push(...rs); } });
  await t1.start();
  const st = fs.statSync(file);
  const at = t1.resumeAt(seen[2]); // the uuid-less mode record
  assert.deepEqual(Object.keys(at).sort(),
    ['afterUuid', 'dev', 'headHash', 'headLen', 'ino', 'lastLineHash', 'lastUuid', 'offset']);
  assert.equal(at.dev, st.dev);
  assert.equal(at.ino, st.ino);
  assert.equal(at.offset, seen[2].end);
  assert.equal(at.lastUuid, records[1].uuid);
  assert.equal(at.afterUuid, 1);
  assert.equal(at.lastLineHash, crypto.createHash('sha256').update(seen[2].line).digest('hex'));
  assert.equal(at.headLen, HEAD_BYTES);
  assert.equal(t1.resumeAt({ ...seen[2] }), null, 'a copy is not a record this tailer handed over');
  assert.equal(t1.resumeAt(null), null);
  // A consumer that dropped rec.line still gets a resume (the hash check is then skipped).
  delete seen[3].line;
  assert.equal(t1.resumeAt(seen[3]).lastLineHash, null);
  await t1.stop();

  const again = [];
  const t2 = make({ resume: JSON.parse(JSON.stringify(at)), onRecords: (rs) => { again.push(...rs); } });
  await t2.start();
  assert.equal(t2.stats.resumed, 'offset');
  assert.deepEqual(again.map((x) => x.line), [JSON.stringify(records[3])]);
});

// ── opening ──────────────────────────────────────────────────────────────────

test('a file absent at start is read once it appears; one that never appears leaves waiting set and stop() resolves', async (t) => {
  const { ch, sid, got, make } = rig(t);
  const tl = make();
  await tl.start();
  assert.equal(tl.stats.waiting, true);
  assert.equal(tl.stats.opens, 0);
  const recs = sampleRecords(17, 2);
  ch.writeTranscript(sid, recs);
  await tl.drain();
  assert.equal(tl.stats.waiting, false);
  assert.deepEqual(got.recs.map((x) => x.line), linesOf(recs));
  assert.deepEqual(got.resets, []);

  const never = rig(t);
  const t2 = never.make();
  await t2.start();
  await t2.drain();
  assert.equal(t2.stats.waiting, true);
  await t2.stop();
  assert.equal(never.mw.calls.stops, 1);
  assert.deepEqual(never.got.errors, []);
});

test('a file that appears later is found by the poll alone', async (t) => {
  const { ch, sid, got, make, mw } = rig(t, { live: true });
  const tl = make({ pollMs: 30 });
  await tl.start();
  assert.equal(tl.stats.waiting, true);
  const recs = sampleRecords(18, 2);
  ch.writeTranscript(sid, recs);
  await waitUntil(() => got.recs.length === recs.length, { timeout: 10_000, what: 'the late file' });
  assert.equal(mw.calls.made[0].opts.pollMs, 30);
});

test('a symlink at the transcript path is refused by the O_NOFOLLOW open', async (t) => {
  const { ch, file, got, make } = rig(t);
  const real = ch.write('elsewhere/real.jsonl', textOf(sampleRecords(19, 1)));
  fs.symlinkSync(real, file);
  t.after(() => fs.rmSync(file, { force: true }));
  const tl = make();
  await tl.start();
  await tl.drain();
  assert.deepEqual(got.recs, []);
  assert.equal(got.errors.length, 1, 'one error per refused file, not one per poll');
  assert.equal(got.errors[0].code, 'WC_TAIL_REFUSED');
  assert.equal(got.errors[0].reason, 'symlink');
  assert.equal(tl.stats.refused, 1);
  assert.equal(tl.stats.opens, 0);

  // Replaced by a regular file, it is read.
  fs.rmSync(file);
  fs.writeFileSync(file, textOf(sampleRecords(19, 1)));
  await tl.drain();
  assert.equal(got.recs.length, 2);
});

test('the fence runs when the file appears and after each replacement; null stops the read', async (t) => {
  const { ch, sid, file, got, make } = rig(t);
  const asked = [];
  let allow = false;
  const tl = make({ fence: (p) => { asked.push(p); return allow ? transcriptFile(p) : null; } });
  await tl.start();
  assert.deepEqual(asked, [], 'no file yet: nothing to fence');
  const recs = sampleRecords(20, 2);
  ch.writeTranscript(sid, recs);
  await tl.drain();
  await tl.drain();
  assert.deepEqual(asked, [file, file]);
  assert.equal(tl.stats.opens, 0);
  assert.deepEqual(got.recs, []);
  assert.equal(got.errors.length, 1);
  assert.equal(got.errors[0].reason, 'fence');

  allow = true;
  await tl.drain();
  assert.equal(got.recs.length, recs.length);
  const before = asked.length;
  await tl.drain();
  assert.equal(asked.length, before, 'an open file is not fenced again');

  fs.writeFileSync(`${file}.new`, textOf(recs));
  fs.renameSync(`${file}.new`, file);
  await tl.drain();
  assert.equal(asked.length, before + 1, 'fenced again after the replacement');
});

test('the real fence passes a transcript and refuses the path once it names something else', async (t) => {
  const { ch, sid, file, got, make } = rig(t);
  const recs = sampleRecords(21, 1);
  ch.writeTranscript(sid, recs);
  const tl = make({ fence: transcriptFile });
  await tl.start();
  assert.equal(got.recs.length, recs.length);
  // A symlink renamed over the transcript: the fence refuses it before any open.
  const elsewhere = ch.write('elsewhere/other.jsonl', textOf(sampleRecords(210, 1)));
  fs.symlinkSync(elsewhere, `${file}.link`);
  fs.renameSync(`${file}.link`, file);
  await tl.drain();
  assert.equal(got.recs.length, recs.length, 'nothing read through the link');
  assert.deepEqual(got.errors.map((e) => [e.code, e.reason]), [['WC_TAIL_REFUSED', 'fence']]);
});

// ── soak ─────────────────────────────────────────────────────────────────────
//
// The validation's harness, in-process and seeded: a writer appends real-shaped
// records in random byte-sized pieces (mid-line, mid-character) while the
// consumer restarts the tailer from a stored turn boundary (resumeAt), and the
// file is copied over itself, live and while the tailer is down. The consumer
// keeps what its index would: everything up to the boundary it stored, and on a
// reset that found no anchor, nothing (the tailer re-reads from 0). At the end
// it holds every line exactly once, in order.

test('soak: random pieces, restarts from a stored boundary, rewrites by copy: nothing dropped or duplicated', async (t) => {
  const resumed = { offset: 0, mismatch: 0 };
  const seeds = process.env.WEB_CHAT_SOAK_SEEDS ? Number(process.env.WEB_CHAT_SOAK_SEEDS) : 3;
  for (let seed = 1; seed <= seeds; seed++) {
    const { ch, sid, file, make } = rig(t);
    const rand = mulberry32(seed);
    const records = sampleRecords(100 + seed, 30);
    const text = textOf(records);
    const pieces = chunksOf(text, randomSplits(text, { seed, count: 80 }));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    const kept = [];
    const resumes = []; // what the index would store beside each record: resumeAt, taken when it arrives
    const copyOver = () => {
      fs.copyFileSync(file, `${file}.copy`);
      fs.renameSync(`${file}.copy`, file);
    };
    const open = async (resume) => {
      const tl = make({
        resume,
        chunkBytes: 1 + Math.floor(rand() * 300),
        onRecords: (rs) => {
          for (const r of rs) {
            kept.push(r);
            resumes.push(JSON.parse(JSON.stringify(tl.resumeAt(r))));
          }
        },
        onReset: (info) => { if (!info.anchored) { kept.length = 0; resumes.length = 0; } },
      });
      await tl.start();
      return tl;
    };
    let tl = await open(null);
    let restarts = 0;
    for (const piece of pieces) {
      fs.appendFileSync(file, piece);
      const roll = rand();
      if (roll < 0.4) await tl.drain();
      else if (roll < 0.5) copyOver();
      else if (roll < 0.6 && kept.length) {
        await tl.drain();
        const k = Math.floor(rand() * kept.length);
        const stored = resumes[k];
        kept.length = k + 1;
        resumes.length = k + 1;
        await tl.stop();
        if (rand() < 0.3) copyOver(); // rewritten while down: the resume no longer matches
        tl = await open(stored);
        resumed[tl.stats.resumed] += 1;
        restarts += 1;
      }
    }
    await tl.drain();
    assert.deepEqual(kept.map((x) => x.line), linesOf(records), `seed ${seed}`);
    assertContiguous(kept, file);
    assert.ok(restarts > 0, `seed ${seed} restarted`);
    await tl.stop();
  }
  assert.ok(resumed.offset > 0 && resumed.mismatch > 0, `both kinds of restart: ${JSON.stringify(resumed)}`);
});

// ── draining and stopping ────────────────────────────────────────────────────

test('drain() resolves only after every record up to EOF was delivered', async (t) => {
  const { ch, sid, file, make } = rig(t);
  const delivered = [];
  let inFlight = 0;
  let overlapped = false;
  const tl = make({
    chunkBytes: 128,
    onRecords: async (rs) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 2));
      delivered.push(...rs);
      inFlight -= 1;
    },
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  await tl.start();
  const recs = sampleRecords(22, 12);
  ch.appendTranscript(sid, recs);
  await tl.drain();
  assert.equal(delivered.length, recs.length);
  assert.equal(delivered.at(-1).end, fs.statSync(file).size);
  assert.equal(overlapped, false, 'one onRecords at a time');
  assert.ok(tl.stats.reads > 5, 'read in many chunks');
});

test('a throwing callback reaches onError and the tailer carries on', async (t) => {
  const { ch, sid, got, make } = rig(t);
  let n = 0;
  const tl = make({ onRecords: () => { n += 1; throw new Error('consumer bug'); } });
  ch.writeTranscript(sid, sampleRecords(23, 1));
  await tl.start();
  ch.appendTranscript(sid, sampleRecords(24, 1));
  await tl.drain();
  assert.equal(n, 2);
  assert.deepEqual(got.errors.map((e) => e.message), ['consumer bug', 'consumer bug']);
  assert.equal(tl.stats.errors, 2);
});

test('live appends arrive through lib/core/watch, with no directory watch', async (t) => {
  const { ch, sid, got, make, mw } = rig(t, { live: true });
  const first = sampleRecords(25, 1);
  const then = sampleRecords(26, 2);
  ch.writeTranscript(sid, first);
  const tl = make({ pollMs: 50 });
  await tl.start();
  assert.equal(got.recs.length, first.length);
  ch.appendTranscript(sid, then);
  await waitUntil(() => got.recs.length === first.length + then.length, { timeout: 10_000, what: 'the live append' });
  assert.deepEqual(got.recs.map((x) => x.line), linesOf([...first, ...then]));
  assert.equal(mw.calls.made.length, 1);
  assert.equal(mw.calls.made[0].opts.dirWatch, false);
  assert.equal(mw.calls.made[0].opts.persistent, true);
});

function resources(types) {
  const counts = Object.fromEntries(types.map((k) => [k, 0]));
  for (const k of process.getActiveResourcesInfo()) if (k in counts) counts[k] += 1;
  return counts;
}

function openFds() {
  try { return fs.readdirSync('/dev/fd').length; } catch { return null; }
}

test('stop() is idempotent, closes the file and the watch, and leaves no handle', async (t) => {
  const { ch, sid, got, make, mw } = rig(t, { live: true });
  const TYPES = ['FSEventWrap', 'Timeout', 'Immediate', 'StatWatcher'];
  const recs = sampleRecords(27, 2);
  ch.writeTranscript(sid, recs);
  const before = resources(TYPES);
  const fdsBefore = openFds();
  const tl = make({ pollMs: 40 });
  await tl.start();
  assert.equal(got.recs.length, recs.length);
  // The transcript, and on kqueue the file watch's own descriptor.
  if (fdsBefore !== null) assert.ok(openFds() > fdsBefore, 'the transcript is open');
  const during = resources(TYPES);
  assert.ok(during.Timeout > before.Timeout, 'the poll is running');

  const a = tl.stop();
  const b = tl.stop();
  assert.equal(a, b, 'one stop');
  await a;
  await tl.stop();
  assert.equal(mw.calls.stops, 1, 'the watch was stopped once');
  if (fdsBefore !== null) assert.equal(openFds(), fdsBefore, 'the transcript is closed');
  // A closed handle leaves the list a loop turn later; an earlier test's may
  // still be leaving it at `before`, so the check is "no more than before".
  const settled = await waitUntil(() => TYPES.every((k) => resources(TYPES)[k] <= before[k]), { timeout: 5000 });
  assert.ok(settled, `handles left: ${JSON.stringify(resources(TYPES))} against ${JSON.stringify(before)}`);

  // Nothing is handed over, and drain() returns at once, after stop().
  ch.appendTranscript(sid, sampleRecords(28, 1));
  await tl.drain();
  assert.equal(got.recs.length, recs.length);
});

test('stop() during a long catch-up returns without handing anything more over', async (t) => {
  const { ch, sid, make } = rig(t);
  ch.writeTranscript(sid, sampleRecords(29, 40));
  let batches = 0;
  let tl = null;
  tl = make({
    chunkBytes: 64,
    onRecords: () => { batches += 1; if (batches === 3) tl.stop(); },
  });
  await tl.start();
  await tl.stop();
  assert.equal(batches, 3);
});

test('stop() before start() resolves, and start() after it does nothing', async (t) => {
  const { make, mw } = rig(t);
  const tl = make();
  await tl.stop();
  await tl.start();
  await tl.drain();
  assert.equal(mw.calls.made.length, 0);
});

test('the tailer takes its triggers only from lib/core/watch', () => {
  const src = fs.readFileSync(TAIL_SRC, 'utf8');
  assert.equal(/\bfs\.watch/.test(src), false);
  assert.equal(/readline/.test(src), false);
  assert.equal(/require\(['"](?:node:)?events['"]\)/.test(src), false);
  assert.match(src, /require\('\.\.\/\.\.\/core\/watch'\)/);
});

test('option checks', () => {
  assert.throws(() => createTailer({}), TypeError);
  assert.throws(() => createTailer({ file: '/x.jsonl', chunkBytes: 0 }), RangeError);
  assert.throws(() => createTailer({ file: '/x.jsonl', maxLineBytes: 1.5 }), RangeError);
  assert.throws(() => createTailer({ file: '/x.jsonl', fence: 'no' }), TypeError);
});
