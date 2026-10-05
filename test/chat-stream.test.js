// The chat stream (public/app/chat-stream.js, public/app/chat-turns.js) through
// the real shell (test-support/chrome-shell.js): design spec §7.10, §15.4,
// §2.4, §2.8, §7.2's `view` event, and U37's brief.
//
//   * A turn: prompt bubble · intro prose · ONE closed <details> of tool cards
//     and narration · final prose · footer; markdown in its own .md-chat, never
//     under a page .md-block; the summary's names unique, at most four then …;
//     a running turn says what runs and is not opened.
//   * Each author's row; interrupted vs stopped from this page.
//   * Keyed: a frame about turn B redraws B only, and B's open group stays open.
//   * Paging and scroll: one older read at a time, a prepend holds the view;
//     stuck → new content scrolls in, else '↓ N new'; 150 turns only while stuck.
//   * Rewinds: the notice above its first superseded turn, the superseded dimmed,
//     'Set surface back to' only with a node and only on its click.
//   * The graph link: the node chip previews its node; a folded turn says where
//     it rode; topbar's `view` and the accent rail.
//   * Seams: registerTurnAction, setToolRenderer, setPendingRenderer; the
//     delegated Copy and remote-image click; level basic draws nothing.
//   * Attachments: a thumbnail under the route's limit; over it (alone or with
//     its record) a chip that requests nothing; a failed thumbnail → that chip.
//
// main.js does not init the dock, the panel or the stream yet (U40 wires them),
// so the boot's init does, as main.js will. Each test follows a conversation of
// its own (a fresh snapshot naming it primary), so each starts on a fresh stream.
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

const T0 = Date.UTC(2026, 9, 5, 14, 0, 0);
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };

let shell, W, $, doc, bus, S, stream, turns, topbar, state, dock;
let current = null;          // what GET /api/mirror answers
const pages = new Map();     // conversation id → its first page of turns
const older = new Map();     // conversation id → (url) => an older page (or a promise of one)
let rev = 1000;
let convN = 0;
let cid = null;              // the conversation the running test follows

// jsdom has no IntersectionObserver. A stub one is in place for the whole file
// (the stream binds its sentinel once), so the observer path is the one under
// test; `ios` holds what the stream built, and a test fires its callback.
const ios = [];
class StubIO {
  constructor(cb, opts) { this.cb = cb; this.opts = opts; this.targets = []; ios.push(this); }
  observe(el) { this.targets.push(el); }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

// ── fixtures ─────────────────────────────────────────────────────────────────

function snapshot(conversationId, { level = 'local' } = {}) {
  const content = level !== 'basic';
  const row = content
    ? { id: conversationId, rev: 1, headless: false, counts: ZERO, live: { state: 'idle', since: T0, last_activity_at: T0 } }
    : { id: conversationId, state: 'idle', since: T0, last_activity_at: T0, counts: ZERO };
  return { v: 1, enabled: true, now: Date.now(), rev: ++rev, content, access: { level, remote: level === 'basic' },
    capabilities: {}, primary: conversationId, aggregate: { state: 'idle' }, conversations: [row], tasks: [], asks: [] };
}

const prompt = (tid, text, extra = {}) => ({ id: `p_${tid}`, kind: 'prompt', text, origin: 'human', ...extra });
const reply = (id, text) => ({ id, kind: 'reply', text });
const tool = (id, kind, label, { status = 'done', at = 0, ms = 1000 } = {}) => ({
  id, kind: 'tool_call', tool: kind, tool_kind: kind, label, call: label, status,
  started_at: T0 + at, ...(status === 'running' ? {} : { ended_at: T0 + at + ms, duration_ms: ms }),
});

// A Turn as a page carries it: the header and its items, each item given a seq.
function turn(id, seq, items = [], extra = {}) {
  const tools = items.filter((i) => i.kind === 'tool_call').length;
  return {
    id, rev: ++rev, conversation_id: cid, session_id: 's1', seq, kind: 'prompt', author: 'user', status: 'done',
    started_at: T0 + seq * 60000, ended_at: T0 + seq * 60000 + 50000, duration_ms: 50000,
    counts: { items: items.length, tools, tool_errors: 0, agents: 0, tasks: 0, edits: 0 },
    tool_names: [], groups: [], node: null, folded_into: null, code: null,
    ...extra,
    items: items.map((it, i) => ({ turn_id: id, seq: seq * 1000 + i, ts: T0 + seq * 60000 + i, rev, ...it })),
  };
}

// Follow a new conversation whose first page is `list` (and, with hasOlder, has
// more above it), and wait until the stream has drawn it.
async function follow(list, { hasOlder = false, level = 'local' } = {}) {
  cid = `c${++convN}`;
  const built = typeof list === 'function' ? list() : list;
  pages.set(cid, { conversation_id: cid, turns: built, next_before: hasOlder ? built[0].seq : null,
    total: hasOlder ? built.length + 100 : built.length, rev: ++rev });
  current = snapshot(cid, { level });
  await shell.frame(helloFrame());
  if (level === 'basic') {
    await waitUntil(() => S.mirror.access.level === 'basic', { what: 'the basic snapshot' });
    await shell.tick();
    return;
  }
  await waitUntil(() => S.mirror.stream.conversationId === cid && !S.mirror.stream.loading
    && stream().querySelectorAll('.ct-turn').length === Math.min(built.length, 150), { what: `the stream of ${cid}` });
}

async function streamFrame({ turns: hs = [], items = [], removed_items } = {}) {
  await shell.frame({ type: 'mirror:stream', rev: ++rev, conversation_id: cid, turns: hs, items,
    ...(removed_items ? { removed_items } : {}) });
  await shell.tick();
}

const turnEl = (id) => stream().querySelector(`.ct-turn[data-turn-id="${id}"]`);
const turnIds = () => [...stream().querySelectorAll('.ct-turn')].map((e) => e.dataset.turnId);
const text = (e) => (e ? e.textContent : null);

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/mirror': () => current,
      '/api/mirror/conversations/*': (url) => {
        const id = decodeURIComponent(url.split('?')[0].split('/')[4]);
        if (url.includes('before=')) {
          const fn = older.get(id);
          return fn ? fn(url) : { conversation_id: id, turns: [], next_before: null, total: 0, rev };
        }
        return pages.get(id) || { conversation_id: id, turns: [], next_before: null, total: 0, rev };
      },
    },
    init: async (sh) => {
      (await sh.importApp('chat-dock.js')).initChatDock();
      (await sh.importApp('chat-panel.js')).initChatPanel();
      globalThis.IntersectionObserver = StubIO;
      (await sh.importApp('chat-stream.js')).initChatStream();
    },
  });
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  turns = await shell.importApp('chat-turns.js');
  topbar = await shell.importApp('topbar.js');
  state = await shell.importApp('state.js');
  dock = await shell.importApp('chat-dock.js');
  stream = () => $('chat-stream');
  // The stream's frames reach a socket only while a chat view is open, and the
  // store reads the stream only then (posture full): open the dock once.
  current = snapshot('c0');
  await shell.frame(helloFrame());
  bus.emit('chat:open', { view: 'chat' });
  await shell.tick();
  assert.ok(dock.isChatOpen(), 'the dock is open');
});

after(() => {
  delete globalThis.IntersectionObserver;
  return shell.restore();
});

afterEach(() => {
  // Back to no layout: each test sets the geometry it needs.
  shell.scrollMetrics(stream(), { scrollHeight: 0, clientHeight: 0, scrollTop: 0 });
  if (!dock.isChatOpen()) bus.emit('chat:open', { view: 'chat' });
});

// ── a turn ───────────────────────────────────────────────────────────────────

function fixtureTurn(id = 't1', seq = 1, extra = {}) {
  return turn(id, seq, [
    prompt(id, 'Fix the <b>rail</b>\n  please'),
    reply(`r1_${id}`, "I'll look at **the rail** first. <script>alert(1)</script>"),
    tool(`tu_r_${id}`, 'Read', 'Read · app.css', { at: 0, ms: 2000 }),
    reply(`r2_${id}`, 'Found it.'),
    tool(`tu_e_${id}`, 'Edit', 'Edit · app.css', { at: 3000, ms: 1000 }),
    tool(`tu_b_${id}`, 'Bash', 'Bash · npm test', { at: 5000, ms: 37000 }),
    reply(`r3_${id}`, '# Done\n\nAll **green**.\n\n```js\nconst x = 1;\n```'),
  ], { node: { id: 'n7', label: 'n1.7', role: 'commit' }, ...extra });
}

test('a fixture turn: bubble · intro · one closed group "▸ 3 tool calls · Read, Edit, Bash · 42s" · final · footer, markdown in .md-chat and escaped', async () => {
  await follow([fixtureTurn()]);
  const t = turnEl('t1');
  assert.ok(t, 'the turn is drawn');
  const kids = [...t.children].map((c) => c.className.split(' ').find((k) => k.startsWith('ct-')) || c.tagName);
  assert.deepEqual(kids, ['ct-open', 'ct-prose', 'ct-group', 'ct-prose', 'ct-foot'], 'prompt · intro · group · final · footer');

  const bubble = t.querySelector('.ct-prompt .ct-bubble');
  assert.equal(bubble.textContent, 'Fix the <b>rail</b>\n  please', 'the prompt is its own text');
  assert.equal(bubble.querySelector('b'), null, 'never HTML');

  const intro = t.querySelector('.ct-intro');
  assert.ok(intro.querySelector(':scope > div.md-chat'), 'the intro is chat markdown');
  assert.ok(intro.querySelector('strong'), 'rendered');
  assert.equal(intro.querySelector('script'), null, 'raw HTML is escaped');
  assert.match(intro.textContent, /<script>alert\(1\)<\/script>/);

  const groups = t.querySelectorAll('details.ct-group');
  assert.equal(groups.length, 1, 'ONE group per turn');
  const g = groups[0];
  assert.equal(g.open, false, 'closed');
  assert.equal(g.querySelector('summary').textContent, '▸ 3 tool calls · Read, Edit, Bash · 42s');
  const body = [...g.querySelector('.ct-gbody').children];
  assert.deepEqual(body.map((c) => c.dataset.itemId || c.className), ['tu_r_t1', 'ct-prose ct-narration', 'tu_e_t1', 'tu_b_t1'],
    'every card and the narration, in order');
  assert.equal(text(body[0].querySelector('.ct-tool-label')), 'Read · app.css', 'the generic card: its label');
  assert.equal(text(body[0].querySelector('.ct-tool-glyph')), '✓', 'and its status glyph');

  const final = t.querySelector('.ct-final');
  assert.ok(final.querySelector('div.md-chat h1'), 'the final prose');
  for (const md of t.querySelectorAll('.md-chat')) assert.equal(md.closest('.md-block'), null, 'never inside a page .md-block');

  const foot = t.querySelector('.ct-foot');
  assert.equal(text(foot.querySelector('.ct-node')), 'n1.7', 'the node chip');
  assert.equal(text(foot.querySelector('.ct-dur')), '50s');
  assert.equal(text(foot.querySelector('.ct-ntools')), '3 tools');
  assert.ok(text(foot.querySelector('.ct-time')), 'a time');
  assert.equal(foot.querySelector('.ct-action'), null, 'no actions while none is registered');
  assert.equal(foot.querySelector('.ct-files'), null, 'no files line without a ready code record');
});

test('the summary\'s names are unique in first-use order and stop at four then …; a running turn says what runs and is never opened', async () => {
  const many = turn('t1', 1, [
    prompt('t1', 'go'),
    tool('a1', 'Read', 'Read · a'), tool('a2', 'Read', 'Read · b'), tool('a3', 'Edit', 'Edit · a'),
    tool('a4', 'Grep', 'Grep · x'), tool('a5', 'Bash', 'Bash · ls'), tool('a6', 'Write', 'Write · c'),
  ]);
  const runningTurn = turn('t2', 2, [
    prompt('t2', 'test it'),
    tool('b1', 'Read', 'Read · a'), tool('b2', 'Edit', 'Edit · a'), tool('b3', 'Grep', 'Grep · x'),
    tool('b4', 'Bash', 'Bash · ls'), tool('b5', 'Bash', 'Bash · npm test', { status: 'running' }),
  ], { status: 'open', ended_at: undefined, duration_ms: undefined });
  await follow([many, runningTurn]);
  assert.equal(text(turnEl('t1').querySelector('summary')), '▸ 6 tool calls · Read, Edit, Grep, Bash, … · 1s');
  assert.equal(turns.toolNames([{ tool_kind: 'Read' }, { tool_kind: 'Read' }, { tool_kind: 'MCP', tool: 'mcp__x__y' }]), 'Read, MCP');
  const g = turnEl('t2').querySelector('details.ct-group');
  assert.equal(text(g.querySelector('summary')), '▸ 5 tool calls · running Bash · npm test');
  assert.equal(g.querySelector('.ct-gdot').getAttribute('data-cs-state'), 'working', 'with the state dot');
  assert.equal(g.open, false, 'never auto-expanded');
  assert.equal(text(turnEl('t2').querySelector('.ct-dur')), null, 'no duration while open');
});

test('each author renders its row; interrupted reads "✕ interrupted in the terminal", or "■ stopped from this page" by web or hook', async () => {
  const list = [
    turn('u', 1, [prompt('u', 'hello')]),
    turn('w', 2, [prompt('w', 'from the page')], { author: 'web' }),
    turn('ch', 3, [prompt('ch', '<channel source="web-chat" count="3">3 queued signals were pushed to Claude:</channel>', { origin: 'channel' })],
      { author: 'channel', kind: 'channel' }),
    turn('pk', 4, [prompt('pk', 'and this')], { author: 'parked' }),
    turn('tn', 5, [prompt('tn', '<task-notification>…</task-notification>', { origin: 'task-notification' }),
      { id: 't_b1_x', kind: 'task', task_id: 'b1', task_kind: 'shell', status: 'done',
        summary: 'Background command "npm test" completed (exit code 0)', exit_code: 0 }],
    { author: 'task-notification', kind: 'task-notification' }),
    turn('sy', 6, [prompt('sy', '/compact', { origin: 'command' }),
      { id: 'c_1', kind: 'compact', duration_ms: 18000, pre_tokens: 120000, post_tokens: 18000 },
      { id: 'n_s', kind: 'notice', notice: 'session', text: 'Session cleared' },
      { id: 'n_m', kind: 'notice', notice: 'model', text: 'Model: sonnet' },
      { id: 'n_e', kind: 'notice', notice: 'api-error', text: 'API Error: 529 overloaded' },
      { id: 'n_a', kind: 'away', text: 'Claude finished the refactor.' }],
    { author: 'system', kind: 'command' }),
    turn('i1', 7, [prompt('i1', 'stop'), { id: 'n_i', kind: 'notice', notice: 'interrupted', text: 'Interrupted by the user' }],
      { status: 'interrupted', ended_by: 'terminal' }),
    turn('i2', 8, [prompt('i2', 'stop')], { status: 'interrupted', ended_by: 'web' }),
    turn('i3', 9, [prompt('i3', 'stop')], { status: 'interrupted', ended_by: 'hook' }),
  ];
  await follow(list);
  const sys = (id) => [...turnEl(id).querySelectorAll('.ct-sys')].map((e) => e.textContent);
  assert.equal(text(turnEl('u').querySelector('.ct-bubble')), 'hello');
  const web = turnEl('w').querySelector('.ct-bubble');
  assert.equal(text(web.querySelector('.ct-tag')), 'web', 'a web bubble wears its tag');
  assert.deepEqual(sys('ch'), ['⇢ Push from the surface · 3 signals']);
  assert.equal(turnEl('ch').querySelector('.ct-bubble'), null, 'a push is a row, not a bubble');
  assert.deepEqual(sys('pk'), ['⇢ Delivered with your message']);
  assert.deepEqual(sys('tn'), ['⚙ npm test finished · exit 0']);
  assert.deepEqual(sys('sy'), ['› /compact', '— conversation compacted (18 s) —', '— session cleared —', 'model → sonnet',
    '⚠ API error — see the terminal']);
  assert.equal(turnEl('sy').querySelector('.ct-bubble'), null, 'a system turn has no bubble');
  assert.equal(text(turnEl('sy').querySelector('.ct-away .ct-away-title')), 'While you were away');
  assert.equal(text(turnEl('sy').querySelector('.ct-away .ct-away-text')), 'Claude finished the refactor.');
  assert.deepEqual(sys('i1'), ['✕ interrupted in the terminal'], 'once, from its notice');
  assert.deepEqual(sys('i2'), ['■ stopped from this page']);
  assert.deepEqual(sys('i3'), ['■ stopped from this page']);
});

test('thinking reads "Thought for 12 s", collapsed, its text expandable', async () => {
  await follow([turn('t1', 1, [prompt('t1', 'think'), { id: 'th_1', kind: 'thinking', chars: 40, duration_ms: 12000, text: 'Let me see.' },
    reply('r_1', 'Done.')])]);
  const th = turnEl('t1').querySelector('details.ct-think');
  assert.ok(th, 'a details');
  assert.equal(th.open, false);
  assert.equal(text(th.querySelector('summary')), 'Thought for 12 s');
  assert.equal(text(th.querySelector('.ct-think-text')), 'Let me see.');
});

// ── keyed rendering ──────────────────────────────────────────────────────────

test('a mirror frame changing turn B re-renders B only: A keeps its element, and B\'s open group stays open', async () => {
  const A = turn('tA', 1, [prompt('tA', 'first'), reply('rA', 'A says **hi**')]);
  const B = turn('tB', 2, [prompt('tB', 'second'), tool('tb1', 'Read', 'Read · x')], { status: 'open' });
  await follow([A, B]);
  const aEl = turnEl('tA');
  const aProse = aEl.querySelector('.ct-prose');
  const aFoot = aEl.querySelector('.ct-foot');
  const bEl = turnEl('tB');
  const g = bEl.querySelector('details.ct-group');
  const card1 = g.querySelector('[data-item-id="tb1"]');
  g.open = true;

  await streamFrame({
    turns: [{ ...B, items: undefined, rev: ++rev, counts: { ...B.counts, tools: 2 } }],
    items: [{ ...tool('tb2', 'Edit', 'Edit · y'), turn_id: 'tB', seq: 2999, rev }],
  });
  await waitUntil(() => turnEl('tB').querySelectorAll('[data-item-id]').length === 2, { what: 'B redrawn' });
  assert.equal(turnEl('tA'), aEl, 'A: the same element');
  assert.equal(aEl.querySelector('.ct-prose'), aProse, 'A: not redrawn at all');
  assert.equal(aEl.querySelector('.ct-foot'), aFoot);
  assert.equal(turnEl('tB'), bEl, 'B keeps its element');
  assert.equal(bEl.querySelector('details.ct-group'), g, 'and its group');
  assert.equal(g.open, true, 'which stays open');
  assert.equal(g.querySelector('[data-item-id="tb1"]'), card1, 'an unchanged card is the same element');
  assert.equal(text(g.querySelector('summary')), '▸ 2 tool calls · Read, Edit');
});

// ── paging and scroll ────────────────────────────────────────────────────────

test('the top sentinel calls loadOlder once while one read is in flight; a prepend keeps the scroll position', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await follow(() => [turn('o10', 10, [prompt('o10', 'ten')]), turn('o11', 11, [prompt('o11', 'eleven')]),
    turn('o12', 12, [prompt('o12', 'twelve')])], { hasOlder: true });
  older.set(cid, async () => {
    await gate;
    return { conversation_id: cid, turns: [turn('o8', 8, [prompt('o8', 'eight')]), turn('o9', 9, [prompt('o9', 'nine')])],
      next_before: null, total: 5, rev: ++rev };
  });
  const s = stream();
  // 1000px per drawn turn; the viewport 400px, scrolled near the top.
  const m = shell.scrollMetrics(s, { clientHeight: 400, scrollTop: 50 });
  Object.defineProperty(m, 'scrollHeight', { get: () => 1000 * s.querySelectorAll('.ct-turn').length, configurable: true });
  shell.scrollMetrics(s, m);
  s.scrollTop = 50;
  const olderCalls = () => shell.calls.filter((c) => c.url.includes(`/conversations/${cid}/turns`) && c.url.includes('before='));
  s.dispatchEvent(new W.Event('scroll'));
  s.dispatchEvent(new W.Event('scroll'));
  await shell.tick();
  s.dispatchEvent(new W.Event('scroll'));
  await shell.tick();
  assert.equal(olderCalls().length, 1, 'one request while one is in flight');
  assert.match(olderCalls()[0].url, /before=10/);

  release();
  await waitUntil(() => turnIds().length === 5, { what: 'the older turns drawn' });
  assert.deepEqual(turnIds(), ['o8', 'o9', 'o10', 'o11', 'o12'], 'prepended, in order');
  assert.equal(s.scrollTop, 50 + 2000, 'the view held where it was: the prepend\'s height added');
  assert.equal($('chat-new').hidden, true, 'history put in above is not news');
});

test('the observer\'s sentinel does not stall: one that fired while the store was loading pages once loading ends', async () => {
  assert.equal(ios.length, 1, 'the stream observes its sentinel');
  const io = ios[0];
  assert.equal(io.opts.root, stream());
  assert.equal(io.targets.length, 1);
  const sentinel = io.targets[0];
  assert.equal(stream().firstElementChild, sentinel, 'the sentinel tops the stream');

  // A first page too short to fill the panel, held back so the store is
  // loading when the sentinel comes into range.
  let release;
  const gate = new Promise((r) => { release = r; });
  cid = `c${++convN}`;
  const id = cid;
  const first = [turn('io20', 20, [prompt('io20', 'twenty')]), turn('io21', 21, [prompt('io21', 'twenty-one')])];
  pages.set(id, gate.then(() => ({ conversation_id: id, turns: first, next_before: 20, total: 4, rev: ++rev })));
  older.set(id, () => ({ conversation_id: id, turns: [turn('io18', 18, [prompt('io18', 'eighteen')]),
    turn('io19', 19, [prompt('io19', 'nineteen')])], next_before: null, total: 4, rev: ++rev }));
  const s = stream();
  // A browser's geometry: 100px a turn, a 400px panel, scrollTop clamped to
  // what the content allows (so a short page sits at 0, its sentinel in range).
  let top = 0;
  const height = () => Math.max(400, 100 * s.querySelectorAll('.ct-turn').length);
  shell.scrollMetrics(s, { clientHeight: 400 });
  Object.defineProperty(s, 'scrollHeight', { configurable: true, get: height });
  Object.defineProperty(s, 'scrollTop', { configurable: true, get: () => top,
    set: (v) => { top = Math.max(0, Math.min(Number(v) || 0, height() - 400)); } });
  const olderCalls = () => shell.calls.filter((c) => c.url.includes(`/conversations/${id}/turns`) && c.url.includes('before='));
  try {
    current = snapshot(id);
    await shell.frame(helloFrame());
    await waitUntil(() => S.mirror.stream.conversationId === id && S.mirror.stream.loading, { what: 'the store loading' });
    io.cb([{ isIntersecting: true, target: sentinel }], io);   // the sentinel in range: nothing to page yet
    await shell.tick();
    assert.equal(olderCalls().length, 0, 'nothing to page while the store loads');

    release();
    await waitUntil(() => olderCalls().length >= 1, { what: 'the older page asked for, with no new intersection' });
    await waitUntil(() => turnIds().length === 4, { what: 'the older turns drawn' });
    await shell.tick();
    assert.equal(olderCalls().length, 1, 'exactly one older read');
    assert.match(olderCalls()[0].url, /before=20/);
    assert.deepEqual(turnIds(), ['io18', 'io19', 'io20', 'io21']);
  } finally {
    delete s.scrollTop;
    delete s.scrollHeight;
  }
});

test('stuck within 48px: new content scrolls into view; scrolled up: "↓ 2 new", whose click re-sticks', async () => {
  await follow([turn('s1', 1, [prompt('s1', 'one')]), turn('s2', 2, [prompt('s2', 'two')], { status: 'open' })]);
  const s = stream();
  const newBtn = $('chat-new');
  const m = shell.scrollMetrics(s, { scrollHeight: 2000, clientHeight: 400, scrollTop: 1560 });
  s.dispatchEvent(new W.Event('scroll'));
  m.scrollHeight = 2400;
  await streamFrame({ items: [{ ...reply('rs2a', 'working on it'), turn_id: 's2', seq: 2500, rev }] });
  await waitUntil(() => turnEl('s2').querySelector('.ct-prose'), { what: 'the reply' });
  assert.equal(s.scrollTop, 2400, 'stuck: scrolled to the new bottom');
  assert.equal(newBtn.hidden, true);

  s.scrollTop = 500;
  s.dispatchEvent(new W.Event('scroll'));
  await streamFrame({ items: [{ ...reply('rs2b', 'more'), turn_id: 's2', seq: 2600, rev },
    { ...reply('rs2c', 'and more'), turn_id: 's2', seq: 2700, rev }] });
  await waitUntil(() => newBtn.hidden === false, { what: 'the new pill' });
  assert.equal(newBtn.textContent, '↓ 2 new');
  assert.equal(s.scrollTop, 500, 'not scrolled');

  // Back to the bottom by hand: stuck again (decided on every user scroll), the
  // pill gone and its count cleared, so the next news counts afresh.
  s.scrollTop = 2400 - 400 - 10;
  s.dispatchEvent(new W.Event('scroll'));
  assert.equal(newBtn.hidden, true, 'a scroll to the bottom re-sticks and clears the pill');
  s.scrollTop = 500;
  s.dispatchEvent(new W.Event('scroll'));
  await streamFrame({ items: [{ ...reply('rs2e', 'one more'), turn_id: 's2', seq: 2750, rev }] });
  await waitUntil(() => newBtn.hidden === false, { what: 'the new pill again' });
  assert.equal(newBtn.textContent, '↓ 1 new', 'counted afresh after the re-stick');

  shell.click(newBtn);
  assert.equal(s.scrollTop, 2400, 'the click scrolls down');
  assert.equal(newBtn.hidden, true, 'and re-sticks');
  m.scrollHeight = 2800;
  await streamFrame({ items: [{ ...reply('rs2d', 'last'), turn_id: 's2', seq: 2800, rev }] });
  await waitUntil(() => s.scrollTop === 2800, { what: 'stuck again' });

  // A turn that changed without a new item (it ended: its footer grows a
  // duration) is new content too: a stuck stream follows it down.
  m.scrollHeight = 2900;
  const s2 = pages.get(cid).turns[1];
  await streamFrame({ turns: [{ ...s2, items: undefined, rev: ++rev, status: 'done' }] });
  await waitUntil(() => turnEl('s2').querySelector('.ct-dur'), { what: 's2 closed' });
  await waitUntil(() => s.scrollTop === 2900, { what: 'a changed turn scrolled into view while stuck' });
});

test('at most 150 turns in the DOM, pruned only while stuck', async () => {
  const list = () => Array.from({ length: 160 }, (_, i) => turn(`m${i + 1}`, i + 1, [prompt(`m${i + 1}`, `#${i + 1}`)]));
  await follow(list);
  assert.equal(turnIds().length, 150, 'stuck: the newest 150');
  assert.equal(turnIds()[0], 'm11');
  const s = stream();
  const m = shell.scrollMetrics(s, { scrollHeight: 50000, clientHeight: 400, scrollTop: 20000 });
  s.dispatchEvent(new W.Event('scroll'));
  await streamFrame({ turns: [{ ...turn('m161', 161), items: undefined }, { ...turn('m162', 162), items: undefined }] });
  await waitUntil(() => turnIds().length === 152, { what: 'two more, unpruned' });
  assert.equal(turnIds()[0], 'm11', 'scrolled up: nothing pruned');
  m.scrollHeight = 60000;
  assert.equal($('chat-new').hidden, false, 'the new turns counted');
  shell.click($('chat-new'));
  await waitUntil(() => turnIds().length === 150, { what: 'pruned once stuck' });
  assert.equal(turnIds()[0], 'm13');
  assert.equal(turnIds()[149], 'm162');
});

// ── rewinds ──────────────────────────────────────────────────────────────────

test('a rewound notice renders above its first superseded turn, the superseded dimmed; "Set surface back to n1.12" POSTs only on its click', async () => {
  const at = T0 + 3 * 60000;
  await follow([
    turn('k1', 1, [prompt('k1', 'start')], { node: { id: 'n12', label: 'n1.12', role: 'commit' } }),
    turn('k2', 2, [{ id: 'rw_k2', kind: 'notice', notice: 'rewound', reason: 'branch', at, returned_to: 'k1', through_turn_id: 'k3',
      text: 'Rewound in the terminal' }, prompt('k2', 'abandoned')], { superseded: true }),
    turn('k3', 3, [prompt('k3', 'also abandoned')], { superseded: true }),
    turn('k4', 4, [prompt('k4', 'the new branch')]),
  ]);
  const k2 = turnEl('k2');
  const notice = k2.firstElementChild;
  assert.ok(notice.classList.contains('ct-rewind'), 'the notice comes first, above the turn');
  assert.match(text(notice.querySelector('.ct-rewind-text')), /^↶ Rewound in the terminal at \S/);
  assert.equal(k2.querySelectorAll('.ct-rewind').length, 1);
  assert.deepEqual(['k1', 'k2', 'k3', 'k4'].map((id) => turnEl(id).classList.contains('ct-superseded')), [false, true, true, false]);
  assert.deepEqual(turnIds(), ['k1', 'k2', 'k3', 'k4'], 'file order, still readable');
  // The superseded turns are dimmed UNDER the notice, never the notice: opacity
  // multiplies down the tree, so the notice and every ancestor must stay at 1.
  const sheet = doc.createElement('style');
  sheet.textContent = read('public/app.css');
  doc.head.append(sheet);
  try {
    const opacity = (e) => Number(W.getComputedStyle(e).opacity || '1');
    const drawn = (e) => { let o = 1; for (let n = e; n && n.nodeType === 1; n = n.parentElement) o *= opacity(n); return o; };
    assert.equal(drawn(notice), 1, 'the rewind notice (and its Set surface back) is drawn at full opacity');
    assert.equal(drawn(notice.querySelector('.ct-setback')), 1);
    const k2Own = [...k2.children].find((c) => !c.classList.contains('ct-rewind'));
    assert.ok(k2Own, 'the superseded turn has content beside the notice');
    assert.ok(drawn(k2Own) < 1, 'the superseded turn\'s own content is dimmed');
    assert.ok(drawn(turnEl('k3').firstElementChild) < 1, 'and the next superseded turn\'s');
    assert.equal(drawn(turnEl('k4').firstElementChild), 1, 'the live branch is not');
  } finally {
    sheet.remove();
  }
  const back = notice.querySelector('.ct-setback');
  assert.equal(text(back), 'Set surface back to n1.12');
  const posts = () => shell.calls.filter((c) => c.url === '/api/graph/active' && c.method === 'POST');
  await shell.tick();
  assert.equal(posts().length, 0, 'never applied without the click');
  shell.click(back);
  await waitUntil(() => posts().length === 1, { what: 'the set-active POST' });
  assert.deepEqual(posts()[0].body, { id: 'n12' });
});

test('a reset reads "Conversation reset at …"; with no node to go back to there is no Set surface back', async () => {
  await follow([
    turn('q1', 1, [prompt('q1', 'start')]),
    turn('q2', 2, [{ id: 'rw_q2', kind: 'notice', notice: 'rewound', reason: 'reset', at: T0, returned_to: 'q1', through_turn_id: 'q2' },
      prompt('q2', 'gone')], { superseded: true }),
  ]);
  const notice = turnEl('q2').querySelector('.ct-rewind');
  assert.match(text(notice), /^Conversation reset at \S/);
  assert.equal(notice.querySelector('.ct-setback'), null);
  // The node arrives later (tranche 3's link): the offer appears with it.
  const q1 = pages.get(cid).turns[0];
  await streamFrame({ turns: [{ ...q1, items: undefined, rev: ++rev, node: { id: 'n3', label: 'n1.3', role: 'commit' } }] });
  await waitUntil(() => turnEl('q2').querySelector('.ct-setback'), { what: 'the offer' });
  assert.equal(text(turnEl('q2').querySelector('.ct-setback')), 'Set surface back to n1.3');
});

// ── the graph link ───────────────────────────────────────────────────────────

test('the node chip previews its node (GET /api/graph/node/:id) and the dock stays open; a folded turn says where it rode', async () => {
  await follow([
    turn('g1', 1, [prompt('g1', 'draw')], { node: { id: 'n7', label: 'n1.7', role: 'commit' } }),
    turn('g2', 2, [prompt('g2', 'just chat')], { node: { id: 'n15', label: 'n1.15', role: 'folded' },
      folded_into: { id: 'n15', label: 'n1.15' } }),
  ]);
  assert.equal(text(turnEl('g2').querySelector('.ct-folded')), 'no surface change · rode into n1.15');
  const chip = turnEl('g1').querySelector('.ct-foot .ct-node');
  const before = shell.calls.length;
  shell.press(chip);
  await waitUntil(() => shell.calls.slice(before).some((c) => c.url === '/api/graph/node/n7'), { what: 'the preview read' });
  await shell.tick();
  assert.ok(dock.isChatOpen(), 'the dock stays open');
  assert.equal(state.view.viewedId, 'n7', 'previewing n7');
  await waitUntil(() => turnEl('g1').classList.contains('ct-viewed'), { what: 'the accent rail' });
  topbar.returnToActive();
  await waitUntil(() => !turnEl('g1').classList.contains('ct-viewed'), { what: 'the rail gone with the preview' });
});

test('topbar emits `view` {activeId, viewedId} when either changes and not otherwise; the matching turn carries the accent rail', async () => {
  await follow([
    turn('v1', 1, [prompt('v1', 'a')], { node: { id: 'n21', label: 'n1.21', role: 'commit' } }),
    turn('v2', 2, [prompt('v2', 'b')], { node: { id: 'n22', label: 'n1.22', role: 'commit' } }),
  ]);
  const seen = [];
  const off = bus.on('view', (d) => seen.push(d));
  const { view } = state;
  const was = { activeId: view.activeId, viewedId: view.viewedId };
  try {
    topbar.updateChip();
    assert.deepEqual(seen, [], 'nothing changed: no event');
    view.viewedId = 'n22';
    topbar.updateChip();
    topbar.updateChip();
    assert.deepEqual(seen, [{ activeId: was.activeId, viewedId: 'n22' }], 'once, on the change');
    view.activeId = 'n22';
    topbar.updateChip();
    assert.deepEqual(seen[1], { activeId: 'n22', viewedId: 'n22' });
    assert.equal(seen.length, 2);
    await waitUntil(() => turnEl('v2').classList.contains('ct-viewed'), { what: 'the rail' });
    assert.equal(turnEl('v1').classList.contains('ct-viewed'), false);
  } finally {
    view.activeId = was.activeId;
    view.viewedId = was.viewedId;
    topbar.updateChip();
    off();
  }
});

test('"3 files +40 −12 · View changes" once code is ready, View changes only with a diff detail registered', async () => {
  const panel = await shell.importApp('chat-panel.js');
  await follow([turn('d1', 1, [prompt('d1', 'edit')], { node: { id: 'n30', label: 'n1.30', role: 'commit' },
    code: { status: 'ready', files: 3, additions: 40, deletions: 12 } }),
  turn('d2', 2, [prompt('d2', 'chat only')], { node: { id: 'n30', label: 'n1.30', role: 'folded' },
    folded_into: { id: 'n30', label: 'n1.30' }, code: { status: 'ready', files: 1, additions: 2, deletions: 0 } })]);
  assert.equal(text(turnEl('d1').querySelector('.ct-files')), '3 files +40 −12');
  assert.equal(turnEl('d1').querySelector('.ct-view-changes'), null, 'no diff view registered');
  const opened = [];
  const off = bus.on('chat:open', (d) => opened.push(d));
  const unreg = panel.registerDetail('diff', () => {});
  try {
    await streamFrame({ turns: [{ ...pages.get(cid).turns[0], items: undefined, rev: ++rev }] });
    await waitUntil(() => turnEl('d1').querySelector('.ct-view-changes'), { what: 'View changes' });
    shell.click(turnEl('d1').querySelector('.ct-view-changes'));
    assert.deepEqual(opened, [{ view: 'diff', node_id: 'n30' }]);
    // A folded turn has no node of its own: its diff is asked for by the turn.
    await waitUntil(() => turnEl('d2').querySelector('.ct-view-changes'), { what: 'the folded turn\'s View changes' });
    shell.click(turnEl('d2').querySelector('.ct-view-changes'));
    assert.deepEqual(opened[1], { view: 'diff', id: 'd2' }, 'a folded turn opens the diff by its turn id');
  } finally {
    off();
    unreg();
    while (panel.popDetail({ refocus: false }));
  }
});

// ── seams ────────────────────────────────────────────────────────────────────

test('registerTurnAction adds a footer button only where applies() is true; run receives (turn, el); unregister removes it', async () => {
  await follow([turn('a1', 1, [prompt('a1', 'x')]), turn('a2', 2, [prompt('a2', 'y')])]);
  const ran = [];
  const off = turns.registerTurnAction({ id: 'fork', label: 'Fork from here', applies: (t) => t.id === 'a1',
    run: (t, el) => ran.push([t.id, el]) });
  try {
    await waitUntil(() => turnEl('a1').querySelector('.ct-action'), { what: 'the button' });
    const b = turnEl('a1').querySelector('.ct-foot .ct-action');
    assert.equal(b.textContent, 'Fork from here');
    assert.equal(turnEl('a2').querySelector('.ct-action'), null, 'not where applies() is false');
    shell.click(b);
    assert.equal(ran.length, 1);
    assert.equal(ran[0][0], 'a1');
    assert.equal(ran[0][1], turnEl('a1'), 'run gets the turn\'s element');
  } finally {
    off();
  }
  await waitUntil(() => !turnEl('a1').querySelector('.ct-action'), { what: 'the button gone' });
});

test('setToolRenderer replaces the generic default card, and its restore puts it back', async () => {
  const { setToolRenderer } = await shell.importApp('chat-stream.js');
  await follow([turn('r1', 1, [prompt('r1', 'x'), tool('rt1', 'Read', 'Read · a'), tool('rt2', 'Bash', 'Bash · ls')])]);
  assert.equal(turnEl('r1').querySelectorAll('.ct-tool').length, 2, 'the default cards');
  const seenCtx = [];
  const restore = setToolRenderer((item, ctx) => {
    seenCtx.push(ctx);
    const d = doc.createElement('div');
    d.className = 'my-card';
    d.textContent = `custom ${item.label}`;
    return d;
  });
  await waitUntil(() => turnEl('r1').querySelectorAll('.my-card').length === 2, { what: 'the custom cards' });
  assert.equal(turnEl('r1').querySelectorAll('.ct-tool').length, 0);
  assert.deepEqual([...turnEl('r1').querySelectorAll('.my-card')].map((c) => c.dataset.itemId), ['rt1', 'rt2'],
    'each card is marked with its item');
  assert.equal(seenCtx[0].turn.id, 'r1', 'the renderer gets the turn');
  restore();
  await waitUntil(() => turnEl('r1').querySelectorAll('.ct-tool').length === 2, { what: 'the defaults back' });
});

test('setPendingRenderer renders into a container after the last turn, on set and on every queue event', async () => {
  const { setPendingRenderer } = await shell.importApp('chat-stream.js');
  await follow([turn('pp1', 1, [prompt('pp1', 'x')])]);
  const calls = [];
  const restore = setPendingRenderer((box, info) => {
    calls.push(info.conversationId);
    box.replaceChildren(Object.assign(doc.createElement('div'), { className: 'pending-test', textContent: 'next' }));
  });
  try {
    assert.equal(calls.length, 1, 'rendered when set');
    bus.emit('queue', { items: [] });
    assert.equal(calls.length, 2, 'and on a queue event');
    assert.equal(calls[1], cid);
    const box = stream().querySelector('.pending-test').parentElement;
    assert.equal(box.previousElementSibling.lastElementChild, turnEl('pp1'), 'after the last turn');
  } finally {
    restore();
  }
  assert.equal(stream().querySelector('.pending-test'), null, 'emptied when unset');
});

test('a code block\'s Copy calls copyText; a click on span.md-img-remote makes an <img> with that src', async () => {
  await follow([turn('c1', 1, [prompt('c1', 'x'), reply('rc1', 'Run:\n\n```sh\nnpm test\n```\n\n![cat](https://example.com/cat.png)')])]);
  const written = [];
  Object.defineProperty(W.navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { written.push(t); } } });
  try {
    const copy = turnEl('c1').querySelector('.ct-code .ct-copy');
    assert.ok(copy, 'a Copy beside the code block');
    shell.click(copy);
    await waitUntil(() => written.length === 1, { what: 'the copy' });
    assert.equal(written[0], 'npm test');
  } finally {
    delete W.navigator.clipboard;
  }
  const span = turnEl('c1').querySelector('span.md-img-remote');
  assert.ok(span, 'the placeholder');
  assert.equal(turnEl('c1').querySelector('img'), null, 'nothing loaded before the click');
  shell.click(span);
  const img = turnEl('c1').querySelector('img');
  assert.ok(img, 'an image now');
  assert.equal(img.getAttribute('src'), 'https://example.com/cat.png');
  assert.equal(turnEl('c1').querySelector('span.md-img-remote'), null);
  // The click re-checks the engine's gate: a placeholder whose data-src is not a
  // remote http(s) image loads nothing.
  const forged = doc.createElement('span');
  forged.className = 'md-img-remote';
  forged.setAttribute('data-src', 'javascript:alert(1)');
  forged.textContent = 'x';
  turnEl('c1').querySelector('.ct-prose').append(forged);
  shell.click(forged);
  assert.ok(forged.isConnected, 'the placeholder stays');
  assert.equal(turnEl('c1').querySelectorAll('img').length, 1, 'no image made from a non-remote src');
  forged.remove();
});

test('a chat h1 inside the stream has no border-bottom and keeps U35\'s size: page.css\'s .md-block rules do not reach it', async () => {
  await follow([turn('h1t', 1, [prompt('h1t', 'x'), reply('rh1', '# Title')])]);
  const sheets = [];
  for (const f of ['public/app.css', 'public/page.css']) {
    const st = doc.createElement('style');
    st.textContent = read(f);
    doc.head.append(st);
    sheets.push(st);
  }
  const probe = doc.createElement('div');
  probe.className = 'md-block';
  probe.innerHTML = '<h1>page</h1>';
  doc.body.append(probe);
  // jsdom cascades font-size and padding but leaves a shorthand holding var()
  // unresolved, so the border is read from the rules that match, beside the
  // computed values it does resolve.
  const borderRules = (e) => {
    const out = [];
    const walk = (rules) => {
      for (const r of rules) {
        if (r.cssRules && !r.selectorText) { walk(r.cssRules); continue; }
        if (!r.selectorText || !r.style) continue;
        let hit = false;
        try { hit = e.matches(r.selectorText); } catch { hit = false; }
        if (hit && (r.style.getPropertyValue('border-bottom') || r.style.getPropertyValue('border-bottom-style')
          || r.style.getPropertyValue('border-bottom-width') || r.style.getPropertyValue('border'))) out.push(r.selectorText);
      }
    };
    for (const sh of doc.styleSheets) walk(sh.cssRules);
    return out;
  };
  try {
    const pageH1 = probe.querySelector('h1');
    assert.ok(borderRules(pageH1).some((sel) => /\.md-block h1/.test(sel)), 'control: a page h1 gets its border-bottom rule');
    assert.equal(W.getComputedStyle(pageH1).paddingBottom, '8px', 'control: the sheets cascade');
    assert.equal(W.getComputedStyle(pageH1).fontSize, '17px');
    const h1 = turnEl('h1t').querySelector('div.md-chat h1');
    assert.deepEqual(borderRules(h1), [], 'no rule gives the chat h1 a border-bottom');
    const cs = W.getComputedStyle(h1);
    assert.notEqual(cs.borderBottomStyle, 'solid');
    assert.notEqual(cs.paddingBottom, '8px', 'nor the page h1\'s padding');
    assert.equal(cs.fontSize, '16px', 'U35\'s size');
  } finally {
    probe.remove();
    for (const st of sheets) st.remove();
  }
});

// ── attachments ──────────────────────────────────────────────────────────────

test('ATTACHMENT_SHOW_MAX is the route\'s 6 MiB − 48 KiB', () => {
  assert.equal(turns.ATTACHMENT_SHOW_MAX, 6242304);
  assert.equal(turns.ATTACHMENT_SHOW_MAX, 6 * 1024 * 1024 - 48 * 1024);
});

test('attachments: an image under the limit is a lazy thumbnail; over it, alone or by its record\'s sum, a chip that requests nothing; a failed thumbnail becomes the chip', async () => {
  const MAX = 6242304;
  await follow([
    turn('at1', 1, [prompt('at1', 'look', { attachments: [{ n: 0, kind: 'image', media_type: 'image/png', bytes: 2048 },
      { n: 1, kind: 'file', name: 'src/app.js' }, { n: 2, kind: 'document', name: 'spec.pdf', media_type: 'application/pdf', bytes: 9000 }] })]),
    turn('at2', 2, [prompt('at2', 'big', { attachments: [{ n: 0, kind: 'image', media_type: 'image/png', bytes: MAX + 1 }] })]),
    turn('at3', 3, [prompt('at3', 'two', { attachments: [{ n: 0, kind: 'image', media_type: 'image/jpeg', bytes: 4 * 1024 * 1024 },
      { n: 1, kind: 'document', name: '/Users/x/report.pdf', media_type: 'application/pdf', bytes: 3 * 1024 * 1024 }] })]),
  ]);
  const thumb = turnEl('at1').querySelector('a.ct-att-thumb');
  assert.ok(thumb, 'a thumbnail');
  assert.equal(thumb.getAttribute('href'), '/api/mirror/items/p_at1/attachments/0');
  assert.equal(thumb.target, '_blank');
  assert.equal(thumb.rel, 'noopener');
  const img = thumb.querySelector('img');
  assert.equal(img.getAttribute('src'), '/api/mirror/items/p_at1/attachments/0', 'its bytes are requested');
  assert.equal(img.getAttribute('loading'), 'lazy');
  const chips = [...turnEl('at1').querySelectorAll('.ct-att')];
  assert.equal(chips[0].textContent, 'src/app.js', 'a file is a chip');
  assert.equal(chips[0].querySelector('button, a'), null, 'with no View (0.8.5)');
  const open = chips[1].querySelector('a.ct-att-open');
  assert.equal(open.textContent, 'Open', 'a PDF has Open');
  assert.equal(open.getAttribute('href'), '/api/mirror/items/p_at1/attachments/2');

  const refs = (id) => [...turnEl(id).querySelectorAll('[src], [href]')]
    .filter((e) => /\/attachments\//.test(e.getAttribute('src') || e.getAttribute('href')));
  assert.deepEqual(refs('at2'), [], 'over the limit alone: never requested');
  const big = turnEl('at2').querySelector('.ct-att-big');
  assert.deepEqual([...big.children].map((c) => c.textContent), ['image', '6 MB', 'too large to show here'],
    'no location recorded: kind, size, why');
  assert.deepEqual(refs('at3'), [], 'over the limit together: neither is requested');
  const both = [...turnEl('at3').querySelectorAll('.ct-att-big')];
  assert.equal(both.length, 2);
  assert.deepEqual([...both[1].children].map((c) => c.textContent), ['/Users/x/report.pdf', '3 MB'], 'its location and size');
  assert.equal(shell.calls.filter((c) => c.url.includes('/attachments/')).length, 0, 'nothing fetched either');

  img.dispatchEvent(new W.Event('error'));
  const fell = turnEl('at1').querySelector('.ct-att-big');
  assert.ok(fell, 'a failed thumbnail becomes the chip');
  assert.equal(turnEl('at1').querySelector('img'), null);
  assert.deepEqual([...fell.children].map((c) => c.textContent), ['image', '2 KB', 'too large to show here']);
});

// ── below read, and the source ───────────────────────────────────────────────

test('level basic: the stream holds no turn', async () => {
  await follow([turn('b1', 1, [prompt('b1', 'secret')])]);
  assert.equal(turnIds().length, 1);
  await follow([], { level: 'basic' });
  await waitUntil(() => turnIds().length === 0, { what: 'an empty stream' });
  assert.equal(stream().textContent.includes('secret'), false);
  // back to local for anything after
  await follow([turn('b2', 2, [prompt('b2', 'again')])]);
  assert.equal(turnIds().length, 1);
});

test('the source: no id outside RESERVED_IDS, never a fetch of turns, reads chat-state only', () => {
  for (const rel of ['public/app/chat-stream.js', 'public/app/chat-turns.js']) {
    const src = read(rel);
    const ids = [
      ...[...src.matchAll(/\bid="([a-zA-Z][\w-]*)"/g)].map((m) => m[1]),
      ...[...src.matchAll(/\.id\s*=\s*['"`]([a-zA-Z][\w-]*)['"`]/g)].map((m) => m[1]),
      ...[...src.matchAll(/getElementById\(\s*['"`]([a-zA-Z][\w-]*)['"`]/g)].map((m) => m[1]),
      ...[...src.matchAll(/setAttribute\(\s*'id',\s*'([a-zA-Z][\w-]*)'/g)].map((m) => m[1]),
    ];
    assert.deepEqual(ids.filter((id) => !isReservedId(id)), [], `${rel}: every id is reserved`);
    assert.ok(ids.every((id) => id === 'chat-stream' || id === 'chat-new'), `${rel}: no id beyond chat-stream and chat-new`);
    const code = codeOf(rel);
    assert.doesNotMatch(code, /\bfetch\(|XMLHttpRequest|\/turns\b/, `${rel}: never fetches turns`);
    assert.doesNotMatch(code, /from '\.\/ws\.js'/, `${rel}: no line to the socket`);
    assert.doesNotMatch(code, /innerHTML\s*=(?!\s*renderMarkdown\()/, `${rel}: HTML only from the markdown engine`);
  }
  const css = read('public/app.css');
  const start = css.indexOf('/* ── U37 · the stream');
  const end = css.indexOf('/* ── U38', start);
  const section = css.slice(start, end);
  assert.ok(start > 0 && end > start, 'the U37 section');
  assert.doesNotMatch(stripComments(section), /#[0-9a-fA-F]{3,8}\b/, 'tokens only, no hex');
  assert.match(section, /content-visibility:\s*auto;\s*contain-intrinsic-size:\s*auto 120px/);
  assert.doesNotMatch(section, /@keyframes/, 'U17\'s pulse, reused');
});
