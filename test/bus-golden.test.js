const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');
const { driveGoldenSession } = require('../test-support/golden-session');

// Byte-identity safety net for the Phase 2 change-bus migration. driveGoldenSession
// runs one scripted turn across every producer family (render, store, theme, the
// turn lock, a tab capture) with FIXED ids/urls, collects the full WS frame stream
// (incl. `hello`) + the /api/events log, and scrubs wall-clock stamps. GOLDEN below
// was captured from the PRE-refactor server; deepEqual proves the whole wire — WS
// frame shapes/order AND the event log — is unchanged by the migration.
//
// Frozen quirks this pins (all preserved verbatim, NOT bugs to fix here):
//  - the capture event's own `seq:1` overrides the ring seq (spread-after-seq).
//  - render's WS frame carries `html`; its event carries `bytes` and no html.
//  - the golden captures a TABLE page → the builtin `tables` distiller, whose pane
//    is the compact feedbackCard. (`default`/`article` render a reader-lite
//    simplified pane — ~3KB of themed CSS — so pinning that here would couple this
//    bus-wire snapshot to reader cosmetics; `tables` keeps the render frame small.)
//  - capture's render params omit `modes` (canPane is undefined → dropped).
//  - node-added carries `label` + `unlock:true`; seq-less WS frames stay out of
//    the ring.
//  - CHANNELS depth-1 addition: the capture is now wake-worthy, so the daemon's
//    classify subscriber folds it into the queue. That enqueue fires SYNCHRONOUSLY
//    inside the capture event's subscriber phase — i.e. BEFORE the capture emit's
//    own `store:patch` WS frame — so the `queue` add frame precedes it, and a
//    `queue` event lands between the capture and turn-end (bumping turn-end to
//    seq 7). `enqueued_at` is scrubbed volatile.
const GOLDEN = {
  frames: [
    {
      type: 'hello',
      store: {},
      mounts: [],
      active: null,
      lock: null,
      project: '<v>',
      theme: { tokens: {} },
      activeTheme: null,
    },
    { type: 'render', html: '<p>hello</p>', target: 'main', id: 'm1' },
    { type: 'store:patch', patch: { greeting: 'hi', n: 1 } },
    {
      type: 'theme',
      scope: 'global',
      theme: { tokens: { '--wc-accent': '#123456' } },
      resolved: { scope: 'global', tokens: { '--wc-accent': '#123456' }, css: '' },
    },
    { type: 'lock', lock: { base: null, started_at: '<v>', message: 'golden turn', author: 'user' } },
    {
      type: 'queue',
      op: 'add',
      item: {
        staged: true,
        kind: 'capture',
        source: 'ext:tab-stream',
        capture_id: 'cap1',
        why_wake: 'page captured',
        summary: 'captured example.com · profile tables · cap1',
        origin_mount: null,
        seq: 1,
        id: 'q1',
        enqueued_at: '<v>',
      },
      count: 1,
    },
    {
      type: 'store:patch',
      patch: {
        tab_capture: {
          seq: 1,
          capture_id: 'cap1',
          url: 'https://example.com/page',
          title: 'Example',
          profile: 'tables',
        },
      },
    },
    {
      type: 'render',
      html: '\n    <div style="font:13px var(--wc-font,system-ui);color:var(--wc-fg,#111)">\n      <div style="font-weight:600;margin-bottom:4px">📥 Captured: Example</div>\n      <div style="color:var(--wc-muted,#57606a);font:11.5px var(--wc-mono,monospace)">https://example.com/page</div>\n      <div style="margin-top:6px">profile <code>tables</code> · 1 table(s), 1 rows · raw 0.1 KB</div>\n      <div style="margin-top:4px;color:var(--wc-muted,#8c959f);font-size:11px">id <code>cap1</code> · signal <code>tab_capture</code></div>\n    </div>',
      target: 'main',
      id: 'tab-capture:tables:bf705e83',
      params: { title: 'Capture · tables — Example', mode: 'reduced' },
      pane_state: { mode: 'reduced' },
    },
    {
      type: 'node-added',
      node: {
        id: 'n0',
        parent_id: null,
        created_at: '<v>',
        author: 'claude',
        trigger_summary: 'did the golden thing',
        label: 'n1.0',
      },
      active: 'n0',
      unlock: true,
    },
  ],
  events: [
    { seq: 1, ts: '<v>', kind: 'render', id: 'm1', target: 'main', bytes: 12, source: 'claude' },
    { seq: 2, ts: '<v>', kind: 'store', patch: { greeting: 'hi', n: 1 }, source: 'server' },
    { seq: 3, ts: '<v>', kind: 'theme', scope: 'global', clear: false },
    { seq: 4, ts: '<v>', kind: 'graph', op: 'turn-begin', base: null, stole_stale_lock: false },
    { seq: 1, ts: '<v>', kind: 'capture', capture_id: 'cap1', url: 'https://example.com/page', profile: 'tables', source: 'ext:tab-stream' },
    {
      seq: 6, ts: '<v>', kind: 'queue', op: 'add', id: 'q1',
      item: {
        staged: true, kind: 'capture', source: 'ext:tab-stream', capture_id: 'cap1',
        why_wake: 'page captured', summary: 'captured example.com · profile tables · cap1',
        origin_mount: null, seq: 1, id: 'q1', enqueued_at: '<v>',
      },
    },
    { seq: 7, ts: '<v>', kind: 'graph', op: 'turn-end', id: 'n0' },
  ],
  latest: 7,
};

test('bus golden: the whole wire is byte-identical to the pre-refactor server', async (t) => {
  const ctx = await withServer(t);
  const actual = await driveGoldenSession(ctx);
  assert.deepEqual(actual, GOLDEN);
});

// ── Targeted invariants (small, localizing) ────────────────────────────────

test('bus: render WS frame carries html (no bytes); the event carries bytes (no html)', async (t) => {
  const { api, port } = await withServer(t);
  const c = await new Promise((res, rej) => {
    const WebSocket = require('ws');
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const frames = [];
    ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch {} });
    ws.on('open', () => res({ ws, frames }));
    ws.on('error', rej);
  });
  await new Promise((r) => setTimeout(r, 50));
  await api.post('/api/render', { id: 'r1', html: '<b>x</b>', target: 'main' });
  await new Promise((r) => setTimeout(r, 50));
  c.ws.close();

  const wsRender = c.frames.find((f) => f.type === 'render' && f.id === 'r1');
  assert.ok(wsRender, 'WS render frame present');
  assert.equal(wsRender.html, '<b>x</b>');
  assert.equal('bytes' in wsRender, false, 'WS frame has no bytes');

  const { json } = await api.get('/api/events');
  const evRender = json.events.find((e) => e.kind === 'render' && e.id === 'r1');
  assert.equal(evRender.bytes, 8);
  assert.equal('html' in evRender, false, 'event has no html');
});

test('bus: a tab capture is a triple-effect (store mutation + store:patch WS + one capture event)', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/capture', { url: 'https://x.test/p', title: 'P', html: '<p>hi there</p>' });

  // store mutation
  const { json: store } = await api.get('/api/store');
  assert.ok(store.tab_capture, 'tab_capture signal key set in the store');
  assert.equal(store.tab_capture.capture_id, 'cap1');

  // exactly one capture event
  const { json: ev } = await api.get('/api/events');
  const caps = ev.events.filter((e) => e.kind === 'capture');
  assert.equal(caps.length, 1);
  assert.equal(caps[0].capture_id, 'cap1');
});

test('bus: reset frame carries exactly {mounts,store,active,lock,theme,activeTheme}', async (t) => {
  const { api, port } = await withServer(t);
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const frames = [];
  ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch {} });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await new Promise((r) => setTimeout(r, 50));
  // wipe triggers a broadcastReset
  await api.post('/api/graph/wipe', {});
  await new Promise((r) => setTimeout(r, 50));
  ws.close();

  const reset = frames.find((f) => f.type === 'reset');
  assert.ok(reset, 'reset frame present');
  assert.deepEqual(
    Object.keys(reset).sort(),
    ['active', 'activeTheme', 'lock', 'mounts', 'store', 'theme', 'type'].sort(),
  );
});

test('/api/wait (driver endpoint): matches a top-level event field; a nested/absent field does not', async (t) => {
  // Claude's wait_for tool is deleted, but
  // /api/wait remains a documented driver contract (lib/driver.js waitFor). This
  // stays as a deliberate contract pin — not a state probe — because it exercises
  // the endpoint's matcher semantics (top-level field match, no nested descent)
  // that drivers still depend on.
  const { api } = await withServer(t);
  await api.post('/api/store', { patch: { hello: 1 } }); // seq 1, a store event

  // top-level match on `source` resolves
  const ok = await api.post('/api/wait', {
    predicate: { event_kind: 'store', match: { source: 'server' }, since_seq: 0 },
    timeout_ms: 500,
  });
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.matched, 'event');

  // a field that only exists nested (patch.hello) is NOT matched top-level
  const nested = await api.post('/api/wait', {
    predicate: { event_kind: 'store', match: { hello: 1 }, since_seq: 0 },
    timeout_ms: 300,
  });
  assert.equal(nested.json.ok, false);
  assert.equal(nested.json.timeout, true);
});

test('bus: except suppresses the echo to the origin socket', async (t) => {
  const { port } = await withServer(t);
  const WebSocket = require('ws');
  // Two sockets. A sends a store:set; the server echoes store:patch to everyone
  // EXCEPT the sender (A). So B sees it, A does not.
  const mk = () => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const frames = [];
    ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch {} });
    ws.on('open', () => res({ ws, frames }));
    ws.on('error', rej);
  });
  const A = await mk();
  const B = await mk();
  await new Promise((r) => setTimeout(r, 50));
  A.ws.send(JSON.stringify({ type: 'store:set', patch: { fromA: 1 } }));
  await new Promise((r) => setTimeout(r, 80));
  A.ws.close(); B.ws.close();

  const patchOf = (c) => c.frames.filter((f) => f.type === 'store:patch' && f.patch && f.patch.fromA === 1);
  assert.equal(patchOf(B).length, 1, 'B (other socket) receives the echo');
  assert.equal(patchOf(A).length, 0, 'A (origin socket) is skipped via except');
});

test('bus: one POST /api/store bumps latest by exactly 1', async (t) => {
  const { api } = await withServer(t);
  const before = (await api.get('/api/events')).json.latest;
  await api.post('/api/store', { patch: { k: 1 } });
  const after = (await api.get('/api/events')).json.latest;
  assert.equal(after - before, 1);
});

test('bus: a seq-less WS frame (legacy-clear) never enters the event log', async (t) => {
  const { api } = await withServer(t);
  // A plain clear broadcasts a WS `clear` frame AND pushes a `clear` event, but
  // the *lock* frame (turn-begin) is the seq-less one. Assert lock frames are not
  // in the log: turn-begin emits a `graph` event but the `lock` WS frame is not
  // an event.
  await api.post('/api/turn-begin', { message: 'x' });
  const { json } = await api.get('/api/events');
  assert.equal(json.events.some((e) => e.type === 'lock' || e.kind === 'lock'), false);
  const graphEvents = json.events.filter((e) => e.kind === 'graph' && e.op === 'turn-begin');
  assert.equal(graphEvents.length, 1, 'turn-begin contributes exactly one graph event, not a lock event');
});
