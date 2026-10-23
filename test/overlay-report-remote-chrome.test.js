// The report path's remote carrier in the real chrome (public/app/
// overlay-report-remote.js, annotation engine PLAN.md 2B.1; U312), booted once
// (test-support/chrome-shell) as a REMOTE page: /api/health says remote and
// carries the portal's X-WC-Answer-Origin, the mirror says full (as
// test/answer-surface-remote.test.js's and test/portal-answer.test.js's chrome
// cases set it up), and public/app/overlay-report.js is initialised through
// the shell's init hook (main.js does not initialise it yet).
//
//   * ONE hidden `elements` frame on the answer origin, at /answer/elements/
//     report?layout=report with the tab's viewer id; its container a hidden
//     stand-in, nothing drawn;
//   * overlay-report's transport is the frame's: the first answers go to the
//     frame once it says it listens (READY), checked against its origin and
//     contentWindow; the socket's sent frames carry no `report`;
//   * EXPIRED from the frame mounts a fresh one and the recent batches go again;
//   * at read the frame and the transport are taken down; on a local page
//     (remote.js says local) nothing is mounted or registered;
//   * the per-tab viewer id (K.2-56) is sent as the client field `viewer` and
//     kept in sessionStorage; the chrome's channel names equal the frame's.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { bootShell, respond, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const AORIGIN = 'https://wc-0a1b2c3d-a.example.com';
const N = 12;
const rowText = (id, i) => `${id}: row ${['harbor', 'quartz', 'lantern', 'meadow', 'cobalt', 'tundra'][i % 6]} ${i * 7} ${['ember', 'saffron', 'glacier'][i % 3]}`;
const FIX = (id) => ({ id, target: 'main', params: {}, gen: 0, html: `<div class="list">${Array.from({ length: N }, (_, i) => `<div class="it">${rowText(id, i)}</div>`).join('')}</div>` });

let shell, W, rep, inst, R, anchors;
let access = { level: 'full', remote: true };
let rev = 9000;
const snapshot = () => ({
  v: 1, enabled: true, now: Date.now(), rev: ++rev, content: true, access, capabilities: {},
  primary: null, aggregate: { state: 'idle' }, conversations: [], tasks: [], asks: [],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = () => [...W.document.querySelectorAll('iframe.wc-answer-frame[data-kind="elements"]')];
const reportsOnSocket = () => shell.sockets.flatMap((s) => s.frames('report'));
// The frame's first message, as answer.js posts it: its size (asks.js's 3 s
// load check remounts a silent frame).
const sized = (f) => W.dispatchEvent(new W.MessageEvent('message', { data: { type: 'wc-answer:size', height: 22 }, origin: AORIGIN, source: f.contentWindow }));

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/health': respond({ ok: true, remote: true }, { headers: { 'X-WC-Answer-Origin': AORIGIN } }),
      '/api/mirror': () => snapshot(),
      '/api/asks': () => ({ asks: [], answer: null }),
    },
    init: async (sh) => {
      rep = await sh.importApp('overlay-report.js');
      inst = rep.initOverlayReport();
    },
  });
  W = shell.window;
  R = await shell.importApp('overlay-report-remote.js');
  anchors = (await shell.importApp('anchors.js')).default;
});

after(async () => { if (inst) inst.stop(); if (shell) await shell.restore(); });

test('at full: ONE hidden elements frame on the answer origin, with the tab\'s viewer id; a hidden stand-in container, nothing drawn', async () => {
  await shell.frame(helloFrame({ mounts: [FIX('pa')], surface: 2000, elements: [] }));
  await waitUntil(() => frames().length === 1, { timeout: 5000, what: 'the elements frame' });
  sized(frames()[0]);
  await sleep(50);
  assert.equal(frames().length, 1, 'one frame');
  const [f] = frames();
  const u = new URL(f.src);
  assert.equal(u.origin, AORIGIN);
  assert.equal(u.pathname, '/answer/elements/report');
  assert.equal(u.searchParams.get('layout'), 'report');
  assert.equal(u.searchParams.get('viewer'), R.tabViewerId());
  assert.match(R.tabViewerId(), R.VIEWER_RE);
  assert.equal(f.title, 'web-chat reports');
  const box = f.parentElement;
  assert.equal(box.hidden, true, 'the container is hidden');
  assert.equal(box.dataset.wcStandIn, 'elements-report');
  assert.equal(box.parentElement, W.document.body);
  assert.equal(box.children.length, 1, 'nothing but the frame');
  // The viewer id rides the client frame and is kept for the tab.
  const client = shell.socket().frames('client').at(-1);
  assert.equal(client.viewer, R.tabViewerId());
  assert.equal(W.sessionStorage.getItem(R.VIEWER_KEY), R.tabViewerId());
});

test('the transport is the frame\'s: the answers wait for READY, then go to its contentWindow at its origin; the socket carries no report', async () => {
  const [f] = frames();
  const cw = f.contentWindow;
  const got = [];
  cw.postMessage = (msg, target) => { got.push({ msg, target }); };
  // The pane's anchored elements, as a reset carries them: the overlay resolves
  // them and overlay-report hands the batch to the transport.
  const root = W.__wcMount.itemEl(W.document, 'pa').el.shadowRoot;
  const els = [...root.querySelectorAll('.it')];
  const elements = [0, 5, 9].map((i) => ({ id: `c${i}`, v: 1, type: 'comment', anchor: anchors.record(root, els[i], { mount: 'pa' }), shared: true, replies: 0 }));
  await shell.frame({ type: 'reset', mounts: [FIX('pa')], store: {}, active: 'n1', lock: null, surface: 2001, elements });
  await waitUntil(() => inst.stats().messages >= 1, { timeout: 6000, what: 'a batch handed to the transport' });
  assert.equal(got.length, 0, 'nothing posted before the frame says it listens');
  // READY from another window, or from the frame at another origin: ignored.
  W.dispatchEvent(new W.MessageEvent('message', { data: { channel: R.READY_CHANNEL }, origin: AORIGIN, source: W }));
  W.dispatchEvent(new W.MessageEvent('message', { data: { channel: R.READY_CHANNEL }, origin: 'https://evil.example', source: cw }));
  assert.equal(got.length, 0);
  W.dispatchEvent(new W.MessageEvent('message', { data: { channel: R.READY_CHANNEL }, origin: AORIGIN, source: cw }));
  assert.ok(got.length >= 1, 'the queued batch went on READY');
  for (const g of got) {
    assert.equal(g.target, AORIGIN);
    assert.equal(g.msg.channel, R.REPORT_CHANNEL);
    assert.equal(g.msg.report.surface, 2001);
    assert.equal('type' in g.msg.report, false, 'the message less its type');
  }
  const ids = got.flatMap((g) => g.msg.report.mounts.flatMap((m) => m.items.map((i) => i.id))).sort();
  assert.deepEqual(ids, ['c0', 'c5', 'c9']);
  assert.deepEqual(reportsOnSocket(), [], 'no report on the socket');
  assert.equal(inst.stats().remote_dropped, 0);
});

test('EXPIRED from the frame mounts a fresh one, and the recent batches go again once it is READY', async () => {
  const [old] = frames();
  W.dispatchEvent(new W.MessageEvent('message', { data: { channel: R.EXPIRED_CHANNEL }, origin: AORIGIN, source: old.contentWindow }));
  await waitUntil(() => frames().length === 1 && frames()[0] !== old, { timeout: 3000, what: 'a fresh frame' });
  const [f] = frames();
  sized(f);
  assert.equal(new URL(f.src).searchParams.get('viewer'), R.tabViewerId(), 'the same viewer');
  const got = [];
  f.contentWindow.postMessage = (msg, target) => { got.push({ msg, target }); };
  W.dispatchEvent(new W.MessageEvent('message', { data: { channel: R.READY_CHANNEL }, origin: AORIGIN, source: f.contentWindow }));
  assert.ok(got.length >= 1, 'the recent batch went again');
  assert.equal(got[0].msg.channel, R.REPORT_CHANNEL);
  // A second EXPIRED inside REMOUNT_MIN_MS waits; the frame stays as it is.
  W.dispatchEvent(new W.MessageEvent('message', { data: { channel: R.EXPIRED_CHANNEL }, origin: AORIGIN, source: f.contentWindow }));
  await sleep(50);
  assert.equal(frames()[0], f, 'no remount inside the window');
});

test('at read the frame and the transport go; nothing more is handed to a frame', async () => {
  access = { level: 'read', remote: true };
  await shell.frame(helloFrame({ mounts: [FIX('pa')], surface: 2002, elements: [] }));
  await waitUntil(() => frames().length === 0, { timeout: 5000, what: 'the frame taken down below full' });
  assert.equal(W.document.querySelectorAll('[data-wc-stand-in="elements-report"]').length, 0, 'the container went too');
  access = { level: 'full', remote: true };
  await shell.frame(helloFrame({ mounts: [FIX('pa')], surface: 2003, elements: [] }));
  await waitUntil(() => frames().length === 1, { timeout: 5000, what: 'mounted again at full' });
  sized(frames()[0]);
});

test('on a local page, or with no answer origin, nothing is mounted or registered', async () => {
  const before = frames().length;
  for (const remote of [
    { isRemote: async () => false, remoteKnown: () => true, remoteNow: () => false, answerOrigin: () => null },
    { isRemote: async () => true, remoteKnown: () => true, remoteNow: () => true, answerOrigin: () => null },
  ]) {
    let registered = 0;
    const stop = R.initRemoteReports({ setTransport: () => { registered += 1; return () => {}; }, viewer: R.tabViewerId(), remote, mayAct: () => true });
    await sleep(20);
    assert.equal(registered, 0);
    assert.equal(frames().length, before, 'no frame');
    stop();
  }
  // Remote with an origin but below full: nothing either.
  let registered = 0;
  const stop = R.initRemoteReports({ setTransport: () => { registered += 1; return () => {}; }, mayAct: () => false });
  await sleep(20);
  assert.equal(registered, 0);
  stop();
});

test('the chrome\'s channel names and viewer grammar are the frame\'s', async () => {
  const F = await import(pathToFileURL(path.join(__dirname, '..', 'lib/server/answer-surface/public/elements-report.js')).href);
  for (const k of ['REPORT_CHANNEL', 'READY_CHANNEL', 'EXPIRED_CHANNEL']) assert.equal(R[k], F[k], k);
  const { VIEWER_RE } = require('../lib/server/domain/reports-remote');
  assert.equal(String(R.VIEWER_RE), String(VIEWER_RE));
  assert.equal(String(F.VIEWER_RE), String(VIEWER_RE), 'the frame module keys a tab by the daemon\'s grammar');
});
