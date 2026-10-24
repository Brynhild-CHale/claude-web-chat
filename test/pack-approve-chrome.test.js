// The element pack's Approve on its quarantine card (annotation engine tranche
// 2, U322a; DECISIONS.md K.4: H3 a, I3 b, readings (i) and (iii)), in the real
// chrome (test-support/chrome-shell).
//
// A pack that ships an element type is approved by a person, never by the
// page's realm: its card mounts the 'pack-approve' confirm frame (a document of
// the answer origin, lib/server/control/pack-approve.js) where a component
// pack's card has its 'Install it' button; when the frame cannot be shown
// (mayAct() false: a viewer below full) the card names the terminal command.
// 'Install now' on such a pack lands as its card. The daemon half runs in
// before(), against a real createServer BEFORE the shell replaces fetch and the
// timers (test/elements-e2e-chrome.test.js's pattern): the quarantine list it
// serves, its answer to a page-realm fetch of the approve route (the 409), the
// frames the control's approve (the frame's click) broadcasts, and the
// toolbar's listing after it (U337, GET /api/toolbar) — which the shell then
// serves the chrome.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');

const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { withServer, waitUntil } = require('../test-support/helpers');
const { packFixture, tmpDir, fakeForge, repoWithArchive } = require('../test-support/packs');

const PORT = 4568;
const SHA = 'a'.repeat(40);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>\n';
const DRAW = "export default function draw(el, ctx) { ctx.box(el).textContent = 'sticky'; }\n";
const ELEMENT_REFUSAL = '"mark-pack" ships element type (sticky). An element type\'s draw.js runs in the surface page\'s own realm, so a pack that ships one installs only after a review — nothing was installed.\n  claude-web-chat pack get https://example.test/acme/marks, then claude-web-chat pack review mark-pack and claude-web-chat pack approve mark-pack — or ＋ → Manage → Download for review';

const ELEMENT_Q = {
  name: 'mark-pack', version: '1.0.0', tier: 'local', description: 'Sticky notes on the surface.',
  source: { url: 'https://example.test/acme/marks', via: 'tarball', sha: SHA },
  components: [], themes: [], services: [], skill: null, collisions: [], errors: [], warnings: [],
  elements: [{ name: 'sticky', schema: 'sticky@1', reads: ['sticky@1'], anchors: ['element', 'range'], draw: 'draw.js', files: ['element.json', 'draw.js'] }],
};
const COMPONENT_Q = {
  name: 'acme-ops', version: '1.2.0', tier: 'local', description: 'Ops.',
  source: { url: 'https://example.test/acme/ops', via: 'tarball', sha: SHA },
  components: [{ name: 'deploy-board', description: '', has_service: false, has_seed: false }],
  themes: [], services: [], skill: null, collisions: [], errors: [], warnings: [],
};

let shell, doc, $, drawer, S, TS;
let rev = 100;
let access = { level: 'local', remote: false };
let packsBody = { ok: true, packs: [], quarantined: [ELEMENT_Q, COMPONENT_Q], pending: [] };

const snapshot = () => ({
  v: 1, enabled: true, now: Date.now(), rev: ++rev, content: true, access, capabilities: {},
  primary: null, aggregate: { state: 'idle' }, conversations: [], tasks: [], asks: [],
});

function elementPack() {
  const body = { type: 'sticky', family: 'page', remote: { see: 'read', send: 'full' }, schema: 'sticky@1', reads: ['sticky@1'], anchors: ['element', 'range'] };
  return packFixture({
    name: 'mark-pack', version: '1.0.0', components: [], skill: false,
    manifest: { name: 'mark-pack', version: '1.0.0', description: 'Sticky notes on the surface.', elements: ['sticky'] },
    extraFiles: {
      'elements/sticky/element.json': JSON.stringify(body, null, 2) + '\n',
      'elements/sticky/draw.js': DRAW,
      'elements/sticky/assets/icon.svg': SVG,
    },
  });
}

// What the daemon served, by name.
const served = {};

// withServer and the fake forge with an owner of their own: a before() hook
// has no test context, so the teardowns are collected and run, last first, as
// soon as the daemon's answers are in.
async function fromDaemon() {
  const cleanups = [];
  const owner = { after: (fn) => { cleanups.push(fn); } };
  try {
    const ctx = await withServer(owner, { root: tmpDir('wc-pa-chrome-') });
    const { srv, api, baseUrl } = ctx;
    const forge = await fakeForge(owner, { repos: { 'acme/marks': repoWithArchive(elementPack(), { sha: SHA }) } });
    const q = await api.post('/api/packs/quarantine', { url: forge.url('acme', 'marks') });
    assert.equal(q.json.ok, true, q.text);
    served.packsBefore = (await api.get('/api/packs')).json;
    served.toolbarBefore = (await api.get('/api/toolbar')).json;
    // A pane script's fetch: Node's fetch, from no tab, carrying no token.
    const r = await fetch(`${baseUrl}/api/packs/quarantine/mark-pack/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    served.paneApprove = { status: r.status, body: await r.json() };
    // The frame's click: the control row, through the one pipeline, while a
    // socket listens for what the daemon broadcasts.
    const sock = ctx.ws();
    const got = [];
    sock.on('message', (d) => { try { got.push(JSON.parse(d.toString())); } catch { /* not JSON */ } });
    await new Promise((resolve, reject) => { sock.once('open', resolve); sock.once('error', reject); });
    await waitUntil(() => got.some((m) => m.type === 'hello'), { timeout: 3000, what: 'the hello' });
    await srv.controlStarted;
    served.approve = await srv.control.invoke('pack-approve', { name: 'mark-pack', tier: 'local' }, { remote: false });
    await waitUntil(() => got.some((m) => m.type === 'components'), { timeout: 3000, what: 'the components frame' });
    sock.close();
    served.frames = got.filter((m) => m.type === 'packs:changed' || m.type === 'components');
    served.packsAfter = (await api.get('/api/packs')).json;
    served.toolbarAfter = (await api.get('/api/toolbar')).json;
  } finally {
    for (const fn of cleanups.reverse()) await fn();
  }
}

before(async () => {
  await fromDaemon();
  shell = await bootShell({
    routes: {
      '/api/mirror': () => snapshot(),
      '/api/asks': () => ({ asks: [], answer: { port: PORT } }),
      '/api/packs': () => packsBody,
    },
  });
  doc = shell.document;
  $ = shell.$;
  drawer = await shell.importApp('drawer.js');
  S = await shell.importApp('chat-state.js');
  TS = await shell.importApp('toolbar-state.js');
});

after(() => shell.restore());

// A fresh mirror snapshot with `a` as the viewer's access.
async function setAccess(a) {
  access = a;
  const want = rev + 1;
  await shell.frame(helloFrame());
  await waitUntil(() => S.mirror.rev >= want && (S.mirror.access || {}).level === a.level, { timeout: 3000, what: 'the snapshot' });
  await shell.tick();
}

const cardOf = (name) => [...doc.querySelectorAll('#drawer-manage .pk-card.pk-quarantined')]
  .find((c) => c.querySelector('.pk-name').textContent === name) || null;
const buttonsOf = (card) => [...card.querySelectorAll('.pk-actions button')].map((b) => b.textContent);

async function openManage() {
  drawer.closeDrawer();
  await drawer.openDrawerManage();
  await waitUntil(() => cardOf('mark-pack') || cardOf('acme-ops'), { timeout: 3000, what: 'the quarantine cards' });
  await shell.tick();
}

test('the element pack\'s card mounts the pack-approve confirm frame in its actions; the component pack\'s keeps Install it', async () => {
  await setAccess({ level: 'local', remote: false });
  await openManage();
  const el = cardOf('mark-pack');
  const frames = [...el.querySelectorAll('.pk-actions iframe.wc-answer-frame')];
  assert.equal(frames.length, 1, 'one confirm frame');
  const u = new URL(frames[0].src);
  assert.equal(u.port, String(PORT), 'on the answer origin');
  assert.deepEqual([u.pathname, u.searchParams.get('name'), u.searchParams.get('tier'), u.searchParams.get('layout')],
    ['/answer/control/pack-approve', 'mark-pack', 'local', 'confirm']);
  assert.ok(!buttonsOf(el).includes('Install it'), 'no Install it button in the page\'s realm');
  assert.ok(!/claude-web-chat pack approve/.test(el.textContent), 'no fallback while the frame is up');

  const comp = cardOf('acme-ops');
  assert.ok(buttonsOf(comp).includes('Install it'));
  assert.equal(comp.querySelector('iframe'), null);
});

test('with mayAct() false the element card shows the terminal command instead of a frame', async () => {
  await setAccess({ level: 'read', remote: true });
  await openManage();
  const el = cardOf('mark-pack');
  assert.equal(el.querySelector('iframe'), null);
  const cmd = [...el.querySelectorAll('.rn-cmd')].map((c) => c.textContent);
  assert.deepEqual(cmd, ['claude-web-chat pack approve mark-pack']);
  assert.match(el.textContent, /It ships element type \(sticky\) whose drawing code runs in this page/);
  assert.ok(!buttonsOf(el).includes('Install it'));
  await setAccess({ level: 'local', remote: false });
});

test('Install now on a pack that ships an element type lands as its card: downloaded for review, nothing installed', async () => {
  packsBody = { ok: true, packs: [], quarantined: [COMPONENT_Q], pending: [] };
  const url = 'https://example.test/acme/marks';
  shell.setRoutes({
    '/api/packs/install': { ok: false, rejected: true, hint: ELEMENT_REFUSAL, errors: [ELEMENT_REFUSAL] },
    '/api/packs/quarantine': () => {
      packsBody = { ok: true, packs: [], quarantined: [ELEMENT_Q, COMPONENT_Q], pending: [] };
      return { ok: true, record: { name: 'mark-pack' } };
    },
  });
  try {
    await openManage();
    $('pk-url').value = url;
    const now = doc.querySelector('#drawer-manage .pk-now');
    now.click();          // armed: a URL never reviewed takes two clicks
    now.click();
    await waitUntil(() => cardOf('mark-pack'), { timeout: 3000, what: 'the landed card' });
    const q = shell.calls.filter((c) => c.url === '/api/packs/quarantine' && c.method === 'POST');
    assert.equal(q.length, 1);
    assert.deepEqual(q[0].body, { url, global: false });
    assert.equal(shell.calls.filter((c) => c.url.endsWith('/approve')).length, 0, 'the page approves nothing');
    await waitUntil(() => /read its card below and approve it there/.test(doc.querySelector('#drawer-manage .pk-status').textContent), { timeout: 3000, what: 'the status line' });
    assert.equal(cardOf('mark-pack').querySelectorAll('iframe.wc-answer-frame').length, 1, 'with its Approve frame');
    assert.equal($('pk-url').value, '');
  } finally {
    shell.setRoutes();
  }
});

test('Install now lands the card on the refusal\'s code alone, whatever its words (K.2-86)', async () => {
  packsBody = { ok: true, packs: [], quarantined: [COMPONENT_Q], pending: [] };
  const url = 'https://example.test/acme/marks';
  const hint = 'mark-pack needs a review before it installs';
  shell.setRoutes({
    '/api/packs/install': { ok: false, rejected: true, code: 'element-review', hint, errors: [hint] },
    '/api/packs/quarantine': () => {
      packsBody = { ok: true, packs: [], quarantined: [ELEMENT_Q, COMPONENT_Q], pending: [] };
      return { ok: true, record: { name: 'mark-pack' } };
    },
  });
  try {
    await openManage();
    const ELEMENT_REVIEW = /ships element types? \([^)]*\)\. An element type's draw\.js runs in the surface page's own realm, so a pack that ships one installs only after a review/;
    assert.doesNotMatch(hint, ELEMENT_REVIEW, 'the words alone would not land it');
    const before = shell.calls.filter((c) => c.url === '/api/packs/quarantine' && c.method === 'POST').length;
    $('pk-url').value = url;
    const now = doc.querySelector('#drawer-manage .pk-now');
    now.click();          // armed: a URL never reviewed takes two clicks
    now.click();
    await waitUntil(() => cardOf('mark-pack'), { timeout: 3000, what: 'the landed card' });
    const q = shell.calls.filter((c) => c.url === '/api/packs/quarantine' && c.method === 'POST');
    assert.equal(q.length, before + 1);
    assert.deepEqual(q[q.length - 1].body, { url, global: false });
    await waitUntil(() => /read its card below and approve it there/.test(doc.querySelector('#drawer-manage .pk-status').textContent), { timeout: 3000, what: 'the status line' });
    assert.equal($('pk-url').value, '');
  } finally {
    shell.setRoutes();
  }
});

test('the daemon\'s own answers: its card carries the frame, a pane\'s fetch of the approve route gets 409, and the control\'s approve lists the type on the toolbar', async () => {
  assert.equal(served.approve.ok, true, JSON.stringify(served.approve));
  packsBody = served.packsBefore;
  shell.setRoutes({
    '/api/toolbar': () => served.toolbar,
    '/api/packs/quarantine/mark-pack/approve': () => respond(served.paneApprove.body, { status: served.paneApprove.status }),
  });
  served.toolbar = served.toolbarBefore;
  try {
    await openManage();
    assert.equal(cardOf('mark-pack').querySelectorAll('iframe.wc-answer-frame').length, 1, 'the daemon\'s record mounts the frame');
    // A pane script's fetch, from the page's own realm.
    const r = await shell.window.fetch('/api/packs/quarantine/mark-pack/approve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, 'element-approve');
    assert.ok(!TS.toolbarState().tools.some((x) => x.type === 'sticky'), 'not listed: nothing installed');
    // The daemon's frames after the control's approve, then its listing.
    packsBody = served.packsAfter;
    served.toolbar = served.toolbarAfter;
    assert.deepEqual(served.frames.map((m) => m.type), ['packs:changed', 'components']);
    for (const m of served.frames) await shell.frame(m);
    await waitUntil(() => TS.toolbarState().tools.some((x) => x.type === 'sticky'), { timeout: 3000, what: 'the toolbar listing' });
    const tool = TS.toolbarState().tools.find((x) => x.type === 'sticky');
    assert.deepEqual([tool.pack.name, tool.builtin], ['mark-pack', false]);
    await waitUntil(() => !cardOf('mark-pack'), { timeout: 3000, what: 'the card gone from AWAITING REVIEW' });
  } finally {
    shell.setRoutes();
  }
});
