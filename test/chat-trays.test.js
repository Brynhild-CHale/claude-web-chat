// The status bar's chips and their tray (public/app/chat-trays.js), through the
// real shell (test-support/chrome-shell.js): design spec §7.6.
//
//   * initChatTrays() takes #cs-chips over from the bar (chat-bar.js
//     claimChips), which leaves it empty, and builds the one #cs-tray, inside
//     index.html's tray host.
//   * The chips are chat-present.js's categories(), in its order, and nothing
//     else; below `read` they are counts only and open nothing.
//   * The tray is a .popover: the shell's dismiss layer closes it, and never the
//     chat dock with it; the graph overlay closes before it opens.
//   * ONE setInterval while the tray is open (its metas), cleared on close;
//     stopTrays() gives #cs-chips back to the bar and leaves no timer.
//
// main.js does not start the trays yet (U51 wires them): the boot's init does,
// after recording what the bar drew before it.
const test = require('node:test');
const { before, after, afterEach } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { isReservedId } = require('../lib/server/domain/mounts');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
const codeOf = (rel) => stripComments(read(rel)).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const T = Date.now();
const min = (n) => n * 60000;
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };

let shell, bus, S, P, Q, gv, trays;
let $;
let current = null;        // what GET /api/mirror answers
let queueBody = { items: [], count: 0 };
let rev = 1000;
let before_ = null;        // what the bar drew before initChatTrays

const conversation = (id, state = 'working') => ({ id, rev: 1, title: `title of ${id}`, headless: false, counts: ZERO,
  live: { state, since: T - min(1), last_activity_at: T - 1000 } });
const shell1 = { id: 's1', kind: 'shell', conversation_id: 'c1', title: 'npm run dev', status: 'running',
  started_at: T - min(14), meta: { port: 5173 }, line: 'ready in 412 ms' };
const shell2 = { id: 's2', kind: 'shell', conversation_id: 'c1', title: 'npm test -- --watch', status: 'running',
  started_at: T - min(3), line: '12 passing' };
const agent1 = { id: 'a1', kind: 'agent', conversation_id: 'c1', title: 'Explore the queue rail', status: 'done',
  started_at: T - min(9), ended_at: T - min(4), line: 'Found three call sites' };
// No enqueued_at: the rail's hydrate keeps a local item newer than the snapshot's newest, and an
// empty snapshot must take this one away.
const QITEM = { id: 'q1', kind: 'signal', summary: 'form_submit · Apply', staged: true };

function snapshot({ tasks = [shell1, shell2, agent1], level = 'local', caps = {}, conversations } = {}) {
  return { v: 1, enabled: true, now: T, rev: ++rev, content: level !== 'basic', access: { level, remote: false },
    capabilities: caps, primary: 'c1', aggregate: { state: 'working' },
    conversations: conversations || [conversation('c1')], tasks, asks: [] };
}

// A (re)connect: the hello, then the store's GET /api/mirror and the rail's
// GET /api/queue, both answered at once; then the trays' frame.
async function show(over = {}, queue = { items: [QITEM], count: 1 }) {
  current = snapshot(over);
  queueBody = queue;
  await shell.frame(helloFrame());
  await shell.tick();
  await waitUntil(() => S.mirror.rev >= current.rev, { timeout: 2000 });
  await shell.tick();
}

const chips = () => [...$('cs-chips').querySelectorAll('.cs-chip')];
const chip = (cat) => chips().find((c) => c.dataset.csCat === cat);
const labels = () => chips().map((c) => c.querySelector('.cs-chip-label').textContent);
const tray = () => $('cs-tray');
const trayShown = () => !!tray() && !tray().classList.contains('hidden');
const rows = () => [...$('cs-tray-rows').children];
const expanded = () => chips().filter((c) => c.getAttribute('aria-expanded') === 'true').map((c) => c.dataset.csCat);
const trayTicker = (known) => shell.intervals().filter((i) => !known.has(i.id) && i.ms === 1000);

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/mirror': () => current,
      '/api/queue': () => queueBody,
      '/api/mirror/tasks/*': () => ({ task_id: 's1', text: 'ready\n', from: 0, to: 6, size: 6, eof: true, ended: false, footer: '' }),
    },
    init: async (sh) => {
      const bar = await sh.importApp('chat-bar.js');
      void bar;
      // main.js starts the trays (tranche 3): they come off first — stopTrays()
      // empties #cs-chips and calls claimChips' release(), and the bar puts
      // nothing back — and the takeover below is this file's own, as it was
      // before main.js ran it.
      (await sh.importApp('chat-trays.js')).stopTrays();
      await sh.tick();
      before_ = {
        chips: sh.$('cs-chips').childNodes.length,
        devchips: sh.$('cs-chips').querySelectorAll('.cs-devchip').length,
        trays: sh.document.querySelectorAll('[id="cs-tray"]').length,
      };
      trays = await sh.importApp('chat-trays.js');
      const known = new Set(sh.intervals().map((i) => i.id));
      const el = trays.initChatTrays();
      assert.ok(el, 'initChatTrays answers the tray');
      assert.equal(trays.initChatTrays(), el, 'idempotent: a second call answers the same tray');
      assert.deepEqual(sh.intervals().filter((i) => !known.has(i.id)), [], 'no timer while the tray is closed');
    },
  });
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  P = await shell.importApp('chat-present.js');
  Q = await shell.importApp('queue.js');
  gv = await shell.importApp('graph-view.js');
  $ = shell.$;
  await show();
});

after(() => shell.restore());

afterEach(() => {
  if (trays) trays.closeTray({ returnFocus: false });
});

/* ── the takeover ─────────────────────────────────────────────────────────── */

test('before initChatTrays #cs-chips is empty and there is no #cs-tray; after it, the chips are the categories', () => {
  assert.equal(before_.chips, 0, 'the bar left #cs-chips empty: nothing stands in for the chips');
  assert.equal(before_.devchips, 0, 'no stand-in chip');
  assert.equal(before_.trays, 0, 'and no #cs-tray: the bar builds no note');
  assert.equal($('cs-chips').querySelectorAll('.cs-devchip').length, 0, 'no stand-in after either');
  assert.equal(shell.document.querySelector('.cs-dev'), null, 'and no note');
  assert.deepEqual(labels(), ['2 shells', 'agents · 1 done', 'queue 1'], 'categories() labels, in its order');
  const want = P.categories(S.mirror, Q.queueSnapshot(), { now: S.serverNow() }).map((e) => e.cat);
  assert.deepEqual(chips().map((c) => c.dataset.csCat), want, 'one chip per category categories() returns');
  const s = chip('shells');
  assert.equal(s.tagName, 'BUTTON');
  assert.equal(s.getAttribute('type'), 'button');
  assert.equal(s.getAttribute('aria-label'), '2 shells running — show');
  assert.equal(s.title, '2 shells', 'the label in the title (the compact chip shows only the dot and the count)');
  assert.equal(s.getAttribute('aria-controls'), 'cs-tray');
  assert.equal(s.getAttribute('aria-expanded'), 'false');
  assert.equal(chip('agents').getAttribute('aria-label'), 'agents, 1 done — show');
  assert.equal(chip('queue').getAttribute('aria-label'), 'queue 1 — show');
  assert.equal(s.querySelector('.cs-chip-dot').dataset.csTone, 'live');
  assert.equal(chip('agents').querySelector('.cs-chip-dot').dataset.csTone, 'muted', 'finished work: the muted dot');
  assert.equal(s.querySelector('.cs-chip-count').textContent, '2');
});

test('exactly one #cs-tray, the trays\' own, inside index.html\'s tray host, with §7.6\'s markup', () => {
  assert.equal(shell.document.querySelectorAll('#cs-tray').length, 1);
  assert.equal(shell.document.querySelector('.cs-dev'), null, 'the bar\'s note is gone');
  const t = tray();
  assert.ok(t.classList.contains('popover') && t.classList.contains('cs-tray') && t.classList.contains('hidden'));
  assert.equal(t.getAttribute('role'), 'dialog');
  assert.equal(t.getAttribute('aria-labelledby'), 'cs-tray-title');
  const head = t.querySelector('.cs-tray-head');
  assert.deepEqual([...head.children].map((e) => e.id), ['cs-tray-title', 'cs-tray-sub', 'cs-tray-close']);
  assert.ok($('cs-tray-close').classList.contains('pane-btn'));
  assert.equal($('cs-tray-close').getAttribute('aria-label'), 'Close');
  assert.equal($('cs-tray-close').textContent, '✕');
  assert.equal($('cs-tray-rows').getAttribute('role'), 'list');
  assert.ok($('cs-tray-rows').classList.contains('cs-tray-rows'));
  // Just before the host's closing marker.
  let n = t.nextSibling;
  while (n && n.nodeType === 3) n = n.nextSibling;
  assert.equal(n && n.nodeType, 8, 'a comment follows the tray');
  assert.equal(n.nodeValue.trim(), '/chat-host:tray');
});

test('no id outside RESERVED_IDS', () => {
  const ids = [tray(), ...tray().querySelectorAll('[id]'), ...$('cs-chips').querySelectorAll('[id]')]
    .map((e) => e.id).filter(Boolean);
  for (const id of ids) assert.ok(isReservedId(id), `${id} is reserved`);
  assert.deepEqual([...new Set(ids)].sort(), ['cs-tray', 'cs-tray-close', 'cs-tray-rows', 'cs-tray-sub', 'cs-tray-title']);
});

/* ── opening, swapping, closing ──────────────────────────────────────────── */

test('a chip opens the tray on its category: title, sub and one row per RowModel', async () => {
  shell.press(chip('shells'));
  assert.ok(trayShown());
  const entry = P.categories(S.mirror, Q.queueSnapshot(), { now: S.serverNow() }).find((e) => e.cat === 'shells');
  assert.equal($('cs-tray-title').textContent, entry.title);
  assert.equal($('cs-tray-sub').textContent, entry.sub);
  assert.deepEqual(rows().map((r) => r.dataset.rowId), entry.rows.map((r) => r.id));
  assert.deepEqual(rows().map((r) => r.querySelector('.cs-row-title').textContent), ['npm run dev', 'npm test -- --watch']);
  assert.equal(rows()[0].getAttribute('role'), 'listitem');
  assert.equal(rows()[0].querySelector('.cs-row-meta').textContent, entry.rows[0].meta);
  assert.equal(tray().dataset.csCat, 'shells');
  assert.deepEqual(expanded(), ['shells'], 'aria-expanded only on the open chip');
});

test('another chip swaps the content; the same chip closes the tray', () => {
  shell.press(chip('shells'));
  shell.press(chip('agents'));
  assert.ok(trayShown(), 'still open');
  assert.equal($('cs-tray-title').textContent, 'Agents');
  assert.deepEqual(rows().map((r) => r.dataset.rowId), ['a1']);
  assert.deepEqual(expanded(), ['agents']);
  shell.press(chip('queue'));
  assert.equal($('cs-tray-title').textContent, 'Queue');
  assert.deepEqual(rows().map((r) => r.dataset.rowId), ['q1']);
  shell.press(chip('queue'));
  assert.ok(!trayShown(), 'the same chip closes it');
  assert.deepEqual(expanded(), []);
  assert.equal(rows().length, 0);
});

test('the ✕ closes the tray', () => {
  shell.press(chip('shells'));
  shell.press($('cs-tray-close'));
  assert.ok(!trayShown());
  assert.deepEqual(expanded(), []);
});

test('Escape and an outside pointerdown close the tray through shell.js, and the open chat dock stays open', async (t) => {
  const dock = $('chat-dock');
  t.after(async () => { (await shell.importApp('chat-dock.js')).closeChat({ returnFocus: false }); });
  bus.emit('chat:open', { view: 'chat' });
  await shell.tick();
  assert.ok(!dock.classList.contains('hidden'), 'precondition: the chat dock is open');

  shell.press(chip('shells'));
  assert.ok(trayShown());
  shell.key('Escape');
  await shell.tick();
  assert.ok(!trayShown(), 'Escape closed the tray');
  assert.deepEqual(expanded(), []);
  assert.equal(rows().length, 0, 'the tray heard it close');
  assert.ok(!dock.classList.contains('hidden'), 'and left the chat open');

  shell.press(chip('agents'));
  assert.ok(trayShown());
  shell.press($('topbar'));
  await shell.tick();
  assert.ok(!trayShown(), 'an outside pointerdown closed it');
  assert.ok(!dock.classList.contains('hidden'), 'the chat dock stays open');
});

test('opening a tray closes the other popovers (wc:close-popovers, keeping the tray)', async () => {
  const more = $('more-menu');
  more.classList.remove('hidden');
  shell.click(chip('shells'));
  assert.ok(trayShown());
  assert.ok(more.classList.contains('hidden'), 'the ⋯ menu closed');
});

test('opening a tray while the graph overlay is open closes the overlay first', async (t) => {
  t.after(() => { if (gv.isOverlayOpen()) gv.closeOverlay(); });
  await gv.openOverlay();
  assert.ok(gv.isOverlayOpen(), 'precondition: the graph is open');
  shell.click(chip('shells'));
  assert.ok(!gv.isOverlayOpen(), 'the graph closed');
  assert.ok(trayShown(), 'and the tray opened');
});

/* ── redraws ──────────────────────────────────────────────────────────────── */

test('rows are keyed by id: a redraw keeps the element and an expanded Output', async () => {
  shell.press(chip('shells'));
  const first = rows()[0];
  shell.click(first.querySelector('[data-action="output"]'));
  await waitUntil(() => first.querySelector('.cs-row-tail') && first.querySelector('.cs-row-tail').textContent === 'ready\n',
    { timeout: 2000 });
  // A new shell joins: the next flush re-renders.
  await show({ tasks: [shell1, shell2, agent1, { ...shell2, id: 's3', title: 'tail -f log', started_at: T - min(1) }] });
  assert.deepEqual(rows().map((r) => r.dataset.rowId), ['s1', 's2', 's3']);
  assert.equal(rows()[0], first, 'the same element');
  assert.ok(!first.querySelector('.cs-row-body').hidden, 'still expanded');
  assert.equal(first.querySelector('.cs-row-tail').textContent, 'ready\n', 'with its tail');
  await show();
});

test('closing the tray stops an expanded row\'s follower: no further request', async () => {
  shell.press(chip('shells'));
  const first = rows()[0];
  const outputs = () => shell.calls.filter((c) => /\/api\/mirror\/tasks\/s1\/output/.test(c.url)).length;
  const n = outputs();
  shell.click(first.querySelector('[data-action="output"]'));
  await waitUntil(() => outputs() === n + 1, { timeout: 2000, what: 'the first read' });
  trays.closeTray();
  await new Promise((r) => setTimeout(r, 1700));   // past one FOLLOW_MS
  assert.equal(outputs(), n + 1, 'no read after the tray closed');
});

test('Escape inside a row\'s inline confirm reverts the confirm and leaves the tray open', async () => {
  await show({ level: 'full', caps: { task_stop: true } });
  try {
    shell.press(chip('shells'));
    const first = rows()[0];
    shell.click(first.querySelector('[data-action="kill"]'));
    const box = first.querySelector('.cs-row-confirm');
    assert.ok(box, 'the inline confirm');
    shell.key('Escape', { target: box.querySelector('.cs-confirm-no') });
    await shell.tick();
    assert.equal(first.querySelector('.cs-row-confirm'), null, 'the confirm reverted');
    assert.ok(trayShown(), 'the tray stayed open');
    shell.key('Escape');
    await shell.tick();
    assert.ok(!trayShown(), 'the next Escape closes the tray');
  } finally {
    await show();
  }
});

test('a tray whose category empties closes', async () => {
  shell.press(chip('queue'));
  assert.ok(trayShown());
  await show({}, { items: [], count: 0 });
  assert.ok(!trayShown(), 'nothing left to list');
  assert.equal(chip('queue'), undefined, 'and its chip is gone');
  await show();
});

/* ── the ticker ───────────────────────────────────────────────────────────── */

test('ONE setInterval while the tray is open, which redraws the metas; cleared on close', () => {
  const known = new Set(shell.intervals().map((i) => i.id));
  shell.press(chip('shells'));
  const mine = trayTicker(known);
  assert.equal(mine.length, 1, 'one ticker while open');
  shell.press(chip('agents'));
  assert.equal(trayTicker(known).length, 1, 'still one after a swap');
  shell.press(chip('shells'));
  const meta = () => rows()[0].querySelector('.cs-row-meta').textContent;
  const at = meta();
  const held = Date.now;
  const later = held() + min(2);
  Date.now = () => later;
  try { trayTicker(known)[0].fn(); } finally { Date.now = held; }
  assert.notEqual(meta(), at, 'the tick redrew the meta');
  assert.match(meta(), /:5173$/);
  assert.deepEqual(expanded(), ['shells'], 'a redraw keeps aria-expanded true on the open chip only');
  shell.press(chip('shells'));
  assert.equal(trayTicker(known).length, 0, 'cleared on close');
  shell.press(chip('agents'));
  shell.key('Escape');
  return waitUntil(() => trayTicker(known).length === 0, { timeout: 1000 });
});

test('the chrome timer rules: one setInterval in chat-trays.js, unref\'d, and no setTimeout', () => {
  const code = codeOf('public/app/chat-trays.js');
  assert.equal((code.match(/\bsetInterval\s*\(/g) || []).length, 1);
  assert.doesNotMatch(code, /\bsetTimeout\s*\(/);
  assert.match(code, /\.unref\(\)/);
});

/* ── chat:tasks ───────────────────────────────────────────────────────────── */

test('bus chat:tasks {category: \'agents\'} opens the agents tray; with no category, the first one', () => {
  bus.emit('chat:tasks', { category: 'agents' });
  assert.ok(trayShown());
  assert.equal(tray().dataset.csCat, 'agents');
  trays.closeTray();
  bus.emit('chat:tasks', {});
  assert.equal(tray().dataset.csCat, 'shells', 'the first non-empty category');
  trays.closeTray();
  bus.emit('chat:tasks', { category: 'workflows' });
  assert.equal(tray().dataset.csCat, 'shells', 'an empty category falls back to the first');
});

test('below 760px chat:tasks is the phone sheet\'s: the tray stays shut, and an open one closes', () => {
  const known = new Set(shell.intervals().map((i) => i.id));
  shell.press(chip('shells'));
  assert.ok(trayShown());
  shell.setViewport({ width: 700 });
  try {
    assert.ok(!trayShown(), 'the flip below 760px closed the tray');
    assert.equal(trayTicker(known).length, 0, 'and its ticker');
    bus.emit('chat:tasks', { category: 'agents' });
    assert.ok(!trayShown());
  } finally {
    shell.setViewport({ width: 1280 });
  }
});

/* ── below read ───────────────────────────────────────────────────────────── */

test('below read the chips show counts only, carry aria-disabled, and a click opens no tray', async () => {
  const row = { id: 'c1', state: 'working', since: T - min(1), counts: { ...ZERO, shells: 2, agents: 1 } };
  await show({ level: 'basic', conversations: [row] }, { items: [], count: 0 });
  try {
    assert.deepEqual(labels(), ['2 shells', '1 agent']);
    for (const c of chips()) assert.equal(c.getAttribute('aria-disabled'), 'true');
    assert.equal(chip('shells').getAttribute('aria-label'), '2 shells running', 'no "— show": there is no tray');
    shell.press(chip('shells'));
    assert.ok(!trayShown(), 'no tray opened');
    bus.emit('chat:tasks', { category: 'shells' });
    assert.ok(!trayShown(), 'nor through chat:tasks');
  } finally {
    await show();
  }
  assert.equal(chip('shells').getAttribute('aria-disabled'), null, 'back at read, the chips open trays again');
});

/* ── the CSS ──────────────────────────────────────────────────────────────── */

test('the U46 CSS sits under its own marker, with the tray\'s geometry on the panels\' rung', () => {
  const css = read('public/app.css');
  const start = css.indexOf('/* ── U46 · chips and trays · chat-trays.js, chat-rows.js, chat-actions.js ── */');
  const end = css.indexOf('/* ── U47 · detail views');
  assert.ok(start > 0 && end > start);
  const mine = css.slice(start, end);
  assert.match(mine, /\n\n$/, 'the blank line before the next marker is kept');
  assert.doesNotMatch(stripComments(mine), /#[0-9a-fA-F]{3,8}\b/, 'tokens only, no hex');
  const rule = /\.popover\.cs-tray\s*\{([^}]*)\}/.exec(stripComments(mine));
  assert.ok(rule, '.popover.cs-tray is styled');
  for (const [prop, value] of [['top', 'auto'], ['right', '12px'], ['bottom', 'calc(var(--cs-bar-h) + 8px)'],
    ['width', '440px'], ['max-height', 'min(460px, calc(100% - 120px))']]) {
    assert.match(rule[1], new RegExp(`(^|;)\\s*${prop}\\s*:\\s*${value.replace(/[()+]/g, '\\$&')}\\s*;`), `${prop}: ${value}`);
  }
  assert.doesNotMatch(rule[1], /z-index/, 'on the shared panel rung, like every popover');
  assert.match(mine, /prefers-reduced-motion: reduce/, 'animations off under reduced motion');
  assert.doesNotMatch(mine, /@keyframes/, 'wc-chat-pulse is U17\'s, never redefined');
  assert.doesNotMatch(mine, /\[data-cs-cat="[a-z]+"\]\s*\{\s*--cs-cat/, 'the category inks are U17\'s');
});

/* ── stopping ─────────────────────────────────────────────────────────────── */

test('stopTrays() gives #cs-chips back to the bar, empty, removes the tray and leaves no interval', async () => {
  const known = new Set(shell.intervals().map((i) => i.id));
  shell.press(chip('shells'));
  assert.equal(trayTicker(known).length, 1);
  trays.stopTrays();
  assert.equal(trayTicker(known).length, 0, 'no ticker left');
  assert.equal(chips().length, 0, 'the trays\' chips are gone');
  assert.equal(tray(), null, 'the trays\' #cs-tray is gone, and no other stands in its place');
  // release(): the bar puts nothing back, on its next frame or after it.
  await shell.tick();
  await shell.tick();
  assert.equal($('cs-chips').childNodes.length, 0, '#cs-chips stays empty');
  assert.equal($('cs-chips').querySelectorAll('.cs-devchip').length, 0, 'no stand-in chip');
  assert.equal(shell.document.getElementById('cs-tray'), null, 'and no #cs-tray');
  // Empty, app.css hides it, and its divider with it.
  assert.match(read('public/app.css'), /\.cs-chips:empty, \.cs-div:has\(\+ \.cs-chips:empty\) \{ display: none; \}/);
  trays.stopTrays();   // a second stop is harmless
  // …and a fresh start claims #cs-chips again.
  assert.ok(trays.initChatTrays());
  assert.equal($('cs-chips').querySelectorAll('.cs-devchip').length, 0);
  assert.deepEqual(labels(), ['2 shells', 'agents · 1 done', 'queue 1']);
  assert.equal(shell.document.querySelectorAll('#cs-tray').length, 1);
  assert.ok(tray().classList.contains('cs-tray'), '#cs-tray is only ever the trays\' tray');
});
