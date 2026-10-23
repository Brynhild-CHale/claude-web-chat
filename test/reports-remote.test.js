// The report path's remote half (annotation engine PLAN.md 2B.1; DECISIONS.md
// A3, E2; U312): the `elements` answer kind (lib/server/domain/reports-remote,
// registered from reports.js start()), driven against a real daemon
// (withServer) and, for the answer host, through a REAL portal (withPortal,
// test/portal-answer.test.js's pattern) found through the real registry.
//
//   * the kind: the document (Sec-Fetch-Dest iframe → 200, <html
//     data-kind="elements">, a nonce); any other rest or layout 404; an image
//     load 403 dest;
//   * at full (the opt-in written into the sandbox HOME's tunnel.json before
//     boot; X-WC-Remote on loopback): a batch with the document's nonce → 200
//     {ok, accepted}, held with source {peer: 'remote', device}; without the
//     nonce 403; from a local request 403 'local'; a 70 KB body refused by the
//     kit; below full the engine's lock, and the kind's own level check
//     (ANSWER_HINT) behind it;
//   * B6 for the remote half: a batch echoing the pre-Set-active surface is
//     refused stale-surface, with the new surface accepted;
//   * the viewer (K.2-56): a per-tab id rides the document's query and the
//     body; an equal key from the same id replaces, another viewer's never;
//   * no main-port path: POST /api/elements/report answers 404, local and remote;
//   * through a real portal at full: the document and elements-report.js load
//     at the answer host and a report lands with source remote; at read every
//     elements route is 403 with ANSWER_HINT and nothing reaches the surface.
// No real tunnel or Cloudflare runs here: E3's tunnel check is the maintainer's.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');

const { withServer, withPortal, withTempHome, tmpRoot, commentBody } = require('../test-support/helpers');
const { createFakeAccess } = require('../test-support/fake-access');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const { ANSWER_HINT } = require('../lib/core/remote-policy');
const { registerInstance, instanceId } = require('../lib/util/registry');
const { answerHost } = require('../lib/tunnel/config');
const { createReports } = require('../lib/server/domain/reports');
const { registerRemoteReports, LOCAL_HINT, KEEP_ALIVE_MS } = require('../lib/server/domain/reports-remote');
const client = require('../lib/client');

const REMOTE = { 'x-wc-remote': '1' };
const NAV = { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-site' };
const VIEWER = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';

function req(port, { method = 'GET', path: p = '/', headers = {}, body = null, raw = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw != null ? raw : body == null ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false,
      headers: { ...(data != null ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

async function ok(p, what) {
  const r = await p;
  assert.ok(r.status === 200 && (!r.json || r.json.ok !== false), `${what}: ${r.status} ${r.text}`);
  return r.json;
}

async function commit(api, msg) {
  await ok(api.post('/api/turn-begin', { message: msg }), 'turn-begin');
  return (await ok(api.post('/api/turn-end', { author: 'claude', summary: msg }), 'turn-end')).node_id;
}

async function pinOn(d, mount) {
  const r = await ok(d.anonApi.post('/api/elements', commentBody({ text: 'a note', shared: true, anchor: { mount, selector: 'p', text: 'x' } })), `pin on ${mount}`);
  return { id: r.pin.id, v: r.pin.v };
}

const tunnel = (root, level) => createFakeAccess().config({
  remote: { allowDestructive: false, ...(level ? { mirror: { [path.resolve(root)]: level } } : {}) },
});

// A daemon whose project is opted in at `level`, with its answer surface up.
async function boot(t, level = 'full') {
  const root = tmpRoot('wc-reports-remote-');
  const d = await withServer(t, { root, seed: () => writeJsonAtomic(userPaths().tunnelConfig, tunnel(root, level)) });
  const call = { port: d.port, noSpawn: true, timeout: 10000 };
  await client.get('/api/asks?ensure=1', call);
  const health = await client.get('/api/health', call);
  assert.ok(health.answer && Number.isInteger(health.answer.port), 'the answer surface listens');
  const aport = health.answer.port;
  const origin = `http://127.0.0.1:${aport}`;
  const nonceOf = (r) => { const m = /name="wc-answer-nonce" content="([^"]*)"/.exec(r.text || ''); return m ? m[1] : null; };
  const out = {
    ...d, aport, origin,
    doc: (query = 'layout=report&mode=light&device=mobile', headers = {}) =>
      req(aport, { path: `/answer/elements/report?${query}`, headers: { 'sec-fetch-dest': 'iframe', ...headers } }),
    async nonce(query, headers) {
      const r = await out.doc(query, headers);
      assert.equal(r.status, 200, r.text);
      return nonceOf(r);
    },
    post: (nonce, body, headers = {}) => req(aport, {
      method: 'POST', path: '/answer/api/elements/report',
      headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(nonce ? { 'x-wc-answer': nonce } : {}), ...headers },
      body,
    }),
    nonceOf,
  };
  return out;
}

// A pane with a pin on it, and one report naming the pin.
async function seeded(d) {
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  const pin = await pinOn(d, 'p1');
  const batch = (surface = d.srv.reports.surface(), state = 'exact') =>
    ({ surface, mounts: [{ mount: 'p1', gen: d.srv.state.mounts.get('p1').gen || 0, items: [{ id: pin.id, v: pin.v, state }] }] });
  return { pin, batch };
}

const stats = (d) => d.srv.reports.stats();

// ── the kind's document ─────────────────────────────────────────────────────

test('the document: iframe → 200, data-kind elements and a nonce; another rest or layout 404; an image load 403 dest, counted', async (t) => {
  const d = await boot(t);
  const r = await d.doc();
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /<html[^>]*data-kind="elements"/);
  assert.ok(d.nonceOf(r), 'a nonce in the meta');
  for (const p of ['/answer/elements/other?layout=report', '/answer/elements/report?layout=bar', '/answer/elements/report', '/answer/elements?layout=report']) {
    const x = await req(d.aport, { path: p, headers: { 'sec-fetch-dest': 'iframe' } });
    assert.equal(x.status, 404, `${p}: ${x.text}`);
    assert.doesNotMatch(x.text, /wc-answer-nonce/, `${p}: no nonce`);
  }
  const img = await d.doc(undefined, { 'sec-fetch-dest': 'image' });
  assert.equal(img.status, 403);
  assert.equal(img.json.refused, 'dest');
  assert.equal(stats(d).refused.dest, 1, 'the engine\'s refusal counted into the reports\' refused');
  const getApi = await req(d.aport, { path: '/answer/api/elements/report', headers: { 'x-wc-answer': d.nonceOf(r), 'sec-fetch-site': 'same-origin' } });
  assert.equal(getApi.status, 403, 'a GET of the API has no nonce key: refused');
});

// ── at full ─────────────────────────────────────────────────────────────────

test('at full: a remote batch with the document\'s nonce is accepted and held with source {peer: remote, device}; the answer is counts only', async (t) => {
  const d = await boot(t);
  const { pin, batch } = await seeded(d);
  const nonce = await d.nonce(undefined, REMOTE);
  const r = await d.post(nonce, { reports: [batch()], device: 'mobile' }, REMOTE);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, accepted: 1, confirmed: 0, refused: {} });
  const [a] = d.srv.reports.answers({ mount: 'p1' });
  assert.equal(a.id, pin.id);
  assert.equal(a.state, 'exact');
  assert.deepEqual(a.source, { peer: 'remote', device: 'mobile' });
  assert.equal(a.surface, d.srv.reports.surface());
  assert.equal(stats(d).accepted, 1);
  // The device falls back to the request's query, else null.
  const r2 = await d.post(nonce, { reports: [batch(undefined, 'orphaned')] }, REMOTE);
  assert.equal(r2.json.accepted, 1);
  assert.equal(d.srv.reports.answers({ mount: 'p1' })[0].source.device, null);
  // A bad shape is a 400, counted.
  for (const body of [{}, { reports: [] }, { reports: 'x' }, { reports: Array(9).fill(batch()) }]) {
    const x = await d.post(nonce, body, REMOTE);
    assert.equal(x.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(x.json.refused, 'shape');
  }
  assert.equal(stats(d).refused.shape, 4);
});

test('refused, moving nothing: without the nonce, from a local request (\'local\'), and a 70 KB body (the kit)', async (t) => {
  const d = await boot(t);
  const { batch } = await seeded(d);
  const nonce = await d.nonce(undefined, REMOTE);
  const none = await d.post(null, { reports: [batch()] }, REMOTE);
  assert.equal(none.status, 403);
  assert.equal(none.json.refused, 'nonce');
  const wrong = await d.post('not-a-nonce', { reports: [batch()] }, REMOTE);
  assert.equal(wrong.status, 403);
  const local = await d.post(nonce, { reports: [batch()] });
  assert.equal(local.status, 403, local.text);
  assert.deepEqual(local.json, { ok: false, refused: 'local', hint: LOCAL_HINT });
  // Over the kit's 64 KB the engine stops reading and drops the socket, so the
  // 413 may or may not reach the client (test/isolated-origin.test.js): what is
  // pinned is that nothing came through.
  const big = { reports: [batch()], pad: 'x'.repeat(70 * 1024) };
  const tooBig = await d.post(nonce, big, REMOTE).catch(() => null);
  assert.ok(tooBig === null || tooBig.status === 413, tooBig && tooBig.text);
  assert.equal(stats(d).held, 0, 'nothing held');
  assert.equal(stats(d).accepted, 0);
  assert.ok(stats(d).refused.nonce >= 2 && stats(d).refused.local === 1, JSON.stringify(stats(d).refused));
});

test('below full: at read the engine\'s lock refuses the remote document and report, nothing held; the kind checks the level again (ANSWER_HINT)', async (t) => {
  const d = await boot(t, 'read');
  const { batch } = await seeded(d);
  const nonce = await d.nonce(); // a local load
  const doc = await d.doc(undefined, REMOTE);
  assert.equal(doc.status, 403);
  assert.equal(doc.json.remote, true);
  const r = await d.post(nonce, { reports: [batch()] }, REMOTE);
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.remote, true);
  assert.match(r.json.error, /claude-web-chat tunnel mirror on/);
  assert.equal(stats(d).held, 0);
  assert.equal(stats(d).refused.remote, 1, `the report's refusal counted: ${JSON.stringify(stats(d).refused)}`);

  // The kind's own check behind the lock: a remote request below full.
  let spec = null;
  const off = registerRemoteReports({
    accept: () => { throw new Error('never reached'); },
    answerSurface: { register: (kind, s) => { spec = { kind, ...s }; return () => {}; } },
    audience: { peerOf: () => 'remote', levelOf: () => 'read' },
  });
  t.after(off);
  assert.equal(spec.kind, 'elements');
  const sent = [];
  const kit = { json: (res, status, body) => sent.push({ status, body }) };
  spec.api({ method: 'POST', headers: {} }, null, kit, { rest: 'report', query: {}, body: { reports: [batch()] } });
  assert.deepEqual(sent, [{ status: 403, body: { ok: false, refused: 'mirror', hint: ANSWER_HINT } }]);
});

// ── B6, the viewer, the keep-alive ──────────────────────────────────────────

test('B6 for the remote half: a batch echoing the pre-Set-active surface is refused stale-surface; with the new surface accepted', async (t) => {
  const d = await boot(t);
  const { batch } = await seeded(d);
  const n0 = await commit(d.api, 'first');
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>two</p>' }), 'render 2');
  await commit(d.api, 'second');
  const s0 = d.srv.reports.surface();
  await ok(d.api.post('/api/graph/active', { id: n0 }), 'set active n0');
  const s1 = d.srv.reports.surface();
  assert.ok(s1 > s0);
  const nonce = await d.nonce(undefined, REMOTE);
  const stale = await d.post(nonce, { reports: [batch(s0)] }, REMOTE);
  assert.equal(stale.status, 200);
  assert.deepEqual(stale.json, { ok: true, accepted: 0, confirmed: 0, refused: { 'stale-surface': 1 } });
  assert.equal(stats(d).held, 0);
  const fresh = await d.post(nonce, { reports: [batch(s1)] }, REMOTE);
  assert.equal(fresh.json.accepted, 1, fresh.text);
  assert.equal(d.srv.reports.answers()[0].surface, s1);
});

test('the viewer (K.2-56): the per-tab id rides the query and the body; the same id replaces at an equal key, another viewer never does', async (t) => {
  const d = await boot(t);
  const { batch } = await seeded(d);
  const mine = await d.nonce(`layout=report&viewer=${VIEWER}`, REMOTE);
  // The nonce is minted for this viewer: a body naming another is refused.
  const cross = await d.post(mine, { reports: [batch()], viewer: OTHER }, REMOTE);
  assert.equal(cross.status, 403);
  assert.equal(cross.json.refused, 'nonce');
  assert.equal((await d.post(mine, { reports: [batch()] }, REMOTE)).status, 403, 'nor one naming none');
  assert.equal((await d.post(mine, { reports: [batch()], viewer: VIEWER }, REMOTE)).json.accepted, 1);
  // Same viewer, equal key: replaces.
  assert.equal((await d.post(mine, { reports: [batch(undefined, 'orphaned')], viewer: VIEWER }, REMOTE)).json.accepted, 1);
  assert.equal(d.srv.reports.answers()[0].state, 'orphaned');
  // A second frame of the same tab (a remount) is the same viewer.
  const again = await d.nonce(`layout=report&viewer=${VIEWER}`, REMOTE);
  assert.equal((await d.post(again, { reports: [batch(undefined, 're-resolved')], viewer: VIEWER }, REMOTE)).json.accepted, 1);
  assert.equal(d.srv.reports.answers()[0].state, 're-resolved');
  // Another tab at an equal key never replaces.
  const theirs = await d.nonce(`layout=report&viewer=${OTHER}`, REMOTE);
  const other = await d.post(theirs, { reports: [batch(undefined, 'exact')], viewer: OTHER }, REMOTE);
  assert.equal(other.json.accepted, 0);
  assert.equal(d.srv.reports.answers()[0].state, 're-resolved', 'the held answer stands');
  assert.equal(stats(d).dropped_items.outranked, 1);
});

test('the seams: start registers the kind once, stop unregisters it; keepAlive is true for five minutes after a report', () => {
  const regs = [];
  let unregistered = 0;
  const surface = { register: (kind, spec) => { regs.push({ kind, spec }); return () => { unregistered += 1; }; } };
  let clock = 1_000_000;
  const state = { mounts: new Map(), markdown: new Map(), store: {} };
  const reports = createReports({ state, graph: null, bus: null, answerSurface: () => surface, audience: () => ({ peerOf: () => 'remote', levelOf: () => 'full' }), now: () => clock });
  reports.start();
  reports.start();
  assert.equal(regs.length, 1);
  assert.equal(regs[0].kind, 'elements');
  const { spec } = regs[0];
  assert.equal(spec.keepAlive(), false, 'no report yet');
  spec.api({ method: 'POST', headers: { 'x-wc-answer': 'n' } }, null, { json: () => {} }, { rest: 'report', query: {}, body: { reports: [{ surface: 1, mounts: [] }] } });
  assert.equal(spec.keepAlive(), true);
  clock += KEEP_ALIVE_MS;
  assert.equal(spec.keepAlive(), false, 'five minutes on');
  spec.onRefused({ code: 'origin' });
  assert.equal(reports.stats().refused.origin, 1);
  assert.equal(spec.nonceKey({ method: 'GET' }, { rest: 'report', body: null }), null);
  assert.equal(spec.nonceKey({ method: 'POST' }, { rest: 'other', body: {} }), null);
  assert.equal(spec.nonceKey({ method: 'POST' }, { rest: 'report', body: {} }), 'elements:report');
  assert.equal(spec.nonceKey({ method: 'POST' }, { rest: 'report', body: { viewer: VIEWER } }), `elements:report:${VIEWER}`);
  assert.equal(spec.nonceKey({ method: 'POST' }, { rest: 'report', body: { viewer: 'short' } }), 'elements:report');
  reports.stop();
  assert.equal(unregistered, 1);
  // No answer surface: nothing registered, nothing thrown.
  const bare = createReports({ state: { mounts: new Map(), markdown: new Map(), store: {} }, graph: null, bus: null });
  bare.start();
  bare.stop();
});

// ── no main-port path ───────────────────────────────────────────────────────

test('no main-port path: POST /api/elements/report answers 404 on the daemon\'s port, local and remote at full', async (t) => {
  const d = await boot(t);
  const { batch } = await seeded(d);
  for (const headers of [{}, REMOTE]) {
    const r = await req(d.port, {
      method: 'POST', path: '/api/elements/report',
      headers: { 'content-type': 'application/json', ...headers }, body: { reports: [batch()] },
    });
    assert.equal(r.status, 404, `${JSON.stringify(headers)}: ${r.status} ${r.text}`);
  }
  assert.equal(stats(d).held, 0);
});

// ── through a real portal ───────────────────────────────────────────────────

async function rig(t, level) {
  withTempHome(t);
  const root = tmpRoot('wc-reports-remote-portal-');
  const access = createFakeAccess();
  const raw = access.config({ remote: { allowDestructive: false, mirror: { [path.resolve(root)]: level } } });
  writeJsonAtomic(userPaths().tunnelConfig, raw);
  const d = await withServer(t, { root, writePortfile: true });
  registerInstance({ root: d.root, port: d.port, pid: process.pid });
  const p = await withPortal(t, { config: raw, fetchJwks: access.fetchJwks });
  const ahost = answerHost(p.config, instanceId(d.root));
  const aorigin = `https://${ahost}`;
  const auth = { 'cf-access-jwt-assertion': access.mint() };
  const A = (pathStr, { method = 'GET', headers = {}, body } = {}) => p.request(pathStr, {
    host: ahost, method, body, headers: { ...auth, ...(body != null ? { 'content-type': 'application/json' } : {}), ...headers },
  });
  return { d, p, A, aorigin };
}

test('through a real portal at full: the document and elements-report.js load at the answer host, and a report lands with source remote', async (t) => {
  const { d, A, aorigin } = await rig(t, 'full');
  const { pin, batch } = await seeded(d);
  // Loaded as the frame's real load from the session's page: a same-site
  // navigation, which the portal's CSRF rule lets through for the elements
  // kind's document (lib/portal/answer.js DOCUMENT_PATH; K.2-73).
  const doc = await A(`/answer/elements/report?layout=report&mode=light&device=mobile&viewer=${VIEWER}`, { headers: NAV });
  assert.equal(doc.status, 200, doc.text.slice(0, 300));
  assert.match(doc.text, /data-kind="elements"/);
  const nonce = /name="wc-answer-nonce" content="([^"]*)"/.exec(doc.text)[1];
  assert.ok(nonce);
  const mod = await A('/answer/elements-report.js', { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'script' } });
  assert.equal(mod.status, 200, mod.text.slice(0, 200));
  assert.match(String(mod.headers['content-type']), /javascript/);
  assert.match(mod.text, /export function mount\(rt\)/);
  const r = await A('/answer/api/elements/report', {
    method: 'POST',
    headers: { origin: aorigin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'x-wc-answer': nonce },
    body: { reports: [batch()], device: 'mobile', viewer: VIEWER },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.accepted, 1);
  const [a] = d.srv.reports.answers({ mount: 'p1' });
  assert.equal(a.id, pin.id);
  assert.deepEqual(a.source, { peer: 'remote', device: 'mobile' });
});

test('through a real portal at full: the frame\'s real load (a same-site navigation from the session\'s page) reaches the document', async (t) => {
  const { A } = await rig(t, 'full');
  const doc = await A('/answer/elements/report?layout=report&mode=light&device=desktop', { headers: NAV });
  assert.equal(doc.status, 200, doc.text.slice(0, 300));
  assert.match(doc.text, /data-kind="elements"/);
});

test('through a real portal at read: every elements route is 403 with ANSWER_HINT, and nothing reaches the answer surface', async (t) => {
  const { d, A, aorigin } = await rig(t, 'read');
  const { batch } = await seeded(d);
  for (const [method, p, headers, body] of [
    ['GET', '/answer/elements/report?layout=report', NAV],
    ['GET', '/answer/elements-report.js', { 'sec-fetch-site': 'same-origin' }],
    ['POST', '/answer/api/elements/report', { origin: aorigin, 'sec-fetch-site': 'same-origin', 'x-wc-answer': 'x' }, { reports: [batch()] }],
  ]) {
    const res = await A(p, { method, headers, body });
    assert.equal(res.status, 403, `${method} ${p}: ${res.text}`);
    assert.deepEqual(res.json, { ok: false, remote: true, hint: ANSWER_HINT, mirror: 'read' }, `${method} ${p}`);
  }
  assert.equal(d.srv.answerSurface.port, null, 'the answer surface was never started');
  assert.equal(stats(d).held, 0);
});
