// The file-editor fence (U214e; PLAN 1B.4, writer identity; DECISIONS I.3 D1):
// the built-in file-editor never opens, lists into or writes the project root's
// own .web-chat/ or .git/, whatever its approval covers.
//
// Why: meta.json marks `path` and `root` x-trust project-path, so ONE
// `claude-web-chat trust file-editor` covers every path inside the project. A
// pane could api.spawn a file-editor child on '.web-chat/writer-token' (or
// write `editor_ctl {action: 'open'}` to a running one) and nothing asked: the
// service read Claude's writer token into the store, where the pane read it
// back and claimed the verified claude class (GT-15's pane-forgery clause).
// The capture token lives beside it, and a `save` under .git/hooks is code the
// user's next git command runs.
//
// The fence decides by FILE IDENTITY (device and inode of the entries and of
// the realpath'd nearest-existing part of the path and its ancestors), so a
// case variant, a `..` detour, an absolute spelling and a link inside the
// project are all the same place. Two levels: the service alone, through the
// ctx stub test/file-editor-service.test.js builds (plus `root` and the
// `covers` the supervisor hands a covered pane), and end to end, a daemon whose
// one approval covers pane-spawned children that ask for nothing.
//
// The temp roots are deliberately NOT realpath'd: on macOS $TMPDIR is a
// symlink, the state that tells identity from spelling.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withTempHome, withServer, waitUntil: harnessWaitUntil } = require('../test-support/helpers');
const { fence } = require('../lib/core/paths');
const { lineDiff } = require('../lib/server/diff');
const { PANE_HEADER } = require('../lib/core/writer-token');

const SERVICE = path.join(__dirname, '..', 'templates', 'components', 'file-editor', 'service.js');
const COVERS = { path: 'project-path', root: 'project-path' };
const REFUSED = /\.web-chat\/ or \.git\//;
const SENTINEL = {
  writer: 'SENTINEL-WRITER-TOKEN-7f3a',
  capture: 'SENTINEL-CAPTURE-TOKEN-91c2',
  gitConfig: 'SENTINEL-GIT-CONFIG-4d08',
};
const SENTINELS = Object.values(SENTINEL);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = (fn, opts) => harnessWaitUntil(fn, { timeout: 6000, interval: 40, ...opts });
let clicks = 0;
const click = () => Date.now() + ++clicks;

// A project tree: the three sentinel files, a .git/hooks directory, and the
// look-alikes the fence must leave alone.
function project(t, prefix = 'wc-fefence-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.web-chat', 'writer-token'), SENTINEL.writer + '\n');
  fs.writeFileSync(path.join(root, '.web-chat', 'capture-token'), SENTINEL.capture + '\n');
  fs.writeFileSync(path.join(root, '.git', 'config'), `[core]\n\t# ${SENTINEL.gitConfig}\n`);
  fs.writeFileSync(path.join(root, 'a.txt'), 'AAA\n');
  fs.mkdirSync(path.join(root, 'notes'));
  return root;
}

// Every file and directory under `dir`, with each file's bytes.
function tree(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? rel + '/' + e.name : e.name;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { out[r + '/'] = true; walk(abs, r); } else out[r] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}
const privateTrees = (root) => ({ webChat: tree(path.join(root, '.web-chat')), git: tree(path.join(root, '.git')) });

// The ctx the supervisor hands a covered pane (lib/server/services.js): the
// shape test/file-editor-service.test.js makeCtx builds, plus `root` (the
// daemon's spelling of the project root) and `covers`.
function makeCtx(root, store, params = {}, extra = {}) {
  const writes = [];
  let handler = null;
  const ctx = {
    mountId: 'm1',
    name: 'file-editor',
    params: { ...params },
    covers: COVERS,
    root,
    log() {},
    webChatDir: path.join(root, '.web-chat'),
    diff: (a, b, opts) => lineDiff(a, b, opts),
    fence: (parent, child) => fence(parent, child),
    driver: {
      async setStore(patch) { writes.push(JSON.parse(JSON.stringify(patch))); Object.assign(store, patch); },
      async getStore(keys) {
        const out = {};
        for (const k of keys || Object.keys(store)) if (k in store) out[k] = store[k];
        return out;
      },
      streamEvents({ onEvent }) { handler = onEvent; return { close() { handler = null; } }; },
    },
    ...extra,
  };
  return { ctx, writes, fire: (patch) => handler && handler({ patch }) };
}

function loadService() {
  delete require.cache[require.resolve(SERVICE)];
  return require(SERVICE);
}

async function startService(t, root, store, params, extra) {
  const svc = loadService();
  t.after(async () => { try { await svc.stop(); } catch {} });
  const h = makeCtx(root, store, params, extra);
  await svc.start(h.ctx);
  return { svc, ...h, latest: () => store.editor };
}

function assertNoSentinel(writes, label) {
  const text = JSON.stringify(writes);
  for (const s of SENTINELS) assert.ok(!text.includes(s), `${label}: a store write holds ${s}`);
}

// Fire one control write and answer the push it caused.
async function act(h, ctl) {
  const before = h.writes.length;
  h.fire({ editor_ctl: { seq: click(), ...ctl } });
  for (let i = 0; i < 50 && h.writes.length === before; i++) await sleep(10);
  assert.ok(h.writes.length > before, `${JSON.stringify(ctl)} pushed`);
  return h.writes[h.writes.length - 1].editor;
}

// ── service level ───────────────────────────────────────────────────────────

for (const p of ['.web-chat/writer-token', '.web-chat/capture-token', '.git/config']) {
  test(`fence: a covered pane started on ${p} is refused on its first push, with nothing read`, async (t) => {
    withTempHome(t);
    const root = project(t);
    const store = {};
    const h = await startService(t, root, store, { path: p });
    assert.equal(h.writes.length, 1, 'the start published once');
    const e = h.writes[0].editor;
    assert.match(String(e.error), REFUSED);
    assert.equal(e.content, '');
    assert.equal(e.exists, false);
    assertNoSentinel(h.writes, p);
  });
}

test('fence: open, diff, revert, save and browse into .web-chat/ or .git/ are each refused under the same approval, and nothing changes on disk', async (t) => {
  withTempHome(t);
  const root = project(t);
  const before = privateTrees(root);
  const store = {};
  const h = await startService(t, root, store, { path: 'a.txt' });
  assert.equal(h.latest().path, 'a.txt');
  assert.equal(h.latest().content, 'AAA\n');

  const files = ['.web-chat/writer-token', '.web-chat/capture-token', '.git/config'];
  const ctls = [];
  for (const f of files) {
    ctls.push({ action: 'open', path: f });
    ctls.push({ action: 'diff', path: f, version: 'v1', content: 'x' });
    ctls.push({ action: 'revert', path: f, version: 'v1' });
  }
  ctls.push({ action: 'save', path: '.git/hooks/pre-commit', content: '#!/bin/sh\necho owned\n' });
  ctls.push({ action: 'save', path: '.web-chat/x.txt', content: 'planted\n' });
  ctls.push({ action: 'save', path: '.web-chat/writer-token', content: 'replaced\n' });
  ctls.push({ action: 'browse', dir: '.web-chat' });
  ctls.push({ action: 'browse', dir: '.git' });
  ctls.push({ action: 'browse', dir: '.git/hooks' });
  for (const c of ctls) {
    const e = await act(h, c);
    assert.match(String(e.error), REFUSED, JSON.stringify(c));
    assert.equal(e.path, 'a.txt', `${JSON.stringify(c)}: the view keeps the file it had`);
    assert.equal(e.content, 'AAA\n', `${JSON.stringify(c)}: and its content`);
  }
  assertNoSentinel(h.writes, 'control writes');
  assert.deepEqual(privateTrees(root), before, 'nothing was created, changed or removed under .web-chat/ or .git/');
  assert.equal(fs.readFileSync(path.join(root, '.web-chat', 'writer-token'), 'utf8'), SENTINEL.writer + '\n');
  assert.equal(fs.readFileSync(path.join(root, '.web-chat', 'capture-token'), 'utf8'), SENTINEL.capture + '\n');
  assert.ok(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8').includes(SENTINEL.gitConfig));
});

test('fence: every spelling of the same place is refused — root, absolute, `..`, a file link, a directory link, a case variant', async (t) => {
  withTempHome(t);
  const root = project(t);
  fs.symlinkSync(path.join('.web-chat', 'writer-token'), path.join(root, 'tok'));
  fs.symlinkSync('.git', path.join(root, 'g'));
  fs.symlinkSync('.web-chat', path.join(root, 'wc'));

  // root '.web-chat' with a path inside it (root is covered too).
  const viaRoot = await startService(t, root, {}, { root: '.web-chat', path: 'writer-token' });
  assert.match(String(viaRoot.writes[0].editor.error), REFUSED, 'root .web-chat');
  assert.equal(viaRoot.writes[0].editor.content, '');
  assertNoSentinel(viaRoot.writes, 'root .web-chat');

  const store = {};
  const h = await startService(t, root, store, { path: 'a.txt' });
  const spellings = [
    path.join(root, '.web-chat', 'writer-token'),
    'notes/../.web-chat/writer-token',
    './.web-chat/./capture-token',
    'tok',
    'g/config',
    'wc/capture-token',
    'g',
  ];
  for (const p of spellings) {
    const e = await act(h, { action: 'open', path: p });
    assert.match(String(e.error), REFUSED, p);
  }
  const saved = await act(h, { action: 'save', path: 'g/hooks/post-checkout', content: '#!/bin/sh\n' });
  assert.match(String(saved.error), REFUSED, 'a save through the directory link');
  assert.equal(fs.existsSync(path.join(root, '.git', 'hooks', 'post-checkout')), false);
  const listed = await act(h, { action: 'browse', dir: 'wc' });
  assert.match(String(listed.error), REFUSED, 'a listing through the directory link');
  assertNoSentinel(h.writes, 'spellings');
});

test('fence: a case variant reaches .web-chat on a case-insensitive volume, and is refused by identity', async (t) => {
  withTempHome(t);
  const root = project(t);
  const upper = path.join(root, '.WEB-CHAT', 'writer-token');
  if (!fs.existsSync(upper)) { t.skip('the volume is case-sensitive: .WEB-CHAT is another name'); return; }
  const h = await startService(t, root, {}, { path: 'a.txt' });
  for (const p of ['.WEB-CHAT/writer-token', '.Web-Chat/capture-token', '.GIT/config', '.GIT']) {
    const e = await act(h, { action: 'open', path: p });
    assert.match(String(e.error), REFUSED, p);
  }
  const saved = await act(h, { action: 'save', path: '.GIT/hooks/pre-push', content: '#!/bin/sh\n' });
  assert.match(String(saved.error), REFUSED);
  assert.equal(fs.existsSync(path.join(root, '.git', 'hooks', 'pre-push')), false);
  assertNoSentinel(h.writes, 'case variants');
});

test('fence: a .git that is a FILE (a worktree) is itself refused', async (t) => {
  withTempHome(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-fefence-wt-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.web-chat'));
  fs.writeFileSync(path.join(root, '.git'), `gitdir: /elsewhere/${SENTINEL.gitConfig}\n`);
  fs.writeFileSync(path.join(root, 'a.txt'), 'AAA\n');
  const h = await startService(t, root, {}, { path: 'a.txt' });
  const e = await act(h, { action: 'open', path: '.git' });
  assert.match(String(e.error), REFUSED);
  const s = await act(h, { action: 'save', path: '.git', content: 'gitdir: /attacker\n' });
  assert.match(String(s.error), REFUSED);
  assert.equal(fs.readFileSync(path.join(root, '.git'), 'utf8'), `gitdir: /elsewhere/${SENTINEL.gitConfig}\n`);
  assertNoSentinel(h.writes, 'worktree .git');
});

test('fence: an absent .git fences nothing, and .web-chat stays fenced', async (t) => {
  withTempHome(t);
  const root = project(t);
  fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
  const h = await startService(t, root, {}, { path: 'a.txt' });
  const e = await act(h, { action: 'open', path: '.web-chat/writer-token' });
  assert.match(String(e.error), REFUSED);
  assertNoSentinel(h.writes, 'no .git');
});

test('fence: nothing else is fenced — .gitignore, .github/, .web-chat-notes.md and src/.git-keep open and save as before', async (t) => {
  withTempHome(t);
  const root = project(t);
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  fs.mkdirSync(path.join(root, '.github'));
  fs.writeFileSync(path.join(root, '.github', 'ci.yml'), 'on: push\n');
  fs.writeFileSync(path.join(root, '.web-chat-notes.md'), '# notes\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', '.git-keep'), '');
  const h = await startService(t, root, {}, { path: 'a.txt' });
  for (const [p, was] of [['.gitignore', 'node_modules\n'], ['.github/ci.yml', 'on: push\n'], ['.web-chat-notes.md', '# notes\n'], ['src/.git-keep', '']]) {
    const o = await act(h, { action: 'open', path: p });
    assert.equal(o.error, null, `${p} opens`);
    assert.equal(o.content, was);
    assert.equal(o.exists, true);
    const s = await act(h, { action: 'save', path: p, content: was + 'more\n' });
    assert.equal(s.error, null, `${p} saves`);
    assert.equal(fs.readFileSync(path.join(root, p), 'utf8'), was + 'more\n');
  }
  // The root listing still names both entries — names only.
  const l = await act(h, { action: 'browse', dir: '.' });
  assert.equal(l.error, null);
  const names = l.listing.entries.map((x) => x.name);
  assert.ok(names.includes('.web-chat') && names.includes('.git'), names.join(','));
  // A save under the project's own .web-chat/ is still where the service keeps
  // its snapshots — its own writes, never through a path from the store.
  assert.ok(fs.existsSync(path.join(root, '.web-chat', 'file-versions')));
});

test('fence: a stored view whose path is a token file is refused on respawn, and params.path opens instead', async (t) => {
  withTempHome(t);
  const root = project(t);
  const store = { editor: { root: '.', unfenced: false, start_path: 'a.txt', path: '.web-chat/writer-token', exists: true, content: 'x', versions: [], listing: { dir: '.git', parent: '.', entries: [] }, seq: 5, load: 3, ack: null } };
  const h = await startService(t, root, store, { path: 'a.txt' });
  assert.equal(h.writes.length, 1, 'the view changed, so it is published');
  const e = h.writes[0].editor;
  assert.equal(e.path, 'a.txt', 'the fence refused the stored path and params.path opened');
  assert.equal(e.content, 'AAA\n');
  assert.equal(e.error, null);
  assert.equal(e.listing, null, 'the stored listing of .git was not rebuilt');
  assert.ok(e.load > 3, 'a different file: the pane reloads');
  assertNoSentinel(h.writes, 'respawn');
});

test('fence: a persisted open of a token file replayed at startup is refused', async (t) => {
  withTempHome(t);
  const root = project(t);
  const store = { editor_ctl: { seq: Date.now() - 60000, action: 'open', path: '.web-chat/writer-token' } };
  const h = await startService(t, root, store, { path: 'a.txt' });
  assert.match(String(h.writes[h.writes.length - 1].editor.error), REFUSED);
  assertNoSentinel(h.writes, 'replayed open');
});

// ── end to end ──────────────────────────────────────────────────────────────

function openViewer(t, ctx) {
  return new Promise((resolve, reject) => {
    const sock = ctx.ws();
    t.after(() => { try { sock.close(); } catch {} });
    sock.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch {}
      if (msg && msg.type === 'hello') resolve(sock);
    });
    sock.on('error', reject);
  });
}

// Approve the way the CLI does: write the user-tier trust file under the key
// the daemon reported, then nudge.
async function approve(ctx, req) {
  const file = path.join(ctx.userWebChat, 'services', 'trusted.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  data[req.key] = { name: req.name, hash: req.hash, root: req.root, params: req.params, approved: true, approved_at: 1 };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  await ctx.api.post('/api/services/refresh-trust', {});
}

test('end to end: pane-spawned file-editor children on the tokens and .git/config ride the one approval, run, and put no byte of them in the store or the events', async (t) => {
  const ctx = await withServer(t);
  const { api, anonApi, baseUrl } = ctx;
  const root = ctx.root;
  fs.writeFileSync(path.join(root, 'a.txt'), 'first\n');
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'config'), `[core]\n\t# ${SENTINEL.gitConfig}\n`);
  const capture = path.join(root, '.web-chat', 'capture-token');
  if (!fs.existsSync(capture)) fs.writeFileSync(capture, SENTINEL.capture + '\n');
  const captureBytes = fs.readFileSync(capture, 'utf8').trim();
  const token = ctx.writerToken();
  assert.ok(token, 'the boot wrote a writer token');
  const secrets = [token, captureBytes, SENTINEL.gitConfig];

  await openViewer(t, ctx);
  const pending = async () => (await api.get('/api/services/pending')).json.pending;
  await api.post('/api/components/file-editor/use', { id: 'ed', params: { path: 'a.txt' } });
  const req = await waitUntil(async () => (await pending())[0] || false);
  assert.ok(req, 'the first mount asks');
  assert.deepEqual(req.covers, COVERS);
  await approve(ctx, req);
  const opened = await waitUntil(async () => {
    const ed = (await api.get('/api/store')).json.editor;
    return ed && ed.path === 'a.txt' ? ed : false;
  });
  assert.ok(opened, 'the approved service opened a.txt');

  // The parent pane; its children are spawned the way a pane script's
  // api.spawn posts — stamped with the parent's id from a same-origin browser
  // (U214c), and once as a credentialed caller (today's rule).
  assert.equal((await api.post('/api/render', { id: 'p', html: '<p>parent</p>' })).status, 200);
  const stamped = { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin', [PANE_HEADER]: 'p' };
  const cases = [
    { id: 'p-wt', path: '.web-chat/writer-token', via: 'pane' },
    { id: 'p-ct', path: '.web-chat/capture-token', via: 'pane' },
    { id: 'p-gc', path: '.git/config', via: 'pane' },
    { id: 'p-hk', path: '.git/hooks/pre-commit', via: 'claude' },
  ];
  for (const c of cases) {
    const body = { parent: 'p', id: c.id, component: 'file-editor', params: { path: c.path } };
    const r = c.via === 'pane' ? await anonApi.post('/api/pane/spawn', body, stamped) : await api.post('/api/pane/spawn', body);
    assert.equal(r.json && r.json.ok, true, `${c.path}: ${r.text}`);
    const child = await waitUntil(() => ctx.srv.services._children.get(c.id) || false);
    assert.ok(child, `${c.path}: the child's service runs on the one approval`);
    const ed = await waitUntil(async () => {
      const e = (await api.get('/api/store')).json.editor;
      return e && e.start_path === c.path && e.error ? e : false;
    });
    assert.ok(ed, `${c.path}: the store's editor carries the child's push`);
    assert.match(ed.error, REFUSED, c.path);
    assert.equal(ed.content, '');
    assert.equal(ed.exists, false);
    assert.deepEqual(await pending(), [], `${c.path}: no new trust request`);
  }

  assert.equal(fs.existsSync(path.join(root, '.git', 'hooks', 'pre-commit')), false);

  // And a control write to the running children cannot reach them either.
  const before = (await api.get('/api/store')).json.editor.seq;
  await anonApi.post('/api/store', { patch: { editor_ctl: { seq: Date.now(), action: 'open', path: '.web-chat/writer-token' } } }, stamped);
  await waitUntil(async () => (await api.get('/api/store')).json.editor.seq > before);
  await sleep(200);

  const storeText = (await api.get('/api/store')).text;
  const eventsText = (await api.get('/api/events?since=0')).text;
  for (const s of secrets) {
    assert.ok(!storeText.includes(s), 'GET /api/store holds a secret');
    assert.ok(!eventsText.includes(s), 'GET /api/events holds a secret');
  }
  assert.ok(!storeText.includes(SENTINEL.writer));
});
