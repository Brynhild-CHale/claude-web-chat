// The excerpt switch (U422; DECISIONS.md L.4 P3 = a, L.2 L8 = b, D2): a
// host-only project record, .web-chat/excerpts.json {v: 1, on}, read by
// lib/core/excerpts and written only by `claude-web-chat excerpts on|off`.
//
//   (1) the record: absent, torn or the wrong shape reads as the default (off),
//       honestly reported and never thrown, the file untouched by the read;
//       setSwitch writes {v: 1, on} atomically and refuses a folder that is no
//       project and the home directory.
//   (2) the one gate (lib/server/index.js elementWake): OFF, no queue item
//       carries an excerpt and every envelope — the live wake's and the park's
//       — is ids-only; ON (flipped with no restart), a shared highlight's item
//       carries its quote masked and bounded, and both envelopes carry one
//       excerpt block naming its id; an anchor with no quote (a box grab) and
//       a delete carry none.
//   (3) below `read` (GT-16): the excerpt is replaced by the text-free label
//       wherever an item rides — GET /api/queue, the queue frame, the ring,
//       the stream's catch-up and /api/wait; a read viewer gets the words; GET
//       /api/queue/pending's items never carry the field.
//   (4) no route: nothing under lib/server/routes names the switch, and no
//       request a pane can make changes the record.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { withServer, tmpRoot, openSSE, waitUntil } = require('../test-support/helpers');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { encodePng, solid } = require('../test-support/png-encode');
const { routePaths } = require('../test-support/doc-truth');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { projectPaths, userPaths, homeDir } = require('../lib/core/paths');
const { createRedactor } = require('../lib/core/redact');
const { EXCERPTS_DEFAULT, readSwitch, excerptsOn, setSwitch } = require('../lib/core/excerpts');
const { wakeEnvelope, excerptText, EXCERPT_HEADER, EXCERPT_PREFIX } = require('../lib/channel/envelope');
const { setSeams } = require('../lib/server/box-grab');
const client = require('../lib/client');

const SECRET = fakeSecrets({ seed: 422 }).find((f) => f.id === 'github-ghp');
const MOUNT = 'xs-pane';
const PASSAGE_MARK = 'wc-u422-passage-mark';
const QUOTE = `${PASSAGE_MARK} then ${SECRET.text}`;
const RANGE = (exact) => ({ v: 1, kind: 'range', mount: MOUNT, quote: { exact, prefix: '', suffix: '' }, pos: { start: 0, end: exact.length } });
const HIGHLIGHT = (exact, note = 'look here') => ({ type: 'highlight', anchor: RANGE(exact), payload: { color: 'gold', note } });
// What the daemon must put on the item: the quote masked, then bounded.
const EXPECTED = excerptText(createRedactor().value(QUOTE));

const textOf = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const elementItems = (srv) => srv.state.queue.filter((it) => it.kind === 'element');

async function ok(p, what) {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text || JSON.stringify(r.body)}`);
  return r.json !== undefined ? r.json : r.body;
}

// ── (1) the record ──────────────────────────────────────────────────────────

test('(1) readSwitch: absent → off from the default; {v:1,on:true} → on from the record; torn or the wrong shape → off, named, never thrown, the file untouched', () => {
  assert.equal(EXCERPTS_DEFAULT, false, 'the default stays off until the real-session check (D2)');
  const root = tmpRoot('wc-u422-rec-');
  const file = projectPaths(root).excerpts;
  assert.equal(file, path.join(root, '.web-chat', 'excerpts.json'));
  assert.deepStrictEqual(readSwitch(root), { on: false, source: 'default', state: 'absent' });
  assert.equal(excerptsOn(root), false);

  fs.writeFileSync(file, JSON.stringify({ v: 1, on: true }));
  assert.deepStrictEqual(readSwitch(root), { on: true, source: 'record', state: 'ok' });
  assert.equal(excerptsOn(root), true);
  fs.writeFileSync(file, JSON.stringify({ v: 1, on: false }));
  assert.deepStrictEqual(readSwitch(root), { on: false, source: 'record', state: 'ok' });

  const cases = [
    ['{"v":1,"on":tr', 'corrupt'],
    ['', 'corrupt'],
    ['[1]', 'invalid'],
    ['"on"', 'invalid'],
    ['true', 'invalid'],
    ['null', 'invalid'],
    ['{"v":2,"on":true}', 'invalid'],
    ['{"v":1,"on":"yes"}', 'invalid'],
    ['{"on":true}', 'invalid'],
    ['{"v":1,"on":true,"also":1}', 'invalid'],
  ];
  for (const [bytes, state] of cases) {
    fs.writeFileSync(file, bytes);
    let r;
    assert.doesNotThrow(() => { r = readSwitch(root); }, bytes);
    assert.deepStrictEqual(r, { on: false, source: 'default', state }, bytes);
    assert.equal(excerptsOn(root), false, bytes);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, `${bytes}: the read left the file as it was`);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('excerpts')), ['excerpts.json'], `${bytes}: nothing renamed aside`);
  }
  // A directory in the record's place is a failed read, not a throw.
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.deepStrictEqual(readSwitch(root), { on: false, source: 'default', state: 'corrupt' });
  // A folder that is no project at all reads as the default.
  assert.deepStrictEqual(readSwitch(path.join(root, 'nowhere')), { on: false, source: 'default', state: 'absent' });
});

test('(1) setSwitch writes {v:1,on} atomically, and refuses a folder with no .web-chat/, the home directory, a folder holding the user tier and a non-boolean', () => {
  const root = tmpRoot('wc-u422-set-');
  const file = projectPaths(root).excerpts;
  assert.deepStrictEqual(setSwitch(root, true), { v: 1, on: true });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, on: true });
  assert.deepStrictEqual(readSwitch(root), { on: true, source: 'record', state: 'ok' });
  setSwitch(root, false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, on: false });
  // A torn record is rewritten whole.
  fs.writeFileSync(file, '{"v":1,');
  setSwitch(root, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, on: true });
  // Atomic: the engine's tmp+rename leaves nothing beside the record.
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('excerpts')), ['excerpts.json']);

  for (const bad of ['on', 1, null, undefined]) {
    assert.throws(() => setSwitch(root, bad), TypeError, String(bad));
  }
  const bare = fs.mkdtempSync(path.join(path.dirname(root), 'wc-u422-bare-'));
  assert.throws(() => setSwitch(bare, true), (e) => e instanceof TypeError && /no \.web-chat\//.test(e.message));
  assert.ok(!fs.existsSync(path.join(bare, '.web-chat')), 'nothing created in a folder that is no project');

  const home = homeDir();
  fs.mkdirSync(path.join(home, '.web-chat'), { recursive: true });
  assert.throws(() => setSwitch(home, true), (e) => e instanceof TypeError && /home directory/.test(e.message));
  assert.ok(!fs.existsSync(path.join(home, '.web-chat', 'excerpts.json')), 'nothing written into the user tier');

  // A folder whose .web-chat/ holds the user tier's own files, whatever HOME says.
  const tier = tmpRoot('wc-u422-tier-');
  fs.writeFileSync(path.join(tier, '.web-chat', path.basename(userPaths().instances)), '{}');
  assert.throws(() => setSwitch(tier, true), TypeError);
  assert.ok(!fs.existsSync(projectPaths(tier).excerpts));
});

// ── (2) the one gate ────────────────────────────────────────────────────────

// Render the pane and connect nothing: a Push parks.
async function bootLocal(t) {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: MOUNT, html: `<p class="lead">${PASSAGE_MARK} and more</p>` }), 'render');
  return d;
}
const postHighlight = async (d, exact = QUOTE, note) => (await ok(d.api.post('/api/elements', HIGHLIGHT(exact, note)), 'highlight')).element;
// A Push with a wake consumer connected: the wake's batch, and the content the
// channel bridge builds from it (lib/channel/bridge → wakeEnvelope).
async function livePush(t, d) {
  const channel = await openSSE(d.port, { kinds: ['wake'], awaitChannel: d.api });
  t.after(() => channel.close());
  const pushed = await ok(d.api.post('/api/queue/push', {}), 'live push');
  assert.equal(pushed.mode, 'wake', JSON.stringify(pushed));
  const wake = await waitUntil(() => channel.events.find((e) => e.kind === 'wake'), { timeout: 5000, what: 'the wake' });
  channel.close();
  return { wake, content: wakeEnvelope(wake.batch, { reason: wake.reason, source: wake.source, seq: wake.seq }).content };
}
async function parkPush(d) {
  const pushed = await ok(d.api.post('/api/queue/push', {}), 'park push');
  assert.equal(pushed.mode, 'parked', JSON.stringify(pushed));
  return (await ok(d.api.get('/api/queue/pending'), 'pending')).pending;
}
// U423: highlights on one pane share one queue group; a member's excerpt is
// the group's string (a one-member group) or its [{id, text}] entry.
const groupOf = (items, id) => items.find((it) => (it.element_ids || [it.element_id]).includes(id));
const excerptOf = (it, id) => {
  if (!it) return undefined;
  if (typeof it.excerpt === 'string') return it.element_id === id ? it.excerpt : undefined;
  return Array.isArray(it.excerpt) ? (it.excerpt.find((e) => e.id === id) || {}).text : undefined;
};
const withoutExcerpt = (batch) => batch.map((it) => { const { excerpt: _e, ...rest } = it; return rest; });

test('(2) OFF (no record): the queue item has no excerpt key; the live wake and the park are ids-only, byte-equal to the same flow with no excerpt field', async (t) => {
  const d = await bootLocal(t);
  assert.equal(d.srv.state.excerptsOn(), false, 'state.excerptsOn reads the record (none: the default)');
  const h = await postHighlight(d);
  const [item] = elementItems(d.srv);
  assert.equal(item.element_id, h.id);
  assert.ok(!('excerpt' in item), 'no excerpt key on the item');
  const listed = (await ok(d.api.get('/api/queue'), 'queue')).items.find((it) => it.element_id === h.id);
  assert.ok(!('excerpt' in listed));

  const { wake, content } = await livePush(t, d);
  assert.ok(wake.batch.every((it) => !('excerpt' in it)), 'the wake batch carries no excerpt');
  assert.ok(!content.includes(EXCERPT_HEADER), 'no excerpt block in the live envelope');
  assert.ok(!content.includes(PASSAGE_MARK), 'none of the passage\'s words');
  assert.strictEqual(content, wakeEnvelope(withoutExcerpt(wake.batch), { reason: wake.reason, source: wake.source, seq: wake.seq }).content);

  // No consumer: the next Push parks, ids-only.
  const h2 = await postHighlight(d, `${PASSAGE_MARK} second`);
  assert.ok(!('excerpt' in elementItems(d.srv).find((it) => it.element_id === h2.id)));
  const pending = await parkPush(d);
  assert.ok(pending.envelope.content.includes(h2.id), 'the park names the element');
  assert.ok(!pending.envelope.content.includes(EXCERPT_HEADER), 'no excerpt block in the park');
  assert.ok(!pending.envelope.content.includes(PASSAGE_MARK), 'none of the passage\'s words in the park');
  assert.ok(pending.items.every((it) => !('excerpt' in it)));
  const ring = (await ok(d.api.get('/api/events?since=0'), 'events')).events;
  assert.ok(!textOf(ring).includes(PASSAGE_MARK), 'the ring holds none of the passage');
});

test('(2) ON (flipped with no restart): the next shared highlight\'s item carries excerptText(redactor.value(quote)), the secret masked; the live wake and the park carry one block naming its id; a box grab and a delete carry none', async (t) => {
  const d = await bootLocal(t);
  const before = await postHighlight(d, `${PASSAGE_MARK} before`);
  setSwitch(d.root, true);
  assert.equal(d.srv.state.excerptsOn(), true, 'state.excerptsOn follows the record, no restart');
  assert.equal(excerptOf(groupOf(elementItems(d.srv), before.id), before.id), undefined, 'an item queued before the flip keeps what it had');

  const h = await postHighlight(d);
  const item = groupOf(elementItems(d.srv), h.id);
  assert.strictEqual(excerptOf(item, h.id), EXPECTED, 'the quote, masked then bounded, at the producer');
  assert.ok(excerptOf(item, h.id).includes(PASSAGE_MARK));
  assert.equal(excerptOf(item, before.id), undefined, 'the member queued before the flip still has none');
  assert.deepStrictEqual(findLeaks(item, [SECRET]), [], 'the fake secret is masked on the item');
  const ring = (await ok(d.api.get('/api/events?since=0'), 'events')).events;
  assert.deepStrictEqual(findLeaks(ring, [SECRET]), [], 'and nowhere on the ring');
  assert.ok(!textOf(ring).includes(SECRET.secrets[0]));

  // A long quote is bounded by the envelope's one bound.
  const long = `${PASSAGE_MARK} ${'word '.repeat(200)}`;
  const hl = await postHighlight(d, long);
  const longItem = groupOf(elementItems(d.srv), hl.id);
  assert.strictEqual(excerptOf(longItem, hl.id), excerptText(long));
  assert.ok(excerptOf(longItem, hl.id).length <= 240 && excerptOf(longItem, hl.id).endsWith('…'));
  // U423: it shares the group with the others; deleting it drops its member.
  await ok(d.api.del(`/api/elements/${hl.id}`), 'drop the long one');

  const { wake, content } = await livePush(t, d);
  const carried = groupOf(wake.batch, h.id);
  assert.strictEqual(excerptOf(carried, h.id), EXPECTED, 'the wake batch carries the excerpt');
  assert.equal(excerptOf(groupOf(wake.batch, before.id), before.id), undefined);
  assert.equal(content.split(`${EXCERPT_HEADER}:`).length - 1, 1, 'one excerpt block in the live envelope');
  assert.ok(content.includes(`- highlight ${h.id}\n${EXCERPT_PREFIX}${PASSAGE_MARK}`), `the block names the id: ${content}`);
  assert.deepStrictEqual(findLeaks(content, [SECRET]), []);

  // No consumer now: the next Push parks, with the block.
  const h2 = await postHighlight(d, `${PASSAGE_MARK} parked`);
  const pending = await parkPush(d);
  assert.equal(pending.envelope.content.split(`${EXCERPT_HEADER}:`).length - 1, 1, 'one excerpt block in the park');
  assert.ok(pending.envelope.content.includes(`- highlight ${h2.id}\n${EXCERPT_PREFIX}${PASSAGE_MARK} parked`));
  assert.ok(pending.items.every((it) => !('excerpt' in it)), 'the park\'s items never carry the field');

  // A box grab: a page anchor, no quote — no excerpt.
  setSeams(d.srv.state, {
    findChrome: () => '/fake/chrome',
    captureImpl: async (o) => ({ png: encodePng(solid(o.clip.w, o.clip.h, [200, 40, 90]), o.clip.w, o.clip.h, { alpha: false }) }),
  });
  const grab = (await ok(d.api.post('/api/elements', {
    type: 'box-grab',
    anchor: { v: 1, kind: 'page', item: MOUNT, mount: MOUNT, rect: { x: 4, y: 6, w: 32, h: 20 }, viewport: { w: 1024, h: 700 } },
    payload: { rect: { x: 4, y: 6, w: 32, h: 20, item: MOUNT, viewport: { w: 1024, h: 700 } }, meta: { item_path: `#${MOUNT}`, element_path: 'p.lead', html: '<p class="lead">x</p>', mode: 'light', viewport: { w: 1024, h: 700 } } },
    device: 'desktop',
  }), 'box grab')).element;
  const grabItem = await waitUntil(() => elementItems(d.srv).find((it) => it.element_id === grab.id), { timeout: 10000, what: 'the grab\'s item' });
  assert.ok(!('excerpt' in grabItem), 'an anchor with no quote carries none');

  // A delete: the item goes, and nothing raised after it carries an excerpt.
  const h3 = await postHighlight(d, `${PASSAGE_MARK} deleted`);
  assert.ok(elementItems(d.srv).find((it) => it.element_id === h3.id).excerpt);
  const seq = (await ok(d.api.get('/api/events?since=0'), 'events')).events.at(-1).seq;
  await ok(d.api.del(`/api/elements/${h3.id}`), 'delete');
  assert.ok(!elementItems(d.srv).some((it) => it.element_id === h3.id), 'the delete dropped the item');
  const after = (await ok(d.api.get(`/api/events?since=${seq}`), 'events')).events;
  assert.ok(after.some((e) => e.kind === 'element' && e.op === 'delete'));
  assert.ok(!textOf(after).includes(`${PASSAGE_MARK} deleted`), 'the delete carries no excerpt');

  // Off again: the next item has none.
  setSwitch(d.root, false);
  const h4 = await postHighlight(d, `${PASSAGE_MARK} off again`);
  assert.ok(!('excerpt' in elementItems(d.srv).find((it) => it.element_id === h4.id)));
});

// ── (3) below read ──────────────────────────────────────────────────────────

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const PEER = Object.freeze({ 'x-test-peer': '10.0.0.9' });

// Requests carrying x-test-peer arrive from that address (spec §10.1).
function stubPeers(server) {
  const onRequest = (req, res) => {
    const addr = req.headers['x-test-peer'];
    if (!addr) return;
    Object.defineProperty(req.socket, 'remoteAddress', { value: addr, configurable: true });
    res.once('close', () => { delete req.socket.remoteAddress; });
  };
  server.prependListener('request', onRequest);
  return () => server.off('request', onRequest);
}

async function listenWs(t, port, headers) {
  const got = [];
  const sock = new WebSocket(`ws://localhost:${port}/ws`, { headers });
  sock.on('message', (data) => { try { got.push(JSON.parse(data.toString())); } catch {} });
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  t.after(() => { try { sock.close(); } catch {} });
  await waitUntil(() => got.some((f) => f.type === 'hello'), { timeout: 5000, what: 'hello' });
  return got;
}

// Two daemons on one sandbox HOME, the switch on in both: remote viewers at
// nothing (basic) on one, at `read` on the other. Each holds a shared
// highlight quoting PASSAGE_MARK, a live Push (a wake consumer connected), and
// a second highlight parked by a Push with no consumer.
async function bootRemote(t) {
  const readRoot = tmpRoot('wc-u422-read-');
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(readRoot)]: 'read' } } });
  const out = {};
  for (const level of ['basic', 'read']) {
    const d = await withServer(t, level === 'basic' ? { seed } : { root: readRoot });
    t.after(stubPeers(d.server));
    d.call = (method, p, body, headers) => client.request(d.port, method, p, body, { headers, timeout: 10000 });
    setSwitch(d.root, true);
    await ok(d.api.post('/api/render', { id: MOUNT, html: `<p class="lead">${PASSAGE_MARK}</p>` }), `${level}: render`);
    d.frames = { remote: await listenWs(t, d.port, REMOTE), local: await listenWs(t, d.port, {}) };
    d.h = await postHighlight(d);
    const channel = await openSSE(d.port, { kinds: ['wake'], awaitChannel: d.api });
    const pushed = await ok(d.api.post('/api/queue/push', {}), `${level}: push`);
    assert.equal(pushed.mode, 'wake');
    await waitUntil(() => channel.events.some((e) => e.kind === 'wake'), { timeout: 5000, what: `${level}: the wake` });
    channel.close();
    d.h2 = await postHighlight(d, `${PASSAGE_MARK} queued`);
    out[level] = d;
  }
  return out;
}
const hasWords = (v) => textOf(v).includes(PASSAGE_MARK);
const excerptsIn = (v) => {
  const found = [];
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x && typeof x === 'object') {
      if (typeof x.excerpt === 'string') found.push(x);
      Object.values(x).forEach(walk);
    }
  };
  walk(v);
  return found;
};
function assertLabelled(body, what) {
  assert.ok(!hasWords(body), `${what}: none of the passage's words`);
  const items = excerptsIn(body);
  assert.ok(items.length >= 1, `${what}: an item still says it had an excerpt`);
  for (const it of items) {
    // K.2-163: an element item's label names its type.
    assert.equal(it.excerpt, `${MOUNT} · ${it.kind === 'element' ? it.type : it.kind}`, `${what}: the text-free label`);
    assert.equal(it.text_hidden, true, `${what}: text_hidden`);
  }
}

test('(3) below read the excerpt is the text-free label in GET /api/queue, the queue frame, the ring, the stream\'s catch-up and /api/wait; a read viewer gets the words; /api/queue/pending\'s items never carry the field', async (t) => {
  const d = await bootRemote(t);

  // GET /api/queue.
  const local = (await d.basic.call('GET', '/api/queue')).body;
  const QUEUED = excerptText(`${PASSAGE_MARK} queued`);
  assert.strictEqual(excerptsIn(local)[0].excerpt, QUEUED, 'local: the words');
  for (const [who, headers] of [['remote', REMOTE], ['peer', PEER]]) {
    const r = await d.basic.call('GET', '/api/queue', null, headers);
    assert.equal(r.status, 200, `basic ${who}`);
    assertLabelled(r.body, `basic ${who} GET /api/queue`);
  }
  const readRemote = (await d.read.call('GET', '/api/queue', null, REMOTE)).body;
  assert.strictEqual(excerptsIn(readRemote)[0].excerpt, QUEUED, 'read remote: the words');
  assertLabelled((await d.read.call('GET', '/api/queue', null, PEER)).body, 'read peer GET /api/queue');

  // The queue frame.
  const frames = (d) => d.filter((f) => f.type === 'queue' && f.item);
  await waitUntil(() => frames(d.basic.frames.remote).length >= 2 && frames(d.read.frames.remote).length >= 2, { timeout: 5000, what: 'queue frames' });
  assert.ok(frames(d.basic.frames.local).some((f) => f.item.excerpt === EXPECTED), 'local socket: the words');
  assertLabelled(frames(d.basic.frames.remote), 'basic remote socket');
  assert.ok(frames(d.read.frames.remote).some((f) => f.item.excerpt === EXPECTED), 'read remote socket: the words');

  // The ring: queue adds and the wake batch.
  const ringLocal = (await d.basic.call('GET', '/api/events?since=0')).body;
  assert.ok(ringLocal.events.some((e) => e.kind === 'wake' && e.batch.some((it) => it.excerpt === EXPECTED)), 'local ring: the wake batch carries the words');
  assert.ok(ringLocal.events.some((e) => e.kind === 'queue' && e.item && e.item.excerpt === EXPECTED), 'local ring: the queue add carries them');
  for (const [who, headers] of [['remote', REMOTE], ['peer', PEER]]) {
    const r = await d.basic.call('GET', '/api/events?since=0', null, headers);
    assert.equal(r.status, 200);
    assertLabelled(r.body, `basic ${who} GET /api/events`);
    assert.ok(r.body.events.some((e) => e.kind === 'wake' && e.batch.some((it) => it.excerpt === `${MOUNT} · highlight`)), `basic ${who}: the wake batch's label`);
  }
  const ringRead = (await d.read.call('GET', '/api/events?since=0', null, REMOTE)).body;
  assert.ok(ringRead.events.some((e) => e.kind === 'wake' && e.batch.some((it) => it.excerpt === EXPECTED)), 'read remote ring: the words');

  // The stream's catch-up.
  const streamed = (port, headers) => new Promise((resolve, reject) => {
    let text = '';
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/events/stream?since=0&kinds=queue,wake', headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
        if (/event: wake\n/.test(text) && (text.match(/event: queue\n/g) || []).length >= 2 && /\n\n$/.test(text)) { req.destroy(); resolve(text); }
      });
    });
    req.on('error', (e) => (text ? resolve(text) : reject(e)));
    req.setTimeout(10000, () => { req.destroy(); resolve(text); });
  });
  assert.ok(hasWords(await streamed(d.basic.port, {})), 'local stream: the words');
  for (const [who, headers] of [['remote', REMOTE], ['peer', PEER]]) {
    const text = await streamed(d.basic.port, headers);
    assert.ok(/event: wake\n/.test(text), `basic ${who}: the catch-up's wake`);
    assert.ok(!hasWords(text), `basic ${who} stream: none of the words`);
    assert.ok(text.includes(`"excerpt":"${MOUNT} · highlight"`), `basic ${who} stream: the label`);
  }
  assert.ok(hasWords(await streamed(d.read.port, REMOTE)), 'read remote stream: the words');

  // /api/wait's matched event.
  const targets = ringLocal.events.filter((e) => (e.kind === 'queue' && e.item && e.item.excerpt) || e.kind === 'wake');
  assert.ok(targets.length >= 2);
  for (const e of targets) {
    const wait = (dd, headers) => dd.call('POST', '/api/wait', { predicate: { event_kind: e.kind, since_seq: e.seq - 1 }, timeout_ms: 1000 }, headers);
    assert.ok(hasWords((await wait(d.basic, {})).body.event), `local wait seq ${e.seq}: the words`);
    for (const [who, headers] of [['remote', REMOTE], ['peer', PEER]]) {
      const below = (await wait(d.basic, headers)).body;
      assert.equal(below.event.seq, e.seq, `basic ${who}: the same entry`);
      assertLabelled(below.event, `basic ${who} wait seq ${e.seq}`);
    }
  }

  // GET /api/queue/pending: a park with an excerpt; its items never carry the field.
  for (const level of ['basic', 'read']) {
    const pushed = await ok(d[level].api.post('/api/queue/push', {}), `${level}: park`);
    assert.equal(pushed.mode, 'parked', JSON.stringify(pushed));
    const localPending = (await d[level].call('GET', '/api/queue/pending')).body.pending;
    assert.ok(localPending.envelope.content.includes(`${EXCERPT_HEADER}:`), `${level} local: the park's envelope holds the block`);
    for (const [who, headers] of [['local', {}], ['remote', REMOTE], ['peer', PEER]]) {
      const p = (await d[level].call('GET', '/api/queue/pending', null, headers)).body.pending;
      assert.ok(p.items.length >= 1, `${level} ${who}: the parked items`);
      assert.ok(p.items.every((it) => !('excerpt' in it)), `${level} ${who}: no item carries the field`);
    }
    for (const headers of [REMOTE, PEER]) {
      const p = (await d.basic.call('GET', '/api/queue/pending', null, headers)).body.pending;
      if (p) assert.ok(!hasWords(p), 'basic: the park carries none of the words below read');
    }
  }
});

// ── (4) no route ────────────────────────────────────────────────────────────

test('(4) no route names the switch, and no request a pane can make changes the record', async (t) => {
  const routes = routePaths();
  assert.ok(routes.length > 20);
  assert.deepStrictEqual(routes.filter((r) => /excerpt/i.test(r)), [], 'no route under lib/server/routes (or anywhere a route is mounted) names excerpts');
  const routeDir = path.join(__dirname, '..', 'lib', 'server', 'routes');
  for (const f of fs.readdirSync(routeDir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(routeDir, f), 'utf8');
    assert.ok(!/core\/excerpts/.test(src), `${f} does not reach the switch`);
  }

  const d = await withServer(t);
  const file = projectPaths(d.root).excerpts;
  for (const p of ['/api/excerpts', '/api/settings/excerpts', '/api/project/excerpts']) {
    for (const [method, call] of [['POST', d.anonApi.post], ['PATCH', d.anonApi.patch], ['PUT', d.anonApi.put]]) {
      if (typeof call !== 'function') continue;
      const r = await call(p, { v: 1, on: true });
      assert.ok(r.status >= 400, `${method} ${p}: ${r.status}`);
    }
  }
  assert.ok(!fs.existsSync(file), 'the record was never written');
  assert.equal(excerptsOn(d.root), false);
});
