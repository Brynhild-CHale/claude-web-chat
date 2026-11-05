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

// ── repeated undo steps back (U518b; form 5 AR1 = b, DECISIONS N.5) ─────────
// A version the undo wrote retracts its parent: the next undo reads it as
// restoring the version it names (its provenance's `undo`) and retracts the
// caller's next older action — on the same element first (down to its create,
// which the Delete path removes), then the next element — never the revert
// the previous undo wrote.

test('U518b: repeated undo on one element keeps stepping back — v3 (v1\'s payload), then the create removed, never v2\'s payload again', async (t) => {
  const d = await boot(t);
  const h = await highlight(d.anonApi, 'm1');
  await ok(d.anonApi.patch(`/api/elements/${h.id}`, { payload: { color: 'blue' } }), 'PATCH blue');
  const r1 = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo 1');
  assert.deepEqual(r1.undone, { id: h.id, type: 'highlight', v: 2, item: 'm1', how: 'reverted', to_v: 1, now_v: 3 });
  const bytes = logBytes(d.root);
  const r2 = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo 2');
  assert.deepEqual(r2.undone, { id: h.id, type: 'highlight', v: 1, item: 'm1', how: 'removed' },
    'the second undo retracts the create, not the revert the first one wrote');
  assert.equal(d.srv.elements.version(h.id, 4), null, 'no v4: never toggled back to v2\'s payload');
  assert.equal(logBytes(d.root), bytes, 'nothing appended (C2)');
  assert.deepEqual(d.srv.state.elements, []);
  assert.equal(d.srv.elements.version(h.id, 3).provenance.undo, 1, 'the revert is marked with the version it restores');
  const none = await d.anonApi.post(UNDO, { item: 'm1' });
  assert.equal(none.status, 409, none.text);

  // Three versions: each undo restores the one before the last it retracted.
  const g = await highlight(d.anonApi, 'm1');
  await ok(d.anonApi.patch(`/api/elements/${g.id}`, { payload: { color: 'blue' } }), 'PATCH blue');
  await ok(d.anonApi.patch(`/api/elements/${g.id}`, { payload: { color: 'green' } }), 'PATCH green');
  const s1 = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo green');
  assert.deepEqual([s1.undone.v, s1.undone.to_v, s1.undone.now_v], [3, 2, 4]);
  assert.equal(d.srv.elements.version(g.id, 4).payload.color, 'blue');
  const s2 = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo blue');
  assert.deepEqual([s2.undone.v, s2.undone.how, s2.undone.to_v, s2.undone.now_v], [2, 'reverted', 1, 5]);
  const v5 = d.srv.elements.version(g.id, 5);
  assert.equal(v5.payload.color, 'gold', 'v5 holds v1\'s payload (the pre-edit state), not green');
  assert.deepEqual([v5.parent_v, v5.provenance.undo], [4, 1]);
  assert.deepEqual(d.srv.state.elements, [`${g.id}@5`]);
  const s3 = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo the create');
  assert.deepEqual([s3.undone.id, s3.undone.v, s3.undone.how], [g.id, 1, 'removed']);
  assert.deepEqual(d.srv.state.elements, []);
});

test('U518b: a comment edited then undone twice: its text back, then the comment deleted — never the edited text again', async (t) => {
  const d = await boot(t);
  const c = await comment(d.anonApi, 'first words');
  await ok(d.anonApi.patch(`/api/elements/${c.id}`, { text: 'second words' }), 'PATCH text');
  const r1 = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo 1');
  assert.deepEqual([r1.undone.v, r1.undone.how, r1.undone.now_v], [2, 'reverted', 3]);
  assert.equal(d.srv.state.comments.find((p) => p.id === c.id).text, 'first words');
  const r2 = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo 2');
  assert.deepEqual(r2.undone, { id: c.id, type: 'comment', v: 1, item: 'm1', how: 'removed' });
  assert.ok(!d.srv.state.comments.some((p) => p.id === c.id), 'the pin is gone');
});

test('U518b: a glyph moved twice, then a move back to its first offset, undone four times — each move retracted in turn, then the comment deleted (the mark, not the content, tells a revert)', async (t) => {
  const d = await boot(t);
  const glyph = (id) => `/api/elements/${encodeURIComponent(id)}/glyph`;
  const shown = (id) => { const p = d.srv.state.comments.find((x) => x.id === id); return p ? (p.display ? p.display.glyph : null) : undefined; };
  const c = await comment(d.anonApi);
  const A = { dx: 10, dy: 20, corner: 'tl' };
  const B = { dx: -30, dy: 5, corner: 'br' };
  await ok(d.anonApi.post(glyph(c.id), A), 'move to A');
  await ok(d.anonApi.post(glyph(c.id), B), 'move to B');
  // A move back to A: the same payload and display as v2 — content alone would
  // read it as a revert of v3; it carries no mark, so it is an action.
  await ok(d.anonApi.post(glyph(c.id), A), 'move back to A');
  assert.deepEqual(shown(c.id), A);
  const seen = [];
  for (let k = 0; k < 3; k++) {
    const r = await ok(d.anonApi.post(UNDO, { item: 'm1' }), `undo ${k + 1}`);
    seen.push([r.undone.v, r.undone.how, shown(c.id)]);
  }
  assert.deepEqual(seen, [[4, 'reverted', B], [3, 'reverted', A], [2, 'reverted', null]]);
  const last = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo the create');
  assert.deepEqual([last.undone.v, last.undone.how], [1, 'removed']);
  assert.equal(shown(c.id), undefined);
});

test('U518b: across two elements the undo walks the caller\'s actions newest first — B\'s edit, A\'s edit, B\'s create, A\'s create — never B\'s revert', async (t) => {
  const d = await boot(t);
  const a = await highlight(d.anonApi, 'm1');
  const b = await highlight(d.anonApi, 'm2');
  await ok(d.anonApi.patch(`/api/elements/${a.id}`, { payload: { color: 'blue' } }), 'PATCH A');
  await ok(d.anonApi.patch(`/api/elements/${b.id}`, { payload: { color: 'blue' } }), 'PATCH B');
  const steps = [];
  for (let k = 0; k < 4; k++) {
    const r = await ok(d.anonApi.post(UNDO, {}), `page-wide undo ${k + 1}`);
    steps.push([r.undone.id, r.undone.v, r.undone.how]);
  }
  assert.deepEqual(steps, [
    [b.id, 2, 'reverted'],
    [a.id, 2, 'reverted'],
    [b.id, 1, 'removed'],
    [a.id, 1, 'removed'],
  ]);
  assert.equal(d.srv.elements.version(b.id, 4), null, 'B\'s revert never retracted');
  assert.equal(d.srv.elements.version(a.id, 4), null);
  assert.deepEqual(d.srv.state.elements, []);
  const none = await d.anonApi.post(UNDO, {});
  assert.equal(none.status, 409, none.text);
});

test('U518b, AF10: a revert the caller wrote over another writer\'s version exposes that writer\'s action — the next undo is not the caller\'s (409 naming it), and the other writer\'s own undo takes it', async (t) => {
  const d = await boot(t);
  const h = await highlight(d.api, 'm1');
  assert.equal(h.writer.owner, 'claude');
  await ok(d.anonApi.patch(`/api/elements/${h.id}`, { payload: { color: 'blue' } }), 'the user\'s PATCH');
  const r1 = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'the user\'s undo');
  assert.deepEqual([r1.undone.v, r1.undone.how, r1.undone.now_v], [2, 'reverted', 3]);
  assert.equal(d.srv.elements.version(h.id, 3).writer.owner, 'user', 'the revert carries the caller\'s stamp');
  const bytes = logBytes(d.root);
  const r2 = await d.anonApi.post(UNDO, { item: 'm1' });
  assert.equal(r2.status, 409, r2.text);
  assert.deepEqual(r2.json.newer, [{ id: h.id, type: 'highlight', writer_class: 'claude' }]);
  assert.equal(logBytes(d.root), bytes);
  const own = await ok(d.api.post(UNDO, { item: 'm1' }), 'Claude\'s undo');
  assert.deepEqual([own.undone.id, own.undone.v, own.undone.how], [h.id, 1, 'removed']);
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

test('UNDO@scope, U518b: the step back stops at a committed ordinary version — v1 committed, PATCH v2, undo (v3), undo again 409; the element live at v3, the node file unchanged', async (t) => {
  const d = await boot(t);
  const h = await highlight(d.anonApi, 'm1');
  const done = await turn(d.api, 'commit the highlight');
  const nodeId = done.node_id || done.node || (await ok(d.api.get('/api/graph'))).active;
  assert.ok(d.srv.elements.homeOf(h.id, 1), 'v1 is committed');
  const nodeFile = path.join(projectPaths(d.root).graphDir, `${nodeId}.json`);
  const before = fs.readFileSync(nodeFile, 'utf8');
  await ok(d.anonApi.patch(`/api/elements/${h.id}`, { payload: { color: 'blue' } }), 'PATCH blue');
  const r1 = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo the edit');
  assert.deepEqual([r1.undone.v, r1.undone.how, r1.undone.to_v, r1.undone.now_v], [2, 'reverted', 1, 3]);
  assert.equal(d.srv.elements.version(h.id, 3).provenance.undo, 1, 'v3 is marked as restoring v1');
  const bytes = logBytes(d.root);
  const r2 = await d.anonApi.post(UNDO, { item: 'm1' });
  assert.equal(r2.status, 409, r2.text);
  assert.equal(r2.json.error, 'nothing to undo');
  assert.deepEqual(d.srv.state.elements, [`${h.id}@3`], 'the committed element is not removed');
  assert.equal(logBytes(d.root), bytes, 'nothing appended');
  assert.equal(fs.readFileSync(nodeFile, 'utf8'), before, 'the node file unchanged');
});

test('UNDO@scope, U518b: the step back never crosses a committed revert — v1, PATCH v2, undo (v3), commit, PATCH v4, undo (v5 = v3\'s payload), undo again 409', async (t) => {
  const d = await boot(t);
  const h = await highlight(d.anonApi, 'm1');
  await ok(d.anonApi.patch(`/api/elements/${h.id}`, { payload: { color: 'blue' } }), 'PATCH blue');
  const r1 = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo blue');
  assert.deepEqual([r1.undone.v, r1.undone.to_v, r1.undone.now_v], [2, 1, 3]);
  const done = await turn(d.api, 'commit the revert');
  const nodeId = done.node_id || done.node || (await ok(d.api.get('/api/graph'))).active;
  assert.ok(d.srv.elements.homeOf(h.id, 3), 'v3 (the revert) is committed');
  assert.equal(d.srv.elements.homeOf(h.id, 1), null, 'v1 is not');
  const nodeFile = path.join(projectPaths(d.root).graphDir, `${nodeId}.json`);
  const before = fs.readFileSync(nodeFile, 'utf8');
  await ok(d.anonApi.patch(`/api/elements/${h.id}`, { payload: { color: 'green' } }), 'PATCH green');
  const r2 = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo green');
  assert.deepEqual([r2.undone.v, r2.undone.how, r2.undone.to_v, r2.undone.now_v], [4, 'reverted', 3, 5]);
  assert.equal(d.srv.elements.version(h.id, 5).payload.color, 'gold', 'v5 holds the committed v3\'s payload');
  const bytes = logBytes(d.root);
  const r3 = await d.anonApi.post(UNDO, { item: 'm1' });
  assert.equal(r3.status, 409, r3.text);
  assert.equal(r3.json.error, 'nothing to undo');
  assert.deepEqual(d.srv.state.elements, [`${h.id}@5`], 'the element the node holds is not deleted by a live undo');
  assert.equal(logBytes(d.root), bytes, 'the log bytes unchanged');
  assert.equal(fs.readFileSync(nodeFile, 'utf8'), before, 'the node file unchanged');
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

// ── a stroke's page record: undone from either item (tranche 5, U623) ───────
// UNDO@either-end: a page record names its item and both endpoints' items
// (element-refs anchorItems), so the chrome's item finds an arrow from A to B
// at A or at B, and a margin stroke at the item nearest its pen-down;
// UNDO@scope (a) and WRITER@undo-selection (a) are unchanged.
const strokes = require('../lib/core/strokes');
const { approveElementPack } = require('../test-support/element-type-fixture');
const PAGE_ARROW = (a, b) => strokes.pageRecord({
  frame: { w: 1200, h: 2400 },
  from: { item: a, x: 0.5, y: 0.5, w: 600, h: 200 },
  to: { item: b, x: 0.25, y: 0.5, w: 600, h: 200 },
});
const PAGE_MARGIN = (a) => strokes.pageRecord({
  frame: { w: 1200, h: 2400 },
  from: { item: a, x: 1.1, y: 0.2, w: 600, h: 200 },
  to: { item: a, x: 1.2, y: 0.8, w: 600, h: 200 },
});
const INK = 'tq-undo-ink';
async function bootInk(t) {
  const d = await boot(t);
  await render(d.api, 'm3');
  approveElementPack(d, { name: 'tq-undo-ink-pack', type: INK, json: { anchors: ['element', 'page'], payload: { keys: ['anchor', 'shared', 'tool'] } } });
  return d;
}
const ink = async (who, anchor, headers) => (await ok(who.post('/api/elements', { type: INK, anchor, payload: { tool: 'pen' } }, headers), 'POST ink')).element;
const liveIds = (d) => (d.srv.state.elements || []).map((r) => r.split('@')[0]);

test('UNDO@either-end (U623): an arrow from m1 to m2 is undone with the chrome\'s item m2 (the answer names m2), and another from m1 with item m1; an item it does not touch finds nothing', async (t) => {
  const d = await bootInk(t);
  const arrow = await ink(d.anonApi, PAGE_ARROW('m1', 'm2'));
  const elsewhere = await d.anonApi.post(UNDO, { item: 'm3' });
  assert.equal(elsewhere.status, 409, elsewhere.text);
  assert.equal(elsewhere.json.error, 'nothing to undo');
  assert.deepEqual(liveIds(d), [arrow.id]);

  const r = await ok(d.anonApi.post(UNDO, { item: 'm2', device: 'desktop' }), 'undo from the end item');
  assert.deepEqual(r.undone, { id: arrow.id, type: INK, v: 1, item: 'm2', how: 'removed' });
  assert.deepEqual(liveIds(d), [], 'the arrow removed');

  const again = await ink(d.anonApi, PAGE_ARROW('m1', 'm2'));
  const s = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo from the start item');
  assert.deepEqual(s.undone, { id: again.id, type: INK, v: 1, item: 'm1', how: 'removed' });

  // An edit (v2) is reverted from the end item too.
  const third = await ink(d.anonApi, PAGE_ARROW('m1', 'm2'));
  await ok(d.anonApi.patch(`/api/elements/${third.id}`, { payload: { tool: 'marker' } }), 'PATCH v2');
  const e = await ok(d.anonApi.post(UNDO, { item: 'm2' }), 'undo the edit from the end item');
  assert.deepEqual([e.undone.id, e.undone.how, e.undone.to_v, e.undone.item], [third.id, 'reverted', 1, 'm2']);
});

test('UNDO@either-end (U623): a margin stroke is undone from its nearest item; with no item the page-wide newest is the caller\'s and its answer names its item', async (t) => {
  const d = await bootInk(t);
  const margin = await ink(d.anonApi, PAGE_MARGIN('m1'));
  const off = await d.anonApi.post(UNDO, { item: 'm2' });
  assert.equal(off.status, 409, 'not on another item');
  const r = await ok(d.anonApi.post(UNDO, { item: 'm1' }), 'undo from its nearest item');
  assert.deepEqual(r.undone, { id: margin.id, type: INK, v: 1, item: 'm1', how: 'removed' });

  const arrow = await ink(d.anonApi, PAGE_ARROW('m2', 'm3'));
  const page = await ok(d.anonApi.post(UNDO, {}), 'undo with no item');
  assert.deepEqual(page.undone, { id: arrow.id, type: INK, v: 1, item: 'm2', how: 'removed' }, 'the record\'s own item');
});

test('WRITER@undo-selection (U623, unchanged): a pane\'s newer arrow ending on m2 is named in the hint when the user\'s highlight on m2 is undone, and left as it is; page-wide, a pane\'s newer highlight on the arrow\'s end item is named', async (t) => {
  const d = await bootInk(t);
  const mine = await highlight(d.anonApi, 'm2');
  const theirs = await ink(d.anonApi, PAGE_ARROW('m1', 'm2'), PANE('m1'));
  assert.deepEqual(theirs.writer, { class: 'pane', owner: 'pane:m1', verified: false });
  const r = await ok(d.anonApi.post(UNDO, { item: 'm2' }), 'undo on m2');
  assert.equal(r.undone.id, mine.id);
  assert.deepEqual(r.newer, [{ id: theirs.id, type: INK, writer_class: 'pane' }]);
  assert.match(r.hint, /a newer annotation on this pane is tq undo ink by pane; it was left as it is/);
  assert.deepEqual(liveIds(d), [theirs.id], 'the pane\'s arrow is left');
  const none = await d.anonApi.post(UNDO, { item: 'm2' });
  assert.equal(none.status, 409, 'never a refusal keyed on writer, and nothing of the user\'s is left');
  assert.deepEqual(none.json.newer, [{ id: theirs.id, type: INK, writer_class: 'pane' }]);

  // Page-wide: the user's arrow from m1 to m3, then a pane's highlight on m3.
  const arrow = await ink(d.anonApi, PAGE_ARROW('m1', 'm3'));
  const pane = await highlight(d.anonApi, 'm3', PANE('m3'));
  const w = await ok(d.anonApi.post(UNDO, {}), 'undo with no item');
  assert.equal(w.undone.id, arrow.id);
  assert.deepEqual(w.newer, [{ id: pane.id, type: 'highlight', writer_class: 'pane' }], 'a newer version on either of its items is named');
});
