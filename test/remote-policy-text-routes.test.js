// No anchor text below `read` on the graph-node, preview and events routes
// (K.2-117; the 2C gate's GT-16 NO-GO, C-2C-4). Every anchor carries pane text
// — an excerpt, a fingerprint — so the full-surface frames (hello, reset)
// withhold the whole element list below `read`; these three routes are held
// to the same rule through lib/core/remote-policy's TEXT_RULES.routes:
//
//   GET /api/graph/node/:id  `comments` and `lean_elements` go, whole
//   GET /preview/node/:id    the node the document embeds has no `comments`
//   GET /api/events          a comment entry's `pin` goes, whole (its anchor,
//                            locator, note and replies); an element entry
//                            carries ids and flags only and is left as it is
//
// A basic reader is a remote viewer of a project that has not opted in
// (`X-WC-Remote: 1` from loopback, as the portal sends it) and a peer on a
// network bind (a stubbed socket address: basic whatever it sends, Q9). A
// remote viewer at `read`, and a local request, get what they always got.
// The private drop (PRIVATE_RULES) is not this file's: from `read` up it
// alone decides the node's lists.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { withServer, tmpRoot, commentBody } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const { TEXT_RULES, stripText } = require('../lib/core/remote-policy');
const client = require('../lib/client');

const EXCERPT = 'wc-u332b-excerpt-mark';
const FINGERPRINT = 'wc-u332b-fingerprint-mark';
const PIN_TEXT = 'wc-u332b-pin-text-mark';
const MOUNT = 'tr-pane';
const MARKS = [EXCERPT, FINGERPRINT, PIN_TEXT];

// An engine anchor whose excerpt and fingerprint head are in no pane's html:
// only the anchor can carry them.
const ANCHOR = Object.freeze({
  v: 1, kind: 'range', mount: MOUNT,
  quote: { exact: EXCERPT, prefix: 'before ', suffix: ' after' },
  fp: { tag: 'p', id: null, cls: ['x'], head: FINGERPRINT, attrs: [], parent: null },
});

const frozen = (o) => {
  if (o && typeof o === 'object') { Object.values(o).forEach(frozen); Object.freeze(o); }
  return o;
};
const has = (body, mark) => (typeof body === 'string' ? body : JSON.stringify(body)).includes(mark);
const marksIn = (body) => MARKS.filter((m) => has(body, m));

// ── the table ───────────────────────────────────────────────────────────────

test('TEXT_RULES.routes: the node read withholds comments and lean_elements, the preview comments, the ring a comment entry\'s pin', () => {
  const node = TEXT_RULES.routes['GET /api/graph/node/:id'];
  assert.ok(node.includes('comments') && node.includes('lean_elements'), JSON.stringify(node));
  assert.ok(TEXT_RULES.routes['GET /preview/node/:id'].includes('comments'));
  assert.ok(!TEXT_RULES.routes['GET /preview/node/:id'].includes('lean_elements'), 'the preview route builds no lean rows');
  assert.deepStrictEqual([...TEXT_RULES.routes['GET /api/events']], ['events[].pin']);
});

const PIN = { id: 'c1', seq: 1, shared: true, text: PIN_TEXT, anchor: ANCHOR, replies: [{ author: 'user', text: PIN_TEXT }], v: 1 };
const LEAN = { id: 'c1', v: 1, type: 'comment', schema: 'comment@1', anchor: ANCHOR, shared: true, replies: 1, answered: false };

test('(a) stripText GET /api/graph/node/:id: comments and lean_elements go below read; the surface stays', () => {
  const node = frozen({
    id: 'n2', label: 'n1.2', author: 'claude', mounts: [{ id: MOUNT, html: '<p class="x">pane</p>' }], store: { a: 1 },
    elements: ['h3@1'], comments: [PIN], lean_elements: [LEAN], trigger: { kind: 'turn', ended: 'stop' },
  });
  const out = stripText('routes', 'GET /api/graph/node/:id', node);
  assert.deepStrictEqual(out, {
    id: 'n2', label: 'n1.2', author: 'claude', mounts: node.mounts, store: node.store, elements: ['h3@1'], trigger: { kind: 'turn', ended: 'stop' },
  });
  assert.deepStrictEqual(marksIn(out), []);
  assert.equal(out.mounts, node.mounts, 'what no path names is shared, not copied');
  assert.deepStrictEqual(node.comments, [PIN], 'the original is untouched');
});

test('(b) stripText GET /preview/node/:id: comments go below read', () => {
  const node = frozen({ id: 'n2', mounts: [], store: {}, comments: [PIN], trigger: { kind: 'turn' } });
  const out = stripText('routes', 'GET /preview/node/:id', node);
  assert.deepStrictEqual(out, { id: 'n2', mounts: [], store: {}, trigger: { kind: 'turn' } });
  assert.deepStrictEqual(marksIn(out), []);
});

test('(c) stripText GET /api/events: a comment entry carries no pin; an element entry and every other entry stay', () => {
  const element = { seq: 3, ts: 3, kind: 'element', type: 'highlight', op: 'add', id: 'h1', v: 1, shared: true, mount: MOUNT };
  const grab = { seq: 4, ts: 4, kind: 'element', type: 'box-grab', op: 'grab', id: 'g1', v: 1, shared: true, mount: MOUNT,
    image: { state: 'ready', capture: 'cap1', path: 'captures/cap1.png', sha256: 'ab', width: 1, height: 1, bytes: 9 } };
  const render = { seq: 1, ts: 1, kind: 'render', id: MOUNT };
  const body = frozen({
    events: [
      render,
      { seq: 2, ts: 2, kind: 'comment', op: 'add', pin: PIN },
      element,
      grab,
      { seq: 5, ts: 5, kind: 'comment', op: 'edit', pin: PIN, became_shared: false, became_private: false },
      { seq: 6, ts: 6, kind: 'comment', op: 'delete', id: 'c1' },
    ],
    gap: false, dropped: 0, oldest: 1,
  });
  const out = stripText('routes', 'GET /api/events', body);
  assert.deepStrictEqual(out, {
    events: [
      render,
      { seq: 2, ts: 2, kind: 'comment', op: 'add' },
      element,
      grab,
      { seq: 5, ts: 5, kind: 'comment', op: 'edit', became_shared: false, became_private: false },
      { seq: 6, ts: 6, kind: 'comment', op: 'delete', id: 'c1' },
    ],
    gap: false, dropped: 0, oldest: 1,
  });
  assert.deepStrictEqual(marksIn(out), []);
  assert.equal(out.events[2], element, 'an entry with nothing to strip is the entry itself');
});

// ── a daemon at each level ──────────────────────────────────────────────────

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

async function ok(p, what) {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text || JSON.stringify(r.body)}`);
  return r.json !== undefined ? r.json : r.body;
}

// Two daemons on one sandbox HOME: one whose remote viewers are opted in at
// nothing (basic), one at `read`. Each holds a shared pin on MOUNT whose
// anchor carries the marks, made as the chrome makes it, and a committed node
// carrying that pin.
async function boot(t) {
  const readRoot = tmpRoot('wc-u332b-read-');
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(readRoot)]: 'read' } } });
  const out = {};
  for (const level of ['basic', 'read']) {
    const d = await withServer(t, level === 'basic' ? { seed } : { root: readRoot });
    t.after(stubPeers(d.server));
    d.call = (method, p, body, headers) => client.request(d.port, method, p, body, { headers, timeout: 10000 });
    await ok(d.api.post('/api/render', { id: MOUNT, html: '<p class="x">the pane\'s own words</p>' }), `${level}: render`);
    const pin = await ok(d.api.post('/api/elements', commentBody({ text: PIN_TEXT, shared: true, anchor: ANCHOR })), `${level}: pin`);
    await ok(d.api.post('/api/turn-begin', { message: 'commit the pin' }), `${level}: turn-begin`);
    const end = await ok(d.api.post('/api/turn-end', { author: 'claude', summary: 'committed' }), `${level}: turn-end`);
    assert.ok(end.node_id, `${level}: a node was committed: ${JSON.stringify(end)}`);
    d.node = end.node_id;
    d.pin = pin.pin.id;
    out[level] = d;
  }
  return out;
}

const routesOf = (d) => [`/api/graph/node/${d.node}`, `/preview/node/${d.node}`, '/api/events?since=0'];

test('(d) a basic reader — a remote viewer with no opt-in, a network peer — gets no anchor excerpt, fingerprint or pin text from the three routes; read and local are unchanged', async (t) => {
  const d = await boot(t);
  for (const level of ['basic', 'read']) {
    const { call } = d[level];
    for (const route of routesOf(d[level])) {
      const local = await call('GET', route);
      assert.equal(local.status, 200, `${level} local ${route}`);
      assert.ok(has(local.body, EXCERPT) && has(local.body, FINGERPRINT), `${level} ${route}: a local request carries the anchor`);
      if (!route.startsWith('/api/events')) assert.ok(has(local.body, PIN_TEXT), `${level} ${route}: and the pin's text`);

      const remote = await call('GET', route, null, REMOTE);
      assert.equal(remote.status, 200, `${level} remote ${route}`);
      const peer = await call('GET', route, null, { ...PEER, 'Sec-Fetch-Mode': 'cors' });
      assert.equal(peer.status, 200, `${level} peer ${route}`);
      // A network peer is basic at every opt-in.
      assert.deepStrictEqual([EXCERPT, FINGERPRINT].filter((m) => has(peer.body, m)), [], `${level} ${route}: a network peer`);
      // The ring is held to the anchor alone here, the two graph routes to the
      // pin's text as well. Its queue entries no longer quote a shared pin's
      // note below read (K.2-126, U332c), so the ring may now be held to MARKS
      // as well; U332c's own case in this file and its test prove that.
      const held = route.startsWith('/api/events') ? [EXCERPT, FINGERPRINT] : MARKS;
      assert.deepStrictEqual(held.filter((m) => has(peer.body, m)), [], `${level} ${route}: a network peer, the pin's text included`);
      if (level === 'basic') {
        assert.deepStrictEqual(held.filter((m) => has(remote.body, m)), [], `basic ${route}: a remote viewer`);
      } else {
        assert.ok(has(remote.body, EXCERPT) && has(remote.body, FINGERPRINT), `read ${route}: a remote viewer at read keeps the anchor`);
        if (!route.startsWith('/api/events')) assert.ok(has(remote.body, PIN_TEXT), `read ${route}: and the pin's text`);
      }
    }

    // The node read's JSON: the lists themselves.
    const nodeRoute = `/api/graph/node/${d[level].node}`;
    const local = (await call('GET', nodeRoute)).body;
    assert.deepStrictEqual(local.comments.map((c) => c.id), [d[level].pin]);
    assert.deepStrictEqual(local.lean_elements.map((c) => c.id), [d[level].pin]);
    for (const [who, headers] of [['remote', REMOTE], ['peer', PEER]]) {
      const body = (await call('GET', nodeRoute, null, headers)).body;
      const below = who === 'peer' || level === 'basic';
      assert.equal('comments' in body, !below, `${level} ${who}: comments ${below ? 'withheld' : 'kept'}`);
      assert.equal('lean_elements' in body, !below, `${level} ${who}: lean_elements ${below ? 'withheld' : 'kept'}`);
      assert.ok(Array.isArray(body.mounts) && body.mounts.some((m) => m.id === MOUNT), `${level} ${who}: the surface stays`);
      if (!below) assert.deepStrictEqual(body.comments.map((c) => c.id), [d[level].pin]);
    }

    // The ring's JSON: the comment entry stays, without its pin.
    const ringLocal = (await call('GET', '/api/events?since=0')).body;
    const ringPeer = (await call('GET', '/api/events?since=0', null, PEER)).body;
    const comments = (b) => b.events.filter((e) => e.kind === 'comment');
    assert.ok(comments(ringLocal).length >= 1 && comments(ringLocal).every((e) => e.pin), `${level}: the local ring carries the pin`);
    assert.equal(comments(ringPeer).length, comments(ringLocal).length, `${level}: the peer sees the same comment entries`);
    assert.ok(comments(ringPeer).every((e) => !('pin' in e)), `${level}: none of them with its pin`);
    assert.equal(ringPeer.events.length, ringLocal.events.length, `${level}: no entry withheld, only its pin`);
  }
});

test('(d) GET /api/events at basic: no queue entry\'s item quotes the shared pin\'s note (K.2-126); local does', async (t) => {
  const d = await boot(t);
  const { call } = d.basic;
  const queued = (b) => b.events.filter((e) => e.kind === 'queue' && e.item && e.item.kind === 'comment');
  const local = (await call('GET', '/api/events?since=0')).body;
  assert.ok(queued(local).some((e) => has(e.item, PIN_TEXT)), 'the local ring\'s queue entry quotes the note');
  for (const headers of [REMOTE, PEER]) {
    const body = (await call('GET', '/api/events?since=0', null, headers)).body;
    assert.equal(queued(body).length, queued(local).length, 'the same queue entries');
    assert.deepStrictEqual(marksIn(body), [], 'and no note, excerpt or fingerprint anywhere in the ring');
  }
});

test('(d) the ring\'s other readers below read: the stream and /api/wait hand a network peer no pin', async (t) => {
  const d = await boot(t);
  const { port, call } = d.basic;
  const http = require('http');
  // The stream's catch-up: read until the comment entry arrives (or time out).
  const streamed = (headers) => new Promise((resolve, reject) => {
    let text = '';
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/events/stream?since=0&kinds=comment', headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
        if (/event: comment\n/.test(text) && /\n\n$/.test(text)) { req.destroy(); resolve(text); }
      });
    });
    req.on('error', (e) => (text ? resolve(text) : reject(e)));
    req.setTimeout(10000, () => { req.destroy(); resolve(text); });
  });
  const localStream = await streamed({});
  assert.ok(has(localStream, EXCERPT) && has(localStream, FINGERPRINT), 'the local stream carries the anchor');
  const peerStream = await streamed({ ...PEER });
  assert.ok(/event: comment\n/.test(peerStream), 'the peer\'s stream carries the comment entry');
  assert.deepStrictEqual(marksIn(peerStream), [], 'without its pin');

  const wait = (headers) => call('POST', '/api/wait', { predicate: { event_kind: 'comment' }, timeout_ms: 1000 }, headers);
  const local = await wait();
  assert.equal(local.body.matched, 'event');
  assert.ok(has(local.body, EXCERPT), 'the local wait carries the pin');
  const peer = await wait({ ...PEER });
  assert.equal(peer.body.matched, 'event');
  assert.equal(peer.body.event.kind, 'comment');
  assert.deepStrictEqual(marksIn(peer.body), [], 'the peer\'s wait: no pin');
});

test('(e) the preview document for a node with a comment pin, at basic, holds neither the pin\'s text nor its anchor; at read and local it does', async (t) => {
  const d = await boot(t);
  for (const level of ['basic', 'read']) {
    const route = `/preview/node/${d[level].node}`;
    const { call } = d[level];
    const local = await call('GET', route);
    assert.equal(typeof local.body, 'string');
    assert.deepStrictEqual(marksIn(local.body), MARKS, `${level}: the local document embeds the pin`);
    assert.ok(local.body.includes('the pane\\u0027s own words') || local.body.includes('the pane\'s own words'), `${level}: and the pane`);
    for (const [who, headers] of [['remote', REMOTE], ['peer', PEER]]) {
      const r = await call('GET', route, null, headers);
      assert.equal(r.status, 200);
      const below = who === 'peer' || level === 'basic';
      assert.deepStrictEqual(marksIn(r.body), below ? [] : MARKS, `${level} ${who}`);
      assert.ok(r.body.includes('own words'), `${level} ${who}: the surface stays`);
    }
  }
});
