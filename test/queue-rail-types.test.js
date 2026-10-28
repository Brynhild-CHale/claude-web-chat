// The queue rail's rows per type and the Push note box (U424; PLAN.md 3B.2's
// rail half, readiness R5 M8, alpha.2 A-1; rulings Q2 = a, Q3 = b).
//
//   * an element item — U423's group {kind: 'element', type, element_id
//     (newest), element_ids, count, respond?} — draws as ONE row: the kind line
//     is the listed type's label (× its count when more than one), the type's
//     icon before it (toolbar-state.js iconSrc, ?mode=dark under web-chat's
//     dark mode); a type the toolbar does not list falls back to its name and
//     no icon. A legacy kind 'comment' item reads its type's label too.
//   * ⟲'s tooltip reads the item: a group's ⟲ removes the row from the queue
//     and deletes nothing (Q2 = a); a legacy comment item's still deletes its
//     pin; capture, signal, activity and message titles are unchanged.
//   * the dot: qi-element qi-<type>, qi-respond for a type that responds;
//     answered only when Claude has replied to EVERY member.
//   * the card is still drawn into the slot, handed the newest member's
//     element_id; one DELETE per ⟲ and per card remove (GT-07).
//   * the note is a textarea that grows with its text to 120px, Enter pushes
//     (Shift+Enter does not), a Push clears and shrinks it, and its maxlength
//     is the envelope's note cap (NOTE_MAX).
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { NOTE_MAX } = require('../lib/channel/envelope');

const WAIT = { timeout: 3000 };

const QUEUE = {
  items: [
    { id: 'q-g-cm', kind: 'element', type: 'comment', label: 'Comment', element_id: 'c3', element_ids: ['c1', 'c2', 'c3'],
      v: 1, count: 3, respond: true, summary: 'three comments', why_wake: 'comment pinned for Claude', source: 'browser',
      origin_mount: 'p1', staged: true },
    { id: 'q-g-hl', kind: 'element', type: 'highlight', label: 'Highlight', element_id: 'h1', element_ids: ['h1'],
      v: 1, count: 1, summary: 'a highlight', why_wake: 'Highlight sent to Claude', source: 'browser', staged: true },
    { id: 'q-g-x', kind: 'element', type: 'zz-unlisted', element_id: 'z2', element_ids: ['z1', 'z2'],
      v: 1, count: 2, summary: 'two of a pack type', source: 'browser', staged: true },
    { id: 'q-cm', kind: 'comment', comment_id: 'c9', summary: 'p1 · "is this right?"', why_wake: 'comment pinned for Claude',
      source: 'browser', staged: true },
    { id: 'q-cap', kind: 'capture', summary: 'Pricing table', source: 'example.com', staged: true },
    { id: 'q-sig', kind: 'signal', signal_key: 'form_submit', summary: 'form_submit', source: 'plan-picker', staged: true },
    { id: 'q-act', kind: 'activity', summary: '2 edits', source: 'form-signoff', staged: true },
    { id: 'q-msg', kind: 'message', msg_id: 'm-1', text: 'hello there', summary: 'hello there', source: 'web', staged: true },
  ],
  count: 8,
};

// The comment pins comments.js reads (GET /api/elements?type=comment): which
// ones Claude has answered is what isCommentAnswered says per id.
let answered = new Set(['c1', 'c2', 'c9']);
const pin = (id) => ({ id, v: 1, type: 'comment', shared: true, text: 'note ' + id,
  replies: answered.has(id) ? [{ author: 'claude', text: 'yes' }] : [] });

let shell, W, Q, C, shellMod;

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/queue': () => JSON.parse(JSON.stringify(QUEUE)),
      '/api/queue/*': () => ({ ok: true }),
      '/api/elements*': (url) => (/type=comment(&|$)/.test(url)
        ? { ok: true, elements: ['c1', 'c2', 'c3', 'c9'].map(pin) } : { ok: true, elements: [] }),
    },
  });
  W = shell.window;
  Q = await shell.importApp('queue.js');
  C = await shell.importApp('comments.js');
  shellMod = await shell.importApp('shell.js');
  await shell.frame(helloFrame());
  await waitUntil(() => row('q-g-cm') && row('q-msg'), { ...WAIT, what: 'the queue rail' });
  await waitUntil(() => C.isCommentAnswered('c1'), { ...WAIT, what: 'the comment pins' });
  // queue.js loads toolbar-state.js lazily at the first draw with a typed item;
  // until it lands a row reads its type's name ('highlight'), then the label.
  await waitUntil(() => kindOf('q-g-hl') === 'Highlight', { ...WAIT, what: 'the toolbar\'s labels' });
  Q.renderQueue();
});

after(async () => { await shell.restore(); });

const row = (id) => W.document.querySelector(`#queue-rail .rail-item[data-id="${id}"]`);
const kindOf = (id) => row(id).querySelector('.qi-kind').textContent;
const iconOf = (id) => row(id).querySelector('.qi-top img.qi-icon');
const dotOf = (id) => row(id).querySelector('.qi-dot');
const titleOf = (id) => row(id).querySelector('.qi-revert').title;
const note = () => W.document.getElementById('rail-add');

/* ── (1) a count row per type ────────────────────────────────────────────── */

test('a comment group of 3 reads "Comment ×3" with the type\'s icon before it; a highlight group of 1 reads "Highlight"', () => {
  assert.equal(kindOf('q-g-cm'), 'Comment ×3');
  const icon = iconOf('q-g-cm');
  assert.ok(icon, 'the type\'s icon');
  assert.equal(icon.getAttribute('src'), '/api/toolbar/icon/comment', 'iconSrc\'s URL, light mode');
  assert.equal(icon.getAttribute('alt'), '', 'decorative: the label says it');
  assert.equal(icon.nextElementSibling, row('q-g-cm').querySelector('.qi-kind'), 'before the label');
  assert.equal(kindOf('q-g-hl'), 'Highlight', 'one member: no count');
  assert.equal(iconOf('q-g-hl').getAttribute('src'), '/api/toolbar/icon/highlight');
  assert.equal(W.document.querySelectorAll('#queue-rail .rail-item[data-id="q-g-cm"]').length, 1, 'one row for the group');
});

test('a type the toolbar does not list falls back to its name, with no icon', () => {
  assert.equal(kindOf('q-g-x'), 'zz-unlisted ×2');
  assert.equal(iconOf('q-g-x'), null);
});

test('a legacy kind \'comment\' item reads its type\'s label; other kinds keep their kind line and no icon', () => {
  assert.equal(kindOf('q-cm'), 'Comment');
  for (const [id, kind] of [['q-cap', 'capture'], ['q-sig', 'signal'], ['q-act', 'activity'], ['q-msg', 'message']]) {
    assert.equal(kindOf(id), kind, id);
    assert.equal(iconOf(id), null, id);
  }
});

test('under web-chat\'s dark mode the icon is ?mode=dark; back to light, the light icon', async () => {
  const html = W.document.documentElement;
  const was = html.dataset.theme;
  delete html.dataset.theme;
  try {
    await waitUntil(() => iconOf('q-g-cm') && /\?mode=dark$/.test(iconOf('q-g-cm').getAttribute('src')), { ...WAIT, what: 'the dark icon' });
    assert.equal(iconOf('q-g-cm').getAttribute('src'), '/api/toolbar/icon/comment?mode=dark');
  } finally { html.dataset.theme = was || 'light'; }
  await waitUntil(() => iconOf('q-g-cm').getAttribute('src') === '/api/toolbar/icon/comment', { ...WAIT, what: 'the light icon' });
});

test('the label follows the toolbar\'s view of the type (a toolbar frame redraws the rows)', async () => {
  const ts = await shell.importApp('toolbar-state.js');
  const before = ts.toolbarState();
  const tools = before.tools.map((t) => (t.type === 'highlight' ? { ...t, label: 'Marker' } : t));
  ts.applyToolbarFrame({ project: before.project, user: before.user, merged: before.merged, tools });
  try {
    await waitUntil(() => kindOf('q-g-hl') === 'Marker', { ...WAIT, what: 'the relabelled row' });
  } finally {
    ts.applyToolbarFrame({ project: before.project, user: before.user, merged: before.merged, tools: before.tools });
  }
  await waitUntil(() => kindOf('q-g-hl') === 'Highlight', { ...WAIT, what: 'the label back' });
});

test('a listed type that names no icons keeps its label and draws no icon (the toolbar draws its glyph)', async () => {
  const ts = await shell.importApp('toolbar-state.js');
  const before = ts.toolbarState();
  const tools = before.tools.map((t) => (t.type === 'highlight' ? { ...t, icons: null } : t));
  ts.applyToolbarFrame({ project: before.project, user: before.user, merged: before.merged, tools });
  try {
    await waitUntil(() => iconOf('q-g-hl') === null, { ...WAIT, what: 'the icon-less row' });
    assert.equal(kindOf('q-g-hl'), 'Highlight', 'the listed label still');
    assert.ok(iconOf('q-g-cm'), 'a type that names icons keeps its icon');
  } finally {
    ts.applyToolbarFrame({ project: before.project, user: before.user, merged: before.merged, tools: before.tools });
  }
  await waitUntil(() => iconOf('q-g-hl') !== null, { ...WAIT, what: 'the icon back' });
});

/* ── (2) tooltips per type ───────────────────────────────────────────────── */

test('⟲ on an element group says it removes the row from the queue and deletes nothing', () => {
  assert.equal(titleOf('q-g-cm'), 'remove from the queue — the 3 comments stay; delete one from its own tray');
  assert.equal(titleOf('q-g-hl'), 'remove from the queue — the highlight stays; delete it from its own tray');
  assert.equal(titleOf('q-g-x'), 'remove from the queue — the 2 zz-unlisteds stay; delete one from its own tray');
  for (const id of ['q-g-cm', 'q-g-hl', 'q-g-x']) assert.doesNotMatch(titleOf(id), /delete this|revert/, id);
});

test('a legacy comment item keeps "delete this comment pin"; capture, signal, activity and message titles are unchanged', () => {
  assert.equal(titleOf('q-cm'), 'revert — remove from queue and delete this comment pin');
  assert.equal(titleOf('q-cap'), 'revert — remove from queue and drop the captured pane');
  assert.equal(titleOf('q-sig'), 'revert — remove from queue and undo this interaction (the pane stays)');
  assert.equal(titleOf('q-act'), 'revert — remove from queue and undo this interaction (the pane stays)');
  assert.equal(titleOf('q-msg'), 'remove — take this message out of the queue (nothing else changes)');
});

/* ── (3) the answered dot ────────────────────────────────────────────────── */

test('a respond type\'s group is answered only when every member is; a highlight group has no answered state', async () => {
  // c1 and c2 answered, c3 (the newest) not
  assert.equal(dotOf('q-g-cm').className, 'qi-dot qi-element qi-comment qi-respond', 'two of three answered: not yet');
  assert.equal(dotOf('q-g-hl').className, 'qi-dot qi-element qi-highlight', 'no respond: no qi-respond');
  assert.equal(dotOf('q-g-x').className, 'qi-dot qi-element qi-zz-unlisted');
  assert.equal(dotOf('q-cm').className, 'qi-dot qi-comment answered', 'a legacy item by its comment_id, as before');
  assert.equal(dotOf('q-cap').className, 'qi-dot qi-capture', 'the other kinds as before');

  // The newest member answered but an older one not: still not answered (the
  // dot reads every member, never the newest alone).
  answered = new Set(['c2', 'c3', 'c9']);
  await shell.frame(helloFrame());   // comments.js reads its pins again
  await waitUntil(() => C.isCommentAnswered('c3') && !C.isCommentAnswered('c1'), { ...WAIT, what: 'c3 answered, c1 not' });
  Q.renderQueue();
  assert.equal(dotOf('q-g-cm').className, 'qi-dot qi-element qi-comment qi-respond', 'the newest answered, c1 not: not yet');

  answered = new Set(['c1', 'c2', 'c3', 'c9', 'h1']);
  await shell.frame(helloFrame());
  await waitUntil(() => C.isCommentAnswered('c3'), { ...WAIT, what: 'c3 answered' });
  Q.renderQueue();
  assert.equal(dotOf('q-g-cm').className, 'qi-dot qi-element qi-comment qi-respond answered', 'every member answered');
  assert.equal(dotOf('q-g-hl').className, 'qi-dot qi-element qi-highlight', 'a highlight is never answered');

  answered = new Set(['c1', 'c2', 'c9']);
  await shell.frame(helloFrame());
  await waitUntil(() => !C.isCommentAnswered('c3'), { ...WAIT, what: 'c3 unanswered again' });
  Q.renderQueue();
  assert.equal(dotOf('q-g-cm').className, 'qi-dot qi-element qi-comment qi-respond');
});

/* ── (4) the card, the count and dismiss ─────────────────────────────────── */

test('the card is drawn into the slot with the newest member\'s element_id; the rail owns the count; one DELETE per ⟲ and per card remove', async () => {
  const seen = [];
  const card = {
    render(item, slot, ctx) {
      seen.push({ item, ctx });
      const b = W.document.createElement('b');
      b.className = 'u424-card';
      b.textContent = `card ${item.element_id}`;
      slot.appendChild(b);
    },
  };
  const off = shellMod.registerQueueCard('comment', card);
  try {
    await waitUntil(() => row('q-g-cm') && row('q-g-cm').querySelector('.u424-card'), { ...WAIT, what: 'the card' });
    const slot = row('q-g-cm').querySelector('.qi-card');
    assert.equal(slot.dataset.type, 'comment');
    assert.equal(slot.textContent, 'card c3', 'the newest member');
    assert.equal(kindOf('q-g-cm'), 'Comment ×3', 'the count is the rail\'s, beside the card');
    const { item, ctx } = seen.filter((s) => s.item.id === 'q-g-cm').at(-1);
    assert.ok(Object.isFrozen(item), 'a frozen copy');
    assert.deepEqual([...item.element_ids], ['c1', 'c2', 'c3']);

    let n = shell.calls.length;
    ctx.remove();
    await shell.tick(5);
    let dels = shell.calls.slice(n).filter((c) => c.method === 'DELETE');
    assert.deepEqual(dels.map((c) => c.url), ['/api/queue/q-g-cm'], 'the card\'s remove: one DELETE');
  } finally { off(); }

  await Q.hydrateQueue();
  await waitUntil(() => row('q-g-hl'), { ...WAIT, what: 'the rail again' });
  const n = shell.calls.length;
  shell.click(row('q-g-hl').querySelector('.qi-revert'));
  await shell.tick(5);
  const dels = shell.calls.slice(n).filter((c) => c.method === 'DELETE');
  assert.deepEqual(dels.map((c) => c.url), ['/api/queue/q-g-hl?revert=1'], '⟲: one DELETE, as before');
  await Q.hydrateQueue();
  await waitUntil(() => row('q-g-hl'), { ...WAIT, what: 'the rail restored' });
});

/* ── (5) the note box (A-1) ──────────────────────────────────────────────── */

test('the note is a one-row textarea, id and class rail-add, its maxlength the envelope\'s note cap', () => {
  const box = note();
  assert.equal(box.tagName, 'TEXTAREA');
  assert.ok(box.classList.contains('rail-add'));
  assert.equal(box.getAttribute('rows'), '1');
  assert.equal(NOTE_MAX, 1000, 'Q3 = b');
  assert.equal(Number(box.getAttribute('maxlength')), NOTE_MAX, 'the box stops where Claude\'s copy would');
  assert.equal(W.document.querySelector('label[for="rail-add"]').textContent, 'Comment to send with the push');
  assert.equal(box.getAttribute('placeholder'), 'Add comment…');
});

test('typing past one line grows the box with its text up to 120px, then it scrolls; emptied, it is one line again', () => {
  const box = note();
  const m = shell.scrollMetrics(box, { scrollHeight: 30 });
  const type = (text, scrollHeight) => {
    m.scrollHeight = scrollHeight;
    box.value = text;
    box.dispatchEvent(new W.Event('input', { bubbles: true }));
  };
  type('one line', 30);
  assert.equal(box.style.height, '30px');
  type('one line\ntwo lines\nthree', 66);
  assert.equal(box.style.height, '66px', 'grows with its text');
  type('x\n'.repeat(20), 400);
  assert.equal(box.style.height, `${Q.NOTE_BOX_MAX}px`, 'bounded');
  assert.equal(Q.NOTE_BOX_MAX, 120);
  type('', 30);
  assert.equal(box.style.height, '', 'empty: no inline height, the CSS\'s one row');
});

test('Enter pushes the note as `note` (one POST), Shift+Enter does not; a Push clears and shrinks the box', async () => {
  const box = note();
  const m = shell.scrollMetrics(box, { scrollHeight: 66 });
  box.value = 'first line';
  box.dispatchEvent(new W.Event('input', { bubbles: true }));

  let n = shell.calls.length;
  const shifted = shell.key('Enter', { target: box, shiftKey: true });
  await shell.tick(5);
  assert.equal(shifted.defaultPrevented, false, 'Shift+Enter is the textarea\'s own: a new line');
  assert.equal(shell.calls.slice(n).filter((c) => c.url === '/api/queue/push').length, 0, 'and no push');

  box.value = 'first line\nsecond line';
  m.scrollHeight = 66;
  box.dispatchEvent(new W.Event('input', { bubbles: true }));
  assert.equal(box.style.height, '66px');

  n = shell.calls.length;
  const enter = shell.key('Enter', { target: box });
  assert.equal(enter.defaultPrevented, true, 'Enter does not add a line');
  await waitUntil(() => shell.calls.slice(n).some((c) => c.url === '/api/queue/push'), { ...WAIT, what: 'the push' });
  await shell.tick(5);
  const pushes = shell.calls.slice(n).filter((c) => c.url === '/api/queue/push');
  assert.equal(pushes.length, 1, 'one POST');
  assert.equal(pushes[0].method, 'POST');
  assert.equal(pushes[0].body.note, 'first line\nsecond line', 'the note, its lines kept');
  await waitUntil(() => box.value === '', { ...WAIT, what: 'the cleared note' });
  assert.equal(box.style.height, '', 'shrunk back to one line');
  await Q.hydrateQueue();
});
