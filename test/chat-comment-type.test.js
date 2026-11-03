// The chat-comment type, its record and the family switch (annotation engine
// tranche 3, U415; PLAN.md 3A.1's record half and 3E.5's data half;
// DECISIONS.md C1, C2, D5, L1, L5, L6; RULED CHAT@type a, REQ@chat-wipe a,
// U406@pick a "chain", REQ@chat-pin-lifetime d, U415@plugin-chat-family R3 a,
// U415@id-letter-and-drop-record R5-confirm a, U417-U415@diff-anchor-shape
// S1-confirm a).
//
// Here: the type (listed from the approved built-in pack, family chat, armed by
// the Comment tool with no slot of its own), its policy row (C-16-1), the
// refusals a pack meets, the log's chat-comment@1 row and its one per-kind
// anchor record table, the id letter `k` and the drop record (an older reader
// counts it unknown), and the family switch: a chat element is one line of
// versions in the log alone — never in a commit record, a node, the draft, a
// preview or an export (L2), never removed by a Wipe, a bulk clear or New
// graph, and gone only by its own Delete.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { withServer, withTempHome, waitUntil } = require('../test-support/helpers');
const { createRedactor } = require('../lib/core/redact');
const { projectPaths } = require('../lib/core/paths');
const el = require('../lib/core/element-log');
const { BUILTIN_ELEMENT_TYPES, CHAT_ANCHOR_KINDS, ANCHOR_KINDS, compileElementPolicy } = require('../lib/core/element-policy');
const { BUILTIN_ELEMENT_TYPE_NAMES, BUILTIN_ELEMENT_PACK } = require('../lib/core/names');
const { FRAME_RULES, PRIVATE_RULES } = require('../lib/core/remote-policy');
const { validateElement, toolbarFields, readElementJson, CHAT_FAMILY_HINT } = require('../lib/packs/elements');
const { validateManifest } = require('../lib/packs/manifest');
const { seedElementTypes, ELEMENTS_TEMPLATE_DIR } = require('../lib/server/builtins');
const { findPack } = require('../lib/packs/store');
const { emitElements, removeElement } = require('../lib/server/domain/comments');
const { visibleVersion, elementsForNode } = require('../lib/server/domain/element-scope');
const { refsOf } = require('../lib/server/domain/element-refs');

const { createElementLog, SCHEMAS, ID_PREFIX, maxElementSeqIn, isEngineRecord } = el;
const CHAT = Object.keys(SCHEMAS).find((s) => SCHEMAS[s].type === 'chat-comment');
const HIGHLIGHT = Object.keys(SCHEMAS).find((s) => SCHEMAS[s].type === 'highlight');
const MARK = 'wc-u415-chat-marker';

// ── fixtures: anchors as U414 and U417 produce them ─────────────────────────
const HEAD = { v: 1, conversation_id: 'conv-u415', session_id: 'sess-u415', turn_id: 't_7' };
const FP = { h: '0123456789abcdef', len: 48 };
const TURN = { ...HEAD, kind: 'turn', quote: { exact: 'Explain the plan', prefix: '', suffix: '' }, fp: FP, marks: 0, label: 'turn 3' };
const ITEM = { ...HEAD, kind: 'item', item_id: 'r_t_7_0', field: 'text', quote: { exact: 'The plan has two parts.', prefix: '', suffix: '' }, fp: FP, marks: 0, label: "turn 3's reply" };
const RANGE = {
  ...HEAD, kind: 'item-range', item_id: 'r_t_7_0', field: 'text',
  quote: { exact: 'two parts', prefix: 'The plan has ', suffix: '.' }, pos: { start: 13, end: 22 }, ordinal: { index: 0, of: 2 },
  fp: FP, marks: 0, label: "turn 3's reply",
};
const DIFF = {
  ...HEAD, kind: 'diff-line', file: 'lib/a.js', side: 'new', line: 42, line_fp: { h: 'fedcba9876543210' },
  quote: { exact: 'const a = 1;', prefix: '', suffix: '' }, marks: 0, label: 'diff line lib/a.js:42', node_id: 'n3',
};
const payload = (anchor = RANGE, over = {}) => ({ text: MARK, shared: true, replies: [], anchor, chain: [], ...over });

function tmpDir(t, prefix = 'wc-u415-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}
function openLogIn(t, dir, create = createElementLog) {
  const log = create({ file: projectPaths(dir).elementsLog, redactor: createRedactor() });
  t.after(() => { try { log.close(); } catch {} });
  log.load();
  return log;
}
function newChat(log, anchor = RANGE, over = {}) {
  const id = log.mintId('chat-comment');
  log.ensureElement({ id, kind: 'chat-comment', created_at: 1 });
  return log.appendVersion({ id, schema: CHAT, payload: payload(anchor, over), at: 1 });
}

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
async function frames(t, d) {
  const got = [];
  const sock = d.ws();
  sock.on('message', (data) => { try { got.push(JSON.parse(data.toString())); } catch {} });
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  t.after(() => { try { sock.close(); } catch {} });
  await waitUntil(() => got.some((f) => f.type === 'hello'), { timeout: 5000, what: 'hello' });
  return got;
}
// Every file under a directory, as text (a chat element must not be in any).
function textsUnder(dir) {
  const out = [];
  (function walk(d) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push([p, fs.readFileSync(p, 'utf8')]);
    }
  })(dir);
  return out;
}
// One line of versions: v1 has no parent; every later version's parent is the newest before it.
function assertOneLine(store, id) {
  const vs = store.versionsOf(id);
  assert.ok(vs.length > 0);
  vs.forEach((r, i) => assert.equal(r.parent_v, i === 0 ? null : vs[i - 1].v, `${id}@${r.v}'s parent is the newest before it`));
}

// ── the type ────────────────────────────────────────────────────────────────

test('the registry lists chat-comment from the approved built-in record: four types, family chat, toolbar.tool comment', async (t) => {
  const { anonApi } = await withServer(t);
  const body = await ok(anonApi.get('/api/elements/types'), 'GET types');
  assert.deepStrictEqual(body.types.map((r) => r.type).sort(), ['box-grab', 'chat-comment', 'comment', 'highlight']);
  const row = body.types.find((r) => r.type === 'chat-comment');
  assert.equal(row.family, 'chat');
  assert.equal(row.builtin, true);
  assert.equal(row.pack, BUILTIN_ELEMENT_PACK);
  assert.equal(row.schema, CHAT);
  assert.deepStrictEqual(row.reads, [CHAT]);
  assert.deepStrictEqual(row.anchors, ['turn', 'item', 'item-range', 'diff-line']);
  assert.deepStrictEqual(row.remote, { see: 'read', send: 'full' });
  assert.equal(row.private, true);
  assert.equal(row.toolbar.tool, 'comment', 'served as stored: the Comment tool arms it');
  assert.equal('hotkeys' in row.toolbar, false, 'no hotkeys of its own');
  assert.ok(body.reserved.includes('chat-comment'));
});

test('GET /api/toolbar still lists three tools and three pinned: chat-comment has no slot of its own', async (t) => {
  const { anonApi } = await withServer(t);
  const body = await ok(anonApi.get('/api/toolbar'), 'GET toolbar');
  assert.deepStrictEqual(body.tools.map((x) => x.type), ['comment', 'highlight', 'box-grab']);
  assert.deepStrictEqual(body.project.pinned, ['comment', 'highlight', 'box-grab']);
  assert.equal(body.tools[0].pack.version, '1.1.0');
});

test('toolRows leaves out a row another LISTED type\'s tool arms, and keeps one whose tool names nothing listed', () => {
  const { toolRows } = require('../lib/server/routes/toolbar');
  const rows = [
    { type: 'comment', toolbar: {} },
    { type: 'chat-comment', toolbar: { tool: 'comment' } },
    { type: 'orphan', toolbar: { tool: 'absent' } },
  ];
  assert.deepStrictEqual(toolRows(rows).map((r) => r.type), ['comment', 'orphan']);
});

test('C-16-1 4/4: chat-comment/element.json\'s policy fields equal its BUILTIN_ELEMENT_TYPES row; icons byte-equal to comment\'s', () => {
  assert.deepStrictEqual(BUILTIN_ELEMENT_TYPES.map((r) => r.type), ['comment', 'highlight', 'box-grab', 'chat-comment']);
  assert.deepStrictEqual([...BUILTIN_ELEMENT_TYPE_NAMES], ['comment', 'highlight', 'box-grab', 'chat-comment']);
  const dir = path.join(ELEMENTS_TEMPLATE_DIR, 'elements', 'chat-comment');
  const json = readElementJson(dir).raw;
  const row = BUILTIN_ELEMENT_TYPES.find((r) => r.type === 'chat-comment');
  assert.deepStrictEqual({ type: json.type, family: json.family, remote: json.remote, private: json.private },
    { type: row.type, family: row.family, remote: { ...row.remote }, private: row.private });
  assert.deepStrictEqual(row, { type: 'chat-comment', family: 'chat', remote: { see: 'read', send: 'full' }, private: true });
  for (const f of ['icon-light.svg', 'icon-dark.svg']) {
    assert.ok(fs.readFileSync(path.join(dir, f)).equals(fs.readFileSync(path.join(ELEMENTS_TEMPLATE_DIR, 'elements', 'comment', f))), f);
  }
  const v = validateElement(json, { stageDir: ELEMENTS_TEMPLATE_DIR, name: 'chat-comment', builtin: true });
  assert.deepStrictEqual([v.errors, v.warnings], [[], []]);
  // Everything compiled from the row follows: a frame row at read, a private path; no RULES row.
  assert.deepStrictEqual(FRAME_RULES.find((r) => r.type === 'element:chat-comment'), { type: 'element:chat-comment', level: 'read' });
  assert.deepStrictEqual(PRIVATE_RULES.frames['element:chat-comment'], ['elements[]']);
  assert.deepStrictEqual(compileElementPolicy(BUILTIN_ELEMENT_TYPES).typeGates['chat-comment'], { see: 'read', send: 'full' });
  assert.deepStrictEqual([...CHAT_ANCHOR_KINDS], ['turn', 'item', 'item-range', 'diff-line']);
  assert.ok(Object.isFrozen(CHAT_ANCHOR_KINDS));
  for (const k of CHAT_ANCHOR_KINDS) assert.ok(ANCHOR_KINDS.includes(k), k);
});

test('the pack reinstalls on the version change: a project on 1.0.0 (no chat-comment) boots into 1.1.0, reason version', (t) => {
  withTempHome(t);
  const root = tmpDir(t, 'wc-u415-pack-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  // The shipped tree as the previous build had it.
  const old = path.join(tmpDir(t, 'wc-u415-ship-'), BUILTIN_ELEMENT_PACK);
  fs.cpSync(ELEMENTS_TEMPLATE_DIR, old, { recursive: true });
  fs.rmSync(path.join(old, 'elements', 'chat-comment'), { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(old, 'web-chat-pack.json'), 'utf8'));
  fs.writeFileSync(path.join(old, 'web-chat-pack.json'), JSON.stringify({ ...m, version: '1.0.0', elements: ['comment', 'highlight', 'box-grab'] }));
  const said = [];
  const first = seedElementTypes({ root }, { templateDir: old, log: (s) => said.push(s) });
  assert.equal(first.installed, true);
  assert.equal(first.version, '1.0.0');
  const next = seedElementTypes({ root }, { log: (s) => said.push(s) });
  assert.deepStrictEqual([next.installed, next.reason, next.version], [true, 'version', '1.1.0'], 'the boot step\'s report names the version change');
  const rec = findPack(root, BUILTIN_ELEMENT_PACK, 'local').pack;
  assert.equal(rec.version, '1.1.0');
  assert.ok(rec.units.some((u) => u.kind === 'element' && u.name === 'chat-comment'));
  assert.ok(fs.existsSync(path.join(projectPaths(root).elementTypesDir, 'chat-comment', 'element.json')));
  assert.equal(seedElementTypes({ root }, { log: (s) => said.push(s) }).reason, 'intact');
  assert.deepStrictEqual(said, []);
});

// ── refusals ────────────────────────────────────────────────────────────────

const STICKY = { type: 'sticky', family: 'page', remote: { see: 'read', send: 'full' }, schema: 'sticky@1', anchors: ['element'] };

test('refusals: a pack shipping chat-comment is reserved; a page type with a chat kind; a chat-family pack type (refused, CHATFAM@refused a); a tool naming its own type', () => {
  const reserved = validateManifest({ name: 'acme-notes', version: '1.0.0', elements: ['chat-comment'] });
  assert.ok(reserved.errors.some((e) => /element "chat-comment" is a built-in element type name/.test(e)), reserved.errors.join(' | '));

  const mixed = validateElement({ ...STICKY, anchors: ['element', 'turn'] }, { name: 'sticky' });
  assert.equal(mixed.ok, false);
  assert.ok(mixed.errors.some((e) => /\["turn"\] are chat kinds, which only a chat-family type accepts/.test(e)), mixed.errors.join(' | '));

  const chat = validateElement({ ...STICKY, family: 'chat', anchors: ['turn'] }, { name: 'sticky' });
  assert.equal(chat.ok, false);
  assert.ok(chat.errors.some((e) => e.includes('family "chat" is refused') && e.includes(CHAT_FAMILY_HINT)), chat.errors.join(' | '));
  assert.equal(CHAT_FAMILY_HINT, 'plug-in chat types are not supported in this build; only the built-in chat-comment is a chat type');
  assert.doesNotMatch(CHAT_FAMILY_HINT, /tranche/i, 'the hint promises no tranche (CHATFAM@refused a)');
  // …the built-in pack alone may declare it; and a chat type's anchors are chat kinds only, even there.
  assert.equal(validateElement({ ...STICKY, family: 'chat', anchors: ['turn'] }, { name: 'sticky', builtin: true }).ok, true);
  const chatPage = validateElement({ ...STICKY, family: 'chat', anchors: ['turn', 'range'] }, { name: 'sticky', builtin: true });
  assert.ok(chatPage.errors.some((e) => /a chat-family type's "anchors" are chat kinds only/.test(e)), chatPage.errors.join(' | '));

  const self = validateElement({ ...STICKY, tool: 'sticky' }, { name: 'sticky' });
  assert.equal(self.ok, false);
  assert.ok(self.errors.some((e) => /"tool" names the type itself/.test(e)), self.errors.join(' | '));
  for (const bad of ['Comment', '', 7, 'a_b', null]) {
    assert.equal(toolbarFields({ type: 'sticky', tool: bad }, null).ok, false, JSON.stringify(bad));
  }
  assert.deepStrictEqual(toolbarFields({ type: 'sticky', tool: 'comment' }, null), { ok: true, errors: [] });
  const armed = validateElement({ ...STICKY, tool: 'comment' }, { name: 'sticky' });
  assert.equal(armed.ok, true);
  assert.equal(armed.descriptor.tool, 'comment', 'kept in the descriptor as written');
  assert.deepStrictEqual(armed.warnings, [], 'a known key now');
});

// ── the log ─────────────────────────────────────────────────────────────────

test('the log: a chat-comment@1 version with a U414-shaped anchor appends under the letter k, stored as given', (t) => {
  const log = openLogIn(t, tmpDir(t));
  assert.equal(ID_PREFIX['chat-comment'], 'k');
  for (const anchor of [TURN, ITEM, RANGE]) {
    const rec = newChat(log, anchor);
    assert.match(rec.id, /^k\d+$/);
    assert.equal(rec.schema, CHAT);
    assert.deepStrictEqual(rec.payload, payload(anchor), 'stored as given');
    assert.ok(isEngineRecord(anchor), 'a chat anchor is an engine record');
  }
  assert.deepStrictEqual(SCHEMAS[CHAT].keys, [...SCHEMAS['comment@2'].keys], 'comment@2\'s keys, chain included');
  // A chain of typed ids (a bare comment's is empty).
  const chained = newChat(log, RANGE, { chain: ['k1', 'h9'] });
  assert.deepStrictEqual(chained.payload.chain, ['k1', 'h9']);
  // The scanner reads the letter.
  assert.equal(maxElementSeqIn('{"t":"el","id":"k42","kind":"chat-comment"'), 42);
});

test('the log: a diff-line record (the head plus file, side, line, line_fp, node_id?; no fp) appends', (t) => {
  const log = openLogIn(t, tmpDir(t));
  const rec = newChat(log, DIFF);
  assert.deepStrictEqual(rec.payload.anchor, DIFF);
  const { node_id, ...noNode } = DIFF;
  assert.deepStrictEqual(newChat(log, noNode).payload.anchor, noNode, 'node_id is optional');
});

test('checkChatPayload refuses per kind: a page anchor, a long quote, no session_id, a non-list chain, another kind\'s field, a missing own field', (t) => {
  const log = openLogIn(t, tmpDir(t));
  const id = log.mintId('chat-comment');
  log.ensureElement({ id, kind: 'chat-comment', created_at: 1 });
  const refused = (p, re, what) => assert.throws(() => log.appendVersion({ id, schema: CHAT, payload: p, at: 1 }), (e) => e instanceof TypeError && re.test(e.message), what);
  const { session_id, ...noSession } = RANGE;
  const { fp, ...noFp } = ITEM;
  const { line_fp, ...noLineFp } = DIFF;
  refused(payload({ v: 1, kind: 'range', mount: 'm1', quote: { exact: 'x', prefix: '', suffix: '' } }), /has a chat kind/, 'a page anchor');
  refused(payload({ ...RANGE, quote: { exact: 'x'.repeat(2001), prefix: '', suffix: '' } }), /malformed quote/, 'a quote over 2000');
  refused(payload({ ...RANGE, quote: { exact: 'x', prefix: 'p'.repeat(33), suffix: '' } }), /malformed quote/, 'a prefix over 32');
  refused(payload(noSession), /lacks session_id/, 'no session_id');
  refused(payload({ ...RANGE, session_id: null }), /malformed session_id/, 'a null session_id');
  refused(payload(RANGE, { chain: 'k1' }), /chain is a list/, 'a chain that is not a list');
  refused(payload(RANGE, { chain: ['nope'] }), /typed element ids/, 'a chain of untyped ids');
  refused(payload(RANGE, { chain: ['k1', 'k1'] }), /each id once/, 'a chain with a repeated id');
  refused(payload({ ...DIFF, fp: FP }), /holds fp, a turn anchor's field, not a diff-line anchor's/, 'fp on a diff line');
  refused(payload({ ...RANGE, line_fp: { h: 'fedcba9876543210' } }), /holds line_fp, a diff-line anchor's field/, 'line_fp on an item-range');
  refused(payload({ ...ITEM, mount: 'm1' }), /holds mount, which no chat anchor carries/, 'a page field');
  refused(payload(noFp), /lacks fp/, 'an item without its fp');
  refused(payload(noLineFp), /lacks line_fp/, 'a diff line without its line_fp');
  refused(payload({ ...DIFF, side: 'both' }), /malformed side/, 'a side that is not new or old');
  refused(payload({ ...RANGE, label: 'l'.repeat(301) }), /malformed label/, 'a label over 300');
  refused(payload(RANGE, { replies: [{ author: 'bot', at: 1, text: 'x' }] }), /replies are/, 'a reply author');
  refused({ text: MARK, anchor: RANGE }, /chain is a list/, 'no chain');
  assert.equal(log.versionsOf(id).length, 0, 'nothing appended');
});

test('the drop record: ids and stamps only; it survives a reload; a second drop appends nothing', (t) => {
  const dir = tmpDir(t);
  const log = openLogIn(t, dir);
  const rec = newChat(log);
  const drop = log.appendDrop({ id: rec.id, writer: { class: 'user', owner: null, verified: false }, provenance: { origin: 'local' } });
  assert.deepStrictEqual(Object.keys(drop).sort(), ['at', 'id', 'provenance', 't', 'writer']);
  assert.equal(drop.t, 'drop');
  assert.ok(!JSON.stringify(drop).includes(MARK), 'never text');
  assert.ok(log.dropped(rec.id));
  assert.equal(log.dropped('k999'), null);
  assert.deepStrictEqual(log.appendDrop({ id: rec.id }), drop, 'a second drop answers the first');
  assert.throws(() => log.appendDrop({ id: 'k999' }), /holds no element/);
  assert.throws(() => log.appendDrop({ id: 'not an id' }), TypeError);
  log.close();
  const again = openLogIn(t, dir);
  assert.ok(again.dropped(rec.id), 'read back after a reload');
  assert.equal(again.stats().drops, 1);
  assert.equal(again.stats().unknown, 0);
});

test('an older reader (the index without the drop case) counts the drop record unknown and loads the rest', (t) => {
  const dir = tmpDir(t);
  const log = openLogIn(t, dir);
  const a = newChat(log);
  const b = newChat(log, TURN);
  log.appendDrop({ id: a.id });
  log.close();
  // The index as an older build has it: no `case 'drop'` (the rest unchanged).
  const src = fs.readFileSync(require.resolve('../lib/core/element-log'), 'utf8');
  const older = src.replace(/      case 'drop':\n[\s\S]*?return;\n/, '')
    .replace(/require\('\.\/([a-z-]+)'\)/g, (_, m) => `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'core', m))})`);
  assert.notEqual(older, src);
  assert.ok(!older.includes("case 'drop'"));
  const file = path.join(tmpDir(t, 'wc-u415-older-'), 'element-log-older.js');
  fs.writeFileSync(file, older);
  const { createElementLog: olderLog } = require(file);
  const old = openLogIn(t, dir, olderLog);
  assert.equal(old.stats().unknown, 1, 'the drop is unknown');
  assert.equal(old.stats().skipped, 0);
  assert.ok(old.latest(a.id) && old.latest(b.id), 'every version loads');
  assert.equal(old.dropped(a.id), null, 'an older reader never sees the drop');
});

// ── the family switch, over a running daemon ────────────────────────────────

test('the family switch: one line of versions in the log alone, through Set active, a Branch, a Wipe, a bulk clear and New graph; never on a node, a draft, a preview or an export', async (t) => {
  const d = await withServer(t);
  const { api, srv, root } = d;
  const store = srv.elements;
  const seen = await frames(t, d);
  await render(api, 'm1');
  const n1 = (await turn(api, 'one')).node_id;

  // A chat element added through the store (U416's route is not here yet): the log alone.
  const added = store.addElement({ type: 'chat-comment', schema: CHAT, payload: payload(), author: 'user' });
  const id = added.id;
  assert.match(id, /^k\d+$/);
  assert.equal(store.familyOf('chat-comment'), 'chat');
  assert.equal(store.familyOf('comment'), 'page');
  assert.equal(store.familyOf('sticky'), 'page', 'a type nobody declares is a page type');
  assert.deepStrictEqual(refsOf(srv.state), [], 'the surface holds no chat reference');
  assert.deepStrictEqual(store.chatRecords().map((r) => r.id), [id]);
  assert.deepStrictEqual(store.liveRecords('chat-comment').map((r) => r.id), [id]);
  assert.equal(store.chatRecords()[0].text, MARK);
  // The frame (an event that raises no queue item: the wake path is U416's and U423's).
  emitElements(srv.state, srv.bus, store, 'chat-comment', { kind: 'element', type: 'chat-comment', op: 'add', id, v: 1, shared: false, mount: null });
  await waitUntil(() => seen.some((f) => f.type === 'element:chat-comment' && f.elements.some((r) => r.id === id)), { timeout: 5000, what: 'the element:chat-comment frame' });

  let v = 1;
  const editTo = (text) => { const r = store.editElement(id, v, { patch: { text } }); v = r.element.v; return r; };

  await render(api, 'm1', '<p>two</p>');
  const n2 = (await turn(api, 'two')).node_id;
  editTo(`${MARK} edited`);
  await ok(api.post('/api/graph/active', { id: n1 }), 'set active n1');
  editTo(`${MARK} after set active`);
  await render(api, 'm1', '<p>branch</p>');
  const n3 = (await turn(api, 'branch')).node_id;
  assert.equal(srv.graph.nodes.get(n3).parent_id, n1, 'a branch off n1');
  v = store.replyElement(id, v, { text: 'a reply', author: 'user' }).v;
  await ok(api.post('/api/graph/wipe', {}), 'wipe');
  editTo(`${MARK} after wipe`);
  await render(api, 'm2');
  await ok(api.post('/api/clear', {}), 'bulk clear');
  v = store.replyElement(id, v, { text: 'claude here', author: 'claude' }).v;
  await ok(api.post('/api/graph/new', {}), 'new graph');
  editTo(`${MARK} after new graph`);
  await render(api, 'm3');
  const n4 = (await turn(api, 'after')).node_id;

  // Still there, at its newest version, and one line of versions.
  assert.deepStrictEqual(store.chatRecords().map((r) => [r.id, r.v]), [[id, v]]);
  assert.equal(v, 7, "v1, four edits and two replies");
  assertOneLine(store, id);
  const rec = store.chatRecords()[0];
  assert.deepStrictEqual(rec.replies.map((r) => [r.author, r.text]), [['user', 'a reply'], ['claude', 'claude here']]);
  assert.equal(rec.text, `${MARK} after new graph`);
  assert.ok(rec.edited, 'an edit is recorded as edited');

  // An edit or a reply from an older base is refused stale; nothing appended.
  assert.throws(() => store.editElement(id, 2, { patch: { text: 'old base' } }), (e) => e.code === 'STALE' && e.v === v);
  assert.throws(() => store.replyElement(id, 3, { text: 'old base' }), (e) => e.code === 'STALE');
  assert.throws(() => store.replyElement(id, v, { text: '   ' }), (e) => e.reason === 'payload');
  assert.throws(() => store.replyElement(id, v, { text: 'x', author: 'bot' }), (e) => e.reason === 'author');
  assert.equal(store.versionsOf(id).length, v);

  // No commit record pins it; no node, the draft, a preview or an export carries it (D5, L2).
  for (const c of store.log.commits()) assert.ok(!c.pins.some((p) => p.startsWith(`${id}@`)), `${c.node} pins no chat id`);
  for (const n of [n1, n2, n3, n4]) {
    assert.deepStrictEqual(elementsForNode(srv.graph, store, n).filter((r) => r.id === id), [], `${n}: elementsForNode lists none`);
    assert.equal(visibleVersion(srv.graph, store, id, n), v, `${n}: the newest version, whatever the node`);
    const preview = await api.get(`/preview/node/${n}`);
    assert.equal(preview.status, 200);
    assert.ok(!preview.text.includes(MARK) && !preview.text.includes(`"${id}`), `${n}: the preview carries none`);
    const exp = await api.get(`/api/export/${n}`);
    assert.equal(exp.status, 200, exp.text.slice(0, 200));
    assert.ok(!exp.text.includes(MARK) && !exp.text.includes(`"${id}`), `${n}: the export carries none`);
  }
  assert.equal(store.stats().chat_refs_skipped, 0, 'the surface never held one');
  await render(api, 'm4');
  await d.graceful();
  const files = textsUnder(projectPaths(root).graphDir);
  const draft = srv.graph.draftPath;
  assert.ok(draft && fs.existsSync(draft), 'the graceful stop wrote the draft');
  files.push([draft, fs.readFileSync(draft, 'utf8')]);
  for (const [f, text] of files) {
    assert.ok(!text.includes(MARK), `${path.basename(f)} carries no chat text`);
    assert.ok(!new RegExp(`"${id}(@|")`).test(text), `${path.basename(f)} carries no chat id`);
  }
});

test('dropElement: the chat element leaves chatRecords and the next frame through removeElement; a page type\'s Delete still goes through dropRef', async (t) => {
  const d = await withServer(t);
  const { api, srv } = d;
  const store = srv.elements;
  const seen = await frames(t, d);
  const a = store.addElement({ type: 'chat-comment', schema: CHAT, payload: payload(DIFF), author: 'user' });
  const b = store.addElement({ type: 'chat-comment', schema: CHAT, payload: payload(TURN), author: 'user' });
  assert.deepStrictEqual(store.chatRecords().map((r) => r.id), [a.id, b.id]);

  assert.equal(removeElement(srv.state, srv.bus, a.id, { elements: store, writer: { class: 'user', owner: null, verified: false } }), true);
  assert.deepStrictEqual(store.chatRecords().map((r) => r.id), [b.id]);
  assert.ok(store.dropped(a.id));
  assert.equal(store.stats().drops, 1);
  await waitUntil(() => seen.some((f) => f.type === 'element:chat-comment' && f.elements.length === 1 && f.elements[0].id === b.id), { timeout: 5000, what: 'the frame without the dropped one' });
  assert.equal(removeElement(srv.state, srv.bus, a.id, { elements: store }), false, 'already gone');
  assert.throws(() => store.editElement(a.id, 1, { patch: { text: 'x' } }), (e) => e.code === 'GONE');
  assert.deepStrictEqual(store.dropElement(b.id), { id: b.id, dropped: true });
  assert.deepStrictEqual(store.dropElement(b.id), { id: b.id, dropped: false });
  assert.equal(visibleVersion(srv.graph, store, b.id, srv.graph.active), null, 'a dropped chat element is visible from no node');

  // A page type: the DELETE route's dropRef, nothing appended, and dropElement refuses it.
  await render(api, 'm1');
  const h = (await ok(api.post('/api/elements', {
    type: 'highlight', anchor: { v: 1, kind: 'range', mount: 'm1', quote: { exact: 'Hello', prefix: '', suffix: '' }, pos: { start: 0, end: 5 } },
    payload: { color: 'gold', note: 'n' },
  }), 'POST highlight')).element;
  assert.equal(store.familyOf(store.typeOf(h.id)), 'page');
  assert.throws(() => store.dropElement(h.id), (e) => e.reason === 'family');
  const drops = store.stats().drops;
  await ok(api.del(`/api/elements/${h.id}`), 'delete highlight');
  assert.deepStrictEqual(refsOf(srv.state), []);
  assert.equal(store.stats().drops, drops, 'a page Delete appends no drop record');
  assert.equal(store.dropped(h.id), null);
});

test('commitPins skips (and counts) a chat reference a node names; a highlight\'s still pins', async (t) => {
  const { srv } = await withServer(t);
  const store = srv.elements;
  const k = store.addElement({ type: 'chat-comment', schema: CHAT, payload: payload(), author: 'user' });
  const h = store.addElement({ type: 'highlight', schema: HIGHLIGHT, payload: { anchor: null, shared: true, color: 'gold', note: 'n' }, author: 'user' });
  const rec = store.adopt({ id: 'n99', parent_id: null, created_at: 1, comments: [], elements: [`${k.id}@1`, `${h.id}@1`] });
  assert.deepStrictEqual(rec.pins, [`${h.id}@1`]);
  assert.equal(store.stats().chat_refs_skipped, 1);
});

// A PAGE comment never stores a chat anchor (the type's anchors are chat
// kinds iff its family is chat): payloadOf keeps an engine record as given
// only for a page kind, and a mountless chat-kind record is refused as on
// ae/int — 'anchor-without-mount', a 400 at the route, nothing appended.
test('a page comment refuses a chat anchor: POST {type: comment, anchor: TURN} and a PATCH re-anchor to TURN answer 400 and append nothing', async (t) => {
  for (const anchor of [TURN, ITEM, RANGE, DIFF]) {
    assert.throws(() => el.payloadOf({ text: 'x', shared: true, replies: [], anchor }), (e) => e.reason === 'anchor-without-mount', anchor.kind);
  }
  const d = await withServer(t);
  const { api, srv } = d;
  const store = srv.elements;
  await render(api, 'm1');
  const before = store.stats();
  const post = await api.post('/api/elements', { type: 'comment', anchor: TURN, payload: { text: 'secret', shared: true } });
  assert.equal(post.status, 400, post.text);
  assert.deepStrictEqual([store.stats().elements, store.stats().versions], [before.elements, before.versions], 'the refused add appended nothing');
  assert.ok(!(await ok(api.get('/api/elements'), 'GET')).elements.some((e) => e.type === 'comment'), 'no page comment carries the turn anchor');

  // A comment on the page, then a re-anchor of it onto the turn.
  const c = (await ok(api.post('/api/elements', { type: 'comment', anchor: { mount: 'm1', selector: 'p.lead', text: 'Hello world', ordinal: 0 }, payload: { text: 'page note', shared: true } }), 'POST comment')).element;
  const mid = store.stats();
  const patch = await api.patch(`/api/elements/${c.id}`, { anchor: TURN });
  assert.equal(patch.status, 400, patch.text);
  assert.deepStrictEqual([store.stats().elements, store.stats().versions], [mid.elements, mid.versions], 'the refused re-anchor appended nothing');
  const now = (await ok(api.get('/api/elements'), 'GET')).elements.find((e) => e.id === c.id);
  assert.notEqual(now.anchor && now.anchor.kind, 'turn');
  assert.equal(now.v, c.v);
});

// The head's own fields are checked too (S1: the common head of every row),
// and the store refuses a payload its schema's check refuses before an id is
// minted (a refused write spends nothing).
test('checkChatPayload refuses a malformed head (marks, fp.h, v, conversation_id, turn_id); addElement spends nothing on a refusal', async (t) => {
  const log = openLogIn(t, tmpDir(t));
  const id = log.mintId('chat-comment');
  log.ensureElement({ id, kind: 'chat-comment', created_at: 1 });
  const refused = (p, re, what) => assert.throws(() => log.appendVersion({ id, schema: CHAT, payload: p, at: 1 }), (e) => e instanceof TypeError && re.test(e.message), what);
  const { conversation_id, ...noConversation } = TURN;
  const { turn_id, ...noTurn } = TURN;
  refused(payload({ ...TURN, marks: -1 }), /malformed marks/, 'a negative marks');
  refused(payload({ ...TURN, marks: 1.5 }), /malformed marks/, 'a fractional marks');
  refused(payload({ ...TURN, fp: { h: 'not-hex-at-all!!', len: 1 } }), /malformed fp/, 'an fp whose h is not 16 hex');
  refused(payload({ ...TURN, v: 2 }), /malformed v/, 'a v that is not 1');
  refused(payload(noConversation), /lacks conversation_id/, 'no conversation_id');
  refused(payload(noTurn), /lacks turn_id/, 'no turn_id');
  assert.equal(log.versionsOf(id).length, 0, 'nothing appended');

  const { srv } = await withServer(t);
  const store = srv.elements;
  const before = store.stats();
  assert.throws(() => store.addElement({ type: 'chat-comment', schema: CHAT, payload: payload({ ...TURN, marks: -1 }), author: 'user' }), (e) => e.reason === 'payload');
  assert.deepStrictEqual([store.stats().elements, store.stats().versions, store.stats().next_seq],
    [before.elements, before.versions, before.next_seq], 'the refused add minted and appended nothing');
});

// A chat comment's record follows the comment's thread rules: each reply
// carries the stamps of the version that appended it, and `edited` is the
// newest version whose text or sharing changed — a reply is never an edit.
test('a chat comment\'s record: each reply is stamped by its own version; a reply is never an edit', async (t) => {
  const { srv } = await withServer(t);
  const store = srv.elements;
  const w = (owner) => ({ class: 'user', owner, verified: false });
  const a = store.addElement({ type: 'chat-comment', schema: CHAT, payload: payload(), author: 'user', writer: w('w1') });
  const r1 = store.replyElement(a.id, a.v, { text: 'first reply', author: 'user', writer: w('w2') });
  assert.equal(r1.edited, undefined, 'a reply alone is no edit');
  assert.deepStrictEqual(r1.replies.map((r) => r.writer && r.writer.owner), ['w2']);
  const e = store.editElement(a.id, r1.v, { patch: { text: `${MARK} edited` }, writer: w('w3') }).element;
  const r2 = store.replyElement(a.id, e.v, { text: 'second reply', author: 'claude', writer: w('w4') });
  assert.deepStrictEqual(r2.replies.map((r) => [r.author, r.text, r.writer && r.writer.owner]),
    [['user', 'first reply', 'w2'], ['claude', 'second reply', 'w4']]);
  assert.equal(r2.edited && r2.edited.writer && r2.edited.writer.owner, 'w3', 'the edit, not the later reply, is the editor');
  assert.equal(r2.writer && r2.writer.owner, 'w1', 'the creator');
  assertOneLine(store, a.id);
});
