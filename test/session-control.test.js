// The chrome's control frames and the Stop control (public/app/session-control.js,
// spec §15.5, §15.2, §7.5, §7.9), through the real shell
// (test-support/chrome-shell.js), with initAsks and initSessionControl passed
// in (main.js calls neither until U66a).
//
//   * #cs-stop holds ONE control iframe on the answer origin's
//     /answer/control/interrupt for the followed conversation, layout stop,
//     size bar, exactly while capabilities.interrupt is true and that
//     conversation is working, compacting, question or waiting; 1.5 s after it
//     goes idle (a stubbed timer) the slot is empty, which .cs-stop:empty hides;
//   * #cp-stop (size panel) follows the panel's conversation on its own record:
//     following another conversation remounts both, a chat:host move remounts
//     the panel's once and leaves the bar's alone;
//   * no frame when capabilities.interrupt is false, when the viewer is remote
//     with no answer origin, or remote below full; never a write to #cs-act or
//     the step text; no Escape binding;
//   * stopSessionControl unmounts both and clears its timer; a second init
//     mounts nothing more; no setInterval or setTimeout survives stop;
//   * the port rule (A-confirm (1)): mountStop answers synchronously — with a
//     port cached over 60 s ago it mounts AT ONCE there and the background
//     refresh's new port remounts it; with no port it answers null at once and
//     the port event mounts it; a silent Stop is remounted once at the
//     refreshed port, never the popup, then the slot is empty until the next
//     refresh;
//   * mountControlFrame in a registerStopper slot (U46b): a test-only stopper
//     mounts a confirm frame in div.cs-row-confirm at compact and touch
//     density, answers true, and unmount removes it;
//   * onDone hears only the layout's own outcomes.
const test = require('node:test');
const { before, after, beforeEach, afterEach } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const realNow = Date.now;
const T = realNow();
const sec = (n) => n * 1000;
const min = (n) => n * 60000;
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };
const PORT = 4567;
const LOOP = `http://127.0.0.1:${PORT}`;

let shell, W, doc, $, bus, S, A, SC, CA, R, P, Q, ws;
let current = null;
let asksAnswer = { asks: [], answer: { port: PORT } };
let rev = 7000;
let timers;

// Timers the test fires by hand (session-control's linger timer).
function fakeTimers() {
  const pending = new Map();
  let n = 0;
  return {
    setTimeout(fn, ms) { const id = ++n; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    pending: () => [...pending.values()].map((t) => t.ms),
    fire(ms) { for (const [id, t] of [...pending]) if (t.ms === ms) { pending.delete(id); t.fn(); } },
  };
}

const live = (state) => ({ state, since: T - min(1), last_activity_at: T - sec(1) });
const conversation = (id, state = 'working') => ({ id, rev: 1, title: `t-${id}`, headless: false, counts: ZERO, live: live(state) });
const shellTask = { id: 's1', kind: 'shell', conversation_id: 'c1', title: 'npm run dev', status: 'running', started_at: T - min(4) };
function snapshot({ conversations = [conversation('c1')], caps = { interrupt: true, task_stop: true },
  access = { level: 'local', remote: false }, primary = 'c1' } = {}) {
  return { v: 1, enabled: true, now: T, rev: ++rev, content: true, access, capabilities: caps,
    primary, aggregate: { state: 'working' }, conversations, tasks: [shellTask], asks: [] };
}

async function show(over) {
  current = snapshot(over);
  await shell.frame(helloFrame());
  await shell.tick();
  await waitUntil(() => S.mirror.rev >= current.rev, { timeout: 2000 });
  await shell.tick();
}
const frames = (id) => [...$(id).querySelectorAll('iframe.wc-answer-frame')];
const one = (id) => { const f = frames(id); assert.equal(f.length, 1, `#${id} holds one frame`); return f[0]; };
const src = (id, conv, size) => `${LOOP}/answer/control/interrupt?conversation_id=${conv}&size=${size}&layout=stop&mode=light&device=desktop`;
const asksGets = () => shell.calls.filter((c) => c.url.startsWith('/api/asks')).length;
const host = () => { const d = doc.createElement('div'); doc.body.append(d); return d; };

// A fresh asks.js and session-control.js, as a page load would have them.
async function reset({ asks = {}, control = {} } = {}) {
  SC.stopSessionControl();
  A.stopAsks();
  A.initAsks({ onFrame: ws.onFrame, onHello: ws.onHello, ...asks });
  await shell.tick();
  timers = fakeTimers();
  SC.initSessionControl({ timers, ...control });
  await shell.tick();
}

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
      SC = await sh.importApp('session-control.js');
      timers = fakeTimers();
      SC.initSessionControl({ timers });
    },
  });
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  CA = await shell.importApp('chat-actions.js');
  R = await shell.importApp('chat-rows.js');
  P = await shell.importApp('chat-present.js');
  Q = await shell.importApp('queue.js');
});

after(() => {
  Date.now = realNow;
  return shell.restore();
});
beforeEach(() => { const held = realNow(); Date.now = () => held; });
afterEach(() => { Date.now = realNow; });

/* ── the Stop in the bar and the panel ─────────────────────────────────────── */

test('the bar: a working conversation with capabilities.interrupt → ONE stop frame in #cs-stop at the answer origin, size bar; idle → empty 1.5 s later', async () => {
  await show();
  const f = one('cs-stop');
  assert.equal(f.src, src('cs-stop', 'c1', 'bar'));
  assert.equal(f.dataset.kind, 'control');
  assert.equal(f.dataset.layout, 'stop');
  assert.equal(f.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(f.hasAttribute('allow'), false, 'no clipboard for a Stop');
  assert.equal(f.style.opacity + f.style.filter + f.style.transform + f.style.clipPath, '', 'nothing dims, filters, transforms or clips it');
  assert.equal($('cs-stop').getAttribute('data-wc-stop'), 'bar');
  // Still working, another mirror event: nothing remounts.
  await show();
  assert.equal(one('cs-stop'), f, 'the same frame');

  // Idle: the frame lingers 1.5 s so its own 'Interrupted' is seen, then goes.
  await show({ conversations: [conversation('c1', 'idle')] });
  assert.equal(one('cs-stop'), f, 'still there while it lingers');
  assert.deepEqual(timers.pending(), [1500, 1500], 'one bounded linger timer per slot');
  timers.fire(1500);
  assert.equal(frames('cs-stop').length, 0);
  assert.ok($('cs-stop').matches(':empty'), 'the slot is empty, so .cs-stop:empty hides it');
  assert.match(fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8'), /\.cs-stop:empty \{ display: none; \}/);
  assert.equal($('cs-stop').hasAttribute('data-wc-stop'), false);

  // Each active state mounts it; back to working within the linger keeps it.
  for (const state of ['compacting', 'question', 'waiting', 'working']) {
    await show({ conversations: [conversation('c1', state)] });
    assert.equal(frames('cs-stop').length, 1, `${state}: a Stop`);
  }
  const kept = one('cs-stop');
  await show({ conversations: [conversation('c1', 'idle')] });
  await show({ conversations: [conversation('c1', 'working')] });
  assert.deepEqual(timers.pending(), [], 'busy again: the linger is cancelled');
  timers.fire(1500);
  assert.equal(one('cs-stop'), kept, 'and the frame kept');
});

test('the panel: #cp-stop (size panel) on its own record; following another conversation remounts; a chat:host move remounts the panel\'s once and leaves the bar\'s', async () => {
  await show({ conversations: [conversation('c1'), conversation('c2')] });
  const panelFrame = one('cp-stop');
  assert.equal(panelFrame.src, src('cp-stop', 'c1', 'panel'));
  assert.equal($('cp-stop').getAttribute('data-wc-stop'), 'panel');
  const barFrame = one('cs-stop');

  S.followConversation('c2');
  await shell.tick();
  assert.equal(one('cs-stop').src, src('cs-stop', 'c2', 'bar'), 'the bar follows the conversation it shows');
  assert.equal(one('cp-stop').src, src('cp-stop', 'c2', 'panel'), 'the panel too');
  assert.notEqual(one('cp-stop'), panelFrame, 'a new frame');
  assert.notEqual(one('cs-stop'), barFrame);

  // The panel moves host: its Stop is remounted there, once; the bar's is not.
  const bar2 = one('cs-stop');
  const panel2 = one('cp-stop');
  const added = [];
  const mo = new W.MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) if (n.tagName === 'IFRAME') added.push(n); });
  mo.observe($('cp-stop'), { childList: true });
  const away = host();
  const home = $('chat-panel').parentNode;
  bus.emit('chat:host', { host: away, variant: 'desktop' });
  await shell.tick();
  mo.disconnect();
  assert.equal($('chat-panel').parentNode, away, 'the panel moved');
  assert.equal(added.length, 1, 'remounted once');
  assert.notEqual(one('cp-stop'), panel2);
  assert.equal(one('cs-stop'), bar2, 'the bar\'s frame untouched');
  bus.emit('chat:host', { host: home, variant: 'desktop' });
  await shell.tick();
  away.remove();

  // Back to the server's primary: both slots follow it.
  S.followConversation(null);
  await shell.tick();
  assert.equal(one('cp-stop').src, src('cp-stop', 'c1', 'panel'), 'back to the server\'s primary');
});

test('no frame when capabilities.interrupt is false, for a remote viewer with no answer origin, or one below full', async () => {
  await reset();
  await show({ caps: { interrupt: false } });
  assert.equal(frames('cs-stop').length + frames('cp-stop').length, 0, 'no interrupt capability');

  const remoteNoOrigin = { isRemote: async () => true, remoteNow: () => true, remoteKnown: () => true, answerOrigin: () => null };
  await reset({ asks: { remote: remoteNoOrigin } });
  await show({ access: { level: 'full', remote: true } });
  assert.equal(frames('cs-stop').length + frames('cp-stop').length, 0, 'remote, no answer origin');

  const remoteOrigin = { ...remoteNoOrigin, answerOrigin: () => 'https://wc-0123abcd-a.example.com' };
  await reset({ asks: { remote: remoteOrigin } });
  await show({ access: { level: 'read', remote: true } });
  assert.equal(frames('cs-stop').length + frames('cp-stop').length, 0, 'remote below full');
  assert.equal(SC.mountControlFrame(host(), { action: 'interrupt', params: { conversation_id: 'c1' }, layout: 'stop' }), null,
    'the helper refuses too');

  // Remote at full, with the portal's answer origin: the frame loads from it.
  await show({ access: { level: 'full', remote: true } });
  assert.match(one('cs-stop').src, /^https:\/\/wc-0123abcd-a\.example\.com\/answer\/control\/interrupt\?conversation_id=c1&size=bar&layout=stop&/);
  await reset();
  await show();
  assert.equal(one('cs-stop').src, src('cs-stop', 'c1', 'bar'));
});

test('never a write to #cs-act, the step text or the bar\'s state, and no Escape binding', async () => {
  const bar = await shell.importApp('chat-bar.js');
  bar.stopBar();
  try {
    await reset();
    const watched = [$('cs-act'), $('cs-step-text'), $('chat-statusbar')];
    const seen = [];
    const mo = new W.MutationObserver((recs) => {
      for (const r of recs) if (r.target !== $('cs-stop') && !$('cs-stop').contains(r.target)) seen.push(r.type);
    });
    for (const el of watched) mo.observe(el, { childList: true, characterData: true, attributes: true, subtree: el.id !== 'chat-statusbar' });
    await show({ conversations: [conversation('c1', 'working')] });
    await show({ conversations: [conversation('c1', 'idle')] });
    timers.fire(1500);
    await show({ conversations: [conversation('c1', 'waiting')] });
    mo.disconnect();
    assert.deepEqual(seen, [], 'the bar stopped, nothing else touched its parts');
  } finally {
    bar.initChatBar();
  }
  const src = fs.readFileSync(path.join(REPO, 'public/app/session-control.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /keydown|keyup|'Escape'|addEscapeStep|handleEscape/, 'no key is bound');
  assert.doesNotMatch(src, /cs-act|cs-step|data-cs-state|registerStopper|opacity|filter|transform/, 'never the bar\'s parts, a stopper or a style');
  // Escape anywhere leaves the Stop where it is.
  const f = one('cs-stop');
  shell.key('Escape');
  await shell.tick();
  assert.equal(one('cs-stop'), f);
});

test('stopSessionControl unmounts both frames and clears its timer; a second init mounts nothing more; no interval or timeout survives', async () => {
  await reset();
  const intervals = shell.intervals().length;
  SC.initSessionControl({ timers });
  await show();
  assert.equal(frames('cs-stop').length, 1, 'two inits, one frame');
  assert.equal(frames('cp-stop').length, 1);
  assert.equal(shell.intervals().length, intervals, 'no setInterval of its own');
  await show({ conversations: [conversation('c1', 'idle')] });
  assert.equal(timers.pending().length, 2, 'the lingers are pending');
  bus.emit('mirror', { what: ['status'] });          // a frame scheduled, then stopped under it
  SC.stopSessionControl();
  assert.deepEqual(timers.pending(), [], 'cleared');
  assert.equal(frames('cs-stop').length + frames('cp-stop').length, 0, 'both unmounted');
  await shell.tick();
  await show();
  assert.equal(frames('cs-stop').length, 0, 'stopped: deaf to the mirror');
  timers = fakeTimers();
  SC.initSessionControl({ timers });
  await shell.tick();
  assert.equal(frames('cs-stop').length, 1, 'a fresh init mounts at once');
});

/* ── the port rule ─────────────────────────────────────────────────────────── */

test('the port rule: mountStop with a port cached over 60 s ago mounts AT ONCE there and the refresh\'s new port remounts it', async () => {
  let t = 1_000_000;
  await reset({ asks: { now: () => t } });
  await show();
  SC.stopSessionControl();
  t += 61_000;
  let answer;
  asksAnswer = () => new Promise((r) => { answer = r; });
  const gets = asksGets();
  const el = host();
  const h = SC.mountStop(el, { conversationId: 'c1', size: 'bar' });
  assert.ok(h, 'synchronous');
  assert.equal(h.frame.src, `${LOOP}/answer/control/interrupt?conversation_id=c1&size=bar&layout=stop&mode=light&device=desktop`);
  await shell.tick();
  assert.equal(asksGets(), gets + 1, 'refreshing in the background');
  answer({ asks: [], answer: { port: 4700 } });
  await shell.tick();
  assert.match(el.querySelector('iframe').src, /^http:\/\/127\.0\.0\.1:4700\/answer\/control\/interrupt\?/, 'remounted at the new port');
  h.unmount();
  assert.equal(el.childNodes.length, 0);
  el.remove();
  asksAnswer = { asks: [], answer: { port: PORT } };
  await reset();
});

test('the port rule: with no port at all mountStop answers null at once, and the port event the refresh emits mounts the Stop', async () => {
  asksAnswer = { asks: [], answer: null };
  await reset();
  let answer;
  asksAnswer = () => new Promise((r) => { answer = r; });
  const gets = asksGets();
  await show();
  assert.equal(frames('cs-stop').length, 0, 'no port: the slot waits');
  assert.equal(SC.mountStop(host(), { conversationId: 'c1' }), null, 'null at once');
  await shell.tick();
  // The hello's refresh and the mounts share one GET; no GET per mirror event.
  const after = asksGets();
  assert.ok(after - gets <= 2, `one shared refresh per cause (${after - gets})`);
  bus.emit('mirror', { what: ['status'] });
  bus.emit('mirror', { what: ['status'] });
  await shell.tick();
  assert.equal(asksGets(), after, 'a waiting slot does not ask on every mirror event');
  answer({ asks: [], answer: { port: PORT } });
  await shell.tick();
  assert.equal(one('cs-stop').src, src('cs-stop', 'c1', 'bar'), 'the port event mounted it');
  assert.equal(one('cp-stop').src, src('cp-stop', 'c1', 'panel'));
  asksAnswer = { asks: [], answer: { port: PORT } };
});

test('a Stop that posts no size in 3 s is remounted once at the refreshed port — never the popup — then #cs-stop is empty until the next refresh', async () => {
  const asksTimers = fakeTimers();
  await reset({ asks: { timers: asksTimers } });
  await show();
  const first = one('cs-stop');
  const gets = asksGets();
  asksTimers.fire(3000);
  await shell.tick();
  assert.equal(asksGets(), gets + 1, 'the port refreshed');
  assert.equal(doc.querySelector('#cs-stop button, #cp-stop button'), null, 'never the popup button');
  const second = one('cs-stop');
  assert.notEqual(second, first, 'remounted once');
  asksTimers.fire(3000);
  await shell.tick();
  assert.ok($('cs-stop').matches(':empty'), 'a second silence: the slot is empty');
  assert.ok($('cp-stop').matches(':empty'));
  bus.emit('mirror', { what: ['status'] });
  await shell.tick();
  assert.ok($('cs-stop').matches(':empty'), 'and stays empty on mirror events');
  // The next port refresh (a reconnect's hello) brings it back.
  await shell.frame(helloFrame());
  await shell.tick();
  assert.equal(frames('cs-stop').length, 1, 'back at the next refresh');
  await reset();
});

/* ── the one helper ────────────────────────────────────────────────────────── */

test('mountControlFrame: a confirm frame allows the clipboard and carries the params and size; it refuses what it cannot frame', async () => {
  await reset();
  await show();
  const el = host();
  const h = SC.mountControlFrame(el, { action: 'restore', params: { preview: 'pv_1' }, layout: 'confirm', size: 'compact' });
  assert.ok(h);
  assert.equal(h.frame.src, `${LOOP}/answer/control/restore?preview=pv_1&size=compact&layout=confirm&mode=light&device=desktop`);
  assert.equal(h.frame.getAttribute('allow'), 'clipboard-write');
  h.unmount();
  assert.equal(el.childNodes.length, 0);
  for (const bad of [
    { action: 'restore', params: { preview: 'pv_1' }, layout: 'card' },
    { action: '../ask', layout: 'confirm' },
    { action: 'Restore', layout: 'confirm' },
    { action: 'restore', params: { layout: 'page' }, layout: 'confirm' },
    { action: 'restore', params: { mode: 'dark' }, layout: 'confirm' },
    { action: 'restore', params: { 'bad key': 'x' }, layout: 'confirm' },
    { action: 'restore', params: { preview: { x: 1 } }, layout: 'confirm' },
    { action: 'restore', params: { preview: 'x'.repeat(300) }, layout: 'confirm' },
    { action: 'restore', layout: 'confirm', size: 'Huge!' },
  ]) assert.equal(SC.mountControlFrame(el, bad), null, JSON.stringify(bad));
  assert.equal(SC.mountStop(el, { conversationId: 'c 1' }), null);
  assert.equal(SC.mountStop(el, { conversationId: 'c1', size: 'huge' }), null);
  assert.equal(SC.mountControlFrame(null, { action: 'restore', layout: 'confirm' }), null);
  assert.equal(el.childNodes.length, 0);
  el.remove();
});

test('onDone hears only the layout\'s own outcomes, and never more than counts', async () => {
  const el = host();
  const got = [];
  const h = SC.mountControlFrame(el, { action: 'fork', params: { turn_id: 't1' }, layout: 'confirm', onDone: (o, r) => got.push([o, r]) });
  const s = SC.mountControlFrame(host(), { action: 'interrupt', params: { conversation_id: 'c1' }, layout: 'stop', onDone: (o) => got.push([`stop:${o}`]) });
  const post = (frame, data) => W.dispatchEvent(new W.MessageEvent('message', { data, origin: LOOP, source: frame.contentWindow }));
  post(h.frame, { type: 'wc-answer:done', outcome: 'interrupted' });
  post(h.frame, { type: 'wc-answer:done', outcome: 'forked', result: { command: 'claude --resume x', n: 1 } });
  post(s.frame, { type: 'wc-answer:done', outcome: 'restored' });
  post(s.frame, { type: 'wc-answer:done', outcome: 'interrupted' });
  assert.deepEqual(got, [['forked', { n: 1 }], ['stop:interrupted']]);
  assert.deepEqual([...SC.OUTCOMES.stop], ['interrupted']);
  assert.deepEqual([...SC.OUTCOMES.confirm], ['restored', 'failed', 'undone', 'forked', 'refused']);
  h.unmount();
  s.unmount();
  el.remove();
});

/* ── the stopper seam (U46b; ruling E1 (a)) ────────────────────────────────── */

test('mountControlFrame in a registerStopper slot: a test stopper mounts a confirm frame in div.cs-row-confirm at compact and touch, answers true, unmount removes it', async () => {
  await reset();
  await show();
  const log = [];
  const handles = new Map();
  const off = CA.registerStopper({
    mount(slot, row, { density }) {
      const h = SC.mountControlFrame(slot, { action: 'task-stop', params: { task_id: row.id }, layout: 'confirm' });
      log.push({ slot, density, mounted: !!h });
      if (!h) return false;
      handles.set(slot, h);
      return true;
    },
    unmount(slot) { const h = handles.get(slot); if (h) { h.unmount(); handles.delete(slot); } },
  });
  const posts = () => shell.calls.filter((c) => c.url.startsWith('/api/queue/task-stop')).length;
  const before = posts();
  try {
    const list = host();
    const model = () => P.categories(S.mirror, Q.queueSnapshot(), { now: S.serverNow() }).find((e) => e.cat === 'shells').rows.find((r) => r.id === 's1');
    for (const density of ['compact', 'touch']) {
      const rowEl = R.rowEl(model(), { density });
      list.append(rowEl);
      const button = rowEl.querySelector('.cs-row-actions [data-action="kill"]');
      assert.ok(button, `${density}: a Kill`);
      CA.runAction(model(), 'kill', { rowEl, density, button });
      const last = log.at(-1);
      assert.equal(last.density, density);
      assert.equal(last.mounted, true, `${density}: the helper mounted`);
      const slot = rowEl.querySelector('div.cs-row-confirm');
      assert.ok(slot, `${density}: the slot`);
      assert.equal(slot, last.slot);
      assert.equal(slot.classList.contains('cs-row-confirm-touch'), density === 'touch');
      const f = slot.querySelector('iframe.wc-answer-frame');
      assert.ok(f, `${density}: the confirm frame in the slot`);
      assert.equal(f.src, `${LOOP}/answer/control/task-stop?task_id=s1&layout=confirm&mode=light&device=desktop`);
      assert.equal(posts(), before, 'the stopper owns the stop: no queue POST');
      // Another stop action on the row reverts the slot: unmount runs, the frame goes.
      CA.runAction(model(), 'kill', { rowEl, density, button });
      assert.equal(rowEl.querySelector('iframe'), null, `${density}: unmount removed it`);
      assert.equal(handles.size, 0);
      rowEl.remove();
    }
    list.remove();
  } finally {
    off();
  }
});
