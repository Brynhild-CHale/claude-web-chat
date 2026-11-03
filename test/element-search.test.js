// The search add-on (annotation engine 4E.1, U551): GET /api/elements/search,
// a filter over each element's LATEST version in the element log (RULED
// SEARCH@latest (a)), never an all-copies index; private by default (AD5,
// K.5 J2): a private element is never a hit for a reader that does not see
// private records (audience.seesPrivate: a local browser alone).
//
// Who is who, as test/private-routes.test.js has them. A local browser is
// Node's fetch (withServer's `api`: it sends sec-fetch-mode). lib/client (the
// MCP tools, the CLI) sends no fetch metadata. A remote viewer is a loopback
// request carrying X-WC-Remote: 1 at the project's opt-in (basic, read, full)
// seeded into the sandbox's tunnel.json; a network peer is a request whose
// socket address is stubbed to 10.0.0.5 (always basic).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { withServer, tmpRoot, waitUntil, commentBody } = require('../test-support/helpers');
const { findLeaks } = require('../test-support/fake-secrets');
const { mcpTools } = require('../test-support/doc-truth');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths, projectPaths } = require('../lib/core/paths');
const { PRIVATE_RULES, TEXT_RULES, RULES, dropPrivate, stripText } = require('../lib/core/remote-policy');
const { PORTAL_PROTOCOL_VERSION } = require('../lib/core/versions');
const { SCHEMAS } = require('../lib/core/element-log');
const { mountElementRoutes } = require('../lib/server/routes/elements');
const { mountElementSearchRoutes, SNIPPET_MAX } = require('../lib/server/routes/element-search');
const client = require('../lib/client');

const SEARCH = '/api/elements/search';
const ROUTE_KEY = `GET ${SEARCH}`;
const SRC = path.join(__dirname, '..', 'lib', 'server', 'routes', 'element-search.js');
const CHAT = Object.keys(SCHEMAS).find((s) => SCHEMAS[s].type === 'chat-comment');

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const PEER = Object.freeze({ 'x-test-peer': '10.0.0.5' });

const RANGE = (mount, exact = 'Alpha') => ({ v: 1, kind: 'range', mount, quote: { exact, prefix: '', suffix: '' }, pos: { start: 0, end: exact.length } });
const LOCATOR = (mount) => ({ mount, selector: 'p.x', text: 'Alpha paragraph', ordinal: 0 });
const TURN_ANCHOR = Object.freeze({
  v: 1, conversation_id: 'conv-u551', session_id: 'sess-u551', turn_id: 't_7', kind: 'turn',
  quote: { exact: 'Explain the plan', prefix: '', suffix: '' }, fp: { h: '0123456789abcdef', len: 48 }, marks: 0, label: 'turn 3',
});
const HIT_KEYS = ['anchor_label', 'created_at', 'family', 'field', 'home', 'id', 'live', 'seq', 'shared', 'snippet', 'type', 'v'];

// Requests (and upgrades) carrying x-test-peer arrive from that address.
function stubPeers(server) {
  const onRequest = (req, res) => {
    const addr = req.headers['x-test-peer'];
    if (!addr) return;
    Object.defineProperty(req.socket, 'remoteAddress', { value: addr, configurable: true });
    res.once('close', () => { delete req.socket.remoteAddress; });
  };
  server.prependListener('request', onRequest);
  return () => { server.off('request', onRequest); };
}

// Daemons on one sandbox HOME, their remote viewers opted in at nothing
// (basic), `read` and `full`; each with `call` (lib/client's raw request).
async function boot(t, levels = ['basic', 'read', 'full']) {
  const roots = { read: tmpRoot('wc-u551-read-'), full: tmpRoot('wc-u551-full-') };
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, {
    ...TUNNEL, remote: { mirror: { [path.resolve(roots.read)]: 'read', [path.resolve(roots.full)]: 'full' } },
  });
  const out = {};
  let seeded = false;
  for (const level of levels) {
    const opts = level === 'basic' ? {} : { root: roots[level] };
    if (!seeded) { opts.seed = seed; seeded = true; }
    const d = await withServer(t, opts);
    t.after(stubPeers(d.server));
    d.call = (method, p, body, headers) => client.request(d.port, method, p, body, { headers, timeout: 10000 });
    out[level] = d;
  }
  return out;
}

async function ok(p, what) {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text || JSON.stringify(r.json !== undefined ? r.json : r.body)}`);
  return r.json !== undefined ? r.json : r.body;
}
const has = (body, mark) => (typeof body === 'string' ? body : JSON.stringify(body)).includes(mark);
const url = (q, extra = '') => `${SEARCH}?q=${encodeURIComponent(q)}${extra}`;

const render = (api, id) => ok(api.post('/api/render', { id, html: '<p class="x">Alpha paragraph</p>' }), `render ${id}`);
async function addComment(api, text, { shared = true, mount = 'm1' } = {}) {
  return (await ok(api.post('/api/elements', commentBody({ text, shared, anchor: LOCATOR(mount) })), `comment ${text}`)).pin.id;
}
async function addHighlight(api, note, { shared = true, mount = 'm1' } = {}) {
  return (await ok(api.post('/api/elements', { type: 'highlight', anchor: RANGE(mount), payload: { color: 'gold', note, shared } }), `highlight ${note}`)).element.id;
}
async function commit(api, message) {
  await ok(api.post('/api/turn-begin', { message }), 'turn-begin');
  const e = await ok(api.post('/api/turn-end', { author: 'claude', summary: message }), 'turn-end');
  assert.ok(e.node_id, `a node was committed: ${JSON.stringify(e)}`);
  return e.node_id;
}
// lib/client's read (no fetch metadata): the MCP tools' and the CLI's.
const tool = async (d, p) => {
  const r = await client.request(d.port, 'GET', p, null, { timeout: 10000 });
  assert.equal(r.status, 200, `lib/client GET ${p}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

// ── hits by text and by type; the hit's shape ─────────────────────────────

test('hits by text and by type: a shared comment, a highlight note and a reply each found by a word of theirs; field names the match; the snippet holds it; newest first', async (t) => {
  const d = await withServer(t);
  const { api } = d;
  await render(api, 'm1');
  const c = await addComment(api, 'wcsearch zebra comment body');
  const h = await addHighlight(api, 'wcsearch yak note');
  const r = await addComment(api, 'wcsearch plain host');
  await ok(api.post(`/api/elements/${r}/reply`, { text: 'a quokka reply', author: 'user' }), 'reply');

  const byText = await ok(api.get(url('ZEBRA')), 'zebra');
  assert.equal(byText.truncated, false);
  assert.deepStrictEqual(byText.hits.map((x) => [x.id, x.type, x.field]), [[c, 'comment', 'text']], 'case-insensitive, the comment\'s text');
  const hit = byText.hits[0];
  assert.deepStrictEqual(Object.keys(hit).sort(), HIT_KEYS, 'no chain, record, anchor object, writer or provenance rides a hit');
  assert.ok(hit.snippet.includes('zebra'));
  assert.equal(hit.family, 'page');
  assert.equal(hit.shared, true);
  assert.equal(hit.live, true);
  assert.equal(hit.home, null, 'not committed yet');
  assert.equal(hit.v, 1);
  assert.ok(Number.isSafeInteger(hit.seq));
  assert.match(hit.anchor_label, /^m1/);

  const note = await ok(api.get(url('yak')), 'yak');
  assert.deepStrictEqual(note.hits.map((x) => [x.id, x.type, x.field]), [[h, 'highlight', 'note']]);
  assert.ok(note.hits[0].snippet.includes('yak'));
  assert.equal(note.hits[0].live, true, 'a highlight on the surface by its reference');

  const reply = await ok(api.get(url('quokka')), 'quokka');
  assert.deepStrictEqual(reply.hits.map((x) => [x.id, x.field]), [[r, 'replies']]);
  assert.ok(reply.hits[0].snippet.includes('quokka'));
  assert.equal(reply.hits[0].v, 2, 'the latest version: the reply\'s');

  const label = await ok(api.get(url('Alpha paragraph')), 'anchor label');
  assert.deepStrictEqual(label.hits.map((x) => x.field).sort(), ['anchor', 'anchor'], 'the comments\' anchor label (describeAnchor)');

  const all = await ok(api.get(url('wcsearch')), 'every one');
  assert.deepStrictEqual(all.hits.map((x) => x.id), [r, h, c], 'newest first');
  for (let i = 1; i < all.hits.length; i++) assert.ok(all.hits[i - 1].seq > all.hits[i].seq);

  const hl = await ok(api.get(url('wcsearch', '&type=highlight')), '?type=highlight');
  assert.deepStrictEqual(hl.hits.map((x) => x.type), ['highlight'], 'highlights only');
  const cm = await ok(api.get(url('wcsearch', '&type=comment')), '?type=comment');
  assert.deepStrictEqual(cm.hits.map((x) => x.id), [r, c]);

  const nope = await api.get(url('wcsearch', '&type=nope'));
  assert.equal(nope.status, 400);
  assert.equal(nope.json.error, 'unknown element type');
  assert.equal(nope.json.type, 'nope');
  assert.match(nope.json.hint, /GET \/api\/elements\/types/);
});

test('the snippet: at most SNIPPET_MAX characters of the masked field around the first match, … where cut', async (t) => {
  const d = await withServer(t);
  const { api } = d;
  await render(api, 'm1');
  const text = `${'lead '.repeat(80)}needleword${' tail'.repeat(80)}`;
  await addComment(api, text);
  const b = await ok(api.get(url('needleword')), 'needle');
  const s = b.hits[0].snippet;
  assert.ok(s.length <= SNIPPET_MAX, `${s.length} ≤ ${SNIPPET_MAX}`);
  assert.ok(s.includes('needleword'));
  assert.ok(s.startsWith('…') && s.endsWith('…'), s);
});

// ── refusals ──────────────────────────────────────────────────────────────

test('refusals: q absent, empty, blank, over 256 characters or holding a bidi override; limit 0, 201 or x; a node or version parameter (the all-copies index refused) — each 400', async (t) => {
  const d = await withServer(t);
  const { api } = d;
  await render(api, 'm1');
  await addComment(api, 'a findable word');
  for (const p of [SEARCH, `${SEARCH}?q=`, `${SEARCH}?q=%20%20`, url('x'.repeat(257)), url('find‮able'), url('find​able'),
    `${SEARCH}?q=a&q=b`, url('find', '&limit=0'), url('find', '&limit=201'), url('find', '&limit=x'), url('find', '&type=')]) {
    const r = await api.get(p);
    assert.equal(r.status, 400, `${p}: ${r.status} ${JSON.stringify(r.json)}`);
    assert.equal(typeof r.json.error, 'string', p);
  }
  assert.equal((await api.get(url('x'.repeat(256)))).status, 200, '256 characters is the bound');
  assert.equal((await api.get(url('find', '&limit=200'))).status, 200);
  for (const extra of ['&node=n1', '&node=', '&v=1', '&versions=1', '&all=1']) {
    const r = await api.get(url('find', extra));
    assert.equal(r.status, 400, extra);
    assert.match(r.json.hint, /latest version; GET \/api\/elements\?node=<stored id> reads one node/, extra);
  }
});

// ── private: never a hit for a reader without seesPrivate ────────────────

test('private: a private comment and highlight are 0 hits for lib/client and the remote read and full viewers; basic and a network peer are 403; the local browser gets both, shared false', async (t) => {
  const d = await boot(t);
  const PC = 'wcu551privcommentmark';
  const PH = 'wcu551privnotemark';
  for (const level of ['basic', 'read', 'full']) {
    const { api } = d[level];
    await render(api, 'm1');
    await addComment(api, `wcu551 shared ${level}`);
    await addComment(api, `wcu551 ${PC}`, { shared: false });
    await addHighlight(api, `wcu551 ${PH}`, { shared: false });
  }
  for (const level of ['basic', 'read', 'full']) {
    const dl = d[level];
    const browser = await ok(dl.api.get(url('wcu551')), `${level}: browser`);
    assert.equal(browser.hits.length, 3, `${level}: the local browser sees all three`);
    const priv = browser.hits.filter((x) => x.shared === false);
    assert.deepStrictEqual(priv.map((x) => x.type).sort(), ['comment', 'highlight'], `${level}: both private hits, shared false`);

    for (const q of [PC, PH, 'wcu551']) {
      const body = await tool(dl, url(q));
      assert.ok(!has(body, PC) && !has(body, PH), `${level}: lib/client q=${q}: no private token anywhere`);
      assert.ok(body.hits.every((x) => x.shared !== false), `${level}: lib/client: no private hit`);
      if (q !== 'wcu551') assert.deepStrictEqual(body, { hits: [], truncated: false }, `${level}: lib/client q=${q}`);
    }

    for (const q of [PC, PH, 'wcu551']) {
      const remote = await dl.call('GET', url(q), null, REMOTE);
      if (level === 'basic') {
        assert.equal(remote.status, 403, 'remote basic: refused before anything is read');
      } else {
        assert.equal(remote.status, 200, `${level}: ${JSON.stringify(remote.body)}`);
        assert.ok(remote.body.hits.every((x) => x.shared !== false));
        if (q !== 'wcu551') assert.deepStrictEqual(remote.body.hits, [], `${level} remote q=${q}`);
        else assert.equal(remote.body.hits.length, 1, `${level} remote: the shared comment alone`);
      }
      assert.ok(!has(remote.body, PC) && !has(remote.body, PH), `${level} remote q=${q}: no private token`);

      const peer = await dl.call('GET', url(q), null, PEER);
      assert.equal(peer.status, 403, `${level}: a network peer is always basic`);
      assert.ok(!has(peer.body, PC) && !has(peer.body, PH) && !has(peer.body, 'wcu551 shared'));
    }
  }
});

test('X-14: a shared comment committed into a node, then made private (a new version) — 0 hits for lib/client and the remote read viewer although the node\'s copy is still shared; the local browser gets the new version, live', async (t) => {
  const { read: d } = await boot(t, ['read']);
  const { api } = d;
  const TOKEN = 'wcu551xfourteenmark';
  await render(api, 'm1');
  const id = await addComment(api, `${TOKEN} once shared`);
  const n = await commit(api, 'commit the shared copy');
  const before = await tool(d, url(TOKEN));
  assert.deepStrictEqual(before.hits.map((x) => [x.id, x.v, x.home]), [[id, 1, n]], 'shared: found, its home the node');

  await ok(api.patch(`/api/elements/${id}`, { shared: false }), 'make it private');
  const after = await tool(d, url(TOKEN));
  assert.deepStrictEqual(after, { hits: [], truncated: false }, 'lib/client: the latest version is private');
  const remote = await d.call('GET', url(TOKEN), null, REMOTE);
  assert.equal(remote.status, 200);
  assert.deepStrictEqual(remote.body, { hits: [], truncated: false }, 'the remote read viewer: 0 hits');
  assert.ok(!has(remote.body, TOKEN));

  const browser = await ok(api.get(url(TOKEN)), 'browser');
  assert.equal(browser.hits.length, 1);
  assert.equal(browser.hits[0].id, id);
  assert.equal(browser.hits[0].v, 2, 'the new version');
  assert.equal(browser.hits[0].shared, false);
  assert.equal(browser.hits[0].live, true);
  assert.equal(browser.hits[0].home, null, 'v2 is not committed');
});

test('the limit and truncated never count a private element', async (t) => {
  const { read: d } = await boot(t, ['read']);
  const { api } = d;
  await render(api, 'm1');
  for (let i = 0; i < 3; i++) await addComment(api, `wcu551limit shared ${i}`);
  // The private ones are the newest: they would take the first places.
  for (let i = 0; i < 2; i++) await addComment(api, `wcu551limit private ${i}`, { shared: false });

  const t3 = await tool(d, url('wcu551limit', '&limit=3'));
  assert.equal(t3.hits.length, 3);
  assert.equal(t3.truncated, false, 'lib/client: the private two neither take a place nor set truncated');
  assert.ok(t3.hits.every((x) => x.shared));
  const t2 = await tool(d, url('wcu551limit', '&limit=2'));
  assert.equal(t2.hits.length, 2);
  assert.equal(t2.truncated, true, 'a visible third is truncation');
  const remote = await d.call('GET', url('wcu551limit', '&limit=3'), null, REMOTE);
  assert.equal(remote.body.hits.length, 3);
  assert.equal(remote.body.truncated, false);

  const b3 = await ok(api.get(url('wcu551limit', '&limit=3')), 'browser');
  assert.equal(b3.hits.length, 3);
  assert.equal(b3.truncated, true, 'the local browser: five match');
  assert.deepStrictEqual(b3.hits.slice(0, 2).map((x) => x.shared), [false, false], 'newest first');
  const b5 = await ok(api.get(url('wcu551limit', '&limit=5')), 'browser 5');
  assert.equal(b5.truncated, false);
});

test('learned later (C-13): a value the redactor learns after the write never matches its raw text, and no fragment of it rides a hit', async (t) => {
  const d = await withServer(t);
  const { api } = d;
  await render(api, 'm1');
  const V = 'wcU551learnedSecretValue42';
  const id = await addComment(api, `pelican note with ${V} inside`);
  assert.equal((await tool(d, url(V))).hits.length, 1, 'before the redactor learns it: found');
  fs.writeFileSync(projectPaths(d.root).captureToken, V + '\n');
  await waitUntil(async () => (await tool(d, url(V))).hits.length === 0, { timeout: 6000, what: 'the redactor learned the value' });
  const browser = await ok(api.get(url(V)), 'browser');
  assert.deepStrictEqual(browser.hits, [], 'masked for the local browser too: the match is over masked text');
  const other = await tool(d, url('pelican'));
  assert.deepStrictEqual(other.hits.map((x) => x.id), [id]);
  const fakes = [{ id: 'learned', rule: 'capture-token', secrets: [V] }];
  assert.deepStrictEqual(findLeaks(other, fakes), [], 'no fragment of the learned value in the body');
  assert.deepStrictEqual(findLeaks(await ok(api.get(url('pelican')), 'browser pelican'), fakes), []);
});

// ── the chat family ─────────────────────────────────────────────────────

test('chat-comment: found by its text with family chat and live true; private, 0 hits for lib/client; deleted (the drop), 0 hits; the mirror is never asked', async (t) => {
  const d = await withServer(t);
  const { api, srv } = d;
  const store = srv.graph.elements;
  const payload = (text, shared = true) => ({ text, shared, replies: [], anchor: TURN_ANCHOR, chain: [] });
  const shared = store.addElement({ type: 'chat-comment', schema: CHAT, payload: payload('wcu551chat heron shared'), author: 'user' });
  store.addElement({ type: 'chat-comment', schema: CHAT, payload: payload('wcu551chat ibis private', false), author: 'user' });

  // The search over a ctx whose mirror is a spy: every read of ctx.mirror
  // and every resolveAnchors call counted.
  let mirrorReads = 0;
  let resolves = 0;
  const spyMirror = { resolveAnchors: async () => { resolves += 1; return { unavailable: true }; } };
  const ctx = {
    state: srv.state, bus: srv.bus, audience: srv.audience, writers: srv.writers, graph: srv.graph, elementTypes: srv.elementTypes,
    get mirror() { mirrorReads += 1; return spyMirror; },
  };
  const app = express();
  app.use(express.json());
  mountElementRoutes(app, ctx);
  mountElementSearchRoutes(app, ctx);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  mirrorReads = 0;
  resolves = 0;

  const viaSpy = await fetch(`http://127.0.0.1:${port}${url('heron')}`);
  const sb = await viaSpy.json();
  assert.deepStrictEqual(sb.hits.map((x) => [x.id, x.type, x.family, x.live, x.field]), [[shared.id, 'chat-comment', 'chat', true, 'text']]);
  assert.equal(sb.hits[0].home, null, 'a chat element is never on a node');
  assert.equal(sb.hits[0].anchor_label, 'on turn 3');
  const anchorHit = await (await fetch(`http://127.0.0.1:${port}${url('on turn 3')}`)).json();
  assert.equal(anchorHit.hits.length, 2, 'both chat pins by their anchor label (the local browser sees the private one)');
  const privTool = await client.request(port, 'GET', url('ibis'), null, { timeout: 10000 });
  assert.deepStrictEqual(privTool.body, { hits: [], truncated: false }, 'a private chat pin: 0 hits for lib/client');
  assert.equal((await (await fetch(`http://127.0.0.1:${port}${url('ibis')}`)).json()).hits.length, 1, 'the local browser sees it');
  assert.equal(mirrorReads, 0, 'the search never reads ctx.mirror');
  assert.equal(resolves, 0, 'never resolveAnchors');

  // The daemon's own route, same answers.
  assert.equal((await ok(api.get(url('heron')), 'daemon')).hits[0].family, 'chat');
  await ok(api.del(`/api/elements/${shared.id}`), 'delete the chat pin');
  assert.ok(store.dropped(shared.id), 'the drop record');
  assert.deepStrictEqual((await ok(api.get(url('heron')), 'after the drop')).hits, [], 'a dropped chat element is no hit');
});

// ── the per-type gate ─────────────────────────────────────────────────────

test('per-type gate: a type whose see is full — the remote read viewer gets no hit without ?type= and 403 with it; the full viewer gets it', async (t) => {
  const d = await boot(t, ['read', 'full']);
  const stubTypes = {
    listed: (type) => type === 'highlight',
    gate: (type) => (type === 'highlight' ? { see: 'full', send: 'full' } : null),
    descriptor: () => null,
    list: () => [{ type: 'highlight' }],
  };
  const at = {};
  for (const level of ['read', 'full']) {
    const { srv, api } = d[level];
    await render(api, 'm1');
    await addHighlight(api, 'wcu551gate heron note');
    await addComment(api, 'wcu551gate comment');
    const ctx = { state: srv.state, bus: srv.bus, audience: srv.audience, writers: srv.writers, graph: srv.graph, elementTypes: stubTypes };
    const app = express();
    app.use(express.json());
    mountElementSearchRoutes(app, ctx);   // mounted first: the resolver is read per request
    mountElementRoutes(app, ctx);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    at[level] = (p) => client.request(server.address().port, 'GET', p, null, { headers: REMOTE, timeout: 10000 });
  }
  const r = await at.read(url('wcu551gate'));
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.body.hits.map((x) => x.type), ['comment'], 'read: no highlight hit');
  assert.ok(!has(r.body, 'heron'));
  const rt = await at.read(url('wcu551gate', '&type=highlight'));
  assert.equal(rt.status, 403, 'read: the type\'s own gate');
  assert.ok(!has(rt.body, 'heron'));
  const f = await at.full(url('wcu551gate'));
  assert.deepStrictEqual(f.body.hits.map((x) => x.type), ['comment', 'highlight'], 'full: both, newest first');
  assert.equal((await at.full(url('heron', '&type=highlight'))).body.hits.length, 1);
});

test('a mount with no element routes answers 503; the mount refuses a ctx with no element store or audience', async (t) => {
  const d = await withServer(t);
  assert.throws(() => mountElementSearchRoutes(express(), { audience: d.srv.audience, graph: {} }), TypeError);
  assert.throws(() => mountElementSearchRoutes(express(), { graph: d.srv.graph }), TypeError);
  const app = express();
  mountElementSearchRoutes(app, { state: d.srv.state, audience: d.srv.audience, graph: d.srv.graph });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const r = await client.request(server.address().port, 'GET', url('x'), null, { timeout: 10000 });
  assert.equal(r.status, 503);
});

// ── SEARCH@latest: a deleted page element is still found ─────────────────

test('SEARCH@latest: a deleted page element is still found, live false, its home the node that first committed it', async (t) => {
  const d = await withServer(t);
  const { api } = d;
  await render(api, 'm1');
  const c = await addComment(api, 'wcu551gone comment');
  const h = await addHighlight(api, 'wcu551gone note');
  const n = await commit(api, 'commit both');
  await ok(api.del(`/api/elements/${c}`), 'delete the comment');
  await ok(api.del(`/api/elements/${h}`), 'delete the highlight');
  const b = await tool(d, url('wcu551gone'));
  const byId = Object.fromEntries(b.hits.map((x) => [x.id, x]));
  assert.deepStrictEqual(Object.keys(byId).sort(), [c, h].sort());
  for (const id of [c, h]) {
    assert.equal(byId[id].live, false, `${id}: off the surface`);
    assert.equal(byId[id].home, n, `${id}: its home`);
  }
});

// ── structure: never an all-copies index ─────────────────────────────────

test('the all-copies index refused, structurally: the module names no node-copy read, no excerpt and no mirror; the resolver is elements.js\'s, published once', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  for (const name of ['elementsForNode', 'versionsOf', 'byHash', 'bySeq', 'pinsOf', 'commitOf', 'answersOf', 'core/excerpts', 'excerpt', 'ctx.mirror', 'node.comments', 'node.elements']) {
    assert.ok(!src.includes(name), `element-search.js names ${name}`);
  }
  assert.ok(!/graph\.nodes\.(?:values|keys|entries|forEach)\b|of\s+graph\.nodes\b|\.\.\.\s*graph\.nodes\b/.test(src), 'no iteration of graph.nodes');
  assert.ok(!/function\s+typeInfo\b|typeInfo\s*=\s*\(/.test(src), 'no second typeInfo');
  assert.ok(src.includes('ctx.elementGates'), 'the resolver read through ctx.elementGates');
  const elements = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'routes', 'elements.js'), 'utf8');
  const published = elements.match(/ctx\.elementGates\s*=/g) || [];
  assert.equal(published.length, 1, 'published once, from mountElementRoutes');
  assert.match(elements, /ctx\.elementGates = Object\.freeze\(\{ typeInfo, infoOf, allTypes, passes, meets \}\)/);
});

// ── the tables ────────────────────────────────────────────────────────────

test('the tables: PRIVATE_RULES.routes and TEXT_RULES.routes key the route; dropPrivate and stripText over a sample; no new portal row; the protocol and the tool set unchanged', () => {
  assert.deepStrictEqual(PRIVATE_RULES.routes[ROUTE_KEY], ['hits[]']);
  assert.deepStrictEqual(TEXT_RULES.routes[ROUTE_KEY], ['hits']);
  const SHARED_HIT = Object.freeze({ id: 'c1', type: 'comment', shared: true, snippet: 'a shared word' });
  const PRIVATE_HIT = Object.freeze({ id: 'c2', type: 'comment', shared: false, snippet: 'a private word' });
  const body = Object.freeze({ hits: Object.freeze([SHARED_HIT, PRIVATE_HIT]), truncated: false });
  assert.deepStrictEqual(dropPrivate('routes', ROUTE_KEY, body), { hits: [SHARED_HIT], truncated: false });
  const stripped = stripText('routes', ROUTE_KEY, body);
  assert.ok(!has(stripped, 'word'), `below read the hits go: ${JSON.stringify(stripped)}`);
  assert.equal(stripped.truncated, false);
  const portalRows = RULES.filter((r) => r.path === SEARCH);
  assert.equal(portalRows.length, 1, 'the portal\'s one row (element-policy FLOOR_RULES), declared before this unit');
  assert.equal(portalRows[0].mirror, 'read');
  assert.equal(PORTAL_PROTOCOL_VERSION, 12);
  assert.equal(mcpTools().length, 24);
});
