'use strict';
// The lean element projection (PLAN 2A.3, U304; readiness R2 §3 row 3, S-17):
// lib/server/domain/element-projection leanElements / surfaceOf, the hello and
// reset that carry them (lib/server/ws.js), their per-socket projection
// (lib/core/remote-policy projectSnapshot), and GET /api/graph/node/:id's
// `lean_elements` (a previewed node's rows, anchors converted by the daemon).
//
// A row is {id, v, type, anchor, shared, replies, answered}: never a text
// body, a reply's text, or a writer or provenance sibling. The anchors are the
// log's (the version's payload.anchor), so GT-20's "hello byte-equal under the
// ledger projection" is read off the element log here, row for row.
//
// The servers are real (withServer) and so are the sockets; the remote levels
// come from a sandboxed tunnel.json opt-in, a network peer is basic (Q9).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { withServer, tmpRoot, waitUntil, wsConnect } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const { convertAnchor, SCHEMAS } = require('../lib/core/element-log');
const { setRefs } = require('../lib/server/domain/element-refs');
const { leanElements, surfaceOf } = require('../lib/server/domain/element-projection');
const { projectSnapshot, TEXT_RULES, PRIVATE_RULES } = require('../lib/core/remote-policy');
const client = require('../lib/client');

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const PEER = Object.freeze({ 'x-test-peer': '10.0.0.9' });

// Every text the fixture writes: none may reach a frame or a row.
const T = Object.freeze({
  legacy: 'wc-u304-legacy-pin-text',
  engine: 'wc-u304-engine-pin-text',
  priv: 'wc-u304-private-pin-text',
  answered: 'wc-u304-answered-pin-text',
  userReply: 'wc-u304-user-reply-text',
  claudeReply: 'wc-u304-claude-reply-text',
  note: 'wc-u304-highlight-note-text',
});
const ROW_KEYS = ['anchor', 'answered', 'id', 'replies', 'shared', 'type', 'v'];
// The anchors' text: a marker no pane's HTML holds, so a frame that carries an
// anchor is told from one that carries the page.
const LEAD = 'wc-u304-anchor-head';
const LEGACY = Object.freeze({ mount: 'm-a', selector: 'p.lead', text: LEAD, ordinal: 0 });
// An anchor record of the engine's own (lib/core/anchors.js record), stored as given.
const ENGINE = Object.freeze({
  v: 1, kind: 'element', mount: 'm-a', at: { path: [0, 0], sib: 0 },
  fp: { tag: 'p', id: null, cls: ['lead'], head: LEAD, attrs: [], parent: 'section' }, rows: [],
});
const schemaOf = (type) => Object.keys(SCHEMAS).find((k) => SCHEMAS[k].type === type);

async function ok(p, what) {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}

// A network peer's upgrade (spec §10.1): its remoteAddress stubbed.
function stubPeers(server) {
  const onUpgrade = (req) => {
    const addr = req.headers['x-test-peer'];
    if (addr) Object.defineProperty(req.socket, 'remoteAddress', { value: addr, configurable: true });
  };
  server.prependListener('upgrade', onUpgrade);
  return () => server.off('upgrade', onUpgrade);
}

// One server; `level` 'read' or 'full' opts this project in (a remote viewer's
// level), anything else leaves it opted out (a remote viewer is basic).
async function boot(t, level) {
  const root = tmpRoot('wc-u304-');
  const opts = { root };
  if (level === 'read' || level === 'full') {
    opts.seed = () => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(root)]: level } } });
  }
  const d = await withServer(t, opts);
  t.after(stubPeers(d.server));
  d.call = (method, p, body, headers) => client.request(d.port, method, p, body, { headers, timeout: 10000 });
  return d;
}

// A socket that records every frame; resolves once its hello is in.
async function socket(t, port, headers) {
  const ws = wsConnect(port, '/ws', headers ? { headers } : undefined);
  t.after(() => { try { ws.terminate(); } catch {} });
  const raw = [];
  const frames = [];
  ws.on('message', (d) => { const s = d.toString(); raw.push(s); try { frames.push(JSON.parse(s)); } catch {} });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { timeout: 10000, interval: 5, what: 'the hello' });
  const of = (type) => frames.filter((f) => f.type === type);
  const rawOf = (type) => raw.filter((s, i) => frames[i] && frames[i].type === type);
  return { ws, raw, frames, of, rawOf };
}

const resets = async (socks, n) => waitUntil(() => socks.every((s) => s.of('reset').length >= n),
  { timeout: 10000, interval: 5, what: `reset ${n} on every socket` });

// The fixture: one pane, four pins (a legacy locator, an engine record, a
// private one, one Claude answered) and three references (a shared highlight,
// a private one, one of a type no gate names). Returns their ids.
async function populate(d) {
  const { api, anonApi, srv } = d;
  await ok(api.post('/api/render', { id: 'm-a', html: `<section><p class="lead">Lead of m-a</p></section>` }), 'render');
  const pin = async (text, shared, anchor) => (await ok(anonApi.post('/api/comments', { text, shared, anchor }), `pin ${text}`)).pin;
  const legacy = await pin(T.legacy, true, LEGACY);
  const engine = await pin(T.engine, true, ENGINE);
  const priv = await pin(T.priv, false, LEGACY);
  const answered = await pin(T.answered, true, LEGACY);
  await ok(anonApi.post(`/api/comments/${legacy.id}/reply`, { text: T.userReply }), 'user reply');
  await ok(api.post(`/api/comments/${answered.id}/reply`, { text: T.claudeReply, author: 'claude' }), 'claude reply');
  // The references: highlights and box grabs live in the log alone (E-STORE a);
  // their own units write them, so the log is written here directly.
  const log = srv.elements.log;
  const mint = (type, kind, payload) => {
    const id = log.mintId(type);
    log.ensureElement({ id, kind });
    const rec = log.appendVersion({ id, payload, schema: schemaOf(type) });
    return `${id}@${rec.v}`;
  };
  const hl = mint('highlight', 'highlight', { anchor: ENGINE, shared: true, color: 'gold', note: T.note });
  const hlPriv = mint('highlight', 'highlight', { anchor: ENGINE, shared: false, color: 'rust', note: null });
  const odd = mint('highlight', 'sticker', { anchor: ENGINE, shared: true, color: 'green', note: null });
  setRefs(srv.state, [hl, hlPriv, odd]);
  return { legacy: legacy.id, engine: engine.id, priv: priv.id, answered: answered.id, hl, hlPriv, odd };
}

const noText = (json, what) => {
  for (const s of Object.values(T)) assert.ok(!json.includes(s), `${what}: no text (${s})`);
  // An anchor's fingerprint has a `text` (64 characters of pane text, as the
  // log holds it); a row has none of its own (ROW_KEYS), and no sibling.
  for (const k of ['"writer"', '"provenance"', '"edited"', '"note"', '"author"']) assert.ok(!json.includes(k), `${what}: no ${k} key`);
};
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

// ── leanElements, alone ─────────────────────────────────────────────────────

test('leanElements over live pins: one row each, the log version\'s anchor, the reply count and answered, no text anywhere', async (t) => {
  const d = await boot(t);
  const ids = await populate(d);
  const { srv } = d;
  const rows = leanElements(srv.state, srv.elements);
  assert.deepStrictEqual(rows.map((r) => r.id), rows.map((r) => r.id).slice().sort(), 'sorted by id');
  for (const r of rows) assert.deepStrictEqual(Object.keys(r).sort(), ROW_KEYS, `${r.id}: exactly the lean keys`);
  const m = byId(rows);
  for (const [id, shared, replies, answered] of [[ids.legacy, true, 1, false], [ids.engine, true, 0, false],
    [ids.priv, false, 0, false], [ids.answered, true, 1, true]]) {
    const live = srv.state.comments.find((c) => c.id === id);
    assert.ok(Number.isInteger(live.v), `${id}: the live pin carries v`);
    assert.deepStrictEqual(m[id], {
      id, v: live.v, type: 'comment', anchor: srv.elements.version(id, live.v).payload.anchor, shared, replies, answered,
    }, id);
  }
  assert.deepStrictEqual(m[ids.legacy].anchor, convertAnchor(LEGACY), 'a legacy locator is drawn converted (pin-locator@1)');
  assert.deepStrictEqual(m[ids.engine].anchor, ENGINE, 'an engine record is drawn as stored');
  noText(JSON.stringify(rows), 'the rows');
});

test('state.elements\' id@v references project with the log\'s type, anchor and shared', async (t) => {
  const d = await boot(t);
  const ids = await populate(d);
  const m = byId(leanElements(d.srv.state, d.srv.elements));
  const [hl, hv] = ids.hl.split('@');
  assert.deepStrictEqual(m[hl], { id: hl, v: Number(hv), type: 'highlight', anchor: ENGINE, shared: true, replies: 0, answered: false });
  assert.equal(m[ids.hlPriv.split('@')[0]].shared, false);
  assert.equal(m[ids.odd.split('@')[0]].type, 'sticker', 'the type is the log\'s element kind');
  // A reference naming a pin is the pin's row; one the log does not hold is
  // an unresolvable row, private (fail closed); a malformed one is skipped.
  const legacyV = d.srv.state.comments.find((c) => c.id === ids.legacy).v;
  setRefs(d.srv.state, [ids.hl, `${ids.legacy}@${legacyV}`, 'h9999@1', 'h9998@0']);
  const again = leanElements(d.srv.state, d.srv.elements);
  assert.equal(again.filter((r) => r.id === ids.legacy).length, 1);
  assert.equal(byId(again)[ids.legacy].type, 'comment');
  assert.deepStrictEqual(byId(again).h9999, { id: 'h9999', v: 1, type: null, anchor: null, shared: false, replies: 0, answered: false });
  assert.equal(byId(again).h9998, undefined, 'a malformed reference (v 0) is skipped');
});

test('a pin the log cannot map carries the converted form of its own copy\'s anchor', async (t) => {
  // No store at all, and a store that holds no such version.
  const pin = { id: 'c50', v: 3, text: T.legacy, shared: true, anchor: { ...LEGACY }, replies: [{ author: 'claude', at: 1, text: T.claudeReply }] };
  const want = { id: 'c50', v: 3, type: 'comment', anchor: convertAnchor(LEGACY), shared: true, replies: 1, answered: true };
  assert.deepStrictEqual(leanElements({ comments: [pin] }, null), [want]);
  assert.deepStrictEqual(leanElements({ comments: [pin] }, { version: () => null }), [want]);
  assert.deepStrictEqual(leanElements({ comments: [{ ...pin, v: undefined }] }, null), [{ ...want, v: null }]);
  // An anchor that cannot be converted (no mount) is null; a page note is null.
  assert.equal(leanElements({ comments: [{ id: 'c51', anchor: { selector: 'p' } }] })[0].anchor, null);
  assert.equal(leanElements({ comments: [{ id: 'c52', anchor: null }] })[0].anchor, null);
  // On the daemon: a live pin whose v the log does not hold.
  const d = await boot(t);
  await populate(d);
  d.srv.state.comments = d.srv.state.comments.concat([{ ...pin, id: 'c999', v: 99 }]);
  assert.deepStrictEqual(byId(leanElements(d.srv.state, d.srv.elements)).c999, { ...want, id: 'c999', v: 99 });
  // Malformed input never throws.
  assert.deepStrictEqual(leanElements(null), []);
  assert.deepStrictEqual(leanElements({ comments: [null, 3, { id: '' }], elements: 'x' }), []);
});

test('surfaceOf: state.surface when a non-negative integer, else 0', () => {
  assert.equal(surfaceOf({}), 0);
  assert.equal(surfaceOf(null), 0);
  assert.equal(surfaceOf({ surface: 7 }), 7);
  for (const bad of [-1, 1.5, '3', NaN, null]) assert.equal(surfaceOf({ surface: bad }), 0, String(bad));
});

// ── the frames ──────────────────────────────────────────────────────────────

test('ledger projection (GT-20): the hello\'s `elements` equals, row for row, the projection read off the element log', async (t) => {
  const d = await boot(t);
  const ids = await populate(d);
  const local = await socket(t, d.port);
  const hello = local.of('hello')[0];
  const log = d.srv.elements;
  const want = [];
  for (const c of d.srv.state.comments) {
    const rec = log.version(c.id, c.v);
    want.push({ id: c.id, v: c.v, type: 'comment', anchor: rec.payload.anchor, shared: rec.payload.shared !== false,
      replies: rec.payload.replies.length, answered: rec.payload.replies.some((r) => r.author === 'claude') });
  }
  for (const ref of [ids.hl, ids.hlPriv, ids.odd]) {
    const [id, v] = ref.split('@');
    const rec = log.version(id, Number(v));
    want.push({ id, v: Number(v), type: log.log.element(id).kind, anchor: rec.payload.anchor, shared: rec.payload.shared !== false, replies: 0, answered: false });
  }
  want.sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.deepStrictEqual(hello.elements, want);
  assert.equal(hello.surface, 0);
  noText(local.rawOf('hello')[0], 'the serialized hello');
});

test('hello and the reset after a Wipe, a Set active and a Branch carry `elements` and `surface`; after Set active the rows are the new active surface\'s pins on that frame', async (t) => {
  const d = await boot(t);
  const { api, anonApi, srv } = d;
  const commit = async (msg) => {
    await ok(api.post('/api/turn-begin', { message: msg }), 'turn-begin');
    return (await ok(api.post('/api/turn-end', { author: 'claude', summary: msg }), 'turn-end')).node_id;
  };
  await ok(api.post('/api/render', { id: 'm-a', html: `<section><p class="lead">Lead of m-a</p></section>` }), 'render');
  const a = (await ok(anonApi.post('/api/comments', { text: T.legacy, shared: true, anchor: LEGACY }), 'pin a')).pin;
  const n0 = await commit('first');
  const b = (await ok(anonApi.post('/api/comments', { text: T.engine, shared: true, anchor: ENGINE }), 'pin b')).pin;
  const n1 = await commit('second');
  const local = await socket(t, d.port);
  assert.deepStrictEqual(local.of('hello')[0].elements.map((r) => r.id).sort(), [a.id, b.id].sort());
  assert.equal(local.of('hello')[0].surface, 0);

  // Set active n0: the reset is frame 1 of n0's surface.
  await ok(api.post('/api/graph/active', { id: n0 }), 'set active');
  await resets([local], 1);
  const r1 = local.of('reset')[0];
  assert.deepStrictEqual(r1.elements.map((r) => r.id), [a.id], 'n0\'s one pin');
  assert.deepStrictEqual(r1.elements, leanElements(srv.state, srv.elements), 'the live surface\'s rows, on that frame');
  const copy = srv.graph.nodes.get(n0).comments.find((c) => c.id === a.id);
  assert.deepStrictEqual(r1.elements[0].anchor, convertAnchor(copy.anchor), 'the node copy\'s anchor, converted');
  assert.equal(r1.surface, 0);

  // A turn on n0 forks it; ⑃ Branch back onto n1's tip (a Set active there).
  await ok(api.post('/api/render', { id: 'm-b', html: '<p>fork</p>' }), 'render fork');
  await commit('fork');
  srv.state.surface = 3; // U311 bumps it on a restore; these frames stamp what it holds
  await ok(api.post('/api/graph/active', { id: n1 }), 'branch');
  await waitUntil(() => local.of('reset').some((f) => f.elements.length === 2), { timeout: 10000, interval: 5, what: 'the branch reset' });
  const r2 = local.of('reset').at(-1);
  assert.deepStrictEqual(r2.elements.map((r) => r.id).sort(), [a.id, b.id].sort());
  assert.deepStrictEqual(r2.elements, leanElements(srv.state, srv.elements));
  assert.equal(r2.surface, 3);

  const before = local.of('reset').length;
  await ok(api.post('/api/graph/wipe', {}), 'wipe');
  await resets([local], before + 1);
  const r3 = local.of('reset').at(-1);
  assert.ok(Array.isArray(r3.elements), 'the wipe\'s reset carries `elements`');
  assert.deepStrictEqual(r3.elements, leanElements(srv.state, srv.elements));
  assert.equal(r3.surface, 3);
  for (const f of [...local.of('hello'), ...local.of('reset')]) noText(JSON.stringify(f), f.type);
});

// ── per socket ──────────────────────────────────────────────────────────────

test('projection: a local socket gets every row; a remote one at full and at read no private row and no row of an unknown type; basic gets no element list and no anchor text', async (t) => {
  const full = await boot(t, 'full');
  const read = await boot(t, 'read');
  const basic = await boot(t);
  const ids = {};
  for (const [name, d] of Object.entries({ full, read, basic })) ids[name] = await populate(d);

  const commit = async (d, msg) => {
    await ok(d.api.post('/api/turn-begin', { message: msg }), 'turn-begin');
    return (await ok(d.api.post('/api/turn-end', { author: 'claude', summary: msg }), 'turn-end')).node_id;
  };
  const check = async (d, name, level) => {
    // The fixture's surface committed as a node, then left and set active
    // again: the reset restores every pin and reference onto the surface.
    const home = await commit(d, 'the fixture');
    const local = await socket(t, d.port);
    const remote = await socket(t, d.port, REMOTE);
    const peer = await socket(t, d.port, PEER);
    const id = ids[name];
    const hid = (ref) => ref.split('@')[0];
    await ok(d.api.post('/api/render', { id: 'm-z', html: '<p>later</p>' }), 'render later');
    await commit(d, 'later');
    d.srv.state.surface = 2;
    await ok(d.api.post('/api/graph/active', { id: home }), 'set active');
    await resets([local, remote, peer], 1);
    const all = [id.legacy, id.engine, id.priv, id.answered, hid(id.hl), hid(id.hlPriv), hid(id.odd)].sort();
    for (const kind of ['hello', 'reset']) {
      const lf = local.of(kind)[0];
      assert.deepStrictEqual(lf.elements.map((r) => r.id).sort(), all, `${name} ${kind}: local, every row`);
      const rf = remote.of(kind)[0];
      if (level === 'basic') {
        assert.equal(rf.elements, undefined, `${name} ${kind}: basic remote, no element list`);
        assert.equal(peer.of(kind)[0].elements, undefined, `${name} ${kind}: a network peer, no element list`);
        assert.ok(!remote.rawOf(kind)[0].includes(LEAD), `${name} ${kind}: no anchor text`);
        assert.ok(!peer.rawOf(kind)[0].includes(LEAD), `${name} ${kind}: no anchor text`);
        assert.equal(rf.surface, kind === 'hello' ? 0 : 2, 'the counter is not text: it stays');
      } else {
        const got = rf.elements.map((r) => r.id);
        for (const gone of [id.priv, hid(id.hlPriv), hid(id.odd)]) assert.ok(!got.includes(gone), `${name} ${kind}: no ${gone}`);
        assert.deepStrictEqual(got.sort(), [id.legacy, id.engine, id.answered, hid(id.hl)].sort(), `${name} ${kind}: the shared rows of known types`);
        assert.equal(peer.of(kind)[0].elements, undefined, `${name} ${kind}: a network peer is basic`);
      }
    }
    // A local socket's frames are the unprojected bytes.
    assert.equal(local.raw[0], JSON.stringify(local.frames[0]));
  };
  await check(full, 'full', 'full');
  await check(read, 'read', 'read');
  await check(basic, 'basic', 'basic');
});

test('projectSnapshot: local the frame itself; read and up less private rows and rows the level may not see (default deny); below read the TEXT_RULES paths, the whole list included', () => {
  const rows = [
    { id: 'c1', v: 1, type: 'comment', anchor: { mount: 'm', fp: { head: LEAD } }, shared: true, replies: 0, answered: false },
    { id: 'c2', v: 1, type: 'comment', anchor: null, shared: false, replies: 0, answered: false },
    { id: 'h3', v: 1, type: 'highlight', anchor: null, shared: true, replies: 0, answered: false },
    { id: 'x4', v: 1, type: 'sticker', anchor: null, shared: true, replies: 0, answered: false },
    { id: 'x5', v: 1, type: null, anchor: null, shared: true, replies: 0, answered: false },
  ];
  const lock = { base: 'n1', message: 'a prompt', session_id: 's', claude_pid: 1, prompt_id: 'p', stale: false };
  for (const type of ['hello', 'reset']) {
    const frame = Object.freeze({ type, store: {}, lock, elements: rows, surface: 4 });
    assert.equal(projectSnapshot(frame, 'local'), frame);
    for (const level of ['read', 'full']) {
      const out = projectSnapshot(frame, level);
      assert.deepStrictEqual(out.elements.map((r) => r.id), ['c1', 'h3'], `${type} ${level}`);
      assert.equal(out.lock, lock, 'the lock stays whole at read');
      assert.equal(out.surface, 4);
    }
    for (const level of ['basic', 'nonsense', undefined]) {
      const out = projectSnapshot(frame, level);
      assert.equal(out.elements, undefined, `${type} ${String(level)}: no list`);
      assert.equal(out.lock.message, undefined);
      assert.equal(out.surface, 4);
    }
    const clean = Object.freeze({ type, elements: [rows[0]] });
    assert.equal(projectSnapshot(clean, 'read'), clean, 'nothing to drop: the frame itself');
    const none = Object.freeze({ type, store: {} });
    assert.equal(projectSnapshot(none, 'full'), none);
    assert.equal(projectSnapshot({ type, elements: 'x' }, 'read').elements, undefined, 'not a list: dropped, never sent');
    assert.ok(TEXT_RULES.frames[type].includes('elements'));
    assert.deepStrictEqual(PRIVATE_RULES.frames[type], ['elements[]']);
  }
  const other = Object.freeze({ type: 'render', elements: rows });
  assert.equal(projectSnapshot(other, 'basic'), other, 'only the two full-surface frames');
  assert.equal(rows.length, 5, 'never mutated');
});

// ── the previewed node ──────────────────────────────────────────────────────

test('GET /api/graph/node/:id: `lean_elements` is leanElements over the node; a local browser gets both rows, lib/client and a remote viewer at read and full the shared one; a pinless node answers []', async (t) => {
  for (const level of ['read', 'full']) {
    const d = await boot(t, level);
    const { api, anonApi, srv, call } = d;
    await ok(api.post('/api/turn-begin', { message: 'empty' }), 'turn-begin');
    await ok(api.post('/api/render', { id: 'm-x', html: '<p>x</p>' }), 'render x');
    const empty = (await ok(api.post('/api/turn-end', { author: 'claude', summary: 'empty' }), 'turn-end')).node_id;
    await ok(api.post('/api/render', { id: 'm-a', html: `<section><p class="lead">Lead of m-a</p></section>` }), 'render');
    const shared = (await ok(anonApi.post('/api/comments', { text: T.legacy, shared: true, anchor: LEGACY }), 'shared')).pin;
    const priv = (await ok(anonApi.post('/api/comments', { text: T.priv, shared: false, anchor: LEGACY }), 'private')).pin;
    await ok(api.post(`/api/comments/${shared.id}/reply`, { text: T.claudeReply, author: 'claude' }), 'claude reply');
    await ok(api.post('/api/turn-begin', { message: 'pins' }), 'turn-begin');
    const id = (await ok(api.post('/api/turn-end', { author: 'claude', summary: 'pins' }), 'turn-end')).node_id;

    const node = srv.graph.nodes.get(id);
    const want = leanElements(node, srv.elements, { node: true });
    assert.deepStrictEqual(want.map((r) => r.id), [shared.id, priv.id].sort());
    for (const r of want) {
      const copy = node.comments.find((c) => c.id === r.id);
      assert.deepStrictEqual(r.anchor, convertAnchor(copy.anchor), `${r.id}: converted by the daemon`);
      assert.deepStrictEqual(Object.keys(r).sort(), ROW_KEYS);
    }
    assert.deepStrictEqual([byId(want)[shared.id].replies, byId(want)[shared.id].answered], [1, true]);

    const browser = await ok(api.get(`/api/graph/node/${id}`), 'browser');
    assert.deepStrictEqual(browser.lean_elements, want, `${level}: a local browser, both rows`);
    noText(JSON.stringify(browser.lean_elements), 'lean_elements');
    const tool = await call('GET', `/api/graph/node/${id}`);
    assert.deepStrictEqual(tool.body.lean_elements, want.filter((r) => r.shared), `${level}: lib/client, the shared row`);
    const remote = await call('GET', `/api/graph/node/${id}`, null, REMOTE);
    assert.equal(remote.status, 200);
    assert.deepStrictEqual(remote.body.lean_elements, want.filter((r) => r.shared), `remote ${level}: the shared row`);

    assert.deepStrictEqual((await ok(api.get(`/api/graph/node/${empty}`), 'pinless')).lean_elements, []);
  }
});

// ── size (GT-08's reading on a fixture: R2 S-17 measured 2.4 % on the real graph) ──

// A seeded generator: pane HTML of a real pane's weight (3–8 KB of markup and
// script), a store of a few KB, and a pin about every other turn (some
// replied to, the oldest removed past five) — the reset of each node measured
// with and without the two new fields.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
function paneHtml(id, bytes, r) {
  const rows = [];
  let out = `<section class="card" id="${id}"><h3 class="lead">Pane ${id}</h3><table class="grid">`;
  while (out.length + rows.join('').length < bytes - 400) {
    rows.push(`<tr><td class="k">row ${rows.length}</td><td class="v">${Math.floor(r() * 1e9).toString(36)} value ${rows.length}</td><td><button data-act="pick" data-i="${rows.length}">Pick</button></td></tr>`);
  }
  return `${out}${rows.join('')}</table><script>root.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => store.set({ ${id.replace(/-/g, '_')}_pick: { seq: Date.now(), i: b.dataset.i } }), { signal: api.signal }));</script></section>`;
}

test('size: on a populated fixture graph, the median reset grows by at most 10 % with the lean projection', async (t) => {
  const d = await boot(t);
  const { api, anonApi, srv } = d;
  const r = rng(304);
  const PANES = ['p-a', 'p-b', 'p-c', 'p-d', 'p-e', 'p-f'];
  const nodes = [];
  const live = [];
  for (let i = 0; i < 24; i++) {
    await ok(api.post('/api/turn-begin', { message: `turn ${i}` }), 'turn-begin');
    const k = 2 + Math.floor(r() * 3);
    for (let j = 0; j < k; j++) {
      const id = PANES[Math.floor(r() * PANES.length)];
      await ok(api.post('/api/render', { id, html: paneHtml(id, 3000 + Math.floor(r() * 5000), r) }), 'render');
    }
    const patch = {};
    for (let j = 0; j < 4; j++) patch[`key_${Math.floor(r() * 12)}`] = { seq: i, note: 'x'.repeat(100 + Math.floor(r() * 400)) };
    await ok(api.post('/api/store', { patch }), 'store');
    if (r() < 0.5) {
      const mount = PANES[Math.floor(r() * PANES.length)];
      if (srv.state.mounts.has(mount)) {
        const pin = (await ok(anonApi.post('/api/comments', {
          text: `note ${i}`, shared: r() < 0.8, anchor: { mount, selector: 'h3.lead', text: `Pane ${mount}`, ordinal: 0 },
        }), 'pin')).pin;
        live.push(pin.id);
        if (r() < 0.4) await ok(api.post(`/api/comments/${pin.id}/reply`, { text: `answer ${i}`, author: 'claude' }), 'reply');
        if (live.length > 5) await ok(anonApi.del(`/api/comments/${live.shift()}`), 'delete');
      }
    }
    const end = await ok(api.post('/api/turn-end', { author: 'claude', summary: `turn ${i}` }), 'turn-end');
    if (end.node_id) nodes.push(end.node_id);
  }
  assert.ok(nodes.length >= 20, `a populated graph: ${nodes.length} nodes`);
  const local = await socket(t, d.port);
  const growth = [];
  let rowsSeen = 0;
  for (const id of nodes) {
    const n = local.of('reset').length;
    await ok(api.post('/api/graph/active', { id }), 'set active');
    await resets([local], n + 1);
    const raw = local.rawOf('reset').at(-1);
    const frame = JSON.parse(raw);
    rowsSeen += frame.elements.length;
    const { elements, surface, ...before } = frame;
    void elements; void surface;
    const base = JSON.stringify(before).length;
    growth.push((raw.length - base) / base);
  }
  growth.sort((a, b) => a - b);
  const median = growth[Math.floor(growth.length / 2)];
  t.diagnostic(`lean projection: ${growth.length} resets, ${rowsSeen} rows in all; median growth ${(median * 100).toFixed(2)} %, max ${(growth.at(-1) * 100).toFixed(2)} %`);
  assert.ok(rowsSeen > 0, 'the fixture holds pins');
  assert.ok(median <= 0.10, `the median reset grows by ${(median * 100).toFixed(2)} % (at most 10 %)`);
});
