// The engine's undo (annotation engine 4A.3, U518; DECISIONS N.1 AD6, AF9
// UNDO@scope, AF10 WRITER@undo-selection, AI13): POST /api/elements/undo over
// lib/server/domain/element-undo undoOnItem — one undo over the element log for
// every page type: a create undone by the Delete path (nothing appended, C2),
// an edit by an appended revert version with parent_v, a comment through its
// own 0.8.5 copy; chat elements and committed versions out; the version undone
// always the caller's own (the writer stamp attributes), another writer's
// newer one named in the hint and never a refusal keyed on writer.
//
// Who is who (test/element-routes-private.test.js's terms): `anonApi` is a
// local browser (Node's fetch sends fetch metadata) — the writer 'user'; the
// same with X-WC-Pane: <mount> is that pane's stamp; `api` carries Claude's
// writer token; a remote viewer is a loopback request carrying X-WC-Remote: 1
// at the project's opt-in in the sandbox's tunnel.json.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer, tmpRoot, waitUntil } = require('../test-support/helpers');
const { v3Graph } = require('../test-support/v3-graph');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths, projectPaths } = require('../lib/core/paths');
const { SCHEMAS } = require('../lib/core/element-log');
const { PANE_HEADER } = require('../lib/core/writer-token');

const CHAT = Object.keys(SCHEMAS).find((s) => SCHEMAS[s].type === 'chat-comment');
const RANGE = (mount, exact = 'Hello') => ({ v: 1, kind: 'range', mount, quote: { exact, prefix: '', suffix: '' }, pos: { start: 0, end: exact.length } });
const LOCATOR = (mount = 'm1') => ({ mount, selector: 'p.lead', text: 'Hello', ordinal: 0 });
const UNDO = '/api/elements/undo';
const PANE = (id) => ({ [PANE_HEADER]: id });
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });

const logBytes = (root) => { try { return fs.readFileSync(projectPaths(root).elementsLog, 'utf8'); } catch { return ''; } };

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
const render = (api, id) => ok(api.post('/api/render', { id, html: '<p class="lead">Hello world</p>' }), `render ${id}`);
async function turn(api, message = 't') {
  await ok(api.post('/api/turn-begin', { message }), 'turn-begin');
  return ok(api.post('/api/turn-end', { author: 'claude' }), 'turn-end');
}
const highlight = async (who, mount, headers, extra = {}) => (await ok(who.post('/api/elements', {
  type: 'highlight', anchor: RANGE(mount), payload: { color: 'gold', note: 'a note', ...extra },
}, headers), 'POST highlight')).element;
const comment = async (who, text = 'first words', mount = 'm1') => (await ok(who.post('/api/elements', {
  type: 'comment', anchor: LOCATOR(mount), payload: { text, shared: true },
}), 'POST comment')).element;

async function frames(t, d) {
  const got = [];
  const sock = d.ws();
  sock.on('message', (data) => { try { got.push(JSON.parse(data.toString())); } catch {} });
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  t.after(() => { try { sock.close(); } catch {} });
  await waitUntil(() => got.some((f) => f.type === 'hello'), { timeout: 5000, what: 'hello' });
  return got;
}
const newFrames = (seen, from, type) => seen.slice(from).filter((f) => f.type === type);

async function boot(t) {
  const d = await withServer(t);
  await render(d.api, 'm1');
  await render(d.api, 'm2');
  return d;
}

// ── a page element: the create and the edit ────────────────────────────────

test('a highlight created then undone: its reference dropped, nothing appended to the log, its element frame sent', async (t) => {
  const d = await boot(t);
  const seen = await frames(t, d);
  const h = await highlight(d.anonApi, 'm1');
  assert.deepEqual(h.writer, { class: 'user', owner: 'user', verified: false });
  assert.deepEqual(d.srv.state.elements, [`${h.id}@1`]);
  const bytes = logBytes(d.root);
  const at = seen.length;

  const r = await ok(d.anonApi.post(UNDO, { item: 'm1', device: 'desktop' }), 'undo');
  assert.deepEqual(r.undone, { id: h.id, type: 'highlight', v: 1, item: 'm1', how: 'removed' });
  assert.equal(r.newer, undefined);
  assert.deepEqual(d.srv.state.elements, [], 'the reference dropped');
  assert.equal(logBytes(d.root), bytes, 'nothing appended (C2)');
  const f = await waitUntil(() => newFrames(seen, at, 'element:highlight')[0], { timeout: 5000, what: 'element:highlight frame' });
  assert.deepEqual(f.elements, [], 'the frame carries the type\'s live records');
  const ev = (await ok(d.api.get('/api/events?since=0'))).events.filter((e) => e.kind === 'element');
  assert.equal(ev[ev.length - 1].op, 'delete');

  // A second undo finds nothing of the user's: 409, and still nothing written.
  const again = await d.anonApi.post(UNDO, { item: 'm1' });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.error, 'nothing to undo');
  assert.match(again.json.hint, /version history/);
  assert.equal(logBytes(d.root), bytes);
});

test('a highlight edited (colour) to v2 then undone: v3 holds v1\'s payload, parent_v 2, the live reference at v3, an edit frame and event', async (t) => {
  const d = await boot(t);
  const seen = await frames(t, d);
  const h = await highlight(d.anonApi, 'm1');
  await ok(d.anonApi.patch(`/api/elements/${h.id}`, { payload: { color: 'blue' } }), 'PATCH colour');
  assert.deepEqual(d.srv.state.elements, [`${h.id}@2`]);
  const at = seen.length;

  const r = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo');
  assert.deepEqual(r.undone, { id: h.id, type: 'highlight', v: 2, item: 'm1', how: 'reverted', to_v: 1, now_v: 3 });
  const v1 = d.srv.elements.version(h.id, 1);
  const v3 = d.srv.elements.version(h.id, 3);
  assert.deepEqual(v3.payload, v1.payload, 'v3 holds v1\'s payload');
  assert.equal(v3.payload.color, 'gold');
  assert.equal(v3.parent_v, 2);
  assert.equal(v3.schema, v1.schema, 'under the version\'s own schema');
  assert.deepEqual(v3.writer, { class: 'user', owner: 'user', verified: false }, 'the caller\'s writer');
  assert.deepEqual(d.srv.state.elements, [`${h.id}@3`]);
  const f = await waitUntil(() => newFrames(seen, at, 'element:highlight')[0], { timeout: 5000, what: 'element:highlight frame' });
  assert.deepEqual(f.elements.map((e) => [e.id, e.v, e.color]), [[h.id, 3, 'gold']]);
  const ev = (await ok(d.api.get('/api/events?since=0'))).events.filter((e) => e.kind === 'element');
  const last = ev[ev.length - 1];
  assert.deepEqual([last.op, last.id, last.v, last.was_shared, last.mount], ['edit', h.id, 3, true, 'm1'], 'announced as the PATCH\'s edit');
});

// ── a comment: its 0.8.5 copy ───────────────────────────────────────────────

test('a comment created then undone: deleted through deleteComment (state.comments without it, the comment frame sent)', async (t) => {
  const d = await boot(t);
  const seen = await frames(t, d);
  const c = await comment(d.anonApi);
  assert.ok(d.srv.state.comments.some((p) => p.id === c.id));
  const bytes = logBytes(d.root);
  const at = seen.length;
  const r = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo');
  assert.deepEqual(r.undone, { id: c.id, type: 'comment', v: 1, item: 'm1', how: 'removed' });
  assert.ok(!d.srv.state.comments.some((p) => p.id === c.id), 'the pin is gone');
  assert.equal(logBytes(d.root), bytes, 'nothing appended (C2)');
  const f = await waitUntil(() => newFrames(seen, at, 'element:comment')[0], { timeout: 5000, what: 'element:comment frame' });
  assert.ok(!f.elements.some((p) => p.id === c.id));
  const ev = (await ok(d.api.get('/api/events?since=0'))).events.filter((e) => e.kind === 'comment');
  assert.deepEqual([ev[ev.length - 1].op, ev[ev.length - 1].id], ['delete', c.id]);
});

test('a comment\'s text edited then undone: a version with the old text and parent_v, the pin\'s copy updated, an edit event', async (t) => {
  const d = await boot(t);
  const seen = await frames(t, d);
  const c = await comment(d.anonApi, 'first words');
  await ok(d.anonApi.patch(`/api/elements/${c.id}`, { text: 'second words' }), 'PATCH text');
  const at = seen.length;
  const r = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo');
  assert.deepEqual(r.undone, { id: c.id, type: 'comment', v: 2, item: 'm1', how: 'reverted', to_v: 1, now_v: 3 });
  const v3 = d.srv.elements.version(c.id, 3);
  assert.equal(v3.payload.text, 'first words');
  assert.equal(v3.parent_v, 2);
  assert.equal(v3.schema, d.srv.elements.version(c.id, 1).schema);
  const pin = d.srv.state.comments.find((p) => p.id === c.id);
  assert.equal(pin.v, 3);
  assert.equal(pin.text, 'first words');
  assert.deepEqual(pin.anchor, LOCATOR('m1'), 'the anchor reads as v1\'s');
  const f = await waitUntil(() => newFrames(seen, at, 'element:comment')[0], { timeout: 5000, what: 'element:comment frame' });
  assert.equal(f.elements.find((p) => p.id === c.id).text, 'first words');
  const ev = (await ok(d.api.get('/api/events?since=0'))).events.filter((e) => e.kind === 'comment');
  const last = ev[ev.length - 1];
  assert.deepEqual([last.op, last.pin.id, last.pin.v, last.became_shared, last.became_private], ['edit', c.id, 3, false, false]);
});

test('a comment\'s sharing toggle undone: became_shared / became_private as the PATCH computes them', async (t) => {
  const d = await boot(t);
  const lastComment = async () => {
    const ev = (await ok(d.api.get('/api/events?since=0'))).events.filter((e) => e.kind === 'comment');
    return ev[ev.length - 1];
  };
  // Shared, made private, undone: shared again (became_shared).
  const a = await comment(d.anonApi, 'shared words', 'm1');
  await ok(d.anonApi.patch(`/api/elements/${a.id}`, { shared: false }), 'PATCH private');
  const r1 = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo the toggle');
  assert.deepEqual([r1.undone.id, r1.undone.how], [a.id, 'reverted']);
  assert.equal(d.srv.state.comments.find((p) => p.id === a.id).shared, true);
  const e1 = await lastComment();
  assert.deepEqual([e1.op, e1.pin.id, e1.became_shared, e1.became_private], ['edit', a.id, true, false]);
  // Private, made shared, undone: private again (became_private).
  const b = (await ok(d.anonApi.post('/api/elements', { type: 'comment', anchor: LOCATOR('m2'), payload: { text: 'private words', shared: false } }), 'POST private comment')).element;
  await ok(d.anonApi.patch(`/api/elements/${b.id}`, { shared: true }), 'PATCH shared');
  const r2 = await ok(d.anonApi.post(UNDO, { item: 'm2' }), 'undo the share');
  assert.deepEqual([r2.undone.id, r2.undone.how], [b.id, 'reverted']);
  assert.equal(d.srv.state.comments.find((p) => p.id === b.id).shared, false);
  const e2 = await lastComment();
  assert.deepEqual([e2.op, e2.pin.id, e2.became_shared, e2.became_private], ['edit', b.id, false, true]);
});

test('a comment\'s reply undone: the reply gone from the new version', async (t) => {
  const d = await boot(t);
  const c = await comment(d.anonApi, 'a thread');
  await ok(d.anonApi.post(`/api/elements/${c.id}/reply`, { text: 'a reply', author: 'user' }), 'reply');
  assert.equal(d.srv.state.comments.find((p) => p.id === c.id).replies.length, 1);
  const r = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo');
  assert.equal(r.undone.how, 'reverted');
  const pin = d.srv.state.comments.find((p) => p.id === c.id);
  assert.equal(pin.v, 3);
  assert.equal(pin.replies, undefined, 'no replies on the new version');
  assert.deepEqual(d.srv.elements.version(c.id, 3).payload.replies, []);
  assert.equal(d.srv.elements.version(c.id, 3).parent_v, 2);
});

// ── AF10: attribution picks the version ────────────────────────────────────

test('AF10: a pane\'s newer highlight on the same item — the user\'s own newest is undone, the pane\'s named in newer and the hint and left as it is', async (t) => {
  const d = await boot(t);
  const mine = await highlight(d.anonApi, 'm1');
  const theirs = await highlight(d.anonApi, 'm1', PANE('m1'));
  assert.deepEqual(theirs.writer, { class: 'pane', owner: 'pane:m1', verified: false });
  const r = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo');
  assert.equal(r.undone.id, mine.id);
  assert.deepEqual(r.newer, [{ id: theirs.id, type: 'highlight', writer_class: 'pane' }]);
  assert.match(r.hint, /a newer annotation on this pane is highlight by pane; it was left as it is/);
  assert.deepEqual(d.srv.state.elements, [`${theirs.id}@1`], 'the pane\'s is left');

  // Nothing of the user's is live there now: 409 naming the pane's version.
  const none = await d.anonApi.post(UNDO, { item: 'm1' });
  assert.equal(none.status, 409, none.text);
  assert.equal(none.json.error, 'nothing to undo');
  assert.deepEqual(none.json.newer, [{ id: theirs.id, type: 'highlight', writer_class: 'pane' }]);
  assert.match(none.json.hint, /highlight by pane/);
  assert.match(none.json.hint, /version history/);
  assert.deepEqual(d.srv.state.elements, [`${theirs.id}@1`]);

  // The pane's own undo takes its own.
  const own = await ok(d.anonApi.post(UNDO, { item: 'm1' }, PANE('m1')), 'pane undo');
  assert.equal(own.undone.id, theirs.id);
  assert.deepEqual(d.srv.state.elements, []);
});

test('AF10: another writer\'s v2 supersedes the user\'s v1 on one element — nothing of the user\'s is live: 409 with the hint, nothing changed', async (t) => {
  const d = await boot(t);
  const h = await highlight(d.anonApi, 'm1');
  await ok(d.api.patch(`/api/elements/${h.id}`, { payload: { color: 'blue' } }), 'Claude\'s PATCH');
  assert.equal(d.srv.elements.version(h.id, 2).writer.owner, 'claude');
  const bytes = logBytes(d.root);
  const r = await d.anonApi.post(UNDO, { item: 'm1' });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(r.json.newer, [{ id: h.id, type: 'highlight', writer_class: 'claude' }]);
  assert.match(r.json.hint, /highlight by claude/);
  assert.equal(logBytes(d.root), bytes);
  assert.deepEqual(d.srv.state.elements, [`${h.id}@2`]);
});

// ── the scope: the node commit, chat, the page ─────────────────────────────

test('UNDO@scope: after a node commit the committed version is not undone (409; the node file unchanged)', async (t) => {
  const d = await boot(t);
  const h = await highlight(d.anonApi, 'm1');
  const done = await turn(d.api, 'commit the highlight');
  const nodeId = done.node_id || done.node || (await ok(d.api.get('/api/graph'))).active;
  assert.ok(d.srv.elements.homeOf(h.id, 1), 'v1 is committed');
  const nodeFile = path.join(projectPaths(d.root).graphDir, `${nodeId}.json`);
  const before = fs.readFileSync(nodeFile, 'utf8');
  const bytes = logBytes(d.root);
  const r = await d.anonApi.post(UNDO, { item: 'm1' });
  assert.equal(r.status, 409, r.text);
  assert.match(r.json.hint, /since the last commit/);
  assert.equal(fs.readFileSync(nodeFile, 'utf8'), before, 'the node file unchanged');
  assert.equal(logBytes(d.root), bytes);
  assert.deepEqual(d.srv.state.elements, [`${h.id}@1`]);

  // An edit after the commit is live: undone back to the committed payload.
  await ok(d.anonApi.patch(`/api/elements/${h.id}`, { payload: { color: 'blue' } }), 'PATCH');
  const r2 = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo the edit');
  assert.deepEqual([r2.undone.v, r2.undone.how, r2.undone.to_v], [2, 'reverted', 1]);
  assert.equal(fs.readFileSync(nodeFile, 'utf8'), before);
});

test('UNDO@scope: a chat-comment is never a candidate, even the newest; no item undoes the page-wide newest of the caller\'s and names its item', async (t) => {
  const d = await boot(t);
  const a = await highlight(d.anonApi, 'm1');
  const b = await highlight(d.anonApi, 'm2');
  const USER = { class: 'user', owner: 'user', verified: false };
  const anchor = { v: 1, conversation_id: 'conv-u518', session_id: 'sess-u518', turn_id: 't_1', kind: 'turn',
    quote: { exact: 'Explain', prefix: '', suffix: '' }, fp: { h: '0123456789abcdef', len: 7 }, marks: 0, label: 'turn 1' };
  const chat = d.srv.elements.addElement({ type: 'chat-comment', schema: CHAT,
    payload: { text: 'a chat pin', shared: true, replies: [], anchor, chain: [] }, author: 'user', writer: USER });
  assert.ok(chat.seq > b.seq, 'the chat pin is the newest of the user\'s');

  const r = await ok(d.anonApi.post(UNDO, {}), 'page-wide undo');
  assert.deepEqual([r.undone.id, r.undone.item], [b.id, 'm2'], 'the page-wide newest, its item named');
  assert.ok(!d.srv.elements.dropped(chat.id), 'the chat pin untouched');
  const r2 = await ok(d.anonApi.post(UNDO, {}), 'again');
  assert.deepEqual([r2.undone.id, r2.undone.item], [a.id, 'm1']);
  const none = await d.anonApi.post(UNDO, {});
  assert.equal(none.status, 409, none.text);
  assert.match(none.json.hint, /on this page/);
  assert.ok(!d.srv.elements.dropped(chat.id));
  assert.equal(d.srv.elements.latest(chat.id).v, 1);
});

test('bad requests: a malformed item 400; the store read-only 503 with the element routes\' hint', async (t) => {
  const d = await boot(t);
  for (const item of [5, '', 'x'.repeat(300), { id: 'm1' }]) {
    const r = await d.anonApi.post(UNDO, { item });
    assert.equal(r.status, 400, `${JSON.stringify(item)}: ${r.text}`);
  }
  const ro = await withServer(t, { seed: ({ root }) => { v3Graph(root, { unmappable: true }); } });
  assert.equal(ro.srv.elements.readOnly, true);
  const r = await ro.anonApi.post(UNDO, {});
  assert.equal(r.status, 503, r.text);
  assert.match(r.json.hint, /claude-web-chat migrate/);
});

// ── remote ──────────────────────────────────────────────────────────────────

test('remote: a full viewer\'s undo retracts only versions stamped remote; a read viewer is refused 403', async (t) => {
  const roots = { read: tmpRoot('wc-undo-read-'), full: tmpRoot('wc-undo-full-') };
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, {
    hostname: 'wc.example.test', style: 'flat',
    access: { team: 'testteam', aud: 'test-aud-0123456789' }, allow: { emails: ['me@example.com'], domains: [] },
    remote: { mirror: { [path.resolve(roots.read)]: 'read', [path.resolve(roots.full)]: 'full' } },
  });
  const full = await withServer(t, { root: roots.full, seed });
  await render(full.api, 'm1');
  const theirs = await highlight(full.anonApi, 'm1', REMOTE);
  assert.deepEqual(theirs.writer, { class: 'remote', owner: 'remote', verified: false });
  const mine = await highlight(full.anonApi, 'm1');
  const r = await ok(full.anonApi.post(UNDO, { item: 'm1' }, REMOTE), 'remote undo');
  assert.equal(r.undone.id, theirs.id, 'the remote\'s own, not the newer local one');
  assert.deepEqual(r.newer, [{ id: mine.id, type: 'highlight', writer_class: 'user' }]);
  assert.deepEqual(full.srv.state.elements, [`${mine.id}@1`]);
  const none = await full.anonApi.post(UNDO, { item: 'm1' }, REMOTE);
  assert.equal(none.status, 409, none.text);

  const read = await withServer(t, { root: roots.read });
  await render(read.api, 'm1');
  const h = await highlight(read.anonApi, 'm1');
  const refused = await read.anonApi.post(UNDO, { item: 'm1' }, REMOTE);
  assert.equal(refused.status, 403, refused.text);
  assert.deepEqual(read.srv.state.elements, [`${h.id}@1`]);
});

test('remote: a private element is neither undone nor named for a viewer that does not see private records', async (t) => {
  const root = tmpRoot('wc-undo-priv-');
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, {
    hostname: 'wc.example.test', style: 'flat',
    access: { team: 'testteam', aud: 'test-aud-0123456789' }, allow: { emails: ['me@example.com'], domains: [] },
    remote: { mirror: { [path.resolve(root)]: 'full' } },
  });
  const d = await withServer(t, { root, seed });
  await render(d.api, 'm1');
  const PRIVATE = 'wc-u518-private-note';
  const priv = await highlight(d.anonApi, 'm1', undefined, { note: PRIVATE, shared: false });
  const r = await d.anonApi.post(UNDO, { item: 'm1' }, REMOTE);
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.newer, undefined, 'the private element is not named');
  assert.ok(!r.text.includes(priv.id) && !r.text.includes(PRIVATE));
  assert.deepEqual(d.srv.state.elements, [`${priv.id}@1`]);
});
