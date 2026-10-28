// The element API (PLAN 2C.4; U325): lib/server/routes/elements.js serves,
// writes and removes every element type through the log's one writer — the
// comment with today's semantics (moved from routes/comments.js), a highlight
// and a box grab as log versions the surface holds by id@v reference
// (state.elements, E-STORE a). Here: the writes and their versions, the typed
// mint (F1 a), the frames and the text-free event, the reference riding a
// commit and its commit record, the re-anchor, the reply rules (C-15-2), the
// one removal (C2: nothing appended), the Wipe and New graph rules, the node
// scope (keyed by stored id, U205), the type gate (built-ins from
// element-policy, a third-party type only when ctx.elementTypes lists it), and
// read-only. The private rows (C-16-2), the network peer and learned-later
// masking are test/element-routes-private.test.js's.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { withServer, waitUntil } = require('../test-support/helpers');
const { v3Graph } = require('../test-support/v3-graph');
const { SCHEMAS, SCHEMA, copyMatches, parsePin } = require('../lib/core/element-log');
const { projectPaths } = require('../lib/core/paths');
const { mountElementRoutes, describeAnchor } = require('../lib/server/routes/elements');
const comments = require('../lib/server/routes/comments');
const client = require('../lib/client');
const { classify } = require('../lib/core/remote-policy');

// A box grab POSTed here is drawn off the request by the export path's
// headless Chrome (U328b): pin the finder to no browser, so these tests never
// launch the machine's own Chrome (test/box-grab.test.js drives the render).
process.env.WEB_CHAT_CHROME = '/nonexistent/web-chat-test/chrome';

const schemaOf = (type) => Object.keys(SCHEMAS).find((s) => SCHEMAS[s].type === type);
const HIGHLIGHT = schemaOf('highlight');
const BOX_GRAB = schemaOf('box-grab');

const logBytes = (root) => { try { return fs.readFileSync(projectPaths(root).elementsLog, 'utf8'); } catch { return ''; } };
const nodeOf = (root, id) => JSON.parse(fs.readFileSync(path.join(projectPaths(root).graphDir, `${id}.json`), 'utf8'));

const RANGE = (mount, exact = 'Hello') => ({ v: 1, kind: 'range', mount, quote: { exact, prefix: '', suffix: '' }, pos: { start: 0, end: exact.length } });
const ELEMENT = (mount, head = 'Hello world') => ({ v: 1, kind: 'element', mount, at: { path: [0], sib: 0 }, fp: { tag: 'p', id: '', cls: ['lead'], head, attrs: [], parent: '' }, rows: [] });
const LOCATOR = { mount: 'm1', selector: 'p.lead', text: 'Hello', ordinal: 0 };
const RECT = (item) => ({ x: 1, y: 2, w: 30, h: 40, item, viewport: { w: 1200, h: 800 } });

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
async function turn(api, message = 't') {
  await ok(api.post('/api/turn-begin', { message }), 'turn-begin');
  return ok(api.post('/api/turn-end', { author: 'claude' }), 'turn-end');
}
const render = (api, id, html = '<p class="lead">Hello world</p>') => ok(api.post('/api/render', { id, html }), `render ${id}`);
const addHighlight = async (api, mount, extra = {}) => (await ok(api.post('/api/elements', {
  type: 'highlight', anchor: RANGE(mount), payload: { color: 'gold', note: 'a note', ...extra },
}), 'POST highlight')).element;
const addComment = async (api, text = 'a pin', extra = {}) => (await ok(api.post('/api/elements', {
  type: 'comment', anchor: LOCATOR, payload: { text, shared: true, ...extra },
}), 'POST comment'));
const events = async (api) => ((await api.get('/api/events?since=0')).json.events || []);

// A local socket's frames, collected.
async function frames(t, d) {
  const got = [];
  const sock = d.ws();
  sock.on('message', (data) => { try { got.push(JSON.parse(data.toString())); } catch {} });
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  t.after(() => { try { sock.close(); } catch {} });
  await waitUntil(() => got.some((f) => f.type === 'hello'), { timeout: 5000, what: 'hello' });
  return got;
}

// pane_state is only settable over the WS (the browser owns pane chrome).
async function pinPane(d, id) {
  const sock = d.ws();
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  sock.send(JSON.stringify({ type: 'pane:state', id, pane_state: { pinned: true } }));
  try {
    await waitUntil(async () => {
      const m = (await d.api.get('/api/mounts')).json.mounts.find((x) => x.id === id);
      return !!(m && m.pane_state && m.pane_state.pinned);
    }, { timeout: 5000, what: `pane ${id} pinned` });
  } finally { sock.close(); }
}

// ── writes, versions, frames, the commit ────────────────────────────────────

test('POST a highlight: a highlight@1 version under the typed mint, its id@v in state.elements, an element:highlight frame and a text-free element event; a highlight-only turn commits a node whose elements and commit record pin it', async (t) => {
  const d = await withServer(t);
  const { api, srv, root } = d;
  await render(api, 'm1');
  await turn(api, 'base');
  const seen = await frames(t, d);
  const next = srv.elements.nextSeq();

  await ok(api.post('/api/turn-begin', { message: 'highlight only' }), 'turn-begin');
  const MARK = 'wc-u325-highlight-note';
  const h = await addHighlight(api, 'm1', { note: MARK });
  assert.equal(h.id, `h${next}`, 'the typed mint: h + the one seq');
  assert.equal(h.type, 'highlight');
  assert.equal(h.schema, HIGHLIGHT);
  assert.equal(h.v, 1);
  assert.equal(h.seq, next);
  assert.deepEqual(h.anchor, RANGE('m1'));
  assert.equal(h.shared, true);
  assert.equal(h.color, 'gold');
  assert.equal(h.note, MARK);
  assert.deepEqual(h.writer, { class: 'claude', owner: 'claude', verified: true });
  assert.deepEqual(h.provenance, { origin: 'local', device: 'desktop' });
  assert.equal(srv.elements.version(h.id, 1).schema, HIGHLIGHT);
  assert.equal(srv.elements.log.element(h.id).kind, 'highlight');
  assert.deepEqual(srv.state.elements, [`${h.id}@1`]);

  const frame = await waitUntil(() => seen.find((f) => f.type === 'element:highlight'), { timeout: 5000, what: 'element:highlight frame' });
  assert.deepEqual(frame.elements.map((e) => [e.id, e.v, e.note]), [[h.id, 1, MARK]]);
  const ev = (await events(api)).filter((e) => e.kind === 'element');
  assert.equal(ev.length, 1);
  const { kind, type, op, id, v, shared, mount } = ev[0];
  assert.deepEqual({ kind, type, op, id, v, shared, mount }, { kind: 'element', type: 'highlight', op: 'add', id: h.id, v: 1, shared: true, mount: 'm1' });
  assert.ok(!JSON.stringify(ev).includes(MARK), 'the event carries no text');

  const end = await ok(api.post('/api/turn-end', { author: 'claude' }), 'turn-end');
  assert.ok(end.node_id, `the highlight-only turn committed: ${JSON.stringify(end)}`);
  assert.deepEqual(nodeOf(root, end.node_id).elements, [`${h.id}@1`], 'the node carries the reference');
  assert.ok(!('comments' in nodeOf(root, end.node_id)) || nodeOf(root, end.node_id).comments.length === 0);
  assert.deepEqual(srv.elements.pinsOf(end.node_id), [`${h.id}@1`], 'its commit record pins it');
});

test('POST a box grab: box-grab@1 under the g mint; GET serves both types, their records, the cursor and the filters', async (t) => {
  const { api, srv } = await withServer(t);
  await render(api, 'm1');
  await render(api, 'm2');
  const c = (await addComment(api, 'first')).element;
  const h = await addHighlight(api, 'm2');
  const gr = await ok(api.post('/api/elements', {
    type: 'box-grab', anchor: { v: 1, kind: 'page', item: 'm1', mount: 'm1', rect: RECT('m1'), viewport: { w: 1200, h: 800 } },
    payload: { rect: RECT('m1'), meta: { tag: 'p' } },
  }), 'POST box grab');
  const g = gr.element;
  assert.match(g.id, /^g\d+$/);
  assert.equal(g.schema, BOX_GRAB);
  // U328b: the meta's closed shape (a chrome key the grab does not record is
  // dropped), completed on the daemon (theme, script_errors), and the capture
  // that holds the picture, reserved before the one version.
  assert.deepEqual([g.rect, g.grab], [RECT('m1'), { capture: g.grab.capture }]);
  assert.match(g.grab.capture, /^cap\d+$/);
  assert.deepEqual(g.meta, { item_path: null, element_path: null, html: '', theme: g.meta.theme, mode: null, viewport: { w: 1200, h: 800 }, script_errors: [] });
  assert.deepEqual(srv.state.elements, [`${h.id}@1`, `${g.id}@1`]);
  assert.deepEqual([c.id, h.id, g.id].map((x) => parsePin(`${x}@1`).id[0]), ['c', 'h', 'g']);

  const all = await ok(api.get('/api/elements'), 'GET');
  assert.deepEqual(all.elements.map((e) => [e.id, e.type]), [[c.id, 'comment'], [h.id, 'highlight'], [g.id, 'box-grab']]);
  assert.equal(all.next_cursor, srv.elements.maxSeq());
  assert.equal(typeof all.respond_hint, 'string', 'the comment type is in the read');
  const onlyH = await ok(api.get('/api/elements?type=highlight'), 'GET highlight');
  assert.deepEqual(onlyH.elements.map((e) => e.id), [h.id]);
  assert.ok(!('respond_hint' in onlyH), 'no comments, no respond_hint');
  const rec = onlyH.elements[0];
  assert.deepEqual(Object.keys(rec).sort(), ['anchor', 'color', 'created_at', 'id', 'note', 'provenance', 'schema', 'seq', 'shared', 'type', 'v', 'writer'].sort());
  assert.deepEqual((await ok(api.get(`/api/elements?since=${h.seq}`))).elements.map((e) => e.id), [g.id], 'since is exclusive');
  assert.deepEqual((await ok(api.get('/api/elements?mount=m2'))).elements.map((e) => e.id), [h.id], 'mount scopes to the anchor\'s item');
  const unknown = await api.get('/api/elements?type=sticker');
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.hint, /built-in/);
});

test('a comment through the element API: today\'s pin plus type, schema, anchor_label and record; an engine anchor with a legacy locator keeps the locator beside it and its copy still matches its version', async (t) => {
  const { api, srv, root } = await withServer(t);
  await render(api, 'm1');
  await turn(api, 'base');
  const legacy = await addComment(api, 'legacy');
  assert.equal(legacy.pin.id, legacy.element.id);
  assert.deepEqual(legacy.pin.anchor, LOCATOR);
  assert.equal(legacy.element.type, 'comment');
  assert.equal(legacy.element.schema, SCHEMA);
  assert.equal(legacy.element.anchor_label, 'm1: "Hello"');
  assert.equal(legacy.element.record.form, 'pin-locator@1', 'the converted record the log holds');

  const eng = await ok(api.post('/api/elements', {
    type: 'comment', anchor: ELEMENT('m1'), locator: LOCATOR, payload: { text: 'engine', shared: true },
  }), 'POST engine comment');
  assert.deepEqual(eng.pin.anchor, ELEMENT('m1'), 'the pin\'s anchor is the engine record');
  assert.deepEqual(eng.pin.locator, LOCATOR, 'the legacy locator rides beside it');
  assert.deepEqual(eng.element.record, ELEMENT('m1'));
  assert.equal(eng.element.anchor_label, 'm1: "Hello"', 'anchor_label reads the served anchor, the 0.8.5 locator (S-14)');
  const adoptedBefore = srv.elements.stats().adopted_versions;
  const n = (await turn(api, 'pins')).node_id;
  assert.equal(srv.elements.stats().adopted_versions, adoptedBefore, 'the commit mapped every copy to its version');
  for (const c of nodeOf(root, n).comments) assert.ok(copyMatches(c, srv.elements.version(c.id, c.v)), `${c.id} matches its version`);
  // An edit keeps the engine anchor and the locator.
  const ed = await ok(api.patch(`/api/elements/${eng.pin.id}`, { text: 'engine 2' }), 'edit');
  assert.deepEqual([ed.pin.anchor, ed.pin.locator], [ELEMENT('m1'), LOCATOR]);
  // describeAnchor: one copy, the element API's (routes/comments.js is the
  // 410 refusal since U327a and exports none).
  assert.equal(comments.describeAnchor, undefined);
  // A bare source record with no locator reads its slug (F.3); one above the
  // item's first heading (slug null) reads as before.
  assert.equal(describeAnchor({ v: 1, kind: 'source', md: 'md-1', slug: 's', quote: { exact: 'Intro' }, pos: { start: 0, end: 5 } }), 'md-1: "Intro" — on section #s');
  assert.equal(describeAnchor({ v: 1, kind: 'source', md: 'md-1', slug: null, quote: { exact: 'Intro' }, pos: { start: 0, end: 5 } }), 'md-1: "Intro"');
  assert.equal(describeAnchor(RANGE('m1', 'quoted')), 'm1: "quoted"');
});

// F.3 (RULED M3 (a)): a pin on a markdown item says which section it is about.
// Its served anchor is the chrome's locator {mount: <md>, selector: <tag>,
// text, ordinal, section}; every anchor without a section keeps its label.
test('describeAnchor: a heading locator reads on section "…", a prose locator its text then the section, a bare source record its slug; every other label unchanged', () => {
  assert.equal(describeAnchor({ mount: 'md-3', selector: 'h2', text: 'Release plan', ordinal: 0, section: 'Release plan' }),
    'md-3: on section "Release plan"');
  assert.equal(describeAnchor({ mount: 'md-3', selector: 'p', text: 'Ship the build on Friday.', ordinal: 1, section: 'Release plan' }),
    'md-3: "Ship the build on Friday." — on section "Release plan"');
  const long = 'x'.repeat(80);
  assert.equal(describeAnchor({ mount: 'md-3', selector: 'h1', text: long, ordinal: 0, section: long }),
    `md-3: on section "${'x'.repeat(60)}…"`, 'the heading clipped at 60, as a text is');
  assert.equal(describeAnchor({ v: 1, kind: 'source', md: 'md-4', slug: 'release-plan', quote: { exact: 'Ship it' }, pos: { start: 20, end: 27 } }),
    'md-4: "Ship it" — on section #release-plan');
  // Unchanged: a pane locator, a selector-only one, a whole pane, an element
  // and a range record, and the S-14 golden's own labels.
  assert.equal(describeAnchor({ mount: 'plan', selector: 'h3', text: 'Timeline', ordinal: 0 }), 'plan: "Timeline"');
  assert.equal(describeAnchor({ mount: 'plan', selector: 'button.go' }), 'plan @ button.go');
  assert.equal(describeAnchor({ mount: 'plan' }), 'plan (whole pane)');
  assert.equal(describeAnchor(ELEMENT('m1')), 'm1: "Hello world"');
  assert.equal(describeAnchor(RANGE('m1', 'quoted')), 'm1: "quoted"');
  assert.equal(describeAnchor(null), null);
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 's14-today.json'), 'utf8'));
  let seen = 0;
  for (const step of golden) {
    for (const c of ((step.get_comments && step.get_comments.comments) || [])) {
      if (!c.anchor || c.anchor_label == null) continue;
      assert.equal(describeAnchor(c.anchor), c.anchor_label, `S-14 ${step.step}: ${c.id}`);
      seen++;
    }
  }
  assert.ok(seen > 0, 'the golden carried labels');
});

test('PATCH: a comment\'s {text, shared} as today; a highlight\'s payload keys; {anchor} appends an anchor version (a comment\'s original null); base_v names the version read', async (t) => {
  const d = await withServer(t);
  const { api, srv, root } = d;
  await render(api, 'm1');
  await render(api, 'm2');
  const p = (await addComment(api, 'one')).pin;
  const noop = await ok(api.patch(`/api/elements/${p.id}`, {}), 'no-op');
  assert.equal(noop.unchanged, true);
  const cursor = srv.elements.maxSeq();
  await ok(api.patch(`/api/elements/${p.id}`, { text: 'one' }), 'same text');
  assert.equal(srv.elements.maxSeq(), cursor, 'an unchanged PATCH spends no seq');
  const ed = await ok(api.patch(`/api/elements/${p.id}`, { text: 'two', shared: false }), 'edit');
  assert.deepEqual([ed.pin.text, ed.pin.shared, ed.pin.v], ['two', false, 2]);

  const h = await addHighlight(api, 'm1');
  const seen = await frames(t, d);
  const hn = await ok(api.patch(`/api/elements/${h.id}`, { note: 'changed', color: 'accent' }), 'highlight edit');
  assert.deepEqual([hn.element.v, hn.element.note, hn.element.color], [2, 'changed', 'accent']);
  assert.ok(hn.element.edited && hn.element.edited.writer.class === 'claude');
  assert.deepEqual(srv.state.elements, [`${h.id}@2`], 'the reference follows the new version');
  await waitUntil(() => seen.some((f) => f.type === 'element:highlight' && f.elements[0] && f.elements[0].v === 2), { timeout: 5000, what: 'the edit frame' });
  const same = await ok(api.patch(`/api/elements/${h.id}`, { payload: { note: 'changed' } }), 'unchanged');
  assert.equal(same.unchanged, true);
  const stale = await api.patch(`/api/elements/${h.id}`, { base_v: 1, note: 'late' });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.v, 2);

  // Re-anchor: a new version; no node rewritten.
  const n = (await turn(api, 'before re-anchor')).node_id;
  const nodeBytes = fs.readFileSync(path.join(projectPaths(root).graphDir, `${n}.json`), 'utf8');
  const ra = await ok(api.patch(`/api/elements/${h.id}`, { anchor: RANGE('m2', 'Hello'), base_v: 2 }), 're-anchor highlight');
  assert.deepEqual([ra.element.v, ra.element.anchor.mount], [3, 'm2']);
  const rc = await ok(api.patch(`/api/elements/${p.id}`, { anchor: ELEMENT('m2', 'Moved') }), 're-anchor comment');
  assert.equal(srv.elements.version(p.id, rc.pin.v).original, null, 'the comment\'s new version has no original');
  assert.deepEqual(rc.pin.anchor, ELEMENT('m2', 'Moved'), 'its anchor is the record');
  assert.equal(rc.element.anchor_label, 'm2: "Moved"');
  assert.deepEqual([rc.pin.text, rc.pin.shared], ['two', false], 'the words stay');
  assert.equal(fs.readFileSync(path.join(projectPaths(root).graphDir, `${n}.json`), 'utf8'), nodeBytes, 'the node is untouched');
  const mixed = await api.patch(`/api/elements/${p.id}`, { anchor: ELEMENT('m1'), text: 'x' });
  assert.equal(mixed.status, 400);
  const stray = await api.patch(`/api/elements/${h.id}`, { payload: { text: 'not a highlight key' } });
  assert.equal(stray.status, 400, stray.text);
  assert.equal((await api.patch('/api/elements/h999', { note: 'x' })).status, 404);
});

test('reply: Claude\'s token replies as claude; a tokenless claude reply is 403 unverified; a claude reply into a private thread is 404; a reply on a highlight is 400', async (t) => {
  const { api, anonApi, port } = await withServer(t);
  await render(api, 'm1');
  const p = (await addComment(api, 'shared')).pin;
  const priv = (await addComment(api, 'private', { shared: false })).pin;
  const r = await ok(api.post(`/api/elements/${p.id}/reply`, { text: 'from Claude', author: 'claude' }), 'claude reply');
  assert.deepEqual(r.pin.replies.map((x) => [x.author, x.writer.verified]), [['claude', true]]);
  assert.equal(r.element.type, 'comment');
  const tokenless = await client.request(port, 'POST', `/api/elements/${p.id}/reply`, { text: 'no token', author: 'claude' }, { timeout: 10000 });
  assert.equal(tokenless.status, 403, JSON.stringify(tokenless.body));
  assert.equal(tokenless.body.writer, 'unverified');
  const browser = await anonApi.post(`/api/elements/${p.id}/reply`, { text: 'I am Claude', author: 'claude' });
  assert.equal(browser.status, 403);
  const intoPrivate = await api.post(`/api/elements/${priv.id}/reply`, { text: 'x', author: 'claude' });
  assert.equal(intoPrivate.status, 404);
  assert.deepEqual(intoPrivate.json, { error: 'not found', id: priv.id });
  const user = await ok(anonApi.post(`/api/elements/${priv.id}/reply`, { text: 'mine', author: 'user' }), 'the user\'s reply on a private pin');
  assert.equal(user.pin.replies[0].author, 'user');
  const h = await addHighlight(api, 'm1');
  const onH = await api.post(`/api/elements/${h.id}/reply`, { text: 'x', author: 'user' });
  assert.equal(onH.status, 400);
  assert.match(onH.json.hint, /comments/);
  assert.equal((await api.post(`/api/elements/${p.id}/reply`, { text: '  ' })).status, 400, 'an empty reply');
});

test('DELETE is the one removal: the live copy or reference goes, the log gains nothing, a frame and a delete event follow; a committed node keeps its own', async (t) => {
  const d = await withServer(t);
  const { api, srv, root } = d;
  await render(api, 'm1');
  const p = (await addComment(api, 'gone soon')).pin;
  const h = await addHighlight(api, 'm1');
  const n = (await turn(api, 'both')).node_id;
  const seen = await frames(t, d);
  const before = logBytes(root);
  assert.deepEqual(await ok(api.del(`/api/elements/${h.id}`), 'delete highlight'), { ok: true, removed: h.id });
  assert.deepEqual(await ok(api.del(`/api/elements/${p.id}`), 'delete comment'), { ok: true, removed: p.id });
  assert.equal(logBytes(root), before, 'nothing appended');
  assert.deepEqual(srv.state.elements, []);
  assert.deepEqual(srv.state.comments, []);
  await waitUntil(() => seen.some((f) => f.type === 'element:highlight' && f.elements.length === 0), { timeout: 5000, what: 'the empty highlight frame' });
  await waitUntil(() => seen.some((f) => f.type === 'element:comment' && f.elements.length === 0), { timeout: 5000, what: 'the element:comment frame' });
  const del = (await events(api)).filter((e) => e.op === 'delete');
  assert.deepEqual(del.map((e) => [e.kind, e.id]), [['element', h.id], ['comment', p.id]]);
  assert.deepEqual(nodeOf(root, n).elements, [`${h.id}@1`], 'the node keeps its reference');
  assert.equal(nodeOf(root, n).comments.length, 1, 'and its copy');
  assert.equal((await api.del(`/api/elements/${h.id}`)).status, 404);
});

test('Wipe keeps a highlight on a pinned pane and drops one on a removed pane; New graph drops every live reference; committed nodes keep theirs', async (t) => {
  const d = await withServer(t);
  const { api, srv, root } = d;
  await render(api, 'm1');
  await render(api, 'm2');
  await pinPane(d, 'm1');
  const keep = await addHighlight(api, 'm1');
  const drop = await addHighlight(api, 'm2');
  const grab = await ok(api.post('/api/elements', { type: 'box-grab', anchor: null, payload: { rect: RECT('m2'), meta: {} } }), 'grab on m2');
  const n = (await turn(api, 'three')).node_id;
  const before = logBytes(root);
  await ok(api.post('/api/graph/wipe', {}), 'wipe');
  assert.deepEqual(srv.state.elements, [`${keep.id}@1`], 'only the pinned pane\'s highlight stays');
  assert.equal(logBytes(root), before, 'a wipe appends nothing');
  const dels = (await events(api)).filter((e) => e.kind === 'element' && e.op === 'delete').map((e) => e.id).sort();
  assert.deepEqual(dels, [drop.id, grab.element.id].sort());
  await ok(api.post('/api/graph/new', {}), 'new graph');
  assert.deepEqual(srv.state.elements, [], 'a New graph drops every reference');
  assert.deepEqual(nodeOf(root, n).elements.slice().sort(), [`${keep.id}@1`, `${drop.id}@1`, `${grab.element.id}@1`].sort(), 'the committed node keeps all three');
  assert.equal(logBytes(root), before);
});

test('the node scope: ?node=<stored id> answers that node\'s elements through elementsForNode; a label answers 400 with the hint; an unknown node 404', async (t) => {
  const { api, srv } = await withServer(t);
  await render(api, 'm1');
  const p = (await addComment(api, 'on n1')).pin;
  const h = await addHighlight(api, 'm1');
  const n1 = (await turn(api, 'one')).node_id;
  await ok(api.patch(`/api/elements/${h.id}`, { note: 'later' }), 'edit');
  const n2 = (await turn(api, 'two')).node_id;
  const at1 = await ok(api.get(`/api/elements?node=${n1}`), 'node n1');
  assert.deepEqual(at1.elements.map((e) => [e.id, e.v, e.node_v]).sort(), [[p.id, 1, 1], [h.id, 1, 1]].sort());
  assert.equal(at1.elements.find((e) => e.id === h.id).note, 'a note');
  assert.deepEqual(at1.elements.find((e) => e.id === h.id).newer_elsewhere.map((x) => [x.v, x.home]), [[2, n2]]);
  assert.equal(at1.elements.find((e) => e.id === p.id).anchor_label, 'm1: "Hello"');
  const at2 = await ok(api.get(`/api/elements?node=${n2}&type=highlight`), 'node n2');
  assert.deepEqual(at2.elements.map((e) => [e.id, e.v, e.note]), [[h.id, 2, 'later']]);
  const labels = (await ok(api.get('/api/graph'), 'graph')).nodes;
  const label = (labels.find((x) => x.id === n1) || {}).label;
  assert.ok(label && label !== n1, `n1 has a label (${label})`);
  const byLabel = await api.get(`/api/elements?node=${encodeURIComponent(label)}`);
  assert.equal(byLabel.status, 400);
  assert.match(byLabel.json.hint, /stored id/);
  assert.equal((await api.get('/api/elements?node=n99999')).status, 404);
  assert.equal((await ok(api.get('/api/elements?node=live&type=highlight'))).elements[0].v, 2);
  assert.ok(srv.elements.pinsOf(n2).includes(`${h.id}@2`));
});

test('a reference whose version the log does not hold is skipped at the commit and counted', async (t) => {
  const { api, srv, root } = await withServer(t);
  await render(api, 'm1');
  const h = await addHighlight(api, 'm1');
  srv.state.elements = [`${h.id}@1`, 'h4242@1'];
  const n = (await turn(api, 'one')).node_id;
  assert.deepEqual(nodeOf(root, n).elements.slice().sort(), [`${h.id}@1`, 'h4242@1'].sort(), 'the node carries both');
  assert.deepEqual(srv.elements.pinsOf(n), [`${h.id}@1`], 'the record pins only the version the log holds');
  assert.equal(srv.elements.stats().element_refs_skipped, 1);
});

test('types: the built-ins work with no registry and with one that lists nothing (the built-in pack\'s record missing); a third-party type only when ctx.elementTypes lists it; an unknown type is 400', async (t) => {
  const d = await withServer(t);
  const { api } = d;
  await render(api, 'm1');
  // The daemon's own ctx has no registry until U324 lands: the built-ins come from element-policy.
  for (const type of ['comment', 'highlight', 'box-grab']) {
    const body = type === 'comment' ? { type, anchor: LOCATOR, payload: { text: 'x' } }
      : type === 'highlight' ? { type, anchor: RANGE('m1'), payload: {} } : { type, anchor: null, payload: { rect: RECT('m1'), meta: {} } };
    await ok(api.post('/api/elements', body), `POST ${type}`);
    assert.equal((await ok(api.get(`/api/elements?type=${type}`))).elements.length, 1);
  }
  assert.equal((await api.post('/api/elements', { type: 'sticker', payload: {} })).status, 400);

  // The same handlers mounted over a registry: one that lists nothing, then one that lists 'sticker'.
  const ctx = { state: d.srv.state, bus: d.srv.bus, audience: d.srv.audience, writers: d.srv.writers, graph: d.srv.graph, elementTypes: null };
  const app = express();
  app.use(express.json());
  mountElementRoutes(app, ctx);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const at = (method, p, body) => client.request(server.address().port, method, p, body, { headers: { [require('../lib/core/writer-token').WRITER_HEADER]: d.writerToken() }, timeout: 10000 });
  ctx.elementTypes = { listed: () => false, gate: () => null, descriptor: () => null, list: () => [] };
  assert.equal((await at('POST', '/api/elements', { type: 'highlight', anchor: RANGE('m1'), payload: {} })).status, 200, 'a built-in the registry does not list');
  assert.equal((await at('GET', '/api/elements?type=comment')).status, 200);
  assert.equal((await at('GET', '/api/elements?type=sticker')).status, 400, 'an unlisted type');
  ctx.elementTypes = {
    listed: (type) => type === 'sticker',
    gate: () => ({ see: 'read', send: 'full' }),
    descriptor: (type) => (type === 'sticker' ? { type, schema: 'sticker@1' } : null),
    list: () => [{ type: 'sticker' }],
  };
  const g = await at('GET', '/api/elements?type=sticker');
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.deepEqual(g.body.elements, []);
  const w = await at('POST', '/api/elements', { type: 'sticker', payload: {} });
  assert.equal(w.status, 400, 'listed, but the log has no schema for it');
  assert.equal(w.body.error, 'element type not writable');
});

test('read-only (a v3 project with an unmappable copy): POST, PATCH and reply answer 503; GET answers 200', async (t) => {
  const { api, srv } = await withServer(t, { seed: ({ root }) => { v3Graph(root, { unmappable: true }); } });
  assert.equal(srv.elements.readOnly, true);
  const got = await api.get('/api/elements');
  assert.equal(got.status, 200);
  const pins = got.json.elements.filter((e) => e.type === 'comment');
  assert.ok(pins.length >= 1);
  for (const r of [
    await api.post('/api/elements', { type: 'comment', anchor: LOCATOR, payload: { text: 'x' } }),
    await api.post('/api/elements', { type: 'highlight', anchor: RANGE('m1'), payload: {} }),
    await api.patch(`/api/elements/${pins[0].id}`, { text: 'changed' }),
    await api.post(`/api/elements/${pins[0].id}/reply`, { text: 'hello', author: 'user' }),
  ]) {
    assert.equal(r.status, 503, r.text);
    assert.match(r.json.hint, /claude-web-chat migrate/);
  }
  assert.equal((await api.get('/api/elements?type=highlight')).status, 200);
});

test('route census: every element route sits under a FLOOR_RULES row (read to see, full to send)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/server/routes/elements.js'), 'utf8');
  const routes = [...src.matchAll(/\bapp\.(get|post|patch|delete)\(\s*'([^']+)'/g)].map((m) => [m[1].toUpperCase(), m[2]]);
  assert.deepEqual(routes.map((r) => r.join(' ')), [
    'GET /api/elements', 'POST /api/elements', 'PATCH /api/elements/:id', 'POST /api/elements/:id/reply',
    'GET /api/elements/:id/grab', 'DELETE /api/elements/:id',
  ]);
  for (const [method, p] of routes) {
    const url = p.replace(':id', 'h7');
    const v = classify(method, url, { mirror: 'full' });
    assert.equal(v.allow, true, `${method} ${url}`);
    assert.equal(v.key, method === 'GET' ? 'GET /api/elements/*' : 'POST|PATCH|DELETE /api/elements/*', `${method} ${url}: the floor row`);
    assert.equal(classify(method, url, { mirror: method === 'GET' ? 'off' : 'read' }).allow, false, `${method} ${url}: below its level`);
  }
});

// ── review additions (U325 round 1): the narrowing rules the brief keeps ────

test('ruling B4 on the element API: a pane-stamped writer edits and deletes only the elements it added (a comment and a highlight); the user and its own pane still may', async (t) => {
  const { PANE_HEADER } = require('../lib/core/writer-token');
  const d = await withServer(t);
  const { api, anonApi, baseUrl } = d;
  for (const id of ['pa', 'pb']) await render(api, id);
  const as = (pane) => ({ Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin', ...(pane ? { [PANE_HEADER]: pane } : {}) });
  const userPin = (await ok(anonApi.post('/api/elements', { type: 'comment', anchor: LOCATOR, payload: { text: 'the user\'s' } }, as(null)))).element;
  const userHl = (await ok(anonApi.post('/api/elements', { type: 'highlight', anchor: RANGE('pa'), payload: { note: 'the user\'s' } }, as(null)))).element;
  const panePin = (await ok(anonApi.post('/api/elements', { type: 'comment', anchor: LOCATOR, payload: { text: 'pa\'s' } }, as('pa')))).element;
  const paneHl = (await ok(anonApi.post('/api/elements', { type: 'highlight', anchor: RANGE('pa'), payload: { note: 'pa\'s' } }, as('pa')))).element;
  assert.equal(paneHl.writer.owner, 'pane:pa');
  const before = logBytes(d.root);
  for (const id of [userPin.id, userHl.id, panePin.id, paneHl.id]) {
    const who = id === panePin.id || id === paneHl.id ? 'pb' : 'pa';
    const edit = await anonApi.patch(`/api/elements/${id}`, { text: 'x', note: 'x' }, as(who));
    assert.equal(edit.status, 403, `${who} edits ${id}: ${edit.text}`);
    assert.equal(edit.json.writer, 'pane');
    const del = await anonApi.del(`/api/elements/${id}`, as(who));
    assert.equal(del.status, 403, `${who} deletes ${id}: ${del.text}`);
  }
  assert.equal(logBytes(d.root), before, 'the refusals appended nothing');
  assert.equal((await anonApi.patch(`/api/elements/${paneHl.id}`, { note: 'edited by its pane' }, as('pa'))).status, 200);
  assert.equal((await anonApi.del(`/api/elements/${panePin.id}`, as('pa'))).status, 200);
  assert.equal((await anonApi.patch(`/api/elements/${userHl.id}`, { note: 'edited by the user' }, as(null))).status, 200);
});

test('a type\'s gate only tightens the floor: a listed type gated see:full / send:local refuses a read viewer\'s read and a full viewer\'s write, with or without ?type=', async (t) => {
  const d = await withServer(t);
  const { rank } = d.srv.audience;
  // A stub audience: the level is the request's own x-test-level header.
  const levelOf = (req) => req.headers['x-test-level'] || 'local';
  const audience = {
    ...d.srv.audience,
    levelOf,
    seesPrivate: () => false,
    requireMirror: (need) => (req, res, next) => (rank(levelOf(req)) >= rank(need) ? next() : res.status(403).json({ ok: false, mirror: levelOf(req) })),
  };
  const ctx = {
    state: d.srv.state, bus: d.srv.bus, audience, writers: d.srv.writers, graph: d.srv.graph,
    elementTypes: {
      listed: (type) => type === 'sticker',
      gate: () => ({ see: 'full', send: 'local' }),
      descriptor: (type) => (type === 'sticker' ? { type, schema: 'sticker@1' } : null),
      list: () => [{ type: 'sticker' }],
    },
  };
  const app = express();
  app.use(express.json());
  mountElementRoutes(app, ctx);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const at = (level, method, p, body) => client.request(server.address().port, method, p, body, { headers: { 'x-test-level': level }, timeout: 10000 });
  assert.equal((await at('read', 'GET', '/api/elements?type=sticker')).status, 403, 'a read viewer, ?type=sticker');
  assert.equal((await at('full', 'GET', '/api/elements?type=sticker')).status, 200, 'a full viewer, ?type=sticker');
  assert.equal((await at('read', 'GET', '/api/elements')).status, 200, 'a read viewer, every type it may see');
  assert.equal((await at('full', 'POST', '/api/elements', { type: 'sticker', payload: {} })).status, 403, 'a full viewer cannot write a send:local type');
  assert.equal((await at('local', 'POST', '/api/elements', { type: 'sticker', payload: {} })).status, 400, 'the host passes the gate, and the log has no schema for it');
});

test('Wipe reads every anchor family: a highlight on the markdown kept above a pinned pane (a source record\'s md) and a box grab whose rect names the pinned pane stay; their twins on a removed item go', async (t) => {
  const d = await withServer(t);
  const { api, srv } = d;
  await ok(api.post('/api/markdown', { id: 'md-gone', text: '## Gone' }), 'md-gone');
  await render(api, 'w1');
  await ok(api.post('/api/markdown', { id: 'md-kept', text: '## Kept' }), 'md-kept');
  await render(api, 'w2');
  await pinPane(d, 'w2');
  const SOURCE = (md) => ({ v: 1, kind: 'source', md, slug: 'x', quote: { exact: 'Kept', prefix: '', suffix: '' } });
  const post = async (body) => (await ok(api.post('/api/elements', body), 'POST')).element;
  const hlKept = await post({ type: 'highlight', anchor: SOURCE('md-kept'), payload: { note: 'kept' } });
  const hlGone = await post({ type: 'highlight', anchor: SOURCE('md-gone'), payload: { note: 'gone' } });
  const grabKept = await post({ type: 'box-grab', anchor: null, payload: { rect: RECT('w2'), meta: {} } });
  const grabGone = await post({ type: 'box-grab', anchor: null, payload: { rect: RECT('w1'), meta: {} } });
  await ok(api.post('/api/graph/wipe', {}), 'wipe');
  const md = (await ok(api.get('/api/mounts'))).markdown.map((m) => m.id);
  assert.deepEqual(md, ['md-kept'], 'the markdown directly above the pinned pane survives');
  assert.deepEqual(srv.state.elements.slice().sort(), [`${hlKept.id}@1`, `${grabKept.id}@1`].sort());
  assert.ok(![hlGone.id, grabGone.id].some((id) => srv.state.elements.some((r) => r.startsWith(`${id}@`))));
});

// K.2-59 (U327a): a comment re-anchored with a legacy locator stores the
// converted record (pin-locator@1) as its anchor; describeAnchor reads its
// fingerprint.text and path.selector, so get_comments' anchor_label keeps the
// text instead of falling to '(whole pane)'.
test('anchor_label: a comment re-anchored with a legacy locator keeps its text label (describeAnchor reads the converted record)', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'm1');
  const eng = await ok(api.post('/api/elements', {
    type: 'comment', anchor: ELEMENT('m1'), payload: { text: 'engine', shared: true },
  }), 'POST engine comment');
  await ok(api.patch(`/api/elements/${eng.pin.id}`, { anchor: LOCATOR }), 're-anchor with a legacy locator');
  const got = (await ok(api.get('/api/elements?type=comment'), 'GET')).elements.find((e) => e.id === eng.pin.id);
  assert.equal(got.anchor.form, 'pin-locator@1', 'the converted record is the pin\'s anchor');
  assert.equal(got.anchor_label, 'm1: "Hello"');
  const noText = { ...got.anchor, fingerprint: { ...got.anchor.fingerprint, text: '' } };
  assert.equal(describeAnchor(noText), 'm1 @ p.lead', 'no text: the converted path.selector');
});

// ── the chain (F.6, U406; RULED L7 (a), O5 (a) "chain", Q8 (a)) ─────────────
// A comment made over live elements records their ids, smallest first, as its
// chain (a comment@2 version); its record adds chain and chain_label, the pane
// and the section derived at read time; a removed member reads 'a removed …';
// a private member reads 'a private element' for a request that does not see
// private records (lib/client: Claude's tools). A chainless comment is as
// today (comments-store.test.js replays the whole S-14 golden).
const CHAINED = Object.keys(SCHEMAS).find((s) => SCHEMAS[s].type === 'comment' && SCHEMAS[s].keys.includes('chain'));
const addGrab = async (api, mount) => (await ok(api.post('/api/elements', {
  type: 'box-grab', anchor: { v: 1, kind: 'page', item: mount, mount, rect: RECT(mount), viewport: { w: 1200, h: 800 } },
  payload: { rect: RECT(mount), meta: { tag: 'p' } },
}), 'POST box grab')).element;

test('a comment posted with a chain of a live highlight and a live box grab is comment@2 with chain and chain_label (smallest first, then the pane and the section, derived); its event carries chain_private', async (t) => {
  const { api, srv } = await withServer(t);
  await ok(api.post('/api/markdown', { id: 'md-title', text: '# Plan\n\n## Options\n\nPick one.' }), 'markdown');
  await render(api, 'm1');
  const h = await addHighlight(api, 'm1');
  const g = await addGrab(api, 'm1');
  const r = await ok(api.post('/api/elements', { type: 'comment', anchor: RANGE('m1'), payload: { text: 'on both', shared: true, chain: [h.id, g.id] } }), 'chained comment');
  assert.equal(r.element.schema, CHAINED);
  assert.equal(srv.elements.version(r.pin.id, r.pin.v).schema, CHAINED);
  assert.deepEqual(srv.elements.version(r.pin.id, r.pin.v).payload.chain, [h.id, g.id], 'stored: the ids only');
  assert.deepEqual(r.pin.chain, [h.id, g.id]);
  assert.deepEqual(r.element.chain, [h.id, g.id]);
  assert.equal(r.element.chain_label, `on highlight ${h.id} › box grab ${g.id} › pane m1 › section "Options"`);
  assert.equal(r.element.anchor_label, 'm1: "Hello"', 'the word level is the anchor\'s own label, unchanged');
  const got = (await ok(api.get('/api/elements?type=comment'))).elements.find((e) => e.id === r.pin.id);
  assert.equal(got.chain_label, r.element.chain_label, 'the read derives the same label');
  const ev = (await events(api)).filter((e) => e.kind === 'comment' && e.op === 'add').pop();
  assert.deepEqual(ev.chain_private, [], 'no member is private');
  // The section follows the page: a heading written above the pane later is read at the next read.
  await ok(api.post('/api/markdown', { id: 'md-title', text: '# Plan\n\n## Choices' }), 'rewrite the heading');
  const again = (await ok(api.get('/api/elements?type=comment'))).elements.find((e) => e.id === r.pin.id);
  assert.match(again.chain_label, /› section "Choices"$/, 'never stored: derived at read time');
  // A chainless comment: comment@1, no chain, no chain_label, no chain_private.
  const bare = await addComment(api, 'bare');
  assert.equal(bare.element.schema, SCHEMA);
  for (const k of ['chain', 'chain_label']) {
    assert.equal(k in bare.element, false, k);
    assert.equal(k in bare.pin, false, k);
  }
  const bareEv = (await events(api)).filter((e) => e.kind === 'comment' && e.op === 'add').pop();
  assert.equal('chain_private' in bareEv, false);
  // Another comment as a member; an empty chain is no chain.
  const onComment = await ok(api.post('/api/elements', { type: 'comment', anchor: LOCATOR, payload: { text: 'on the pin', chain: [bare.pin.id] } }), 'on a comment');
  assert.equal(onComment.element.chain_label, `on comment ${bare.pin.id} › pane m1 › section "Choices"`);
  const empty = await ok(api.post('/api/elements', { type: 'comment', anchor: LOCATOR, payload: { text: 'empty', chain: [] } }), 'empty chain');
  assert.equal(empty.element.schema, SCHEMA);
});

test('a chain naming a missing id, a duplicate, more than 8 ids or a non-id is 400 with the hint; nothing is appended', async (t) => {
  const { api, srv } = await withServer(t);
  await render(api, 'm1');
  const h = await addHighlight(api, 'm1');
  const before = srv.elements.stats().versions;
  const many = [];
  for (let i = 0; i < 9; i++) many.push((await addHighlight(api, 'm1')).id);
  const afterHighlights = srv.elements.stats().versions;
  assert.equal(afterHighlights, before + 9);
  for (const [why, chain] of [
    ['a missing id', [h.id, 'h999']], ['a duplicate', [h.id, h.id]], ['more than 8', many],
    ['a non-string', [7]], ['not a list', h.id], ['an empty id', ['']],
  ]) {
    const r = await api.post('/api/elements', { type: 'comment', anchor: LOCATOR, payload: { text: 'x', chain } });
    assert.equal(r.status, 400, `${why}: ${r.status} ${r.text}`);
    assert.match(r.json.hint, /at most 8 distinct ids, each an element live on the page/, why);
  }
  assert.equal(srv.elements.stats().versions, afterHighlights, 'no refused comment landed');
  assert.ok((await ok(api.post('/api/elements', { type: 'comment', anchor: LOCATOR, payload: { text: 'x', chain: many.slice(0, 8) } }))).element.chain.length === 8, 'eight is the cap');
});

test('after the highlight\'s DELETE the label reads "a removed highlight"; the comment still resolves; an edit, a reply and a re-anchor keep comment@2 and the chain', async (t) => {
  const { api, srv } = await withServer(t);
  await render(api, 'm1');
  const h = await addHighlight(api, 'm1');
  const g = await addGrab(api, 'm1');
  const c = (await ok(api.post('/api/elements', { type: 'comment', anchor: RANGE('m1'), payload: { text: 'chained', chain: [h.id, g.id] } }))).pin;
  await ok(api.del(`/api/elements/${h.id}`), 'delete the highlight');
  const read = async () => (await ok(api.get('/api/elements?type=comment'))).elements.find((e) => e.id === c.id);
  const got = await read();
  assert.ok(got, 'the comment stays');
  assert.equal(got.chain_label, `on a removed highlight ${h.id} › box grab ${g.id} › pane m1`);
  assert.deepEqual(got.chain, [h.id, g.id], 'the recorded chain is unchanged');
  assert.equal(got.anchor_label, 'm1: "Hello"');
  const ed = await ok(api.patch(`/api/elements/${c.id}`, { text: 'edited' }), 'edit');
  assert.equal(ed.element.schema, CHAINED);
  assert.deepEqual(ed.pin.chain, [h.id, g.id]);
  const rp = await ok(api.post(`/api/elements/${c.id}/reply`, { text: 'a reply', author: 'user' }), 'reply');
  assert.equal(rp.element.schema, CHAINED);
  assert.deepEqual(rp.pin.chain, [h.id, g.id]);
  const ra = await ok(api.patch(`/api/elements/${c.id}`, { anchor: ELEMENT('m1') }), 're-anchor');
  assert.equal(ra.element.schema, CHAINED);
  assert.deepEqual(ra.pin.chain, [h.id, g.id]);
  for (const v of [ed.pin.v, rp.pin.v, ra.pin.v]) assert.deepEqual(srv.elements.version(c.id, v).payload.chain, [h.id, g.id]);
  const ops = (await events(api)).filter((e) => e.kind === 'comment' && e.pin && e.pin.id === c.id).map((e) => [e.op, Array.isArray(e.chain_private)]);
  assert.deepEqual(ops, [['add', true], ['edit', true], ['reply', true], ['anchor', true]], 'every chained comment event carries chain_private');
  // A commit keeps the chain on the node copy, which matches its version.
  const n = (await turn(api, 'chained')).node_id;
  const nodeRead = (await ok(api.get(`/api/elements?type=comment&node=${n}`))).elements.find((e) => e.id === c.id);
  assert.equal(nodeRead.chain_label, `on a removed highlight ${h.id} › box grab ${g.id} › pane m1`, 'a node read reads the node\'s own surface');
});

test('a private member reads "a private element" (no type, no id) for a request that does not see private records; a local browser sees it named', async (t) => {
  const { api, port } = await withServer(t);
  await render(api, 'm1');
  const h = await addHighlight(api, 'm1');
  const priv = (await addComment(api, 'secret note', { shared: false })).pin;
  const r = await ok(api.post('/api/elements', { type: 'comment', anchor: RANGE('m1'), payload: { text: 'over both', shared: true, chain: [priv.id, h.id] } }), 'chained comment');
  assert.equal(r.element.chain_label, `on comment ${priv.id} › highlight ${h.id} › pane m1`, 'the local browser sees its own private pin');
  const ev = (await events(api)).filter((e) => e.kind === 'comment' && e.op === 'add').pop();
  assert.deepEqual(ev.chain_private, [priv.id], 'the event names the private member\'s id only');
  const viaClient = await client.request(port, 'GET', '/api/elements?type=comment', undefined, { timeout: 10000 });
  assert.equal(viaClient.status, 200);
  const seen = viaClient.body.elements.find((e) => e.id === r.pin.id);
  assert.equal(seen.chain_label, `on a private element › highlight ${h.id} › pane m1`);
  assert.deepEqual(seen.chain, [null, h.id], 'no id for the private member');
  assert.ok(!JSON.stringify(viaClient.body).includes(priv.id), 'the private member\'s id never reaches lib/client');
  // A request that does not see private records cannot name a private element in a chain (C-16-2).
  const refused = await client.request(port, 'POST', '/api/elements', { type: 'comment', anchor: LOCATOR, payload: { text: 'x', chain: [priv.id] } }, { timeout: 10000 });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.hint, /each an element live on the page/);
});
