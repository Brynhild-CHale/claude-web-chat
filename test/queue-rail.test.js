// Push feedback in the queue rail, under jsdom with the real front-end module
// graph (same harness style as test/client-boot.test.js — node --test gives each
// test FILE its own process, so importing public/app/main.js here does not
// collide with that file's import).
//
// Three defects are pinned here:
//   (a) P with the rail COLLAPSED posted every confirmation / error / recovery
//       button into .rail-expanded, which is opacity:0 + pointer-events:none.
//   (b) A parked push announced itself for 6s and then vanished — no standing
//       indicator that a delivery was pending, and no way to cancel it, even
//       though GET /api/queue/pending reports the park as durable server state.
//   (c) P with an EMPTY queue was a completely silent no-op.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

// Boot the real front end into a jsdom window with a scripted fetch. `routes`
// maps a URL (or a prefix, longest match wins) to a body factory; every call is
// recorded on `calls` so a test can assert what the rail asked the daemon for.
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

  const calls = [];
  const state = {
    queue: [],
    pending: null,          // what GET /api/queue/pending reports
    pushResult: { ok: true, mode: 'parked', pending_id: 'pw1', delivers: 'Pushed — delivers with your next message.' },
    pushOk: true,
  };
  window.fetch = async (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (url === '/api/queue') return json({ items: state.queue, count: state.queue.length });
    if (url === '/api/queue/pending') return json({ pending: state.pending });
    if (url === '/api/queue/pending/consume') { state.pending = null; return json({ ok: true, consumed: true }); }
    if (url === '/api/queue/push') {
      if (!state.pushOk) return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
      if (state.pushResult.mode === 'parked') {
        state.pending = { id: 'pw1', created_at: Date.now(), envelope: { meta: { count: '2' } }, note: '' };
      }
      return json(state.pushResult);
    }
    if (url === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (url === '/api/graph') return json({ nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }], active: 'n1' });
    if (url === '/api/components') return json({ components: [] });
    if (url === '/api/themes') return json({ themes: [] });
    if (String(url).startsWith('/api/theme')) return json({ name: 'web-chat' });
    return json({ ok: true });
  };
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'getComputedStyle', 'localStorage', 'WebSocket', 'fetch', 'HTMLElement', 'Node', 'Element'];
  for (const k of keys) { try { saved[k] = global[k]; global[k] = window[k]; } catch {} }
  const savedSetInterval = global.setInterval;
  global.setInterval = () => 0; // no pollers keeping the process alive
  global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  window.__wcMount = require(path.join(REPO, 'public/mount-runtime.js'));

  await import(pathToFileURL(path.join(REPO, 'public/app/main.js')).href);

  const restore = () => {
    for (const k of keys) { try { global[k] = saved[k]; } catch {} }
    global.setInterval = savedSetInterval;
    window.close();
  };
  return { window, wsInstances, calls, state, restore };
}

const tick = () => new Promise((r) => setTimeout(r, 25));
const rail = (w) => w.document.getElementById('queue-rail');
const pressP = (w) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'p' }));
// Escape is the shell's "unpin the rail" gesture — the state a user is in after
// the rail auto-opened and they dismissed it, i.e. collapsed again.
const unpinRail = (w) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));

test('the queue rail makes Push legible: reveal, empty-push notice, standing park + cancel', async () => {
  const { window, wsInstances, calls, state, restore } = await boot();
  try {
    await tick();
    const w = window;
    const r = rail(w);

    // The rail starts COLLAPSED — this is the state P used to post into blindly.
    assert.ok(!r.classList.contains('open'), 'precondition: the rail is collapsed');

    /* --- (c) P with an empty queue must not be a silent no-op --- */
    pressP(w);
    await tick();
    assert.ok(!calls.some((c) => c.url === '/api/queue/push'),
      'an empty queue still does not POST a push');
    const nothing = r.querySelector('.rail-nothing');
    assert.ok(nothing, 'P on an empty queue says something instead of nothing');
    assert.match(nothing.textContent, /Nothing to push/i);

    /* --- (a) ...and it says it somewhere the user can actually see --- */
    assert.ok(r.classList.contains('open'), 'the rail is revealed so the notice is visible');

    // collapse it again (Escape unpins; the pointer leaving would do the same)
    unpinRail(w);
    assert.ok(!r.classList.contains('open'), 'the rail collapses again');

    /* --- a real push, still from the collapsed rail --- */
    const ws = wsInstances[0];
    ws.onmessage({ data: JSON.stringify({ type: 'queue', op: 'add', item: { id: 'q1', kind: 'capture', source: 'x', summary: 's', enqueued_at: 1 } }) });
    ws.onmessage({ data: JSON.stringify({ type: 'queue', op: 'add', item: { id: 'q2', kind: 'signal', source: 'y', summary: 's2', enqueued_at: 2 } }) });
    assert.equal(r.querySelectorAll('.rail-item').length, 2, 'two items queued');

    pressP(w);
    await tick();
    assert.ok(calls.some((c) => c.url === '/api/queue/push' && c.method === 'POST'), 'P pushed');
    assert.ok(r.classList.contains('open'), 'the rail is revealed for the push confirmation');
    assert.ok(r.querySelector('.rail-parked'), 'the transient parked confirmation is shown');

    /* --- (b) the STANDING parked indicator, backed by GET /api/queue/pending --- */
    assert.ok(calls.some((c) => c.url === '/api/queue/pending'), 'the rail read the durable park');
    const box = r.querySelector('.rail-pending');
    assert.ok(box && !box.classList.contains('hidden'), 'a standing parked indicator is visible');
    assert.match(box.querySelector('.rp-text').textContent, /2 signals deliver with your next message/);
    assert.ok(r.classList.contains('has-pending'), 'the collapsed rail also flags the park');

    // ...and unlike the 6s confirmation it must survive that confirmation expiring.
    const parked = r.querySelector('.rail-parked');
    parked.remove();
    assert.ok(!r.querySelector('.rail-pending').classList.contains('hidden'),
      'the standing indicator outlives the transient note');

    /* --- (b) cancel: the park can be taken back --- */
    const cancel = box.querySelector('.rp-cancel');
    assert.ok(cancel, 'the parked indicator offers a cancel affordance');
    cancel.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await tick();
    const consume = calls.find((c) => c.url === '/api/queue/pending/consume');
    assert.ok(consume, 'cancel consumes the park server-side');
    assert.equal(consume.body.id, 'pw1', 'it consumes the id the server reported');
    assert.equal(state.pending, null);
    assert.ok(r.querySelector('.rail-pending').classList.contains('hidden'), 'the indicator clears');
    assert.ok(!r.classList.contains('has-pending'), 'and so does the collapsed flag');

    /* --- (a) the same reveal for a FAILED push and its recovery buttons --- */
    state.pushOk = false;
    unpinRail(w);
    r.classList.remove('open');
    ws.onmessage({ data: JSON.stringify({ type: 'queue', op: 'add', item: { id: 'q3', kind: 'capture', source: 'z', summary: 's3', enqueued_at: 3 } }) });
    pressP(w);
    await tick();
    const err = r.querySelector('.rail-error');
    assert.ok(err, 'a failed push reports itself');
    assert.match(err.textContent, /Push failed/);
    assert.ok(r.classList.contains('open'), 'in a rail the user can actually see');
    assert.equal(r.querySelectorAll('.rail-item').length, 1, 'and the batch is kept');

    await new Promise((res) => setTimeout(res, 400)); // drain deferred timers
  } finally { restore(); }
});
