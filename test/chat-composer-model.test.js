// The composer's pure half (public/app/chat-composer.js, design spec §7.13,
// §6.3, §6.6), in plain node: jsdom cannot lay out, so the popup's height is a
// pure function of the panel's (listMaxHeight), and the module loads with no
// DOM — which this file proves by loading it with none.
//
//   * The chrome's limits are the server's: MESSAGE_MAX, FILES_MAX and PATH_MAX
//     equal lib/server/composer.js's exports (the precedent: U40 pinned
//     ATTACHMENT_SHOW_MAX to the attachment route's), the `@` query cap equals
//     lib/server/project-files.js's Q_MAX, and the counter starts at 90 %.
//   * listMaxHeight: the room above the composer inside the panel, less a gap,
//     capped; a panel that is not laid out gives the cap.
//   * triggerAt: '/' only at the very start, '@' at a word start anywhere.
//   * The refusals' words, the pending states' words (§6.6), the access
//     decision and a stored draft's checks.
//   * The U65 section of app.css never uses position: fixed or a viewport unit.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(REPO, 'public/app', rel)).href);

let C;
test.before(async () => {
  assert.equal(typeof globalThis.document, 'undefined', 'precondition: no DOM in this process');
  C = await load('chat-composer.js');
});

test('the module loads with no DOM, and init with no document wires nothing', async () => {
  assert.equal(typeof C.initChatComposer, 'function');
  assert.equal(typeof C.stopChatComposer, 'function');
  assert.equal(await C.initChatComposer(), false);
  C.stopChatComposer();   // nothing to stop; never throws
});

test('MESSAGE_MAX, FILES_MAX and PATH_MAX equal lib/server/composer.js\'s; the `@` cap is the file index\'s', () => {
  const composer = require('../lib/server/composer');
  const files = require('../lib/server/project-files');
  assert.equal(C.MESSAGE_MAX, composer.MESSAGE_MAX);
  assert.equal(C.FILES_MAX, composer.FILES_MAX);
  assert.equal(C.PATH_MAX, composer.PATH_MAX);
  assert.equal(C.QUERY_MAX, files.Q_MAX);
  assert.equal(C.COUNTER_FROM, 2700, 'the counter appears from 90 % of 3,000');
  assert.equal(C.FILES_DEBOUNCE_MS, 120);
  assert.equal(C.DRAFT_KEY, 'wc:chat-draft');
  assert.equal(C.SKILLS_FOOTER, 'A skill picked here asks Claude to run it.');
});

test('the ids the composer writes are reserved (lib/server/domain/mounts.js)', () => {
  const { isReservedId } = require('../lib/server/domain/mounts');
  for (const id of [C.INPUT_ID, C.LIST_ID, `${C.OPTION_ID_PREFIX}0`, `${C.OPTION_ID_PREFIX}49`]) {
    assert.ok(isReservedId(id), `${id} is reserved`);
  }
  assert.ok(!isReservedId(`${C.OPTION_ID_PREFIX}x`), 'the family is numbered');
});

test('listMaxHeight: the room above the composer inside the panel, less the gap, capped', () => {
  const { listMaxHeight, LIST_MAX_PX, LIST_GAP_PX, LIST_PANEL_SHARE } = C;
  assert.equal(listMaxHeight(800, 700), LIST_MAX_PX, 'plenty of room: the cap');
  assert.equal(listMaxHeight(300, 150), 150 - LIST_GAP_PX, 'the room above the composer');
  assert.equal(listMaxHeight(300, 290), Math.floor(300 * LIST_PANEL_SHARE), 'never more than the panel\'s share');
  assert.equal(listMaxHeight(400, 4), 0, 'no room: nothing, never a negative height');
  assert.equal(listMaxHeight(400, -20), 0);
  assert.equal(listMaxHeight(400, 9999), Math.floor(400 * LIST_PANEL_SHARE), 'a top past the panel counts as the panel');
  assert.equal(listMaxHeight(1000, 9999), LIST_MAX_PX);
  for (const bad of [0, -1, NaN, undefined, null, '300']) {
    assert.equal(listMaxHeight(bad, 100), LIST_MAX_PX, `a panel that is not laid out (${String(bad)}): the cap`);
  }
  assert.equal(listMaxHeight(300, NaN), Math.floor(300 * LIST_PANEL_SHARE), 'an unknown top: the panel bounds it');
  // Pure: the same answer twice, and always inside the panel.
  for (const [ph, top] of [[220, 200], [622, 560], [341, 280], [120, 100]]) {
    const h = listMaxHeight(ph, top);
    assert.equal(listMaxHeight(ph, top), h);
    assert.ok(h >= 0 && h <= top && h <= ph, `${h} fits a ${ph}px panel above ${top}`);
  }
});

test('triggerAt: \'/\' only at the very start of the text, \'@\' at a word start anywhere', () => {
  const { triggerAt } = C;
  assert.deepEqual(triggerAt('/', 1), { kind: 'skill', q: '', start: 0, end: 1 });
  assert.deepEqual(triggerAt('/cap', 4), { kind: 'skill', q: 'cap', start: 0, end: 4 });
  assert.deepEqual(triggerAt('/capture rest', 3), { kind: 'skill', q: 'ca', start: 0, end: 8 }, 'the token runs to its end');
  assert.equal(triggerAt('/capture ', 9), null, 'past the name: no list');
  assert.equal(triggerAt('hi /cap', 7), null, '\'/\' after other text opens nothing');
  assert.equal(triggerAt(' /cap', 5), null, 'not even after a space');
  assert.deepEqual(triggerAt('see @lib/co', 11), { kind: 'file', q: 'lib/co', start: 4, end: 11 });
  assert.deepEqual(triggerAt('@', 1), { kind: 'file', q: '', start: 0, end: 1 });
  assert.deepEqual(triggerAt('a\n@x y', 4), { kind: 'file', q: 'x', start: 2, end: 4 });
  assert.equal(triggerAt('me@host', 7), null, 'not at a word start');
  assert.equal(triggerAt('@a b', 4), null, 'the caret left the token');
  assert.deepEqual(triggerAt('/x', undefined), { kind: 'skill', q: 'x', start: 0, end: 2 }, 'no caret: the end');
  assert.equal(triggerAt(null, 0), null);
});

test('insertChoice replaces the token and leaves one space after it', () => {
  const { insertChoice, triggerAt } = C;
  assert.deepEqual(insertChoice('/cap', triggerAt('/cap', 4), '/capture-profile'), { text: '/capture-profile ', caret: 17 });
  assert.deepEqual(insertChoice('/ca rest', triggerAt('/ca rest', 2), '/capture'), { text: '/capture rest', caret: 9 });
  assert.deepEqual(insertChoice('see @li now', triggerAt('see @li now', 7), '@lib/core/bus.js'),
    { text: 'see @lib/core/bus.js now', caret: 21 });
});

test('filterSkills: name prefixes first, then names holding it; everything for an empty query', () => {
  const list = [{ name: 'docx' }, { name: 'capture-profile' }, { name: 'anthropic-skills:pdf' }, { name: 'web-chat' },
    { name: '' }, null, { name: 7 }];
  assert.deepEqual(C.filterSkills(list, '').map((s) => s.name), ['docx', 'capture-profile', 'anthropic-skills:pdf', 'web-chat']);
  assert.deepEqual(C.filterSkills(list, 'P').map((s) => s.name), ['capture-profile', 'anthropic-skills:pdf'],
    'case-insensitive; no name starts with p, so the holders, in order');
  assert.deepEqual(C.filterSkills(list, 'web').map((s) => s.name), ['web-chat']);
  assert.deepEqual(C.filterSkills(list, 'zzz'), []);
  assert.deepEqual(C.filterSkills(null, 'a'), []);
  const many = Array.from({ length: 80 }, (_, i) => ({ name: `s${i}` }));
  assert.equal(C.filterSkills(many, 's').length, C.LIST_ROWS_MAX);
});

test('refusalHint: the body\'s hint, else a sentence per code; the path for file_refused, when for rate_limited', () => {
  const { refusalHint, REFUSAL_HINTS } = C;
  for (const code of ['empty', 'too_large', 'unknown_skill', 'user_only_skill', 'builtin_command', 'file_refused',
    'too_many_files', 'too_many', 'rate_limited', 'disabled']) {
    assert.equal(typeof REFUSAL_HINTS[code], 'string', `${code} has a sentence`);
    assert.equal(refusalHint({ ok: false, refused: code }), REFUSAL_HINTS[code]);
  }
  assert.equal(refusalHint({ ok: false, refused: 'too_large', hint: 'A message is at most 3,000 characters.' }),
    'A message is at most 3,000 characters.');
  assert.equal(refusalHint({ ok: false, refused: 'file_refused', path: '.env', why: 'sensitive',
    hint: 'That file looks like it holds secrets, so it cannot be attached.' }),
  '.env: That file looks like it holds secrets, so it cannot be attached.');
  assert.equal(refusalHint({ ok: false, refused: 'file_refused', path: 'a.txt', why: 'ignored' }),
    'a.txt: That file cannot be attached: an ignored file cannot be attached.');
  assert.equal(refusalHint({ ok: false, refused: 'file_refused', path: 'b', why: 'odd' }), 'b: That file cannot be attached (odd).');
  assert.equal(refusalHint({ ok: false, refused: 'rate_limited', retry_after: 12 }), `${REFUSAL_HINTS.rate_limited} Try again in 12 s.`);
  assert.equal(refusalHint({ ok: false, refused: 'mystery' }), 'The message was not sent.');
  assert.equal(refusalHint(null), 'The message was not sent.');
});

test('pendingLabel: §6.6\'s words for every state, Resend and Retry where they belong', () => {
  const L = (m) => C.pendingLabel(m);
  assert.deepEqual(L({ state: 'queued', position: 1 }), { text: 'next', action: null });
  assert.deepEqual(L({ state: 'queued', position: 2 }), { text: '#2', action: null });
  assert.deepEqual(L({ state: 'queued', position: 3 }), { text: '#3', action: null });
  assert.deepEqual(L({ state: 'queued', position: null }), { text: 'queued', action: null });
  assert.deepEqual(L({ state: 'held' }), { text: 'held', action: null });
  assert.deepEqual(L({ state: 'sending' }), { text: 'sending…', action: null });
  assert.deepEqual(L({ state: 'sent' }), { text: 'Sent', action: null }, 'an ack is "Sent", never "delivered"');
  assert.deepEqual(L({ state: 'parked' }), { text: 'With your next message', action: null });
  assert.deepEqual(L({ state: 'handed_over' }), { text: 'With your next message', action: null });
  assert.deepEqual(L({ state: 'unconfirmed' }), { text: 'waiting for Claude to read it', action: 'Resend' });
  assert.deepEqual(L({ state: 'failed' }), { text: 'failed — ', action: 'Retry' });
  assert.deepEqual(L({ state: 'confirmed' }), { text: 'Received', action: null }, '"Received" only for confirmed');
  for (const s of ['queued', 'held', 'sending', 'sent', 'parked', 'handed_over', 'unconfirmed', 'failed']) {
    assert.notEqual(L({ state: s, position: 1 }).text, 'Received');
  }
});

test('composerMode: full with queue_message → the input; full without → off; below full remotely → the host note', () => {
  const M = C.composerMode;
  assert.equal(M({ level: 'local', remote: false, queueMessage: true }), 'input');
  assert.equal(M({ level: 'full', remote: true, queueMessage: true }), 'input');
  assert.equal(M({ level: 'full', remote: true, queueMessage: false }), 'off');
  assert.equal(M({ level: 'local', remote: false, queueMessage: false }), 'off');
  assert.equal(M({ level: 'read', remote: true, queueMessage: true }), 'host');
  assert.equal(M({ level: 'basic', remote: true, queueMessage: false }), 'host');
  assert.equal(M({ level: 'basic', remote: false }), 'off', 'a local page before the mirror answers');
  assert.equal(M({}), 'off');
});

test('readDraft keeps a string text and at most five distinct short paths', () => {
  assert.deepEqual(C.readDraft(null), { text: '', files: [] });
  assert.deepEqual(C.readDraft('x'), { text: '', files: [] });
  assert.deepEqual(C.readDraft([1]), { text: '', files: [] });
  assert.deepEqual(C.readDraft({ text: 'hi', files: ['a', 'a', 7, '', 'b', 'x'.repeat(241), 'c', 'd', 'e', 'f'] }),
    { text: 'hi', files: ['a', 'b', 'c', 'd', 'e'] });
  assert.deepEqual(C.readDraft({ text: 5, files: 'a' }), { text: '', files: [] });
});

test('the U65 section of app.css: no position: fixed, no viewport unit, tokens only', () => {
  const css = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');
  const start = css.indexOf('/* ── U65 · the composer');
  const end = css.indexOf('/* ── U68', start);
  assert.ok(start >= 0 && end > start, 'the section is there');
  const body = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(body, /\.cc-pop\s*\{/, 'the popup is styled here');
  assert.doesNotMatch(body, /position\s*:\s*fixed/, 'never fixed to the viewport (§8.5)');
  assert.doesNotMatch(body, /\d(?:\.\d+)?(?:d|s|l)?v(?:h|w|min|max|b|i)\b/, 'never a viewport unit');
  assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b/, 'tokens, never a hex colour');
  assert.match(body, /prefers-reduced-motion/);
  assert.match(body, /\.cc-root\[data-variant="sheet"\] \.cc-input \{[^}]*height: 44px[^}]*font-size: 16px/,
    'the sheet: 44 px and 16 px text');
});
