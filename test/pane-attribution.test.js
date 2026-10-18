// Pane attribution from the realm (PLAN 1B.4, U214c; DECISIONS A1).
//
// A live pane script is compiled with its own `fetch` (public/mount-runtime.js
// paneFetch): the global fetch, with the pane header (lib/core/writer-token
// PANE_HEADER) naming the pane on every same-origin request. The daemon reads
// it in one place (lib/server/domain/writers resolveWriter, asked {pane: true}):
// a LOCAL BROWSER request stamped with a LIVE pane's id is class 'pane', owner
// 'pane:<id>'. The comment routes let a pane edit or delete only its own pins
// and refuse its claim to be Claude; spawn and close from a browser need the
// stamp to equal the `parent` they name.
//
// COOPERATIVE: pane scripts run in the chrome's own realm, so a script that
// calls `window.fetch` (unstamped → the user) or forges the header (as another
// live pane) defeats the attribution. Nothing here proves the residual away; it
// proves that every stamped request is held to its stamp — S-9's nine pane
// forgeries are accepted 0/9 — and that a remote or unstamped request is never
// read as a pane.
//
// Measured four ways: the runtime alone (node, as test/mount-runtime.test.js
// requires it), the writers domain alone, a real daemon (withServer) for S-9
// and spawn/close, and the real chrome (bootShell) forwarding the pane facade's
// requests to that daemon — including after the chrome remounts its panes.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Node's own fetch, held before the chrome shell replaces the global.
const realFetch = globalThis.fetch;

const { withServer, tmpRoot } = require('../test-support/helpers');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { PANE_HEADER, WRITER_HEADER } = require('../lib/core/writer-token');
const { PUBLIC_DIR, projectPaths } = require('../lib/core/paths');
const { createAudience } = require('../lib/server/audience');
const { createWriters } = require('../lib/server/domain/writers');
const { PANE_STAMP_HINT } = require('../lib/server/routes/spawn');
const client = require('../lib/client');
const mount = require('../public/mount-runtime.js');

const lower = PANE_HEADER.toLowerCase();
const stampOf = (init) => {
  const h = (init && init.headers) || {};
  for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return h[k];
  return undefined;
};

// ── the runtime ─────────────────────────────────────────────────────────────

test('the runtime spells the pane header exactly as lib/core/writer-token does (the one browser copy)', () => {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8');
  const m = src.match(/var PANE_HEADER = '([^']+)';/);
  assert.ok(m, 'mount-runtime.js declares PANE_HEADER');
  assert.strictEqual(m[1], PANE_HEADER);
});

// A page location for the runtime's same-origin test (node has none), and a
// recording global fetch; both put back after.
function withPage(t, href = 'http://localhost:5173/') {
  const saved = { fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'), location: Object.getOwnPropertyDescriptor(globalThis, 'location') };
  t.after(() => {
    for (const k of ['fetch', 'location']) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k];
    }
  });
  const seen = [];
  Object.defineProperty(globalThis, 'location', { value: new URL(href), configurable: true, writable: true });
  Object.defineProperty(globalThis, 'fetch', {
    value: (input, init) => { seen.push({ input, init }); return Promise.resolve({ ok: true }); },
    configurable: true, writable: true,
  });
  return seen;
}
const lifeOf = () => ({ timers: new Set(), signal: new AbortController().signal, onUnmount() {} });

test('runScripts with a life: a pane\'s same-origin fetch carries its mount id; a cross-origin one goes untouched', async (t) => {
  const seen = withPage(t);
  const store = mount.createStore({});
  const errors = [];
  mount.runScripts(null, [
    'fetch("/api/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });'
    + 'fetch("https://other.example/");'
    + 'fetch("http://localhost:5173/api/abs");'
    + 'fetch("/api/forged", { headers: { "x-wc-pane": "someone-else" } });'
    + 'fetch("/api/pairs", { headers: [["X-A", "1"]] });',
  ], store, {}, 'm1', (e) => errors.push(e), null, lifeOf());
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(seen.length, 5);
  assert.strictEqual(seen[0].input, '/api/x');
  assert.strictEqual(stampOf(seen[0].init), 'm1', 'the relative same-origin request is stamped');
  assert.strictEqual(seen[0].init.headers['Content-Type'], 'application/json', 'the script\'s own headers are kept');
  assert.strictEqual(seen[0].init.method, 'POST');
  assert.strictEqual(seen[0].init.body, '{}');
  assert.strictEqual(seen[1].init, undefined, 'a cross-origin request goes to the global fetch exactly as called');
  assert.strictEqual(stampOf(seen[2].init), 'm1', 'an absolute same-origin URL is stamped');
  assert.strictEqual(stampOf(seen[3].init), 'm1', 'a header the script set itself is replaced by its own id');
  assert.strictEqual(Object.keys(seen[3].init.headers).filter((k) => k.toLowerCase() === lower).length, 1);
  assert.strictEqual(seen[4].init.headers['X-A'], '1', 'an array of pairs is kept');
});

test('runScripts with a life and no page location: only a relative URL is stamped', (t) => {
  const seen = withPage(t);
  globalThis.location = undefined;
  const store = mount.createStore({});
  mount.runScripts(null, ['fetch("/rel"); fetch("http://localhost:5173/abs"); fetch("//cdn.example/x")'], store, {}, 'm6', null, null, lifeOf());
  assert.deepStrictEqual(seen.map((c) => stampOf(c.init)), ['m6', undefined, undefined]);
});

test('runScripts with a life: a Request input is re-wrapped with the header, its own headers kept', async (t) => {
  const seen = withPage(t);
  const store = mount.createStore({});
  mount.runScripts(null, ['fetch(new Request("http://localhost:5173/api/r", { method: "POST", headers: { "X-B": "2" }, body: "z" }))'],
    store, {}, 'm2', null, null, lifeOf());
  assert.strictEqual(seen.length, 1);
  const r = seen[0].input;
  assert.ok(r instanceof Request, 'a Request goes on');
  assert.strictEqual(r.headers.get(PANE_HEADER), 'm2');
  assert.strictEqual(r.headers.get('X-B'), '2');
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(await r.text(), 'z');

  seen.length = 0;
  mount.runScripts(null, ['fetch(new Request("https://other.example/x"))'], store, {}, 'm2', null, null, lifeOf());
  assert.strictEqual(seen[0].input.headers.get(PANE_HEADER), null, 'a cross-origin Request is passed through');
});

test('runScripts with a life: the global fetch is looked up at call time', async (t) => {
  withPage(t);
  const store = mount.createStore({});
  mount.runScripts(null, ['store.set({ go: function () { return fetch("/late"); } })'], store, {}, 'm3', null, null, lifeOf());
  const late = [];
  globalThis.fetch = (input, init) => { late.push(stampOf(init)); return Promise.resolve(null); };
  await store.get('go')();
  assert.deepStrictEqual(late, ['m3']);
});

test('runScripts with a life: a script declaring `const fetch` still runs, and its setInterval still ends with the pane', (t) => {
  withPage(t);
  const saved = { si: global.setInterval, ci: global.clearInterval };
  t.after(() => { global.setInterval = saved.si; global.clearInterval = saved.ci; });
  const cleared = [];
  global.setInterval = () => 77;
  global.clearInterval = (h) => cleared.push(h);
  const life = lifeOf();
  const store = mount.createStore({});
  const errors = [];
  mount.runScripts(null, ['const fetch = function () { return "own"; }; store.set({ f: fetch(), h: setInterval(function () {}, 5) })'],
    store, {}, 'm4', (e) => errors.push(e), null, life);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(store.get('f'), 'own', 'its own fetch');
  assert.strictEqual(store.get('h'), 77);
  const [entry] = [...life.timers];
  assert.ok(entry, 'the interval is tracked');
  entry.clear();
  assert.deepStrictEqual(cleared, [77], 'and released with the pane');

  // One that declares a timer name falls back to neither, as before.
  mount.runScripts(null, ['const setTimeout = 1; store.set({ g: fetch === globalThis.fetch })'], store, {}, 'm4', (e) => errors.push(e), null, life);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(store.get('g'), true, 'the global fetch, unstamped');
});

test('runScripts without a life (preview, export): the script\'s fetch is the global, unstamped', (t) => {
  const seen = withPage(t);
  const store = mount.createStore({});
  mount.runScripts(null, ['store.set({ same: fetch === globalThis.fetch }); fetch("/api/y")'], store, {}, 'm5');
  assert.strictEqual(store.get('same'), true);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].init, undefined, 'no stamp');
});

// ── the writers domain ──────────────────────────────────────────────────────

function domain(t) {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { mounts: new Map([['evil', {}], ['p', {}]]) };
  const writers = createWriters({ paths: projectPaths(root), state, redactor: null, audience: createAudience({ root, configFile: null }) });
  t.after(() => writers.stop());
  return { writers, state };
}
const reqOf = (headers = {}) => ({
  headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  socket: { remoteAddress: '127.0.0.1' },
});
const BROWSER = { Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-origin' };

test('resolveWriter: a local browser request stamped with a live pane is that pane; unstamped, remote or a dead pane is not', (t) => {
  const { writers, state } = domain(t);
  const P = { pane: true };
  assert.deepStrictEqual(writers.resolveWriter(reqOf({ ...BROWSER, [PANE_HEADER]: 'evil' }), {}, P), { class: 'pane', owner: 'pane:evil', verified: false });
  assert.deepStrictEqual(writers.resolveWriter(reqOf(BROWSER), {}, P), { class: 'user', owner: 'user', verified: false }, 'unstamped → user');
  assert.deepStrictEqual(writers.resolveWriter(reqOf({ ...BROWSER, [PANE_HEADER]: 'gone' }), {}, P).class, 'user', 'a stamp naming no live pane → user');
  assert.deepStrictEqual(writers.resolveWriter(reqOf({ ...BROWSER, [PANE_HEADER]: '' }), {}, P).class, 'user', 'an empty stamp claims nothing');
  assert.strictEqual(writers.resolveWriter(reqOf({ ...BROWSER, [PANE_HEADER]: 'evil', 'X-WC-Remote': '1' }), {}, P).class, 'remote', 'remote is never a pane');
  assert.strictEqual(writers.resolveWriter(reqOf({ [PANE_HEADER]: 'evil' }), {}, P).class, 'claude', 'a non-browser caller keeps today\'s rule (advisory claude)');
  assert.strictEqual(writers.resolveWriter(reqOf({ ...BROWSER, [PANE_HEADER]: 'evil' }), {}).class, 'user',
    'a caller that does not ask (the render/markdown/clear gate) gets user, which it refuses');
  state.mounts.delete('evil');
  assert.strictEqual(writers.resolveWriter(reqOf({ ...BROWSER, [PANE_HEADER]: 'evil' }), {}, P).class, 'user', 'liveness is read per request');
  assert.deepStrictEqual(writers.resolveWriter(reqOf({ ...BROWSER, [PANE_HEADER]: 'p', [WRITER_HEADER]: 'bogus' }), {}, P), { stale: true },
    'a writer header is read first: a forged one is stale, not a pane');
});

// ── one daemon and one chrome for the rest of the file ─────────────────────
// The chrome shell replaces the timer globals for the whole process, which a
// daemon booted after it cannot run on (an interval stub has no unref), so the
// daemon boots first, in the same before() hook, and every daemon case below
// shares it (each with its own ids). It stops after the shell is put back.

let shell = null;
let daemon = null;
const cleanups = [];
const forwarded = [];
const forward = async (u, init = {}) => {
  forwarded.push({ url: u, stamp: stampOf(init) });
  const r = await realFetch(daemon.baseUrl + u, {
    method: init.method || 'GET',
    headers: { ...(init.headers || {}), Origin: daemon.baseUrl },
    body: init.body,
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { text }; }
  return respond(body, { status: r.status });
};

// withServer's api/anonApi call the global fetch, which the shell has
// replaced by then: these two go to the daemon through Node's own.
function viaRealFetch(base, token) {
  async function req(method, p, body, headers = {}) {
    const h = { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers };
    const t = token && token();
    if (t) h[WRITER_HEADER] = t;
    const res = await realFetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, json, text };
  }
  return {
    get: (p, headers) => req('GET', p, undefined, headers),
    post: (p, body, headers) => req('POST', p, body, headers),
    patch: (p, body, headers) => req('PATCH', p, body, headers),
    del: (p, headers) => req('DELETE', p, undefined, headers),
  };
}

before(async () => {
  const ctx = await withServer({ after: (fn) => cleanups.push(fn) });
  daemon = {
    port: ctx.port,
    baseUrl: ctx.baseUrl,
    api: viaRealFetch(ctx.baseUrl, () => ctx.writerToken()),
    anonApi: viaRealFetch(ctx.baseUrl, null),
  };
  shell = await bootShell({ open: true, routes: { '/api/pane/*': forward, '/api/probe': { ok: true } } });
});
after(async () => {
  if (shell) await shell.restore();
  for (const fn of cleanups.reverse()) await fn();
});

// ── S-9 against a real daemon ───────────────────────────────────────────────

const SHARED_PIN = { text: 'a user note', shared: true, anchor: { mount: 'cl', selector: 'p', text: 'c', ordinal: 0 } };

test('S-9: the nine pane forgeries, each a pane-stamped browser request from a live pane — accepted 0/9', async () => {
  const { api, anonApi, port, baseUrl } = daemon;
  const evil = { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin', [PANE_HEADER]: 'evil' };
  const plain = { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' };
  assert.equal((await api.post('/api/render', { id: 'cl', html: '<p>c</p>' })).status, 200);
  assert.equal((await api.post('/api/render', { id: 'evil', html: '<p>e</p>' })).status, 200);
  assert.equal((await api.post('/api/render', { id: 'p', html: '<p>p</p>' })).status, 200);
  assert.equal((await api.post('/api/pane/spawn', { parent: 'p', id: 'p-kid', html: '<i>k</i>' })).json.ok, true);
  const userPin = (await anonApi.post('/api/comments', SHARED_PIN, plain)).json.pin;
  assert.equal(userPin.writer.class, 'user');
  const mounts = async () => (await client.get('/api/mounts', { port, noSpawn: true })).mounts || [];

  const outcomes = [];
  const refused = (label, r) => outcomes.push({ label, forged: r.status < 400, detail: `${r.status} ${r.text}` });

  refused('reply as author claude', await anonApi.post(`/api/comments/${userPin.id}/reply`, { text: 'I am Claude', author: 'claude' }, evil));
  refused('render over a Claude pane as service:x', await anonApi.post('/api/render', { id: 'cl', html: '<p>x</p>', owner: 'service:x' }, evil));
  refused('render over a Claude pane as service:x with force', await anonApi.post('/api/render', { id: 'cl', html: '<p>x</p>', owner: 'service:x', force: true }, evil));
  refused('render with no owner', await anonApi.post('/api/render', { id: 'evil-new', html: '<p>x</p>' }, evil));
  refused('render as service:git-dashboard', await anonApi.post('/api/render', { id: 'gd', html: '<p>x</p>', owner: 'service:git-dashboard' }, evil));
  refused('close another pane\'s child naming that pane as parent', await anonApi.post('/api/pane/close', { parent: 'p', id: 'p-kid' }, evil));
  refused('delete a user\'s pin', await anonApi.del(`/api/comments/${userPin.id}`, evil));

  const reply = await anonApi.post(`/api/comments/${userPin.id}/reply`, { text: 'a pane says hi' }, evil);
  const last = reply.json && reply.json.pin && reply.json.pin.replies.slice(-1)[0];
  outcomes.push({ label: 'author-less reply', forged: !(reply.status === 200 && last.author === 'user' && last.writer.class === 'pane' && last.writer.owner === 'pane:evil'), detail: reply.text });
  const add = await anonApi.post('/api/comments', { ...SHARED_PIN, text: 'a pane pin' }, evil);
  outcomes.push({ label: 'add a pin', forged: !(add.status === 200 && add.json.pin.writer.class === 'pane' && add.json.pin.writer.owner === 'pane:evil'), detail: add.text });

  const forged = outcomes.filter((o) => o.forged);
  assert.deepStrictEqual(forged, [], `accepted forgeries ${forged.length}/9`);
  assert.strictEqual(outcomes.length, 9);

  // What the refusals left alone.
  const ms = await mounts();
  assert.strictEqual(ms.find((m) => m.id === 'cl').owner || 'claude', 'claude');
  assert.ok(!ms.some((m) => m.id === 'evil-new' || m.id === 'gd'));
  assert.ok(ms.some((m) => m.id === 'p-kid'), 'the child is still up');
  const pins = (await api.get('/api/comments')).json.comments;
  assert.ok(pins.some((c) => c.id === userPin.id), 'the user\'s pin is still there');
  assert.ok(!pins.find((c) => c.id === userPin.id).replies.some((r) => r.author === 'claude'));

  // The pane's own pin is its to edit and delete.
  const own = add.json.pin;
  assert.equal((await anonApi.patch(`/api/comments/${own.id}`, { text: 'edited by its pane' }, evil)).status, 200);
  assert.equal((await anonApi.del(`/api/comments/${own.id}`, evil)).status, 200);
});

// ── spawn and close ─────────────────────────────────────────────────────────

test('spawn/close: a browser stamp must equal the parent; remote, credentialed and lib/client callers keep today\'s rule', async () => {
  const { api, anonApi, port, baseUrl } = daemon;
  for (const id of ['sp', 'sq']) assert.equal((await api.post('/api/render', { id, html: `<p>${id}</p>` })).status, 200);
  const as = (pane) => ({ Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin', ...(pane ? { [PANE_HEADER]: pane } : {}) });

  const own = await anonApi.post('/api/pane/spawn', { parent: 'sp', id: 'sp-a', html: '<i>a</i>' }, as('sp'));
  assert.equal(own.json.ok, true, own.text);
  const other = await anonApi.post('/api/pane/spawn', { parent: 'sp', id: 'sp-b', html: '<i>b</i>' }, as('sq'));
  assert.equal(other.status, 403, other.text);
  assert.deepStrictEqual(other.json, { ok: false, writer: 'pane', hint: PANE_STAMP_HINT });
  const bare = await anonApi.post('/api/pane/spawn', { parent: 'sp', id: 'sp-b', html: '<i>b</i>' }, as(null));
  assert.equal(bare.status, 403, 'an unstamped browser request is refused');
  const closeOther = await anonApi.post('/api/pane/close', { parent: 'sp', id: 'sp-a' }, as('sq'));
  assert.equal(closeOther.status, 403);
  const closeOwn = await anonApi.post('/api/pane/close', { parent: 'sp', id: 'sp-a' }, as('sp'));
  assert.equal(closeOwn.json.ok, true, closeOwn.text);

  // lib/client (no fetch metadata): today's rule.
  const viaClient = await client.post('/api/pane/spawn', { parent: 'sp', id: 'sp-c', html: '<i>c</i>' }, { port, noSpawn: true });
  assert.equal(viaClient.ok, true, JSON.stringify(viaClient));
  assert.equal((await client.post('/api/pane/close', { parent: 'sp', id: 'sp-c' }, { port, noSpawn: true })).ok, true);
  // Claude's token (a proven credential): today's rule.
  assert.equal((await api.post('/api/pane/spawn', { parent: 'sq', id: 'sq-a', html: '<i>q</i>' })).json.ok, true);
  // Through the portal: today's rule (cooperative; a remote pane is never stamped).
  const remote = await anonApi.post('/api/pane/spawn', { parent: 'sq', id: 'sq-b', component: 'nope' }, { ...as('sp'), 'X-WC-Remote': '1' });
  assert.notEqual(remote.status, 403, `remote: ${remote.status} ${remote.text}`);
});

// ── the chrome's facade, against the real daemon ────────────────────────────

const PARENT_HTML = '<p>parent</p><script>'
  + '(window.__apis = window.__apis || {})[mountId] = api;'
  + '(window.__fetches = window.__fetches || {})[mountId] = fetch;'
  + '</script>';

test('chrome: api.spawn and api.close go out stamped with the pane and work against a real daemon, also after the chrome remounts its panes', async () => {
  const { api, port } = daemon;
  const W = shell.window;
  assert.equal((await api.post('/api/render', { id: 'fp', html: PARENT_HTML })).status, 200);
  const pane = { id: 'fp', html: PARENT_HTML, target: 'main', params: {}, pane_state: {} };
  await shell.frame(helloFrame({ mounts: [{ ...pane }] }));
  await shell.tick();
  assert.ok(W.__apis && W.__apis.fp, 'the pane script ran with its api');

  // The realm stamp on the pane's bare fetch, in the real chrome.
  await W.__fetches.fp('/api/probe');
  const probe = shell.calls.filter((c) => c.url === '/api/probe').pop();
  assert.ok(probe, 'the probe was sent');
  assert.strictEqual(stampOf(probe), 'fp', 'a pane script\'s bare fetch carries its mount id');

  const spawned = await W.__apis.fp.spawn({ id: 'fp-kid', html: '<i>kid</i>' });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  assert.strictEqual(forwarded.filter((f) => f.url === '/api/pane/spawn').pop().stamp, 'fp');
  let mounts = (await client.get('/api/mounts', { port, noSpawn: true })).mounts;
  assert.strictEqual(mounts.find((m) => m.id === 'fp-kid').owner, 'pane:fp');

  // A reload of the chrome: every pane is mounted afresh (a new script run, a
  // new facade). The stamp comes from the bound id, so close still works.
  shell.socket().receive({ type: 'reset', mounts: [{ ...pane }], store: {}, active: 'n1' });
  await shell.tick();
  const closed = await W.__apis.fp.close('fp-kid');
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.strictEqual(forwarded.filter((f) => f.url === '/api/pane/close').pop().stamp, 'fp');
  mounts = (await client.get('/api/mounts', { port, noSpawn: true })).mounts;
  assert.ok(!mounts.some((m) => m.id === 'fp-kid'), 'the child is gone');
});
