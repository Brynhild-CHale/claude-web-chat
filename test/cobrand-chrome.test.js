// The browser tab's title (public/app/project.js), through the real shell
// (test-support/chrome-shell.js): design spec §9.4, and the maintainer's N1
// ruling. The tab title is the project's name and nothing else: never
// " — web-chat", never a step or a state. Before the identity is known it is
// the hello's folder name; a reconnect's hello never puts the folder name back
// over a renamed project; a `project` frame renames it.
//
// main.js does not start project.js yet (the tranche's integration unit wires
// it), so the boot's init does, as main.js will.
const test = require('node:test');
const { before, beforeEach, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const FOLDER = 'acme-web';
// The project's identity as the daemon sends it (lib/core/project-identity).
const identity = (over = {}) => ({
  name: 'Acme Web', default_name: FOLDER, custom: true, show_name: true,
  logo: null, logo_dark: null, favicon: null, favicon_dark: null, touch: null,
  mark: null, mark_dark: false, ...over,
});

// What GET /api/project answers: the current identity, unless a test holds the
// answer back to look at the moment before it lands.
let serverIdentity = identity();
let projectRoute = () => serverIdentity;
function hold() {
  let release;
  const answer = new Promise((r) => { release = r; });
  projectRoute = () => answer;
  return (body) => { projectRoute = () => serverIdentity; release(body); };
}

let shell, bus, project;
let W, doc, $;
const projectFrame = (id) => shell.frame({ type: 'project', identity: id });

before(async () => {
  shell = await bootShell({
    routes: { '/api/project': () => projectRoute() },
    init: async (sh) => {
      const ws = await sh.importApp('ws.js');
      const { initProject } = await sh.importApp('project.js');
      initProject({ onFrame: ws.onFrame, onHello: ws.onHello });
    },
  });
  ({ bus } = await shell.importApp('bus.js'));
  project = await shell.importApp('project.js');
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
});

after(() => shell.restore());

beforeEach(() => {
  shell.setRoutes();
  shell.calls.length = 0;
});

/* ── the tab title ─────────────────────────────────────────────────────────── */

test('before the daemon has said anything, the tab reads web-chat', () => {
  assert.equal(doc.title, 'web-chat');
  assert.equal(project.getProject(), project.DEFAULT_IDENTITY);
});

test('the tab title is the hello\'s folder name until the identity lands, then the identity\'s name', async (t) => {
  const answer = hold();
  t.after(() => answer(serverIdentity));
  await shell.frame(helloFrame({ project: FOLDER }));
  assert.equal(doc.title, FOLDER, 'the folder name, bare: ws.js\'s "<folder> — web-chat" does not survive the hello');
  assert.ok(shell.calls.some((c) => c.url === '/api/project' && c.method === 'GET'), 'and the identity is read');

  answer(identity());
  await shell.tick();
  assert.equal(doc.title, 'Acme Web', 'the identity\'s name, and nothing else');
  const got = project.getProject();
  assert.equal(got.name, 'Acme Web');
  assert.ok(Object.isFrozen(got), 'one copy, read-only to its readers');
});

test('a reconnect\'s hello never puts the folder name back, and a dropped socket never touches the title', async (t) => {
  const answer = hold();
  t.after(() => answer(serverIdentity));
  const sockets = shell.sockets.length;
  shell.socket().drop();
  await shell.tick();
  assert.equal(doc.title, 'Acme Web', 'a dropped connection is the pill\'s to show, never the title\'s');
  assert.equal($('active-pill').textContent, 'reconnecting…', 'and the pill does show it');

  await waitUntil(() => shell.sockets.length > sockets && shell.socket().readyState === 1,
    { timeout: 5000, what: 'the chrome to reconnect' });
  await shell.frame(helloFrame({ project: FOLDER }));
  assert.equal(doc.title, 'Acme Web', 'the known name stands while the identity is re-read: no flicker to the folder');

  answer(identity());
  await shell.tick();
  assert.equal(doc.title, 'Acme Web');
});

test('a `project` frame renames the tab', async () => {
  await projectFrame(identity({ name: 'Acme Two' }));
  assert.equal(doc.title, 'Acme Two');

  await projectFrame(identity({ name: FOLDER, custom: false }));
  assert.equal(doc.title, FOLDER, 'reset to the folder name');

  await projectFrame(identity());
  assert.equal(doc.title, 'Acme Web');
});

test('the title never carries a step, a state or a node: mirror frames, locks and previews leave it alone', async () => {
  const seen = [];
  const off = bus.on('project', (d) => seen.push(d));
  const frames = [
    { type: 'mirror:status', status: { c1: { state: 'working', step: { tool: 'Edit', label: 'Edit · QueueRail.tsx' } } } },
    { type: 'mirror:status', status: { c1: { state: 'waiting', waiting: { kind: 'permission', tool: 'Bash' } } } },
    { type: 'mirror:update', conversation: { id: 'c1', title: 'Fix the rail' }, what: ['stream'] },
    { type: 'mirror:ask', ask: { id: 'a1', kind: 'question', summary: 'Keep the 56px rail?' } },
    { type: 'lock', lock: { author: 'user', token: 't', prompt: 'make it blue' } },
    { type: 'lock', lock: { author: 'wake', token: 't2' } },
    { type: 'lock', lock: null },
    { type: 'node-added', active: 'n1', unlock: true },
  ];
  for (const f of frames) {
    await shell.frame(f);
    assert.equal(doc.title, 'Acme Web', `after ${f.type}`);
  }
  bus.emit('mirror', { what: 'all' });
  bus.emit('conn', { state: 'reconnecting' });
  bus.emit('conn', { state: 'live' });
  assert.equal(doc.title, 'Acme Web');
  off();
  assert.deepEqual(seen, [], 'and none of it is a change of identity');
});

test('garbage keeps the last good identity: a frame, and a GET answer, that is not one', async (t) => {
  const before = project.getProject();
  const seen = [];
  const off = bus.on('project', (d) => seen.push(d));
  t.after(off);
  for (const bad of [undefined, null, 'Acme', 42, [], {}, { name: '' }, { name: '   ' }, { name: 7 }, { show_name: false }]) {
    await shell.frame(bad === undefined ? { type: 'project' } : { type: 'project', identity: bad });
    assert.equal(doc.title, 'Acme Web', `kept after ${JSON.stringify(bad)}`);
  }
  assert.equal(project.getProject(), before, 'the same identity, untouched');
  assert.deepEqual(seen, [], 'and no `project` event for any of it');

  // A daemon older than the project routes answers 404; a confused one, junk.
  serverIdentity = { ok: true };
  await shell.frame(helloFrame({ project: FOLDER }));
  shell.setRoutes({ '/api/project': respond({ error: 'not found' }, { status: 404 }) });
  await shell.frame(helloFrame({ project: FOLDER }));
  assert.equal(doc.title, 'Acme Web');
  assert.equal(project.getProject(), before);
  serverIdentity = identity();
});

test('an identity read that something newer overtook is older news: it never undoes what landed after it', async (t) => {
  // The host renames the project while the hello's read is out: the frame is
  // newer than the answer the read is about to bring.
  const answer = hold();
  t.after(() => answer(serverIdentity));
  await shell.frame(helloFrame({ project: FOLDER }));
  await projectFrame(identity({ name: 'Renamed' }));
  assert.equal(doc.title, 'Renamed');
  answer(identity({ name: 'Acme Web' }));
  await shell.tick();
  assert.equal(doc.title, 'Renamed', 'the older answer is dropped');

  // Two reads out at once (two hellos in quick succession): the later read's
  // answer is the one that stays, whichever order the answers come back in.
  const readPair = async () => {
    const first = hold();
    await shell.frame(helloFrame({ project: FOLDER }));
    const second = hold();
    await shell.frame(helloFrame({ project: FOLDER }));
    return [first, second];
  };
  let [first, second] = await readPair();
  second(identity({ name: 'Second' }));
  await shell.tick();
  first(identity({ name: 'First' }));
  await shell.tick();
  assert.equal(doc.title, 'Second', 'the earlier read, answering last, is dropped');

  [first, second] = await readPair();
  first(identity({ name: 'First' }));
  await shell.tick();
  assert.equal(doc.title, 'First', 'the earlier read, answering first, is still newer than what was shown');
  second(identity({ name: 'Second' }));
  await shell.tick();
  assert.equal(doc.title, 'Second', 'and the later read\'s answer still lands after it');
  await projectFrame(identity());
});

test('the name is text: markup stays text in the tab, and a long name is cut to 64 code points', async () => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  await projectFrame(identity({ name: evil }));
  assert.equal(doc.title, evil);
  assert.equal(W.__pwned, undefined);

  const long = '🦊'.repeat(40) + 'x'.repeat(40);
  await projectFrame(identity({ name: long }));
  assert.equal([...doc.title].length, 64, 'cut by code points, so no emoji is split in half');
  assert.equal(doc.title, '🦊'.repeat(40) + 'x'.repeat(24));

  await projectFrame(identity({ name: '  Acme Web  ', name_max: 64, max_bytes: 262144 }));
  assert.equal(doc.title, 'Acme Web', 'trimmed');
  assert.equal('name_max' in project.getProject(), false, 'the GET\'s extra fields are not identity');
});
