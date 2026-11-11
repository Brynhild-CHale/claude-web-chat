// Live delivery is in ring order (U750b; contract 07 C-07.11; the exit gate's
// C-EX6-23-wake-ack-seq, its second half). An emit made while another emit of
// the same bus is delivering — a subscriber that emits, the daemon's wake policy
// above all — still takes its seq, ts and ring slot at once and still returns
// its entry, but its delivery (subscribers with its `meta`, then its WS frames
// with their `except`) waits until the delivery in progress has finished, and
// the outermost emit drains the queue, in emit order, before it returns. Before
// this, the nested emit fanned out at once, so every subscriber after the
// emitter, and the WS broadcaster, heard entry N+1 before entry N.
//
// (a) the engine, in process, over generated shapes (a seeded counter, never
// Math.random); (b) a real server's all-kinds SSE stream across a capture and a
// declared queue signal, against GET /api/events.

const test = require('node:test');
const assert = require('node:assert');
const { createBus } = require('../lib/core/bus');
const { createHookTap } = require('../lib/server/hook-tap');
const WebSocket = require('ws');
const { withServer, openSSE, waitUntil } = require('../test-support/helpers');

// A seeded linear congruential counter: the same shapes on every run.
function counter(seed) {
  let s = seed >>> 0;
  return (n) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; };
}

// A shape: subscribers at several positions, some emitting 0–2 nested events on
// some depths (kinds d0..d3), nesting to `maxDepth` (≤ 3); WS frames on or off,
// a ws-only nested emit now and then; one subscriber that throws, or none.
function genShapes(count, seed = 0x750b) {
  const r = counter(seed);
  const shapes = [];
  for (let i = 0; i < count; i++) {
    const nSubs = 1 + r(5);
    const maxDepth = 1 + r(3);
    const subs = [];
    for (let k = 0; k < nSubs; k++) {
      const fan = r(3);
      const on = new Set();
      for (let d = 0; d < maxDepth; d++) if (r(2)) on.add(d);
      subs.push({ fan, on, wsOnly: r(4) === 0 });
    }
    shapes.push({
      i,
      subs,
      maxDepth,
      ws: r(2) === 1,
      meta: r(2) === 1,
      thrower: r(3) === 0 ? r(nSubs) : -1,
      seqIsPosition: r(2) === 1,
      roots: 1 + r(3),
    });
  }
  return shapes;
}

// Run one shape; return the list of what went wrong (empty when the rule holds).
function runShape(shape) {
  const bus = createBus({ seqIsPosition: shape.seqIsPosition });
  const problems = [];
  let emitIndex = 0; // the order emit was CALLED in
  const frames = []; // what the broadcaster heard: emit indices
  const heard = shape.subs.map(() => []); // per subscriber: seqs
  const returned = []; // { idx, built }
  let depthNow = 0; // how deep inside an emit's call we are (to find the outermost)
  let outermostReturns = 0;

  bus.setBroadcaster((frame, except) => {
    frames.push(frame.idx);
    if (except !== `except-${frame.idx}`) problems.push(`frame ${frame.idx} got except ${except}`);
  });

  function doEmit(kindDepth, withEvent) {
    const idx = ++emitIndex;
    const meta = shape.meta ? { idx } : undefined;
    const args = {
      event: withEvent ? { kind: `d${kindDepth}`, idx } : null,
      meta,
    };
    if (shape.ws) { args.ws = { type: `t${kindDepth}`, idx }; args.except = `except-${idx}`; }
    depthNow++;
    const built = bus.emit(args);
    depthNow--;
    if (withEvent) {
      if (!built || built.idx !== idx) problems.push(`emit ${idx} did not return its entry`);
      else {
        if (!bus.events.includes(built)) problems.push(`emit ${idx}'s entry was not on the ring when emit returned`);
        if (built.seq !== bus.events.indexOf(built) + 1) problems.push(`emit ${idx}'s seq ${built.seq} is not its ring position`);
      }
      returned.push({ idx, built });
    } else if (built !== null) problems.push(`ws-only emit ${idx} returned ${JSON.stringify(built)}`);
    if (depthNow === 0) {
      outermostReturns++;
      // The outermost caller sees everything delivered, as before.
      const total = bus.events.length;
      for (let k = 0; k < heard.length; k++) {
        if (heard[k].length !== total) problems.push(`outermost emit ${idx} returned before subscriber ${k} heard all (${heard[k].length}/${total})`);
      }
    }
    return built;
  }

  shape.subs.forEach((sub, k) => {
    bus.subscribe((e, meta) => {
      heard[k].push(e.seq);
      if (shape.meta) {
        if (!meta || meta.idx !== e.idx) problems.push(`sub ${k} got meta ${JSON.stringify(meta)} with event ${e.idx}`);
      } else if (meta !== undefined) problems.push(`sub ${k} got meta ${JSON.stringify(meta)} with no meta given`);
      const d = Number(e.kind.slice(1));
      if (d < shape.maxDepth && sub.on.has(d)) {
        for (let f = 0; f < sub.fan; f++) doEmit(d + 1, !(sub.wsOnly && f === 1));
      }
      if (k === shape.thrower) throw new Error(`sub ${k} throws`);
    });
  });

  for (let r = 0; r < shape.roots; r++) doEmit(0, true);

  const ring = bus.events.map((e) => e.seq);
  const want = ring.map((_, i) => i + 1);
  if (JSON.stringify(ring) !== JSON.stringify(want)) problems.push(`ring ${ring} is not 1..n`);
  heard.forEach((h, k) => {
    if (JSON.stringify(h) !== JSON.stringify(ring)) problems.push(`sub ${k} heard [${h}], ring [${ring}]`);
  });
  if (shape.ws) {
    const order = frames.slice();
    const sorted = order.slice().sort((a, b) => a - b);
    if (JSON.stringify(order) !== JSON.stringify(sorted)) problems.push(`broadcaster heard emits [${order}], emitted [${sorted}]`);
    if (order.length !== emitIndex) problems.push(`broadcaster heard ${order.length} of ${emitIndex} frames`);
    // The frames of entries on the ring come in ring order.
    const ringIdx = bus.events.map((e) => e.idx);
    const frameRingIdx = order.filter((x) => ringIdx.includes(x));
    if (JSON.stringify(frameRingIdx) !== JSON.stringify(ringIdx)) problems.push(`broadcaster's ring frames [${frameRingIdx}] vs ring [${ringIdx}]`);
  }
  if (outermostReturns !== shape.roots) problems.push(`outermost returns ${outermostReturns} of ${shape.roots}`);
  const nested = bus.events.some((e) => e.kind !== 'd0');
  return { problems, nested, entries: bus.events.length };
}

const SHAPES = 600;

test(`(a) over ${SHAPES} generated nestings every subscriber and the broadcaster hear strictly increasing seqs with no position skipped, in the ring's order; emit returns the built entry; meta reaches only its own event`, () => {
  const shapes = genShapes(SHAPES);
  let nestedShapes = 0;
  let entries = 0;
  const failed = [];
  for (const shape of shapes) {
    const { problems, nested, entries: n } = runShape(shape);
    entries += n;
    if (nested) nestedShapes++;
    if (problems.length) failed.push(`shape ${shape.i}: ${problems.slice(0, 3).join('; ')}`);
  }
  console.log(`bus-live-order: ${shapes.length} shapes generated (${nestedShapes} with a nested emit), ${entries} entries; ${failed.length} broke the rule`);
  assert.ok(nestedShapes > SHAPES / 3, `enough nested shapes to mean something (${nestedShapes})`);
  assert.deepEqual(failed.slice(0, 10), [], `${failed.length} shapes broke the rule`);
});

test('(a) the smallest nesting: a later subscriber and the broadcaster hear the outer entry first', () => {
  const bus = createBus({ seqIsPosition: true });
  const frames = [];
  bus.setBroadcaster((f) => frames.push(f.type));
  let inner = null;
  bus.subscribe((e) => {
    if (e.kind === 'capture') {
      inner = bus.emit({ event: { kind: 'queue', op: 'add' }, ws: { type: 'queue' } });
      // The inner entry is on the ring and returned at once…
      assert.equal(inner.seq, 2);
      assert.equal(bus.events[1], inner);
    }
  });
  const later = [];
  bus.subscribe((e) => later.push(`${e.seq}:${e.kind}`));
  const outer = bus.emit({ event: { kind: 'capture' }, ws: { type: 'capture' } });
  assert.equal(outer.seq, 1);
  assert.deepEqual(later, ['1:capture', '2:queue'], 'the later subscriber hears the ring\'s order');
  assert.deepEqual(frames, ['capture', 'queue'], 'the capture\'s frame before its queue item\'s');
  assert.deepEqual(bus.read().events.map((e) => `${e.seq}:${e.kind}`), later, 'equal to the ring');
});

test('(a) a throwing subscriber strands nothing: every deferred delivery is made, and the next emit is delivered at once', () => {
  const bus = createBus({ seqIsPosition: true });
  const heard = [];
  bus.subscribe((e) => {
    if (e.kind === 'a') { bus.emit({ event: { kind: 'b' } }); bus.emit({ event: { kind: 'c' } }); throw new Error('boom'); }
  });
  bus.subscribe((e) => { heard.push(e.kind); if (e.kind === 'b') throw new Error('boom too'); });
  bus.emit({ event: { kind: 'a' } });
  assert.deepEqual(heard, ['a', 'b', 'c']);
  bus.emit({ event: { kind: 'd' } });
  assert.deepEqual(heard, ['a', 'b', 'c', 'd'], 'not left in a delivering state');
});

test('(a) a broadcaster that throws: the outer emit still throws to its caller, after the deferred deliveries are made; a deferred frame\'s throw strands nothing', () => {
  const bus = createBus();
  const heard = [];
  const frames = [];
  let throwOn = 'outer';
  bus.setBroadcaster((f) => { frames.push(f.n); if (f.n === throwOn) throw new Error(`ws ${f.n}`); });
  bus.subscribe((e) => {
    heard.push(e.kind);
    if (e.kind === 'outer') bus.emit({ event: { kind: 'inner' }, ws: { n: 'inner' } });
  });
  assert.throws(() => bus.emit({ event: { kind: 'outer' }, ws: { n: 'outer' } }), /ws outer/);
  assert.deepEqual(heard, ['outer', 'inner']);
  assert.deepEqual(frames, ['outer', 'inner']);
  throwOn = 'inner';
  bus.emit({ event: { kind: 'outer' }, ws: { n: 'outer' } }); // the inner throw stays inside, as it did
  assert.deepEqual(heard, ['outer', 'inner', 'outer', 'inner']);
  bus.emit({ event: { kind: 'x' } });
  assert.deepEqual(heard.slice(-1), ['x'], 'not left in a delivering state');
});

test('(a) a ws-only emit inside a delivery waits its turn too', () => {
  const bus = createBus();
  const frames = [];
  bus.setBroadcaster((f) => frames.push(f));
  bus.subscribe((e) => { if (e.kind === 'a') bus.emit({ ws: 'nested' }); });
  bus.emit({ event: { kind: 'a' }, ws: 'outer' });
  assert.deepEqual(frames, ['outer', 'nested']);
});

test('(a) the hook tap (another instance of the engine) keeps ring order for a re-entrant publish', () => {
  const tap = createHookTap();
  const heard = [];
  tap.subscribe((e) => { if (e.event === 'A') tap.publish({ v: 1, event: 'B' }); });
  tap.subscribe((e) => heard.push(`${e.seq}:${e.event}`));
  tap.publish({ v: 1, event: 'A' });
  assert.deepEqual(heard, ['1:A', '2:B']);
});

// ── (b) a real server ───────────────────────────────────────────────────────

// A browser tab: resolves once its hello is in; records every later frame.
function tab(t, port) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://localhost:${port}/ws`);
    const frames = [];
    let ready = false;
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!ready) { if (m.type === 'hello') { ready = true; resolve({ sock, frames }); } return; }
      frames.push(m);
    });
    sock.on('error', reject);
    t.after(() => { try { sock.close(); } catch {} });
  });
}

test('(b) a real server: the all-kinds live stream across a capture and a declared queue signal is in ring order, each position once; a tab hears the capture\'s frame before its queue item\'s', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'u750b-p', html: '<p>s</p>', params: { signals: [{ key: 'u750b_sig', wake: 'queue' }] } });
  const since = (await api.get('/api/events?since=0')).json.latest;
  const sse = await openSSE(port, { since });
  t.after(() => sse.close());
  const watcher = await tab(t, port);
  // A capture: the wake policy folds it into the queue inside its own fan-out.
  const cap = await api.post('/api/capture', { url: 'https://example.test/u750b', title: 'U750b', html: '<p>captured</p>', kind: 'selection' });
  assert.equal(cap.status, 200, JSON.stringify(cap.json));
  await waitUntil(() => watcher.frames.some((f) => f.type === 'queue'), { timeout: 5000, what: 'the capture\'s queue frame' });
  // A declared queue signal, written by a browser: folded the same way.
  const writer = await tab(t, port);
  writer.sock.send(JSON.stringify({ type: 'store:set', patch: { u750b_sig: { seq: 1 } } }));
  let ring;
  await waitUntil(async () => {
    ring = (await api.get(`/api/events?since=${since}`)).json;
    return ring.events.filter((e) => e.kind === 'queue').length >= 2 && sse.events.length >= ring.events.length;
  }, { timeout: 10000, what: 'two queue items, and the stream caught up with the ring' });
  const kinds = ring.events.map((e) => `${e.seq}:${e.kind}`);
  const capIdx = ring.events.findIndex((e) => e.kind === 'capture');
  const storeIdx = ring.events.findIndex((e) => e.kind === 'store');
  assert.ok(capIdx >= 0 && storeIdx > capIdx, kinds.join(','));
  assert.equal(ring.events[capIdx + 1].kind, 'queue', `the capture's queue item right after it: ${kinds}`);
  assert.equal(ring.events[storeIdx + 1].kind, 'queue', `the signal's queue item right after it: ${kinds}`);
  const live = sse.events.map((e) => `${e.seq}:${e.kind}`);
  assert.deepEqual(live, kinds, 'the live stream is the ring, in its order');
  sse.events.forEach((e, i) => assert.equal(e.seq, since + 1 + i, 'strictly increasing by one'));
  // The watching tab: the capture's store:patch frame, then its queue add.
  const types = watcher.frames.map((f) => (f.type === 'queue' ? `queue:${f.op}` : f.type));
  const sp = types.indexOf('store:patch');
  const qa = types.indexOf('queue:add');
  assert.ok(sp >= 0 && qa > sp, `the capture's frame before its queue item's: ${types.join(',')}`);
});
