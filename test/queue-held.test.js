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

// The park as the daemon reports it: the structured batch (summary-only fields —
// GET /api/queue/pending reduces pendingWake.batch to exactly these) PLUS the
// wake envelope, whose `content` is prose written for Claude.
//
// The two deliberately disagree here. The envelope folds source into each bullet
// ('example.com — Pricing table'); the items keep `summary` and `source` apart,
// as a queued item does. The rail used to regex-parse those bullets, so it can
// only render the fields below if it is reading `items`.
const PARK = {
  id: 'pw1',
  created_at: Date.now(),
  note: 'ship the second one',
  items: [
    { id: 'q1', kind: 'capture', source: 'example.com', summary: 'Pricing table', why_wake: 'a page you captured' },
    { id: 'q2', kind: 'signal', source: 'plan-picker', summary: 'form_submit', why_wake: 'declared signal' },
  ],
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
    'FocusEvent', 'navigator', 'getComputedStyle', 'localStorage', 'WebSocket', 'fetch', 'HTMLElement', 'Node', 'Element'];
  // Node 21+ defines some of these (navigator) as GETTERS with no setter, so a
  // plain assignment is a silent no-op and the modules keep seeing Node's own.
  const aliasGlobal = (k, v) => {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch { try { global[k] = v; } catch {} }
  };
  for (const k of keys) { try { saved[k] = global[k]; } catch {} aliasGlobal(k, window[k]); }
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
  // one row per signal, read from the STRUCTURED batch the daemon parked.
  const rows = rowsUnder('Held for next prompt').map((r) => ({
    kind: r.querySelector('.qi-kind').textContent,
    src: r.querySelector('.qi-src').textContent,
    summary: r.querySelector('.qi-summary').textContent,
  }));
  assert.deepEqual(rows, [
    { kind: 'note', src: '', summary: 'ship the second one' },
    { kind: 'capture', src: 'example.com', summary: 'Pricing table' },
    { kind: 'signal', src: 'plan-picker', summary: 'form_submit' },
  ], 'the held batch is itemised from `items`, not scraped back out of the envelope prose — '
    + 'which is why the source is its own field here instead of folded into the summary line');

  // The header/summary lines of the envelope are prose, not signals.
  assert.ok(!rows.some((r) => /queued signals were pushed/.test(r.summary)),
    "the envelope's own header line is not mistaken for an item");

  // It is persistent, unlike the 6s confirmation banner beside it.
  const note = rail().querySelector('.rail-parked');
  if (note) note.remove();
  assert.ok(section('Held for next prompt'), 'the held section outlives the transient note');
});

test('rewording the envelope cannot change what the rail shows', async () => {
  // The envelope is prose for Claude and lib/channel/envelope.js is free to
  // change it — a different bullet, a summary containing a newline, the 50-line
  // cap on a large batch. None of that is the rail's business any more.
  state.pending = {
    ...PARK,
    envelope: { content: 'Two things are waiting.\n• capture: example.com\n• signal: plan-picker', meta: { kind: 'batch', count: '2' } },
  };
  const { refreshPending } = await import(pathToFileURL(path.join(REPO, 'public/app/queue.js')).href);
  await refreshPending();
  await tick();
  const rows = rowsUnder('Held for next prompt').map((r) => r.querySelector('.qi-summary').textContent);
  assert.deepEqual(rows, ['ship the second one', 'Pricing table', 'form_submit'],
    'the rows come from `items`; the old regex over `- [kind] …` bullets would have found none '
    + 'here and silently degraded the whole batch to "2 signals awaiting delivery"');
  state.pending = PARK;
  await refreshPending();
  await tick();
});

test('an envelope with no items degrades to a count, not an empty section', async () => {
  state.pending = { id: 'pw2', created_at: Date.now(), note: null, envelope: { content: 'prose', meta: { count: '3' } } };
  const { refreshPending } = await import(pathToFileURL(path.join(REPO, 'public/app/queue.js')).href);
  await refreshPending();
  await tick();
  const rows = rowsUnder('Held for next prompt').map((r) => r.querySelector('.qi-summary').textContent);
  assert.deepEqual(rows, ['3 signals awaiting delivery']);
  state.pending = PARK;
  await refreshPending();
  await tick();
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
