// The tool cards (public/app/chat-tools.js) through the real shell
// (test-support/chrome-shell.js): design spec §7.10 "Tool cards", §7.11, §2.4,
// §2.10, and U38's brief.
//
//   * One fixture item per tool_kind: the header's label, status glyph and meta.
//   * The body: fetched once (GET /api/mirror/items/:id?field=…) on the first
//     expand, then from the cache — collapse/expand and the stream's keyed
//     re-renders of the turn request nothing more; Read's Show more pages on.
//   * An Edit's body is renderDiff's; a Todo is glyphs, never form controls.
//   * Open task → bus chat:open {view: 'task', id}; Show on page → revealPane.
//   * A failed fetch: one line with Retry, and Retry fetches again.
//   * Text is text: a <script> in a result, markup in an input.
//   * Denied and interrupted have their own glyph; below read a header only.
//   * The stream's module is untouched: the cards plug in via setToolRenderer.
//
// main.js does not init the chat yet (U40 wires it), so the boot's init does:
// initChatDock, initChatPanel, initChatStream, initChatTools. The tests route
// GET /api/mirror/items/* themselves.
const test = require('node:test');
const { before, after, beforeEach } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const T0 = Date.UTC(2026, 9, 5, 14, 0, 0);
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };

let shell, W, $, bus, S, tools, stream;
let current = null;
const pages = new Map();
let rev = 5000;
let convN = 0;
let cid = null;
let itemAnswer = null;   // (url) => body | respond(...) for GET /api/mirror/items/*

class StubIO {
  constructor() {}
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

// ── fixtures ─────────────────────────────────────────────────────────────────

function snapshot(conversationId, { level = 'local', tasks = [], asks = [] } = {}) {
  const content = level !== 'basic';
  const row = content
    ? { id: conversationId, rev: 1, headless: false, counts: ZERO, live: { state: 'idle', since: T0, last_activity_at: T0 } }
    : { id: conversationId, state: 'idle', since: T0, last_activity_at: T0, counts: ZERO };
  return { v: 1, enabled: true, now: Date.now(), rev: ++rev, content, access: { level, remote: level === 'basic' },
    capabilities: {}, primary: conversationId, aggregate: { state: 'idle' }, conversations: [row],
    tasks: content ? tasks.map((t) => ({ conversation_id: conversationId, rev: 1, ...t })) : [],
    asks: asks.map((a) => ({ conversation_id: conversationId, ...a })) };
}

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const result = (preview, extra = {}) => ({ preview, bytes: bytes(preview), is_error: false, full: true, ...extra });

function call(id, tool, toolKind, label, { status = 'done', ms = 1200, ...extra } = {}) {
  return {
    id, kind: 'tool_call', tool, tool_kind: toolKind, label, call: label, status,
    started_at: T0, ...(status === 'running' ? {} : { ended_at: T0 + ms, duration_ms: ms }), ...extra,
  };
}

const READ_TEXT = Array.from({ length: 120 }, (_, i) => `${String(i + 1).padStart(6)}→x`).join('\n');
const EDIT_PATCH = ['@@ -10,5 +10,14 @@', ' keep',
  ...Array.from({ length: 12 }, (_, i) => `+added ${i}`), ...Array.from({ length: 3 }, (_, i) => `-gone ${i}`), ' keep'].join('\n');
const WRITE_PATCH = ['@@ -0,0 +1,40 @@', ...Array.from({ length: 40 }, (_, i) => `+line ${i}`)].join('\n');
const TODOS = [
  { content: 'one', status: 'completed' }, { content: 'two', status: 'completed' }, { content: 'three', status: 'completed' },
  { content: 'four', status: 'in_progress' }, { content: 'five', status: 'pending' },
];

// One item per tool_kind (and the variants the table names).
function fixtureItems(now = Date.now()) {
  return [
    call('tu_read', 'Read', 'Read', 'Read · app.css', { input: { file_path: '/p/app.css' }, result: result(READ_TEXT) }),
    call('tu_edit', 'Edit', 'Edit', 'Edit · QueueRail.tsx', { edit: { path: '/p/QueueRail.tsx', patch: EDIT_PATCH }, result: result('ok') }),
    call('tu_write', 'Write', 'Write', 'Write · notes.md', { edit: { path: '/p/notes.md', patch: WRITE_PATCH }, result: result('ok') }),
    call('tu_bash', 'Bash', 'Bash', 'Bash · npm test', { input: { command: 'npm test' }, result: result('all green\n') }),
    call('tu_bash_err', 'Bash', 'Bash', 'Bash · npm run lint', { status: 'error', input: { command: 'npm run lint' },
      result: result('Exit code 2\nlint failed', { is_error: true }) }),
    call('tu_bg', 'Bash', 'Bash', 'Bash · npm run dev', { input: { command: 'npm run dev', run_in_background: true },
      links: { task_id: 'bg1' }, result: result('Command running in background with ID: bg1') }),
    call('tu_grep', 'Grep', 'Grep', 'Grep · railState', { input: { pattern: 'railState' }, result: result('Found 4 files\na.js\nb.js\nc.js\nd.js') }),
    call('tu_web', 'WebFetch', 'Web', 'Web · docs.example.com', { input: { url: 'https://docs.example.com/a' }, result: result('the page') }),
    call('tu_agent', 'Agent', 'Agent', 'Agent · Explore rail tests', { status: 'running', started_at: now - 72000,
      input: { description: 'Explore rail tests', prompt: 'Find the rail tests' }, links: { agent_id: 'ag1' } }),
    call('tu_todo', 'TodoWrite', 'Todo', 'Todo · 3 / 5', { input: { todos: TODOS }, result: result('Todos have been modified') }),
    call('tu_mon', 'Monitor', 'Monitor', 'Monitor · build errors', { status: 'running', input: { description: 'build errors' },
      links: { task_id: 'mon1' } }),
    call('tu_q', 'AskUserQuestion', 'Question', 'Question · Which port?', { input: { questions: [
      { header: 'Port', question: 'Which port?', options: [{ label: '5173' }, { label: '8080' }] }] },
    result: result('User has answered your questions: "Which port?"="5173"') }),
    call('tu_plan', 'ExitPlanMode', 'Plan', 'Plan', { status: 'running', input: { planFilePath: '/p/plan.md' } }),
    call('tu_wc', 'mcp__web-chat__render', 'MCP', 'web-chat · render · tc-pane', { server: 'web-chat',
      input: { id: 'tc-pane', target: 'main' }, result: result('{"ok":true,"id":"tc-pane"}') }),
    call('tu_gh', 'mcp__github__get_issue', 'MCP', 'github · get_issue', { server: 'github', input: { number: 7 },
      result: result('issue body') }),
    call('tu_wf', 'Workflow', 'Workflow', 'Workflow · release-check', { status: 'running', links: { run_id: 'wf1' } }),
    call('tu_den', 'Bash', 'Bash', 'Bash · rm -rf dist', { status: 'denied', input: { command: 'rm -rf dist' },
      result: result("The user doesn't want to proceed with this tool use.", { is_error: true }) }),
    call('tu_int', 'Bash', 'Bash', 'Bash · sleep 60', { status: 'interrupted', input: { command: 'sleep 60' },
      result: result('[Request interrupted by user for tool use]', { is_error: true }) }),
  ];
}

function fixtureTasks(now = Date.now()) {
  return [
    { id: 'bg1', kind: 'shell', title: 'npm run dev', status: 'running', started_at: now - 5000, tool_use_id: 'tu_bg', meta: {} },
    { id: 'ag1', kind: 'agent', title: 'Explore rail tests', status: 'running', started_at: now - 72000, tool_use_id: 'tu_agent',
      meta: { tools: 6 } },
    { id: 'mon1', kind: 'monitor', title: 'build errors', status: 'running', started_at: now - 9000, tool_use_id: 'tu_mon',
      meta: { events: 7 } },
    { id: 'wf1', kind: 'workflow', title: 'release-check', status: 'running', started_at: now - 9000, tool_use_id: 'tu_wf',
      meta: { step: { index: 1, total: 3 } },
      steps: [{ label: 'build', state: 'done' }, { label: 'test', state: 'running' }, { label: 'tag', state: 'pending' }] },
  ];
}

function turn(id, seq, items, extra = {}) {
  return {
    id, rev: ++rev, conversation_id: cid, session_id: 's1', seq, kind: 'prompt', author: 'user', status: 'done',
    started_at: T0, ended_at: T0 + 50000, duration_ms: 50000,
    counts: { items: items.length + 1, tools: items.length, tool_errors: 0, agents: 0, tasks: 0, edits: 0 },
    tool_names: [], groups: [], node: null, folded_into: null, code: null, ...extra,
    items: [{ id: `p_${id}`, kind: 'prompt', text: 'go', origin: 'human' }, ...items]
      .map((it, i) => ({ turn_id: id, seq: seq * 1000 + i, ts: T0 + i, rev, ...it })),
  };
}

async function follow(items, { level = 'local', tasks = [], asks = [] } = {}) {
  cid = `c${++convN}`;
  const t = turn('t1', 1, items);
  pages.set(cid, { conversation_id: cid, turns: [t], next_before: null, total: 1, rev: ++rev });
  current = snapshot(cid, { level, tasks, asks });
  await shell.frame(helloFrame());
  if (level === 'basic') {
    await waitUntil(() => S.mirror.access.level === 'basic', { what: 'the basic snapshot' });
    await shell.tick();
    return t;
  }
  await waitUntil(() => S.mirror.stream.conversationId === cid && !S.mirror.stream.loading
    && stream().querySelectorAll('[data-item-id]').length === items.length, { what: `the cards of ${cid}` });
  return t;
}

const card = (id) => stream().querySelector(`.tc[data-item-id="${id}"]`);
const head = (id) => card(id).querySelector('.tc-head');
const labelOf = (id) => card(id).querySelector('.tc-label').textContent;
const glyphOf = (id) => card(id).querySelector('.tc-glyph').textContent;
const metaOf = (id) => [...card(id).querySelectorAll('.tc-meta')].map((m) => m.textContent).join(' ');
const bodyOf = (id) => card(id).querySelector('.tc-body');
const itemCalls = (id, field) => shell.calls.filter((c) => c.url.startsWith(`/api/mirror/items/${encodeURIComponent(id)}?field=${field}`));

async function open(id) {
  card(id).open = true;
  await waitUntil(() => bodyOf(id).childNodes.length > 0, { what: `the body of ${id}` });
  await shell.tick();
}
async function close(id) {
  card(id).open = false;
  await shell.tick();
}
// The tool cards' ticker (the bar and the panel run 1 s tickers of their own).
const toolTickers = () => shell.intervals().filter((i) => /refreshLive/.test(String(i.fn)));
const click = (elt) => elt.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/mirror': () => current,
      '/api/mirror/conversations/*': (url) => {
        const id = decodeURIComponent(url.split('?')[0].split('/')[4]);
        return pages.get(id) || { conversation_id: id, turns: [], next_before: null, total: 0, rev };
      },
      '/api/mirror/items/*': (url) => (itemAnswer ? itemAnswer(url) : respond({ ok: false, error: 'not found' }, { status: 404 })),
    },
    init: async (sh) => {
      (await sh.importApp('chat-dock.js')).initChatDock();
      (await sh.importApp('chat-panel.js')).initChatPanel();
      globalThis.IntersectionObserver = StubIO;
      (await sh.importApp('chat-stream.js')).initChatStream();
      (await sh.importApp('chat-tools.js')).initChatTools();
    },
  });
  W = shell.window;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  tools = await shell.importApp('chat-tools.js');
  stream = () => $('chat-stream');
  current = snapshot('c0');
  await shell.frame(helloFrame());
  bus.emit('chat:open', { view: 'chat' });
  await shell.tick();
});

after(() => {
  delete globalThis.IntersectionObserver;
  return shell.restore();
});

// Every field answers from the item's own fixture text unless a test says
// otherwise.
beforeEach(() => {
  itemAnswer = (url) => {
    const u = new URL(url, 'http://x');
    const id = decodeURIComponent(u.pathname.split('/')[4]);
    const field = u.searchParams.get('field');
    const text = `fetched ${field} of ${id}`;
    return { id, field, text, from: 0, to: text.length, total: text.length, eof: true };
  };
});

// ── headers ──────────────────────────────────────────────────────────────────

test('one card per tool_kind: the table\'s label, status glyph and meta', async () => {
  await follow(fixtureItems(), { tasks: fixtureTasks() });
  const want = {
    tu_read: ['Read · app.css', '✓', '120 lines'],
    tu_edit: ['Edit · QueueRail.tsx', '✓', '+12 −3'],
    tu_write: ['Write (new) · notes.md', '✓', '+40'],
    tu_bash: ['Bash · npm test', '✓', '1.2s'],
    tu_bash_err: ['Bash · npm run lint', '✗', 'exit 2'],
    tu_grep: ['Grep · railState', '✓', '4 files'],
    tu_web: ['Web · docs.example.com', '✓', '1.2s'],
    tu_todo: ['Todo · 3 / 5', '✓', ''],
    tu_mon: ['Monitor · build errors', '◌', '7 events'],
    tu_q: ['Question · Which port?', '✓', 'answered'],
    tu_plan: ['Plan', '◌', 'pending'],
    tu_wc: ['web-chat · render · tc-pane', '✓', '1.2s'],
    tu_gh: ['github · get_issue', '✓', '1.2s'],
    tu_wf: ['Workflow · release-check', '◌', 'phase 2 / 3'],
    tu_den: ['Bash · rm -rf dist', '⊘', 'denied'],
    tu_int: ['Bash · sleep 60', '✕', 'interrupted'],
  };
  for (const [id, [label, glyph, meta]] of Object.entries(want)) {
    assert.equal(labelOf(id), label, `${id}: label`);
    assert.equal(glyphOf(id), glyph, `${id}: glyph`);
    assert.equal(metaOf(id), meta, `${id}: meta`);
  }
  // The table's literal readings, glyph and meta together.
  assert.match(card('tu_bash').querySelector('.tc-status').textContent, /^✓ 1\.2s$/);
  assert.match(card('tu_bash_err').querySelector('.tc-status').textContent, /^✗ exit 2$/);
  assert.equal(labelOf('tu_bg'), 'Bash · npm run dev · background', 'a background shell says so');
  assert.match(metaOf('tu_bg'), /^running \d:\d\d$/, 'and runs on its task row\'s clock');
  assert.match(metaOf('tu_agent'), /^running 1:1[23] · 6 tools$/, 'an agent: its clock and its tool count');
  assert.equal(card('tu_wf').querySelectorAll('.tc-phase').length, 3, 'the workflow\'s phase bar');
  assert.deepEqual([...card('tu_wf').querySelectorAll('.tc-phase')].map((p) => p.dataset.state), ['done', 'running', 'pending']);
  assert.equal(card('tu_den').querySelector('.tc-glyph').getAttribute('aria-label'), 'denied');
  assert.equal(card('tu_int').dataset.status, 'interrupted');
  assert.equal(shell.calls.filter((c) => c.url.startsWith('/api/mirror/items/')).length, 0, 'drawing the headers fetches nothing');
  // Every card is a <details> the stream marked with its item.
  for (const c of stream().querySelectorAll('.tc')) assert.equal(c.tagName, 'DETAILS');
});

test('a task row\'s change repaints the live header without the stream redrawing the card', async () => {
  const now = Date.now();
  await follow(fixtureItems(now), { tasks: fixtureTasks(now) });
  const before = card('tu_mon');
  await shell.frame({ type: 'mirror:update', rev: ++rev, conversation_id: cid, tasks: [
    { ...fixtureTasks(now)[2], conversation_id: cid, rev: 2, meta: { events: 9 } }] });
  await waitUntil(() => metaOf('tu_mon') === '9 events', { what: 'the monitor\'s new count' });
  assert.equal(card('tu_mon'), before, 'the same card');
  assert.equal(toolTickers().length, 1, 'a ticker runs while a live card runs');
});

test('the 1 s ticker stops once no live card runs', async () => {
  const now = Date.now();
  const mon = fixtureTasks(now)[2];
  await follow([fixtureItems(now)[10]], { tasks: [mon] });
  await shell.frame({ type: 'mirror:update', rev: ++rev, conversation_id: cid, tasks: [
    { ...mon, conversation_id: cid, rev: 2, meta: { events: 8 } }] });
  await waitUntil(() => metaOf('tu_mon') === '8 events', { what: 'the monitor\'s new count' });
  assert.equal(toolTickers().length, 1, 'one ticker while the monitor runs');
  await shell.frame({ type: 'mirror:update', rev: ++rev, conversation_id: cid, tasks: [
    { ...mon, conversation_id: cid, rev: 3, status: 'done', ended_at: now, meta: { events: 8 } }] });
  await waitUntil(() => toolTickers().length === 0, { what: 'the ticker cleared once nothing runs' });
});

// U38@ticker-first-render: the stream draws a card before it puts it in the
// DOM, so a running live card starts the ticker once it is there, with no
// `mirror` event after it.
test('a running Agent card starts its 1 s ticker when the stream first draws it, with no further frame', async () => {
  tools.stopChatTools();   // no ticker left over from an earlier test
  tools.initChatTools();
  assert.equal(toolTickers().length, 0);
  const agent = { ...fixtureItems()[8], id: 'tu_agent_first', links: { agent_id: 'ag_first' } };
  await follow([agent]);
  await shell.tick();
  assert.equal(glyphOf('tu_agent_first'), '◌', 'the card is running');
  assert.equal(toolTickers().length, 1, 'one refreshLive interval, started by the first draw');
});

// U38@plan-rejected: §7.10's Plan row reads approved, rejected or pending.
test('Plan: approved, rejected or pending — a declined plan reads rejected, an error stays error', async () => {
  const plan = (id, status, extra = {}) => call(id, 'ExitPlanMode', 'Plan', 'Plan', { status, input: { planFilePath: '/p/plan.md' }, ...extra });
  await follow([
    plan('tu_pl_run', 'running'),
    plan('tu_pl_ok', 'done', { result: result('User has approved your plan.') }),
    // Claude Code's reply to a declined plan; normalize.js classifies it denied.
    plan('tu_pl_no', 'denied', { result: result("The user doesn't want to proceed with this tool use.", { is_error: true }) }),
    plan('tu_pl_err', 'error', { result: result('boom', { is_error: true }) }),
  ]);
  assert.deepEqual(['tu_pl_run', 'tu_pl_ok', 'tu_pl_no', 'tu_pl_err'].map((id) => [glyphOf(id), metaOf(id)]),
    [['◌', 'pending'], ['✓', 'approved'], ['⊘', 'rejected'], ['✗', 'error']]);
});

// ── the lazy body ────────────────────────────────────────────────────────────

test('a Read body is fetched once: collapse/expand and the turn\'s re-renders request nothing more', async () => {
  const items = fixtureItems();
  const t = await follow(items, { tasks: fixtureTasks() });
  assert.equal(itemCalls('tu_read', 'result').length, 0, 'nothing before the first expand');
  await open('tu_read');
  await waitUntil(() => bodyOf('tu_read').textContent.includes('fetched result of tu_read'), { what: 'the fetched body' });
  assert.equal(itemCalls('tu_read', 'result').length, 1, 'one request on the first expand');
  assert.match(itemCalls('tu_read', 'result')[0].url, /^\/api\/mirror\/items\/tu_read\?field=result&from=0&max=\d+$/);

  await close('tu_read');
  await open('tu_read');
  assert.equal(itemCalls('tu_read', 'result').length, 1, 'collapse and expand again: nothing more');

  // The turn's header changes (a new Turn object): the stream re-renders it.
  const el = card('tu_read');
  await shell.frame({ type: 'mirror:stream', rev: ++rev, conversation_id: cid,
    turns: [{ ...t, items: undefined, rev: ++rev, reply_preview: 'changed' }] });
  await shell.tick();
  // And the item itself changes (a new item object): the card is handed back as `prev`.
  const readItem = t.items.find((i) => i.id === 'tu_read');
  await shell.frame({ type: 'mirror:stream', rev: ++rev, conversation_id: cid, items: [{ ...readItem, rev: ++rev, duration_ms: 1300 }] });
  await shell.tick();
  await shell.tick();
  assert.equal(card('tu_read'), el, 'the same card, reused');
  assert.equal(card('tu_read').open, true, 'still expanded');
  assert.match(bodyOf('tu_read').textContent, /fetched result of tu_read/, 'with its fetched body');
  assert.equal(itemCalls('tu_read', 'result').length, 1, 'and still one request');
});

test('Read: Show more pages the result on, from where the last page ended', async () => {
  itemAnswer = (url) => {
    const u = new URL(url, 'http://x');
    const from = Number(u.searchParams.get('from'));
    const text = from === 0 ? 'page one\n' : 'page two\n';
    return { id: 'tu_read2', field: 'result', text, from, to: from + 100, total: 200, eof: from !== 0 };
  };
  await follow([{ ...fixtureItems()[0], id: 'tu_read2' }]);
  await open('tu_read2');
  await waitUntil(() => card('tu_read2').querySelector('.tc-more'), { what: 'Show more' });
  click(card('tu_read2').querySelector('.tc-more'));
  await waitUntil(() => bodyOf('tu_read2').textContent.includes('page two'), { what: 'the second page' });
  const urls = itemCalls('tu_read2', 'result').map((c) => c.url);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /&from=100&/, 'the next page starts at the last page\'s `to`');
  assert.match(bodyOf('tu_read2').textContent, /page one\npage two/);
  assert.equal(card('tu_read2').querySelector('.tc-more'), null, 'no Show more at the end');
});

test('an Edit card\'s body is renderDiff\'s output, and fetches nothing', async () => {
  const fetches = () => shell.calls.filter((c) => c.url.startsWith('/api/mirror/items/')).length;
  const before = fetches();
  await follow(fixtureItems().slice(1, 3));
  await open('tu_edit');
  const diff = bodyOf('tu_edit').querySelector('pre.md-diff');
  assert.ok(diff, 'a pre.md-diff');
  assert.equal(diff.querySelectorAll('span.dl.dl-add').length, 12);
  assert.equal(diff.querySelectorAll('span.dl.dl-del').length, 3);
  assert.equal(diff.querySelectorAll('span.dl-hunk').length, 1);
  await open('tu_write');
  assert.equal(bodyOf('tu_write').querySelectorAll('span.dl-add').length, 40);
  assert.equal(fetches(), before);
});

test('Bash: "$ command" and the output\'s tail', async () => {
  const long = Array.from({ length: 200 }, (_, i) => `out ${i}`).join('\n');
  itemAnswer = () => ({ id: 'tu_bash', field: 'result', text: long, from: 0, to: long.length, total: long.length, eof: true });
  await follow([fixtureItems()[3]]);
  await open('tu_bash');
  await waitUntil(() => bodyOf('tu_bash').textContent.includes('out 199'), { what: 'the tail' });
  const pres = [...bodyOf('tu_bash').querySelectorAll('pre')].map((p) => p.textContent);
  assert.equal(pres[0], '$ npm test');
  assert.ok(!pres[1].includes('out 119\n'), 'only the tail');
  assert.ok(pres[1].startsWith('out 120\n'), `the last ${tools.TAIL_LINES} lines`);
  assert.match(bodyOf('tu_bash').textContent, /The last 80 lines of 200\./);
});

// ── open, reveal ─────────────────────────────────────────────────────────────

test('Open task on a background Bash emits chat:open {view: task, id: links.task_id}', async () => {
  await follow(fixtureItems(), { tasks: fixtureTasks() });
  const seen = [];
  const off = bus.on('chat:open', (d) => seen.push(d));
  try {
    await open('tu_bg');
    const b = bodyOf('tu_bg').querySelector('.tc-open');
    assert.equal(b.textContent, 'Open task');
    click(b);
    assert.deepEqual(seen, [{ view: 'task', id: 'bg1' }]);
    assert.equal(itemCalls('tu_bg', 'result').length, 0, 'a background shell\'s body fetches nothing');

    await open('tu_agent');
    click(bodyOf('tu_agent').querySelector('.tc-open'));
    await open('tu_mon');
    click(bodyOf('tu_mon').querySelector('.tc-open'));
    await open('tu_wf');
    click(bodyOf('tu_wf').querySelector('.tc-open'));
    assert.deepEqual(seen.slice(1), [{ view: 'task', id: 'ag1' }, { view: 'task', id: 'mon1' }, { view: 'task', id: 'wf1' }]);
    assert.deepEqual([...stream().querySelectorAll('.tc-open')].map((b2) => b2.textContent),
      ['Open task', 'Open agent', 'Open monitor', 'Open workflow']);
  } finally {
    off();
  }
});

test('Show on page on a web-chat render card calls revealPane with the mount id', async () => {
  await follow(fixtureItems());
  await shell.frame({ type: 'render', id: 'tc-pane', html: '<p>pane</p>', target: 'main', params: {} });
  const pane = () => [...W.document.querySelectorAll('#main .pane')].find((p) => p.dataset.paneId === 'tc-pane');
  await waitUntil(() => pane(), { what: 'the pane on the page' });
  await open('tu_wc');
  const input = bodyOf('tu_wc').querySelector('.tc-input');
  assert.match(input.textContent, /"id": "tc-pane"/, 'an input preview');
  const scrolls = shell.scrolls.length;
  click(bodyOf('tu_wc').querySelector('.tc-reveal'));
  assert.ok(pane().classList.contains('pane-flash'), 'revealPane flashed the pane');
  assert.ok(shell.scrolls.slice(scrolls).some((s) => s.el === pane()), 'and brought it into view');
});

// ── Todo, Plan, Question ─────────────────────────────────────────────────────

test('a Todo card is a checklist of glyphs, with no <input>', async () => {
  await follow([fixtureItems()[9]]);
  await open('tu_todo');
  const items = [...bodyOf('tu_todo').querySelectorAll('.tc-todo-item')];
  assert.deepEqual(items.map((li) => li.querySelector('.tc-todo-glyph').textContent), ['☑', '☑', '☑', '◐', '☐']);
  assert.deepEqual(items.map((li) => li.querySelector('.tc-todo-text').textContent), ['one', 'two', 'three', 'four', 'five']);
  assert.equal(card('tu_todo').querySelectorAll('input, select, textarea, [contenteditable]').length, 0, 'never a form control');
  assert.equal(itemCalls('tu_todo', 'input').length, 0, 'the store held the list');
});

test('Plan: the plan\'s markdown when the full input carries it, else "the plan is in the terminal"', async () => {
  itemAnswer = () => {
    const text = JSON.stringify({ planFilePath: '/p/plan.md' }, null, 2);
    return { id: 'tu_plan', field: 'input', text, from: 0, to: text.length, total: text.length, eof: true };
  };
  await follow([fixtureItems()[12]]);
  await open('tu_plan');
  await waitUntil(() => /The plan is in the terminal/.test(bodyOf('tu_plan').textContent) && itemCalls('tu_plan', 'input').length === 1
    && !/Loading/.test(bodyOf('tu_plan').textContent), { what: 'the plan body' });

  itemAnswer = () => {
    const text = JSON.stringify({ plan: '# Ship it\n\n- **one**' });
    return { id: 'tu_plan2', field: 'input', text, from: 0, to: text.length, total: text.length, eof: true };
  };
  await follow([{ ...fixtureItems()[12], id: 'tu_plan2' }]);
  await open('tu_plan2');
  await waitUntil(() => bodyOf('tu_plan2').querySelector('div.md-chat h1'), { what: 'the plan as chat markdown' });
  assert.equal(bodyOf('tu_plan2').querySelector('strong').textContent, 'one');
});

// U36's Show plan → U38b's expandCard: the plan card itself opens, as a click
// would, and its body is requested once.
test('showPlan on a pending plan leaves the Plan card expanded, its body requested once', async () => {
  const aw = await shell.importApp('chat-awaiting.js');
  itemAnswer = () => {
    const text = JSON.stringify({ plan: '# The plan\n\n- **step**' });
    return { id: 'tu_plan_show', field: 'input', text, from: 0, to: text.length, total: text.length, eof: true };
  };
  const item = { ...fixtureItems()[12], id: 'tu_plan_show', awaiting: { ask_id: 'ask-plan-show', kind: 'plan', status: 'pending' } };
  await follow([item], { asks: [{ id: 'ask-plan-show', kind: 'plan', state: 'pending', tool_use_id: 'tu_plan_show' }] });
  await waitUntil(() => aw.pendingAsk() && aw.pendingAsk().id === 'ask-plan-show', { what: 'the pending plan ask' });
  assert.equal(card('tu_plan_show').open, false, 'collapsed before Show plan');
  assert.equal(itemCalls('tu_plan_show', 'input').length, 0);

  assert.equal(aw.showPlan(), true);
  assert.equal(card('tu_plan_show').open, true, 'the Plan card is expanded');
  await waitUntil(() => bodyOf('tu_plan_show').querySelector('div.md-chat h1'), { what: 'the plan in the card' });
  await shell.tick();   // the details' own toggle event has run too
  assert.equal(itemCalls('tu_plan_show', 'input').length, 1, 'its body requested once');
  assert.equal(tools.expandCard('tu_plan_show'), true, 'expanding an open card again');
  await shell.tick();
  assert.equal(itemCalls('tu_plan_show', 'input').length, 1, 'still once');
  assert.equal(tools.expandCard('tu_no_such_card'), false, 'no card, nothing expanded');
});

// U38@webfetch-prompt: §7.10 gives Web cards prompt and result previews; the
// projection keeps only the url, so the first expand fetches the input once.
test('a Web card shows its prompt above the result, the input fetched once on the first expand', async () => {
  const prompt = 'List the install steps';
  itemAnswer = (url) => {
    const u = new URL(url, 'http://x');
    const field = u.searchParams.get('field');
    const text = field === 'input' ? JSON.stringify({ url: 'https://docs.example.com/a', prompt }) : 'the fetched page';
    return { id: 'tu_web_p', field, text, from: 0, to: text.length, total: text.length, eof: true };
  };
  await follow([{ ...fixtureItems()[7], id: 'tu_web_p' }]);
  assert.equal(itemCalls('tu_web_p', 'input').length, 0, 'nothing before the first expand');
  await open('tu_web_p');
  await waitUntil(() => bodyOf('tu_web_p').querySelector('.tc-prompt') && bodyOf('tu_web_p').textContent.includes('the fetched page')
    && !/Loading/.test(bodyOf('tu_web_p').textContent), { what: 'the prompt and the result' });
  const p = bodyOf('tu_web_p').querySelector('.tc-prompt');
  assert.equal(p.textContent, prompt);
  const out = [...bodyOf('tu_web_p').querySelectorAll('pre')].find((x) => x.textContent === 'the fetched page');
  assert.ok(out && (p.compareDocumentPosition(out) & W.Node.DOCUMENT_POSITION_FOLLOWING), 'the prompt sits above the result');
  assert.equal(itemCalls('tu_web_p', 'input').length, 1, 'the input once');
  assert.equal(itemCalls('tu_web_p', 'result').length, 1, 'the result once');
  await close('tu_web_p');
  await open('tu_web_p');
  assert.equal(itemCalls('tu_web_p', 'input').length, 1, 'collapse and expand again: nothing more');
  assert.equal(itemCalls('tu_web_p', 'result').length, 1);
  assert.equal(bodyOf('tu_web_p').querySelector('.tc-prompt').textContent, prompt);
});

test('Question: the questions, their options and the answer', async () => {
  await follow([fixtureItems()[11]]);
  await open('tu_q');
  await waitUntil(() => /fetched result of tu_q/.test(bodyOf('tu_q').textContent), { what: 'the answer' });
  assert.equal(bodyOf('tu_q').querySelector('.tc-q-text').textContent, 'Which port?');
  assert.deepEqual([...bodyOf('tu_q').querySelectorAll('.tc-q-opts li')].map((li) => li.textContent), ['5173', '8080']);
});

// ── failures ─────────────────────────────────────────────────────────────────

test('a failing items fetch shows one error line with Retry, and Retry fetches again', async () => {
  let fail = true;
  itemAnswer = () => (fail ? respond({ ok: false, error: 'boom' }, { status: 500 })
    : { id: 'tu_grep', field: 'result', text: 'a.js\nb.js', from: 0, to: 9, total: 9, eof: true });
  await follow([fixtureItems()[6]]);
  await open('tu_grep');
  await waitUntil(() => bodyOf('tu_grep').querySelector('.tc-error'), { what: 'the error line' });
  assert.equal(bodyOf('tu_grep').querySelectorAll('.tc-error').length, 1);
  assert.match(bodyOf('tu_grep').querySelector('.tc-error').textContent, /Couldn't load this call's output\.\s*Retry/);
  assert.equal(itemCalls('tu_grep', 'result').length, 1);

  await close('tu_grep');
  await open('tu_grep');
  assert.equal(itemCalls('tu_grep', 'result').length, 1, 'a re-expand does not retry on its own');

  fail = false;
  click(bodyOf('tu_grep').querySelector('.tc-retry'));
  await waitUntil(() => bodyOf('tu_grep').textContent.includes('a.js\nb.js'), { what: 'the retried body' });
  assert.equal(itemCalls('tu_grep', 'result').length, 2, 'Retry fetched again');
  assert.equal(bodyOf('tu_grep').querySelector('.tc-error'), null);
});

test('a fetch that rejects outright is the same error line, never a throw', async () => {
  itemAnswer = () => { throw new Error('socket hang up'); };
  await follow([fixtureItems()[7]]);
  await open('tu_web');
  await waitUntil(() => bodyOf('tu_web').querySelector('.tc-retry'), { what: 'Retry' });
});

// ── text is text ─────────────────────────────────────────────────────────────

test('a result preview holding <script> and an input holding markup render as text', async () => {
  const evil = '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 2">';
  itemAnswer = () => ({ id: 'tu_x', field: 'result', text: evil, from: 0, to: evil.length, total: evil.length, eof: true });
  const x = call('tu_x', 'mcp__evil__tool', 'MCP', '<b>evil</b> · tool', { server: 'evil',
    input: { html: '<iframe src="javascript:alert(1)"></iframe>' }, result: result(evil) });
  await follow([x]);
  assert.equal(labelOf('tu_x'), '<b>evil</b> · tool', 'the label is text');
  assert.equal(head('tu_x').querySelector('b'), null);
  await open('tu_x');
  await waitUntil(() => bodyOf('tu_x').querySelectorAll('pre').length === 2, { what: 'input and result' });
  const body = bodyOf('tu_x');
  assert.equal(body.querySelector('script, img, iframe'), null, 'no markup became elements');
  assert.ok(body.textContent.includes('<script>window.__pwned = 1</script>'));
  assert.ok(body.textContent.includes('<iframe src=\\"javascript:alert(1)\\"></iframe>'));
  assert.equal(W.__pwned, undefined);
  // An agent's result goes through the chat flavour, which escapes raw HTML.
  itemAnswer = () => ({ id: 'tu_ag2', field: 'result', text: evil, from: 0, to: evil.length, total: evil.length, eof: true });
  await follow([call('tu_ag2', 'Agent', 'Agent', 'Agent · x', { input: { prompt: '<b>p</b>' }, result: result('r') })]);
  await open('tu_ag2');
  await waitUntil(() => bodyOf('tu_ag2').querySelector('div.md-chat'), { what: 'the agent result' });
  assert.equal(bodyOf('tu_ag2').querySelector('script, img, b'), null);
});

// ── level ────────────────────────────────────────────────────────────────────

test('level basic: the header from the store and no body; nothing is fetched', async () => {
  await follow([], { level: 'basic' });
  const before = shell.calls.filter((c) => c.url.startsWith('/api/mirror/items/')).length;
  const c = tools.renderToolCard(fixtureItems()[0]);
  assert.equal(c.tagName, 'DIV', 'not expandable');
  assert.ok(c.classList.contains('tc-flat'));
  assert.equal(c.querySelector('.tc-label').textContent, 'Read · app.css');
  assert.equal(c.querySelector('.tc-glyph').textContent, '✓');
  assert.equal(c.querySelector('.tc-body'), null, 'no body');
  click(c.querySelector('.tc-head'));
  await shell.tick();
  assert.equal(c.querySelector('.tc-body'), null);
  assert.equal(shell.calls.filter((x) => x.url.startsWith('/api/mirror/items/')).length, before, 'nothing fetched');
  // And denied / interrupted keep their own glyph there too.
  assert.equal(tools.renderToolCard(fixtureItems()[16]).querySelector('.tc-glyph').textContent, '⊘');
  assert.equal(tools.renderToolCard(fixtureItems()[17]).querySelector('.tc-glyph').textContent, '✕');
});

// ── the seam ─────────────────────────────────────────────────────────────────

test('the cards plug in through setToolRenderer: chat-tools reaches the stream through that seam alone', () => {
  const src = read('public/app/chat-tools.js');
  const fromStream = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/chat-stream\.js'/g)].map((m) => m[1].trim());
  assert.deepEqual(fromStream, ['setToolRenderer']);
  assert.doesNotMatch(read('public/app/chat-stream.js'), /chat-tools/, 'the stream does not know the cards');
  assert.match(read('public/app.css'), /\/\* ── U38 · tool cards · chat-tools\.js ── \*\/\n\/\* /, 'the CSS sits under its marker');
});

test('initChatTools is idempotent and stopChatTools puts the generic card back', async () => {
  assert.equal(tools.initChatTools(), tools.initChatTools(), 'one registration');
  tools.stopChatTools();
  await follow([fixtureItems()[3]]).catch(() => {});
  await waitUntil(() => stream().querySelector('.ct-tool[data-item-id="tu_bash"]'), { what: 'the generic card' });
  tools.initChatTools();
  await waitUntil(() => card('tu_bash'), { what: 'the tool card back' });
});
