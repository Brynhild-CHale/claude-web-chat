// The HELD batch in the queue rail, under jsdom with the real front-end module
// graph (same harness style as test/queue-rail.test.js — node --test gives each
// test FILE its own process).
//
// The defect pinned here: when Channels are not enabled a Push is PARKED, and
// the rail announced that for six seconds and then went quiet. The park is real,
// durable server state (GET /api/queue/pending) that the user's next message
// will deliver — but nothing on screen said WHAT was waiting, so "did I already
// push that capture?" was a question only memory could answer. The batch now
// appears in the rail's item list under a header reading "Held for next prompt",
// the same way staged and held items are shown.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

// The park as the daemon reports it: the wake envelope, summary only (see
// lib/channel/envelope.js — `content` is one string of `- [kind] summary` lines
// with a header, and `meta.count` is the authoritative item count).
const PARK = {
  id: 'pw1',
  created_at: Date.now(),
  note: 'ship the second one',
  envelope: {
    content: [
      'Context from the user: ship the second one',
      '2 queued signals were pushed to Claude:',
      '- [capture] example.com — Pricing table',
      '- [signal] form_submit · plan-picker',
    ].join('\n'),
    meta: { kind: 'batch', count: '2', ids: 'q1,q2' },
  },
};

const calls = [];
const state = { queue: [], pending: null, pushResult: { ok: true, mode: 'parked', pending_id: 'pw1', delivers: 'Pushed — delivers with your next message.' } };
let W = null, WS = null, restore = () => {};

async function boot() {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8')
    .replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;

  const wsInstances = [];
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; wsInstances.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send() {}
    close() {}
  };
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (url === '/api/queue') return json({ items: state.queue, count: state.queue.length });
    if (url === '/api/queue/pending') return json({ pending: state.pending });
    if (url === '/api/queue/pending/consume') { state.pending = null; return json({ ok: true, consumed: true }); }
    if (url === '/api/queue/push') { state.pending = PARK; return json(state.pushResult); }
    if (url === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (url === '/api/graph') return json({ nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }], active: 'n1' });
    if (url === '/api/components') return json({ components: [] });
    if (url === '/api/themes') return json({ themes: [] });
    if (String(url).startsWith('/api/theme')) return json({ name: 'web-chat' });
    return json({ ok: true });
  };

  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'FocusEvent', 'getComputedStyle', 'localStorage', 'WebSocket', 'fetch', 'HTMLElement', 'Node', 'Element'];
  for (const k of keys) { try { saved[k] = global[k]; global[k] = window[k]; } catch {} }
  const savedSetInterval = global.setInterval;
  global.setInterval = () => 0;
  global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  window.__wcMount = require(path.join(REPO, 'public/mount-runtime.js'));

  await import(pathToFileURL(path.join(REPO, 'public/app/main.js')).href);

  restore = () => {
    for (const k of keys) { try { global[k] = saved[k]; } catch {} }
    global.setInterval = savedSetInterval;
    window.close();
  };
  W = window;
  WS = wsInstances[0];
}

const tick = () => new Promise((r) => setTimeout(r, 25));
const rail = () => W.document.getElementById('queue-rail');
const section = (label) => [...rail().querySelectorAll('.rail-sec')]
  .find((h) => h.querySelector('.rail-sec-cap').textContent === label);
// The rows that follow a section header, up to the next header.
function rowsUnder(label) {
  const h = section(label);
  if (!h) return [];
  const out = [];
  for (let n = h.nextElementSibling; n && !n.classList.contains('rail-sec'); n = n.nextElementSibling) {
    if (n.classList.contains('rail-item')) out.push(n);
  }
  return out;
}

test('a parked push is listed in the rail, not just announced', async () => {
  await boot();
  await tick();

  // Two signals queued, no channel connected.
  WS.onmessage({ data: JSON.stringify({ type: 'queue', op: 'add', item: { id: 'q1', kind: 'capture', source: 'example.com', summary: 'Pricing table', enqueued_at: 1 } }) });
  WS.onmessage({ data: JSON.stringify({ type: 'queue', op: 'add', item: { id: 'q2', kind: 'signal', source: 'plan-picker', summary: 'form_submit', enqueued_at: 2 } }) });
  assert.equal(rowsUnder('Staged').length, 2, 'precondition: two staged items');
  assert.equal(section('Held for next prompt'), undefined, 'and nothing held for the next prompt yet');

  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'p' }));
  await tick();
  assert.ok(calls.some((c) => c.url === '/api/queue/push'), 'P pushed');

  // The staged rows are gone (the batch left the queue) — and if the park were
  // only a transient note, the rail would now show "No queued signals" while a
  // delivery sat pending.
  assert.equal(section('Staged'), undefined, 'the staged section is empty again');
  assert.equal(rail().querySelector('.rail-empty'), null,
    'the rail does not claim to be empty while a delivery is pending');

  const head = section('Held for next prompt');
  assert.ok(head, 'the held batch gets its own section');
  assert.equal(head.querySelector('.rail-sec-cap').textContent, 'Held for next prompt',
    'with exactly that header');
  assert.equal(head.querySelector('.rail-sec-cnt').textContent, '2',
    'counted from the envelope meta, which is authoritative for a capped batch');

  // ...and it shows WHAT is waiting, item by item — the note the user typed plus
  // one row per signal, parsed back out of the envelope the daemon parked.
  const rows = rowsUnder('Held for next prompt').map((r) => ({
    kind: r.querySelector('.qi-kind').textContent,
    summary: r.querySelector('.qi-summary').textContent,
  }));
  assert.deepEqual(rows, [
    { kind: 'note', summary: 'ship the second one' },
    { kind: 'capture', summary: 'example.com — Pricing table' },
    { kind: 'signal', summary: 'form_submit · plan-picker' },
  ], 'the held batch is itemised, not summarised as a count');

  // The header/summary lines of the envelope are prose, not signals.
  assert.ok(!rows.some((r) => /queued signals were pushed/.test(r.summary)),
    "the envelope's own header line is not mistaken for an item");

  // It is persistent, unlike the 6s confirmation banner beside it.
  const note = rail().querySelector('.rail-parked');
  if (note) note.remove();
  assert.ok(section('Held for next prompt'), 'the held section outlives the transient note');
});

test('cancelling the delivery takes the held batch off the rail', async () => {
  const cancel = rail().querySelector('.rp-cancel');
  cancel.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(state.pending, null, 'the park was consumed server-side');
  assert.equal(section('Held for next prompt'), undefined, 'and its section is gone');
  assert.ok(rail().querySelector('.rail-empty'), 'the rail is genuinely empty again');
});

// The push raised the 6s transient parked banner, whose expiry timer touches
// `document`. Let it fire while the window is still valid, then tear down.
test.after(async () => { await new Promise((r) => setTimeout(r, 6200)); restore(); });
