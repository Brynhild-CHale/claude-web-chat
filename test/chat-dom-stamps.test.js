// The chat's DOM stamps and its settle (public/app/chat-turns.js,
// public/app/chat-stream.js; annotation engine 3A.5, D5, GT-13 / M-12):
//
//   * Through the real shell (test-support/chrome-shell, once in before()) and
//     the facade's routes: a turn with a prompt, a thought and eight chat
//     replies. Every prompt, reply and thinking element carries data-item-id
//     and data-field="text" (100%, counted by kind); tool cards keep their
//     data-item-id; a reply's top-level blocks carry data-src, the prompt's and
//     the thought's text the identity "0,<len>".
//   * 56 seeded random ranges inside reply blocks map back through the block's
//     data-src and sourceMap(text, {flavor: 'chat'}) — by lib/core/anchors
//     recordSource, the one offset engine — to source offsets whose slice is
//     the range's text: 56/56 (GT-13's NO-GO is < 56/56).
//   * A prompt's tag and a code block's Copy are chrome: recordSource /
//     resolveSource align the bubble (identity map) and the reply around them.
//   * chat:drawn fires once per drawing that changed the DOM, with the drawn
//     turn ids in order; a pruned turn is absent (160 turns draw 150);
//     clearAll says it once with [].
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const anchors = require('../lib/core/anchors');
const { sourceMap } = require('../lib/core/markdown');

const T0 = Date.UTC(2026, 9, 28, 9, 0, 0);
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };

let shell, $, bus, S, turnsMod, stream;
let current = null;
const pages = new Map();
let rev = 5000;
let convN = 0;
let cid = null;
const drawn = [];            // every chat:drawn detail, in order

class StubIO {
  constructor(cb) { this.cb = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

function snapshot(conversationId, { level = 'local' } = {}) {
  const content = level !== 'basic';
  const row = content
    ? { id: conversationId, rev: 1, headless: false, counts: ZERO, live: { state: 'idle', since: T0, last_activity_at: T0 } }
    : { id: conversationId, state: 'idle', since: T0, last_activity_at: T0, counts: ZERO };
  return { v: 1, enabled: true, now: Date.now(), rev: ++rev, content, access: { level, remote: level === 'basic' },
    capabilities: {}, primary: conversationId, aggregate: { state: 'idle' }, conversations: [row], tasks: [], asks: [] };
}

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

// The eight chat-flavour replies (headings, lists, fenced code, links,
// emphasis, inline code, a quote, a table, a rule).
const REPLIES = [
  '# Plan\n\nI will **fix** the rail first, then *the tray*.',
  '## Steps\n\n- read `app.css`\n- edit the rule\n  - keep the token\n- run the tests',
  'The change:\n\n```css\n.rail { color: var(--wc-accent); }\n```\n\nThat is all.',
  'See [the guide](https://example.test/guide) and https://example.test/other for more.',
  '> The maintainer said: keep the look.\n\nAgreed, and **nothing** else.',
  '1. first\n2. second\n3. third\n\n---\n\nDone with the list.',
  '### Result\n\n| file | lines |\n|---|--:|\n| app.css | 4 |\n| page.css | 2 |',
  'Inline `code`, ~~old~~ and a final **bold *nested* word**.',
];
const PROMPT = 'Fix the rail <b>now</b>\nplease';
const THOUGHT = 'The rail colour comes from --wc-accent; check the token first.';

function m12Turn(id, seq, extra = {}) {
  const items = [
    { id: `p_${id}`, kind: 'prompt', text: PROMPT, origin: 'human' },
    { id: `th_${id}`, kind: 'thinking', text: THOUGHT, duration_ms: 4000 },
    { id: `r0_${id}`, kind: 'reply', text: REPLIES[0] },
    { id: `tu_${id}`, kind: 'tool_call', tool: 'Read', tool_kind: 'Read', label: 'Read · app.css', call: 'Read · app.css',
      status: 'done', started_at: T0, ended_at: T0 + 1000, duration_ms: 1000 },
  ];
  for (let k = 1; k < REPLIES.length; k++) items.push({ id: `r${k}_${id}`, kind: 'reply', text: REPLIES[k] });
  return turn(id, seq, items, extra);
}

async function follow(list, { level = 'local' } = {}) {
  cid = `d${++convN}`;
  pages.set(cid, { conversation_id: cid, turns: list, next_before: null, total: list.length, rev: ++rev });
  current = snapshot(cid, { level });
  await shell.frame(helloFrame());
  if (level === 'basic') {
    await waitUntil(() => S.mirror.access.level === 'basic', { what: 'the basic snapshot' });
    await shell.tick();
    return;
  }
  await waitUntil(() => S.mirror.stream.conversationId === cid && !S.mirror.stream.loading
    && stream().querySelectorAll('.ct-turn').length === Math.min(list.length, 150), { what: `the stream of ${cid}` });
  await shell.tick();
}

const turnEl = (id) => stream().querySelector(`.ct-turn[data-turn-id="${id}"]`);
const domIds = () => [...stream().querySelectorAll('.ct-turn')].map((e) => e.dataset.turnId);
const ofCid = (c) => drawn.filter((d) => d.conversationId === c);

before(async () => {
  globalThis.IntersectionObserver = StubIO;
  shell = await bootShell({
    routes: {
      '/api/mirror': () => current,
      '/api/mirror/conversations/*': (url) => {
        const id = decodeURIComponent(url.split('?')[0].split('/')[4]);
        if (url.includes('before=')) return { conversation_id: id, turns: [], next_before: null, total: 0, rev };
        return pages.get(id) || { conversation_id: id, turns: [], next_before: null, total: 0, rev };
      },
    },
    init: async (sh) => {
      (await sh.importApp('chat-dock.js')).initChatDock();
      (await sh.importApp('chat-panel.js')).initChatPanel();
      (await sh.importApp('chat-stream.js')).initChatStream();
      (await sh.importApp('chat-tools.js')).stopChatTools();
    },
  });
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  turnsMod = await shell.importApp('chat-turns.js');
  stream = () => $('chat-stream');
  bus.on('chat:drawn', (d) => drawn.push(d));
  current = snapshot('d0');
  await shell.frame(helloFrame());
  bus.emit('chat:open', { view: 'chat' });
  await shell.tick();
});

after(() => {
  delete globalThis.IntersectionObserver;
  return shell.restore();
});

// ── the stamps ───────────────────────────────────────────────────────────────

test('stamps: every prompt, reply and thinking element carries data-item-id and data-field="text"; tool cards keep theirs', async () => {
  await follow([m12Turn('m1', 1)]);
  const t = turnEl('m1');
  const stamped = [...t.querySelectorAll('[data-item-id][data-field="text"]')];
  const byKind = { prompt: 0, reply: 0, thinking: 0 };
  for (const e of stamped) {
    if (e.classList.contains('ct-bubble')) byKind.prompt++;
    else if (e.classList.contains('ct-prose')) byKind.reply++;
    else if (e.classList.contains('ct-think-text')) byKind.thinking++;
  }
  assert.deepStrictEqual(byKind, { prompt: 1, reply: 8, thinking: 1 }, '100% of each kind');
  assert.equal(stamped.length, 10, 'nothing else is stamped as text');
  assert.equal(t.querySelectorAll('.ct-prose').length, 8);
  for (const e of t.querySelectorAll('.ct-prose')) assert.ok(e.dataset.itemId, 'every prose element');
  assert.equal(t.querySelector('.ct-bubble').dataset.itemId, 'p_m1');
  assert.equal(t.querySelector('.ct-think-text').dataset.itemId, 'th_m1');
  assert.deepStrictEqual([...t.querySelectorAll('.ct-prose')].map((e) => e.dataset.itemId),
    REPLIES.map((_, k) => `r${k}_m1`));
  const card = t.querySelector('.ct-tool[data-item-id="tu_m1"]');
  assert.ok(card, 'the tool card keeps its data-item-id');
  assert.equal(card.dataset.field, undefined);
  assert.equal(t.dataset.turnId, 'm1', 'and the turn its data-turn-id');
});

test('stamps: a reply\'s top-level blocks carry data-src; the prompt\'s and the thought\'s text the identity offsets', async () => {
  await follow([m12Turn('m2', 1)]);
  const t = turnEl('m2');
  const bubble = t.querySelector('.ct-bubble');
  assert.equal(bubble.dataset.src, `0,${PROMPT.length}`);
  assert.equal(bubble.textContent, PROMPT);
  const think = t.querySelector('.ct-think-text');
  assert.equal(think.dataset.src, `0,${THOUGHT.length}`);
  REPLIES.forEach((text, k) => {
    const el = t.querySelector(`.ct-prose[data-item-id="r${k}_m2"]`);
    const blocks = [...el.querySelectorAll('[data-src]')];
    assert.ok(blocks.length >= 1, `reply ${k} has stamped blocks`);
    for (const b of blocks) {
      const [a, z] = b.dataset.src.split(',').map(Number);
      assert.ok(a >= 0 && z <= text.length && a < z, `${b.tagName} ${b.dataset.src}`);
      assert.ok(text.slice(a, z).trim(), 'a block\'s source');
    }
    assert.equal(el.querySelector('.md-chat [data-src] [data-src]'), null, 'top-level blocks only');
  });
});

// A seeded PRNG (the same LCG the markdown fixtures use).
function prng(seed) {
  let st = seed;
  return () => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; };
}

test('GT-13: 56 seeded ranges inside reply blocks map back through data-src and the chat map, slice == text: 56/56', async () => {
  await follow([m12Turn('m3', 1)]);
  const t = turnEl('m3');
  const doc = shell.document;
  const r = prng(1307);
  const replies = REPLIES.map((text, k) => ({ text, el: t.querySelector(`.ct-prose[data-item-id="r${k}_m3"]`),
    map: sourceMap(text, { flavor: 'chat' }) }));
  let exact = 0;
  const N = 56;
  for (let k = 0; k < N; k++) {
    const rep = replies[Math.floor(r() * replies.length)];
    // A block with text (a rule has none).
    const blocks = [...rep.el.querySelectorAll('[data-src]')].filter((b) => b.textContent.length);
    const block = blocks[Math.floor(r() * blocks.length)];
    const nodes = [];
    const w = doc.createTreeWalker(block, 4);
    let n;
    while ((n = w.nextNode())) if (n.data.length && !n.parentElement.closest('[data-wc-chrome]')) nodes.push(n);
    const node = nodes[Math.floor(r() * nodes.length)];
    const a = Math.floor(r() * node.data.length);
    const b = a + 1 + Math.floor(r() * (node.data.length - a));
    const range = doc.createRange();
    range.setStart(node, a);
    range.setEnd(node, b);
    const rec = anchors.recordSource(rep.el, range, rep.map, rep.text, { md: null });
    const [lo, hi] = block.dataset.src.split(',').map(Number);
    if (rec && rep.text.slice(rec.pos.start, rec.pos.end) === range.toString()
      && rec.pos.start >= lo && rec.pos.end <= hi) exact++;
  }
  assert.equal(exact, N, `${exact}/${N} seeded ranges map back exactly`);
});

test('S2: a passage recorded over every reply resolves back to its range; the bubble aligns around its tag (identity map)', async () => {
  const web = turn('w1', 2, [{ id: 'p_w1', kind: 'prompt', text: 'from the phone', origin: 'web', device: 'mobile' }],
    { author: 'web' });
  await follow([m12Turn('m4', 1), web]);
  const doc = shell.document;
  REPLIES.forEach((text, k) => {
    const el = turnEl('m4').querySelector(`.ct-prose[data-item-id="r${k}_m4"]`);
    const map = sourceMap(text, { flavor: 'chat' });
    const all = doc.createRange();
    all.selectNodeContents(el);
    const rec = anchors.recordSource(el, all, map, text, { md: null });
    assert.ok(rec, `reply ${k}: a record`);
    const back = anchors.resolveSource(el, text, map, { v: 1, kind: 'source', slug: null, quote: rec.quote, pos: rec.pos });
    assert.deepStrictEqual([back.start, back.end], [rec.pos.start, rec.pos.end], `reply ${k}`);
    assert.ok(back.range);
  });
  const bubble = turnEl('w1').querySelector('.ct-bubble');
  const tag = bubble.querySelector('.ct-tag');
  assert.equal(tag.getAttribute('data-wc-chrome'), 'tag', 'the tag is chrome');
  assert.equal(bubble.dataset.src, '0,14', 'the tag is outside the range');
  const text = 'from the phone';
  const identity = { v: 1, len: text.length, runs: [[0, text.length, text.length, 'exact']], headings: [] };
  const range = doc.createRange();
  range.setStart(bubble.firstChild, 5);
  range.setEnd(bubble.firstChild, 8);
  const rec = anchors.recordSource(bubble, range, identity, text, { md: null });
  assert.deepStrictEqual(rec.pos, { start: 5, end: 8 });
  const back = anchors.resolveSource(bubble, text, identity, { v: 1, kind: 'source', slug: null, quote: rec.quote, pos: rec.pos });
  assert.equal(back.range.toString(), 'the');
  // A code block's Copy is chrome too.
  const copy = turnEl('m4').querySelector('.ct-copy');
  assert.equal(copy.getAttribute('data-wc-chrome'), 'copy');
});

test('stamps: the queued bubble and a preview-only opener carry no item stamp', () => {
  const entry = {};
  const t = turn('q1', 1, [{ id: 'qd1', kind: 'queued', text: 'later', status: 'queued' }], { prompt: { preview: 'a preview' } });
  const el = turnsMod.renderTurn(entry, t, { level: 'local', turnById: () => null });
  assert.equal(el.querySelector('.ct-queued .ct-bubble').dataset.itemId, undefined, 'a queued message is not an item');
  const opener = el.querySelector('.ct-open .ct-bubble');
  assert.equal(opener.textContent, 'a preview');
  assert.equal(opener.dataset.itemId, undefined, 'a preview is no item\'s text');
  assert.equal(opener.dataset.src, undefined);
});

test('stamps: renderTurn alone stamps a later prompt and keeps the stamps across a re-render', () => {
  const entry = {};
  const t = turn('lp', 1, [
    { id: 'p_lp', kind: 'prompt', text: 'first' },
    { id: 'r_lp', kind: 'reply', text: 'ok' },
    { id: 'p2_lp', kind: 'prompt', text: 'second one' },
  ]);
  const el = turnsMod.renderTurn(entry, t, { level: 'local', turnById: () => null });
  const bubbles = [...el.querySelectorAll('.ct-bubble')];
  assert.deepStrictEqual(bubbles.map((b) => [b.dataset.itemId, b.dataset.field, b.dataset.src]),
    [['p_lp', 'text', '0,5'], ['p2_lp', 'text', '0,10']]);
  const prose = el.querySelector('.ct-prose');
  turnsMod.renderTurn(entry, { ...t, rev: t.rev + 1 }, { level: 'local', turnById: () => null });
  assert.equal(el.querySelector('.ct-prose'), prose, 'the cached element, stamps and all');
  assert.equal(prose.dataset.itemId, 'r_lp');
});

// ── chat:drawn ───────────────────────────────────────────────────────────────

test('chat:drawn: once per drawing, with the drawn turn ids in order; nothing when nothing changed', async () => {
  const before = drawn.length;
  const list = [m12Turn('a1', 1), m12Turn('a2', 2), m12Turn('a3', 3)];
  await follow(list);
  const mine = ofCid(cid);
  assert.equal(mine.length, 1, 'one settle for the first drawing');
  assert.deepStrictEqual(mine[0].turnIds, ['a1', 'a2', 'a3']);
  assert.deepStrictEqual(mine[0].turnIds, domIds());
  assert.ok(drawn.slice(before).every((d) => d.conversationId === cid || d.turnIds.length === 0),
    'the conversation it left is cleared with []');

  // A frame changing a2: one more settle, the same ids.
  const n = drawn.length;
  await shell.frame({ type: 'mirror:stream', rev: ++rev, conversation_id: cid,
    turns: [{ ...list[1], items: undefined, rev: ++rev, status: 'done', duration_ms: 51000 }], items: [] });
  await waitUntil(() => drawn.length > n, { what: 'the settle after a2 changed' });
  await shell.tick();
  assert.equal(drawn.length, n + 1, 'exactly once');
  assert.deepStrictEqual(drawn[n], { conversationId: cid, turnIds: ['a1', 'a2', 'a3'] });

  // A redraw that changes nothing says nothing.
  const m = drawn.length;
  bus.emit('mirror', {});
  await shell.tick();
  await shell.tick();
  assert.equal(drawn.length, m, 'no settle for a drawing that changed nothing');
});

test('chat:drawn: a stream of 160 turns draws 150, and the pruned ids are absent', async () => {
  const list = Array.from({ length: 160 }, (_, i) => turn(`b${i}`, i + 1,
    [{ id: `p_b${i}`, kind: 'prompt', text: `p${i}` }, { id: `r_b${i}`, kind: 'reply', text: `r **${i}**` }]));
  await follow(list);
  const mine = ofCid(cid);
  assert.equal(mine.length, 1);
  const ids = mine[mine.length - 1].turnIds;
  assert.equal(ids.length, 150);
  assert.deepStrictEqual(ids, list.slice(10).map((t) => t.id));
  assert.deepStrictEqual(ids, domIds());
  for (let i = 0; i < 10; i++) assert.ok(!ids.includes(`b${i}`), `b${i} pruned and absent`);
});

test('chat:drawn: clearAll says it once with [] — leaving a conversation, and dropping below read', async () => {
  await follow([m12Turn('c1', 1)]);
  const left = cid;
  const n = drawn.length;
  await follow([m12Turn('c2', 1)]);
  const cleared = drawn.slice(n).filter((d) => d.conversationId === left);
  assert.deepStrictEqual(cleared, [{ conversationId: left, turnIds: [] }], 'once, for the conversation it cleared');
  assert.deepStrictEqual(ofCid(cid).map((d) => d.turnIds), [['c2']]);

  const shown = cid;
  const k = drawn.length;
  await follow([], { level: 'basic' });
  await waitUntil(() => drawn.length > k, { what: 'the clear below read' });
  await shell.tick();
  const after2 = drawn.slice(k);
  assert.deepStrictEqual(after2, [{ conversationId: shown, turnIds: [] }], 'once, with []');
  assert.equal(stream().querySelectorAll('.ct-turn').length, 0);
});

test('chat:drawn: chat-stream.js is its only emitter', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'public', 'app');
  const emitters = fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
    .filter((f) => /emit\(\s*['"]chat:drawn['"]/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepStrictEqual(emitters, ['chat-stream.js']);
});
