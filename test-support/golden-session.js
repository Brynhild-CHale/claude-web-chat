// Shared driver + scrubber for the byte-identity golden test (test/bus-golden).
// Lives in test-support (never auto-collected by `node --test`, not scanned by
// the conventions tripwire) so both the frozen-snapshot capture and the test
// import the SAME session — the frozen expected can't drift from what the test
// replays. See test/bus-golden.test.js.
//
// The session is scripted with FIXED ids/urls so every payload is deterministic
// except for wall-clock stamps, which scrubGolden() normalizes.

const WebSocket = require('ws');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// Values that are wall-clock / environment dependent and therefore differ every
// run. Normalized to a sentinel (rather than deleted) so the snapshot still
// asserts the field is PRESENT and only its volatile value is ignored.
const VOLATILE_KEYS = new Set(['ts', 'started_at', 'created_at', 'saved_at', 'project', 'enqueued_at']);

function scrubGolden(x) {
  if (Array.isArray(x)) return x.map(scrubGolden);
  if (x && typeof x === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(x)) out[k] = VOLATILE_KEYS.has(k) ? '<v>' : scrubGolden(v);
    return out;
  }
  return x;
}

// Open a WS client that records every frame it receives (incl. `hello`).
function collectFrames(port) {
  const frames = [];
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch {} });
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return { frames, ws, ready };
}

// Drive one representative turn across every producer family: render, store,
// theme, the turn lock (turn-begin/turn-end), and a tab capture (triple-effect).
// Returns the scrubbed WS frame stream + the scrubbed /api/events log.
async function driveGoldenSession({ api, port }) {
  const { frames, ws, ready } = collectFrames(port);
  await ready;
  await settle(60); // let `hello` land

  await api.post('/api/render', { id: 'm1', html: '<p>hello</p>', target: 'main' });
  await api.post('/api/store', { patch: { greeting: 'hi', n: 1 } });
  await api.post('/api/theme', { scope: 'global', tokens: { '--wc-accent': '#123456' } });
  await api.post('/api/turn-begin', { message: 'golden turn', author: 'user' });
  // A TABLE page → the builtin `tables` distiller, whose pane is the small
  // feedbackCard. (Q-D5 gave `default`/`article` a reader-lite simplified pane
  // ~3KB of themed CSS; `tables` keeps the compact card, so this bus-wire golden
  // stays pinned to a stable render frame instead of coupling to reader CSS.)
  await api.post('/api/capture', {
    url: 'https://example.com/page',
    title: 'Example',
    html: '<html><body><table><tr><th>Item</th></tr><tr><td>a</td></tr></table></body></html>',
  });
  await api.post('/api/turn-end', { author: 'claude', summary: 'did the golden thing' });

  await settle(100); // drain the socket
  ws.close();

  const { json: ev } = await api.get('/api/events');
  return {
    frames: scrubGolden(frames),
    events: scrubGolden(ev.events || []),
    latest: ev.latest,
  };
}

module.exports = { driveGoldenSession, scrubGolden };
