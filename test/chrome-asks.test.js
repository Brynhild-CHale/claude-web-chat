// The chrome's asks (public/app/asks.js) and the answer origin's half of
// public/app/remote.js, through the real shell (test-support/chrome-shell.js),
// with initAsks passed in (main.js does not call it until U66a).
//
//   * the provider registers only once a port is known, and the REAL
//     chat-bar.js and chat-awaiting.js pick it up unedited — the bar on its
//     next 1 s tick, the card on the panel's next draw — with no refusal
//     recorded for want of a port (A-confirm (1), the callers' side);
//   * the frame: its src, referrerpolicy and title; mountBar / mountCard /
//     mountSheet's layouts; false for a live wait, an unanswerable ask and a
//     remote page with no answer origin; unmount takes the frame and its
//     listener;
//   * the messages: checked against the frame's origin AND its window; size,
//     open-chat and done; the chrome-bus 'mode' forwarded to every frame;
//   * a frame that never loads: an ask frame becomes `Review & answer ↗`; a
//     control frame is remounted once at a refreshed port and then left empty
//     until the next refresh, never the popup;
//   * the port rule: synchronous mounts, a stale port refreshed behind a mount,
//     a port change remounting every frame, and mountAnswerFrame's no-port null
//     with one shared refresh and the port event;
//   * remote.js: answerOrigin() keeps only the origin of a valid https header.
//
// Module state (the cached port, the registration) is this file's to reset:
// stopAsks() then initAsks() is a fresh page as far as asks.js is concerned.
const test = require('node:test');
const { before, after, beforeEach, afterEach } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');

const REPO = path.resolve(__dirname, '..');
const realNow = Date.now;
const T = realNow();
const sec = (n) => n * 1000;
const min = (n) => n * 60000;
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };

let shell, W, doc, $, bus, S, slots, A, ws, bar, barTicker;
let current = null;              // what GET /api/mirror answers
let asksAnswer = { asks: [], answer: null };   // what GET /api/asks answers (or a function)
let rev = 9000;

const asksGets = () => shell.calls.filter((c) => c.url.startsWith('/api/asks')).length;

const live = (state, extra = {}) => ({ state, since: T - min(1), last_activity_at: T - sec(1), ...extra });
const conversation = (id, l) => ({ id, rev: 1, title: 'c', headless: false, counts: ZERO, live: l });
function snapshot({ conversations = [conversation('c1', live('idle'))], asks = [] } = {}) {
  return { v: 1, enabled: true, now: T, rev: ++rev, content: true, access: { level: 'local', remote: false },
    capabilities: {}, primary: 'c1', aggregate: { state: 'idle' }, conversations, tasks: [], asks };
}
const askPublic = (id = 'ask_000000000001', extra = {}) => ({ id, conversation_id: 'c1', kind: 'permission',
  tool_name: 'Bash', tool_kind: 'shell', state: 'pending', answerable: true, created_at: T - sec(1), version: 1, masked: false, ...extra });
// What chat-state hands the provider: AskPublic plus summary and source.
const entry = (id = 'ask_000000000001', extra = {}) => ({ ...askPublic(id), summary: 'Bash(npm test)', source: 'ask', ...extra });
const permissionWait = (askId) => live('waiting', { waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(npm test)', ask_id: askId } });

async function show(over) {
  current = snapshot(over);
  await shell.frame(helloFrame());
  await shell.tick();
}
const tickBar = () => barTicker.fn();
const redraw = async () => { bus.emit('mirror', { what: ['all'] }); await shell.tick(); };

// A fresh asks.js state: everything unmounted, the port forgotten, and init
// again with the timers, clock and remote stand-in a case needs.
async function reset(opts = {}) {
  A.stopAsks();
  A.initAsks({ onFrame: ws.onFrame, onHello: ws.onHello, ...opts });
  await shell.tick();
}
// Fake timers: recorded, fired by hand.
function fakeTimers() {
  const pending = new Map();
  let n = 0;
  return {
    setTimeout(fn, ms) { const id = ++n; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    pending: () => [...pending.values()],
    fire(ms) {
      for (const [id, t] of [...pending]) if (t.ms === ms) { pending.delete(id); t.fn(); }
    },
  };
}
const portFrame = (port, ask = askPublic('ask_00000000000f', { state: 'resolved' })) =>
  shell.frame({ type: 'mirror:ask', op: 'update', ask, answer: { port } });
// A message as the frame's window would post it.
function fromFrame(frame, data, origin) {
  W.dispatchEvent(new W.MessageEvent('message', { data, origin, source: frame.contentWindow }));
}
const host = () => { const d = doc.createElement('div'); doc.body.append(d); return d; };

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/mirror': () => current,
      '/api/asks': (url) => (typeof asksAnswer === 'function' ? asksAnswer(url) : asksAnswer),
    },
    init: async (sh) => {
      ws = await sh.importApp('ws.js');
      A = await sh.importApp('asks.js');
      A.initAsks({ onFrame: ws.onFrame, onHello: ws.onHello });
      bar = await sh.importApp('chat-bar.js');
      bar.stopBar();
      const known = new Set(sh.intervals().map((i) => i.id));
      bar.initChatBar();
      [barTicker] = sh.intervals().filter((i) => !known.has(i.id));
    },
  });
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  slots = await shell.importApp('chat-slots.js');
});

after(() => {
  Date.now = realNow;
  return shell.restore();
});
beforeEach(() => { const held = realNow(); Date.now = () => held; });
afterEach(() => { Date.now = realNow; });

/* ── the registration ──────────────────────────────────────────────────────── */

test('registration: a page that loads before the port is known registers nothing; when it arrives the bar and the card mount, nothing refused', async () => {
  // The boot GET /api/asks?ensure=1 has answered `answer: null`.
  assert.ok(asksGets() >= 1, 'the boot asked for the port (and started the surface)');
  assert.equal(slots.approvals(), null, 'no provider without a port');
  await show({ conversations: [conversation('c1', permissionWait('ask_000000000001'))], asks: [askPublic()] });
  assert.equal(slots.approvals(), null, 'the hello\'s refresh found no port either');
  tickBar();
  const act = $('cs-act');
  assert.ok(act.querySelector('.cs-act-note'), 'the bar: answer in the terminal');
  assert.equal(act.querySelector('iframe'), null);
  const card = $('chat-awaiting');
  assert.equal(card.hidden, false);
  assert.equal(card.querySelector('.cp-aw-hint').textContent, 'Answer in the terminal', 'the card: read-only');

  // The port arrives in a mirror:ask frame's `answer`.
  await shell.frame({ type: 'mirror:ask', op: 'update', ask: askPublic(), answer: { port: 4567 } });
  assert.ok(slots.approvals(), 'the provider registered');
  tickBar();
  const barFrame = act.querySelector('iframe.wc-answer-frame');
  assert.ok(barFrame, 'the bar mounted the frame on its next tick');
  assert.equal(barFrame.src, 'http://127.0.0.1:4567/answer/ask/ask_000000000001?layout=bar&mode=light&device=desktop');
  assert.equal($('cs-step-text').textContent, 'Permission · Bash', 'beside the frame the bar names the tool alone');
  await redraw();
  const cardFrame = card.querySelector('.cp-aw-body > iframe.wc-answer-frame');
  assert.ok(cardFrame, 'the card mounted the frame on the panel\'s next draw');
  assert.match(cardFrame.src, /\/answer\/ask\/ask_000000000001\?layout=card&/);
  assert.equal(card.querySelector('.cp-aw-hint'), null, 'the frame owns the card\'s body');

  // The wait ends: both let go of their frames.
  await show({ conversations: [conversation('c1', live('working'))], asks: [] });
  tickBar();
  await redraw();
  assert.equal(doc.querySelectorAll('iframe.wc-answer-frame').length, 0, 'unmounted from the bar and the card');
});

test('registration: the port can come from the boot GET /api/asks?ensure=1 too', async () => {
  asksAnswer = { asks: [], answer: { port: 4568 } };
  await reset();
  assert.ok(slots.approvals(), 'registered from the boot fetch');
  assert.equal(A.answerFrameOrigin(), 'http://127.0.0.1:4568');
  asksAnswer = { asks: [], answer: { port: 4567 } };
  await reset();
  assert.equal(A.answerFrameOrigin(), 'http://127.0.0.1:4567');
});

/* ── the frame ─────────────────────────────────────────────────────────────── */

test('mountBar after a port push appends ONE iframe with the answer origin\'s src and no referrer, and answers true', async () => {
  await reset();
  await portFrame(4567);
  const el = host();
  const ok = slots.approvals().mountBar(el, entry());
  assert.equal(ok, true);
  const frames = el.querySelectorAll('iframe');
  assert.equal(frames.length, 1);
  const f = frames[0];
  assert.equal(f.src, 'http://127.0.0.1:4567/answer/ask/ask_000000000001?layout=bar&mode=light&device=desktop');
  assert.equal(f.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(f.className, 'wc-answer-frame');
  assert.ok(f.title, 'a title');
  assert.equal(f.hasAttribute('sandbox'), false, 'no sandbox');
  assert.equal(f.hasAttribute('allow'), false, 'no clipboard for an ask');
  assert.equal(f.style.opacity, '');
  slots.approvals().unmount(el);
  el.remove();
});

test('mountBar answers false for a live wait and an unanswerable ask; mountCard and mountSheet use the card and sheet layouts', async () => {
  const p = slots.approvals();
  const el = host();
  assert.equal(p.mountBar(el, entry('live:c1', { source: 'live' })), false, 'a live wait: no ask to answer');
  assert.equal(p.mountBar(el, entry(undefined, { answerable: false })), false, 'not answerable');
  assert.equal(p.mountBar(el, entry(undefined, { state: 'decided' })), false, 'not pending');
  assert.equal(p.mountBar(el, null), false);
  assert.equal(el.childNodes.length, 0, 'nothing left behind');
  assert.equal(p.mountCard(el, entry()), true);
  assert.match(el.querySelector('iframe').src, /\?layout=card&mode=light&device=desktop$/);
  assert.equal(p.mountSheet(el, entry()), true, 'a second mount into one container replaces the first');
  assert.equal(el.querySelectorAll('iframe').length, 1);
  assert.match(el.querySelector('iframe').src, /\?layout=sheet&/);
  p.unmount(el);
  el.remove();
});

test('unmount removes the iframe and its message listener', async () => {
  const p = slots.approvals();
  const el = host();
  const counts = { add: 0, remove: 0 };
  const add = W.addEventListener;
  const remove = W.removeEventListener;
  W.addEventListener = function (type, ...rest) { if (type === 'message') counts.add += 1; return add.call(this, type, ...rest); };
  W.removeEventListener = function (type, ...rest) { if (type === 'message') counts.remove += 1; return remove.call(this, type, ...rest); };
  try {
    p.mountCard(el, entry());
    const f = el.querySelector('iframe');
    const cw = f.contentWindow;
    p.unmount(el);
    assert.equal(el.querySelector('iframe'), null);
    assert.deepEqual(counts, { add: 1, remove: 1 });
    const seen = [];
    const off = bus.on('chat:open', (d) => seen.push(d));
    W.dispatchEvent(new W.MessageEvent('message', { data: { type: 'wc-answer:open-chat', id: 'x' }, origin: 'http://127.0.0.1:4567', source: cw }));
    off();
    assert.deepEqual(seen, [], 'a message from an unmounted frame does nothing');
  } finally {
    W.addEventListener = add;
    W.removeEventListener = remove;
    el.remove();
  }
});

test('a remote page without X-WC-Answer-Origin frames nothing: the provider answers false, mountAnswerFrame null', async () => {
  const remote = { isRemote: async () => true, remoteNow: () => true, remoteKnown: () => true, answerOrigin: () => null };
  await reset({ remote });
  assert.ok(slots.approvals(), 'registered (remote-ness known), so the bar and the card do not show the stand-in');
  const el = host();
  assert.equal(slots.approvals().mountBar(el, entry()), false);
  assert.equal(slots.approvals().mountCard(el, entry()), false);
  assert.equal(A.mountAnswerFrame(el, { kind: 'control', path: 'interrupt', layout: 'stop' }), null);
  assert.equal(el.childNodes.length, 0);
  // With the portal's answer origin, the frame loads from it.
  const withOrigin = { ...remote, answerOrigin: () => 'https://wc-0123abcd-a.example.com' };
  await reset({ remote: withOrigin });
  assert.equal(slots.approvals().mountBar(el, entry()), true);
  assert.equal(el.querySelector('iframe').src, 'https://wc-0123abcd-a.example.com/answer/ask/ask_000000000001?layout=bar&mode=light&device=desktop');
  slots.approvals().unmount(el);
  el.remove();
  await reset();
  await portFrame(4567);
});

/* ── the messages ──────────────────────────────────────────────────────────── */

test('messages: another origin, or the right origin from another window, is ignored; size, open-chat and done are read', async () => {
  const el = host();
  const done = [];
  const opened = [];
  const h = A.mountAnswerFrame(el, { id: 'ask_000000000002', layout: 'card', onDone: (o, r) => done.push([o, r]) });
  const f = h.frame;
  const origin = 'http://127.0.0.1:4567';
  const off = bus.on('chat:open', (d) => opened.push(d));
  try {
    fromFrame(f, { type: 'wc-answer:size', height: 200 }, 'http://127.0.0.1:9999');
    assert.equal(f.style.height, '', 'another origin');
    const other = doc.createElement('iframe');
    doc.body.append(other);
    W.dispatchEvent(new W.MessageEvent('message', { data: { type: 'wc-answer:size', height: 200 }, origin, source: other.contentWindow }));
    W.dispatchEvent(new W.MessageEvent('message', { data: { type: 'wc-answer:size', height: 200 }, origin, source: W }));
    other.remove();
    assert.equal(f.style.height, '', 'another window, even this one');
    fromFrame(f, { type: 'wc-answer:size', height: 200 }, origin);
    assert.equal(f.style.height, '200px', 'size sets the height');
    fromFrame(f, { type: 'wc-answer:size', height: 5000 }, origin);
    assert.equal(f.style.height, '480px', 'clamped');
    fromFrame(f, { type: 'wc-answer:size', height: 3 }, origin);
    assert.equal(f.style.height, '22px');
    fromFrame(f, { type: 'wc-answer:open-chat', id: 'ask_spoofed' }, origin);
    assert.deepEqual(opened, [{ view: 'awaiting', id: 'ask_000000000002' }], 'open-chat: chat:open on THIS frame\'s ask');
    fromFrame(f, { type: 'wc-answer:done', id: 'ask_000000000002', outcome: 'allowed', result: { files: 2, cmd: 'claude --resume x' } }, origin);
    assert.deepEqual(done, [['allowed', { files: 2 }]], 'done: onDone(outcome, result), the result content-free');
    fromFrame(f, { type: 'wc-answer:done', outcome: '<b>x</b>' }, origin);
    assert.equal(done.length, 1, 'an outcome that is not a word is dropped');
  } finally {
    off();
    h.unmount();
    el.remove();
  }
  // onOpenChat replaces the chat:open.
  const el2 = host();
  const h2 = A.mountAnswerFrame(el2, { id: 'ask_000000000003', layout: 'bar', onOpenChat: (id) => opened.push({ via: 'onOpenChat', id }) });
  fromFrame(h2.frame, { type: 'wc-answer:open-chat' }, origin);
  assert.deepEqual(opened.at(-1), { via: 'onOpenChat', id: 'ask_000000000003' });
  h2.unmount();
  el2.remove();
});

test('the chrome-bus mode goes to every mounted frame as wc-answer:mode, to its origin', async () => {
  const els = [host(), host()];
  const hs = els.map((el, i) => A.mountAnswerFrame(el, { id: `ask_00000000001${i}`, layout: 'card' }));
  const got = [];
  hs.forEach((h, i) => { h.frame.contentWindow.postMessage = (msg, target) => got.push({ i, msg, target }); });
  bus.emit('mode', { mode: 'dark' });
  assert.deepEqual(got, [
    { i: 0, msg: { type: 'wc-answer:mode', mode: 'dark' }, target: 'http://127.0.0.1:4567' },
    { i: 1, msg: { type: 'wc-answer:mode', mode: 'dark' }, target: 'http://127.0.0.1:4567' },
  ]);
  for (const h of hs) h.unmount();
  for (const el of els) el.remove();
});

/* ── a frame that never loads ──────────────────────────────────────────────── */

test('an ask frame with no size message for 3 s becomes `Review & answer ↗`, which opens the page layout in a popup', async () => {
  const timers = fakeTimers();
  await reset({ timers });
  await portFrame(4567);
  const el = host();
  assert.equal(slots.approvals().mountCard(el, entry()), true);
  assert.deepEqual(timers.pending().map((t) => t.ms), [3000], 'one bounded timer');
  timers.fire(3000);
  assert.equal(el.querySelector('iframe'), null);
  const b = el.querySelector('button.wc-answer-popup');
  assert.equal(b.textContent, 'Review & answer ↗');
  const opened = [];
  const open = W.open;
  W.open = (...args) => { opened.push(args); return null; };
  try { shell.click(b); } finally { W.open = open; }
  assert.deepEqual(opened, [['http://127.0.0.1:4567/answer/ask/ask_000000000001?layout=page&mode=light&device=desktop', '_blank', 'popup,width=460,height=600']]);
  slots.approvals().unmount(el);
  assert.equal(el.childNodes.length, 0, 'unmount takes the button too');
  // A frame that does report a size keeps its frame.
  slots.approvals().mountCard(el, entry());
  fromFrame(el.querySelector('iframe'), { type: 'wc-answer:size', height: 90 }, 'http://127.0.0.1:4567');
  assert.deepEqual(timers.pending(), [], 'the size cleared the timer');
  slots.approvals().unmount(el);
  el.remove();
});

test('a control frame with no size in 3 s is remounted once at a refreshed port — never the popup — then left empty until the next refresh', async () => {
  const timers = fakeTimers();
  await reset({ timers });
  await portFrame(4567);
  const el = host();
  const h = A.mountAnswerFrame(el, { kind: 'control', path: 'interrupt', query: { conversation_id: 'c1' }, layout: 'stop', clipboard: true });
  assert.ok(h);
  assert.equal(h.frame.src, 'http://127.0.0.1:4567/answer/control/interrupt?conversation_id=c1&layout=stop&mode=light&device=desktop');
  assert.equal(h.frame.getAttribute('allow'), 'clipboard-write', 'the clipboard only when asked');
  const firstFrame = h.frame;
  const before = asksGets();
  asksAnswer = { asks: [], answer: { port: 4567 } };
  timers.fire(3000);
  await shell.tick();
  assert.equal(asksGets(), before + 1, 'the port was refreshed');
  assert.equal(el.querySelector('button'), null, 'never the popup button');
  const second = el.querySelector('iframe');
  assert.ok(second, 'remounted');
  assert.notEqual(second, firstFrame, 'a new frame');
  assert.equal(second, h.frame);
  assert.equal(el.querySelectorAll('iframe').length, 1);
  timers.fire(3000);
  await shell.tick();
  assert.equal(el.childNodes.length, 0, 'a second silence leaves the slot empty');
  assert.equal(asksGets(), before + 1, 'and asks no more');
  // The next port refresh (a reconnect's) brings it back.
  await shell.frame(helloFrame());
  await shell.tick();
  assert.ok(el.querySelector('iframe'), 'remounted at the next port refresh');
  h.unmount();
  el.remove();
});

/* ── the port rule ─────────────────────────────────────────────────────────── */

test('a new port from a later mirror:ask frame remounts a mounted frame at the new origin', async () => {
  await reset();
  await portFrame(4567);
  const el = host();
  slots.approvals().mountBar(el, entry());
  const first = el.querySelector('iframe');
  await portFrame(4600);
  const frames = el.querySelectorAll('iframe');
  assert.equal(frames.length, 1, 'one frame still');
  assert.notEqual(frames[0], first, 'a new one');
  assert.equal(frames[0].src, 'http://127.0.0.1:4600/answer/ask/ask_000000000001?layout=bar&mode=light&device=desktop');
  // Its messages are now checked against the new origin.
  fromFrame(frames[0], { type: 'wc-answer:size', height: 40 }, 'http://127.0.0.1:4567');
  assert.equal(frames[0].style.height, '');
  fromFrame(frames[0], { type: 'wc-answer:size', height: 40 }, 'http://127.0.0.1:4600');
  assert.equal(frames[0].style.height, '40px');
  slots.approvals().unmount(el);
  el.remove();
});

test('the port rule: a fresh port mounts with no fetch; one cached over 60 s ago mounts AT ONCE and is refreshed behind it', async () => {
  let t = 1_000_000;
  await reset({ now: () => t });
  await portFrame(4567);
  const el = host();
  let gets = asksGets();
  assert.equal(slots.approvals().mountBar(el, entry()), true);
  await shell.tick();
  assert.equal(asksGets(), gets, 'a fresh port: no fetch');
  slots.approvals().unmount(el);

  t += 61_000;
  let answer;
  asksAnswer = () => new Promise((r) => { answer = r; });
  gets = asksGets();
  assert.equal(slots.approvals().mountBar(el, entry()), true, 'synchronous, at the stale port');
  assert.match(el.querySelector('iframe').src, /^http:\/\/127\.0\.0\.1:4567\//);
  await shell.tick();
  assert.equal(asksGets(), gets + 1, 'refreshing in the background');
  answer({ asks: [], answer: { port: 4700 } });
  await shell.tick();
  assert.match(el.querySelector('iframe').src, /^http:\/\/127\.0\.0\.1:4700\//, 'the refresh found another port: remounted there');
  slots.approvals().unmount(el);
  el.remove();
  asksAnswer = { asks: [], answer: { port: 4567 } };
});

test('mountAnswerFrame with no port: null at once, ONE shared refresh, then the port event — and the caller\'s next mount works', async () => {
  asksAnswer = { asks: [], answer: null };
  await reset();
  assert.equal(slots.approvals(), null);
  let answer;
  asksAnswer = () => new Promise((r) => { answer = r; });
  const gets = asksGets();
  const el = host();
  const events = [];
  const off = bus.on(A.PORT_EVENT, (d) => events.push(d));
  try {
    assert.equal(A.mountAnswerFrame(el, { kind: 'control', path: 'interrupt', layout: 'stop' }), null);
    assert.equal(A.mountAnswerFrame(el, { kind: 'control', path: 'interrupt', layout: 'stop' }), null);
    await shell.tick();
    assert.equal(asksGets(), gets + 1, 'two mounts, one fetch');
    assert.deepEqual(events, []);
    answer({ asks: [], answer: { port: 4567 } });
    await shell.tick();
    assert.deepEqual(events, [{ origin: 'http://127.0.0.1:4567' }], 'the port event');
    const h = A.mountAnswerFrame(el, { kind: 'control', path: 'interrupt', layout: 'stop' });
    assert.ok(h, 'the caller asks again and mounts');
    assert.match(h.frame.src, /^http:\/\/127\.0\.0\.1:4567\/answer\/control\/interrupt\?layout=stop&/);
    assert.ok(slots.approvals(), 'and the provider registered with the port');
    h.unmount();
  } finally {
    off();
    el.remove();
    asksAnswer = { asks: [], answer: { port: 4567 } };
  }
});

test('mountAnswerFrame refuses what it cannot frame: a bad kind, layout or id', () => {
  const el = host();
  for (const bad of [{ layout: 'card' }, { id: 'ask 1', layout: 'card' }, { id: 'ask_1', layout: 'Card' },
    { kind: 'api', path: 'x', layout: 'stop' }, { kind: '../x', layout: 'stop' }, { id: 'ask_1' }]) {
    assert.equal(A.mountAnswerFrame(el, bad), null, JSON.stringify(bad));
  }
  assert.equal(A.mountAnswerFrame(null, { id: 'ask_1', layout: 'card' }), null);
  assert.equal(el.childNodes.length, 0);
  el.remove();
});

/* ── remote.js ─────────────────────────────────────────────────────────────── */

// A fresh remote.js (its own once-per-load cache), against a stubbed fetch.
let fresh = 0;
async function freshRemote(answer) {
  const mod = await import(`${pathToFileURL(path.join(REPO, 'public/app/remote.js')).href}?case=${++fresh}`);
  const held = globalThis.fetch;
  globalThis.fetch = async () => answer();
  try { await mod.isRemote(); } finally { globalThis.fetch = held; }
  return mod;
}
const healthWith = (body, headers = {}, status = 200) => () => ({
  ok: status === 200, status, json: async () => body,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
});

test('remote.js: answerOrigin() keeps only the origin of a valid https X-WC-Answer-Origin; null when absent or malformed', async () => {
  const cases = [
    ['https://wc-0123abcd-a.example.com', 'https://wc-0123abcd-a.example.com'],
    ['https://wc-0123abcd-a.example.com/some/path?q=1#x', 'https://wc-0123abcd-a.example.com'],
    ['https://answer.example.com:8443/', 'https://answer.example.com:8443'],
    ['http://wc-0123abcd-a.example.com', null],
    ['javascript:alert(1)', null],
    ['https://user:pw@example.com', null],
    ['not a url', null],
    ['', null],
    [undefined, null],
  ];
  for (const [header, want] of cases) {
    const r = await freshRemote(healthWith({ ok: true, remote: true }, header === undefined ? {} : { 'x-wc-answer-origin': header }));
    assert.equal(r.answerOrigin(), want, String(header));
    assert.equal(r.remoteNow(), true);
    assert.equal(r.remoteKnown(), true);
  }
  assert.equal((await freshRemote(healthWith({ ok: true }))).loopbackOrigin(4567), 'http://127.0.0.1:4567');
  assert.equal((await freshRemote(healthWith({ ok: true }))).loopbackOrigin(0), null);
});

test('remote.js: isRemote() is unchanged for its existing callers — remote:true, local, a failed or refused health all as before', async () => {
  let r = await freshRemote(healthWith({ ok: true, remote: true }));
  assert.equal(await r.isRemote(), true);
  assert.equal(r.remoteNow(), true);
  r = await freshRemote(healthWith({ ok: true, remote: false }));
  assert.equal(await r.isRemote(), false);
  r = await freshRemote(healthWith({ ok: false }, {}, 503));
  assert.equal(await r.isRemote(), false, 'a refused health is local');
  assert.equal(r.remoteKnown(), true);
  r = await freshRemote(() => { throw new Error('offline'); });
  assert.equal(await r.isRemote(), false, 'a failed fetch is local');
  assert.equal(r.answerOrigin(), null);
  // One fetch per page load: the promise is remembered.
  assert.equal(r.isRemote(), r.isRemote());
});

/* ── the CSS ───────────────────────────────────────────────────────────────── */

test('app.css\'s U56 section sizes the frames and never dims, filters, transforms, clips or masks one', () => {
  const css = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');
  const at = css.indexOf('/* ── U56 ·');
  const section = css.slice(at, css.indexOf('/* ── U', at + 10));
  const rules = section.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(rules, /\.cs-act > \.wc-answer-frame \{[^}]*height: 22px/);
  assert.match(rules, /\.cs-act > \.wc-answer-frame \{[^}]*min-width: 260px/);
  assert.match(rules, /\.cp-aw-body > \.wc-answer-frame \{[^}]*width: 100%/);
  assert.doesNotMatch(rules, /opacity|filter|transform|clip|mask|visibility/);
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b/i, 'tokens only');
  const asks = fs.readFileSync(path.join(REPO, 'public/app/asks.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(asks, /\.style\.(opacity|filter|transform|clip|clipPath|mask)/, 'asks.js never styles them either');
  assert.doesNotMatch(asks, /keydown|Escape/, 'and binds no key: Esc never answers');
});
