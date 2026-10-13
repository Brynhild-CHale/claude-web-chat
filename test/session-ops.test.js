// The session controls in the chat panel's header (public/app/session-ops.js,
// U93; spec §15.7 'Session controls', §15.5, §7.9 #cp-ops, §8.5; rulings Q10,
// Q-E, D1 (a), D-defaults (a)), through the real shell
// (test-support/chrome-shell.js) with initSessionOps passed in (main.js calls it
// from U94a on), the panel and the Stop control as main.js starts them, and a
// fake answer origin (GET /api/asks names its port):
//   * with no mod #cp-ops stays empty, and app.css hides it; with process.mod
//     and capabilities.mod the meter, Compact now, Plan mode and ⋯ render;
//   * the meter reads 38 % from a context reading {tokens: 76000, window:
//     200000, percent: 38}, amber from 80 %, and is hidden with none — never a
//     guess from the meta line's counts; one request in flight, at most once
//     per 2 s, read again when a turn closes and on the reconnect's snapshot;
//   * 'Compact now' mounts ONE confirm frame for session-compact with
//     conversation_id; after 'done' the meter reads Compacting… and, with no
//     compacting state within 120 s (stubbed timers), the did-not-start line;
//     an auto-compaction shows the same line and clears when it ends;
//   * plan: with permission_mode 'plan' the control reads Plan mode on and
//     mounts nothing;
//   * the ⋯ popover opens and closes by Escape and an outside press through
//     shell.js (init adds no document listener), and its own trigger toggles
//     it; Rename mounts session-rename with the typed name as a param; Resume ▸
//     is absent unless capabilities.rewind_in_place, then lists ended,
//     non-headless conversations only;
//   * the sheet variant: frames sized 'sheet', controls 44px and #cp-ops on a
//     row of its own (test-support/css-cascade.js); a chat:host move drops an
//     open frame and the popover;
//   * no id of its own, no fetch of an acting route, no innerHTML.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { createCascade } = require('../test-support/css-cascade');
const { isReservedId } = require('../lib/server/domain/mounts');

const REPO = path.resolve(__dirname, '..');
const APP = path.join(REPO, 'public/app');
const CSS = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');
const T0 = Date.UTC(2026, 9, 13, 14, 0, 0);
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };
const PORT = 4567;
const LOOP = `http://127.0.0.1:${PORT}`;
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

let shell, W, doc, $, bus, S, SO, cascade;
let current = null;
let rev = 11000;
let clock = T0;
let timers;
let docListeners = 0;
const readings = new Map();   // conversation id → context | null

// Timers the test fires by hand: the meter's throttle and the compaction wait.
function fakeTimers() {
  const pending = new Map();
  let n = 0;
  return {
    setTimeout(fn, ms) { const id = ++n; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    pending: () => [...pending.values()].map((t) => t.ms),
    fire(pred) { for (const [id, t] of [...pending]) if (pred(t.ms)) { pending.delete(id); t.fn(); } },
  };
}

const CAPS = { mod: true, rewind_in_place: false };
function conversation(id, { state = 'idle', mod = true, mode = 'default', sid = S1, headless = false, title = `title ${id}`, turns = 1, endedAt } = {}) {
  const c = { id, rev: 1, title, headless, counts: ZERO, current_session_id: sid, permission_mode: mode, turn_count: turns,
    process: { pid: 4242, mod }, live: { state, since: T0, last_activity_at: T0 } };
  if (endedAt) c.ended_at = endedAt;
  return c;
}
function snapshot({ conversations = [conversation('c1')], caps = CAPS, access = { level: 'local', remote: false }, primary = 'c1' } = {}) {
  return { v: 1, enabled: true, now: Date.now(), rev: ++rev, content: true, access, capabilities: caps,
    primary, aggregate: { state: 'idle' }, conversations, tasks: [], asks: [] };
}

async function show(over = {}) {
  current = snapshot(over);
  const want = current.rev;
  await shell.frame(helloFrame());
  await waitUntil(() => S.mirror.rev >= want, { timeout: 3000, what: 'the snapshot' });
  await shell.tick();
  await shell.tick();
}

const ops = () => $('cp-ops');
const q = (sel) => ops().querySelector(sel);
const contextGets = () => shell.calls.filter((c) => c.url.startsWith('/api/mirror/context'));
const frames = () => [...ops().querySelectorAll('iframe.wc-answer-frame')];
const popEl = () => q('.so-pop');
const popOpen = () => !!popEl() && !popEl().classList.contains('hidden');
const advance = (ms) => { clock += ms; };
// Let the meter's next read through: past the 2 s gap, and fire any trailing timer.
async function settle() {
  advance(SO.METER_GAP_MS + 1);
  timers.fire((ms) => ms <= SO.METER_GAP_MS);
  await shell.tick();
  await shell.tick();
}
const done = (frame) => W.dispatchEvent(new W.MessageEvent('message', { data: { type: 'wc-answer:done', outcome: 'done' }, origin: LOOP, source: frame.contentWindow }));
const meterText = () => (q('.so-meter') ? q('.so-meter .so-text').textContent : null);

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/mirror': () => current,
      '/api/asks': () => ({ asks: [], answer: { port: PORT } }),
      '/api/mirror/context': (url) => {
        const cid = new URL(url, 'http://x').searchParams.get('conversation');
        const ctx = readings.has(cid) ? readings.get(cid) : null;
        return ctx === undefined ? respond({ ok: false }, { status: 500 }) : { ok: true, context: ctx };
      },
    },
    init: async (sh) => {
      SO = await sh.importApp('session-ops.js');
      const D = sh.window.document;
      const orig = D.addEventListener;
      D.addEventListener = function counted(...args) { docListeners += 1; return orig.apply(this, args); };
      timers = fakeTimers();
      try {
        SO.initSessionOps({ timers, now: () => clock });
        SO.initSessionOps({ timers, now: () => clock });   // idempotent
      } finally { D.addEventListener = orig; }
    },
  });
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  cascade = createCascade(CSS, { win: () => W });
  bus.emit('chat:open', { view: 'chat' });
  await shell.tick();
});

after(() => {
  if (SO) SO.stopSessionOps();
  return shell.restore();
});

/* ── when it shows ──────────────────────────────────────────────────────── */

test('init adds no document listener (shell.js owns Escape and the outside press)', () => {
  assert.equal(docListeners, 0);
});

test('with no mod, no capabilities.mod, an ended conversation or a viewer below full, #cp-ops stays empty and app.css hides it', async () => {
  for (const over of [
    { conversations: [conversation('c1', { mod: false })] },
    { caps: { mod: false } },
    { conversations: [conversation('c1', { state: 'ended' })] },
    { access: { level: 'read', remote: true } },
  ]) {
    readings.set('c1', { tokens: 76000, window: 200000, percent: 38, at: T0 });
    await show(over);
    assert.equal(ops().childNodes.length, 0, JSON.stringify(over));
    assert.equal(cascade.value(ops(), 'display'), 'none', 'hidden while :empty');
  }
});

test('with process.mod and capabilities.mod: the meter (38 % from the reading), Compact now, Plan mode and ⋯', async () => {
  readings.set('c1', { tokens: 76000, window: 200000, percent: 38, at: T0 });
  await settle();
  const n = contextGets().length;
  await show();
  await waitUntil(() => meterText() !== null, { timeout: 2000, what: 'the meter' });
  assert.equal(contextGets().length, n + 1, 'one read');
  assert.equal(contextGets().at(-1).url, '/api/mirror/context?conversation=c1');
  assert.equal(meterText(), '38% · 76k of 200k');
  assert.equal(q('.so-fill').style.getPropertyValue('--so-pct'), '38%');
  assert.equal(q('.so-meter').hasAttribute('data-so-level'), false);
  assert.equal(q('.so-compact').textContent, 'Compact now');
  assert.equal(q('.so-plan').textContent, 'Plan mode');
  assert.equal(q('.so-plan').title, 'Also switches the model, as /plan does in the terminal');
  assert.equal(q('.so-more').textContent, '⋯');
  assert.notEqual(cascade.value(ops(), 'display'), 'none');
  assert.equal(ops().querySelectorAll('[id]').length, 0, 'no id of its own');
  assert.doesNotMatch(ops().textContent, /model:|effort|config/i, 'no model, effort or config control (Q10)');
});

test('the meter: hidden with no reading — never the meta line\'s counts; amber from 80 %', async () => {
  readings.set('c2', null);
  await settle();
  await show({ conversations: [conversation('c2')], primary: 'c2' });
  await settle();
  await waitUntil(() => contextGets().some((c) => c.url.endsWith('conversation=c2')), { timeout: 2000, what: 'the read' });
  await shell.tick();
  assert.equal(q('.so-meter'), null, 'no reading: no meter');
  assert.ok(q('.so-compact'), 'the controls are still there');
  readings.set('c2', { tokens: 164000, window: 200000, percent: 82, at: T0 + 1 });
  await settle();
  bus.emit('mirror', { what: ['all'] });   // the reconnect's snapshot reads it again
  await shell.tick();
  await waitUntil(() => meterText() === '82% · 164k of 200k', { timeout: 2000, what: 'the new reading' });
  assert.equal(q('.so-meter').getAttribute('data-so-level'), 'amber');
  assert.equal(cascade.value(q('.so-fill'), 'background'), 'var(--wc-gold)');
});

test('the meter is read once per 2 s at most, one request in flight; a turn that closes reads it again', async () => {
  readings.set('c1', { tokens: 76000, window: 200000, percent: 38, at: T0 });
  await settle();
  await show({ conversations: [conversation('c1', { state: 'working' })] });
  await settle();
  await waitUntil(() => meterText() === '38% · 76k of 200k', { timeout: 2000, what: 'the meter' });
  const n = contextGets().length;
  // Within the gap: a burst of snapshots asks once more, at its end.
  bus.emit('mirror', { what: ['all'] });
  bus.emit('mirror', { what: ['all'] });
  await shell.tick();
  assert.equal(contextGets().length, n, 'nothing inside the 2 s gap');
  assert.deepEqual(timers.pending().filter((ms) => ms <= SO.METER_GAP_MS).length, 1, 'one trailing timer');
  await settle();
  assert.equal(contextGets().length, n + 1, 'one read at the end of the gap');
  // The turn closes: read again.
  readings.set('c1', { tokens: 90000, window: 200000, percent: 45, at: T0 + 2 });
  advance(SO.METER_GAP_MS + 1);
  await show({ conversations: [conversation('c1', { state: 'idle', turns: 2 })] });
  await waitUntil(() => meterText() === '45% · 90k of 200k', { timeout: 2000, what: 'the reading after the turn' });
  assert.equal(contextGets().length, n + 2);
});

/* ── Compact now ─────────────────────────────────────────────────────────── */

test('Compact now mounts ONE confirm frame for session-compact; after done the meter reads Compacting…, then the did-not-start line at 120 s', async () => {
  readings.set('c1', { tokens: 76000, window: 200000, percent: 38, at: T0 });
  await settle();
  await show();
  await waitUntil(() => meterText() !== null, { timeout: 2000, what: 'the meter' });
  shell.press(q('.so-compact'));
  await shell.tick();
  assert.ok(popOpen(), 'the popover holds it');
  const [f, ...more] = frames();
  assert.equal(more.length, 0, 'one frame');
  const u = new URL(f.src);
  assert.equal(u.origin, LOOP);
  assert.equal(u.pathname, '/answer/control/session-compact');
  assert.equal(u.searchParams.get('conversation_id'), 'c1');
  assert.equal(u.searchParams.get('layout'), 'confirm');
  assert.equal(u.searchParams.get('size'), 'panel');
  assert.equal(q('.so-confirm').getAttribute('data-so-size'), 'panel');
  assert.equal(shell.calls.filter((c) => c.method === 'POST' && /control|session/.test(c.url)).length, 0, 'the chrome posts nothing');
  done(f);
  await shell.tick();
  assert.equal(popOpen(), false, 'done closes the popover');
  assert.equal(frames().length, 0);
  assert.equal(meterText(), 'Compacting…');
  assert.ok(timers.pending().includes(SO.COMPACT_WAIT_MS), 'one bounded wait');
  timers.fire((ms) => ms === SO.COMPACT_WAIT_MS);
  await shell.tick();
  assert.equal(meterText(), 'Compaction did not start — run /compact in the terminal');
  // A compaction that does run, and ends: the line goes and the meter is read again.
  await show({ conversations: [conversation('c1', { state: 'compacting' })] });
  assert.equal(meterText(), 'Compacting…');
  readings.set('c1', { tokens: 20000, window: 200000, percent: 10, at: T0 + 3 });
  advance(SO.METER_GAP_MS + 1);
  await show({ conversations: [conversation('c1', { state: 'idle' })] });
  await waitUntil(() => meterText() === '10% · 20k of 200k', { timeout: 2000, what: 'the reading after compaction' });
  assert.equal(timers.pending().includes(SO.COMPACT_WAIT_MS), false, 'the wait is cleared');
});

test('an auto-compaction the user did not ask for shows the same line, with the same timeout', async () => {
  readings.set('c1', { tokens: 190000, window: 200000, percent: 95, at: T0 });
  await settle();
  await show({ conversations: [conversation('c1', { state: 'compacting' })] });
  await waitUntil(() => q('.so-meter'), { timeout: 2000, what: 'the meter' });
  assert.equal(meterText(), 'Compacting…');
  timers.fire((ms) => ms === SO.COMPACT_WAIT_MS);
  await shell.tick();
  assert.equal(meterText(), 'Compaction did not start — run /compact in the terminal');
  await show({ conversations: [conversation('c1', { state: 'idle' })] });
  assert.notEqual(meterText(), 'Compaction did not start — run /compact in the terminal', 'it ended: the line goes');
});

/* ── Plan mode ───────────────────────────────────────────────────────────── */

test('Plan mode mounts a session-plan frame; with permission_mode plan it reads Plan mode on and mounts nothing', async () => {
  await show();
  shell.press(q('.so-plan'));
  await shell.tick();
  const [f] = frames();
  assert.equal(new URL(f.src).pathname, '/answer/control/session-plan');
  assert.equal(new URL(f.src).searchParams.get('conversation_id'), 'c1');
  await show({ conversations: [conversation('c1', { mode: 'plan' })] });
  assert.equal(q('.so-plan'), null, 'no button');
  assert.equal(popOpen(), false, 'its open frame went with it');
  const on = q('.so-plan-on');
  assert.equal(on.textContent, 'Plan mode on');
  assert.equal(on.title, 'leave it in the terminal (Shift+Tab)');
  assert.equal(on.tagName, 'SPAN', 'it offers nothing');
  shell.press(on);
  await shell.tick();
  assert.equal(frames().length, 0);
  await show();
  assert.ok(q('.so-plan'), 'back to the button when plan mode is left');
});

/* ── ⋯ ───────────────────────────────────────────────────────────────────── */

test('⋯ opens one .popover; Escape and an outside press close it through shell.js; its own trigger toggles it', async () => {
  await show();
  shell.press(q('.so-more'));
  await shell.tick();
  assert.ok(popOpen());
  assert.equal(q('.so-more').getAttribute('aria-expanded'), 'true');
  assert.deepEqual([...popEl().querySelectorAll('.so-item')].map((b) => b.textContent), ['Rename…', 'Clear']);
  shell.key('Escape');
  await shell.tick();
  assert.equal(popOpen(), false, 'Escape');
  assert.equal(q('.so-more').getAttribute('aria-expanded'), 'false');
  shell.press(q('.so-more'));
  await shell.tick();
  assert.ok(popOpen());
  shell.press($('chat-stream'));
  await shell.tick();
  assert.equal(popOpen(), false, 'an outside press');
  shell.press(q('.so-more'));
  await shell.tick();
  assert.ok(popOpen());
  shell.press(q('.so-more'));
  await shell.tick();
  assert.equal(popOpen(), false, 'its own trigger closes it, never closed-then-reopened');
});

test('Clear mounts session-clear; Rename mounts session-rename with the typed name as a param, and a new keystroke takes the frame down', async () => {
  await show();
  shell.press(q('.so-more'));
  await shell.tick();
  shell.click(popEl().querySelector('[data-so="clear"]'));
  await shell.tick();
  let [f, ...more] = frames();
  assert.equal(more.length, 0);
  assert.equal(new URL(f.src).pathname, '/answer/control/session-clear');

  shell.press(q('.so-more'));
  await shell.tick();
  assert.equal(frames().length, 0, 'one frame at a time');
  shell.click(popEl().querySelector('[data-so="rename"]'));
  await shell.tick();
  const input = popEl().querySelector('input.so-name');
  assert.equal(input.maxLength, 100);
  assert.equal(input.type, 'text');
  input.value = 'Payments refactor';
  input.dispatchEvent(new W.Event('input', { bubbles: true }));
  shell.click(popEl().querySelector('.so-go'));
  await shell.tick();
  [f, ...more] = frames();
  assert.equal(more.length, 0);
  const u = new URL(f.src);
  assert.equal(u.pathname, '/answer/control/session-rename');
  assert.deepEqual([u.searchParams.get('conversation_id'), u.searchParams.get('name')], ['c1', 'Payments refactor'],
    'the frame shows the name before the click');
  input.value = 'Payments refactor 2';
  input.dispatchEvent(new W.Event('input', { bubbles: true }));
  assert.equal(frames().length, 0, 'the old name\'s frame is taken down');
  input.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await shell.tick();
  assert.equal(new URL(frames()[0].src).searchParams.get('name'), 'Payments refactor 2');
  done(frames()[0]);
  await shell.tick();
  assert.equal(popOpen(), false);
});

test('Resume ▸ is absent unless capabilities.rewind_in_place; then it lists ended, non-headless conversations only, by title', async () => {
  const convs = [
    conversation('c1'),
    conversation('c2', { state: 'ended', sid: S2, title: 'last week', endedAt: T0 - 1000 }),
    conversation('c3', { state: 'ended', sid: S3, title: 'a headless job', headless: true, endedAt: T0 - 500 }),
    conversation('c4', { state: 'idle', sid: '44444444-4444-4444-8444-444444444444', title: 'still running' }),
    conversation('c5', { state: 'ended', sid: '55555555-5555-4555-8555-555555555555', title: 'yesterday', endedAt: T0 - 100 }),
  ];
  await show({ conversations: convs });
  shell.press(q('.so-more'));
  await shell.tick();
  assert.equal(popEl().querySelector('[data-so="resume"]'), null, 'no Resume without the flag');
  shell.key('Escape');
  await show({ conversations: convs, caps: { mod: true, rewind_in_place: true } });
  shell.press(q('.so-more'));
  await shell.tick();
  shell.click(popEl().querySelector('[data-so="resume"]'));
  await shell.tick();
  const items = [...popEl().querySelectorAll('.so-list .so-item')];
  assert.deepEqual(items.map((b) => b.textContent), ['yesterday', 'last week'], 'ended and not headless, newest first');
  shell.click(items[1]);
  await shell.tick();
  const u = new URL(frames()[0].src);
  assert.equal(u.pathname, '/answer/control/session-resume');
  assert.deepEqual([u.searchParams.get('conversation_id'), u.searchParams.get('target')], ['c1', S2]);
  shell.key('Escape');
  await shell.tick();
  assert.equal(frames().length, 0, 'Escape takes the frame with the popover');
});

/* ── the phone sheet ─────────────────────────────────────────────────────── */

test('the sheet variant: frames sized sheet, the controls 44px and #cp-ops on its own row of the head; a host move drops an open frame', async () => {
  await show();
  const home = $('chat-panel').parentNode;
  const away = doc.createElement('div');
  doc.body.append(away);
  try {
    shell.press(q('.so-compact'));
    await shell.tick();
    assert.equal(frames().length, 1);
    bus.emit('chat:host', { host: away, variant: 'sheet' });
    await shell.tick();
    assert.equal($('chat-panel').dataset.variant, 'sheet');
    assert.equal(frames().length, 0, 'the move drops the open frame');
    assert.equal(popOpen(), false, 'and the popover');
    // A tap, as a finger gives one (sheet-drag eats a bare click after a drag).
    const btn = q('.so-compact');
    btn.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerType: 'touch' }));
    btn.dispatchEvent(new W.PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, pointerType: 'touch' }));
    shell.click(btn);
    await shell.tick();
    const [f] = frames();
    assert.match(f.src, /[?&]size=sheet&/);
    assert.equal(q('.so-confirm').getAttribute('data-so-size'), 'sheet');
    for (const sel of ['.so-compact', '.so-plan', '.so-more']) {
      assert.equal(cascade.value(q(sel), 'min-height'), '44px', `${sel}: 44px`);
      assert.equal(cascade.value(q(sel), 'min-width'), '44px', `${sel}: 44px wide at least`);
    }
    const head = $('chat-panel').querySelector('.cp-head');
    assert.equal(cascade.value(head, 'flex-wrap'), 'wrap');
    assert.equal(cascade.value(ops(), 'flex-basis'), '100%', '#cp-ops takes a row of its own');
    assert.equal(cascade.value(ops(), 'order'), '10', '…after the title, Stop and Close');
  } finally {
    bus.emit('chat:host', { host: home, variant: 'desktop' });
    await shell.tick();
    away.remove();
  }
  assert.equal(cascade.value(q('.so-compact'), 'min-height'), null, 'back on the desktop: no 44px rule');
  assert.equal(cascade.value(ops(), 'flex-basis'), null);
  assert.equal(cascade.value($('chat-panel').querySelector('.cp-head'), 'flex-wrap'), null);
});

/* ── stop, and the source ────────────────────────────────────────────────── */

test('stopSessionOps empties #cp-ops and clears its timers; init draws it again', async () => {
  await show({ conversations: [conversation('c1', { state: 'compacting' })] });
  assert.ok(ops().childNodes.length > 0);
  assert.ok(timers.pending().includes(SO.COMPACT_WAIT_MS), 'the auto-compaction\'s wait');
  SO.stopSessionOps();
  assert.equal(ops().childNodes.length, 0);
  assert.deepEqual(timers.pending(), [], 'no timer survives stop');
  SO.initSessionOps({ timers, now: () => clock });
  await shell.tick();
  assert.ok(q('.so-compact'));
  await show();
});

test('the source: no id of its own, no innerHTML, no acting route, no document listener, no setInterval; the U93 CSS uses tokens only', () => {
  const src = fs.readFileSync(path.join(APP, 'session-ops.js'), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  const ids = [
    ...[...code.matchAll(/\.id\s*=\s*['"`]([a-zA-Z][\w-]*)['"`]/g)].map((m) => m[1]),
    ...[...code.matchAll(/getElementById\(\s*['"`]([a-zA-Z][\w-]*)['"`]/g)].map((m) => m[1]),
  ];
  assert.deepEqual(ids, ['cp-ops']);
  assert.ok(ids.every(isReservedId));
  assert.doesNotMatch(code, /\.id\s*=(?!=)|setAttribute\(\s*'id'/, 'never sets an id');
  assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(code, /document\.addEventListener|setInterval|localStorage|sessionStorage/);
  assert.doesNotMatch(code, /'\/answer\/|\/api\/control|method:\s*'POST'/, 'no acting route');
  assert.deepEqual([...code.matchAll(/fetch\(/g)].length, 1, 'one fetch: the reading');
  assert.doesNotMatch(code, /\bmodel\b.*(switch|select)|effort/i);
  const FROM = CSS.indexOf('/* ── U93 · session controls on the mod');
  assert.ok(FROM > 0);
  const TO = CSS.indexOf('/* ── ', FROM + 1);
  const section = CSS.slice(FROM, TO === -1 ? undefined : TO).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(section, /#[0-9a-fA-F]{3,8}\b/, 'no hex');
  assert.match(section, /prefers-reduced-motion/);
  assert.doesNotMatch(section, /(^|[^-])filter\s*:|opacity\s*:|transform\s*:/m, 'nothing a frame\'s visibility proof would read as covered');
});
