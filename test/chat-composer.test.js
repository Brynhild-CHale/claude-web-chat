// The chat composer (public/app/chat-composer.js) through the real shell
// (test-support/chrome-shell.js): design spec §7.13, §7.9's composer slot,
// §7.10's pending messages, §6.3's refusals, §6.6's receipts' words, §7.8's
// Escape and §8.5's sheet variant; U65's brief and ruling D2 (a).
//
//   * The slot: the composer replaces the panel's note, stop brings it back, a
//     'sheet' mount moves the same element and keeps the draft.
//   * Access: below full, remotely, the host note and no input; at full with
//     queue_message off, the off note; each re-decided on a mirror frame.
//   * '/' fetches the skills once per opening and filters as typed; '@' asks
//     the file index after 120 ms, one request in flight, a stale answer
//     dropped; a choice inserts its token, a file becomes a chip (five at most).
//   * The combobox's ARIA, and the popup inside the panel.
//   * Send: through queue.js sendMessage alone, exactly {text, files,
//     conversation_id, send, device} and no skill; Shift+Enter and an IME
//     Enter never send; one request at a time; on ok everything clears and the
//     stream re-sticks; a refusal's hint keeps the text; the counter at 2,700.
//   * The draft survives a reboot of the module; a throwing localStorage is
//     invisible. Escape: the list, then the field's focus, then the chat.
//   * Pending bubbles: every state's words, the followed conversation only,
//     text never HTML, Resend and Retry as new messages.
//   * No document- or window-level listener; a confirmed web turn's bubble
//     reads 'web · mobile'.
//
// main.js does not init the composer yet (U66a will, after initChatStream):
// the boot's init calls initChatComposer().
const test = require('node:test');
const { before, after, beforeEach, afterEach } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const T0 = Date.UTC(2026, 9, 7, 9, 0, 0);
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };
const NOTE = 'Reply in the terminal, or add a note in the queue rail (Q) and Push.';

let shell, W, doc, $, bus, S, Q, C, slots, dock;
let current = null;
let rev = 7000;
const pages = new Map();       // conversation id → its turns
const daemon = { items: [], receipts: null, message: null };
let skillsCalls = 0;
let filesAnswer = null;        // (q) => body, or a promise of one

const SKILLS = [
  { name: 'capture-profile', description: 'Author a capture profile', origin: 'project' },
  { name: 'docx', description: 'Word documents', origin: 'user' },
  { name: 'anthropic-skills:pdf', description: 'PDF files', origin: 'synced' },
];

function snapshot({ level = 'local', remote = false, caps = { queue_message: true }, cid = 'c1' } = {}) {
  const content = level !== 'basic';
  const row = content
    ? { id: cid, rev: 1, headless: false, counts: ZERO, live: { state: 'idle', since: T0, last_activity_at: T0 } }
    : { id: cid, state: 'idle', since: T0, last_activity_at: T0, counts: ZERO };
  return { v: 1, enabled: true, now: Date.now(), rev: ++rev, content, access: { level, remote }, capabilities: caps,
    primary: cid, aggregate: { state: 'idle' }, conversations: [row], tasks: [], asks: [] };
}

function queueRoute(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const p = url.split('?')[0];
  if (p === '/api/queue' && method === 'GET') return { items: daemon.items, count: daemon.items.length, receipts: daemon.receipts || [] };
  if (p === '/api/queue/pending') return { pending: null };
  if (p === '/api/queue/message' && method === 'POST') {
    const body = JSON.parse(init.body);
    return daemon.message ? daemon.message(body) : { ok: true, id: 'q900', msg_id: 'm-0000aaaa', mode: 'wake' };
  }
  return { ok: true };
}

// The panel picks a registration up on its next redraw: a mirror snapshot.
async function show(opts = {}) {
  current = snapshot(opts);
  await shell.frame(helloFrame());
  await waitUntil(() => S.mirror.rev >= current.rev, { what: 'the snapshot' });
  await shell.tick();
}

const input = () => $('chat-composer-input');
const slot = () => $('chat-composer-slot');
const root = () => slot().querySelector('.cc-root');
const pop = () => slot().querySelector('.cc-pop');
const msgNote = () => slot().querySelector('.cc-msg');
const options = () => [...$('chat-composer-list').querySelectorAll('[role="option"]')];
const posts = () => shell.calls.filter((c) => c.method === 'POST' && c.url === '/api/queue/message');
const fileCalls = () => shell.calls.filter((c) => c.url.startsWith('/api/files'));

function type(text, caret = text.length) {
  const ta = input();
  ta.focus();
  ta.value = text;
  ta.setSelectionRange(caret, caret);
  ta.dispatchEvent(new W.Event('input', { bubbles: true }));
}
const key = (k, init = {}) => shell.key(k, { target: input(), ...init });
const frames = () => shell.tick(30);

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/mirror': () => current,
      '/api/mirror/conversations/*': (url) => {
        const id = decodeURIComponent(url.split('?')[0].split('/')[4]);
        const turns = pages.get(id) || [];
        return { conversation_id: id, turns, next_before: null, total: turns.length, rev };
      },
      '/api/queue*': queueRoute,
      '/api/skills*': () => { skillsCalls += 1; return { ok: true, conversation: 'c1', source: 'session', partial: false, skills: SKILLS, note: 'n' }; },
      '/api/files*': (url) => {
        const q = new URL(url, 'http://x').searchParams.get('q');
        if (filesAnswer) return filesAnswer(q);
        return { ok: true, files: [`${q}/one.js`, `${q}/two.js`].map((p) => ({ path: p, bytes: 10 })), truncated: false, source: 'git', indexed_at: 1 };
      },
    },
    init: async (sh) => {
      current = snapshot();
      (await sh.importApp('chat-dock.js')).initChatDock();
      (await sh.importApp('chat-panel.js')).initChatPanel();
      (await sh.importApp('chat-stream.js')).initChatStream();
      await (await sh.importApp('chat-composer.js')).initChatComposer();
    },
  });
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  Q = await shell.importApp('queue.js');
  C = await shell.importApp('chat-composer.js');
  slots = await shell.importApp('chat-slots.js');
  dock = await shell.importApp('chat-dock.js');
  await show();
  bus.emit('chat:open', { view: 'chat' });
  await shell.tick();
  assert.ok(dock.isChatOpen(), 'the dock is open');
});

after(() => shell.restore());

beforeEach(async () => {
  if (!dock.isChatOpen()) { bus.emit('chat:open', { view: 'chat' }); await shell.tick(); }
  if (!input()) await show();
});

afterEach(async () => {
  daemon.message = null;
  filesAnswer = null;
  if (input()) {
    key('Escape');                  // a list, if one is open
    input().value = '';
    input().dispatchEvent(new W.Event('input', { bubbles: true }));
    for (let x = slot().querySelector('.cc-chip-x'); x; x = slot().querySelector('.cc-chip-x')) shell.click(x);
    input().blur();
  }
  await frames();
});

// ── the slot ─────────────────────────────────────────────────────────────────

test('the composer mounts in #chat-composer-slot in place of the note; stop brings the note back', async () => {
  assert.ok(input(), 'the field is in the slot');
  assert.ok(slot().contains(input()));
  assert.ok(!slot().textContent.includes(NOTE), 'the panel\'s note is gone');
  assert.equal(slot().querySelector('.cc-keys').textContent, '/ skills · @ files');
  assert.equal(slot().querySelector('.cc-send').textContent, 'Send');
  assert.equal(slots.composer() !== null, true);

  C.stopChatComposer();
  assert.equal(slots.composer(), null, 'unregistered');
  assert.equal(input(), null, 'its elements are gone');
  await show();
  assert.equal(slot().textContent, NOTE, 'the panel\'s note is back on its next redraw');

  await C.initChatComposer();
  await show();
  assert.ok(input(), 'mounted again');
  assert.ok(!slot().textContent.includes(NOTE));
});

test('a second mount with the \'sheet\' variant moves the same element and keeps the typed draft', async () => {
  type('half a thought');
  const el = root();
  assert.equal(el.dataset.variant, 'desktop');
  const host = doc.createElement('div');
  doc.body.append(host);
  bus.emit('chat:host', { host, variant: 'sheet' });
  await frames();
  assert.equal(root(), el, 'the same element');
  assert.equal(el.dataset.variant, 'sheet');
  assert.equal(input().value, 'half a thought', 'the draft kept');
  bus.emit('chat:host', { host: $('cd-body'), variant: 'desktop' });
  await frames();
  assert.equal(root(), el);
  assert.equal(el.dataset.variant, 'desktop');
  assert.equal(input().value, 'half a thought');
  host.remove();
});

// ── access ───────────────────────────────────────────────────────────────────

test('below full (read, remote) the host note and no input; queue_message off shows the off note; both re-decide on a mirror frame', async () => {
  await show({ level: 'read', remote: true });
  assert.equal(input(), null, 'no input exists');
  assert.equal(doc.getElementById('chat-composer-input'), null);
  assert.equal(slot().textContent, 'Messages are sent from the host, or with claude-web-chat tunnel mirror on');
  assert.equal(slot().querySelector('.cc-off code').textContent, 'claude-web-chat tunnel mirror on');

  await show({ level: 'local', caps: { queue_message: false } });
  assert.equal(input(), null);
  assert.equal(slot().textContent, 'Sending messages from this page is off — reply in the terminal.');

  await show();
  assert.ok(input(), 'full with queue_message: the input is back');
});

// ── '/' skills ───────────────────────────────────────────────────────────────

test('\'/\' at the start fetches /api/skills?conversation=<followed> once, filters as typed; Enter inserts \'/name \'', async () => {
  const before0 = skillsCalls;
  type('/');
  await waitUntil(() => options().length === 3, { what: 'the skills' });
  assert.equal(skillsCalls, before0 + 1);
  const call = shell.calls.filter((c) => c.url.startsWith('/api/skills')).at(-1);
  assert.equal(call.url, '/api/skills?conversation=c1');
  assert.equal(slot().querySelector('.cc-pop-foot').textContent, 'A skill picked here asks Claude to run it.');
  assert.equal(slot().querySelector('.cc-pop-foot').hidden, false);
  assert.deepEqual(options().map((o) => o.querySelector('.cc-opt-name').textContent),
    ['/capture-profile', '/docx', '/anthropic-skills:pdf']);
  type('/p');
  await frames();
  assert.deepEqual(options().map((o) => o.querySelector('.cc-opt-name').textContent), ['/capture-profile', '/anthropic-skills:pdf']);
  type('/do');
  await frames();
  assert.deepEqual(options().map((o) => o.querySelector('.cc-opt-name').textContent), ['/docx']);
  assert.equal(skillsCalls, before0 + 1, 'fetched once per opening');
  const e = key('Enter');
  assert.equal(e.defaultPrevented, true);
  assert.equal(input().value, '/docx ');
  assert.equal(pop().hidden, true, 'the choice closes the list');
  assert.equal(posts().length, 0, 'choosing sends nothing');
  // A new opening fetches again.
  type('/');
  await waitUntil(() => options().length === 3);
  assert.equal(skillsCalls, before0 + 2);
});

test('\'/\' after other text opens nothing', async () => {
  const before0 = skillsCalls;
  type('hi /cap');
  await frames();
  assert.equal(pop().hidden, true);
  assert.equal(input().getAttribute('aria-expanded'), 'false');
  assert.equal(skillsCalls, before0);
});

// ── '@' files ────────────────────────────────────────────────────────────────

test('\'@\' mid-text asks /api/files?q= after 120 ms; two keystrokes inside it make one request', async () => {
  const n0 = fileCalls().length;
  type('see @l');
  type('see @li');
  assert.equal(fileCalls().length, n0, 'nothing before the debounce');
  await waitUntil(() => options().length === 2, { what: 'the files' });
  assert.equal(fileCalls().length, n0 + 1, 'one request');
  assert.equal(fileCalls().at(-1).url, '/api/files?q=li');
  assert.deepEqual(options().map((o) => o.textContent), ['li/one.js', 'li/two.js']);
  assert.equal(slot().querySelector('.cc-pop-foot').hidden, true, 'the skills footer is the skills list\'s');
});

test('a stale answer is dropped: one request in flight, then the query typed since', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  filesAnswer = (q) => (q === 'a'
    ? held.then(() => ({ ok: true, files: [{ path: 'stale/a.js', bytes: 1 }] }))
    : { ok: true, files: [{ path: `fresh/${q}.js`, bytes: 1 }] });
  const shown = [];
  const mo = new W.MutationObserver(() => shown.push($('chat-composer-list').textContent));
  mo.observe($('chat-composer-list'), { childList: true, subtree: true, characterData: true });
  const n0 = fileCalls().length;
  type('@a');
  await waitUntil(() => fileCalls().length === n0 + 1, { what: 'the first request' });
  type('@ab');
  await shell.tick(200);
  assert.equal(fileCalls().length, n0 + 1, 'one request in flight at a time');
  release();
  await waitUntil(() => options().length === 1 && options()[0].textContent === 'fresh/ab.js', { what: 'the fresh answer' });
  assert.equal(fileCalls().length, n0 + 2);
  assert.equal(fileCalls().at(-1).url, '/api/files?q=ab');
  mo.disconnect();
  assert.ok(shown.some((t) => t.includes('fresh/ab.js')), 'the observer saw the list drawn');
  assert.ok(!shown.some((t) => t.includes('stale/a.js')), 'the stale answer never showed');
});

test('choosing a file inserts \'@path\' and adds a chip; a sixth is refused with a hint; ✕ removes a chip', async () => {
  for (let i = 1; i <= 5; i++) {
    type(`f${i} @d${i}`);
    await waitUntil(() => options().length === 2);
    key('Enter');
    assert.equal(input().value, `f${i} @d${i}/one.js `);
  }
  const chips = () => [...slot().querySelectorAll('.cc-chip-path')].map((c) => c.textContent);
  assert.deepEqual(chips(), ['d1/one.js', 'd2/one.js', 'd3/one.js', 'd4/one.js', 'd5/one.js']);
  type('six @d6');
  await waitUntil(() => options().length === 2);
  key('Enter');
  assert.equal(chips().length, 5, 'a sixth is refused');
  assert.match(msgNote().textContent, /at most 5 files/);
  assert.equal(msgNote().hidden, false);
  assert.equal(input().value, 'six @d6', 'nothing inserted');
  const x = slot().querySelector('.cc-chip-x[data-path="d2/one.js"]');
  assert.equal(x.getAttribute('aria-label'), 'Remove d2/one.js');
  shell.click(x);
  assert.deepEqual(chips(), ['d1/one.js', 'd3/one.js', 'd4/one.js', 'd5/one.js']);
});

// ── the combobox ─────────────────────────────────────────────────────────────

test('the combobox: aria-expanded, aria-controls and aria-activedescendant follow the list; Up/Down move; the list sits inside the panel', async () => {
  const ta = input();
  assert.equal(ta.getAttribute('aria-controls'), 'chat-composer-list');
  assert.equal(ta.getAttribute('aria-expanded'), 'false');
  assert.equal(ta.hasAttribute('aria-activedescendant'), false);
  type('/');
  await waitUntil(() => options().length === 3);
  assert.equal(ta.getAttribute('aria-expanded'), 'true');
  assert.equal($('chat-composer-list').getAttribute('role'), 'listbox');
  assert.equal(ta.getAttribute('aria-activedescendant'), 'chat-composer-opt-0');
  key('ArrowDown');
  assert.equal(ta.getAttribute('aria-activedescendant'), 'chat-composer-opt-1');
  assert.equal($('chat-composer-opt-1').getAttribute('aria-selected'), 'true');
  assert.equal($('chat-composer-opt-0').getAttribute('aria-selected'), 'false');
  key('ArrowDown');
  key('ArrowDown');
  assert.equal(ta.getAttribute('aria-activedescendant'), 'chat-composer-opt-0', 'it wraps');
  key('ArrowUp');
  assert.equal(ta.getAttribute('aria-activedescendant'), 'chat-composer-opt-2');
  assert.ok($('chat-panel').contains($('chat-composer-list')), 'rendered inside the panel');
  assert.ok(!slot().querySelector('.popover'), 'not a .popover');
  assert.match(pop().style.maxHeight, /^\d+px$/, 'its height comes from the panel');
  assert.notEqual(W.getComputedStyle(pop()).position, 'fixed');
  // A click chooses (its pointerdown keeps the field's focus).
  const opt = $('chat-composer-opt-1');
  const down = new W.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  opt.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  shell.click(opt.querySelector('.cc-opt-name'));
  assert.equal(input().value, '/docx ');
  assert.equal(ta.getAttribute('aria-expanded'), 'false');
  assert.equal(ta.hasAttribute('aria-activedescendant'), false);
  // Blur dismisses it.
  type('/');
  await waitUntil(() => options().length === 3);
  ta.blur();
  assert.equal(pop().hidden, true);
  assert.equal(ta.getAttribute('aria-expanded'), 'false');
});

// ── send ─────────────────────────────────────────────────────────────────────

test('Enter posts through sendMessage exactly {text, files, conversation_id, send, device}; on ok all clears and the stream re-sticks', async () => {
  const stream = $('chat-stream');
  const m = shell.scrollMetrics(stream, { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 });
  type('look @x');
  await waitUntil(() => options().length === 2);
  key('Enter');
  type('/capture-profile make one\n  please @x/one.js ');
  await frames();
  assert.ok(W.localStorage.getItem('wc:chat-draft'), 'a draft is kept');
  const n0 = posts().length;
  const e = key('Enter');
  assert.equal(e.defaultPrevented, true);
  await waitUntil(() => input().value === '', { what: 'the field cleared' });
  assert.equal(posts().length, n0 + 1);
  assert.deepEqual(posts().at(-1).body, {
    text: '/capture-profile make one\n  please @x/one.js ', files: ['x/one.js'], conversation_id: 'c1',
    send: 'auto', device: 'desktop',
  });
  assert.ok(!('skill' in posts().at(-1).body), 'no skill field: the server parses the leading skill');
  assert.equal(slot().querySelectorAll('.cc-chip').length, 0, 'the chips cleared');
  assert.equal(W.localStorage.getItem('wc:chat-draft'), null, 'the draft removed');
  assert.equal(stream.scrollTop, m.scrollHeight, 'stickToBottom: the stream at its bottom');
  shell.scrollMetrics(stream, { scrollHeight: 0, clientHeight: 0, scrollTop: 0 });
});

test('Shift+Enter breaks a line; an Enter while composing sends nothing; one request at a time', async () => {
  const n0 = posts().length;
  type('one');
  const shift = key('Enter', { shiftKey: true });
  assert.equal(shift.defaultPrevented, false, 'the browser inserts the newline');
  const ime = key('Enter', { isComposing: true });
  assert.equal(ime.defaultPrevented, false);
  const ime229 = key('Enter', { keyCode: 229 });
  assert.equal(ime229.defaultPrevented, false);
  await frames();
  assert.equal(posts().length, n0, 'nothing sent');

  let release;
  daemon.message = () => new Promise((r) => { release = () => r({ ok: true, id: 'q901', msg_id: 'm-0000bbbb', mode: 'queued' }); });
  key('Enter');
  key('Enter');
  shell.click(slot().querySelector('.cc-send'));
  await frames();
  assert.equal(posts().length, n0 + 1, 'one send in flight');
  assert.equal(slot().querySelector('.cc-send').disabled, true);
  release();
  await waitUntil(() => input().value === '');
  assert.equal(slot().querySelector('.cc-send').disabled, false);
  assert.equal(input().readOnly, false, 'the field is editable again');
});

test('a refusal shows its hint under the input and keeps the text', async () => {
  const cases = [
    [{ ok: false, refused: 'too_large', max: 3000, hint: 'A message is at most 3,000 characters.' },
      'A message is at most 3,000 characters.'],
    [{ ok: false, refused: 'file_refused', path: '.env', why: 'sensitive', category: 'env',
      hint: 'That file looks like it holds secrets, so it cannot be attached.' },
    '.env: That file looks like it holds secrets, so it cannot be attached.'],
    [{ ok: false, refused: 'file_refused', path: 'notes/x.md', why: 'ignored' },
      'notes/x.md: That file cannot be attached: an ignored file cannot be attached.'],
    [{ ok: false, refused: 'rate_limited', retry_after: 17,
      hint: 'Too many messages in the last minute: wait a moment and try again.' },
    'Too many messages in the last minute: wait a moment and try again. Try again in 17 s.'],
  ];
  for (const [answer, words] of cases) {
    daemon.message = () => answer;
    type('keep these words');
    key('Enter');
    await waitUntil(() => !msgNote().hidden, { what: `the ${answer.refused} hint` });
    assert.equal(msgNote().textContent, words);
    assert.equal(input().value, 'keep these words', 'the text is kept');
    assert.equal(input().readOnly, false, 'and editable again');
    assert.equal(slot().querySelector('.cc-send').disabled, false, 'Send is back');
  }
  type('keep these words!');
  assert.equal(msgNote().hidden, true, 'typing clears the hint');
  // Empty: the hint, and no request.
  const n0 = posts().length;
  type('   ');
  key('Enter');
  assert.equal(msgNote().textContent, 'Type a message, pick a skill or attach a file.');
  assert.equal(posts().length, n0);
});

test('the counter appears at 2,700 characters', async () => {
  const count = slot().querySelector('.cc-count');
  type('x'.repeat(2699));
  assert.equal(count.hidden, true);
  type('x'.repeat(2700));
  assert.equal(count.hidden, false);
  assert.equal(count.textContent, '2,700 / 3,000');
  type('x'.repeat(3001));
  assert.equal(count.getAttribute('data-over'), 'true');
});

// ── the draft ────────────────────────────────────────────────────────────────

test('typed text and chips survive a reboot of the module through wc:chat-draft', async () => {
  type('see @k');
  await waitUntil(() => options().length === 2);
  key('Enter');
  type('see @k/one.js and more');
  await frames();
  assert.deepEqual(JSON.parse(W.localStorage.getItem('wc:chat-draft')), { text: 'see @k/one.js and more', files: ['k/one.js'] });
  C.stopChatComposer();
  await C.initChatComposer();
  await show();
  assert.equal(input().value, 'see @k/one.js and more');
  assert.deepEqual([...slot().querySelectorAll('.cc-chip-path')].map((c) => c.textContent), ['k/one.js']);
  // The last keystroke before a stop is not lost to the frame.
  type('typed just before the stop');
  C.stopChatComposer();
  await C.initChatComposer();
  await show();
  assert.equal(input().value, 'typed just before the stop');
});

test('a throwing localStorage changes nothing visible', async () => {
  const desc = [W, globalThis].map((o) => [o, Object.getOwnPropertyDescriptor(o, 'localStorage')]);
  const thrower = { configurable: true, get() { throw new Error('SecurityError'); } };
  for (const [o] of desc) Object.defineProperty(o, 'localStorage', thrower);
  const errors = [];
  const onErr = (e) => errors.push(e);
  W.addEventListener('error', onErr);
  try {
    type('private window');
    await frames();
    C.stopChatComposer();
    await C.initChatComposer();
    await show();
    assert.ok(input(), 'the composer is there');
    assert.equal(input().value, '', 'no draft to read, and no error');
    type('still works');
    await frames();
    assert.equal(input().value, 'still works');
    assert.deepEqual(errors, []);
  } finally {
    W.removeEventListener('error', onErr);
    for (const [o, d] of desc) {
      if (d) Object.defineProperty(o, 'localStorage', d);
      else delete o.localStorage;
    }
  }
});

// ── Escape ───────────────────────────────────────────────────────────────────

test('Escape: the open list first, then a non-empty draft\'s focus, then the chat (escapeChatViews)', async () => {
  type('/');
  await waitUntil(() => options().length === 3);
  key('Escape');
  assert.equal(pop().hidden, true, 'the list closed');
  assert.equal(doc.activeElement, input(), 'the field kept its focus');
  assert.ok(dock.isChatOpen());
  type('words');
  key('Escape');
  assert.notEqual(doc.activeElement, input(), 'a non-empty draft is blurred');
  assert.ok(dock.isChatOpen(), 'the chat stays');
  assert.equal(input().value, 'words', 'and kept');
  type('');
  key('Escape');
  assert.equal(dock.isChatOpen(), false, 'empty: escapeChatViews() closes the dock');
  bus.emit('chat:open', { view: 'chat' });
  await shell.tick();
});

test('escape() answers the same chain', async () => {
  const c = slots.composer();
  type('/');
  await waitUntil(() => options().length === 3);
  assert.equal(c.escape(), true);
  assert.equal(pop().hidden, true);
  type('words');
  assert.equal(c.escape(), true);
  assert.notEqual(doc.activeElement, input());
  input().value = '';
  assert.equal(c.escape(), true, 'the open dock took it');
  assert.equal(dock.isChatOpen(), false);
  assert.equal(c.escape(), false, 'nothing open: declined');
  bus.emit('chat:open', { view: 'chat' });
  await shell.tick();
  c.focus();
  assert.equal(doc.activeElement, input(), 'focus() focuses the field');
});

// ── the pending bubbles ──────────────────────────────────────────────────────

const MID = (n) => `m-${String(n).padStart(8, '0')}`;
const msg = (n, over = {}) => ({ id: `q${n}`, kind: 'message', msg_id: MID(n), conversation_id: 'c1',
  text: `words of message ${n}`, skill: null, files: [], chars: 18, autosend: true, staged: true, source: 'composer',
  why_wake: 'message from the user', summary: 'message · 18 chars', device: 'desktop', enqueued_at: T0 + n, ...over });

test('pending bubbles: every state in §6.6\'s words, the followed conversation only, text never HTML; Resend and Retry send anew', async () => {
  const XSS = '<img src=x onerror="window.__pwned=1">';
  const all = [msg(1), msg(2), msg(3, { staged: false, autosend: false }), msg(4), msg(5), msg(6), msg(7), msg(8), msg(9),
    msg(10, { conversation_id: 'c2' }), msg(11, { conversation_id: null, device: 'mobile', text: XSS, files: [{ path: 'a', bytes: 1 }] })];
  daemon.items = all;
  daemon.receipts = [];
  await Q.hydrateQueue();
  // Six of them leave the queue, each with its receipt.
  daemon.items = [all[0], all[1], all[2], all[9], all[10]];
  daemon.receipts = [
    { msg_id: MID(4), state: 'sending', at: T0 }, { msg_id: MID(5), state: 'sent', at: T0 },
    { msg_id: MID(6), state: 'parked', at: T0 }, { msg_id: MID(7), state: 'unconfirmed', at: T0 },
    { msg_id: MID(8), state: 'failed', at: T0 }, { msg_id: MID(9), state: 'sent', at: T0 },
  ];
  await Q.hydrateQueue();
  Q.foldQueueFrame({ type: 'queue', op: 'receipt', msg_id: MID(9), state: 'confirmed', at: T0 });
  await frames();
  const box = $('chat-stream').querySelector('.st-pending');
  const bubbles = () => [...box.querySelectorAll('.cc-pending')];
  const states = () => Object.fromEntries(bubbles().map((b) => [b.dataset.msgId, b.querySelector('.cc-pstate').textContent]));
  assert.deepEqual(states(), {
    [MID(1)]: 'next', [MID(2)]: '#2', [MID(3)]: 'held', [MID(4)]: 'sending…', [MID(5)]: 'Sent',
    [MID(6)]: 'With your next message', [MID(7)]: 'waiting for Claude to read itResend', [MID(8)]: 'failed — Retry',
    [MID(9)]: 'Received', [MID(11)]: '#3',
  });
  assert.ok(!bubbles().some((b) => b.dataset.msgId === MID(10)), 'another conversation\'s message is not drawn');
  assert.ok(box.compareDocumentPosition($('chat-stream').querySelector('.st-turns')) & W.Node.DOCUMENT_POSITION_PRECEDING,
    'after the turns');
  const xss = bubbles().find((b) => b.dataset.msgId === MID(11));
  assert.equal(xss.querySelector('.cc-pbubble').textContent, XSS, 'the text as text');
  assert.equal(xss.querySelector('img'), null, 'never HTML');
  assert.equal(W.__pwned, undefined);
  assert.equal(xss.querySelector('.cc-pdevice').textContent, 'sent from phone');
  assert.equal(xss.querySelector('.cc-pfiles').textContent, '1 file');

  // Resend: a new message, the same text.
  const n0 = posts().length;
  shell.click(bubbles().find((b) => b.dataset.msgId === MID(7)).querySelector('.cc-pact'));
  await waitUntil(() => posts().length === n0 + 1);
  assert.deepEqual(posts().at(-1).body, { text: 'words of message 7', files: [], conversation_id: 'c1', send: 'auto', device: 'desktop' });
  daemon.message = () => ({ ok: false, refused: 'rate_limited', retry_after: 3 });
  shell.click(bubbles().find((b) => b.dataset.msgId === MID(8)).querySelector('.cc-pact'));
  await waitUntil(() => posts().length === n0 + 2);
  assert.equal(posts().at(-1).body.text, 'words of message 8');
  await waitUntil(() => bubbles().find((b) => b.dataset.msgId === MID(8)).querySelector('.cc-pnote'), { what: 'the Retry\'s refusal' });
  assert.match(bubbles().find((b) => b.dataset.msgId === MID(8)).querySelector('.cc-pnote').textContent, /Try again in 3 s/);

  daemon.items = [];
  daemon.receipts = [];
  await Q.hydrateQueue();
  Q.foldQueueFrame({ type: 'queue', op: 'clear' });
  await frames();
});

// ── no global listener; the web bubble's device ──────────────────────────────

test('initChatComposer adds no document- or window-level listener', async () => {
  C.stopChatComposer();
  const added = [];
  const spies = [doc, W].map((t) => {
    const orig = t.addEventListener;
    t.addEventListener = function spy(type, ...rest) { added.push(type); return orig.call(this, type, ...rest); };
    return () => { t.addEventListener = orig; };
  });
  try {
    await C.initChatComposer();
    await show();
    assert.ok(input());
    type('/');
    await waitUntil(() => options().length === 3);
    key('Escape');
  } finally {
    for (const undo of spies) undo();
  }
  assert.deepEqual(added, []);
});

test('a confirmed web turn from a mobile push draws its bubble tagged \'web · mobile\' (ruling D2 (a))', async () => {
  const cid = 'cweb';
  pages.set(cid, [{
    id: 't1', rev: ++rev, conversation_id: cid, session_id: 's1', seq: 1, kind: 'prompt', author: 'web', status: 'done',
    started_at: T0, ended_at: T0 + 5000, duration_ms: 5000,
    counts: { items: 2, tools: 0, tool_errors: 0, agents: 0, tasks: 0, edits: 0 }, tool_names: [], groups: [],
    node: null, folded_into: null, code: null,
    items: [
      { id: 'p_t1', turn_id: 't1', kind: 'prompt', seq: 1000, ts: T0, rev, origin: 'peer', device: 'mobile',
        text: 'Pushed from: origin=remote device=mobile\nMessage from the user [web-chat message m-1a2b3c4d]:\n> hi' },
      { id: 'r_t1', turn_id: 't1', kind: 'reply', seq: 1001, ts: T0 + 1, rev, text: 'Hello.' },
    ],
  }]);
  await show({ cid });
  await waitUntil(() => $('chat-stream').querySelector('.ct-turn[data-turn-id="t1"]'), { what: 'the web turn' });
  const tag = $('chat-stream').querySelector('.ct-turn[data-turn-id="t1"] .ct-prompt .ct-tag');
  assert.equal(tag.textContent, 'web · mobile');
  const item = S.mirror.stream.turns.find((t) => t.id === 't1').items.find((i) => i.id === 'p_t1');
  assert.equal(item.device, 'mobile', 'chat-state kept the device');
  await show();
});
