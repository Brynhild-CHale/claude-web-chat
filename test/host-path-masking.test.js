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
const { maskHostText, maskFrameText, hostMaskBelowLocal, HOST_MASK_PREFIXES } = require('../lib/server/host-mask');

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
});

test('hostMaskBelowLocal: a local request passes; any other level, or none, is masked; outside its prefixes nothing is', () => {
  const home = '/home/someone';
  const run = (level, url) => {
    let sent = null;
    const res = { json(b) { sent = b; return this; } };
    const audience = { levelOf: () => { if (level === 'throw') throw new Error('x'); return level; } };
    const mw = hostMaskBelowLocal({ audience, root: null, prefixes: HOST_MASK_PREFIXES });
    let nexted = false;
    mw({ originalUrl: url, url, headers: {} }, res, () => { nexted = true; });
    assert.ok(nexted);
    res.json({ text: `${home}/a` });
    return sent.text;
  };
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
      assert.strictEqual(run(level, '/api/queue'), `${home}/a`, 'outside the prefixes');
    }
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
  await api.post('/api/commit', { message: 'base' });
  const sse = await d.sse();
  t.after(() => sse.close());

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
