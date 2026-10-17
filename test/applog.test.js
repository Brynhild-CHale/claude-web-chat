// The append-only log engine: lib/core/applog.js (PLAN.md 1A.1, GT-10).
//
// The engine's own contracts: one write per record on one append-mode fd, the
// lazy epoch, the torn tail set aside byte for byte, a bad line skipped, the
// one-writer guard and the dry run that predicts a real run's bytes. The crash
// case (C-2) runs test-support/applog-child.js and SIGKILLs it mid-stream.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');

const { openLog } = require('../lib/core/applog');

const CHILD = path.join(__dirname, '..', 'test-support', 'applog-child.js');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-applog-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// A small seeded PRNG (mulberry32), so a failing cut or kill point reproduces.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// An fs that counts the calls the one-write rule is about and passes everything
// through to the real one.
function spyFs() {
  const calls = { open: [], write: [], fsync: 0 };
  const spy = Object.create(fs);
  spy.openSync = (...args) => { const fd = fs.openSync(...args); calls.open.push({ args, fd }); return fd; };
  spy.writeSync = (fd, ...rest) => { calls.write.push(fd); return fs.writeSync(fd, ...rest); };
  spy.fsyncSync = (fd) => { calls.fsync++; return fs.fsyncSync(fd); };
  return { spy, calls };
}

function readAll(file, opts = {}) {
  const recs = [];
  const metas = [];
  const log = openLog(file, { dryRun: true, ...opts });
  const st = log.load({ onRecord: (rec, meta) => { recs.push(rec); metas.push(meta); } });
  log.close();
  return { recs, metas, st };
}

const fixedClock = (ms = 1760000000000) => () => ms;

// ── round trip ────────────────────────────────────────────────────────────

test('round trip: 200 appends come back in order behind one epoch record', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'log', 'elements.jsonl');
  const log = openLog(file, { bootId: 'boot-a' });
  assert.equal(log.load().complete, 0, 'an absent file loads empty');
  const written = [];
  const offsets = [];
  for (let i = 0; i < 200; i++) {
    const rec = { t: 'x', i, text: `line ${i}\nwith a newline and "quotes"` };
    written.push(rec);
    offsets.push(log.append(rec).offset);
  }
  const st = log.stats();
  assert.equal(st.appended_records, 201, 'the epoch counts as an appended record');
  assert.equal(st.appended_bytes, fs.statSync(file).size);
  log.close();

  const { recs, metas, st: st2 } = readAll(file);
  assert.equal(st2.complete, 201);
  assert.equal(st2.bad, 0);
  assert.equal(st2.torn, null);
  assert.equal(st2.lines, 201);
  assert.equal(recs[0].t, 'epoch');
  assert.equal(recs[0].boot, 'boot-a');
  assert.equal(recs[0].pid, process.pid);
  assert.deepEqual(recs.slice(1), written);
  assert.deepEqual(metas.map((m) => m.index), recs.map((_, i) => i));
  assert.equal(metas[0].offset, 0);
  assert.deepEqual(metas.slice(1).map((m) => m.offset), offsets, 'append returns the offset load reports');
});

// ── one write per record ──────────────────────────────────────────────────

test('one write per record, on one fd opened once in append mode with mode 0o600', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'new', 'deeper', 'a.jsonl');
  const { spy, calls } = spyFs();
  const log = openLog(file, { fs: spy });
  log.load();
  assert.equal(calls.open.length, 0, 'load opens no write fd');
  log.append({ t: 'x', i: 0 });
  assert.equal(calls.write.length, 2, 'the first append of an open is two writes: the epoch, then the record');
  for (let i = 1; i <= 10; i++) {
    log.append({ t: 'x', i });
    assert.equal(calls.write.length, 2 + i, 'each later append is exactly one writeSync');
  }
  assert.equal(calls.open.length, 1, 'the fd is opened once');
  assert.deepEqual(calls.open[0].args, [file, 'a', 0o600]);
  assert.ok(calls.write.every((fd) => fd === calls.open[0].fd), 'every write goes to that fd');
  assert.equal(calls.fsync, 0, 'no fsync by default');
  log.close();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'a new log is owner-only');
});

test('fsync: true calls fsyncSync once per write; false never calls it', (t) => {
  const dir = tmpDir(t);
  const a = spyFs();
  const on = openLog(path.join(dir, 'on.jsonl'), { fs: a.spy, fsync: true });
  on.load();
  for (let i = 0; i < 5; i++) on.append({ t: 'x', i });
  on.close();
  assert.equal(a.calls.fsync, a.calls.write.length, 'one fsync per write (the epoch included)');
  assert.equal(a.calls.fsync, 6);

  const b = spyFs();
  const off = openLog(path.join(dir, 'off.jsonl'), { fs: b.spy, fsync: false });
  off.load();
  for (let i = 0; i < 5; i++) off.append({ t: 'x', i });
  off.close();
  assert.equal(b.calls.fsync, 0);
});

test('a short write throws ESHORTWRITE, refuses later appends, and the next load sets the tail aside', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 's.jsonl');
  const first = openLog(file, { epoch: false });
  first.load();
  first.append({ t: 'x', i: 0 });
  first.close();

  const spy = Object.create(fs);
  // Short by 5 bytes ONCE: a later append would then write whole, so only the
  // open's own refusal keeps it from being glued onto the partial line.
  let shorts = 0;
  spy.writeSync = (fd, buf, off, len) => fs.writeSync(fd, buf, off, shorts++ === 0 ? len - 5 : len);
  const log = openLog(file, { fs: spy, epoch: false });
  log.load();
  assert.throws(() => log.append({ t: 'x', i: 1 }), { code: 'ESHORTWRITE' });
  assert.throws(() => log.append({ t: 'x', i: 2 }), { code: 'ESHORTWRITE' }, 'a record must not be glued onto the partial line');
  log.close();

  const again = openLog(file, { epoch: false });
  const st = again.load();
  assert.equal(st.complete, 1);
  assert.ok(st.torn && st.torn.bytes > 0);
  again.append({ t: 'x', i: 1 });
  again.close();
  assert.deepEqual(readAll(file).recs.map((r) => r.i), [0, 1]);
});

// ── the lazy epoch ────────────────────────────────────────────────────────

test('the lazy epoch: a load-only open appends 0 bytes; each open writes its own; epoch: false writes none', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'e.jsonl');
  const one = openLog(file, { bootId: 'b1', now: fixedClock(1) });
  one.load();
  one.append({ t: 'x', i: 0 });
  one.close();
  const size = fs.statSync(file).size;

  const idle = openLog(file, { bootId: 'idle' });
  idle.load();
  assert.equal(idle.stats().epoch_written, false);
  idle.close();
  assert.equal(fs.statSync(file).size, size, 'an open that only loads appends nothing');

  const two = openLog(file, { bootId: 'b2', now: fixedClock(2) });
  two.load();
  two.append({ t: 'x', i: 1 });
  two.append({ t: 'x', i: 2 });
  two.close();

  const none = openLog(file, { epoch: false });
  none.load();
  none.append({ t: 'x', i: 3 });
  none.close();

  const { recs } = readAll(file);
  assert.deepEqual(recs.map((r) => (r.t === 'epoch' ? `epoch:${r.boot}@${r.at}` : r.i)),
    ['epoch:b1@1', 0, 'epoch:b2@2', 1, 2, 3]);
});

test('bootId defaults to <pid>:<now()>', (t) => {
  const dir = tmpDir(t);
  const log = openLog(path.join(dir, 'b.jsonl'), { now: fixedClock(42) });
  assert.equal(log.bootId, `${process.pid}:42`);
  log.close();
});

// ── torn tail and bad lines ───────────────────────────────────────────────

function writeRecords(file, n) {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(JSON.stringify({ t: 'x', i }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

test('a torn tail is moved aside byte for byte and the log truncated to its last newline', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 't.jsonl');
  writeRecords(file, 10);
  const clean = fs.readFileSync(file);
  const tail = Buffer.from('{"t":"x","i":');
  fs.writeFileSync(file, Buffer.concat([clean, tail]));

  const recs = [];
  const log = openLog(file, { now: fixedClock(1700000000123), epoch: false });
  const st = log.load({ onRecord: (r) => recs.push(r) });
  assert.equal(recs.length, 10);
  assert.equal(st.complete, 10);
  assert.equal(st.bad, 0);
  assert.equal(st.bytes_at_load, clean.length + tail.length);
  assert.deepEqual(st.torn, { bytes: tail.length, aside: 't.jsonl.torn-1700000000123' });
  assert.deepEqual(fs.readFileSync(path.join(dir, st.torn.aside)), tail, 'the aside holds exactly the torn bytes');
  assert.deepEqual(fs.readFileSync(file), clean, 'the log is truncated to its last newline');
  log.append({ t: 'x', i: 10 });
  log.close();

  const after = readAll(file);
  assert.equal(after.st.complete, 11);
  assert.equal(after.st.torn, null);
  assert.equal(after.recs[10].i, 10, 'the next append parses');
});

test('two torn tails in one millisecond keep both asides (the renameAside suffix)', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'm.jsonl');
  for (const garbage of ['{"a', '{"b']) {
    fs.writeFileSync(file, `{"t":"x"}\n${garbage}`);
    const log = openLog(file, { now: fixedClock(5) });
    log.load();
    log.close();
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['m.jsonl', 'm.jsonl.torn-5', 'm.jsonl.torn-5-1']);
  assert.equal(fs.readFileSync(path.join(dir, 'm.jsonl.torn-5'), 'utf8'), '{"a');
  assert.equal(fs.readFileSync(path.join(dir, 'm.jsonl.torn-5-1'), 'utf8'), '{"b');
});

test('dryRun load reports the torn tail and moves nothing', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'd.jsonl');
  writeRecords(file, 3);
  fs.appendFileSync(file, '{"t":');
  const before = fs.readFileSync(file);
  const listing = fs.readdirSync(dir);
  const log = openLog(file, { dryRun: true });
  const st = log.load();
  log.close();
  assert.equal(st.complete, 3);
  assert.deepEqual(st.torn, { bytes: 5, aside: null });
  assert.deepEqual(fs.readFileSync(file), before, 'the file bytes are unchanged');
  assert.deepEqual(fs.readdirSync(dir), listing, 'no aside is written');
});

test('a bad complete line is counted with its byte offset and skipped; the records around it are kept', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'bad.jsonl');
  const a = JSON.stringify({ t: 'x', i: 0 });
  const b = JSON.stringify({ t: 'x', i: 1, s: 'é' });
  const c = JSON.stringify({ t: 'x', i: 2 });
  const bad = '{"t":"x", oops';
  fs.writeFileSync(file, `${a}\n${b}\n${bad}\n${c}\n`);
  const { recs, metas, st } = readAll(file);
  assert.deepEqual(recs.map((r) => r.i), [0, 1, 2]);
  assert.equal(st.bad, 1);
  assert.deepEqual(st.bad_offsets, [Buffer.byteLength(`${a}\n${b}\n`)], 'a BYTE offset (é is two bytes)');
  assert.equal(st.complete, 3);
  assert.equal(st.lines, 4);
  assert.equal(metas[2].offset, Buffer.byteLength(`${a}\n${b}\n${bad}\n`));
  assert.deepEqual(metas.map((m) => m.index), [0, 1, 2]);
});

test('a line that parses but is not a record (no string t, not an object) is bad; a blank line is skipped', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'shape.jsonl');
  fs.writeFileSync(file, '{"t":"x"}\n42\n[1]\nnull\n{"t":3}\n\n{"t":"y"}\n');
  const { recs, st } = readAll(file);
  assert.deepEqual(recs.map((r) => r.t), ['x', 'y']);
  assert.equal(st.bad, 4);
  assert.equal(st.lines, 7);
});

test('only the first 20 bad offsets are kept; every bad line is counted', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'many.jsonl');
  fs.writeFileSync(file, 'x\n'.repeat(30));
  const { st } = readAll(file);
  assert.equal(st.bad, 30);
  assert.deepEqual(st.bad_offsets, Array.from({ length: 20 }, (_, i) => i * 2));
});

// ── byte cuts ────────────────────────────────────────────────────────────

test('byte cuts: 10 seeded truncations of a 500-record log recover exactly the complete lines', (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src.jsonl');
  const w = openLog(src, { bootId: 'cut', now: fixedClock(9) });
  w.load();
  for (let i = 0; i < 500; i++) w.append({ t: 'x', i, pad: 'q'.repeat(i % 37) });
  w.close();
  const bytes = fs.readFileSync(src);
  const full = readAll(src).recs;
  assert.equal(full.length, 501);

  const rand = rng(0xc075);
  for (let k = 0; k < 10; k++) {
    const cut = 1 + Math.floor(rand() * (bytes.length - 1));
    const file = path.join(dir, `cut-${k}.jsonl`);
    fs.writeFileSync(file, bytes.subarray(0, cut));
    const bodyLen = bytes.lastIndexOf(0x0a, cut - 1) + 1;
    const complete = bytes.subarray(0, bodyLen).toString('utf8').split('\n').length - 1;
    const expect = full.slice(0, complete);

    const recs = [];
    const log = openLog(file, { now: fixedClock(100 + k) });
    const st = log.load({ onRecord: (r) => recs.push(r) });
    log.close();
    assert.deepEqual(recs, expect, `cut at ${cut}: the complete lines before it`);
    assert.equal(st.bad, 0);
    assert.equal(fs.statSync(file).size, bodyLen, `cut at ${cut}: truncated to the last newline`);
    if (bodyLen === cut) {
      assert.equal(st.torn, null);
    } else {
      assert.equal(st.torn.bytes, cut - bodyLen);
      assert.deepEqual(fs.readFileSync(path.join(dir, st.torn.aside)), bytes.subarray(bodyLen, cut), `cut at ${cut}: the remainder is set aside`);
    }
  }
});

// ── guards ────────────────────────────────────────────────────────────────

test('guards: append before load, a record without a string t, a second load', (t) => {
  const dir = tmpDir(t);
  const log = openLog(path.join(dir, 'g.jsonl'));
  assert.throws(() => log.append({ t: 'x' }), { code: 'ENOTLOADED' });
  log.load();
  for (const bad of [{}, { t: 1 }, null, 'x', ['x'], { t: null }]) {
    assert.throws(() => log.append(bad), TypeError, `refuses ${JSON.stringify(bad)}`);
  }
  assert.throws(() => log.load(), { code: 'ELOADED' });
  const cyc = { t: 'x' };
  cyc.self = cyc;
  assert.throws(() => log.append(cyc), TypeError, 'an unserialisable record throws');
  assert.equal(log.stats().epoch_written, false, '... before the epoch is written');
  assert.ok(!fs.existsSync(path.join(dir, 'g.jsonl')), 'nothing was written');
  log.close();
  assert.throws(() => log.append({ t: 'x' }), { code: 'ECLOSED' });
});

test('one writer: a second open of an open path throws ELOGOPEN until close(), whatever its spelling', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'w.jsonl');
  const a = openLog(file);
  assert.throws(() => openLog(file), { code: 'ELOGOPEN' });
  assert.throws(() => openLog(path.join(dir, '.', 'w.jsonl')), { code: 'ELOGOPEN' });
  const link = path.join(dir, 'link');
  fs.symlinkSync(dir, link);
  assert.throws(() => openLog(path.join(link, 'w.jsonl')), { code: 'ELOGOPEN' }, 'a symlinked spelling names the same log');
  a.close();
  a.close(); // idempotent
  const b = openLog(file);
  b.load();
  b.append({ t: 'x' });
  b.close();
  const c = openLog(path.join(link, 'w.jsonl'));
  c.close();
});

test('one writer: a dry run does not take the path, so a real open beside it succeeds', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'p.jsonl');
  const dry = openLog(file, { dryRun: true });
  dry.load();
  dry.append({ t: 'x' });
  const real = openLog(file);
  real.load();
  real.append({ t: 'x' });
  const dry2 = openLog(file, { dryRun: true });
  dry2.close();
  real.close();
  dry.close();
});

// ── dry run ───────────────────────────────────────────────────────────────

test('dryRun: no file and no directory is created; pending_bytes predicts a real run exactly', (t) => {
  const dir = tmpDir(t);
  const missingDir = path.join(dir, 'not', 'yet');
  const recs = Array.from({ length: 25 }, (_, i) => ({ t: i % 2 ? 'ver' : 'el', id: `e${i}`, text: 'ü'.repeat(i) }));
  let tick = 0;
  const clock = () => 1760000000000 + (tick++);

  tick = 0;
  const dry = openLog(path.join(missingDir, 'log.jsonl'), { dryRun: true, bootId: 'same', now: clock });
  dry.load();
  const dryOffsets = recs.map((r) => dry.append(r));
  const dst = dry.stats();
  dry.close();
  assert.ok(!fs.existsSync(missingDir), 'the missing directory stays missing');
  assert.equal(dst.pending_records, 26, 'the epoch counts');
  assert.equal(dst.appended_records, 0);
  assert.equal(dst.epoch_written, true);

  tick = 0;
  const realFile = path.join(dir, 'real.jsonl');
  const real = openLog(realFile, { bootId: 'same', now: clock });
  real.load();
  const realOffsets = recs.map((r) => real.append(r));
  real.close();
  assert.equal(dst.pending_bytes, fs.statSync(realFile).size, 'predicted bytes == written bytes');
  assert.deepEqual(dryOffsets, realOffsets);

  // Over an existing log with a torn tail: the prediction is of the run that sets it aside.
  const grown = path.join(dir, 'grown.jsonl');
  writeRecords(grown, 4);
  fs.appendFileSync(grown, '{"t"');
  const twin = path.join(dir, 'twin.jsonl');
  fs.copyFileSync(grown, twin);
  tick = 0;
  const d2 = openLog(grown, { dryRun: true, bootId: 'g', now: clock });
  d2.load();
  const last = recs.map((r) => d2.append(r)).pop();
  d2.close();
  tick = 0;
  const r2 = openLog(twin, { bootId: 'g', now: clock });
  r2.load();
  const lastReal = recs.map((r) => r2.append(r)).pop();
  r2.close();
  assert.deepEqual(last, lastReal);
  assert.equal(last.offset + last.bytes, fs.statSync(twin).size);
});

// ── crash (C-2) ───────────────────────────────────────────────────────────

function runChild(args, { killAfter } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let maxAck = -1;
    let killed = false;
    let loaded = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      const lines = out.split('\n');
      out = lines.pop();
      for (const l of lines) {
        if (l.startsWith('a')) {
          maxAck = Math.max(maxAck, Number(l.slice(1)));
          if (killAfter != null && !killed && maxAck + 1 >= killAfter) { killed = true; child.kill('SIGKILL'); }
        } else if (l.startsWith('loaded ')) {
          loaded = l;
        }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, maxAck, err, loaded }));
  });
}

test('crash: SIGKILL after k acks loses no acked record, sets aside at most one tail, and a restart duplicates nothing', async (t) => {
  const dir = tmpDir(t);
  const rand = rng(0xc2c2);
  const ks = Array.from({ length: 5 }, () => 1 + Math.floor(rand() * 2000));
  const t0 = Date.now();
  for (const k of ks) {
    const file = path.join(dir, `crash-${k}`, 'log.jsonl');
    // The count is far above any k, so the child is still appending when the
    // kill lands (the kill is sent once k acks are read; nothing else ends it).
    const run = await runChild([file, '100000'], { killAfter: k });
    assert.equal(run.signal, 'SIGKILL', `k=${k}: the child was killed mid-stream, not finished`);
    assert.ok(run.maxAck + 1 >= k, `k=${k}: the child acked at least k records (${run.maxAck + 1})`);

    const before = readAll(file);
    const seen = new Set(before.recs.filter((r) => r.t === 'x').map((r) => r.i));
    let lost = 0;
    for (let i = 0; i <= run.maxAck; i++) if (!seen.has(i)) lost++;
    assert.equal(lost, 0, `k=${k}: acked_lost`);
    assert.equal(before.st.bad, 0);

    const again = await runChild([file, '50', 'restart']);
    assert.equal(again.code, 0, `k=${k}: the restart child exits cleanly: ${again.err}`);
    const tornBytes = before.st.torn ? before.st.torn.bytes : 0;
    assert.equal(again.loaded, `loaded ${before.st.complete} 0 ${tornBytes}`);

    const after = readAll(file);
    const is = after.recs.filter((r) => r.t === 'x').map((r) => r.i);
    assert.equal(new Set(is).size, is.length, `k=${k}: no duplicate i among complete records`);
    assert.equal(is.length, seen.size + 50);
    assert.equal(after.st.torn, null);
    assert.equal(after.st.bad, 0);
    const asides = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.torn-'));
    assert.ok(asides.length <= 1, `k=${k}: at most one torn tail set aside`);
    assert.equal(asides.length, before.st.torn ? 1 : 0);
  }
  t.diagnostic(`crash case: k=${ks.join(',')} in ${Date.now() - t0} ms`);
});
