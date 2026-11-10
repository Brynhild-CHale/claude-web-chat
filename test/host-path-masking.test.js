// Host-path masking at serve, below local (tranche 6 U752, 6B.5; contract 11
// section 5, C-11.8, C-11.13, C-11.25; 04 C-04.17; REQ@host-path-masking (a)).
//
// The user's own words — the lock's prompt, a node's trigger, a comment —
// hold a path under the (sandboxed) home and one under the project root. A
// request or socket the audience does not judge local (a labelled tunnel
// viewer at read and at basic, a relayed request) gets them with the root as
// `<project>` and the home as `~`, through ONE middleware
// (lib/server/host-mask hostMaskBelowLocal, mounted in lib/server/index.js)
// and the WebSocket projector (maskFrameText); a local request or socket gets
// them whole. Pane html and the store are the surface (contract 11 section
// 4): byte-identical for both. A wipe's and a new graph's label is masked at
// emit, on the ring at every level, while the bookmark the graph keeps is
// the label as typed.
//
// The relay secret is a fresh random value per process, carried only in
// request headers here: never printed. HOME is withServer's sandbox.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withServer, waitUntil, wsConnect, commentBody } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths, realpath } = require('../lib/core/paths');
const { LEVEL_HEADER, REMOTE_HEADER } = require('../lib/core/cors');
const { RELAY_HEADER } = require('../lib/core/writer-token');
const { createServer } = require('../lib/server');
const { maskHostText, maskFrameText, maskQueueItem, maskQueueBody, hostMaskBelowLocal, HOST_MASK_PREFIXES } = require('../lib/server/host-mask');

const SECRET = crypto.randomBytes(32).toString('hex');

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const writeTunnel = (root, optIn) => writeJsonAtomic(userPaths().tunnelConfig,
  optIn ? { ...TUNNEL, remote: { mirror: { [path.resolve(root)]: optIn } } } : { ...TUNNEL });

// The connector record (ceiling full) in the sandbox's connector directory.
function connectorRecord() {
  const dir = userPaths().connectorDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'hub-test.json');
  writeJsonAtomic(file, { record_version: 1, hub: { id: 'hub-test' }, ceiling: 'full' });
  return file;
}

async function boot(t, optIn = 'read') {
  let rec = null;
  const d = await withServer(t, {
    seed: ({ root }) => { writeTunnel(root, optIn); rec = connectorRecord(); },
    createServer: (o) => createServer({ ...o, relaySecret: SECRET, relaySecretVia: 'option', connectorRecord: rec }),
  });
  return d;
}

const REMOTE = { [REMOTE_HEADER]: '1' };
const RELAYED = (stamp) => ({ [REMOTE_HEADER]: '1', [RELAY_HEADER]: SECRET, [LEVEL_HEADER]: stamp });

// The two planted paths and what they read masked.
function planted(root) {
  const home = os.homedir();
  return {
    home, root,
    homes: [...new Set([home, realpath(home)].filter(Boolean))],
    roots: [...new Set([root, realpath(root)].filter(Boolean))],
    text: (what) => `${what} ${path.join(home, 'proj', 'x')} and ${path.join(root, 'y')}`,
    masked: (what) => `${what} ~/proj/x and <project>/y`,
  };
}
const rawIn = (p, value) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return [...p.homes, ...p.roots].filter((d) => s.includes(d));
};
// A node or diff body less its pass-through carriers.
const lessSurface = (body) => {
  if (!body || typeof body !== 'object') return body;
  const { mounts, store, markdown, ...rest } = body;
  return rest;
};

// ── the module ──────────────────────────────────────────────────────────────

test('maskHostText: the root and the home masked in every string, pass-through carriers whole; maskFrameText only its fields', () => {
  const home = '/home/someone';
  const root = '/home/someone/work/proj';
  const body = {
    lock: { message: `see ${root}/a.js and ${home}/notes.md` },
    nodes: [{ trigger_summary: `${home}/x` }],
    mounts: [{ html: `<p>${home}/x</p>` }],
    store: { k: `${home}/x` },
    markdown: [{ text: `${home}/x` }],
    deep: { mounts: `${home}/kept`, other: `${home}/gone` },
    when: new Date(0),
  };
  const out = maskHostText(body, { root, home });
  assert.strictEqual(out.lock.message, 'see <project>/a.js and ~/notes.md');
  assert.strictEqual(out.nodes[0].trigger_summary, '~/x');
  assert.deepStrictEqual(out.mounts, body.mounts);
  assert.deepStrictEqual(out.store, body.store);
  assert.deepStrictEqual(out.markdown, body.markdown);
  assert.strictEqual(out.deep.mounts, `${home}/kept`);
  assert.strictEqual(out.deep.other, '~/gone');
  assert.strictEqual(out.when, new Date(0).toISOString());
  assert.strictEqual(body.lock.message, `see ${root}/a.js and ${home}/notes.md`, 'the input is not touched');
  assert.strictEqual(maskHostText(`${home}/a`, { root, home }), '~/a');

  const hello = { type: 'hello', lock: { message: `${home}/a` }, mounts: [{ html: `${home}/a` }], store: { k: `${home}/a` }, elements: [{ text: `${home}/a` }], project: `${home}/name` };
  const m = maskFrameText(hello, { root, home });
  assert.strictEqual(m.lock.message, '~/a');
  assert.strictEqual(m.elements[0].text, '~/a');
  assert.strictEqual(m.mounts, hello.mounts, 'pane html shared, not copied');
  assert.strictEqual(m.store, hello.store, 'the store shared, not copied');
  assert.strictEqual(m.project, hello.project, 'a field outside the frame text fields is untouched');
  const el = maskFrameText({ type: 'element:comment', pin: { text: `${home}/a` } }, { root, home });
  assert.strictEqual(el.pin.text, '~/a', 'an element frame masked whole');
  const store = { type: 'store:patch', patch: { k: `${home}/a` } };
  assert.strictEqual(maskFrameText(store, { root, home }), store, 'a frame with no text fields is returned as it is');

  // The queue item rule: a message item keeps its text (C-11.14); a comment
  // or element item has its TEXT_RULES.items fields masked, nothing else.
  const msg = { kind: 'message', text: `see ${home}/a`, summary: 'message · 9 chars' };
  const pin = { kind: 'element', type: 'comment', summary: `pane-a · "${home}/a"`, members: [{ id: 'c1', words: `${home}/a` }], excerpt: `${home}/a`, origin_mount: 'pane-a', why_wake: `${home}/kept` };
  assert.strictEqual(maskQueueItem(msg, { root, home }), msg, 'a message item as it is');
  const mp = maskQueueItem(pin, { root, home });
  assert.strictEqual(mp.summary, 'pane-a · "~/a"');
  assert.strictEqual(mp.members[0].words, '~/a');
  assert.strictEqual(mp.excerpt, '~/a');
  assert.strictEqual(mp.why_wake, `${home}/kept`, 'a field TEXT_RULES.items does not name is untouched');
  const qf = maskFrameText({ type: 'queue', op: 'add', item: pin }, { root, home });
  assert.strictEqual(qf.item.summary, 'pane-a · "~/a"', 'the queue frame\'s item');
  const qm = { type: 'queue', op: 'add', item: msg };
  assert.strictEqual(maskFrameText(qm, { root, home }), qm, 'a queue frame with a message item as it is');
  const qb = maskQueueBody({ items: [msg, pin], pending: { items: [pin], note: `${home}/n` } }, { root, home });
  assert.strictEqual(qb.items[0], msg, 'GET /api/queue: the message item as it is');
  assert.strictEqual(qb.items[1].summary, 'pane-a · "~/a"');
  assert.strictEqual(qb.items[1].why_wake, `${home}/kept`);
  assert.strictEqual(qb.pending.items[0].summary, 'pane-a · "~/a"', 'the park\'s items');
  assert.strictEqual(qb.pending.note, '~/n', 'the rest of the body masked');
});

test('hostMaskBelowLocal: a local request passes; any other level, or none, is masked; outside its prefixes nothing is', () => {
  const home = '/home/someone';
  const runBody = (level, url, body) => {
    let sent = null;
    const res = { json(b) { sent = b; return this; } };
    const audience = { levelOf: () => { if (level === 'throw') throw new Error('x'); return level; } };
    const mw = hostMaskBelowLocal({ audience, root: null, prefixes: HOST_MASK_PREFIXES });
    let nexted = false;
    mw({ originalUrl: url, url, headers: {} }, res, () => { nexted = true; });
    assert.ok(nexted);
    res.json(body);
    return sent;
  };
  const run = (level, url) => runBody(level, url, { text: `${home}/a` }).text;
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.strictEqual(run('local', '/api/graph'), `${home}/a`);
    for (const level of ['full', 'read', 'basic', 'throw']) {
      assert.strictEqual(run(level, '/api/graph'), '~/a', level);
      assert.strictEqual(run(level, '/api/graph/node/n1?x=1'), '~/a', level);
      assert.strictEqual(run(level, '/api/health'), '~/a', level);
      assert.strictEqual(run(level, '/api/elements?type=comment'), '~/a', level);
      assert.strictEqual(run(level, '/api/events?since=0'), '~/a', level);
      assert.strictEqual(run(level, '/api/replay/path'), '~/a', level);
      assert.strictEqual(run(level, '/api/mounts/pane-a/history?from=n1'), '~/a', level);
      assert.strictEqual(run(level, '/api/graphical'), `${home}/a`, 'a prefix is a whole segment');
      assert.strictEqual(run(level, '/api/mounts'), `${home}/a`, 'the live mounts are the surface');
      assert.strictEqual(run(level, '/api/mounts/pane-a/restore'), `${home}/a`, 'only the history under /api/mounts');
      assert.strictEqual(run(level, '/api/queue'), '~/a', level);
      assert.strictEqual(run(level, '/api/queued'), `${home}/a`, 'outside the prefixes');
      // Express routes case-insensitively and the portal's classify lowercases
      // a path, so a prefix is matched in any case (U752@host-mask.js:66).
      assert.strictEqual(run(level, '/API/graph'), '~/a', `${level} /API/graph`);
      assert.strictEqual(run(level, '/api/Health'), '~/a', `${level} /api/Health`);
      assert.strictEqual(run(level, '/Api/graph/NODE/n1?X=1'), '~/a', `${level} /Api/graph/NODE/n1`);
      assert.strictEqual(run(level, '/api/MOUNTS/pane-a/HISTORY'), '~/a', `${level} /api/MOUNTS/pane-a/HISTORY`);
      assert.strictEqual(run(level, '/API/GRAPHICAL'), `${home}/a`, 'a prefix is a whole segment in any case');
      // The queue rule takes the same case rule: /API/queue's body goes
      // through maskQueueBody (a message item's text verbatim, the rest masked).
      const q = runBody(level, '/API/queue', { items: [{ kind: 'message', text: `${home}/m` }], note: `${home}/n` });
      assert.strictEqual(q.note, '~/n', `${level} /API/queue: the body masked`);
      assert.strictEqual(q.items[0].text, `${home}/m`, `${level} /API/queue: the queue item rule (a message item verbatim)`);
    }
    assert.strictEqual(run('local', '/API/graph'), `${home}/a`, 'local: /API/graph whole');
  } finally { process.env.HOME = prev; }
});

// ── the daemon: graph, node, health and element reads ───────────────────────

test('graph text, health\'s lock and element text: masked for a remote request at read and basic and a relayed one; whole for a local one; pane html and the store pass through', async (t) => {
  const d = await boot(t, 'read');
  const p = planted(d.root);
  const { api } = d;
  await api.post('/api/render', { id: 'pane-a', html: `<p>${p.text('pane')}</p>` });
  await api.post('/api/store', { patch: { where: p.text('store') } });
  const tb = await api.post('/api/turn-begin', { message: p.text('prompt'), author: 'user' });
  assert.strictEqual(tb.status, 200, tb.text);
  const c = await api.post('/api/elements', commentBody({ text: p.text('comment'), shared: true, anchor: { mount: 'pane-a' } }));
  assert.strictEqual(c.status, 200, c.text);

  // The comment pinned on pane-a queues an item whose summary quotes it: GET
  // /api/queue serves it masked below local and whole to a local read.
  const queueItem = (body) => ((body && body.items) || []).find((it) => it.kind !== 'message' && JSON.stringify(it).includes('proj/x'));
  const lq = await waitUntil(async () => queueItem((await api.get('/api/queue')).json), { timeout: 5000, interval: 20, what: 'the comment\'s queue item' });
  assert.ok(JSON.stringify(lq).includes(path.join(p.home, 'proj', 'x')), `local: the queue item quotes the comment as typed: ${JSON.stringify(lq)}`);
  for (const [who, h] of [['remote read', REMOTE], ['relayed read', RELAYED('read')]]) {
    const q = await api.get('/api/queue', h);
    assert.strictEqual(q.status, 200, q.text);
    const it = queueItem(q.json);
    assert.ok(it && JSON.stringify(it).includes('~/proj/x'), `${who}: the comment's queue item masked: ${q.text.slice(0, 400)}`);
    assert.deepStrictEqual(rawIn(p, q.text), [], `${who}: no raw host path on GET /api/queue`);
  }

  // While the turn runs: the lock on health and the graph.
  const health = async (h) => (await api.get('/api/health', h)).json;
  const graph = async (h) => (await api.get('/api/graph', h)).json;
  assert.strictEqual((await health()).lock.message, p.text('prompt'), 'local: the lock whole');
  assert.strictEqual((await graph()).lock.message, p.text('prompt'));
  for (const [who, h] of [['remote read', REMOTE], ['relayed read', RELAYED('read')], ['relayed full', RELAYED('full')]]) {
    const hb = await health(h);
    assert.strictEqual(hb.lock.message, p.masked('prompt'), `${who}: health's lock masked`);
    assert.deepStrictEqual(rawIn(p, hb), [], `${who}: no raw host path in health`);
    const gb = await graph(h);
    assert.strictEqual(gb.lock.message, p.masked('prompt'), `${who}: the graph's lock masked`);
    assert.deepStrictEqual(rawIn(p, gb), [], `${who}: no raw host path in the graph`);
  }
  // The same routes spelled in another case: Express answers them, and so must
  // the mask (U752@host-mask.js:66).
  for (const url of ['/API/health', '/Api/graph', '/api/Health', '/API/queue']) {
    const lr = await api.get(url);
    assert.strictEqual(lr.status, 200, `local ${url}: ${lr.text.slice(0, 200)}`);
    assert.ok(lr.text.includes(path.join(p.home, 'proj', 'x')), `local ${url}: whole`);
    for (const [who, h] of [['remote read', REMOTE], ['relayed read', RELAYED('read')]]) {
      const r = await api.get(url, h);
      assert.strictEqual(r.status, 200, `${who} ${url}: ${r.text.slice(0, 200)}`);
      assert.ok(r.text.includes('~/proj/x'), `${who} ${url}: masked: ${r.text.slice(0, 300)}`);
      assert.deepStrictEqual(rawIn(p, r.text), [], `${who} ${url}: no raw host path`);
    }
  }

  const te = await api.post('/api/turn-end', { author: 'claude', reply: p.text('reply'), ended: 'stop' });
  assert.ok(te.json && te.json.node_id, te.text);
  const id = te.json.node_id;

  const node = async (h) => (await api.get(`/api/graph/node/${id}`, h)).json;
  const elements = async (h) => (await api.get('/api/elements?type=comment', h));
  const local = await node();
  assert.strictEqual(local.trigger.message, p.text('prompt'), 'local: the node trigger whole');
  assert.strictEqual(local.trigger.reply, p.text('reply'));
  assert.ok(JSON.stringify(local.comments).includes(p.text('comment')), 'local: the node comment whole');
  assert.ok(JSON.stringify((await graph()).nodes).includes(p.text('prompt').slice(0, 20)), 'local: the trigger summary whole');
  const localEls = (await elements()).json;
  assert.ok(JSON.stringify(localEls).includes(p.text('comment')), 'local: the comment whole on GET /api/elements');

  for (const [who, h] of [['remote read', REMOTE], ['relayed read', RELAYED('read')], ['relayed full', RELAYED('full')]]) {
    const n = await node(h);
    assert.strictEqual(n.trigger.message, p.masked('prompt'), `${who}: trigger message`);
    assert.strictEqual(n.trigger.reply, p.masked('reply'), `${who}: trigger reply`);
    assert.ok(JSON.stringify(n.comments).includes(p.masked('comment')), `${who}: the node comment masked: ${JSON.stringify(n.comments)}`);
    assert.deepStrictEqual(rawIn(p, lessSurface(n)), [], `${who}: no raw host path in the node read outside its surface`);
    assert.deepStrictEqual(n.mounts, local.mounts, `${who}: pane html passes through`);
    assert.deepStrictEqual(n.store, local.store, `${who}: the store passes through`);
    const g = await graph(h);
    assert.deepStrictEqual(rawIn(p, g), [], `${who}: no raw host path in GET /api/graph`);
    assert.ok(g.nodes.some((x) => String(x.trigger_summary || '').includes('~/proj/x')), `${who}: the trigger summary masked`);
    const e = await elements(h);
    assert.strictEqual(e.status, 200, e.text);
    assert.ok(e.text.includes(p.masked('comment')), `${who}: the comment masked on GET /api/elements: ${e.text.slice(0, 400)}`);
    assert.deepStrictEqual(rawIn(p, e.text), [], `${who}: no raw host path on GET /api/elements`);
    // The other readers of the same text: the ring's page, the replay path,
    // a pane's version history (JSON, the middleware), the node preview (the
    // document, routes/graph.js) — less its pane html, which passes through.
    for (const url of ['/api/events?since=0', '/api/replay/path', '/api/mounts/pane-a/history']) {
      const r = await api.get(url, h);
      assert.strictEqual(r.status, 200, `${who} ${url}: ${r.text.slice(0, 200)}`);
      assert.deepStrictEqual(rawIn(p, r.text), [], `${who} ${url}: no raw host path`);
    }
    const pv = await api.get(`/preview/node/${id}`, h);
    assert.strictEqual(pv.status, 200);
    const outsideSurface = (doc) => doc.split(p.text('pane')).join('<pane>').split(p.text('store')).join('<store>');
    assert.ok(pv.text.includes(p.text('pane')) && pv.text.includes(p.text('store')), `${who}: the preview's pane html and store pass through`);
    assert.deepStrictEqual(rawIn(p, outsideSurface(pv.text)), [], `${who}: the node preview holds no raw host path outside its pane html and store`);
  }
  assert.ok((await api.get('/api/replay/path')).text.includes(path.join(p.home, 'proj', 'x')), 'local: the replay path whole');
  // The node read spelled in another case (U752@host-mask.js:66).
  {
    const url = `/api/GRAPH/node/${id}`;
    const lr = await api.get(url);
    assert.strictEqual(lr.status, 200, `local ${url}: ${lr.text.slice(0, 200)}`);
    assert.strictEqual(lr.json.trigger.message, p.text('prompt'), `local ${url}: whole`);
    for (const [who, h] of [['relayed read', RELAYED('read')], ['remote read', REMOTE]]) {
      const r = await api.get(url, h);
      assert.strictEqual(r.status, 200, `${who} ${url}: ${r.text.slice(0, 200)}`);
      assert.strictEqual(r.json.trigger.message, p.masked('prompt'), `${who} ${url}: the trigger masked`);
      assert.deepStrictEqual(rawIn(p, lessSurface(r.json)), [], `${who} ${url}: no raw host path outside its surface`);
    }
  }
  // The files on disk keep the host's history whole.
  const nodeFile = fs.readdirSync(path.join(d.webChatDir, 'graph')).find((f) => f.startsWith(id));
  assert.ok(nodeFile, 'the node file');
  assert.ok(fs.readFileSync(path.join(d.webChatDir, 'graph', nodeFile), 'utf8').includes(p.text('prompt')), 'the node file holds the prompt as typed');

  // At basic (the opt-in removed): the text is stripped, and nothing left is raw.
  writeTunnel(d.root, null);
  await waitUntil(async () => (await api.get('/api/mirror/access', REMOTE)).json?.level === 'basic', { timeout: 10000, interval: 25, what: 'basic' });
  for (const [who, h] of [['remote basic', REMOTE], ['relayed basic', RELAYED('basic')]]) {
    for (const url of ['/api/graph', `/api/graph/node/${id}`, '/api/health', '/api/elements?type=comment']) {
      const r = await api.get(url, h);
      const body = r.json && url.includes('/node/') ? lessSurface(r.json) : r.text;
      assert.deepStrictEqual(rawIn(p, body), [], `${who} ${url} (${r.status}): no raw host path`);
    }
  }
});

// ── the WebSocket: the hello and a lock frame ───────────────────────────────

function collect(t, port, headers) {
  const ws = wsConnect(port, '/ws', headers ? { headers } : undefined);
  t.after(() => { try { ws.terminate(); } catch {} });
  const rec = { ws, frames: [], texts: [] };
  ws.on('message', (data) => {
    try { rec.frames.push(JSON.parse(data.toString())); rec.texts.push(data.toString()); } catch {}
  });
  rec.of = (type) => rec.frames.filter((f) => f.type === type);
  rec.opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return rec;
}

test('the /ws hello and a lock frame: masked for a read socket, whole for a local one; pane html and the store byte-identical', async (t) => {
  const d = await boot(t, 'read');
  const p = planted(d.root);
  const { api } = d;
  await api.post('/api/render', { id: 'pane-a', html: `<p>${p.text('pane')}</p>` });
  await api.post('/api/store', { patch: { where: p.text('store') } });

  // Sockets open before the turn: its lock frame.
  const local = collect(t, d.port);
  const remote = collect(t, d.port, REMOTE);
  const relayed = collect(t, d.port, RELAYED('read'));
  await Promise.all([local.opened, remote.opened, relayed.opened]);
  for (const s of [local, remote, relayed]) await waitUntil(() => s.of('hello').length, { timeout: 5000, interval: 10, what: 'hello' });
  await api.post('/api/turn-begin', { message: p.text('prompt'), author: 'user' });
  for (const s of [local, remote, relayed]) await waitUntil(() => s.of('lock').some((f) => f.lock), { timeout: 5000, interval: 10, what: 'lock frame' });
  assert.strictEqual(local.of('lock').find((f) => f.lock).lock.message, p.text('prompt'), 'local: the lock frame whole');
  for (const [who, s] of [['remote read', remote], ['relayed read', relayed]]) {
    assert.strictEqual(s.of('lock').find((f) => f.lock).lock.message, p.masked('prompt'), `${who}: the lock frame masked`);
  }

  // Sockets opened while the turn runs: the hello's lock.
  const local2 = collect(t, d.port);
  const remote2 = collect(t, d.port, REMOTE);
  await Promise.all([local2.opened, remote2.opened]);
  for (const s of [local2, remote2]) await waitUntil(() => s.of('hello').length, { timeout: 5000, interval: 10, what: 'hello' });
  const lh = local2.of('hello')[0];
  const rh = remote2.of('hello')[0];
  assert.strictEqual(lh.lock.message, p.text('prompt'), 'local: the hello\'s lock whole');
  assert.strictEqual(rh.lock.message, p.masked('prompt'), 'read: the hello\'s lock masked');
  assert.strictEqual(JSON.stringify(rh.mounts), JSON.stringify(lh.mounts), 'pane html byte-identical');
  assert.strictEqual(JSON.stringify(rh.store), JSON.stringify(lh.store), 'the store byte-identical');
  assert.ok(JSON.stringify(rh.mounts).includes(p.text('pane')), 'the pane html as rendered');

  // A comment pinned on pane-a queues an item quoting it: the `queue` frame's
  // item is masked for a read socket and whole for a local one.
  const c = await api.post('/api/elements', commentBody({ text: p.text('comment'), shared: true, anchor: { mount: 'pane-a' } }));
  assert.strictEqual(c.status, 200, c.text);
  const queuedAdd = (s) => s.of('queue').find((f) => f.op === 'add' && f.item && f.item.kind !== 'message' && JSON.stringify(f.item).includes('proj/x'));
  for (const s of [local, remote, relayed]) await waitUntil(() => queuedAdd(s), { timeout: 5000, interval: 10, what: 'the queue frame' });
  assert.ok(JSON.stringify(queuedAdd(local).item).includes(path.join(p.home, 'proj', 'x')), 'local: the queue item as typed');
  for (const [who, s] of [['remote read', remote], ['relayed read', relayed]]) {
    assert.ok(JSON.stringify(queuedAdd(s).item).includes('~/proj/x'), `${who}: the queue item masked: ${JSON.stringify(queuedAdd(s).item)}`);
    assert.deepStrictEqual(rawIn(p, queuedAdd(s)), [], `${who}: no raw host path on the queue frame`);
  }

  // A wipe asked for while the turn holds the lock queues: its reaim:pending
  // frame names the label, masked for a socket that is not local.
  const queued = await api.post('/api/graph/wipe', { name: p.text('queued wipe') });
  assert.strictEqual(queued.json && queued.json.pending, true, queued.text);
  for (const s of [local, remote]) await waitUntil(() => s.of('reaim:pending').length, { timeout: 5000, interval: 10, what: 'reaim:pending' });
  assert.strictEqual(local.of('reaim:pending')[0].intent.name, p.text('queued wipe'), 'local: the queued label whole');
  assert.strictEqual(remote.of('reaim:pending')[0].intent.name, p.masked('queued wipe'), 'read: the queued label masked');

  // The node-added frame after the turn ends; and no raw host path on any
  // frame a non-local socket received outside the surface carriers.
  await api.post('/api/turn-end', { author: 'claude', reply: p.text('reply'), ended: 'stop' });
  for (const s of [local, remote]) await waitUntil(() => s.of('node-added').length, { timeout: 5000, interval: 10, what: 'node-added' });
  assert.ok(String(local.of('node-added')[0].node.trigger_summary).includes(path.join(p.home, 'proj', 'x')), 'local: the trigger summary whole');
  assert.ok(String(remote.of('node-added')[0].node.trigger_summary).includes('~/proj/x'), 'read: the trigger summary masked');
  for (const [who, s] of [['remote read', remote], ['relayed read', relayed], ['remote read (2)', remote2]]) {
    for (const f of s.frames) {
      assert.deepStrictEqual(rawIn(p, lessSurface(f)), [], `${who}: ${f.type} holds no raw host path outside pane html and the store`);
    }
  }
});

// ── the ring: wipe and new-graph labels ─────────────────────────────────────

test('a wipe and a new graph named with a host path: the ring events carry the label masked; the kept bookmark is the label as typed', async (t) => {
  const d = await boot(t, 'read');
  const p = planted(d.root);
  const { api } = d;
  await api.post('/api/render', { id: 'pane-a', html: '<p>a</p>' });
  const base = await api.post('/api/commit', { message: 'base' });
  assert.ok(base.json && base.json.node_id, base.text);
  const sse = await d.sse();
  t.after(() => sse.close());

  // A bookmark named with a host path (U752@bookmark-frame-name): the
  // `bookmark` frame carries the name masked to a read socket and as typed to
  // a local one, as GET /api/graph serves it.
  const local = collect(t, d.port);
  const remote = collect(t, d.port, REMOTE);
  const relayed = collect(t, d.port, RELAYED('read'));
  await Promise.all([local.opened, remote.opened, relayed.opened]);
  for (const s of [local, remote, relayed]) await waitUntil(() => s.of('hello').length, { timeout: 5000, interval: 10, what: 'hello' });
  const bm = await api.post('/api/graph/bookmark', { id: base.json.node_id, name: p.text('mark') });
  assert.strictEqual(bm.status, 200, bm.text);
  assert.strictEqual(bm.json.name, p.text('mark'), 'the local answer names the bookmark as typed');
  for (const s of [local, remote, relayed]) await waitUntil(() => s.of('bookmark').length, { timeout: 5000, interval: 10, what: 'the bookmark frame' });
  assert.strictEqual(local.of('bookmark')[0].name, p.text('mark'), 'local: the bookmark frame names it as typed');
  for (const [who, s] of [['remote read', remote], ['relayed read', relayed]]) {
    assert.strictEqual(s.of('bookmark')[0].name, p.masked('mark'), `${who}: the bookmark frame's name masked`);
    assert.deepStrictEqual(rawIn(p, s.of('bookmark')), [], `${who}: no raw host path on the bookmark frame`);
  }
  const remoteGraph = (await api.get('/api/graph', REMOTE)).json;
  assert.ok(remoteGraph.nodes.some((x) => x.name === p.masked('mark')), 'GET /api/graph serves the same name masked');
  assert.strictEqual((await api.get(`/api/graph/node/${base.json.node_id}`)).json.name, p.text('mark'), 'the node keeps the name as typed');

  const w = await api.post('/api/graph/wipe', { name: p.text('wipe') });
  assert.strictEqual(w.status, 200, w.text);
  assert.strictEqual(w.json.name, p.text('wipe'), 'the local answer names the label as typed');
  assert.strictEqual((await api.get('/api/graph')).json.pending_bookmark.name, p.text('wipe'), 'the kept bookmark is the label as typed');
  assert.strictEqual((await api.get('/api/graph', REMOTE)).json.pending_bookmark.name, p.masked('wipe'), 'a remote read of it is masked');

  const n = await api.post('/api/graph/new', { name: p.text('graph') });
  assert.strictEqual(n.status, 200, n.text);
  assert.strictEqual((await api.get('/api/graph')).json.pending_bookmark.name, p.text('graph'), 'the kept bookmark is the label as typed');

  const events = (await api.get('/api/events?since=0')).json.events || [];
  const wipes = events.filter((e) => e.kind === 'graph' && e.op === 'wipe');
  const news = events.filter((e) => e.kind === 'graph' && e.op === 'new-graph');
  assert.ok(wipes.length >= 1 && news.length === 1, JSON.stringify(events.map((e) => [e.kind, e.op])));
  assert.strictEqual(wipes[0].name, p.masked('wipe'), 'the wipe label masked on the ring (a local read)');
  assert.strictEqual(news[0].name, p.masked('graph'), 'the new graph label masked on the ring (a local read)');
  assert.deepStrictEqual(rawIn(p, [...wipes, ...news]), [], 'no raw host path on the ring');
  await waitUntil(() => sse.events.some((e) => e.kind === 'graph' && e.op === 'new-graph'), { timeout: 5000, interval: 10, what: 'the SSE copy' });
  assert.deepStrictEqual(rawIn(p, sse.events.filter((e) => e.kind === 'graph')), [], 'no raw host path on the SSE stream');

  // The bookmark lands on the next commit's node, as typed.
  await api.post('/api/render', { id: 'pane-b', html: '<p>b</p>' });
  const c = await api.post('/api/commit', { message: 'after' });
  const nodeRead = (await api.get(`/api/graph/node/${c.json.node_id}`)).json;
  assert.strictEqual(nodeRead.name, p.text('graph'), 'the node keeps the label as typed');
});

// ── the documents (U752b): the replay player, its download, the page export ──
//
// Each HTML document a reader below local may fetch: the planted prompt (a
// caption, with include_prompts) and the planted comment (one of the node's
// elements, the export's and the replay's doc_elements) masked for a remote
// read viewer and a relayed request stamped read; the pane html and the store
// (the surface) pass through; a local reader gets every word as typed.

async function documentScene(t) {
  const d = await boot(t, 'read');
  const p = planted(d.root);
  const { api } = d;
  await api.post('/api/render', { id: 'pane-a', html: `<p>${p.text('pane')}</p>` });
  await api.post('/api/store', { patch: { where: p.text('store') } });
  const tb = await api.post('/api/turn-begin', { message: p.text('prompt'), author: 'user' });
  assert.strictEqual(tb.status, 200, tb.text);
  const c = await api.post('/api/elements', commentBody({ text: p.text('comment'), shared: true, anchor: { mount: 'pane-a' } }));
  assert.strictEqual(c.status, 200, c.text);
  const te = await api.post('/api/turn-end', { author: 'claude', reply: p.text('reply'), ended: 'stop' });
  assert.ok(te.json && te.json.node_id, te.text);
  const label = (await api.get(`/api/graph/node/${te.json.node_id}`)).json.label;
  assert.ok(label, 'the node has a label');
  return { d, p, api, label };
}

// The document less its surface (pane html and store pass through, whole).
const outsideSurfaceOf = (p, doc) => doc.split(p.text('pane')).join('<pane>').split(p.text('store')).join('<store>');
const asTyped = (p, what) => p.text(what).split(' and ')[0]; // `<what> <home>/proj/x`
const maskedAs = (what) => `${what} ~/proj/x`;

async function documentCase(t, url, { prompt }) {
  const { p, api, label } = await documentScene(t);
  const u = url(label);
  const local = await api.get(u);
  assert.strictEqual(local.status, 200, `local ${u}: ${local.text.slice(0, 200)}`);
  if (prompt) assert.ok(local.text.includes(asTyped(p, 'prompt')), `local ${u}: the caption's prompt as typed`);
  assert.ok(local.text.includes(asTyped(p, 'comment')), `local ${u}: the comment as typed`);
  for (const [who, h] of [['remote read', REMOTE], ['relayed read', RELAYED('read')]]) {
    const r = await api.get(u, h);
    assert.strictEqual(r.status, 200, `${who} ${u}: ${r.text.slice(0, 200)}`);
    assert.ok(r.text.includes(p.text('pane')) && r.text.includes(p.text('store')), `${who} ${u}: the pane html and the store pass through`);
    if (prompt) assert.ok(r.text.includes(maskedAs('prompt')), `${who} ${u}: the caption's prompt masked`);
    assert.ok(r.text.includes(maskedAs('comment')), `${who} ${u}: the comment masked`);
    assert.deepStrictEqual(rawIn(p, outsideSurfaceOf(p, r.text)), [], `${who} ${u}: no raw host path outside its pane html and store`);
  }
}

test('GET /replay: the captions (include_prompts) and the elements masked for a remote and a relayed read; whole for a local reader', async (t) => {
  await documentCase(t, (label) => `/replay?from=${label}&include_prompts=1`, { prompt: true });
});

test('GET /api/replay/html: the downloaded replay\'s captions and elements masked for a remote and a relayed read; whole for a local reader', async (t) => {
  await documentCase(t, (label) => `/api/replay/html?from=${label}&include_prompts=1`, { prompt: true });
});

test('GET /api/export/:ref: the export\'s elements (the pinned comment) masked for a remote and a relayed read; whole for a local reader', async (t) => {
  await documentCase(t, (label) => `/api/export/${label}`, { prompt: false });
});

// A rendered replay .html (POST /api/replay/render, format 'replay') is built
// once, for its file reader (RENDERED_FILE_LEVEL, below local), and served by
// GET /api/replay/file/:name to any viewer at read and above: its captions
// are masked in the file itself, as its elements are, whoever fetches it.
test('GET /api/replay/file/:name: a rendered replay .html carries its captions (include_prompts) and elements masked for a remote and a relayed read', async (t) => {
  const { p, api, label } = await documentScene(t);
  const out = await api.post('/api/replay/render', { format: 'replay', from: label, to: label, include_prompts: true });
  assert.strictEqual(out.status, 200, out.text);
  assert.ok(out.json && out.json.path, out.text);
  const u = `/api/replay/file/${encodeURIComponent(path.basename(out.json.path))}`;
  for (const [who, h] of [['remote read', REMOTE], ['relayed read', RELAYED('read')]]) {
    const r = await api.get(u, h);
    assert.strictEqual(r.status, 200, `${who} ${u}: ${r.text.slice(0, 200)}`);
    assert.ok(r.text.includes(p.text('pane')) && r.text.includes(p.text('store')), `${who} ${u}: the pane html and the store pass through`);
    assert.ok(r.text.includes(maskedAs('prompt')), `${who} ${u}: the caption's prompt masked`);
    assert.ok(r.text.includes(maskedAs('comment')), `${who} ${u}: the comment masked`);
    assert.deepStrictEqual(rawIn(p, outsideSurfaceOf(p, r.text)), [], `${who} ${u}: no raw host path outside its pane html and store`);
  }
});
