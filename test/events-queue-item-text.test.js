// The ring's queue items below `read` (K.2-126, after U332b's review). A
// shared comment pin and a shared highlight each raise a queue item whose
// summary quotes the note (lib/channel/policy commentItem / elementItem); GET
// /api/queue already hands a basic reader that item through stripItemText.
// The ring hands the same item out three more ways — GET /api/events, the SSE
// stream (its catch-up and its live events) and /api/wait's matched event —
// in a `queue` entry's `item` and a `wake` entry's `batch`; below `read` each
// goes through stripItemText at the request's level as well, and a wake
// batch's message is its publicItem with `text_hidden`, as GET /api/queue
// shows it. A remote viewer at `read`, and a local request, get the notes.
// Every other entry is U332b's reading: the route-level strip alone. A wake
// entry's own note — the Push note, the user's text (J1, K1, U401) — goes
// through stripWakeText below `read`: gone, and the entry says `note_hidden`;
// a wake pushed with no note is as it was.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { withServer, tmpRoot, commentBody, openSSE, waitUntil } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const { stripText } = require('../lib/core/remote-policy');
const client = require('../lib/client');

const PIN_NOTE = 'wc-u332c-pin-note-mark';
const HL_NOTE = 'wc-u332c-highlight-note-mark';
const LIVE_NOTE = 'wc-u332c-live-pin-note-mark';
const MSG_TEXT = 'wc-u332c-message-words-mark';
const PUSH_NOTE = 'wc-u401-push-note';
const LIVE_PUSH_NOTE = 'wc-u401-live-push-note';
const NOTES = [PIN_NOTE, HL_NOTE, LIVE_NOTE, MSG_TEXT, PUSH_NOTE, LIVE_PUSH_NOTE];
const MOUNT = 'eq-pane';
const LOCATOR = Object.freeze({ mount: MOUNT, selector: 'p.lead', text: 'Hello', ordinal: 0 });
const RANGE = Object.freeze({ v: 1, kind: 'range', mount: MOUNT, quote: { exact: 'Hello', prefix: '', suffix: '' }, pos: { start: 0, end: 5 } });

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const PEER = Object.freeze({ 'x-test-peer': '10.0.0.9' });

const textOf = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const notesIn = (v) => NOTES.filter((m) => textOf(v).includes(m));

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

async function ok(p, what) {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text || JSON.stringify(r.body)}`);
  return r.json !== undefined ? r.json : r.body;
}

// Two daemons on one sandbox HOME: remote viewers opted in at nothing (basic)
// on one, at `read` on the other. Each holds a shared pin and a shared
// highlight with notes and a Push delivered live (a local wake consumer is
// connected) with a Push note, so the ring holds their queue adds and a wake
// whose batch carries both and whose note is PUSH_NOTE; then a composer message
// sent now, whose wake carries its words and no note.
async function boot(t) {
  const readRoot = tmpRoot('wc-u332c-read-');
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(readRoot)]: 'read' } } });
  const out = {};
  for (const level of ['basic', 'read']) {
    const d = await withServer(t, level === 'basic' ? { seed } : { root: readRoot });
    t.after(stubPeers(d.server));
    d.call = (method, p, body, headers) => client.request(d.port, method, p, body, { headers, timeout: 10000 });
    await ok(d.api.post('/api/render', { id: MOUNT, html: '<p class="lead">Hello world</p>' }), `${level}: render`);
    await ok(d.api.post('/api/elements', commentBody({ text: PIN_NOTE, shared: true, anchor: LOCATOR })), `${level}: pin`);
    await ok(d.api.post('/api/elements', { type: 'highlight', anchor: RANGE, payload: { color: 'gold', note: HL_NOTE } }), `${level}: highlight`);
    const queued = (await ok(d.api.get('/api/queue'), `${level}: queue`)).items;
    assert.deepStrictEqual(queued.map((it) => it.type).sort(), ['comment', 'highlight'], `${level}: two items queued`); // U423: both element groups
    const channel = await openSSE(d.port, { kinds: ['wake'], awaitChannel: d.api });
    t.after(() => channel.close());
    const pushed = await ok(d.api.post('/api/queue/push', { note: PUSH_NOTE }), `${level}: push`);
    assert.equal(pushed.mode, 'wake', `${level}: the push woke the channel: ${JSON.stringify(pushed)}`);
    await waitUntil(() => channel.events.some((e) => e.kind === 'wake'), { timeout: 5000, what: `${level}: the wake` });
    // A composer message sent now: its own wake, whose batch carries its words.
    const msg = await ok(d.api.post('/api/queue/message', { text: MSG_TEXT, send: 'now' }), `${level}: message`);
    assert.equal(msg.ok, true, `${level}: message: ${JSON.stringify(msg)}`);
    await waitUntil(() => channel.events.some((e) => e.kind === 'wake' && e.batch.some((it) => it.kind === 'message')), { timeout: 5000, what: `${level}: the message's wake` });
    out[level] = d;
  }
  return out;
}

const queueEntries = (body) => body.events.filter((e) => e.kind === 'queue' && e.item);
const wakeEntries = (body) => body.events.filter((e) => e.kind === 'wake');
const pushWake = (body) => wakeEntries(body).find((e) => e.batch.some((it) => it.type === 'comment'));
const msgWake = (body) => wakeEntries(body).find((e) => e.batch.some((it) => it.kind === 'message'));
// A wake entry below `read` against its local reading (U401): the same kind,
// seq, reason and batch ids; no note; `note_hidden` exactly when it had one.
function assertWakeHidden(local, below, what) {
  assert.ok(!('note' in below), `${what}: no note field`);
  assert.equal(below.kind, local.kind, `${what}: kind`);
  assert.equal(below.seq, local.seq, `${what}: seq`);
  assert.equal(below.reason, local.reason, `${what}: reason`);
  assert.deepStrictEqual(below.batch.map((it) => it.id), local.batch.map((it) => it.id), `${what}: the batch ids`);
  if (local.note) assert.equal(below.note_hidden, true, `${what}: note_hidden`);
  else assert.ok(!('note_hidden' in below), `${what}: a note-less wake says no note_hidden`);
}
// Every queue item the ring's entries carry, in seq order.
const itemsOf = (body) => body.events.flatMap((e) => (e.kind === 'queue' && e.item ? [e.item] : e.kind === 'wake' ? e.batch : []));

// A basic reading of the ring against the local one: the same entries (kind,
// seq, id), the same items (kind, id), none of their text.
function assertStripped(local, below, what) {
  assert.deepStrictEqual(notesIn(below), [], `${what}: no note anywhere`);
  assert.deepStrictEqual(below.events.map((e) => [e.kind, e.seq, e.id, e.op]), local.events.map((e) => [e.kind, e.seq, e.id, e.op]), `${what}: the same entries`);
  const li = itemsOf(local);
  const bi = itemsOf(below);
  assert.deepStrictEqual(bi.map((it) => [it.kind, it.id]), li.map((it) => [it.kind, it.id]), `${what}: the same items`);
  for (const it of bi) {
    if (it.kind === 'comment' || it.kind === 'element') {
      assert.equal(it.text_hidden, true, `${what}: ${it.kind} ${it.id} text_hidden`);
      assert.equal(it.summary, `${MOUNT} · ${it.kind}`, `${what}: ${it.kind} ${it.id} the text-free label`);
    }
  }
  const lw = wakeEntries(local);
  const bw = wakeEntries(below);
  assert.ok(lw.some((e) => e.note === PUSH_NOTE), `${what}: the local ring's push wake carries the Push note`);
  assert.ok(lw.some((e) => !('note' in e)), `${what}: and the message's wake carries none`);
  lw.forEach((e, i) => assertWakeHidden(e, bw[i], `${what}: wake seq ${e.seq}`));
  const msgs = wakeEntries(below).flatMap((e) => e.batch).filter((it) => it.kind === 'message');
  assert.ok(msgs.length >= 1, `${what}: the wake batch keeps its message item`);
  for (const m of msgs) {
    assert.equal(m.text_hidden, true, `${what}: a wake batch's message is hidden`);
    assert.ok(!('text' in m), `${what}: and carries no text field`);
  }
  // (e) Every other entry is the route-level strip alone, byte for byte.
  const ring = stripText('routes', 'GET /api/events', local);
  const other = (b) => b.events.filter((e) => e.kind !== 'queue' && e.kind !== 'wake');
  assert.ok(other(below).length > 0, `${what}: there are other entries to compare`);
  assert.strictEqual(JSON.stringify(other(below)), JSON.stringify(other(ring)), `${what}: other entries as U332b reads them`);
}

function assertCarried(body, what) {
  for (const n of [PIN_NOTE, HL_NOTE]) {
    assert.ok(queueEntries(body).some((e) => textOf(e.item.summary).includes(n)), `${what}: a queue entry's summary quotes ${n}`);
    assert.ok(wakeEntries(body).some((e) => e.batch.some((it) => textOf(it.summary).includes(n))), `${what}: the wake batch quotes ${n}`);
  }
  assert.strictEqual(pushWake(body).note, PUSH_NOTE, `${what}: the push wake's note, byte-equal`);
  assert.ok(!('note_hidden' in pushWake(body)), `${what}: and no note_hidden`);
  assert.ok(!('note' in msgWake(body)) && !('note_hidden' in msgWake(body)), `${what}: the message's wake as it was`);
}

test('(a) GET /api/events below read: no queue entry\'s item, nor a wake batch, quotes a pin\'s or highlight\'s note; (d) read and local do; (e) other entries are U332b\'s', async (t) => {
  const d = await boot(t);
  const route = '/api/events?since=0';
  const basicLocal = (await d.basic.call('GET', route)).body;
  assertCarried(basicLocal, 'basic local');
  assert.ok(textOf(basicLocal).includes(MSG_TEXT), 'the local ring\'s wake carries the message (the bridge builds the envelope from it)');
  for (const [who, headers] of [['remote', REMOTE], ['peer', PEER]]) {
    const r = await d.basic.call('GET', route, null, headers);
    assert.equal(r.status, 200, `basic ${who}`);
    assertStripped(basicLocal, r.body, `basic ${who}`);
  }
  // A daemon at read: its remote viewer reads the notes; a network peer is basic whatever the opt-in.
  const readLocal = (await d.read.call('GET', route)).body;
  assertCarried(readLocal, 'read local');
  const readRemote = (await d.read.call('GET', route, null, REMOTE)).body;
  assertCarried(readRemote, 'read remote');
  assert.strictEqual(JSON.stringify(itemsOf(readRemote)), JSON.stringify(itemsOf(readLocal)), 'read remote: the items whole');
  assert.strictEqual(JSON.stringify(wakeEntries(readRemote)), JSON.stringify(wakeEntries(readLocal)), 'read remote: the wake entries whole, the Push note included');
  assertStripped(readLocal, (await d.read.call('GET', route, null, PEER)).body, 'read peer');
});

// The stream as text, from `since`, read until `until` holds (or the timeout).
function streamed(port, headers, { query, until, after }) {
  return new Promise((resolve, reject) => {
    let text = '';
    let fired = false;
    const req = http.get({ hostname: '127.0.0.1', port, path: `/api/events/stream?${query}`, headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
        if (!fired && after && text.includes('retry:')) { fired = true; after().catch(reject); }
        if (until(text) && /\n\n$/.test(text)) { req.destroy(); resolve(text); }
      });
    });
    req.on('error', (e) => (text ? resolve(text) : reject(e)));
    req.setTimeout(10000, () => { req.destroy(); resolve(text); });
  });
}
const sseEvents = (text) => text.split('\n\n').map((block) => {
  const kind = /^event: (.+)$/m.exec(block);
  const data = /^data: (.+)$/m.exec(block);
  return kind && data ? { kind: kind[1], data: JSON.parse(data[1]) } : null;
}).filter(Boolean);

test('(b) the SSE stream below read: its catch-up, a live queue event and a live wake carry no note; read and local do', async (t) => {
  const d = await boot(t);
  const query = 'since=0&kinds=queue,wake';
  // Both wakes (the Push's, the message's) have arrived.
  const caughtUp = (text) => (text.match(/event: wake\n/g) || []).length >= 2;
  const local = await streamed(d.basic.port, {}, { query, until: caughtUp });
  assert.deepStrictEqual(notesIn(local).sort(), [HL_NOTE, MSG_TEXT, PIN_NOTE, PUSH_NOTE].sort(), 'the local catch-up carries the notes');
  const localWakes = sseEvents(local).filter((e) => e.kind === 'wake').map((e) => e.data);
  for (const [who, headers] of [['remote', REMOTE], ['peer', PEER]]) {
    const text = await streamed(d.basic.port, headers, { query, until: caughtUp });
    const evs = sseEvents(text);
    assert.ok(evs.some((e) => e.kind === 'queue') && evs.some((e) => e.kind === 'wake'), `basic ${who}: the catch-up's queue and wake entries`);
    assert.deepStrictEqual(notesIn(text), [], `basic ${who}: the catch-up quotes no note`);
    const wakes = evs.filter((e) => e.kind === 'wake').map((e) => e.data);
    assert.equal(wakes.length, localWakes.length, `basic ${who}: every wake`);
    localWakes.forEach((e, i) => assertWakeHidden(e, wakes[i], `basic ${who}: catch-up wake seq ${e.seq}`));
  }
  const readRemote = await streamed(d.read.port, REMOTE, { query, until: caughtUp });
  assert.ok(notesIn(readRemote).includes(PIN_NOTE) && notesIn(readRemote).includes(HL_NOTE), 'read remote: the catch-up carries the notes');
  assert.ok(sseEvents(readRemote).some((e) => e.kind === 'wake' && e.data.note === PUSH_NOTE), 'read remote: the catch-up\'s wake carries the Push note byte-equal');

  // Live: a stream opened from the ring's head, then a fresh shared pin.
  const head = (await d.basic.call('GET', '/api/events?since=0')).body.events.at(-1).seq;
  let n = 0;
  const live = (headers) => streamed(d.basic.port, headers, {
    query: `since=${head}&kinds=queue`,
    until: (text) => /event: queue\n/.test(text),
    after: () => ok(d.basic.api.post('/api/elements', commentBody({ text: `${LIVE_NOTE} ${++n}`, shared: true, anchor: LOCATOR })), 'live pin'),
  });
  const peerLive = await live(PEER);
  const peerEvs = sseEvents(peerLive).filter((e) => e.kind === 'queue');
  assert.ok(peerEvs.length >= 1 && peerEvs[0].data.item && peerEvs[0].data.item.type === 'comment', `the peer's live queue event: ${peerLive}`);
  assert.equal(peerEvs[0].data.item.text_hidden, true);
  assert.deepStrictEqual(notesIn(peerLive), [], 'the peer\'s live queue event quotes no note');
  const localLive = await live({});
  assert.ok(localLive.includes(LIVE_NOTE), 'the local live queue event quotes the note');

  // Live: a stream opened from the ring's head, then a note-only Push (the
  // boot's channel is still connected, so it wakes).
  let w = 0;
  const liveWake = async (headers) => streamed(d.basic.port, headers, {
    query: `since=${(await d.basic.call('GET', '/api/events?since=0')).body.events.at(-1).seq}&kinds=wake`,
    until: (text) => /event: wake\n/.test(text),
    after: async () => {
      const pushed = await ok(d.basic.api.post('/api/queue/push', { note: `${LIVE_PUSH_NOTE} ${++w}` }), 'live push');
      assert.equal(pushed.mode, 'wake', `the live push woke the channel: ${JSON.stringify(pushed)}`);
    },
  });
  for (const [who, headers] of [['peer', PEER], ['remote', REMOTE]]) {
    const text = await liveWake(headers);
    const wakes = sseEvents(text).filter((e) => e.kind === 'wake');
    assert.ok(wakes.length >= 1, `the basic ${who}'s live wake: ${text}`);
    assert.equal(wakes[0].data.note_hidden, true, `the basic ${who}'s live wake says note_hidden`);
    assert.ok(!('note' in wakes[0].data), `the basic ${who}'s live wake carries no note`);
    assert.deepStrictEqual(notesIn(text), [], `the basic ${who}'s live wake quotes no note`);
  }
  const localWake = await liveWake({});
  const localWakeEv = sseEvents(localWake).find((e) => e.kind === 'wake');
  // Which Push note the wake carries is the domain's (an unacked earlier wake
  // folds into it); the local stream carries it byte-equal to the local ring.
  assert.ok(localWakeEv && textOf(localWakeEv.data.note).startsWith(LIVE_PUSH_NOTE), `the local live wake carries a Push note: ${localWake}`);
  const ringWake = (await d.basic.call('GET', '/api/events?since=0')).body.events.find((e) => e.seq === localWakeEv.data.seq);
  assert.strictEqual(localWakeEv.data.note, ringWake.note, 'the local live wake\'s note, byte-equal to the ring\'s');
});

test('(c) /api/wait below read: the matched queue or wake event carries no note; read and local do', async (t) => {
  const d = await boot(t);
  const ring = (await d.basic.call('GET', '/api/events?since=0')).body;
  const targets = [...queueEntries(ring).filter((e) => notesIn(e.item).length), ...wakeEntries(ring)];
  assert.ok(targets.length >= 3, 'a queue entry per noted item, and the wake');
  const wait = (dd, e, headers) => dd.call('POST', '/api/wait', { predicate: { event_kind: e.kind, since_seq: e.seq - 1 }, timeout_ms: 1000 }, headers);
  for (const e of targets) {
    const local = (await wait(d.basic, e)).body;
    assert.equal(local.matched, 'event');
    assert.equal(local.event.seq, e.seq);
    assert.ok(notesIn(local.event).length >= 1, `local wait seq ${e.seq}: the note`);
    for (const [who, headers] of [['remote', REMOTE], ['peer', PEER]]) {
      const below = (await wait(d.basic, e, headers)).body;
      assert.equal(below.matched, 'event', `basic ${who}`);
      assert.equal(below.event.seq, e.seq, `basic ${who}: the same entry`);
      assert.equal(below.event.kind, e.kind);
      assert.deepStrictEqual(notesIn(below), [], `basic ${who} wait seq ${e.seq}: no note`);
      if (e.kind === 'wake') assertWakeHidden(local.event, below.event, `basic ${who} wait seq ${e.seq}`);
    }
  }
  const readRing = (await d.read.call('GET', '/api/events?since=0')).body;
  for (const e of queueEntries(readRing).filter((x) => notesIn(x.item).length)) {
    const remote = (await wait(d.read, e, REMOTE)).body;
    assert.equal(remote.event.seq, e.seq);
    assert.ok(notesIn(remote.event).length >= 1, `read remote wait seq ${e.seq}: the note`);
  }
  for (const e of wakeEntries(readRing)) {
    const remote = (await wait(d.read, e, REMOTE)).body;
    assert.equal(remote.event.seq, e.seq);
    assert.strictEqual(JSON.stringify(remote.event), JSON.stringify(e), `read remote wait seq ${e.seq}: the wake whole, its note byte-equal`);
  }
  assert.strictEqual(pushWake(readRing).note, PUSH_NOTE, 'the read daemon\'s ring holds the Push note');
});
