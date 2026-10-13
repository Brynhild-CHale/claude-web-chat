// The control frame's two layouts (lib/server/answer-surface/public/
// control-stop.js and control-confirm.js, spec §15.5, §15.2, §4.5 'The control
// frame') in jsdom, booted through U56's runtime (answer.js boot) into the real
// index.html, and their stylesheet (answer.css's U85 section).
//
//   * stop: the label follows the state view; a click inside the dwell or the
//     cooldown, an untrusted one, or one without user activation posts
//     nothing; a valid click POSTs {conversation_id, mode: 'now'} with the
//     nonce; 'Interrupting…' until the state view says interrupted for THIS
//     request, then 'Interrupted' and ONE done; no confirmation in 3 s (fake
//     timers) → 'Stop after this step', posting mode 'after-step'; a refusal's
//     hint, briefly; no visibility observer consulted, never the popup.
//   * confirm: the summary from wc-control, set with textContent; the button
//     stays disabled without the visibility proof in a Chromium-like stub, and
//     is the popup without one; the fit rule offers Review ›; after a restore
//     the counts and the residual paths, after a fork the command with Copy;
//     ONE done, never carrying a restore id or a command; Keep posts nothing;
//     a popup's result comes back to the frame that opened it.
//   * the done outcomes (B-confirm (4)): stop posts only 'interrupted', confirm
//     only 'restored', 'failed', 'undone', 'forked', 'refused' or — any other
//     action's ok answer, the mod's rows (U89, ruling F6 Q-B3 (a)) — 'done',
//     whose `said` line shows inside the frame only.
//   * answer.css: the layouts paint only palette.css's tokens (U55's frame
//     palette, ruling A6 (b)), each ink on a measured fill, every pair passing
//     4.5:1 (text) or 3:1 (controls) by contrastRatio IMPORTED from palette.js,
//     in every built-in pack and the fallback, light and dark; no file of this
//     unit defines a contrast or luminance function.
//
// jsdom's events are never trusted, so a trusted click wraps the page's own
// click listeners (the page still reads event.isTrusted). Real clicks in a real
// browser are test/answer-control-e2e.test.js's (opt-in).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

const { contrastRatio, FRAME_TEXT, FRAME_UI, TEXT_MIN, UI_MIN, renderPalette } = require('../lib/server/answer-surface/palette');
const { PACKS } = require('../lib/server/theme-packs');
const { flattenTheme, MODES } = require('../lib/server/theme');
const { tmpRoot } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const PUB = path.join(REPO, 'lib/server/answer-surface/public');
const ORIGIN = 'http://127.0.0.1:47124';
const NONCE = 'control-nonce-for-this-load';
const UUID = '0b7c1d2e-3f40-4a51-8b62-7c83d94ea5f6';

let A, STOP, CONFIRM;
test.before(async () => {
  A = await import(pathToFileURL(path.join(PUB, 'answer.js')).href);
  STOP = await import(pathToFileURL(path.join(PUB, 'control-stop.js')).href);
  CONFIRM = await import(pathToFileURL(path.join(PUB, 'control-confirm.js')).href);
});

// ── the harness ─────────────────────────────────────────────────────────────

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// The real index.html as the surface serves it (one pass), minus its script.
function pageHtml(meta) {
  const values = {
    NONCE, MODE: 'light', KIND: 'control',
    META: meta ? `<meta name="wc-control" content="${escAttr(JSON.stringify(meta))}">` : '',
  };
  return fs.readFileSync(path.join(PUB, 'index.html'), 'utf8')
    .replace(/\{\{(NONCE|MODE|KIND|META)\}\}/g, (_, k) => values[k])
    .replace(/<script[^>]*><\/script>/g, '');
}

function trustClicks(W) {
  const trust = { on: false };
  const proto = W.EventTarget.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  const wrapped = new WeakMap();
  proto.addEventListener = function addEventListener(type, fn, opts) {
    if (type !== 'click' || typeof fn !== 'function') return add.call(this, type, fn, opts);
    const w = function trusted(e) {
      if (!trust.on) return fn.call(this, e);
      const p = new Proxy(e, {
        get(t, k) {
          if (k === 'isTrusted') return true;
          const v = Reflect.get(t, k, t);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      return fn.call(this, p);
    };
    wrapped.set(fn, w);
    return add.call(this, type, w, opts);
  };
  proto.removeEventListener = function removeEventListener(type, fn, opts) {
    return remove.call(this, type, (fn && wrapped.get(fn)) || fn, opts);
  };
  return trust;
}

// A Chromium-like IntersectionObserver v2; every construction is recorded.
function stubVisibility(W) {
  const observers = [];
  W.IntersectionObserverEntry = class IntersectionObserverEntry { get isVisible() { return true; } };
  W.IntersectionObserver = class IntersectionObserver {
    constructor(cb, opts) { this.cb = cb; this.opts = opts; this.target = null; observers.push(this); }
    observe(t) { this.target = t; }
    disconnect() { this.target = null; }
  };
  return {
    observers,
    report(entry = { intersectionRatio: 1, isVisible: true }) {
      for (const o of observers) if (o.target) o.cb([{ target: o.target, ...entry }]);
    },
  };
}

// Timers the test fires by hand: recorded, never run on their own.
function fakeTimers(W) {
  const pending = new Map();
  let n = 0;
  W.setTimeout = (fn, ms) => { const id = ++n; pending.set(id, { fn, ms }); return id; };
  W.clearTimeout = (id) => { pending.delete(id); };
  return {
    pending: () => [...pending.values()].map((t) => t.ms),
    fire(ms) { for (const [id, t] of [...pending]) if (t.ms === ms) { pending.delete(id); t.fn(); } },
  };
}

// A page in jsdom: the real document, the runtime booted into it.
async function openPage(t, { action = 'interrupt', layout = 'stop', query = '', meta, fetch, proof = false,
  activation = true, framed = true, opener = null } = {}) {
  const href = `${ORIGIN}/answer/control/${action}?${query}${query ? '&' : ''}layout=${layout}&mode=light&device=desktop`;
  const dom = new JSDOM(pageHtml(meta), { url: href, pretendToBeVisual: true });
  const W = dom.window;
  const trust = trustClicks(W);
  const vis = proof ? stubVisibility(W) : null;
  const timers = fakeTimers(W);
  Object.defineProperty(W.navigator, 'userActivation', { value: { isActive: activation, hasBeenActive: activation }, configurable: true });
  const posts = [];
  const parent = new JSDOM('', { url: 'http://127.0.0.1:5173/' }).window;
  parent.postMessage = (msg, target) => { posts.push({ msg, target }); };
  if (framed) Object.defineProperty(W, 'parent', { value: parent, configurable: true });
  if (opener) Object.defineProperty(W, 'opener', { value: opener, configurable: true });
  const opened = [];
  const popupWin = { closed: false };
  W.open = (...args) => { opened.push(args); return popupWin; };
  const calls = [];
  W.fetch = async (u, init = {}) => {
    calls.push({ url: String(u), init, body: init.body ? JSON.parse(init.body) : null });
    return fetch(String(u), init);
  };
  const clock = { t: 10_000 };
  const handle = await A.boot(W, { now: () => clock.t });
  t.after(() => { try { handle.stop(); } catch {} W.close(); parent.close(); });
  return { W, doc: W.document, handle, trust, vis, timers, posts, opened, popupWin, calls, clock };
}

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const HANG = () => new Promise(() => {});
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const $ = (doc, sel) => doc.querySelector(sel);
const posted = (p) => p.calls.filter((c) => c.init && c.init.method === 'POST');
const dones = (p) => p.posts.filter((x) => x.msg && x.msg.type === 'wc-answer:done').map((x) => x.msg);
const sizes = (p) => p.posts.filter((x) => x.msg && x.msg.type === 'wc-answer:size').map((x) => x.msg.height);

function click(p, el, { trusted = true, detail = 1 } = {}) {
  p.trust.on = trusted;
  try { el.dispatchEvent(new p.W.MouseEvent('click', { bubbles: true, cancelable: true, detail })); } finally { p.trust.on = false; }
}
function pointerIn(p, el) { el.dispatchEvent(new p.W.Event('pointerover', { bubbles: true })); }

// ── the stop layout's server, stubbed ───────────────────────────────────────

const stateView = (over = {}) => ({
  v: 1, conversation_id: 'c1', state: 'working', active: true, waiting: false, path: 'tty', label: 'Interrupt', last: null, ...over,
});
// The first state read answers `first`; each long-poll waits for the test's
// next push(view). POSTs answer `post` (a function of the body).
function stopServer({ first = stateView(), post = () => json({ ok: true, accepted: true, via: 'tty', request_id: 'ci_1' }) } = {}) {
  const polls = [];
  const s = {
    polls,
    fetch(u, init) {
      if (init && init.method === 'POST') return post(JSON.parse(init.body), u);
      if (!/[?&]v=/.test(u)) return json(first);
      return new Promise((r) => polls.push(r));
    },
    push(view) { const r = polls.shift(); assert.ok(r, 'a long-poll is waiting'); r(json(view)); },
  };
  return s;
}
const DESC = { title: 'fix the flaky tests', summary: 'Interrupt Claude in this conversation' };
const stopPage = (t, server, opts = {}) => openPage(t, { query: 'conversation_id=c1&size=bar', meta: DESC, fetch: server.fetch, ...opts });
// The pointer in for the dwell, the cooldown over.
function ready(p, el) { pointerIn(p, el); p.clock.t += 1000; }

/* ══ stop ════════════════════════════════════════════════════════════════════ */

test('stop: the label follows the state view; the title names the conversation and, while waiting, that Stop declines the prompt', async (t) => {
  const server = stopServer({ first: stateView({ label: 'Stop after this step', path: 'hook', waiting: true }) });
  const p = await stopPage(t, server);
  await settle();
  const btn = $(p.doc, 'button.ct-stop-btn');
  assert.equal(btn.textContent, 'Stop after this step');
  assert.match(btn.title, /^Stop after this step — fix the flaky tests\. /);
  assert.match(btn.title, /Stop declines it/);
  assert.equal(btn.getAttribute('aria-disabled'), 'false');
  assert.equal(p.doc.documentElement.dataset.layout, 'stop');
  assert.equal(p.doc.documentElement.dataset.size, 'bar');
  server.push(stateView({ v: 2, label: 'Interrupt', path: 'tty', waiting: false }));
  await settle();
  assert.equal(btn.textContent, 'Interrupt', 'a new view relabels it');
  assert.equal(btn.title, 'Interrupt — fix the flaky tests', 'not waiting: nothing about a prompt');
  assert.equal(sizes(p).at(-1), 22, 'the bar slot\'s height');
  const st = p.calls.filter((c) => !c.init.method || c.init.method === 'GET').map((c) => c.url);
  assert.equal(st[0], '/answer/api/control/state?action=interrupt&conversation_id=c1', 'the state read');
  assert.match(st[1], /&v=1&wait=20000$/, 'then long-polled on its version');
  for (const c of p.calls) assert.equal(c.init.headers['X-WC-Answer'], NONCE, 'every read carries the nonce');
});

test('stop: inside the dwell, inside the cooldown, untrusted, or without user activation, a click posts nothing', async (t) => {
  const server = stopServer();
  const p = await stopPage(t, server);
  await settle();
  const btn = $(p.doc, 'button.ct-stop-btn');
  click(p, btn);
  assert.equal(posted(p).length, 0, 'no pointer dwell yet');
  pointerIn(p, btn);
  p.clock.t += 200;
  click(p, btn);
  assert.equal(posted(p).length, 0, 'inside the 300 ms dwell');
  p.clock.t += 1000;
  p.W.dispatchEvent(new p.W.Event('focus'));     // the window regained focus: a fresh cooldown
  click(p, btn);
  assert.equal(posted(p).length, 0, 'inside the 600 ms cooldown');
  p.clock.t += 700;
  click(p, btn, { trusted: false });
  assert.equal(posted(p).length, 0, 'an untrusted click');
  Object.defineProperty(p.W.navigator, 'userActivation', { value: { isActive: false }, configurable: true });
  click(p, btn);
  assert.equal(posted(p).length, 0, 'no user activation');
  Object.defineProperty(p.W.navigator, 'userActivation', { value: { isActive: true }, configurable: true });
  click(p, btn);
  assert.equal(posted(p).length, 1, 'now it posts');
});

test('stop: a valid click POSTs mode now with the nonce; Interrupting… until the state view confirms THIS request; then Interrupted and ONE done', async (t) => {
  const server = stopServer();
  const p = await stopPage(t, server);
  await settle();
  const btn = $(p.doc, 'button.ct-stop-btn');
  ready(p, btn);
  click(p, btn);
  await settle();
  const [post] = posted(p);
  assert.equal(post.url, '/answer/api/control/interrupt?device=desktop');
  assert.deepEqual(post.body, { conversation_id: 'c1', mode: 'now' });
  assert.equal(post.init.headers['X-WC-Answer'], NONCE);
  assert.equal(post.init.headers['Content-Type'], 'application/json');
  assert.equal(btn.textContent, 'Interrupting…');
  assert.equal(btn.getAttribute('aria-disabled'), 'true');
  click(p, btn);
  assert.equal(posted(p).length, 1, 'a second click while interrupting posts nothing');
  assert.deepEqual(p.timers.pending().filter((ms) => ms === STOP.CONFIRM_MS), [3000], 'one 3 s wait for the confirmation');
  // Another request's outcome is not this one's.
  server.push(stateView({ v: 2, last: { request_id: 'ci_other', via: 'tty', at: 1, outcome: 'interrupted' } }));
  await settle();
  assert.equal(btn.textContent, 'Interrupting…', 'another request\'s confirmation does not count');
  server.push(stateView({ v: 3, last: { request_id: 'ci_1', via: 'tty', at: 1, outcome: 'pending' } }));
  await settle();
  assert.equal(btn.textContent, 'Interrupting…', 'pending is not a confirmation');
  assert.deepEqual(dones(p), []);
  server.push(stateView({ v: 4, state: 'idle', active: false, last: { request_id: 'ci_1', via: 'tty', at: 1, outcome: 'interrupted' } }));
  await settle();
  assert.equal(btn.textContent, 'Interrupted');
  assert.equal(btn.getAttribute('aria-disabled'), 'true');
  assert.deepEqual(dones(p), [{ type: 'wc-answer:done', id: 'interrupt', outcome: 'interrupted' }], 'one done, the outcome alone');
  assert.deepEqual(p.timers.pending().filter((ms) => ms === STOP.CONFIRM_MS), [], 'the 3 s wait is cleared');
  server.push(stateView({ v: 5, state: 'idle', active: false, last: { request_id: 'ci_1', via: 'tty', at: 1, outcome: 'interrupted' } }));
  await settle();
  assert.equal(dones(p).length, 1, 'never a second done');
});

test('stop: no confirmation within 3 s → Stop after this step, behind a fresh cooldown, posting mode after-step', async (t) => {
  let n = 0;
  const server = stopServer({ post: () => json({ ok: true, accepted: true, via: n++ ? 'hook' : 'tty', request_id: `ci_${n}` }) });
  const p = await stopPage(t, server);
  await settle();
  const btn = $(p.doc, 'button.ct-stop-btn');
  ready(p, btn);
  click(p, btn);
  await settle();
  assert.equal(btn.textContent, 'Interrupting…');
  p.timers.fire(STOP.CONFIRM_MS);
  assert.equal(btn.textContent, 'Stop after this step');
  assert.equal(btn.getAttribute('aria-disabled'), 'false');
  click(p, btn);
  assert.equal(posted(p).length, 1, 'the fallback has its own cooldown: an echo of the first click does nothing');
  p.clock.t += 700;
  click(p, btn);
  await settle();
  assert.deepEqual(posted(p)[1].body, { conversation_id: 'c1', mode: 'after-step' });
  assert.equal(btn.textContent, 'Stopping after this step…');
  assert.equal(btn.getAttribute('aria-disabled'), 'true');
  server.push(stateView({ v: 2, last: { request_id: 'ci_2', via: 'hook', at: 2, outcome: 'interrupted' } }));
  await settle();
  assert.equal(btn.textContent, 'Interrupted');
  assert.deepEqual(dones(p).map((d) => d.outcome), ['interrupted']);
});

test('stop: a request the server sends down the hook path offers nothing more; a refusal shows its hint briefly', async (t) => {
  const answers = [
    json({ ok: true, accepted: true, via: 'hook', request_id: 'ci_h' }),
  ];
  const server = stopServer({ post: () => answers.shift() || json({ ok: false, refused: 'not-busy', hint: 'x' }, 409) });
  const p = await stopPage(t, server, { query: 'conversation_id=c1&size=panel' });
  await settle();
  assert.equal(sizes(p).at(-1), 28, 'the panel slot\'s height');
  const btn = $(p.doc, 'button.ct-stop-btn');
  ready(p, btn);
  click(p, btn);
  await settle();
  assert.equal(btn.textContent, 'Stopping after this step…');
  assert.deepEqual(p.timers.pending().filter((ms) => ms === STOP.CONFIRM_MS), [], 'no fallback to offer');

  // A fresh page, refused.
  const server2 = stopServer({ post: () => json({ ok: false, refused: 'rate_limited', hint: 'wait' }, 429) });
  const q = await stopPage(t, server2, { query: 'conversation_id=c1&size=sheet' });
  await settle();
  assert.equal(sizes(q).at(-1), 44, 'the sheet header\'s height');
  const b2 = $(q.doc, 'button.ct-stop-btn');
  ready(q, b2);
  click(q, b2);
  await settle();
  assert.equal(b2.textContent, 'Just stopped — wait a moment');
  assert.equal(b2.getAttribute('aria-disabled'), 'true');
  q.timers.fire(STOP.HINT_MS);
  assert.equal(b2.textContent, 'Interrupt', 'back to its label');
  assert.deepEqual(dones(q), [], 'a refusal is never a done');
});

test('stop: no visibility observer is consulted, even where one exists, and no popup ever opens', async (t) => {
  const server = stopServer({ post: () => json({ ok: false, refused: 'not-busy', hint: 'x' }, 409) });
  const p = await stopPage(t, server, { proof: true });
  await settle();
  assert.equal(p.handle.rt.proof, true, 'a Chromium-like page');
  assert.deepEqual(p.vis.observers, [], 'no IntersectionObserver made');
  const btn = $(p.doc, 'button.ct-stop-btn');
  ready(p, btn);
  click(p, btn);
  await settle();
  assert.equal(posted(p).length, 1, 'no visibility proof needed');
  assert.equal(btn.textContent, 'Claude is not working now');
  assert.deepEqual(p.opened, [], 'never the popup');
  assert.equal(p.doc.querySelector('.aw-popup, .ct-review'), null);
});

test('stop: a document naming no conversation draws no button and reads nothing', async (t) => {
  const p = await openPage(t, { query: 'size=bar', meta: DESC, fetch: () => { throw new Error('no request'); } });
  await settle();
  assert.equal($(p.doc, 'button'), null);
  assert.equal(p.doc.getElementById('wc-answer').textContent, STOP.UNAVAILABLE);
  assert.deepEqual(p.calls, []);
  assert.equal(sizes(p).at(-1), 22);
});

/* ══ confirm ═════════════════════════════════════════════════════════════════ */

const RESTORE_DESC = { title: 'Restore files', summary: 'Restore 3 files to before turn n1.4: <b>2 rewritten</b> · 1 deleted', lines: ['M src/a.js', 'D src/b.js'] };
const confirmPage = (t, { action = 'restore', query = 'preview=pv_1', meta = RESTORE_DESC, post, ...rest } = {}) => openPage(t, {
  action, layout: 'confirm', query, meta, fetch: (u, init) => (init && init.method === 'POST' ? post(JSON.parse(init.body), u) : HANG()), ...rest,
});
// Fit: jsdom measures 0 everywhere, so the document fits unless told otherwise.
function readyConfirm(p) {
  p.vis.report();
  pointerIn(p, $(p.doc, '.ct-act'));
  p.clock.t += 1000;
}

test('confirm: the subject comes from wc-control as text; without the proof the action stays disabled; with it a click POSTs the document\'s own target', async (t) => {
  let answer = json({ ok: true, restore_id: 'rs_secret1', counts: { rewritten: 2, recreated: 0, deleted: 1, not_covered: 0 }, headMoved: false, residual: [] });
  const p = await confirmPage(t, { proof: true, post: () => answer });
  const doc = p.doc;
  assert.equal($(doc, '.ct-title').textContent, 'Restore files');
  assert.equal($(doc, '.ct-summary').textContent, RESTORE_DESC.summary, 'markup in the summary stays text');
  assert.equal(doc.querySelector('.ct-summary b'), null);
  assert.deepEqual([...doc.querySelectorAll('.ct-lines li')].map((l) => l.textContent), RESTORE_DESC.lines);
  const act = $(doc, '.ct-act');
  assert.equal(act.textContent, 'Restore files');
  assert.equal(p.vis.observers.length, 1, 'one observer');
  assert.ok(p.vis.observers[0].target.contains($(doc, '.ct-summary')) && p.vis.observers[0].target.contains(act),
    'on ONE container holding the summary and the button');
  assert.deepEqual(p.vis.observers[0].opts, { trackVisibility: true, delay: 100, threshold: [1] });
  pointerIn(p, act);
  p.clock.t += 1000;
  click(p, act);
  assert.equal(act.getAttribute('aria-disabled'), 'true', 'no visibility proof yet: disabled');
  assert.equal(posted(p).length, 0, 'and a click does nothing');
  p.vis.report({ intersectionRatio: 0.9, isVisible: true });
  p.clock.t += 1000;
  click(p, act);
  assert.equal(posted(p).length, 0, 'covered');
  assert.equal($(doc, '.ct-guard').hidden, false, 'it says so');
  p.vis.report();
  p.clock.t += 1000;
  p.vis.report();
  assert.equal(act.getAttribute('aria-disabled'), 'false');
  click(p, act);
  await settle();
  const [post] = posted(p);
  assert.equal(post.url, '/answer/api/control/restore?device=desktop');
  assert.deepEqual(post.body, { preview: 'pv_1' }, 'the target params, never the surface\'s keys');
  assert.equal(post.init.headers['X-WC-Answer'], NONCE);
  // The result, in the frame.
  assert.equal($(doc, '.ct-box').hidden, true);
  assert.equal($(doc, '.ct-result').hidden, false);
  assert.equal($(doc, '.ct-outcome').textContent, 'Restored: 2 rewritten · 0 re-created · 1 deleted · 0 not covered');
  assert.deepEqual(dones(p), [{ type: 'wc-answer:done', id: 'restore', outcome: 'restored', result: { rewritten: 2, recreated: 0, deleted: 1, not_covered: 0 } }]);
  assert.ok(!JSON.stringify(p.posts).includes('rs_secret1'), 'the chrome never learns the restore id');
  answer = null;
});

test('confirm: without IntersectionObserver v2 the action is the popup, opening this document\'s confirm layout', async (t) => {
  const p = await confirmPage(t, { post: () => json({ ok: true }) });
  const act = $(p.doc, '.ct-act');
  assert.equal(act.textContent, CONFIRM.POPUP_LABEL);
  assert.equal(act.getAttribute('aria-disabled'), 'false');
  click(p, act, { trusted: false });
  assert.deepEqual(p.opened, [], 'not from an untrusted click');
  click(p, act);
  assert.equal(p.opened.length, 1);
  const [url, target, features] = p.opened[0];
  assert.equal(url, '/answer/control/restore?preview=pv_1&layout=confirm&mode=light&device=desktop');
  assert.equal(target, '_blank');
  assert.equal(features, 'popup,width=460,height=600');
  assert.equal(posted(p).length, 0, 'the frame itself posts nothing');
  assert.equal($(p.doc, '.ct-problem').textContent, 'Continue in the window that opened');
});

test('confirm: a document that does not fit its frame keeps the action disabled and offers Review ›', async (t) => {
  const p = await confirmPage(t, { proof: true, post: () => json({ ok: true }) });
  const de = p.doc.documentElement;
  Object.defineProperty(de, 'scrollHeight', { value: 400, configurable: true });
  Object.defineProperty(p.W, 'innerHeight', { value: 60, configurable: true });
  readyConfirm(p);
  p.vis.report();
  p.W.dispatchEvent(new p.W.Event('resize'));
  const act = $(p.doc, '.ct-act');
  const review = $(p.doc, '.ct-review');
  assert.equal($(p.doc, '.ct').dataset.fit, '0');
  assert.equal(act.getAttribute('aria-disabled'), 'true');
  assert.equal(review.hidden, false);
  click(p, act);
  assert.equal(posted(p).length, 0);
  click(p, review);
  assert.match(p.opened[0][0], /layout=confirm/);
});

test('confirm: a residual restore shows the paths left and that Undo puts everything back; one done, failed, counts only', async (t) => {
  const p = await confirmPage(t, { proof: true, post: () => json({
    ok: false, refused: 'residual', hint: 'some files changed', restore_id: 'rs_secret2',
    counts: { rewritten: 1, recreated: 0, deleted: 0, not_covered: 0 }, residual: [{ path: 'src/<i>x</i>.js', reason: 'changed' }],
  }, 409) });
  readyConfirm(p);
  p.vis.report();
  click(p, $(p.doc, '.ct-act'));
  await settle();
  const text = $(p.doc, '.ct-result').textContent;
  assert.match(text, /Not everything was put back: 1 rewritten/);
  assert.match(text, /src\/<i>x<\/i>\.js \(changed\)/, 'a path, as text');
  assert.equal(p.doc.querySelector('.ct-result i'), null);
  assert.match(text, /Undo puts everything back/);
  assert.deepEqual(dones(p), [{ type: 'wc-answer:done', id: 'restore', outcome: 'failed', result: { rewritten: 1, recreated: 0, deleted: 0, not_covered: 0, residual: 1 } }]);
  assert.ok(!JSON.stringify(p.posts).includes('rs_secret2'));
  assert.ok(!JSON.stringify(p.posts).includes('src/'), 'never a path to the chrome');
});

test('confirm: a fork shows the command with Copy — clipboard where allowed, else selected — and the chrome never sees it', async (t) => {
  const command = `claude --resume ${UUID}`;
  const p = await confirmPage(t, {
    action: 'fork', query: `turn_id=t_7`, meta: { title: 'Fork from here', summary: 'Fork this conversation from before turn n1.4.' },
    proof: true, post: () => json({ ok: true, session_id: UUID, command }),
  });
  const copied = [];
  Object.defineProperty(p.W.navigator, 'clipboard', { value: { writeText: async (s) => { copied.push(s); } }, configurable: true });
  readyConfirm(p);
  p.vis.report();
  click(p, $(p.doc, '.ct-act'));
  await settle();
  assert.deepEqual(posted(p)[0].body, { turn_id: 't_7' });
  assert.equal($(p.doc, '.ct-outcome').textContent, 'Forked');
  assert.equal($(p.doc, '.ct-code').textContent, command);
  const copy = $(p.doc, '.ct-copy');
  click(p, copy, { trusted: false });
  await settle();
  assert.deepEqual(copied, [], 'an untrusted click copies nothing');
  click(p, copy);
  await settle();
  assert.deepEqual(copied, [command]);
  assert.equal($(p.doc, '.ct-note').textContent, 'Copied');
  assert.deepEqual(dones(p), [{ type: 'wc-answer:done', id: 'fork', outcome: 'forked' }], 'done carries no command and no id');
  assert.ok(!JSON.stringify(p.posts).includes(UUID));

  // No clipboard: the command is selected for ⌘C.
  Object.defineProperty(p.W.navigator, 'clipboard', { value: undefined, configurable: true });
  click(p, copy);
  await settle();
  assert.equal(String(p.W.getSelection()), command);
  assert.match($(p.doc, '.ct-note').textContent, /press ⌘C/);
});

test('confirm: undo answers undone; a refusal answers refused with its hint; an expired nonce says so; Keep posts nothing', async (t) => {
  const u = await confirmPage(t, { action: 'undo', query: 'restore=latest', meta: { title: 'Undo', summary: 'Undo the restore of 3 files' },
    proof: true, post: () => json({ ok: true, restore_id: 'rs_3', undo_of: 'rs_2', counts: { rewritten: 3 } }) });
  readyConfirm(u);
  u.vis.report();
  click(u, $(u.doc, '.ct-act'));
  await settle();
  assert.deepEqual(posted(u)[0].body, { restore: 'latest' });
  assert.equal($(u.doc, '.ct-outcome').textContent, 'Undone: 3 rewritten');
  assert.deepEqual(dones(u).map((d) => d.outcome), ['undone']);

  const r = await confirmPage(t, { proof: true, post: () => json({ ok: false, refused: 'busy', hint: 'Claude is working: wait for the turn to end' }, 409) });
  readyConfirm(r);
  r.vis.report();
  click(r, $(r.doc, '.ct-act'));
  await settle();
  assert.match($(r.doc, '.ct-result').textContent, /Claude is working: wait for the turn to end/);
  assert.deepEqual(dones(r), [{ type: 'wc-answer:done', id: 'restore', outcome: 'refused' }]);

  const x = await confirmPage(t, { proof: true, post: () => json({ ok: false, refused: 'nonce' }, 403) });
  readyConfirm(x);
  x.vis.report();
  click(x, $(x.doc, '.ct-act'));
  await settle();
  assert.match($(x.doc, '.ct-result').textContent, /expired/);

  const k = await confirmPage(t, { proof: true, post: () => { throw new Error('Keep must post nothing'); } });
  readyConfirm(k);
  k.vis.report();
  click(k, $(k.doc, '.ct-keep'));
  assert.equal($(k.doc, '.ct-problem').textContent, 'Kept — nothing was changed');
  assert.equal($(k.doc, '.ct-actions').hidden, true);
  click(k, $(k.doc, '.ct-act'));
  await settle();
  assert.equal(posted(k).length, 0);
  assert.deepEqual(dones(k), []);
});

test('confirm: a popup confirms in a top-level window and hands its result to the frame that opened it, on this origin only', async (t) => {
  // The popup: top-level, so no proof and no document-fit rule; its opener is the frame.
  const relayed = [];
  const opener = { postMessage: (msg, target) => relayed.push({ msg, target }) };
  const pop = await confirmPage(t, { framed: false, opener, post: () => json({ ok: true, restore_id: 'rs_9', counts: { rewritten: 1 } }) });
  const act = $(pop.doc, '.ct-act');
  assert.equal(act.textContent, 'Restore files', 'a top-level window acts in place');
  pointerIn(pop, act);
  pop.clock.t += 1000;
  click(pop, act);
  await settle();
  assert.equal(posted(pop).length, 1);
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].target, ORIGIN, 'to this origin only');
  assert.equal(relayed[0].msg.type, CONFIRM.RESULT_MESSAGE);
  assert.equal(relayed[0].msg.outcome, 'restored');

  // The frame that opened it: only that window, on this origin, is heard.
  const frame = await confirmPage(t, { post: () => json({ ok: true }) });
  click(frame, $(frame.doc, '.ct-act'));
  const send = (source, origin, data) => frame.W.dispatchEvent(new frame.W.MessageEvent('message', { data, origin, source }));
  send(frame.popupWin, 'http://127.0.0.1:5173', relayed[0].msg);
  send({}, ORIGIN, relayed[0].msg);
  assert.deepEqual(dones(frame), [], 'another origin, or another window, is ignored');
  send(frame.popupWin, ORIGIN, { ...relayed[0].msg, outcome: 'pwned' });
  assert.deepEqual(dones(frame), [], 'an outcome not of this layout is ignored');
  send(frame.popupWin, ORIGIN, relayed[0].msg);
  assert.equal($(frame.doc, '.ct-outcome').textContent, 'Restored: 1 rewritten');
  assert.deepEqual(dones(frame), [{ type: 'wc-answer:done', id: 'restore', outcome: 'restored', result: { rewritten: 1 } }]);
  assert.ok(!JSON.stringify(frame.posts).includes('rs_9'));
});

test('done outcomes: each layout names its own, once, and readAnswer maps every answer onto them', () => {
  assert.deepEqual([...STOP.STOP_OUTCOMES], ['interrupted']);
  assert.deepEqual([...CONFIRM.CONFIRM_OUTCOMES], ['restored', 'failed', 'undone', 'forked', 'refused', 'done']);
  const cases = [
    ['task-stop', 200, { ok: true, via: 'mod', said: 'Stopping — the row confirms when the task ends' }, 'done'],
    ['resume', 200, { ok: true, via: 'mod', said: 'Switched' }, 'done'],
    ['task-stop', 409, { ok: false, refused: 'no-mod', hint: 'h' }, 'refused'],
    ['restore', 200, { ok: true, counts: { rewritten: 1 } }, 'restored'],
    ['undo', 200, { ok: true, counts: { rewritten: 1 } }, 'undone'],
    ['fork', 200, { ok: true, command: `claude --resume ${UUID}`, session_id: UUID }, 'forked'],
    ['restore', 409, { ok: false, residual: [{ path: 'a', reason: 'changed' }] }, 'failed'],
    ['restore', 409, { ok: false, refused: 'busy', hint: 'h' }, 'refused'],
    ['fork', 409, { ok: false, refused: 'fork-failed' }, 'refused'],
    ['restore', 429, { ok: false, refused: 'rate_limited' }, 'refused'],
    ['restore', 200, { ok: false }, 'refused'],
  ];
  for (const [action, status, body, outcome] of cases) {
    const r = CONFIRM.readAnswer(action, status, body);
    assert.equal(r.outcome, outcome, `${action} ${status}`);
    assert.ok(CONFIRM.CONFIRM_OUTCOMES.includes(r.outcome));
    assert.ok(!JSON.stringify(r.result || {}).match(/claude|rs_|[a-f0-9]{8}-/), 'a result is counts only');
  }
  // 'done' (U89, Q-B3 (a)): the server's `said`, cut to SAID_MAX, or nothing.
  assert.equal(CONFIRM.readAnswer('task-stop', 200, { ok: true, said: 'x'.repeat(500) }).show.said, 'x'.repeat(CONFIRM.SAID_MAX));
  assert.equal(CONFIRM.SAID_MAX, 120);
  assert.equal(CONFIRM.readAnswer('task-stop', 200, { ok: true, said: 7 }).show.said, '');
  assert.equal(CONFIRM.readAnswer('task-stop', 200, { ok: true, said: 'x' }).result, undefined, 'done carries nothing to the chrome');
  assert.equal(CONFIRM.readAnswer('fork', 200, { ok: true, command: 'rm -rf / ; claude --resume x' }).show.command, null,
    'a command that is not exactly `claude --resume <id>` is not shown');
  assert.deepEqual(CONFIRM.bodyOf({ preview: 'pv_1', layout: 'confirm', mode: 'dark', size: 'compact', device: 'mobile', v: '1', wait: '2', action: 'x', Bad: 'y' }),
    { preview: 'pv_1' });
});

test('confirm: a mod row\'s ok answer is \'done\', showing its `said` as text; done carries no `said` to the chrome (U89, Q-B3 (a))', async (t) => {
  const said = '<b>Stopping</b> — the row confirms when the task ends';
  const p = await confirmPage(t, {
    action: 'task-stop', query: 'task_id=b1', meta: { title: 'Stop this task now', summary: 'Claude Code stops it with TaskStop, through the web-chat mod.', lines: ['Shell · b1'] },
    proof: true, post: () => json({ ok: true, via: 'mod', said }),
  });
  readyConfirm(p);
  p.vis.report();
  click(p, $(p.doc, '.ct-act'));
  await settle();
  assert.deepEqual(posted(p)[0].body, { task_id: 'b1' });
  const out = $(p.doc, '.ct-outcome');
  assert.equal(out.textContent, said, 'the server\'s words, as text');
  assert.equal(out.querySelector('b'), null, 'never markup');
  assert.deepEqual(dones(p), [{ type: 'wc-answer:done', id: 'task-stop', outcome: 'done' }]);
  assert.ok(!JSON.stringify(p.posts).includes('Stopping'), 'the line stays inside the frame');

  const bare = await confirmPage(t, {
    action: 'resume', query: 'turn_id=t_7', meta: { title: 'Switch this terminal to the fork?', summary: 's' },
    proof: true, post: () => json({ ok: true, via: 'mod' }),
  });
  readyConfirm(bare);
  bare.vis.report();
  click(bare, $(bare.doc, '.ct-act'));
  await settle();
  assert.equal($(bare.doc, '.ct-outcome').textContent, 'Done');
});

/* ══ answer.css ══════════════════════════════════════════════════════════════ */

const CSS = fs.readFileSync(path.join(PUB, 'answer.css'), 'utf8');
const U85_AT = CSS.indexOf('/* ── U85 ·');
const SECTION = CSS.slice(U85_AT);
const COLOR_PROPS = /^(color|background|background-color|border|border-color|border-top|border-bottom|border-left|border-right|outline|outline-color)$/;

// Each rule's declarations, comments stripped.
function rules(css) {
  const out = [];
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    out.push({ selector: m[1].trim(), decls });
  }
  return out;
}
const tokenOf = (value) => { const m = /var\((--wc-[a-z0-9-]+)\)/.exec(value || ''); return m ? m[1] : null; };

// [ink, fill] pairs the U85 rules paint: a colour on its own rule's
// background, and every border or outline on the frame's surface.
function paintedPairs() {
  const pairs = [];
  for (const r of rules(SECTION)) {
    const bg = tokenOf(r.decls.background || r.decls['background-color']);
    const ink = tokenOf(r.decls.color);
    if (ink) {
      assert.ok(bg, `${r.selector}: a rule that sets a colour sets its background too`);
      pairs.push({ selector: r.selector, ink, fill: bg, kind: 'color' });
    }
    for (const prop of ['border', 'border-color', 'outline', 'outline-color']) {
      const tok = tokenOf(r.decls[prop]);
      if (tok) pairs.push({ selector: r.selector, ink: tok, fill: '--wc-panel-bg', kind: prop });
    }
  }
  return pairs;
}

// Every palette a frame may paint with: each built-in pack, and the fallback
// the surface renders for a project with nothing vetted, light and dark.
function palettes() {
  const out = [];
  for (const pack of PACKS) for (const mode of MODES) out.push({ name: `${pack.name || pack.id} ${mode}`, tokens: flattenTheme(pack, mode).tokens });
  const root = tmpRoot('wc-u85-palette-');
  try {
    const css = renderPalette({ root });
    for (const m of css.matchAll(/:root\[data-mode=(\w+)\] \{([^}]*)\}/g)) {
      const tokens = {};
      for (const d of m[2].matchAll(/(--wc-[a-z0-9-]+):\s*([^;]+);/g)) tokens[d[1]] = d[2].trim();
      out.push({ name: `fallback ${m[1]}`, tokens });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  return out;
}

test('answer.css: the U85 section paints only palette.css\'s tokens — no literal colour, nothing from the embedding page', () => {
  assert.ok(U85_AT > 0, 'answer.css has a U85 section');
  const all = palettes();
  assert.ok(all.length >= 4);
  const defined = new Set(Object.keys(all.at(-1).tokens));
  for (const r of rules(SECTION)) {
    for (const [prop, value] of Object.entries(r.decls)) {
      assert.doesNotMatch(value, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix|currentcolor/i, `${r.selector} ${prop}: no literal colour`);
      if (!COLOR_PROPS.test(prop)) continue;
      for (const m of value.matchAll(/var\((--[a-z0-9-]+)/g)) {
        assert.ok(m[1].startsWith('--wc-'), `${r.selector} ${prop}: a frame token`);
        assert.ok(defined.has(m[1]), `${r.selector} ${prop}: ${m[1]} is defined by palette.css`);
      }
    }
  }
  // The frame's document loads the palette and its own sheet, nothing of the chrome's.
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.deepEqual([...html.matchAll(/<link[^>]*href="([^"]+)"/g)].map((m) => m[1]), ['/answer/palette.css', '/answer/answer.css']);
  for (const f of ['control-stop.js', 'control-confirm.js']) {
    const src = fs.readFileSync(path.join(PUB, f), 'utf8');
    assert.doesNotMatch(src, /getComputedStyle|parent\.document|top\.document|--wc-/, `${f} reads no style from anywhere`);
  }
});

test('answer.css: the layouts\' text pairs pass 4.5:1 and their control pairs 3:1 in every palette, light and dark, by palette.js\'s contrastRatio', () => {
  const measured = new Map();
  for (const [ink, fill] of FRAME_TEXT) measured.set(`${ink} ${fill}`, TEXT_MIN);
  for (const [ink, fill] of FRAME_UI) if (!measured.has(`${ink} ${fill}`)) measured.set(`${ink} ${fill}`, UI_MIN);
  const pairs = paintedPairs();
  assert.ok(pairs.length >= 10, 'the layouts paint something');
  for (const p of pairs) {
    assert.ok(measured.has(`${p.ink} ${p.fill}`), `${p.selector} (${p.kind}): ${p.ink} on ${p.fill} is a pair palette.js measures`);
  }
  for (const pal of palettes()) {
    for (const p of pairs) {
      const need = p.kind === 'color' ? measured.get(`${p.ink} ${p.fill}`) : UI_MIN;
      const ratio = contrastRatio(pal.tokens[p.ink], pal.tokens[p.fill]);
      assert.ok(ratio >= need, `${pal.name}: ${p.selector} ${p.ink} on ${p.fill} is ${ratio.toFixed(2)}:1, needs ${need}:1`);
    }
  }
});

test('no file of this unit defines a contrast or luminance function: palette.js is the WCAG ratio\'s one lib home', () => {
  const files = ['lib/server/answer-surface/public/control-stop.js', 'lib/server/answer-surface/public/control-confirm.js',
    'public/app/session-control.js', 'test/answer-control-frame.test.js', 'test/session-control.test.js', 'test/answer-control-e2e.test.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.doesNotMatch(src, /function\s+\w*(contrast|luminance|relLum)\w*\s*\(|(contrast|luminance)\w*\s*=\s*(\([^)]*\)|\w+)\s*=>/i, `${f}`);
  }
});
