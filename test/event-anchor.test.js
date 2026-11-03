// The event-time anchor (annotation engine PLAN.md 4D.1; DECISIONS.md C4;
// RULED 2026-11-02 U542@event-index-and-view (a)): a reported click, change or
// submit carries the clicked element's anchor record, computed at event time
// over a warm, mutation-invalidated index (public/app/event-anchor.js), checked
// again by the daemon (lib/server/ws.js domEvent), and stripped below `read` on
// the ring (lib/core/remote-policy TEXT_RULES 'GET /api/events').
//
// Four parts: the engine over jsdom with lib/core/anchors and jsdom's own
// MutationObserver; domEvent; a daemon's ring at each level; and, under
// WEB_CHAT_PERF=1 only, the timing (t.diagnostic, never asserted — the graded
// < 1 ms reading over the densest corpus pane is the 4D gate's, F1/K2 v3).
// The chrome's wiring is test/event-anchor-chrome.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');
const WebSocket = require('ws');
const { PUBLIC_DIR, userPaths } = require('../lib/core/paths');
const anchors = require('../lib/core/anchors');
const { domEvent, DOM_ANCHOR_MAX } = require('../lib/server/ws');
const { createRedactor } = require('../lib/core/redact');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { withServer, tmpRoot, waitUntil } = require('../test-support/helpers');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { densePaneHtml, densePaneElements } = require('../test-support/dense-pane');
const client = require('../lib/client');

const RUNTIME = fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8');
const PERF = process.env.WEB_CHAT_PERF === '1';
const wire = (o) => JSON.parse(JSON.stringify(o));

let EA = null;
const engine = async () => EA || (EA = await import(pathToFileURL(path.join(PUBLIC_DIR, 'app', 'event-anchor.js')).href));

const WINDOWS = [];
test.after(() => { for (const w of WINDOWS) w.close(); });
function newWindow() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  dom.window.eval(RUNTIME);
  WINDOWS.push(dom.window);
  return dom.window;
}
function mount(win, html, id = 'm') {
  const host = win.document.createElement('div');
  host.dataset.mountId = id;
  win.document.body.appendChild(host);
  return win.__wcMount.attachAndExtract(host, html).root;
}

// Clock, idle queue and timers the test drives.
function harness(win) {
  const h = { t: 1000, idle: [], timers: new Map(), seq: 0 };
  h.opts = {
    anchors,
    MutationObserver: win.MutationObserver,
    schedule: (fn) => { h.idle.push(fn); },
    now: () => h.t,
    setTimer: (fn, ms) => { const k = ++h.seq; h.timers.set(k, { fn, at: h.t + ms }); return k; },
    clearTimer: (k) => { h.timers.delete(k); },
  };
  h.runIdle = () => { const q = h.idle.splice(0); for (const fn of q) fn(); };
  h.advance = (ms) => {
    h.t += ms;
    for (const [k, x] of [...h.timers]) if (x.at <= h.t) { h.timers.delete(k); x.fn(); }
  };
  return h;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

const LIST = '<section class="card"><h3>Tasks</h3><ul class="rows">'
  + '<li class="row"><b>first</b><button class="go" id="b1">Run</button></li>'
  + '<li class="row"><b>second</b><button class="go" id="b2">Run</button></li>'
  + '</ul><div class="chromed"><span data-wc-chrome="1"><i>pin</i></span>words</div></section>';

// ── the engine ──────────────────────────────────────────────────────────────

test('anchorAt on a button is exactly anchors.record(root, button, {mount}), through JSON', async () => {
  const { createEventAnchors } = await engine();
  const win = newWindow();
  const root = mount(win, LIST, 'p1');
  const ea = createEventAnchors(harness(win).opts);
  const btn = root.getElementById('b2');
  const got = ea.anchorAt(root, btn, 'p1');
  assert.ok(got, 'a record');
  assert.deepStrictEqual(wire(got), wire(anchors.record(root, btn, { mount: 'p1' })));
  assert.equal(got.kind, 'element');
  assert.equal(got.mount, 'p1');
  // a text node target answers for its element
  assert.deepStrictEqual(wire(ea.anchorAt(root, btn.firstChild, 'p1')), wire(anchors.record(root, btn, { mount: 'p1' })));
});

test('after a row is inserted above, the next anchorAt is the fresh record again (no stale index)', async () => {
  const { createEventAnchors } = await engine();
  const win = newWindow();
  const root = mount(win, LIST, 'p1');
  const h = harness(win);
  const ea = createEventAnchors(h.opts);
  const btn = root.getElementById('b2');
  ea.engage(root);
  const before = wire(ea.anchorAt(root, btn, 'p1'));
  const li = win.document.createElement('li');
  li.className = 'row';
  li.innerHTML = '<b>zeroth</b><button class="go">Run</button>';
  root.querySelector('ul.rows').prepend(li);
  // no microtask turn between the mutation and the event: takeRecords sees it
  const after = wire(ea.anchorAt(root, btn, 'p1'));
  assert.deepStrictEqual(after, wire(anchors.record(root, btn, { mount: 'p1' })));
  assert.notDeepStrictEqual(after.at, before.at, 'the path moved with the inserted row');
  // a text change with the observer's callback delivered (then the idle rebuild)
  root.querySelector('li.row b').textContent = 'renamed';
  await flush();
  assert.equal(ea.stats().dirty, 1, 'the observer marked the entry dirty');
  assert.equal(h.idle.length, 1, 'one idle rebuild is scheduled');
  root.querySelector('li.row b').textContent = 'renamed again';
  await flush();
  assert.equal(h.idle.length, 1, 'single-flight: still one');
  h.runIdle();
  assert.equal(ea.stats().dirty, 0, 'the idle callback rebuilt it');
  const warm = ea.stats().warm;
  assert.deepStrictEqual(wire(ea.anchorAt(root, btn, 'p1')), wire(anchors.record(root, btn, { mount: 'p1' })));
  assert.equal(ea.stats().warm, warm + 1, 'answered on the warm path');
});

test('a target inside a data-wc-chrome subtree gives its nearest recordable ancestor\'s record', async () => {
  const { createEventAnchors } = await engine();
  const win = newWindow();
  const root = mount(win, LIST, 'p1');
  const ea = createEventAnchors(harness(win).opts);
  const inner = root.querySelector('[data-wc-chrome] i');
  const div = root.querySelector('div.chromed');
  assert.equal(anchors.record(root, inner, { mount: 'p1' }), null, 'precondition: the chrome element has no record');
  assert.deepStrictEqual(wire(ea.anchorAt(root, inner, 'p1')), wire(anchors.record(root, div, { mount: 'p1' })));
  // a target outside the root has none
  assert.equal(ea.anchorAt(root, win.document.body, 'p1'), null);
});

test('a record over EVENT_ANCHOR_MAX bytes gives null', async () => {
  const { createEventAnchors, EVENT_ANCHOR_MAX } = await engine();
  assert.equal(EVENT_ANCHOR_MAX, 4096);
  const win = newWindow();
  const cls = Array.from({ length: 400 }, (_, i) => `cls-number-${i}`).join(' ');
  const root = mount(win, `<div><button class="${cls}">Go</button></div>`, 'p1');
  const ea = createEventAnchors(harness(win).opts);
  const btn = root.querySelector('button');
  const full = anchors.record(root, btn, { mount: 'p1' });
  assert.ok(Buffer.byteLength(JSON.stringify(full)) > 4096, 'precondition: the record is oversized');
  assert.equal(ea.anchorAt(root, btn, 'p1'), null);
  assert.equal(ea.stats().oversize, 1);
});

test('an entry with no engagement for ENGAGED_MS drops its observer; release disconnects at once', async () => {
  const { createEventAnchors, ENGAGED_MS } = await engine();
  assert.equal(ENGAGED_MS, 60_000);
  const win = newWindow();
  const a = mount(win, LIST, 'pa');
  const b = mount(win, LIST, 'pb');
  const h = harness(win);
  const ea = createEventAnchors(h.opts);
  ea.engage(a);
  ea.engage(b);
  assert.deepStrictEqual([ea.stats().entries, ea.stats().observing], [2, 2]);
  h.advance(ENGAGED_MS / 2);
  ea.engage(b);
  h.advance(ENGAGED_MS / 2);
  assert.deepStrictEqual([ea.stats().entries, ea.stats().observing, ea.stats().expired], [1, 1, 1], 'a expired, b kept');
  // a mutation in a dropped root schedules nothing: its observer is gone
  a.querySelector('b').textContent = 'changed';
  await flush();
  assert.equal(h.idle.length, 0);
  h.advance(ENGAGED_MS);
  assert.deepStrictEqual([ea.stats().entries, ea.stats().observing], [0, 0], 'b expired too');
  assert.equal(h.timers.size, 0, 'no expiry timer is left armed');
  ea.engage(a);
  ea.release(a);
  assert.deepStrictEqual([ea.stats().entries, ea.stats().observing, ea.stats().released], [0, 0, 1]);
  assert.equal(h.timers.size, 0, 'release of the last entry clears the expiry timer');
});

test('a clean entry answers on the warm path, a dirty one on the cold path', async () => {
  const { createEventAnchors } = await engine();
  const win = newWindow();
  const root = mount(win, LIST, 'p1');
  const ea = createEventAnchors(harness(win).opts);
  const btn = root.getElementById('b1');
  ea.anchorAt(root, btn, 'p1');   // first use: an entry made, built cold
  assert.deepStrictEqual([ea.stats().cold, ea.stats().warm], [1, 0]);
  ea.anchorAt(root, btn, 'p1');
  assert.deepStrictEqual([ea.stats().cold, ea.stats().warm], [1, 1]);
  btn.setAttribute('data-x', '1');
  ea.anchorAt(root, btn, 'p1');
  assert.deepStrictEqual([ea.stats().cold, ea.stats().warm], [2, 1]);
  // an engagement over a dirty index rebuilds it there, so the event is warm
  btn.setAttribute('data-y', '1');
  ea.engage(root);
  ea.anchorAt(root, btn, 'p1');
  assert.deepStrictEqual([ea.stats().cold, ea.stats().warm], [2, 2]);
});

// ── domEvent ────────────────────────────────────────────────────────────────

const REC = Object.freeze({
  v: 1, kind: 'element', mount: 'p',
  at: { path: [0, 1, 2], sib: 0 },
  fp: { tag: 'button', id: 'go', cls: ['go'], head: 'Run', attrs: ['class', 'id'], parent: 'li.row' },
  rows: [{ depth: 2, shape: 'li||row', sigs: { b: 1, button: 1 }, key: 'first', head: 'first Run' }],
});
const CLICK = Object.freeze({ type: 'click', mountId: 'p', tag: 'BUTTON', id: 'go', name: null, value: null, dataset: null });

test('domEvent keeps a valid element anchor for its own mount, as a copy', () => {
  assert.equal(DOM_ANCHOR_MAX, 4096);
  const anchor = JSON.parse(JSON.stringify(REC));
  const e = domEvent({ ...CLICK, anchor });
  assert.deepStrictEqual(e.anchor, REC);
  assert.notStrictEqual(e.anchor, anchor, 'a copy, not the payload\'s object');
  anchor.fp.head = 'changed';
  assert.equal(e.anchor.fp.head, 'Run');
});

test('domEvent leaves no anchor key for anything but an engine element record of the event\'s mount, at most 4096 bytes', () => {
  const bad = [
    ['a range record', { ...REC, kind: 'range' }],
    ['a source record', { ...REC, kind: 'source', md: 'md-1' }],
    ['a converted locator', { ...REC, form: 'pin-locator@1' }],
    ['a legacy locator', { mount: 'p', selector: 'button', text: 'Run', ordinal: 0 }],
    ['a legacy locator with v and kind', { ...REC, selector: 'button' }],
    ['another mount', { ...REC, mount: 'q' }],
    ['no mount', { ...REC, mount: null }],
    ['a version 2', { ...REC, v: 2 }],
    ['a string', 'element'],
    ['a number', 7],
    ['an array', [REC]],
    ['an oversized record', { ...REC, fp: { ...REC.fp, cls: Array.from({ length: 400 }, (_, i) => `cls-number-${i}`) } }],
  ];
  for (const [what, anchor] of bad) {
    const e = domEvent({ ...CLICK, anchor });
    assert.ok(e, what);
    assert.ok(!('anchor' in e), `${what}: no anchor key`);
  }
  // a payload with no mountId keeps no anchor either
  assert.ok(!('anchor' in domEvent({ ...CLICK, mountId: undefined, anchor: { ...REC } })));
});

test('domEvent passes the anchor through the redactor: a secret-shaped head is masked', () => {
  const ghp = fakeSecrets().find((f) => f.id === 'github-ghp');
  const anchor = { ...REC, fp: { ...REC.fp, head: ghp.text.slice(0, 120) }, rows: [{ ...REC.rows[0], head: ghp.text }] };
  const e = domEvent({ ...CLICK, anchor }, { redactor: createRedactor() });
  assert.ok(e.anchor, 'the redacted anchor is kept');
  assert.deepStrictEqual(findLeaks(e.anchor, [ghp]), []);
  assert.ok(!JSON.stringify(e.anchor).includes(ghp.secrets[0]));
  assert.deepStrictEqual(e.anchor.at, REC.at, 'the record\'s shape stands');
  // without a redactor the head is as sent (the daemon always passes its own)
  assert.ok(JSON.stringify(domEvent({ ...CLICK, anchor }).anchor).includes(ghp.secrets[0]));
});

test('a frame with no anchor keeps the exact allowlisted shape (test/ws-event-allowlist.test.js)', () => {
  const e = domEvent({
    type: 'click', mountId: 'p', tag: 'BUTTON', id: 'go', name: null, value: 'v',
    dataset: { act: 'go', n: 3 }, seq: 1e9, ts: 1, source: 'server', kind: 'dom', batch: [1],
  });
  assert.deepStrictEqual(e, {
    type: 'click', mountId: 'p', tag: 'BUTTON', id: 'go', name: null, value: 'v',
    dataset: { act: 'go' }, kind: 'dom', source: 'browser',
  });
  assert.deepStrictEqual(domEvent({ ...CLICK, anchor: null }), { ...CLICK, kind: 'dom', source: 'browser' });
});

// ── the ring at each level ──────────────────────────────────────────────────

const HEAD_MARK = 'wc-u542-head-mark';
const ROW_MARK = 'wc-u542-row-mark';
const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const MOUNT = 'm-ev';
const ANCHOR = Object.freeze({
  ...REC, mount: MOUNT,
  fp: { ...REC.fp, head: HEAD_MARK },
  rows: [{ ...REC.rows[0], head: ROW_MARK }],
});
const has = (body, m) => (typeof body === 'string' ? body : JSON.stringify(body)).includes(m);

function sendEvents(port, payloads) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://localhost:${port}/ws`);
    sock.on('unexpected-response', (_q, res) => { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); });
    sock.on('error', reject);
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type !== 'hello') return;
      for (const payload of payloads) sock.send(JSON.stringify({ type: 'event', payload }));
      resolve(sock);
    });
  });
}

async function boot(t) {
  const readRoot = tmpRoot('wc-u542-read-');
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(readRoot)]: 'read' } } });
  const out = {};
  for (const level of ['basic', 'read']) {
    const d = await withServer(t, level === 'basic' ? { seed } : { root: readRoot });
    d.call = (method, p, body, headers) => client.request(d.port, method, p, body, { headers, timeout: 10000 });
    const r = await d.api.post('/api/render', { id: MOUNT, html: '<ul><li class="row"><b>first</b><button class="go" id="go">Run</button></li></ul>' });
    assert.ok(r.status < 300, `${level}: render ${r.status}`);
    const sock = await sendEvents(d.port, [
      { ...CLICK, mountId: MOUNT, anchor: ANCHOR },
      { ...CLICK, type: 'change', mountId: 'm-gone', id: 'dangling', anchor: { ...ANCHOR, mount: 'm-gone' } },
    ]);
    t.after(() => sock.close());
    assert.ok(await waitUntil(async () => {
      const ev = ((await d.api.get('/api/events?since=0')).json.events || []).filter((e) => e.kind === 'dom');
      return ev.length === 2;
    }), `${level}: both events reached the ring`);
    out[level] = d;
  }
  return out;
}

const domsOf = (body) => (body.events || []).filter((e) => e.kind === 'dom');

test('the ring: the host reads the anchor; below read it goes (type, tag and id stay); read keeps it; a dangling mount has none', async (t) => {
  const d = await boot(t);
  for (const level of ['basic', 'read']) {
    const local = await d[level].call('GET', '/api/events?since=0');
    assert.equal(local.status, 200);
    const [click, dangling] = domsOf(local.body);
    assert.deepStrictEqual(click.anchor, ANCHOR, `${level}: the host reads the anchor whole`);
    assert.equal(dangling.mountId, null, `${level}: a dangling mount is nulled`);
    assert.ok(!('anchor' in dangling), `${level}: and its anchor goes with it`);

    const remote = await d[level].call('GET', '/api/events?since=0', null, REMOTE);
    assert.equal(remote.status, 200, `${level}: remote`);
    const rc = domsOf(remote.body)[0];
    assert.deepStrictEqual([rc.type, rc.tag, rc.id, rc.mountId], ['click', 'BUTTON', 'go', MOUNT], `${level}: the entry stays`);
    if (level === 'basic') {
      assert.ok(!('anchor' in rc), 'basic: no anchor');
      assert.ok(!has(remote.body, HEAD_MARK) && !has(remote.body, ROW_MARK), 'basic: no pane text');
    } else {
      assert.deepStrictEqual(rc.anchor, ANCHOR, 'read: the anchor is kept');
    }
  }
});

test('the daemon\'s event branch passes its own redactor: a secret-shaped head reaches the ring masked', async (t) => {
  const ghp = fakeSecrets().find((f) => f.id === 'github-ghp');
  const d = await withServer(t);
  const r = await d.api.post('/api/render', { id: MOUNT, html: '<ul><li class="row"><b>first</b><button class="go" id="go">Run</button></li></ul>' });
  assert.ok(r.status < 300, `render ${r.status}`);
  const anchor = { ...ANCHOR, fp: { ...ANCHOR.fp, head: ghp.text.slice(0, 120) }, rows: [{ ...ANCHOR.rows[0], head: ghp.text }] };
  const sock = await sendEvents(d.port, [{ ...CLICK, mountId: MOUNT, anchor }]);
  t.after(() => sock.close());
  let dom = null;
  assert.ok(await waitUntil(async () => {
    dom = domsOf((await d.api.get('/api/events?since=0')).json)[0] || null;
    return !!dom;
  }), 'the event reached the ring');
  assert.ok(dom.anchor, 'the redacted anchor is kept');
  assert.deepStrictEqual(dom.anchor.at, ANCHOR.at, 'the record\'s shape stands');
  assert.deepStrictEqual(findLeaks(dom.anchor, [ghp]), []);
  assert.ok(!JSON.stringify(dom.anchor).includes(ghp.secrets[0]), 'no secret on the ring');
});

test('the ring\'s other readers below read: the stream\'s catch-up and /api/wait\'s matched event carry no anchor', async (t) => {
  const d = await boot(t);
  const http = require('http');
  const streamed = (port, headers) => new Promise((resolve, reject) => {
    let text = '';
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/events/stream?since=0&kinds=dom', headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
        if ((text.match(/event: dom\n/g) || []).length >= 2 && /\n\n$/.test(text)) { req.destroy(); resolve(text); }
      });
    });
    req.on('error', (e) => { if (text) resolve(text); else reject(e); });
    setTimeout(() => { req.destroy(); resolve(text); }, 5000).unref();
  });
  for (const level of ['basic', 'read']) {
    const { port, call } = d[level];
    const localStream = await streamed(port, {});
    assert.ok(has(localStream, HEAD_MARK), `${level}: the host's stream carries the anchor`);
    const remoteStream = await streamed(port, REMOTE);
    assert.ok(/event: dom\n/.test(remoteStream), `${level}: the remote stream carries the dom entry`);
    assert.equal(has(remoteStream, HEAD_MARK) || has(remoteStream, ROW_MARK), level === 'read', `${level}: the remote stream's anchor`);

    const wait = (headers) => call('POST', '/api/wait', { predicate: { event_kind: 'dom' }, timeout_ms: 1000 }, headers);
    const lw = await wait();
    assert.equal(lw.body.matched, 'event');
    assert.ok(has(lw.body, HEAD_MARK), `${level}: the host's wait carries the anchor`);
    const rw = await wait(REMOTE);
    assert.equal(rw.body.matched, 'event', `${level}: the remote wait matched`);
    assert.equal(rw.body.event.kind, 'dom');
    assert.equal('anchor' in rw.body.event, level === 'read', `${level}: the remote wait's anchor`);
  }
});

// ── timing (WEB_CHAT_PERF=1 only; measured, never asserted) ─────────────────

test('timing: the event-time anchor over the synthetic dense pane, 200 clicks — warm, cold and the engagement rebuild', { skip: !PERF && 'WEB_CHAT_PERF=1 only' }, async (t) => {
  const { createEventAnchors } = await engine();
  const win = newWindow();
  const root = mount(win, densePaneHtml({ sections: 6 }), 'dense');
  const els = root.querySelectorAll('*').length;
  assert.equal(els, densePaneElements(6));
  const h = harness(win);
  const ea = createEventAnchors(h.opts);
  const buttons = [...root.querySelectorAll('button.go')];
  const pick = (k) => buttons[(k * 37) % buttons.length];
  const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
  const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const N = 200;
  ea.engage(root);
  const warm = [];
  const sizes = [];
  for (let k = 0; k < N; k++) {
    const t0 = process.hrtime.bigint();
    const rec = ea.anchorAt(root, pick(k), 'dense');
    warm.push(ms(t0));
    sizes.push(Buffer.byteLength(JSON.stringify(rec)));
  }
  const cold = [];
  for (let k = 0; k < N; k++) {
    pick(k + 1).setAttribute('data-n', String(k));
    const t0 = process.hrtime.bigint();
    ea.anchorAt(root, pick(k), 'dense');
    cold.push(ms(t0));
  }
  const engage = [];
  for (let k = 0; k < N; k++) {
    pick(k + 2).setAttribute('data-m', String(k));
    const t0 = process.hrtime.bigint();
    ea.engage(root);
    engage.push(ms(t0));
  }
  const f = (a) => `p50 ${pct(a, 0.5).toFixed(3)} ms, p95 ${pct(a, 0.95).toFixed(3)} ms`;
  t.diagnostic(`dense pane ${els} elements, ${N} clicks each (jsdom, node ${process.version})`);
  t.diagnostic(`warm path: ${f(warm)} (stats warm ${ea.stats().warm})`);
  t.diagnostic(`cold path (a mutation before each): ${f(cold)}`);
  t.diagnostic(`engagement rebuild (a mutation before each): ${f(engage)}`);
  t.diagnostic(`record bytes: p50 ${pct(sizes, 0.5)}, max ${Math.max(...sizes)}`);
});
