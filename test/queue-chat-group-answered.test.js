// A chat-comment group turns answered on the queue rail (U585, H.5;
// corrective to U424, whose hand-off left it open).
//
// The rail's dot reads comments.js isCommentAnswered — the one answered
// lookup for both families (K.2-164) — once per member, WITH the item's type:
// a chat pin ('chat-comment') is read from the chat layer's records, never
// from a page pin's, and a page comment from the live pins. And the rail
// redraws when a chat pin's record changes (public/app/chat-pins.js announces
// its records on the bus as 'chat:pins'): a reply that lands through the
// daemon's element:chat-comment frame turns the group green with no reload;
// an item drawn before the chat layer had records turns green when they come,
// with one redraw; and nothing redraws while no chat-comment item is queued.
//
// The real chrome (test-support/chrome-shell, booted once), as
// test/queue-rail-types.test.js does. The chat layer's first read is held at
// boot, so the rail draws its chat-comment items before the layer has records.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const WAIT = { timeout: 3000 };
const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);

// The mirror at `local` (the chat layer reads its pins at `read` and above).
const MIRROR = { v: 1, enabled: true, now: T0, rev: 1, content: true, access: { level: 'local', remote: false },
  capabilities: {}, primary: null, aggregate: { state: 'idle' }, conversations: [], tasks: [], asks: [] };

const group = (id, type, ids, extra = {}) => ({ id, kind: 'element', type, label: type, element_id: ids[ids.length - 1],
  element_ids: ids, v: 1, count: ids.length, summary: `${ids.length} of ${type}`, why_wake: 'sent to Claude',
  source: 'browser', staged: true, ...extra });
const QUEUE = {
  items: [
    group('q-chat', 'chat-comment', ['k1', 'k2', 'k3'], { respond: true }),
    group('q-chat-early', 'chat-comment', ['k4'], { respond: true }),
    group('q-page', 'comment', ['c1', 'c2'], { respond: true }),
    group('q-hl', 'highlight', ['h1', 'h2']),
  ],
  count: 4,
};
const ONLY_PAGE = { items: QUEUE.items.filter((it) => it.type !== 'chat-comment'), count: 2 };

// The page pins comments.js reads (GET /api/elements?type=comment).
let pageAnswered = new Set(['c1', 'c2', 'h1', 'h2']);
const pagePin = (id) => ({ id, v: 1, type: 'comment', shared: true, text: 'note ' + id,
  replies: pageAnswered.has(id) ? [{ author: 'claude', text: 'yes' }] : [] });
// A page pin that holds the id of a chat pin (the collision case: the page
// pin's lookup would read it first when no type is passed).
let pageIds = ['c1', 'c2'];

// The chat pins the chat layer reads (GET /api/elements?type=chat-comment)
// and the daemon's element:chat-comment frame carries.
const chatPin = (id, replied, v = 1) => ({ id, v, type: 'chat-comment', schema: 'chat-comment@1', seq: 1, shared: true,
  text: 'chat ' + id, anchor: { v: 1, kind: 'turn', conversation_id: 'cX', session_id: 's1', turn_id: 'tX' },
  replies: replied ? [{ author: 'claude', at: T0, text: 'answered' }] : [],
  state: 'exact', visible: 'exact', explain: 'exact' });
let chatList = [chatPin('k1', true), chatPin('k2', true), chatPin('k3', false), chatPin('k4', true)];

let release = null;
const held = new Promise((r) => { release = r; });
let queueBody = QUEUE;

let shell, W, Q, C, CP;

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/mirror': () => MIRROR,
      '/api/queue': () => JSON.parse(JSON.stringify(queueBody)),
      '/api/queue/*': () => ({ ok: true }),
      '/api/elements*': async (url) => {
        if (/type=chat-comment(&|$)/.test(url)) {
          await held;
          return { ok: true, elements: chatList.map((p) => ({ ...p })), next_cursor: 0 };
        }
        if (/type=comment(&|$)/.test(url)) return { ok: true, elements: pageIds.map(pagePin) };
        return { ok: true, elements: [] };
      },
    },
  });
  W = shell.window;
  Q = await shell.importApp('queue.js');
  C = await shell.importApp('comments.js');
  CP = await shell.importApp('chat-pins.js');
  await shell.frame(helloFrame());
  await waitUntil(() => row('q-chat') && row('q-page') && row('q-hl'), { ...WAIT, what: 'the queue rail' });
  await waitUntil(() => C.isCommentAnswered('c1', 'comment'), { ...WAIT, what: 'the page pins' });
  // queue.js loads toolbar-state.js lazily; let that redraw land first.
  await waitUntil(() => row('q-hl').querySelector('.qi-kind').textContent === 'Highlight ×2', { ...WAIT, what: 'the labels' });
  await settle();
});

after(async () => {
  if (release) release();
  await shell.restore();
});

const row = (id) => W.document.querySelector(`#queue-rail .rail-item[data-id="${id}"]`);
const dotOf = (id) => row(id).querySelector('.qi-dot');
const isGreen = (id) => dotOf(id).classList.contains('answered');
async function settle(n = 6) { for (let i = 0; i < n; i++) await shell.tick(); }

// Each drawRail empties and refills the rail's list: one observer callback
// per draw (a draw is synchronous; two draws in one task would read as one).
function countDraws() {
  const list = W.document.querySelector('#queue-rail .rail-items');
  let n = 0;
  const mo = new W.MutationObserver(() => { n++; });
  mo.observe(list, { childList: true });
  return { get n() { return n; }, stop: () => mo.disconnect() };
}

/* ── (3) drawn before the chat layer had records ─────────────────────────── */

test('a chat-comment item drawn before the chat layer loaded turns answered once it loads, with one redraw', async () => {
  assert.deepStrictEqual(CP.chatPins(), [], 'the chat layer has no records yet (its first read is held)');
  assert.equal(dotOf('q-chat-early').className, 'qi-dot qi-element qi-chat-comment qi-respond', 'drawn, not answered');
  const draws = countDraws();
  try {
    release();
    await waitUntil(() => CP.chatPinOf('k4'), { ...WAIT, what: 'the chat layer\'s first records' });
    await settle();
    assert.ok(isGreen('q-chat-early'), 'its one member is answered: green, with no reload');
    assert.ok(!isGreen('q-chat'), 'k3 has no reply yet: not answered');
    assert.equal(draws.n, 1, 'one redraw for the chat layer\'s first records');
  } finally { draws.stop(); }
});

/* ── (1)+(2) a reply through the element:chat-comment frame ──────────────── */

test('Claude replies on two of three → not answered; the third arrives on the element:chat-comment frame → the rail redraws green', async () => {
  assert.ok(C.isCommentAnswered('k1', 'chat-comment') && C.isCommentAnswered('k2', 'chat-comment'));
  assert.equal(C.isCommentAnswered('k3', 'chat-comment'), false);
  assert.equal(dotOf('q-chat').className, 'qi-dot qi-element qi-chat-comment qi-respond', 'two of three: not yet');
  const draws = countDraws();
  try {
    chatList = [chatPin('k1', true), chatPin('k2', true), chatPin('k3', true, 2), chatPin('k4', true)];
    await shell.frame({ type: 'element:chat-comment', elements: chatList.map((p) => ({ ...p })) });
    await settle();
    assert.equal(dotOf('q-chat').className, 'qi-dot qi-element qi-chat-comment qi-respond answered', 'every member answered: green');
    assert.equal(draws.n, 1, 'one redraw, with no queue frame and no Q.renderQueue()');
    // The same set again changes no record: the chat layer announces nothing.
    await shell.frame({ type: 'element:chat-comment', elements: chatList.map((p) => ({ ...p })) });
    await settle();
    assert.equal(draws.n, 1, 'an unchanged set draws nothing more');
  } finally { draws.stop(); }
});

test('a chat pin is read by its type: a page pin holding the same id never answers for it', async () => {
  // A page pin 'k3' with no reply beside the chat pin 'k3' with Claude's.
  pageIds = ['c1', 'c2', 'k3'];
  try {
    await shell.frame(helloFrame());   // comments.js reads its page pins again
    await waitUntil(() => C.isCommentAnswered('k3') === false, { ...WAIT, what: 'the page pin k3 read first without a type' });
    assert.equal(C.isCommentAnswered('k3', 'chat-comment'), true, 'by its type: the chat layer\'s record');
    Q.renderQueue();
    assert.ok(isGreen('q-chat'), 'the chat group reads its members as chat pins');
  } finally {
    pageIds = ['c1', 'c2'];
    await shell.frame(helloFrame());
    await waitUntil(() => C.isCommentAnswered('k3') === true, { ...WAIT, what: 'the page pin k3 gone' });
  }
});

test('a page comment group still turns answered as before; a highlight group (no respond) never does', async () => {
  Q.renderQueue();
  assert.equal(dotOf('q-page').className, 'qi-dot qi-element qi-comment qi-respond answered', 'both page pins answered');
  assert.equal(dotOf('q-hl').className, 'qi-dot qi-element qi-highlight', 'a highlight is never answered (h1, h2 have replies)');
  pageAnswered = new Set(['c2', 'h1', 'h2']);
  try {
    await shell.frame(helloFrame());
    await waitUntil(() => !C.isCommentAnswered('c1', 'comment'), { ...WAIT, what: 'c1 unanswered' });
    Q.renderQueue();
    assert.equal(dotOf('q-page').className, 'qi-dot qi-element qi-comment qi-respond', 'c1 unanswered: not yet');
  } finally {
    pageAnswered = new Set(['c1', 'c2', 'h1', 'h2']);
    await shell.frame(helloFrame());
    await waitUntil(() => C.isCommentAnswered('c1', 'comment'), { ...WAIT, what: 'c1 answered again' });
  }
  Q.renderQueue();
  assert.ok(isGreen('q-page'));
});

test('a chat pin change while no chat-comment item is queued draws nothing', async () => {
  queueBody = ONLY_PAGE;
  await Q.hydrateQueue();
  await waitUntil(() => !row('q-chat') && !row('q-chat-early'), { ...WAIT, what: 'the chat items gone' });
  await settle();
  const draws = countDraws();
  try {
    CP.applyChatPin(chatPin('k5', true));
    await shell.frame({ type: 'element:chat-comment', elements: [...chatList, chatPin('k6', false)].map((p) => ({ ...p })) });
    CP.dropChatPin('k5');
    await settle();
    assert.ok(!CP.chatPinOf('k5') && CP.chatPinOf('k6'), 'the chat layer took every change');
    assert.equal(draws.n, 0, 'no redraw: no chat-comment item is queued');
  } finally {
    draws.stop();
    queueBody = QUEUE;
    await Q.hydrateQueue();
  }
});

/* ── (2) the seams ───────────────────────────────────────────────────────── */

test('queue.js reaches the chat layer only through comments.js and the bus: no import of chat-pins.js', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/app/queue.js'), 'utf8');
  assert.doesNotMatch(src, /import[^;]*['"]\.\/chat-pins\.js['"]/, 'no static import');
  assert.doesNotMatch(src, /import\(\s*['"]\.\/chat-pins\.js['"]\s*\)/, 'no dynamic import');
  assert.match(src, /isCommentAnswered\(id, type\)/, 'every member read through the one lookup, with the type');
});
