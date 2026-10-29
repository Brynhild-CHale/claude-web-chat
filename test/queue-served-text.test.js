// The park and the queue's socket frames serve through the read view
// (U463; DECISIONS.md K.2-192, L.10 Z2 = a; the exit gate's C-EX-1, GT-13
// learned-later-served). U460 (K.2-182 g10) put a queued item's words —
// summary, label, members[].words, excerpt[].text — through the redactor at
// serve for GET /api/queue and the ring (domain/queue servedItem). Two more
// paths served them as stored:
//   (1) GET /api/queue/pending: the park's wake envelope (rendered at park
//       time) and each parked item's summary;
//   (2) every `queue` socket frame (an add or an update emitted after the
//       learning), to a local socket and to a remote one at `read`.
// A value put into a pin's quote and note before the redactor knows it, then
// learned (the capture token's file, a known source): no served read of the
// park — the host through lib/client, a local browser, a remote viewer at
// read — and no queue frame after the learning carries a fragment of it.
// (c) the same reads before the learning are the stored text; a message's
// frame and the park's meta are as they were; the stored item and the stored
// park are never rewritten (C1). (d) attachWebSocket with no redactor (a bare
// attach) sends a queue frame as stored. (a) and (b) red at 973c39cc.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { withServer, waitUntil, commentBody, wsConnect } = require('../test-support/helpers');
const { findLeaks } = require('../test-support/fake-secrets');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { projectPaths, userPaths } = require('../lib/core/paths');
const { createRedactor, marksIn } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { createState } = require('../lib/server/state');
const { attachWebSocket } = require('../lib/server/ws');
const queue = require('../lib/server/domain/queue');
const client = require('../lib/client');

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const WAIT = { timeout: 6000 };
const MSG_TEXT = 'wc-u463-message-words-mark';

const learned = (value) => [{ id: 'learned', rule: 'known', secrets: [value] }];
const near = (hay, leaks) => leaks.map((l) => hay.slice(Math.max(0, l.at - 80), l.at + 40)).join(' | ');
function noLeaks(body, value, what) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const leaks = findLeaks(raw, learned(value));
  assert.deepEqual(leaks, [], `${what} holds no fragment of the value: ${near(raw, leaks)}`);
}
// An item's excerpt: one string for a lone member, a list of {id, text} for a group.
const excerptsOf = (it) => (Array.isArray(it.excerpt) ? it.excerpt.map((e) => e && e.text) : typeof it.excerpt === 'string' ? [it.excerpt] : []);
const masked = (s, what) => assert.ok(typeof s === 'string' && marksIn(s).length >= 1, `${what} is served masked: ${JSON.stringify(s)}`);

async function ok(p, what) {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}

// A range anchor cut out of `text` as the chrome cuts one.
function rangeIn(mount, text, exact, at = text.indexOf(exact)) {
  const quote = { exact, prefix: text.slice(Math.max(0, at - 32), at), suffix: text.slice(at + exact.length, at + exact.length + 32) };
  return { v: 1, kind: 'range', mount, quote, pos: { start: at, end: at + exact.length } };
}

// A socket that keeps every frame it gets. Resolves once its hello is in.
async function listen(t, port, headers) {
  const got = [];
  const sock = new WebSocket(`ws://localhost:${port}/ws`, headers ? { headers } : undefined);
  sock.on('message', (data) => { try { got.push(JSON.parse(data.toString())); } catch {} });
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  t.after(() => { try { sock.terminate(); } catch {} });
  await waitUntil(() => got.some((f) => f.type === 'hello'), { ...WAIT, what: 'hello' });
  return got;
}

// The daemon (a remote viewer opted in at `read`), a local and a remote
// socket, two panes, a shared comment pin on one and a highlight on the
// other, each quote and note holding `value`, queued and then parked by a
// Push no channel takes.
async function world(t) {
  let root = null;
  const seed = (s) => { root = s.root; writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(s.root)]: 'read' } } }); };
  const d = await withServer(t, { seed });
  assert.equal(d.root, root);
  const value = `wcpark${crypto.randomBytes(12).toString('hex')}`;
  const text = `The staging key is ${value} until Friday.`;
  const local = await listen(t, d.port);
  const remote = await listen(t, d.port, REMOTE);
  await ok(d.api.post('/api/render', { id: 'qs-a', html: `<p>${text}</p>` }), 'render a');
  await ok(d.api.post('/api/render', { id: 'qs-b', html: `<p>${text}</p>` }), 'render b');
  const anchorA = rangeIn('qs-a', text, `key is ${value}`);
  const pinA = (await ok(d.anonApi.post('/api/elements', commentBody({ text: `note names ${value}`, shared: true, anchor: anchorA })), 'pin a')).element;
  const item = d.srv.state.queue.find((it) => (it.element_ids || [it.element_id]).includes(pinA.id));
  assert.ok(item && JSON.stringify(item).includes(value), 'precondition: the queued item quotes the value as written');
  assert.ok(Array.isArray(item.members) && item.members.some((m) => String(m.words).includes(value)), 'precondition: a member\'s words hold it');
  assert.ok(excerptsOf(item).some((e) => String(e).includes(value)), 'precondition: an excerpt holds it (the switch\'s default, on)');
  // A highlight on pane b, its quote and note holding the value too: a
  // second parked group, the one (b) raises again after the learning.
  const anchorH = rangeIn('qs-b', text, `staging key is ${value}`);
  const hl = (await ok(d.anonApi.post('/api/elements', { type: 'highlight', anchor: anchorH, payload: { color: 'gold', note: `hl names ${value}` } }), 'highlight')).element;
  const hlItem = d.srv.state.queue.find((it) => (it.element_ids || [it.element_id]).includes(hl.id));
  assert.ok(hlItem && hlItem.id !== item.id && JSON.stringify(hlItem).includes(value), 'precondition: the highlight\'s own group quotes the value');
  const pushed = await ok(d.api.post('/api/queue/push', { note: 'wc-u463-push-note' }), 'push');
  assert.equal(pushed.mode, 'parked', `the push parked: ${JSON.stringify(pushed)}`);
  assert.ok(d.srv.state.pendingWake && d.srv.state.pendingWake.envelope.content.includes(value), 'precondition: the stored park\'s envelope quotes the value');
  // Readers of the park: the host (lib/client, as turn-begin reads it), a
  // local browser (fetch metadata) and a remote viewer at `read`.
  const call = { port: d.port, noSpawn: true, timeout: 10000 };
  const readers = {
    host: async () => client.get('/api/queue/pending', call),
    local: async () => ok(d.anonApi.get('/api/queue/pending'), 'local pending'),
    remote: async () => ok(d.anonApi.get('/api/queue/pending', REMOTE), 'remote pending'),
  };
  return { ...d, value, text, local, remote, pinA, itemId: item.id, hlItemId: hlItem.id, readers };
}

// The redactor learns `value` through the capture token's file (a known
// source). The probe: the ring's queue entries — already served masked
// (U460) — no longer quote it.
async function learn(w) {
  fs.writeFileSync(projectPaths(w.root).captureToken, w.value + '\n');
  await waitUntil(async () => {
    const ring = (await w.api.get('/api/events?since=0')).json;
    const entries = ((ring && ring.events) || []).filter((e) => e.kind === 'queue' && e.item);
    return entries.length > 0 && !JSON.stringify(entries).includes(w.value);
  }, { ...WAIT, what: 'the redactor learned the value' });
}

test('(a)+(c) GET /api/queue/pending: before the learning the stored text; after it, no fragment in envelope.content or items[].summary for the host, a local browser or a remote viewer at read; the meta and the stored park unchanged', async (t) => {
  const w = await world(t);
  const storedPark = JSON.stringify(w.srv.state.pendingWake);
  const stored = w.srv.state.pendingWake;
  // (c) Before: each reader is served the stored envelope and the item's words.
  for (const [who, read] of Object.entries(w.readers)) {
    const body = await read();
    assert.ok(body.pending, `${who}: a park`);
    assert.strictEqual(body.pending.envelope.content, stored.envelope.content, `${who} before: the envelope's content as stored`);
    assert.deepStrictEqual(body.pending.envelope.meta, stored.envelope.meta, `${who} before: the meta`);
    assert.ok(body.pending.items.some((it) => it.summary.includes(w.value)), `${who} before: the item's summary quotes the value`);
  }
  await learn(w);
  for (const [who, read] of Object.entries(w.readers)) {
    const body = await read();
    assert.ok(body.pending, `${who}: the park is still there`);
    assert.equal(body.pending.id, stored.id, `${who}: the same park`);
    noLeaks(body.pending.envelope.content, w.value, `${who}: envelope.content`);
    masked(body.pending.envelope.content, `${who}: envelope.content`);
    for (const it of body.pending.items) noLeaks(it.summary, w.value, `${who}: items[${it.id}].summary`);
    assert.ok(body.pending.items.some((it) => marksIn(it.summary).length >= 1), `${who}: the item's summary is served masked`);
    noLeaks(body, w.value, `${who}: the whole park`);
    assert.deepStrictEqual(body.pending.envelope.meta, stored.envelope.meta, `${who} after: the meta as it was`);
  }
  // C1: the stored park is never rewritten; the hook's consume is a boolean.
  assert.strictEqual(JSON.stringify(w.srv.state.pendingWake), storedPark, 'the stored park unchanged');
  assert.ok(storedPark.includes(w.value), 'the stored park still holds the words as written');
  const consumed = await client.post('/api/queue/pending/consume', { id: stored.id }, { port: w.port, noSpawn: true, timeout: 10000 });
  assert.deepStrictEqual(consumed, { ok: true, consumed: true }, 'the consume answers no envelope');
});

test('(b)+(c) a queue frame emitted after the learning — a parked group re-sent (add), a fold into it (update) and a fresh pin\'s add — reaches a local and a remote-read socket masked; before it, as stored; a message\'s frame unchanged', async (t) => {
  const w = await world(t);
  const framesOf = (got) => got.filter((f) => f.type === 'queue' && f.item);
  // (c) Before the learning: pin A's add frame carries the words as stored, to both.
  for (const [who, got] of [['local', w.local], ['remote', w.remote]]) {
    const add = await waitUntil(() => framesOf(got).find((f) => f.op === 'add' && f.item.id === w.itemId), { ...WAIT, what: `${who}: pin a's add` });
    assert.ok(JSON.stringify(add.item.members).includes(w.value), `${who} before: members[].words as stored`);
    assert.ok(excerptsOf(add.item).some((e) => String(e).includes(w.value)), `${who} before: the excerpt as stored`);
  }
  const before = { local: w.local.length, remote: w.remote.length };
  await learn(w);
  const storedQueue = () => JSON.stringify(w.srv.state.queue);
  // The parked highlight's group raised again (Re-send, its kept copy — the
  // words stored before the learning): an add frame...
  const resent = await ok(w.api.post(`/api/queue/items/${w.hlItemId}/resend`, {}), 'resend');
  assert.equal(resent.ok, true, `resend: ${JSON.stringify(resent)}`);
  const resentId = resent.item.id;
  // ...and a second highlight on its pane folds in: an update frame that
  // still lists the first's stored words.
  const anchorH2 = rangeIn('qs-b', w.text, `${w.value} until`);
  await ok(w.anonApi.post('/api/elements', { type: 'highlight', anchor: anchorH2, payload: { color: 'gold', note: `hl2 ${w.value}` } }), 'highlight 2');
  // A comment pin on pane a (pin a is parked): an add frame of a fresh group,
  // its quote holding the value.
  const anchorB = rangeIn('qs-a', w.text, `is ${w.value}`);
  const pinB = (await ok(w.anonApi.post('/api/elements', commentBody({ text: `b names ${w.value}`, shared: true, anchor: anchorB })), 'pin b')).element;
  const itemB = w.srv.state.queue.find((it) => (it.element_ids || [it.element_id]).includes(pinB.id));
  assert.ok(itemB && itemB.id !== resentId && itemB.id !== w.itemId, 'pin b raised a fresh group');
  assert.ok(JSON.stringify(w.srv.state.queue.find((it) => it.id === resentId)).includes(w.value), 'C1: the re-sent group still holds the words stored before the learning');
  for (const [who, got] of [['local', w.local], ['remote', w.remote]]) {
    const after = () => framesOf(got.slice(before[who]));
    const addR = await waitUntil(() => after().find((f) => f.op === 'add' && f.item.id === resentId), { ...WAIT, what: `${who}: the re-sent add` });
    const upd = await waitUntil(() => after().find((f) => f.op === 'update' && f.item.id === resentId && (f.item.element_ids || []).length === 2), { ...WAIT, what: `${who}: the fold's update` });
    const addB = await waitUntil(() => after().find((f) => f.op === 'add' && f.item.id === itemB.id), { ...WAIT, what: `${who}: pin b's add` });
    for (const [name, f] of [['re-sent add', addR], ['update', upd], ['pin b add', addB]]) {
      noLeaks(f, w.value, `${who} ${name}`);
      assert.ok(f.item.members.length >= 1 && f.item.members.every((m) => marksIn(m.words).length >= 1), `${who} ${name}: members[].words masked: ${JSON.stringify(f.item.members)}`);
      assert.ok(excerptsOf(f.item).length >= 1 && excerptsOf(f.item).every((e) => marksIn(e).length >= 1), `${who} ${name}: the excerpt(s) masked: ${JSON.stringify(f.item.excerpt)}`);
      masked(f.item.summary, `${who} ${name}: summary`);
      if (typeof f.item.label === 'string') noLeaks(f.item.label, w.value, `${who} ${name}: label`);
    }
    // Every queue frame after the learning, on this socket.
    for (const f of after()) noLeaks(f, w.value, `${who}: queue ${f.op} ${f.item.id}`);
  }
  // A composer message's frame: its publicItem, as it was (no text rides).
  const sent = await ok(w.api.post('/api/queue/message', { text: MSG_TEXT, send: 'hold' }), 'message');
  assert.equal(sent.ok, true, `message: ${JSON.stringify(sent)}`);
  const msg = w.srv.state.queue.find((it) => queue.isMessage(it) && it.text === MSG_TEXT);
  assert.ok(msg, 'the message is queued');
  for (const [who, got] of [['local', w.local], ['remote', w.remote]]) {
    const f = await waitUntil(() => framesOf(got).find((x) => x.op === 'add' && x.item.id === msg.id), { ...WAIT, what: `${who}: the message's add` });
    assert.strictEqual(JSON.stringify(f.item), JSON.stringify(queue.publicItem(msg)), `${who}: the message's frame item is its publicItem`);
    assert.ok(!JSON.stringify(f).includes(MSG_TEXT), `${who}: and carries no text`);
  }
  assert.strictEqual(storedQueue().includes(w.value), true, 'C1: the stored queue is never rewritten');
});

// The bare rig (test/ws-projection.test.js's): attachWebSocket on a loopback
// http server, no audience, one local socket.
async function rig(t, opts = {}) {
  const state = createState();
  const graph = { active: null, nodes: new Map(), lock: null };
  const bus = createBus();
  const httpServer = http.createServer((r, res) => { res.statusCode = 404; res.end(); });
  const api = attachWebSocket(httpServer, { state, graph, paths: null, bus, projectName: 'proj', ...opts });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => {
    api.shutdown();
    api.terminate();
    httpServer.closeAllConnections();
    httpServer.close(r);
  }));
  const port = httpServer.address().port;
  const raw = [];
  const sock = wsConnect(port, '/ws');
  t.after(() => { try { sock.terminate(); } catch {} });
  sock.on('message', (data) => raw.push(data.toString()));
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  await waitUntil(() => raw.some((s) => JSON.parse(s).type === 'hello'), { ...WAIT, what: 'hello' });
  return { bus, raw };
}

test('(d) with no redactor wired (a bare attach) a queue frame is served as stored; with one, the same frame masked', async (t) => {
  const value = `wcbare${crypto.randomBytes(12).toString('hex')}`;
  const item = {
    id: 'q1', kind: 'element', type: 'comment', summary: `qs · comment: names ${value}`, label: `names ${value}`,
    members: [{ id: 'e1', words: `note ${value}` }], excerpt: [{ id: 'e1', text: `key ${value}` }],
  };
  const frame = { type: 'queue', op: 'add', item, count: 1 };
  const bare = await rig(t);
  bare.bus.emit({ ws: frame });
  const got = await waitUntil(() => bare.raw.find((s) => JSON.parse(s).type === 'queue'), { ...WAIT, what: 'the bare frame' });
  assert.strictEqual(got, JSON.stringify(frame), 'the bare attach: the frame byte-equal as stored');
  assert.strictEqual(queue.servedFrame(frame, null), frame, 'servedFrame with no redactor: the same object');
  const redactor = createRedactor();
  redactor.addKnown(value, 'capture-token');
  const wired = await rig(t, { redactor });
  wired.bus.emit({ ws: frame });
  const m = await waitUntil(() => wired.raw.find((s) => JSON.parse(s).type === 'queue'), { ...WAIT, what: 'the wired frame' });
  noLeaks(m, value, 'the wired frame');
  const f = JSON.parse(m);
  for (const s of [f.item.summary, f.item.label, f.item.members[0].words, f.item.excerpt[0].text]) masked(s, 'a masked field');
  assert.deepStrictEqual(Object.keys(f), Object.keys(frame), 'the frame keeps its keys in order');
  assert.ok(JSON.stringify(frame).includes(value), 'the emitted frame object is not rewritten');
  // A frame of another type passes the masker untouched.
  const other = { type: 'store:patch', patch: { k: value } };
  assert.strictEqual(queue.servedFrame(other, redactor), other, 'another frame type: the same object');
});
