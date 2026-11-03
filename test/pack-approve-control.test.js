// An element pack's approve, by a person (annotation engine tranche 2, U322a;
// DECISIONS.md K.4: H3 a, I3 b with the maintainer's note, readings (i)-(iv)).
//
// An element type's draw.js runs in the surface page's own realm, so a pack
// that ships one installs only after a person approved it, and no pane can do
// that for them. The main origin's approve route is reachable by any pane's
// fetch, so it refuses such a pack (409 'element-approve'); the card's Approve
// is the control domain's 'pack-approve' row, a confirm frame on the answer
// origin whose nonce a pane can neither read nor forge (lib/server/control/
// pack-approve.js). These drive the row through the real answer surface (the
// document, its nonce, the POST control-confirm.js sends) and through
// control.invoke, over the fixture U322's consent tests use.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { packFixture, fakeForge, repoWithArchive, tmpDir } = require('../test-support/packs');
const { withServer, waitUntil } = require('../test-support/helpers');
const { projectPaths, userPaths } = require('../lib/core/paths');
const { readAudit, findPack } = require('../lib/packs/store');
const { request } = require('../lib/client');
const { HINTS } = require('../lib/server/control/pack-approve');

const SHA = 'a'.repeat(40);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>\n';
const DRAW = "export default function draw(el, ctx) { ctx.box(el).textContent = 'sticky'; }\n";

function elementFiles(type) {
  const body = { type, family: 'page', remote: { see: 'read', send: 'full' }, schema: `${type}@1`, reads: [`${type}@1`], anchors: ['element', 'range'] };
  return {
    [`elements/${type}/element.json`]: JSON.stringify(body, null, 2) + '\n',
    [`elements/${type}/draw.js`]: DRAW,
    [`elements/${type}/assets/icon.svg`]: SVG,
  };
}

// The consent tests' element pack: types, optionally a component beside them.
function elementPack({ name = 'mark-pack', types = ['sticky'], components = [] } = {}) {
  let extraFiles = {};
  for (const t of types) extraFiles = { ...extraFiles, ...elementFiles(t) };
  return packFixture({
    name, version: '1.0.0', components, skill: false,
    manifest: {
      name, version: '1.0.0', description: 'Sticky notes on the surface.',
      ...(components.length ? { components: components.map((c) => c.name) } : {}),
      elements: types,
    },
    extraFiles,
  });
}

let CONFIRM = null;
test.before(async () => {
  CONFIRM = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'server', 'answer-surface', 'public', 'control-confirm.js')).href);
});

// The frame's protocol has one test copy (U565; ruling
// U511-U565@approveElementPack-twice a): test-support/element-type-fixture.js
// approveFromFrame — the confirm document for pack-approve with `query`, then
// the POST of bodyOf(query), exactly what control-confirm.js sends — and its
// readers of the document's nonce and review.
const { approveFromFrame, frameNonce: nonceOf, frameReview: descOf } = require('../test-support/element-type-fixture');
const confirmThrough = (srv, query) => approveFromFrame(srv, { query });

const controlAudit = (root) => {
  try {
    return fs.readFileSync(projectPaths(root).controlAudit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};
const stickyDir = (root) => path.join(projectPaths(root).elementTypesDir, 'sticky');

// Every WS frame the daemon broadcasts while `fn` runs.
async function framesDuring(ctx, fn) {
  const sock = ctx.ws();
  const got = [];
  sock.on('message', (d) => { try { got.push(JSON.parse(d.toString())); } catch { /* not JSON */ } });
  await new Promise((resolve, reject) => { sock.once('open', resolve); sock.once('error', reject); });
  await waitUntil(() => got.some((m) => m.type === 'hello'), { timeout: 3000, what: 'the hello' });
  try { await fn(); } finally { /* closed below, after the frames land */ }
  return { got, close: () => sock.close() };
}

test('the confirm frame shows the review, its nonce installs the pack, the packs change goes out, and both audits record it', async (t) => {
  await withServer(t, async (ctx) => {
    const { srv, api, root } = ctx;
    const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack({ types: ['sticky', 'flag'], components: [{ name: 'sticky-board' }] }), { sha: SHA }) } });
    const url = forge.url('acme', 'marks');
    let r = await api.post('/api/packs/quarantine', { url });
    assert.equal(r.json.ok, true, r.text);

    let out;
    const w = await framesDuring(ctx, async () => { out = await confirmThrough(srv, 'name=mark-pack&tier=local'); });
    // describe(): the review the person reads, as text.
    assert.equal(out.doc.status, 200);
    assert.equal(out.desc.title, 'Approve and install');
    assert.match(out.desc.summary, /^Install the pack "mark-pack" 1\.0\.0 for this project\? It ships element types whose draw\.js runs in the surface page/);
    assert.ok(out.desc.lines.includes(`From ${url} @ ${SHA.slice(0, 7)}`), JSON.stringify(out.desc.lines));
    assert.ok(out.desc.lines.includes('Its description says: “Sticky notes on the surface.”'));
    assert.ok(out.desc.lines.includes('Element type sticky — schema sticky@1 · anchors element, range · draw.js runs in the surface page'), JSON.stringify(out.desc.lines));
    assert.ok(out.desc.lines.some((l) => l.startsWith('Element type flag — ')));
    assert.ok(out.desc.lines.includes('Component sticky-board'));
    assert.ok(out.desc.lines.includes('Every file: claude-web-chat pack review mark-pack'));
    // run(): installed, through the frame's own POST.
    assert.deepEqual(out.body, { name: 'mark-pack', tier: 'local' }, 'the row\'s fields are exactly the document\'s target params');
    assert.equal(out.res.status, 200, JSON.stringify(out.res.body));
    assert.deepEqual(out.res.body, { ok: true, said: 'Installed mark-pack: sticky, flag' });
    assert.equal(fs.readFileSync(path.join(stickyDir(root), 'draw.js'), 'utf8'), DRAW);
    assert.deepEqual(findPack(root, 'mark-pack', 'local').pack.elements, ['sticky', 'flag']);
    // The packs change, as the route announces it: the event (which the type
    // registry invalidates on) and the packs:changed + components frames.
    await waitUntil(() => w.got.some((m) => m.type === 'components'), { timeout: 3000, what: 'the components frame' });
    w.close();
    assert.ok(w.got.some((m) => m.type === 'packs:changed' && m.op === 'approve' && m.pack === 'mark-pack' && m.tier === 'local'), JSON.stringify(w.got.map((m) => m.type)));
    assert.ok(srv.bus.read({ kinds: ['packs'] }).events.some((e) => e.op === 'approve' && e.pack === 'mark-pack'));
    assert.equal(srv.elementTypes.listed('sticky'), true, 'listed on the next read');
    // The pack audit says who: the control. The control audit: ids only.
    const last = readAudit(root).at(-1);
    assert.deepEqual([last.op, last.actor, last.pack], ['approve', 'control', 'mark-pack']);
    const line = controlAudit(root).at(-1);
    assert.deepEqual({ action: line.action, target: line.target, outcome: line.outcome, origin: line.origin },
      { action: 'pack-approve', target: { name: 'mark-pack', tier: 'local' }, outcome: 'accepted', origin: 'local' });
    // Quarantine is emptied: a second approve has nothing to approve.
    r = await api.get('/api/packs');
    assert.deepEqual(r.json.quarantined, []);
  });
});

// The frame's nonce binds what was staged, not only the name: a pane may
// re-stage the same name from another URL after the person's frame was drawn
// (POST /api/packs/quarantine answers any pane's fetch), and the person's click
// must not then install a tree they never read (DECISIONS.md K.4 H3 a).
test('a re-stage of the name after the frame was drawn fails the click\'s nonce: neither tree installs, the new one stays quarantined', async (t) => {
  await withServer(t, { root: tmpDir('wc-pa-restage-') }, async ({ srv, api, anonApi, root }) => {
    const forge = await fakeForge(t, { repos: {
      'acme/marks': repoWithArchive(elementPack(), { sha: SHA }),
      'evil/marks': repoWithArchive(elementPack({ types: ['evil'] }), { sha: 'b'.repeat(40) }),
    } });
    assert.equal((await api.post('/api/packs/quarantine', { url: forge.url('acme', 'marks') })).json.ok, true);

    // The person's frame: the document for A, its nonce and review.
    await srv.controlStarted;
    const { origin, port } = await srv.answerSurface.ensure();
    const qs = 'name=mark-pack&tier=local&layout=confirm&mode=light';
    const doc = await request(port, 'GET', `/answer/control/pack-approve?${qs}`);
    assert.equal(doc.status, 200);
    assert.ok(descOf(doc.body).lines.some((l) => l.startsWith('Element type sticky — ')), 'the person read A');

    // A pane re-stages the same name from another URL.
    const r = await anonApi.post('/api/packs/quarantine', { url: forge.url('evil', 'marks') });
    assert.equal(r.json.ok, true, r.text);

    // The person's click, with A's nonce.
    const res = await request(port, 'POST', '/answer/api/control/pack-approve?device=desktop',
      CONFIRM.bodyOf(Object.fromEntries(new URLSearchParams(qs))),
      { headers: { origin, 'sec-fetch-site': 'same-origin', 'x-wc-answer': nonceOf(doc.body) } });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: false, refused: 'nonce' }, 'the nonce was minted for the tree the person read');
    const typesDir = projectPaths(root).elementTypesDir;
    assert.equal(fs.existsSync(path.join(typesDir, 'evil')), false, 'B is not installed');
    assert.equal(fs.existsSync(path.join(typesDir, 'sticky')), false, 'nor A');
    assert.equal(findPack(root, 'mark-pack', 'local'), null);
    const waiting = (await api.get('/api/packs')).json.quarantined;
    assert.deepEqual(waiting.map((q) => [q.name, (q.elements || []).map((e) => e.name)]), [['mark-pack', ['evil']]], 'B still in quarantine');
  });
});

// One quarantine per server below: a second quarantine in one project whose
// root is reached through a symlink (macOS $TMPDIR) is refused by
// stageQuarantine's isInside fence — a pre-existing bug in lib/packs/tree.js,
// outside this unit's cell (see U322a's hand-off).
test('check(): nothing quarantined, and a user-tier approve by a viewer that is not the host, are refused with the command; the host may', async (t) => {
  await withServer(t, async ({ srv, api, root }) => {
    await srv.controlStarted;
    const invoke = (target, reqCtx = { remote: false }) => srv.control.invoke('pack-approve', target, reqCtx);
    const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack(), { sha: SHA }) } });

    let a = await invoke({ name: 'nope', tier: 'local' });
    assert.deepEqual(a, { ok: false, refused: 'not-quarantined', hint: HINTS['not-quarantined']('nope') });

    const q = await api.post('/api/packs/quarantine', { url: forge.url('acme', 'marks'), global: true });
    assert.equal(q.json.ok, true, q.text);
    a = await invoke({ name: 'mark-pack', tier: 'system' }, { remote: true });
    assert.equal(a.refused, 'host-only');
    assert.equal(a.hint, HINTS['host-only']('mark-pack'));
    assert.match(a.hint, /claude-web-chat pack approve mark-pack/);
    assert.equal(fs.existsSync(path.join(userPaths().elementTypesDir, 'sticky')), false, 'nothing in the user tier');
    assert.deepEqual(controlAudit(root).slice(-2).map((l) => [l.action, l.outcome, l.origin]), [
      ['pack-approve', 'refused:not-quarantined', 'local'],
      ['pack-approve', 'refused:host-only', 'remote'],
    ]);
    // The host may: the user tier gets the type.
    a = await invoke({ name: 'mark-pack', tier: 'system' });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.ok(fs.existsSync(path.join(userPaths().elementTypesDir, 'sticky', 'draw.js')));
  });
});

test('check(): a pack with no element type is refused — a component pack keeps its own route and card', async (t) => {
  await withServer(t, async ({ srv, api, root }) => {
    await srv.controlStarted;
    const forge = await fakeForge(t, { repos: { 'acme/ops': repoWithArchive(packFixture({ components: [{ name: 'deploy-board' }] }), { sha: SHA }) } });
    const q = await api.post('/api/packs/quarantine', { url: forge.url('acme', 'ops') });
    assert.equal(q.json.ok, true, q.text);
    const a = await srv.control.invoke('pack-approve', { name: 'acme-ops', tier: 'local' }, { remote: false });
    assert.equal(a.refused, 'no-element-types');
    assert.equal(a.hint, '"acme-ops" ships no element type: install it with Install it on its card, or claude-web-chat pack approve acme-ops');
    assert.equal(findPack(root, 'acme-ops', 'local'), null, 'nothing installed');
    assert.equal(controlAudit(root).at(-1).outcome, 'refused:no-element-types');
  });
});

test('a remote viewer at full approves for this project; the document refuses a bad target', async (t) => {
  await withServer(t, async ({ srv, api, root }) => {
    await srv.controlStarted;
    const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack(), { sha: SHA }) } });
    assert.equal((await api.post('/api/packs/quarantine', { url: forge.url('acme', 'marks') })).json.ok, true);
    for (const q of ['name=..%2Fx&tier=local', 'name=mark-pack&tier=everywhere', 'name=mark-pack&tier=constructor', 'name=mark-pack']) {
      const { doc } = await confirmThrough(srv, q);
      assert.equal(doc.status, 400, q);
    }
    const a = await srv.control.invoke('pack-approve', { name: 'mark-pack', tier: 'local' }, { remote: true });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.ok(fs.existsSync(path.join(stickyDir(root), 'draw.js')));
    assert.equal(controlAudit(root).at(-1).origin, 'remote');
  });
});

test('POST /api/packs/quarantine/:name/approve: 409 element-approve for an element pack, from a pane\'s fetch too, and nothing lands', async (t) => {
  await withServer(t, async ({ api, anonApi, root }) => {
    const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack({ components: [{ name: 'sticky-board' }] }), { sha: SHA }) } });
    const q = await api.post('/api/packs/quarantine', { url: forge.url('acme', 'marks') });
    assert.equal(q.json.ok, true, q.text);
    for (const client of [api, anonApi]) {
      const r = await client.post('/api/packs/quarantine/mark-pack/approve', {});
      assert.equal(r.status, 409);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.code, 'element-approve');
      assert.deepEqual(r.json.element_types, ['sticky']);
      assert.match(r.json.hint, /Approve and install on its card in ＋ → Manage/);
      assert.match(r.json.hint, /claude-web-chat pack approve mark-pack/);
    }
    assert.equal(fs.existsSync(stickyDir(root)), false, 'nothing installed');
    assert.equal(findPack(root, 'mark-pack', 'local'), null, 'the component beside it does not land either');
    assert.ok(!readAudit(root).some((e) => e.op === 'approve'), 'refused before the transaction');
    assert.equal((await api.get('/api/packs')).json.quarantined[0].name, 'mark-pack', 'still waiting on its card');
  });
});

test('POST /api/packs/quarantine/:name/approve: a component pack is approved exactly as before', async (t) => {
  await withServer(t, async ({ api, root }) => {
    const forge = await fakeForge(t, { repos: { 'acme/ops': repoWithArchive(packFixture({ components: [{ name: 'deploy-board' }] }), { sha: SHA }) } });
    const q = await api.post('/api/packs/quarantine', { url: forge.url('acme', 'ops') });
    assert.equal(q.json.ok, true, q.text);
    const r = await api.post('/api/packs/quarantine/acme-ops/approve', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true, r.text);
    assert.equal(r.json.pack.name, 'acme-ops');
    assert.deepEqual([readAudit(root).at(-1).op, readAudit(root).at(-1).actor], ['approve', 'http']);
  });
});

test('the drawer reads the install route\'s element refusal by the words the daemon answers', async (t) => {
  await withServer(t, async ({ api }) => {
    const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack(), { sha: SHA }) } });
    const r = await api.post('/api/packs/install', { url: forge.url('acme', 'marks') });
    assert.equal(r.json.ok, false);
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'drawer.js'), 'utf8');
    const m = /const ELEMENT_REVIEW = (\/.*\/);\n/.exec(src);
    assert.ok(m, 'drawer.js declares ELEMENT_REVIEW');
    // eslint-disable-next-line no-new-func
    const re = new Function(`return ${m[1]};`)();
    assert.match(r.json.hint, re, 'the drawer would land this refusal as a quarantine card');
  });
});
