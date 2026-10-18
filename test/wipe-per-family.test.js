// A Wipe and a New graph per anchor family (annotation engine 1A.7; DECISIONS
// C2 and F7; readiness R3 today-bug 2).
//
// C1: a comment pin is a page anchor, and its item is the pane or markdown item
// its `anchor.mount` names (panes and markdown share one id space). C2: a Wipe
// keeps the live copy of every pin whose item survives (a pinned pane, and the
// markdown kept directly above one) and drops the live copy of the rest; a New
// graph drops every live copy; committed copies always stay; a delete drops the
// live copy and never writes a tombstone. F7: a pin with no anchor (a page-level
// note) has no item to survive, so a Wipe drops its live copy.
//
// The fixture is G-11's five pins (design tests/F6/wipe-v2.js), built through the
// HTTP routes on a real daemon: a pin on a pinned pane, on a pane the wipe
// removes, with no anchor, on the markdown heading directly above the pinned
// pane, and on a markdown item the wipe removes.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { withServer, waitUntil } = require('../test-support/helpers');

// pane_state is only settable over the WS (the browser owns pane chrome).
async function pinPane(ctx, id) {
  const sock = ctx.ws();
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  sock.send(JSON.stringify({ type: 'pane:state', id, pane_state: { pinned: true } }));
  try {
    await waitUntil(async () => {
      const m = (await ctx.api.get('/api/mounts')).json.mounts.find((x) => x.id === id);
      return !!(m && m.pane_state && m.pane_state.pinned);
    }, { timeout: 5000, what: `pane ${id} pinned` });
  } finally { sock.close(); }
}

const comments = async (api) => (await api.get('/api/comments')).json.comments;
const events = async (api) => (await api.get('/api/events')).json.events;
const queueItems = async (api) => (await api.get('/api/queue')).json.items;
const liveIds = async (api) => (await comments(api)).map((c) => c.id).sort();

async function ok(p, what) {
  const r = await p;
  assert.equal(r.status, 200, `${what}: ${r.status} ${r.text}`);
  assert.notEqual(r.json && r.json.ok, false, `${what}: ${r.text}`);
  return r.json;
}

async function addPin(api, text, anchor) {
  const r = await ok(api.post('/api/comments', { text, shared: true, anchor }), `pin ${text}`);
  return r.pin;
}

// The page in reading order: md-loose, f6-gone, md-above, f6-kept (pinned). A
// wipe keeps f6-kept and md-above (the markdown run directly above it) and takes
// md-loose and f6-gone.
async function fixture(ctx) {
  const { api } = ctx;
  await ok(api.post('/api/markdown', { id: 'md-loose', text: '## Loose section\n\nSome prose.' }), 'md-loose');
  await ok(api.post('/api/render', { id: 'f6-gone', html: '<p id="g">Gone</p>' }), 'f6-gone');
  await ok(api.post('/api/markdown', { id: 'md-above', text: '## Pinned section' }), 'md-above');
  await ok(api.post('/api/render', { id: 'f6-kept', html: '<p id="k">Kept</p>' }), 'f6-kept');
  await pinPane(ctx, 'f6-kept');
  return {
    pinned_pane: await addPin(api, 'pinned_pane', { mount: 'f6-kept', selector: '#k', text: 'Kept', ordinal: 0 }),
    removed_pane: await addPin(api, 'removed_pane', { mount: 'f6-gone', selector: '#g', text: 'Gone', ordinal: 0 }),
    no_anchor: await addPin(api, 'no_anchor', null),
    markdown_above_pinned: await addPin(api, 'markdown_above_pinned', { mount: 'md-above', selector: 'h2', text: 'Pinned section', ordinal: 0 }),
    markdown_removed: await addPin(api, 'markdown_removed', { mount: 'md-loose', selector: 'p', text: 'Some prose.', ordinal: 0 }),
  };
}

async function turn(api, summary = 't') {
  await ok(api.post('/api/turn-begin', { message: summary }), 'turn-begin');
  const e = await ok(api.post('/api/turn-end', { author: 'claude', summary }), 'turn-end');
  assert.ok(e.node_id, `a node was committed: ${JSON.stringify(e)}`);
  return e.node_id;
}

// sha256 of every committed node file, by name.
function nodeDigests(webChatDir) {
  const dir = path.join(webChatDir, 'graph');
  const out = {};
  for (const f of fs.readdirSync(dir).filter((x) => /^n\d+\.json$/.test(x)).sort()) {
    out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
  }
  return out;
}

// Every file under .web-chat/, relative, for "the op wrote no new record".
function filesUnder(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...filesUnder(dir, r));
    else out.push(r);
  }
  return out.sort();
}

const KEPT = ['pinned_pane', 'markdown_above_pinned'];
const DROPPED = ['removed_pane', 'no_anchor', 'markdown_removed'];

test('a wipe keeps exactly the pins whose item survives; one delete event per dropped pin; committed copies untouched', async (t) => {
  const ctx = await withServer(t);
  const { api, webChatDir } = ctx;
  const pins = await fixture(ctx);
  const A = await turn(api, 'A');
  const digests = nodeDigests(webChatDir);
  assert.ok(Object.keys(digests).length >= 1, 'a committed node file is on disk');
  const filesBefore = filesUnder(webChatDir);

  const before = (await events(api)).length;
  const w = await ok(api.post('/api/graph/wipe', {}), 'wipe');
  assert.deepEqual(w.kept, ['f6-kept']);

  const mounts = (await api.get('/api/mounts')).json;
  assert.deepEqual(mounts.mounts.map((m) => m.id), ['f6-kept'], 'only the pinned pane is left');
  assert.deepEqual(await liveIds(api), KEPT.map((k) => pins[k].id).sort(),
    'exactly the pinned-pane pin and the kept-heading pin are live');

  const deletes = (await events(api)).slice(before).filter((e) => e.kind === 'comment' && e.op === 'delete');
  assert.deepEqual(deletes.map((e) => e.id).sort(), DROPPED.map((k) => pins[k].id).sort(),
    'one comment delete event per dropped pin');

  assert.deepEqual(nodeDigests(webChatDir), digests, 'no committed node file changed');
  const added = filesUnder(webChatDir).filter((f) => !filesBefore.includes(f));
  assert.deepEqual(added, [], 'the wipe wrote no new record (no tombstone, no log)');

  // The committed node still holds every pin.
  const nodeA = (await api.get(`/api/graph/node/${encodeURIComponent(A)}`)).json;
  assert.deepEqual(nodeA.comments.map((c) => c.id).sort(), Object.values(pins).map((p) => p.id).sort());

  // The kept-heading pin rides the next commit.
  const W = await turn(api, 'W');
  const nodeW = (await api.get(`/api/graph/node/${encodeURIComponent(W)}`)).json;
  assert.deepEqual(nodeW.comments.map((c) => c.id).sort(), KEPT.map((k) => pins[k].id).sort(),
    'the next commit carries the pinned-pane pin and the kept-heading pin');
  for (const [f, d] of Object.entries(digests)) assert.equal(nodeDigests(webChatDir)[f], d, `${f} unchanged by the next commit`);
});

test('a wipe dequeues every queued shared pin it drops and keeps the queued items of the pins it keeps', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  const pins = await fixture(ctx);
  const queued = await queueItems(api);
  for (const k of Object.keys(pins)) {
    assert.ok(queued.some((it) => it.comment_id === pins[k].id), `${k}'s shared pin is queued`);
  }
  await ok(api.post('/api/graph/wipe', {}), 'wipe');
  const after = await queueItems(api);
  for (const k of DROPPED) assert.equal(after.some((it) => it.comment_id === pins[k].id), false, `${k} was dequeued`);
  for (const k of KEPT) assert.ok(after.some((it) => it.comment_id === pins[k].id), `${k} stays queued`);
});

test('a wipe drops a pin whose anchor names an id that is neither a pane nor a markdown item on the page', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await ok(api.post('/api/render', { id: 'keep', html: '<div>keep</div>' }), 'keep');
  await pinPane(ctx, 'keep');
  const onKeep = await addPin(api, 'k', { mount: 'keep', selector: 'div', text: 'keep', ordinal: 0 });
  const ghost = await addPin(api, 'ghost', { mount: 'never-on-the-page', selector: 'div', text: 'x', ordinal: 0 });
  // An anchor with no mount: the add route refuses one since U208 (the element
  // log cannot convert it), but a pin a 0.8.5 daemon took can still come back
  // live from a node copy, so it is put live by hand here.
  assert.equal((await api.post('/api/comments', { text: 'empty', shared: true, anchor: { selector: 'div', text: 'x' } })).status, 400);
  const empty = { id: 'c900', seq: 900, created_at: Date.now(), shared: true, text: 'empty', anchor: { selector: 'div', text: 'x' } };
  ctx.srv.state.comments = ctx.srv.state.comments.concat([empty]);
  const before = (await events(api)).length;
  await ok(api.post('/api/graph/wipe', {}), 'wipe');
  assert.deepEqual(await liveIds(api), [onKeep.id]);
  const deletes = (await events(api)).slice(before).filter((e) => e.kind === 'comment' && e.op === 'delete');
  assert.deepEqual(deletes.map((e) => e.id).sort(), [ghost.id, empty.id].sort());
});

test('a wipe queued behind a locked turn applies the per-family rule when it runs after turn-end', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  const pins = await fixture(ctx);

  await ok(api.post('/api/turn-begin', {}), 'turn-begin');
  const q = await ok(api.post('/api/graph/wipe', {}), 'queued wipe');
  assert.equal(q.pending, true, `the wipe queued behind the lock: ${JSON.stringify(q)}`);
  assert.equal((await comments(api)).length, 5, 'nothing is dropped until the turn ends');

  const end = await ok(api.post('/api/turn-end', { author: 'claude', summary: 't' }), 'turn-end');
  assert.ok(end.node_id, 'the turn committed before the queued wipe ran');
  await waitUntil(async () => (await comments(api)).length === KEPT.length, { timeout: 5000, what: 'the queued wipe ran' });
  assert.deepEqual(await liveIds(api), KEPT.map((k) => pins[k].id).sort());
  const node = (await api.get(`/api/graph/node/${encodeURIComponent(end.node_id)}`)).json;
  assert.deepEqual(node.comments.map((c) => c.id).sort(), Object.values(pins).map((p) => p.id).sort(),
    'the node committed before the wipe keeps every pin');
});

test('a new graph is unchanged: every live pin dropped, committed copies byte-identical, the seq counter continues', async (t) => {
  const ctx = await withServer(t);
  const { api, webChatDir } = ctx;
  const pins = await fixture(ctx);
  await turn(api, 'A');
  const digests = nodeDigests(webChatDir);
  const filesBefore = filesUnder(webChatDir);

  const before = (await events(api)).length;
  await ok(api.post('/api/graph/new', { name: 'fresh' }), 'new graph');
  assert.deepEqual(await comments(api), [], 'every live pin is gone');
  const deletes = (await events(api)).slice(before).filter((e) => e.kind === 'comment' && e.op === 'delete');
  assert.deepEqual(deletes.map((e) => e.id).sort(), Object.values(pins).map((p) => p.id).sort());
  assert.equal((await queueItems(api)).some((it) => it.comment_id), false, 'no pin is left queued');
  assert.deepEqual(nodeDigests(webChatDir), digests, 'no committed node file changed');
  assert.deepEqual(filesUnder(webChatDir).filter((f) => !filesBefore.includes(f)), [], 'no new record');

  const maxSeq = Math.max(...Object.values(pins).map((p) => p.seq));
  const next = await addPin(api, 'next', { mount: 'x', selector: 'div', text: 'x', ordinal: 0 });
  assert.equal(next.seq, maxSeq + 1, 'the comment counter was not reset');
});
