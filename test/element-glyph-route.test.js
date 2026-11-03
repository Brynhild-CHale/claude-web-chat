// A detached glyph's move (annotation engine tranche 4, U587; spec H.7;
// DECISIONS L.1 M4 a, K.2-151; RULED U587@glyph-offset-store AI5 a):
// POST /api/elements/:id/glyph {dx, dy, corner} over the element store's
// moveGlyph — one version whose payload is its parent's (payload_hash and
// src_hash unchanged, the anchor untouched) beside a new `display` sibling,
// stamped with the caller's writer; the engine's undo (POST
// /api/elements/undo, U518) retracts it as any version, a committed node keeps
// the placement by id@v, a private element's move answers a non-seesPrivate
// reader nothing, and the boot reconcile reads a moved, committed comment
// clean (GT-10's reconcile unchanged).
//
// Who is who (test/element-undo.test.js's terms): `anonApi` is a local browser
// (the writer 'user'); `api` carries Claude's writer token; a remote viewer is
// a loopback request carrying X-WC-Remote: 1 at the project's opt-in in the
// sandbox's tunnel.json.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer, tmpRoot } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths, projectPaths } = require('../lib/core/paths');
const { createElementLog, SIBLINGS } = require('../lib/core/element-log');
const { stableHash } = require('../lib/core/stable-json');
const { createRedactor } = require('../lib/core/redact');
const { GLYPH_CORNERS, GLYPH_OFFSET_MAX, glyphProblem } = require('../lib/server/domain/elements');

const LOCATOR = (mount = 'm1') => ({ mount, selector: 'p.lead', text: 'Hello', ordinal: 0 });
const RANGE = (mount, exact = 'Hello') => ({ v: 1, kind: 'range', mount, quote: { exact, prefix: '', suffix: '' }, pos: { start: 0, end: exact.length } });
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const glyphPath = (id) => `/api/elements/${encodeURIComponent(id)}/glyph`;

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
async function boot(t, opts) {
  const d = await withServer(t, opts);
  await ok(d.api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello world</p>' }), 'render m1');
  return d;
}
const comment = async (who, { text = 'first words', shared = true } = {}) => (await ok(who.post('/api/elements', {
  type: 'comment', anchor: LOCATOR(), payload: { text, shared },
}), 'POST comment')).element;
async function turn(api, message = 't') {
  await ok(api.post('/api/turn-begin', { message }), 'turn-begin');
  return ok(api.post('/api/turn-end', { author: 'claude' }), 'turn-end');
}
const versionsOf = (d, id) => d.srv.elements.versionsOf(id);
const livePin = (d, id) => d.srv.state.comments.find((c) => c.id === id);

test('the grammar: display is a sibling of the log, outside both hashes; the offset is {dx, dy, corner}, the corners four', () => {
  assert.ok(SIBLINGS.includes('display'), 'element-log SIBLINGS names display');
  assert.deepEqual(GLYPH_CORNERS, ['tl', 'tr', 'bl', 'br']);
  assert.equal(glyphProblem({ dx: 12, dy: -30, corner: 'tr' }), null);
  for (const bad of [null, [], { dx: 1, dy: 2 }, { dx: '1', dy: 2, corner: 'tl' }, { dx: 1, dy: NaN, corner: 'tl' },
    { dx: GLYPH_OFFSET_MAX + 1, dy: 0, corner: 'tl' }, { dx: 1, dy: 2, corner: 'middle' }, { dx: 1, dy: 2, corner: 'tl', extra: 1 }]) {
    assert.ok(glyphProblem(bad), `refused: ${JSON.stringify(bad)}`);
  }
});

test('a comment\'s move appends one version: the same payload_hash and src_hash, a display sibling, the caller\'s writer; the live copy\'s v advances', async (t) => {
  const d = await boot(t);
  const c = await comment(d.anonApi);
  const before = versionsOf(d, c.id);
  assert.equal(before.length, 1);
  const r = await ok(d.anonApi.post(glyphPath(c.id), { dx: 24, dy: -40, corner: 'tr' }), 'move');
  assert.deepEqual(r, { ok: true, id: c.id, type: 'comment', v: 2, display: { glyph: { dx: 24, dy: -40, corner: 'tr' } } });
  const vs = versionsOf(d, c.id);
  assert.equal(vs.length, 2, 'one version appended');
  const [v1, v2] = vs;
  assert.equal(v2.parent_v, 1);
  assert.equal(v2.payload_hash, v1.payload_hash, 'payload_hash unchanged');
  assert.equal(v2.src_hash, v1.src_hash, 'src_hash unchanged');
  assert.deepEqual(v2.payload, v1.payload, 'the parent\'s payload, the anchor untouched');
  assert.deepEqual(v2.display, { glyph: { dx: 24, dy: -40, corner: 'tr' } }, 'the display sibling');
  assert.equal(v1.display ?? null, null, 'the parent carries none');
  assert.deepEqual(v2.writer, { class: 'user', owner: 'user', verified: false }, 'the caller\'s writer stamp');
  assert.deepEqual(v2.original, v1.original, 'the 0.8.5 locator kept');
  const pin = livePin(d, c.id);
  assert.equal(pin.v, 2, 'the live copy\'s v advances as an edit\'s does');
  assert.deepEqual(pin.display, { glyph: { dx: 24, dy: -40, corner: 'tr' } });
  assert.equal(pin.text, 'first words');
  assert.deepEqual(pin.writer, c.writer, 'the creator stays the pin\'s writer');
  // The same offset again appends nothing.
  const again = await ok(d.anonApi.post(glyphPath(c.id), { dx: 24, dy: -40, corner: 'tr' }), 'move again');
  assert.equal(again.unchanged, true);
  assert.equal(versionsOf(d, c.id).length, 2);
  // GET serves the display, and an edit after the move keeps the glyph where it was put.
  const read = await ok(d.anonApi.get('/api/elements?type=comment'), 'GET');
  assert.deepEqual(read.elements.find((e) => e.id === c.id).display, { glyph: { dx: 24, dy: -40, corner: 'tr' } });
  await ok(d.anonApi.patch(`/api/elements/${c.id}`, { text: 'second words' }), 'edit');
  assert.deepEqual(livePin(d, c.id).display, { glyph: { dx: 24, dy: -40, corner: 'tr' } }, 'an edit inherits the display');
  assert.equal(versionsOf(d, c.id)[2].display ?? null, null, 'the edit itself carries none');
});

// ── a plug-in type that adopts the flag (its non-comment branch) ────────────
// A pack's type installed in process through lib/packs/install's approve path,
// as test/element-routes.test.js's approvePlugin does; its element.json
// declares glyph {detach: true} and a payload. The move goes through
// moveGlyph's record() path and the route's putRef: the live reference
// advances to the move's version, so the next commit pins id@v.
const pluginPacks = require('../lib/packs/install');
const { packFixture } = require('../test-support/packs');
const PLUGIN_DRAW = "export default function draw(group) { group.container.textContent = 'x'; }\n";
function approvePlugin(d, { name, type, json = {} }) {
  const element = { type, family: 'page', remote: { see: 'read', send: 'full' }, schema: `${type}@1`, reads: [`${type}@1`], anchors: ['element', 'range'], ...json };
  const stageDir = packFixture({
    name, version: '1.0.0', components: [], skill: false,
    manifest: { name, version: '1.0.0', description: 'A fixture plug-in element type.', elements: [type] },
    extraFiles: {
      [`elements/${type}/element.json`]: JSON.stringify(element, null, 2) + '\n',
      [`elements/${type}/draw.js`]: PLUGIN_DRAW,
    },
  });
  pluginPacks.installFromStage({ stageDir, source: { via: 'test' }, tier: 'local', root: d.root, via: 'approve' });
  d.srv.elementTypes.invalidate();
}

test('a plug-in type whose element.json declares glyph {detach: true}: the move keeps payload_hash, adds a display sibling, the live reference at the new v, the next commit pinning id@v', async (t) => {
  const d = await boot(t);
  approvePlugin(d, { name: 'tq-glyph-pack', type: 'tq-mark', json: { payload: { keys: ['anchor', 'shared', 'color'] }, glyph: { detach: true } } });
  const e = (await ok(d.anonApi.post('/api/elements', { type: 'tq-mark', anchor: RANGE('m1'), payload: { color: '#c03' } }), 'POST tq-mark')).element;
  assert.equal(e.v, 1);
  assert.deepEqual(d.srv.state.elements, [`${e.id}@1`]);
  const r = await ok(d.anonApi.post(glyphPath(e.id), { dx: 18, dy: -12, corner: 'tr' }), 'move');
  assert.deepEqual(r, { ok: true, id: e.id, type: 'tq-mark', v: 2, display: { glyph: { dx: 18, dy: -12, corner: 'tr' } } });
  const [v1, v2] = versionsOf(d, e.id);
  assert.equal(v2.parent_v, 1);
  assert.equal(v2.payload_hash, v1.payload_hash, 'payload_hash unchanged');
  assert.equal(v2.src_hash, v1.src_hash, 'src_hash unchanged');
  assert.deepEqual(v2.display, { glyph: { dx: 18, dy: -12, corner: 'tr' } }, 'the display sibling');
  assert.deepEqual(v2.writer, { class: 'user', owner: 'user', verified: false }, 'the caller\'s writer stamp');
  assert.deepEqual(d.srv.state.elements, [`${e.id}@2`], 'the live reference at the move\'s version');
  await turn(d.api, 'the plug-in glyph moved');
  const node = d.srv.graph.active;
  assert.ok(node, 'a node committed');
  const pins = d.srv.elements.pinsOf(node);
  assert.ok(pins.includes(`${e.id}@2`), `the commit pins the move's version: ${pins}`);
});

test('a move is refused with a hint: a bad offset, a type that does not detach, an id nobody holds; a pane moves only what it added', async (t) => {
  const d = await boot(t);
  const c = await comment(d.anonApi);
  let r = await d.anonApi.post(glyphPath(c.id), { dx: 1, dy: 2, corner: 'middle' });
  assert.equal(r.status, 400);
  assert.match(r.json.hint, /tl, tr, bl, br/);
  r = await d.anonApi.post(glyphPath(c.id), { dx: 'far', dy: 2, corner: 'tl' });
  assert.equal(r.status, 400);
  r = await d.anonApi.post(glyphPath('c999'), { dx: 1, dy: 2, corner: 'tl' });
  assert.equal(r.status, 404);
  // A highlight's manifest declares no glyph: it stays at its anchor.
  const h = (await ok(d.anonApi.post('/api/elements', { type: 'highlight', anchor: RANGE('m1'), payload: { color: 'gold', note: 'n' } }), 'highlight')).element;
  r = await d.anonApi.post(glyphPath(h.id), { dx: 1, dy: 2, corner: 'tl' });
  assert.equal(r.status, 400);
  assert.match(r.json.hint, /"glyph": \{"detach": true\}/);
  // A pane's stamp moves only what that pane added (B4).
  r = await d.anonApi.post(glyphPath(c.id), { dx: 1, dy: 2, corner: 'tl' }, { 'X-WC-Pane': 'm1' });
  assert.equal(r.status, 403);
  // A stale base_v.
  r = await d.anonApi.post(glyphPath(c.id), { dx: 1, dy: 2, corner: 'tl', base_v: 7 });
  assert.equal(r.status, 409);
  assert.equal(versionsOf(d, c.id).length, 1, 'nothing appended by any refusal');
});

test('Mod+Z (POST /api/elements/undo) retracts a move; a glyph moved twice and undone once is at the first move\'s offset', async (t) => {
  const d = await boot(t);
  const c = await comment(d.anonApi);
  await ok(d.anonApi.post(glyphPath(c.id), { dx: 10, dy: 20, corner: 'tl' }), 'first move');
  await ok(d.anonApi.post(glyphPath(c.id), { dx: -30, dy: 5, corner: 'br' }), 'second move');
  assert.deepEqual(livePin(d, c.id).display, { glyph: { dx: -30, dy: 5, corner: 'br' } });
  const u = await ok(d.anonApi.post('/api/elements/undo', { item: 'm1' }), 'undo');
  assert.deepEqual([u.undone.id, u.undone.how, u.undone.v, u.undone.to_v], [c.id, 'reverted', 3, 2]);
  const vs = versionsOf(d, c.id);
  assert.equal(vs.length, 4);
  assert.deepEqual(vs[3].display, { glyph: { dx: 10, dy: 20, corner: 'tl' } }, 'revertElement carries toV\'s display');
  assert.equal(vs[3].payload_hash, vs[0].payload_hash, 'the payload unchanged throughout');
  assert.deepEqual(livePin(d, c.id).display, { glyph: { dx: 10, dy: 20, corner: 'tl' } }, 'the live copy at the first move\'s offset');
  assert.equal(livePin(d, c.id).v, 4);
  // Undo again (U518's rule: the caller's newest live version, v4, back to its
  // parent v3's): the second move's offset; then the first move undone from a
  // fresh comment goes back to attached.
  const c2 = await comment(d.anonApi, { text: 'another' });
  await ok(d.anonApi.post(glyphPath(c2.id), { dx: 3, dy: 4, corner: 'bl' }), 'move c2');
  const u2 = await ok(d.anonApi.post('/api/elements/undo', { item: 'm1' }), 'undo c2');
  assert.equal(u2.undone.id, c2.id);
  const vs2 = versionsOf(d, c2.id);
  assert.deepEqual(vs2[2].display, { glyph: null }, 'reverting to an attached version writes the reset');
  assert.equal(livePin(d, c2.id).display, undefined, 'the pin is attached again: no display served');
});

test('a committed node keeps the placement by id@v; a later move is the live surface\'s, the node read unchanged', async (t) => {
  const d = await boot(t);
  const c = await comment(d.anonApi);
  await turn(d.api, 'the comment');
  await ok(d.anonApi.post(glyphPath(c.id), { dx: 40, dy: 8, corner: 'tl' }), 'move');
  const done = await turn(d.api, 'the move commits a node');
  const node = d.srv.graph.active;
  assert.ok(node && done.ok !== false, 'a node committed when the glyph moved');
  const pins = d.srv.elements.pinsOf(node);
  assert.ok(pins.includes(`${c.id}@2`), `the commit record pins the move's version: ${pins}`);
  const nodeFile = JSON.parse(fs.readFileSync(path.join(projectPaths(d.root).graphDir, `${node}.json`), 'utf8'));
  const copy = nodeFile.comments.find((x) => x.id === c.id);
  assert.deepEqual(copy.display, { glyph: { dx: 40, dy: 8, corner: 'tl' } }, 'the node\'s copy carries it');
  await ok(d.anonApi.post(glyphPath(c.id), { dx: 90, dy: 90, corner: 'br' }), 'a later move');
  const read = await ok(d.anonApi.get(`/api/elements?type=comment&node=${node}`), 'node read');
  const rec = read.elements.find((e) => e.id === c.id);
  assert.equal(rec.node_v, 2);
  assert.deepEqual(rec.display, { glyph: { dx: 40, dy: 8, corner: 'tl' } }, 'the node draws the placement as it was');
});

test('a private element\'s move answers nothing to a reader that does not see private records; a local browser moves it', async (t) => {
  const root = tmpRoot('wc-glyph-priv-');
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, {
    hostname: 'wc.example.test', style: 'flat',
    access: { team: 'testteam', aud: 'test-aud-0123456789' }, allow: { emails: ['me@example.com'], domains: [] },
    remote: { mirror: { [path.resolve(root)]: 'full' } },
  });
  const d = await boot(t, { root, seed });
  const c = await comment(d.anonApi, { shared: false });
  const r = await d.anonApi.post(glyphPath(c.id), { dx: 1, dy: 2, corner: 'tl' }, REMOTE);
  assert.equal(r.status, 404, `a remote viewer: ${r.status} ${r.text}`);
  assert.deepEqual(r.json, { error: 'not found', id: c.id }, 'the GET\'s answer: nothing about it');
  assert.equal(versionsOf(d, c.id).length, 1, 'nothing appended');
  const mine = await ok(d.anonApi.post(glyphPath(c.id), { dx: 1, dy: 2, corner: 'tl' }), 'the local browser');
  assert.equal(mine.v, 2);
});

test('the boot reconcile reads a moved, committed comment clean', async (t) => {
  const first = await boot(t);
  const c = await comment(first.anonApi);
  await ok(first.anonApi.post(glyphPath(c.id), { dx: 12, dy: 14, corner: 'bl' }), 'move');
  await turn(first.api, 'commit the move');
  await first.graceful();
  const second = await withServer(t, { root: first.root });
  const report = JSON.parse(fs.readFileSync(projectPaths(first.root).elementsBootReport, 'utf8'));
  assert.equal(report.clean, true, JSON.stringify(report.states));
  const pin = second.srv.state.comments.find((x) => x.id === c.id);
  assert.ok(pin, 'the pin restored');
  assert.equal(pin.v, 2);
  assert.deepEqual(pin.display, { glyph: { dx: 12, dy: 14, corner: 'bl' } }, 'restored at its offset');
  // The graph index is written on the first immediate after the listen: let
  // it land before the roots are removed.
  await new Promise((resolve) => setImmediate(resolve));
});

test('the log on disk: the move\'s line carries display, and its hashes are the parent\'s', async (t) => {
  const d = await boot(t);
  const c = await comment(d.anonApi);
  await ok(d.anonApi.post(glyphPath(c.id), { dx: 5.26, dy: -7.74, corner: 'tl' }), 'move');
  const lines = fs.readFileSync(projectPaths(d.root).elementsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const vers = lines.filter((l) => l.t === 'ver' && l.id === c.id);
  assert.equal(vers.length, 2);
  assert.deepEqual(vers[1].display, { glyph: { dx: 5.5, dy: -7.5, corner: 'tl' } }, 'stored rounded to the half px');
  assert.equal(vers[1].payload_hash, stableHash(vers[1].payload));
  assert.equal(vers[1].payload_hash, vers[0].payload_hash);
  // A reopened log reads it back.
  const copy = path.join(d.root, 'log-copy.jsonl');
  fs.copyFileSync(projectPaths(d.root).elementsLog, copy);
  const log = createElementLog({ file: copy, dryRun: true, redactor: createRedactor() });
  try {
    log.load();
    assert.deepEqual(log.version(c.id, 2).display, { glyph: { dx: 5.5, dy: -7.5, corner: 'tl' } });
    assert.deepEqual(log.maskView(log.version(c.id, 2)).display, { glyph: { dx: 5.5, dy: -7.5, corner: 'tl' } }, 'maskView copies it');
  } finally { try { log.close(); } catch {} }
});
