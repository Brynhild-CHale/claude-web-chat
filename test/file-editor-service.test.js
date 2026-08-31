const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withTempHome } = require('../test-support/helpers');
const { fence } = require('../lib/core/paths');
const { lineDiff } = require('../lib/server/diff');

// Smoke test for the file-editor builtin's host-side service.js, driven against
// a throwaway tree through a faithful `ctx` stub — the same shape
// lib/server/service-runner.js hands a service (driver.setStore / getStore /
// streamEvents, plus diff / webChatDir / fence). Same harness shape as
// test/git-dashboard-service.test.js.
//
// The point of the file is what a *pane* can make this service do. `editor_ctl`
// is a store key, so every script in the page and every local driver can write
// it, and the service turns what it finds there into filesystem operations:
//
//   * a `version` id becomes a filename inside the snapshot directory. It used
//     to be joined unchecked, so `../../../secret` read a host file straight
//     past the fence the component's own description promises.
//   * a `path` was fenced lexically, and reads/writes follow symlinks — so a
//     link inside the tree pointing out of it was followed.
//   * nothing ever clears `editor_ctl`, and the service is respawned every time
//     the last viewer leaves or the pane comes back on the active node. The
//     startup replay re-ran whatever action was persisted — including a `save`,
//     which silently rewrote the file on disk with a stale buffer.
//
// The temp roots here are deliberately NOT realpath'd: on macOS $TMPDIR is a
// symlink, which is the state that tells a fence that fails closed apart from
// one that is merely lexical.

const SERVICE = path.join(__dirname, '..', 'templates', 'components', 'file-editor', 'service.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The pane stamps `seq: Date.now()` at click time, and the service ignores every
// control write stamped at or before its own start — that floor is what makes a
// PERSISTED write inert, whether it arrives from the startup read or from a
// graph node being restored into the store under a running service. So a test
// click has to carry a live timestamp; a small counter would read as persisted,
// which is exactly what it would be.
let clicks = 0;
const click = () => Date.now() + ++clicks;
// A write that was already sitting in the store when the service came up: the
// pane clicked it in an earlier session, or a graph node carrying it was
// restored. Always stamped before this service started.
const stale = (agoMs = 60000) => Date.now() - agoMs;

function tmpTree(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  return dir;
}

// The ctx a service actually receives. `writes` collects every setStore patch;
// `fire` replays a store event the way the SSE stream would.
function makeCtx(root, store, params = {}) {
  const writes = [];
  let handler = null;
  const ctx = {
    mountId: 'm1',
    name: 'file-editor',
    params: { root, ...params },
    log() {},
    webChatDir: path.join(root, '.web-chat'),
    diff: (a, b, opts) => lineDiff(a, b, opts),
    fence: (parent, child) => fence(parent, child),
    driver: {
      async setStore(patch) { writes.push(patch); Object.assign(store, patch); },
      async getStore(keys) {
        const out = {};
        for (const k of keys || Object.keys(store)) if (k in store) out[k] = store[k];
        return out;
      },
      streamEvents({ onEvent }) { handler = onEvent; return { close() { handler = null; } }; },
    },
  };
  return { ctx, writes, fire: (patch) => handler && handler({ patch }) };
}

// Fresh module instance per start: service.js keeps `stopped`/`stream`/`pollTimer`
// at module scope, so a second start() on a cached copy would come up stopped.
function loadService() {
  delete require.cache[require.resolve(SERVICE)];
  return require(SERVICE);
}

async function startService(t, root, store, params) {
  const svc = loadService();
  t.after(async () => { try { await svc.stop(); } catch {} });
  const h = makeCtx(root, store, params);
  await svc.start(h.ctx);
  return { svc, ...h, latest: () => store.editor };
}

// ── ordinary use still works ────────────────────────────────────────────────

test('file-editor service: saves a new file under the root and snapshots a version', async (t) => {
  withTempHome(t);
  const root = tmpTree('wc-fileed-');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  const store = {};
  const h = await startService(t, root, store);
  assert.ok(h.latest(), 'the service pushed an `editor` payload');
  assert.ok(h.latest().listing, 'with no params.path it browses the root');

  // A file that does not exist yet, in a directory that does not exist yet —
  // the case a realpath-only fence gets wrong under a symlinked $TMPDIR.
  h.fire({ editor_ctl: { seq: click(), action: 'save', path: 'notes/a.txt', content: 'hello\n' } });
  await sleep(50);
  assert.equal(h.latest().error, null, 'saving inside the root is not refused');
  assert.equal(fs.readFileSync(path.join(root, 'notes', 'a.txt'), 'utf8'), 'hello\n');
  assert.deepEqual(h.latest().versions.map((v) => v.id), ['v1'], 'the save snapshotted v1');

  // And the snapshot is readable back through diff/revert by its real id.
  h.fire({ editor_ctl: { seq: click(), action: 'revert', path: 'notes/a.txt', version: 'v1' } });
  await sleep(50);
  assert.equal(h.latest().error, null);
  assert.equal(h.latest().content, 'hello\n', 'a version the service wrote still reverts');
});

// ── services-2: a store-supplied version id is not a path ───────────────────

test('file-editor service: a version id that escapes the snapshot dir is refused', async (t) => {
  withTempHome(t);
  const root = tmpTree('wc-fileed-ver-');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const SECRET = 'SECRET-HOST-CONTENT\n';
  fs.writeFileSync(path.join(root, 'secret.txt'), SECRET);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');

  const store = {};
  const h = await startService(t, root, store, { path: 'a.txt' });
  h.fire({ editor_ctl: { seq: click(), action: 'save', path: 'a.txt', content: 'one\n' } });
  await sleep(50);
  assert.deepEqual(h.latest().versions.map((v) => v.id), ['v1'], 'the snapshot dir exists');

  // Snapshots live at <root>/.web-chat/file-versions/<sha1>/, so three levels up
  // is the project root: an unchecked join reads any file the daemon can.
  const escape = '../../../secret.txt';

  h.fire({ editor_ctl: { seq: click(), action: 'revert', path: 'a.txt', version: escape } });
  await sleep(50);
  assert.ok(h.latest().error, 'revert to a forged version is an error');
  assert.match(h.latest().error, /version/i);
  assert.ok(!String(h.latest().content).includes('SECRET-HOST-CONTENT'), 'no host file reached the buffer');
  assert.notEqual(h.latest().selected, escape);

  h.fire({ editor_ctl: { seq: click(), action: 'diff', path: 'a.txt', version: escape, content: '' } });
  await sleep(50);
  assert.ok(h.latest().error, 'diffing against a forged version is an error');
  assert.equal(h.latest().diff, null, 'and produces no diff of the host file');

  // Nor a well-shaped id the service never wrote.
  h.fire({ editor_ctl: { seq: click(), action: 'revert', path: 'a.txt', version: 'v99' } });
  await sleep(50);
  assert.ok(h.latest().error, 'a version id that is not in the index is refused');
  assert.equal(h.latest().content, 'one\n');
});

// ── services-2 (second half): the fence is realpath-based ───────────────────

test('file-editor service: a symlink pointing out of the root is refused', async (t) => {
  withTempHome(t);
  const root = tmpTree('wc-fileed-link-');
  const outside = tmpTree('wc-fileed-outside-');
  t.after(() => {
    for (const d of [root, outside]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });
  const SECRET = 'SECRET-OUTSIDE-CONTENT\n';
  fs.writeFileSync(path.join(outside, 'passwd'), SECRET);
  fs.symlinkSync(path.join(outside, 'passwd'), path.join(root, 'link.txt'));
  fs.symlinkSync(outside, path.join(root, 'linkdir'));

  const store = {};
  const h = await startService(t, root, store);

  h.fire({ editor_ctl: { seq: click(), action: 'open', path: 'link.txt' } });
  await sleep(50);
  assert.ok(h.latest().error, 'opening through the link is an error');
  assert.match(h.latest().error, /outside the project root/);
  assert.ok(!String(h.latest().content).includes('SECRET-OUTSIDE-CONTENT'), 'nothing leaked into the buffer');

  h.fire({ editor_ctl: { seq: click(), action: 'browse', dir: 'linkdir' } });
  await sleep(50);
  assert.match(h.latest().error, /outside the project root/, 'nor listing through a linked directory');

  // A write through the link would have escaped too.
  h.fire({ editor_ctl: { seq: click(), action: 'save', path: 'link.txt', content: 'clobbered\n' } });
  await sleep(50);
  assert.match(h.latest().error, /outside the project root/);
  assert.equal(fs.readFileSync(path.join(outside, 'passwd'), 'utf8'), SECRET, 'the outside file is untouched');

  // A plain lexical escape is still refused, as before.
  h.fire({ editor_ctl: { seq: click(), action: 'open', path: '../elsewhere.txt' } });
  await sleep(50);
  assert.match(h.latest().error, /outside the project root/);
});

// A link whose target does not exist yet is the half a following walk misses:
// `existsSync` says the link is absent, so a fence that anchors on it treats the
// name as a free filename inside the root — and then the WRITE creates the
// target, outside. git commits symlinks, so this is a link a repository can
// ship, and `doSave` is exactly the caller that would create it.
test('file-editor service: a DANGLING symlink out of the root is refused, not created', async (t) => {
  withTempHome(t);
  const root = tmpTree('wc-fileed-dangle-');
  const outside = tmpTree('wc-fileed-dangle-out-');
  t.after(() => {
    for (const d of [root, outside]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });
  const target = path.join(outside, 'planted.txt');
  fs.symlinkSync(target, path.join(root, 'dangling.txt'));       // leaf link, nothing at the end
  fs.symlinkSync(path.join(outside, 'nodir'), path.join(root, 'dangdir')); // ditto, mid-path

  const store = {};
  const h = await startService(t, root, store);

  h.fire({ editor_ctl: { seq: click(), action: 'save', path: 'dangling.txt', content: 'ESCAPED\n' } });
  await sleep(50);
  assert.match(h.latest().error, /outside the project root/, 'saving through a dangling link is refused');
  assert.equal(fs.existsSync(target), false, 'and nothing was created outside the root');

  h.fire({ editor_ctl: { seq: click(), action: 'open', path: 'dangling.txt' } });
  await sleep(50);
  assert.match(h.latest().error, /outside the project root/, 'nor is it a file to open');

  // The mid-path case must be refused BY THE FENCE, not by mkdir happening to
  // fail with ENOENT — that accident is not a containment rule.
  h.fire({ editor_ctl: { seq: click(), action: 'save', path: 'dangdir/new.txt', content: 'ESCAPED\n' } });
  await sleep(50);
  assert.match(h.latest().error, /outside the project root/, 'a dangling directory component is refused too');
  assert.equal(fs.existsSync(path.join(outside, 'nodir')), false);
});

// ── services-3: respawn replays view state only ─────────────────────────────

test('file-editor service: a persisted save is not re-applied on respawn', async (t) => {
  withTempHome(t);
  const root = tmpTree('wc-fileed-respawn-');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.writeFileSync(path.join(root, 'note.txt'), 'FROM DISK\n');

  // The store a respawn wakes up to: the pane's last Save is still sitting in
  // `editor_ctl` (nothing clears it, and restoring a graph node puts it back).
  const store = { editor_ctl: { seq: stale(), action: 'save', path: 'note.txt', content: 'FROM PANE\n' } };
  const h = await startService(t, root, store, { path: 'note.txt' });
  await sleep(50);

  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'FROM DISK\n',
    'the stale save did not rewrite the file');
  assert.ok(!fs.existsSync(path.join(root, '.web-chat', 'file-versions')),
    'and took no snapshot');
  assert.ok(h.latest(), 'the pane still got a payload');
  assert.equal(h.latest().path, 'note.txt', 'params.path opened instead of the replay');
  assert.equal(h.latest().content, 'FROM DISK\n', 'showing what is actually on disk');

  // The cursor's floor is this service's own START — not zero, and not merely
  // the persisted seq. Any other write from before we came up is stale too, and
  // a live click is still honoured.
  h.fire({ editor_ctl: { seq: stale(90000), action: 'save', path: 'note.txt', content: 'REPLAYED\n' } });
  await sleep(50);
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'FROM DISK\n');

  h.fire({ editor_ctl: { seq: click(), action: 'save', path: 'note.txt', content: 'FROM A REAL CLICK\n' } });
  await sleep(50);
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'FROM A REAL CLICK\n',
    'a live save after the respawn still works');
});

// The second leg of the same finding, and the one a respawn-only fix misses:
// NO respawn happens here. The supervisor keeps a service child alive across
// graph nodes that carry the same mount (identity is service hash + params), and
// `restoreLiveToNode` replaces the WHOLE store when the user navigates — so a
// jump to a node whose snapshot holds a `save` hands that save to the live
// stream and to the 4 s poll of a service that is already running. Without a
// start-time floor the poll applied it and rewrote the file on disk.
test('file-editor service: a restored node\'s save is not executed by the running service', async (t) => {
  withTempHome(t);
  const root = tmpTree('wc-fileed-nav-');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const onDisk = path.join(root, 'note.txt');
  fs.writeFileSync(onDisk, 'FROM DISK\n');

  // Node A: an old save, from the session that committed it.
  const store = { editor_ctl: { seq: stale(120000), action: 'save', path: 'note.txt', content: 'NODE-A\n' } };
  const h = await startService(t, root, store, { path: 'note.txt' });
  await sleep(50);
  assert.equal(fs.readFileSync(onDisk, 'utf8'), 'FROM DISK\n');

  // The user jumps to node B, whose committed store holds a LATER save — later
  // than node A's, still older than this service. A wholesale store swap, the
  // way graph.restoreLiveToNode does it.
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, { editor_ctl: { seq: stale(60000), action: 'save', path: 'note.txt', content: 'NODE-B\n' } });

  h.fire({ editor_ctl: store.editor_ctl }); // the SSE leg of the restore
  await sleep(50);
  assert.equal(fs.readFileSync(onDisk, 'utf8'), 'FROM DISK\n',
    "a restored node's save is a snapshot, not a click");

  // And the poll leg, which is how the restore reaches a service whose stream
  // dropped — the path this was actually reproduced through.
  await sleep(4300);
  assert.equal(fs.readFileSync(onDisk, 'utf8'), 'FROM DISK\n',
    'the 4 s poll does not execute it either');
  assert.ok(!fs.existsSync(path.join(root, '.web-chat', 'file-versions')), 'and took no snapshot');

  // A real click on the restored node still saves, so navigation has not left
  // the pane inert.
  h.fire({ editor_ctl: { seq: click(), action: 'save', path: 'note.txt', content: 'A REAL CLICK\n' } });
  await sleep(50);
  assert.equal(fs.readFileSync(onDisk, 'utf8'), 'A REAL CLICK\n');
});

test('file-editor service: a persisted revert is not re-applied on respawn', async (t) => {
  withTempHome(t);
  const root = tmpTree('wc-fileed-revert-');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.writeFileSync(path.join(root, 'note.txt'), 'CURRENT\n');

  const store = { editor_ctl: { seq: stale(), action: 'revert', path: 'note.txt', version: 'v1' } };
  const h = await startService(t, root, store, { path: 'note.txt' });
  await sleep(50);
  assert.equal(h.latest().content, 'CURRENT\n', 'the buffer shows the file, not an old snapshot');
  assert.equal(h.latest().selected, null, 'no version was selected by the replay');
});

test('file-editor service: a persisted view action IS replayed on respawn', async (t) => {
  withTempHome(t);
  const root = tmpTree('wc-fileed-view-');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'bee\n');

  const opened = await startService(t, root, { editor_ctl: { seq: stale(), action: 'open', path: 'sub/b.txt' } });
  await sleep(50);
  assert.equal(opened.latest().path, path.join('sub', 'b.txt'), 'the persisted open was replayed');
  assert.equal(opened.latest().content, 'bee\n');
  await opened.svc.stop();

  const browsed = await startService(t, root, { editor_ctl: { seq: stale(), action: 'browse', dir: 'sub' } });
  await sleep(50);
  assert.equal(browsed.latest().listing.dir, 'sub', 'so was the persisted browse');
});

// ── the PANE, mounted for real against the service ──────────────────────────
// The pane is the other half of this contract, and the half a user watches. It
// used to call setDirty(false) at click time: the buffer read as saved the
// instant Save was pressed, whether or not anything was written. One way nothing
// is written is entirely ordinary — a Save clicked in the spawn window (a viewer
// arrives, 200 ms debounce, fork, start()) is stamped before the service's own
// start, so the start-time floor above refuses it exactly as it refuses a
// persisted one. Silently, with the pane showing a clean buffer over unsaved
// text. Dirty is now cleared by the service's echo instead (`ack`), the way the
// buffer reload has always been driven by `load`.

const { JSDOM } = require('jsdom');
const mountRuntime = require('../public/mount-runtime.js');
const PANE_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'templates', 'components', 'file-editor', 'component.html'), 'utf8');

function withDom(t) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const saved = { window: global.window, document: global.document, CustomEvent: global.CustomEvent, Event: global.Event };
  global.window = dom.window;
  global.document = dom.window.document;
  global.CustomEvent = dom.window.CustomEvent;
  global.Event = dom.window.Event;
  t.after(() => Object.assign(global, saved));
  return dom.window.document;
}

// Mount the real component.html into a shadow root the way public/app/mounts.js
// does, over a real store. Every editor_ctl the pane writes is relayed into the
// service's event stream, and every `editor` the service pushes lands back in
// the same store — the daemon's wiring, minus the socket.
function mountPane(t, document, store) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const { root: shadow, scripts } = mountRuntime.attachAndExtract(host, PANE_HTML);
  const errors = [];
  mountRuntime.runScripts(shadow, scripts, store, { root: '.' }, 'm1', (e) => errors.push(e));
  assert.deepEqual(errors, [], 'the pane script threw at mount');
  return shadow;
}

function paneCtx(root, store) {
  let handler = null;
  const ctx = {
    mountId: 'm1', name: 'file-editor', params: { root }, log() {},
    webChatDir: path.join(root, '.web-chat'),
    diff: (a, b, opts) => lineDiff(a, b, opts),
    fence: (parent, child) => fence(parent, child),
    driver: {
      async setStore(patch) { store.set(patch); },
      async getStore(keys) {
        const all = store.get() || {};
        const out = {};
        for (const k of keys || Object.keys(all)) if (k in all) out[k] = all[k];
        return out;
      },
      streamEvents({ onEvent }) { handler = onEvent; return { close() { handler = null; } }; },
    },
  };
  return { ctx, wire: () => store.subscribe('editor_ctl', (v) => handler && handler({ patch: { editor_ctl: v } })) };
}

const dirtyShown = (shadow) => shadow.querySelector('[data-dirty]').style.visibility === 'visible';
const errText = (shadow) => {
  const el = shadow.querySelector('[data-error]');
  return el.style.display === 'none' ? '' : el.textContent;
};

test('file-editor pane: a Save the service never ran is reported, not shown as saved', async (t) => {
  withTempHome(t);
  const document = withDom(t);
  const root = tmpTree('wc-fileed-pane-');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  const store = mountRuntime.createStore({});
  const shadow = mountPane(t, document, store);

  // Type a path and some text, then hit Save BEFORE the service exists — the
  // spawn window (viewer arrives, 200 ms debounce, fork, start()), and equally
  // the case where the service has never been approved and so never starts.
  shadow.querySelector('[data-pathin]').value = 'notes.txt';
  shadow.querySelector('[data-ta]').value = 'typed but not saved\n';
  shadow.querySelector('[data-ta]').dispatchEvent(new global.Event('input', { bubbles: true }));
  assert.equal(dirtyShown(shadow), true, 'precondition: the buffer is dirty');
  shadow.querySelector('[data-save]').dispatchEvent(new global.window.MouseEvent('click', { bubbles: true }));

  assert.equal(dirtyShown(shadow), true,
    'the dirty marker used to be cleared right here, at click time — before anything could '
    + 'possibly have run, and whether or not anything ever would');

  // The service starts now, so that click is stamped before its start: refused
  // as persisted, which is what keeps a stale save off the disk (D8).
  const { ctx, wire } = paneCtx(root, store);
  wire();
  const svc = loadService();
  t.after(async () => { try { await svc.stop(); } catch {} });
  await svc.start(ctx);
  await sleep(60);
  assert.equal(fs.existsSync(path.join(root, 'notes.txt')), false, 'nothing was written, as designed');

  // ...and once the ack window closes the pane SAYS so, with both things that
  // fix it. It used to say nothing at all.
  await sleep(2600);
  assert.match(errText(shadow), /nothing was written/i);
  assert.match(errText(shadow), /click Save again/i);
  assert.match(errText(shadow), /claude-web-chat trust file-editor/);
});

test('file-editor pane: dirty clears on the service\'s echo, and only when the write succeeded', async (t) => {
  withTempHome(t);
  const document = withDom(t);
  const root = tmpTree('wc-fileed-echo-');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  const store = mountRuntime.createStore({});
  const shadow = mountPane(t, document, store);
  const { ctx, wire } = paneCtx(root, store);
  wire();
  const svc = loadService();
  t.after(async () => { try { await svc.stop(); } catch {} });
  await svc.start(ctx);
  await sleep(60);

  // A Save the service REFUSES (the path escapes the fence). The buffer holds
  // work that is not on disk, so it must stay dirty — it used to go clean the
  // moment the button was pressed, error and all.
  shadow.querySelector('[data-pathin]').value = '../escaped.txt';
  shadow.querySelector('[data-ta]').value = 'nope\n';
  shadow.querySelector('[data-ta]').dispatchEvent(new global.Event('input', { bubbles: true }));
  shadow.querySelector('[data-save]').dispatchEvent(new global.window.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  assert.match(errText(shadow), /outside the project root/);
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'escaped.txt')), false);
  assert.equal(dirtyShown(shadow), true, 'refused: the work is still only in the buffer');

  // ...and a Save the service RUNS settles it, on the echo of the very seq it ran.
  shadow.querySelector('[data-pathin]').value = 'notes.txt';
  shadow.querySelector('[data-save]').dispatchEvent(new global.window.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'nope\n');
  assert.equal(dirtyShown(shadow), false, 'the echo settled the buffer');
  assert.equal(errText(shadow), '');
});
