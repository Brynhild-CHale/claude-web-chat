// Tranche 5's end-to-end check (design spec §11.8): the phone, through the REAL
// main.js booted once in jsdom at 390×844 (test-support/chrome-shell.js), with
// nothing initialised by the test — main.js starts the sheet, Tasks, the queue
// page, the keyboard and the dock itself (U73).
//
// Pinned, a test per clause:
//   * main.js calls initChatSheet, initSheetTasks, initSheetQueue,
//     initSheetKeyboard and initTabDock once each, in that order, after
//     initTurnActions and before connect(); a second call of each adds nothing;
//   * no stand-in is left on the phone: no .pull-stub, no "Under development";
//   * (1) the tab's six states (§8.3), suspended included — data-cs-state, the
//     width (--tab-w) and the aria-label — from mirror bodies the store reads
//     after a hello, and offline from a dropped socket;
//   * (2) a tap opens half (341) and a second tap closes; a vertical drag from
//     closed past 40px snaps to half, and one from half up to full (622);
//   * (3) the Tasks root from the Final's fixture: the segment reads
//     "6 running", five lines in order;
//   * (4) the Queue page holds #queue-rail.in-sheet — the one element the boot
//     parsed, moved, never copied — and Push from it posts /api/queue/push
//     once while its feedback keeps the sheet on Tasks → Queue;
//   * (5) a horizontal drag docks the tab left (the badge on its inner side, by
//     the cascade of app.css), then centre (the badge merged: .ct-count "6",
//     the aria-label's ", 6 running"); stopTabDock() then initTabDock() — the
//     path a reload runs, since bootShell boots once per file and cannot seed
//     storage before main.js — reads "center" back from wc:chat-tab;
//   * an answerable ask (approvals registered, level local, avail 500) opens
//     the sheet at full, and the awaiting card mounts through mountSheet;
//   * the flip to 1280 closes the sheet and returns the rail to .body;
//   * the sheet sends nothing new on the socket: the posture rides the
//     existing `client` frame's `mirror` field (test/bus-golden.test.js stays
//     byte-identical; it is its own file).
//
// jsdom lays nothing out: #topbar, #bottombar and #chat-pull get rectangles
// (shell.scrollMetrics) for avail 644 — full 622, half 341 — or 500 (full
// 478, half 265). The real layout is test/t5-geometry-e2e.test.js's, opt-in.
const test = require('node:test');
const { describe, before, after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { finalFixture } = require('../test-support/final-fixture');

const REPO = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');
const MAIN = fs.readFileSync(path.join(REPO, 'public/app/main.js'), 'utf8');

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const TRANCHE5 = ['initChatSheet', 'initSheetTasks', 'initSheetQueue', 'initSheetKeyboard', 'initTabDock'];
const DOCK_KEY = 'wc:chat-tab';
const PULL_W = 390;
const WAIT = { timeout: 5000, interval: 10 };
const ANSWER_PORT = 54321;   // the answer surface's port GET /api/asks?ensure=1 names: approvals register

// ── the store's answers ──────────────────────────────────────────────────────

let rev = 100;
const at = (ms) => Date.now() - ms;
function body(conversations, { asks = [], tasks = [] } = {}) {
  rev += 1;
  return {
    v: 1, enabled: true, now: Date.now(), rev, content: true, access: { level: 'local', remote: false },
    capabilities: { task_stop: true, queue_message: true, interrupt: true },
    primary: conversations[0] ? conversations[0].id : null,
    aggregate: { state: conversations.length ? 'working' : 'none' }, conversations, tasks, asks,
  };
}
const conversation = (live) => ({ id: 'c1', rev: 1, title: 'Queue rail redesign', headless: false,
  live: { since: at(60000), last_activity_at: at(1000), ...live } });
const STATES = {
  working: { state: 'working', step: { kind: 'Edit', tool: 'Edit', label: 'Edit · QueueRail.tsx', started_at: at(12000) } },
  question: { state: 'question', waiting: { kind: 'question', summary: 'Keep the 56px rail?' } },
  waiting: { state: 'waiting', waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(npm test)' } },
  idle: { state: 'idle', last_turn: { id: 't1', outcome: 'done', ended_at: at(240000), reply_preview: 'Done.' } },
  suspended: { state: 'suspended' },
};
const ASK = { id: 'ask-t5', conversation_id: 'c1', kind: 'permission', state: 'pending', answerable: true,
  tool_name: 'Bash', summary: 'Bash(npm test)', created_at: at(2000) };

const fixture = finalFixture({ now: Date.now() });
const current = { mirror: fixture.mirrorBody, queue: fixture.queueBody };
const pushAnswer = { ok: true, mode: 'parked', pending_id: 'pw1', delivers: 'Pushed — delivers with your next message.' };
let parked = null;

// ── app.css, cascaded against the live DOM (as test/tab-dock.test.js reads it) ─

const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
function closing(text, open) {
  const [o, c] = text[open] === '(' ? ['(', ')'] : ['{', '}'];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return i;
  }
  throw new Error(`app.css has an unbalanced '${o}'`);
}
function parseRules(text, base = 0, media = null, out = []) {
  for (let i = 0; ;) {
    const open = text.indexOf('{', i);
    if (open < 0) return out;
    const lead = text.slice(i, open);
    const prelude = lead.trim();
    const close = closing(text, open);
    const inner = text.slice(open + 1, close);
    if (prelude.startsWith('@media')) parseRules(inner, base + open + 1, prelude.slice('@media'.length).trim(), out);
    else if (!prelude.startsWith('@')) {
      const decls = [];
      for (const d of inner.split(';')) {
        const c = d.indexOf(':');
        if (c > 0) decls.push([d.slice(0, c).trim(), d.slice(c + 1).trim()]);
      }
      out.push({ at: base + i + (lead.length - lead.trimStart().length), media, selector: prelude, decls });
    }
    i = close + 1;
  }
}
const RULES = parseRules(BARE);
function selectors(list) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { out.push(list.slice(from, i)); from = i + 1; }
  }
  out.push(list.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}
const bySpec = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function specificity(sel) {
  const s = [0, 0, 0];
  const word = (j) => (/^-?[_a-zA-Z][\w-]*/.exec(sel.slice(j)) || [''])[0];
  for (let i = 0; i < sel.length;) {
    const c = sel[i];
    if (c === '#' || c === '.') { s[c === '#' ? 0 : 1]++; i += 1 + word(i + 1).length; }
    else if (c === '[') { s[1]++; i = sel.indexOf(']', i) + 1; }
    else if (c === ':') {
      const element = sel[i + 1] === ':';
      let j = i + (element ? 2 : 1);
      const name = word(j);
      j += name.length;
      let args = '';
      if (sel[j] === '(') { const end = closing(sel, j); args = sel.slice(j + 1, end); j = end + 1; }
      if (element) s[2]++;
      else if (/^(is|not|has|matches)$/.test(name)) {
        const top = selectors(args).map(specificity).sort(bySpec).pop() || [0, 0, 0];
        for (let k = 0; k < 3; k++) s[k] += top[k];
      } else if (name !== 'where') s[1]++;
      i = j;
    } else if (/[a-zA-Z]/.test(c)) { s[2]++; i += word(i).length; }
    else i++;
  }
  return s;
}

describe('tranche 5 on a phone: the real main.js in jsdom', () => {
  let shell = null;
  let W = null;
  let doc = null;
  let $ = null;
  let bus = null;
  let sheet = null;
  let RAIL = null;          // #queue-rail as the boot left it
  const queries = new Map();

  const pull = () => $('chat-pull');
  const tab = () => $('chat-tab');
  const badge = () => $('chat-badge');
  const st = () => sheet.sheetState();
  const posts = (url) => shell.calls.filter((c) => c.url === url && c.method === 'POST');

  function cascade(el, prop) {
    let win = null;
    for (const r of RULES) {
      if (r.media) {
        if (!queries.has(r.media)) queries.set(r.media, W.matchMedia(r.media));
        if (!queries.get(r.media).matches) continue;
      }
      let spec = null;
      for (const sel of selectors(r.selector)) {
        let hit = false;
        try { hit = el.matches(sel); } catch { /* jsdom cannot parse it: no match */ }
        if (hit) { const sp = specificity(sel); if (!spec || bySpec(sp, spec) > 0) spec = sp; }
      }
      if (!spec) continue;
      r.decls.forEach(([p, raw], pos) => {
        if (p !== prop) return;
        const important = /!\s*important$/.test(raw);
        const d = { value: raw.replace(/\s*!\s*important$/, ''), important, spec, at: r.at, pos };
        const beats = !win || (d.important !== win.important ? d.important
          : (bySpec(d.spec, win.spec) || d.at - win.at || d.pos - win.pos) > 0);
        if (beats) win = d;
      });
    }
    return win ? win.value : null;
  }

  // A hello, then the store's GET /api/mirror (served `mirror`) folded in, then
  // the sheet's coalesced frame.
  async function show(mirror) {
    current.mirror = mirror;
    let read = false;
    const off = bus.on('mirror', (d) => { if (d && Array.isArray(d.what) && d.what.includes('all')) read = true; });
    try {
      await shell.frame(helloFrame());
      await waitUntil(() => read, { ...WAIT, what: 'the store to read GET /api/mirror' });
    } finally { off(); }
    await shell.tick();
  }

  // #topbar's bottom at 44 and #bottombar's top at 44 + avail; the pull 390px
  // wide on the bar's top edge; the tab where its dock lays it out (56px).
  const TAB_LEFT = { right: PULL_W - 56, center: (PULL_W - 56) / 2, left: 0 };
  function layout(avail = 644) {
    shell.scrollMetrics($('topbar'), { rect: { top: 0, height: 44, width: PULL_W } });
    shell.scrollMetrics($('bottombar'), { rect: { top: 44 + avail, height: 60, width: PULL_W } });
    shell.scrollMetrics(pull(), { rect: { left: 0, top: 44 + avail, width: PULL_W, height: 0 } });
    placeTab();
  }
  function placeTab() {
    const d = pull().dataset.dock || 'right';
    shell.scrollMetrics(tab(), { rect: { left: TAB_LEFT[d], top: 665, width: 56, height: 23 } });
  }

  let pid = 500;
  function pe(type, init, target = tab()) {
    target.dispatchEvent(new W.PointerEvent(type,
      { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', button: 0, ...init }));
  }
  // A drag of the tab by (dx, dy) from its centre, in three moves with a frame
  // between them, released on the document.
  async function dragBy(dx, dy) {
    placeTab();
    const id = ++pid;
    const x0 = TAB_LEFT[pull().dataset.dock || 'right'] + 28;
    const y0 = 676;
    pe('pointerdown', { pointerId: id, clientX: x0, clientY: y0 });
    for (let i = 1; i <= 3; i++) {
      pe('pointermove', { pointerId: id, clientX: x0 + (dx * i) / 3, clientY: y0 + (dy * i) / 3 }, doc);
      await shell.tick(5);
    }
    pe('pointerup', { pointerId: id, clientX: x0 + dx, clientY: y0 + dy }, doc);
    await shell.tick(5);
  }
  const dragTo = (x) => dragBy(x - (TAB_LEFT[pull().dataset.dock || 'right'] + 28), 0);
  // A tap as a phone sends it: pointerdown and pointerup in place, then the
  // click (the pointerdown disarms the swallower a drag before it armed).
  function tap() {
    placeTab();
    const id = ++pid;
    const x = TAB_LEFT[pull().dataset.dock || 'right'] + 28;
    pe('pointerdown', { pointerId: id, clientX: x, clientY: 676 });
    pe('pointerup', { pointerId: id, clientX: x, clientY: 676 }, doc);
    shell.click(tab());
  }

  async function closed() {
    if (st().open) sheet.closeSheet({ returnFocus: false });
    while (sheet.popPage('tasks'));
    await waitUntil(() => !(W.history.state && W.history.state.wcSheet), { ...WAIT, what: 'the sheet\'s entry to go' });
    await shell.tick();
  }

  before(async () => {
    shell = await bootShell({
      viewport: PHONE,
      routes: {
        '/api/mirror': () => current.mirror,
        '/api/queue': () => current.queue,
        '/api/queue/pending': () => ({ pending: parked }),
        '/api/queue/push': () => {
          parked = { id: 'pw1', created_at: Date.now(), envelope: { meta: { count: 2 } }, items: [], note: '' };
          return pushAnswer;
        },
        '/api/asks': { asks: [], answer: { port: ANSWER_PORT } },
      },
    });
    W = shell.window;
    doc = shell.document;
    $ = shell.$;
    ({ bus } = await shell.importApp('bus.js'));
    sheet = await shell.importApp('chat-sheet.js');
    RAIL = $('queue-rail');
    layout(644);
    await show({ ...fixture.mirrorBody, rev: ++rev });
  });

  after(() => (shell ? shell.restore() : undefined));

  test('main.js calls the five tranche-5 inits once each, in order, after initTurnActions and before connect(); a second call of each adds nothing', async () => {
    const calls = [...MAIN.matchAll(/^(init\w+|connect)\(/gm)].map((m) => m[1]);
    for (const name of TRANCHE5) assert.equal(calls.filter((c) => c === name).length, 1, `${name} once`);
    const at5 = calls.indexOf('initChatSheet');
    assert.deepEqual(calls.slice(at5 - 1, at5 + TRANCHE5.length + 1), ['initTurnActions', ...TRANCHE5, 'connect'],
      'right after initTurnActions, then connect()');
    assert.doesNotMatch(MAIN, /chat-pull-stub|initPullStub|Under development/, 'the stand-in is gone from main.js');

    const slots = await shell.importApp('chat-slots.js');
    const drag = await shell.importApp('sheet-drag.js');
    const handler = drag.dockHandler();
    const shape = () => ({
      pulls: doc.querySelectorAll('#chat-pull').length,
      scrims: doc.querySelectorAll('#chat-scrim').length,
      rails: doc.querySelectorAll('#queue-rail').length,
      roots: doc.querySelectorAll('#sh-tasks .sh-root').length,
      pages: doc.querySelectorAll('#sh-tasks .sh-page').length,
      queuePages: doc.querySelectorAll('#sh-tasks .sh-page[data-page="queue"]').length,
      views: slots.chatViews().map((v) => v.id),
      intervals: shell.intervals().length,
      dock: pull().dataset.dock,
    });
    const once = shape();
    assert.deepEqual(once.views, ['dock', 'sheet'], 'the sheet registered its chat view');
    assert.equal(once.queuePages, 1, 'the Queue page, kept');
    assert.equal(once.dock, 'right', 'the dock marked the stamped pull');
    assert.ok(handler, 'the dock registered its handler with the drag');
    (await shell.importApp('chat-sheet.js')).initChatSheet();
    (await shell.importApp('chat-sheet-tasks.js')).initSheetTasks();
    (await shell.importApp('chat-sheet-queue.js')).initSheetQueue();
    (await shell.importApp('sheet-keyboard.js')).initSheetKeyboard();
    (await shell.importApp('tab-dock.js')).initTabDock();
    await shell.tick();
    assert.deepEqual(shape(), once, 'a second init of each adds no pull, rail, page, view, ticker or dock');
    assert.equal(drag.dockHandler(), handler, 'the same dock handler');
    // One tab listener: a tap toggles once (two would open and close).
    tap();
    assert.equal(st().h, 341, 'one tab listener: one tap, one toggle, open at half');
    // The keyboard view at run time (not only its init line in the source): a
    // focused composer and a shrunk visual viewport put the pull in keyboard
    // mode, which only main.js's initSheetKeyboard could have registered.
    const input = $('chat-composer-input');
    assert.ok(input && $('chat-sheet').contains(input), 'the composer is in the sheet');
    input.focus();
    shell.setViewport({ visualHeight: 508 });
    await shell.tick();
    assert.equal(pull().classList.contains('kb'), true, 'main.js registered the keyboard view: the pull is in keyboard mode');
    input.blur();
    shell.setViewport({ visualHeight: undefined });
    await shell.tick();
    assert.equal(pull().classList.contains('kb'), false, 'and it leaves with the keyboard');
    await closed();
  });

  test('no stand-in is left on the phone: no .pull-stub and no "Under development" anywhere', () => {
    assert.equal(doc.querySelector('.pull-stub, .ps-tab, .ps-note'), null, 'no .pull-stub');
    assert.ok(pull().classList.contains('chat-pull'), '#chat-pull is the real pull');
    assert.ok(doc.querySelector('template.chat-pull-tpl'), 'the template, the markup\'s home, stays');
    assert.doesNotMatch(doc.body.textContent, /under development/i, 'no text says it');
    for (const el of doc.body.querySelectorAll('*')) {
      for (const a of ['aria-label', 'title', 'aria-description']) {
        const v = el.getAttribute(a);
        if (v) assert.doesNotMatch(v, /under development/i, `#${el.id || el.className} [${a}]`);
      }
    }
  });

  test('(1) the tab\'s six states, suspended included: data-cs-state, width and aria-label (§8.3)', async () => {
    const look = () => ({ state: pull().dataset.csState, width: pull().style.getPropertyValue('--tab-w'),
      label: tab().getAttribute('aria-label') });
    await show(body([conversation(STATES.working)]));
    assert.deepEqual(look(), { state: 'working', width: '56px', label: 'Claude is working — Edit · QueueRail.tsx' });
    await show(body([conversation(STATES.question)]));
    assert.deepEqual(look(), { state: 'question', width: '124px', label: 'Claude has a question — open the chat' });
    assert.equal(pull().querySelector('.ct-word').textContent, 'QUESTION');
    await show(body([conversation(STATES.waiting)]));
    assert.deepEqual(look(), { state: 'waiting', width: '124px', label: 'Claude needs you: permission prompt' });
    assert.equal(pull().querySelector('.ct-word').textContent, 'NEEDS YOU');
    await show(body([conversation(STATES.idle)]));
    assert.deepEqual(look(), { state: 'idle', width: '56px', label: 'Chat with Claude — idle' });
    await show(body([conversation(STATES.suspended)]));
    assert.deepEqual(look(), { state: 'suspended', width: '56px', label: 'Claude is suspended — resume it in the terminal' },
      'suspended, never offline');

    // Offline: the socket goes away.
    const sockets = shell.sockets.length;
    shell.socket().drop();
    await waitUntil(() => pull().dataset.csState === 'offline', { ...WAIT, what: 'the tab to say offline' });
    assert.deepEqual(look(), { state: 'offline', width: '56px', label: 'Chat with Claude — reconnecting' });
    await waitUntil(() => shell.sockets.length > sockets && shell.socket().readyState === 1,
      { ...WAIT, what: 'the reconnect' });
    await show(body([conversation(STATES.idle)]));
    assert.equal(look().state, 'idle', 'back on the next hello');
    await show({ ...fixture.mirrorBody, rev: ++rev });
    assert.equal(look().state, 'working', 'the Final\'s fixture again');
  });

  test('(2) a tap snaps to half (341) and a second closes; a vertical drag from closed past 40px snaps to half, from half up to full (622)', async () => {
    layout(644);
    assert.equal(st().open, false);
    tap();
    assert.equal(st().h, 341, 'a tap: half');
    assert.equal(pull().dataset.stop, 'half');
    assert.equal(st().view, 'chat', 'on Chat');
    tap();
    assert.equal(st().open, false, 'a second tap closes');
    assert.equal(pull().dataset.stop, 'closed');
    await closed();

    await dragBy(0, -45);
    assert.equal(st().h, 341, '45px up from closed: half');
    assert.equal(pull().dataset.stop, 'half');
    await dragBy(0, -60);
    assert.equal(st().h, 622, 'from half up: full');
    assert.equal(pull().dataset.stop, 'full');
    assert.equal(pull().classList.contains('dragging'), false, 'no .dragging once settled');
    await closed();
  });

  test('(3) the Tasks root from the Final\'s fixture: "6 running" and five lines in order', async () => {
    tap();
    shell.click($('sh-tab-tasks'));
    await shell.tick();
    assert.equal(st().view, 'tasks');
    assert.equal($('sh-tab-tasks').querySelector('.sh-run').textContent, '6 running');
    const root = $('sh-tasks').querySelector('.sh-root');
    const lines = [...root.querySelectorAll('.sh-line')];
    assert.deepEqual(lines.map((l) => l.dataset.csCat), ['shells', 'agents', 'workflows', 'monitors', 'queue']);
    assert.ok(lines.every((l) => l.tagName === 'BUTTON'), 'each a button');
    const text = (l, sel) => { const e = l.querySelector(sel); return e && !e.hidden ? e.textContent : ''; };
    assert.equal(text(lines[0], '.sh-lmeta'), '2 running');
    assert.equal(text(lines[2], '.sh-ltitle'), 'release-check');
    assert.equal(text(lines[4], '.sh-lline'), 'Also update the README screenshot', 'the queue\'s next message');
    await closed();
  });

  test('(4) Tasks → Queue holds #queue-rail.in-sheet, the boot\'s own element; Push posts once and the feedback keeps the page', async () => {
    assert.equal(doc.querySelectorAll('#queue-rail').length, 1, 'one rail — never a copy');
    assert.equal($('queue-rail'), RAIL, 'the element the boot parsed and main.js moved');
    assert.ok(RAIL.classList.contains('in-sheet'));
    const page = $('sh-tasks').querySelector('.sh-page[data-page="queue"]');
    assert.equal(RAIL.parentNode, page.querySelector('.sh-pbody'), 'in the Queue page\'s body');
    assert.ok($('rail-add') && RAIL.contains($('rail-add')), 'with its own children');

    // From the Tasks root's Queue line, as a user taps it.
    tap();
    shell.click($('sh-tab-tasks'));
    await shell.tick();
    shell.click($('sh-tasks').querySelector('.sh-root .sh-line[data-cs-cat="queue"]'));
    await shell.tick();
    assert.deepEqual([st().open, st().view, st().page], [true, 'tasks', 'queue'], 'Tasks → Queue');
    assert.equal(page.hidden, false);

    const push = RAIL.querySelector('.rail-push');
    await waitUntil(() => !push.disabled, { ...WAIT, what: 'the staged messages to enable Push' });
    const before0 = posts('/api/queue/push').length;
    shell.click(push);
    await waitUntil(() => RAIL.querySelector('.rail-parked'), { ...WAIT, what: 'the push feedback' });
    await shell.tick();
    assert.equal(posts('/api/queue/push').length, before0 + 1, 'one POST /api/queue/push');
    assert.deepEqual([st().open, st().view, st().page], [true, 'tasks', 'queue'], 'the feedback keeps Tasks → Queue');
    assert.ok(page.contains(RAIL.querySelector('.rail-parked')), 'the feedback shows on the page');
    parked = null;
    await closed();
  });

  test('(5) a horizontal drag docks left (the badge on the inner side), then centre (merged); the dock survives a reload', async () => {
    layout(644);
    W.localStorage.removeItem(DOCK_KEY);
    assert.equal(pull().dataset.dock, 'right');
    assert.equal(badge().querySelector('.cb-n').textContent, '6', 'the Final\'s six running tasks');
    assert.equal(cascade(badge(), 'left'), 'calc(100% - var(--tab-w) - 4px)', 'docked right: the badge left of the tab');

    await dragTo(60);
    assert.equal(pull().dataset.dock, 'left');
    assert.equal(W.localStorage.getItem(DOCK_KEY), 'left');
    assert.equal(st().open, false, 'a dock never opens the sheet');
    assert.equal(cascade(tab(), 'left'), '0', 'the tab on the left edge');
    assert.equal(cascade(badge(), 'right'), 'auto');
    assert.equal(cascade(badge(), 'left'), 'calc(var(--tab-w) + 4px)', 'the badge on the tab\'s inner (right) side');
    assert.equal(badge().classList.contains('off'), false);
    assert.equal(pull().querySelector('.ct-count').textContent, '', 'no merged count off the centre');
    assert.doesNotMatch(tab().getAttribute('aria-label'), /running/);

    await dragTo(PULL_W / 2 + 10);
    await shell.tick();   // refreshPull's frame
    assert.equal(pull().dataset.dock, 'center');
    assert.equal(W.localStorage.getItem(DOCK_KEY), 'center');
    assert.equal(cascade(badge(), 'opacity'), '0', 'the badge fades into the tab');
    assert.equal(cascade(badge(), 'pointer-events'), 'none');
    const count = pull().querySelector('.ct-count');
    assert.equal(count.textContent, '6', 'merged into .ct-count');
    assert.equal(cascade(count, 'display'), 'inline', 'the count shows in the tab');
    assert.match(tab().getAttribute('aria-label'), /, 6 running$/);

    // A reload: a fresh page's stamped pull says right; the dock reads it back.
    const dock = await shell.importApp('tab-dock.js');
    dock.stopTabDock();
    pull().dataset.dock = 'right';
    sheet.refreshPull();
    await shell.tick();
    assert.equal(count.textContent, '', 'drawn as the fresh pull');
    dock.initTabDock();
    await shell.tick();
    assert.equal(pull().dataset.dock, 'center', 'read back from wc:chat-tab');
    assert.equal(count.textContent, '6');
    assert.match(tab().getAttribute('aria-label'), /, 6 running$/);

    // Back to the default for the cases after this one.
    await dragTo(PULL_W - 20);
    await shell.tick();
    assert.equal(pull().dataset.dock, 'right');
    W.localStorage.removeItem(DOCK_KEY);
  });

  test('an answerable ask (approvals registered, level local, avail 500) opens the sheet at full; the card mounts through mountSheet', async () => {
    const slots = await shell.importApp('chat-slots.js');
    assert.ok(slots.approvals(), 'the asks provider registered once the answer surface\'s port was known');
    await show(body([conversation(STATES.waiting)], { asks: [ASK] }));
    layout(500);
    tap();
    await shell.tick();
    assert.equal(st().h, 478, 'full: half (265) is under the 320px the card and the composer need');
    assert.equal(pull().dataset.stop, 'full');
    // The ask's frame (the panel's Stop is a control frame of its own, /answer/control/…).
    const frames = [...$('sh-chat').querySelectorAll('iframe.wc-answer-frame')]
      .filter((f) => new URL(f.getAttribute('src')).pathname.startsWith('/answer/ask/'));
    assert.equal(frames.length, 1, 'one ask frame in the sheet\'s Chat page');
    const src = new URL(frames[0].getAttribute('src'));
    assert.equal(src.port, String(ANSWER_PORT), 'on the answer origin');
    assert.equal(src.pathname, `/answer/ask/${ASK.id}`);
    assert.equal(src.searchParams.get('layout'), 'sheet', 'mounted through mountSheet');
    const card = $('chat-awaiting');
    assert.ok($('sh-chat').contains(card) && !card.hidden, 'the awaiting card shows in the sheet\'s Chat page');
    assert.ok(card.querySelector('.cp-aw-body').contains(frames[0]), 'and the frame is its body\'s');
    await closed();
    layout(644);
    await show({ ...fixture.mirrorBody, rev: ++rev });
  });

  test('the flip to 1280 closes the sheet and returns the rail to .body; back at 390 it moves in again', async () => {
    tap();
    assert.equal(st().open, true);
    shell.setViewport(DESKTOP);
    await shell.tick();
    assert.equal(st().open, false, 'closed at once');
    assert.equal(pull().dataset.stop, 'closed');
    assert.equal(RAIL.parentNode, doc.querySelector('.body'), 'the rail is home in .body');
    assert.equal(RAIL.classList.contains('in-sheet'), false);
    assert.equal(doc.querySelectorAll('#queue-rail').length, 1);
    shell.setViewport(PHONE);
    await shell.tick();
    layout(644);
    assert.ok($('sh-tasks').querySelector('.sh-page[data-page="queue"]').contains(RAIL), 'moved in again');
    await closed();
  });

  test('the sheet sends nothing new: the posture rides the client frame\'s mirror field', async () => {
    const sock = shell.socket();
    const from = sock.sent.length;
    tap();
    await shell.tick();
    tap();
    await shell.tick();
    const sent = sock.sent.slice(from);
    assert.deepEqual(sent.map((f) => f.type), ['client', 'client'], 'one client frame on open, one on close');
    assert.deepEqual(sent.map((f) => f.mirror), ['full', 'status']);
    for (const f of shell.sockets.flatMap((s) => s.sent)) {
      assert.equal(f.type, 'client', 'the phone sent only client frames in this file');
      for (const k of Object.keys(f)) assert.ok(['type', 'device', 'mirror'].includes(k), `client.${k} is an existing field`);
    }
    await closed();
  });
});
