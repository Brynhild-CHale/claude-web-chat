// The phone's grip tab as an "Under development" stand-in (public/app/chat-pull-
// stub.js), through the real shell (test-support/chrome-shell.js): design spec
// §8.2–§8.3 and §7.3–§7.4, under the maintainer's ruling of 2026-10-02 that every
// bar element a later 0.8.5 build delivers is on screen from the first alpha and
// says it is under development.
//
//   * Only on a phone: hidden on a desktop and on a narrow window that is not
//     phone-shaped, and app.css draws it only under <html class="phone"> inside
//     the one narrow breakpoint.
//   * It shows the state the desktop bar shows (uiState over the one store) —
//     working, question, waiting, idle and offline, and suspended and quiet —
//     as the data-cs-state the stub's section of app.css turns into the ink, the
//     pulse and the width, with NEEDS YOU or QUESTION while Claude waits on the
//     user; another session waiting outranks a calmer one.
//   * It rides the bottom bar wherever app.css sizes the bar, and the narrow
//     queue screen stops short of it, so it never sits on Push.
//   * A tap opens the "Under development" note; a second tap, Escape and an
//     outside tap close it (the shell's dismiss layer). No badge, no drag.
//   * It steps aside for the real phone chat: once a chat view registers as
//     'sheet' (chat-slots.js), its markup leaves the page for good.
//
// jsdom lays nothing out and applies no @media, so the look is read from app.css
// itself: its rules are matched against the live DOM with el.matches() and
// cascaded the way a browser does, which is how the stub's attributes are shown
// to select the ink, the pulse and the width the spec gives each state. The
// stub's own look is read from the rules it owns (its section, and the state
// table wherever app.css keeps it); where the tab meets its neighbours (the
// bottom bar, the queue screen) the whole sheet is read, so a later restatement
// of a neighbour's rules is followed rather than broken.
//
// main.js starts neither the store nor the stub yet (the integration unit wires
// them), so the boot's init does, as main.js will.
const test = require('node:test');
const { before, beforeEach, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');

const PHONE = { width: 390, height: 844 };
const NARROW = { width: 700, height: 900 };   // a terminal beside a browser: narrow, not phone-shaped
const DESKTOP = { width: 1280, height: 800 };

// The phone bottom bar's height before anything names it --bb-h (§8.2).
const PHONE_BAR = 'calc(60px + env(safe-area-inset-bottom))';

// ── the store's answers ──────────────────────────────────────────────────────

let rev = 0;
// GET /api/mirror, as the daemon answers it: at `local` the conversations carry
// their Live; below `read` they are StatusRows.
function snapshot(conversations, { level = 'local', primary, tasks = [] } = {}) {
  rev += 1;
  return {
    v: 1, now: Date.now(), rev, access: { level, remote: false }, capabilities: {},
    primary: primary !== undefined ? primary : (conversations[0] ? conversations[0].id : null),
    aggregate: { state: conversations.length ? 'working' : 'none' }, conversations, tasks, asks: [],
  };
}
const conversation = (id, live, extra = {}) => ({
  id, rev: 1, title: 'Queue rail redesign', headless: false,
  live: { since: Date.now() - 60000, last_activity_at: Date.now() - 1000, ...live }, ...extra,
});
const at = (ms) => Date.now() - ms;
const WORKING = { state: 'working', step: { kind: 'Edit', tool: 'Edit', label: 'Edit · paths.js', started_at: at(12000) } };
const QUESTION = { state: 'question', waiting: { kind: 'question', summary: 'Keep the 56px rail, or match the 64px queue rail?' } };
const WAITING = { state: 'waiting', waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(npm test)' } };
const IDLE = { state: 'idle', last_turn: { id: 't1', outcome: 'done', ended_at: at(240000), reply_preview: 'The rail now collapses.' } };

let mirrorBody = snapshot([]);

let shell, W, $, bus, slots, stub;
const pull = () => $('chat-pull');
const tab = () => $('chat-tab');
const note = () => $('chat-sheet');
const label = () => tab().getAttribute('aria-label');
const isOpen = () => !note().classList.contains('hidden');

// Read GET /api/mirror again (a `hello` re-hydrates the store) and wait until
// the store has announced it, by which point the stub, an earlier listener of
// the same `mirror` event, has drawn it.
async function show(body) {
  mirrorBody = body;
  let read = false;
  const off = bus.on('mirror', (d) => { if (d && Array.isArray(d.what) && d.what.includes('all')) read = true; });
  try {
    await shell.frame(helloFrame());
    await waitUntil(() => read, { timeout: 5000, what: 'the store to read GET /api/mirror' });
  } finally { off(); }
}

async function viewport(vp) {
  shell.setViewport(vp);
  await shell.tick();
}

// `fn` run with the stub unhidden, as if its script had shown it, and hidden
// again after: what the stylesheet does on its own.
function shownAnyway(fn) {
  const p = pull();
  const was = p.hidden;
  p.hidden = false;
  try { return fn(); } finally { p.hidden = was; }
}
// `fn` run with `cls` on `el`, and the class as it was after.
function withClass(el, cls, fn) {
  const had = el.classList.contains(cls);
  el.classList.add(cls);
  try { return fn(); } finally { if (!had) el.classList.remove(cls); }
}

before(async () => {
  shell = await bootShell({
    routes: { '/api/mirror': () => mirrorBody },
    init: async (sh) => {
      const ws = await sh.importApp('ws.js');
      const { initChatState } = await sh.importApp('chat-state.js');
      initChatState({ onFrame: ws.onFrame, onHello: ws.onHello });
      const { initPullStub } = await sh.importApp('chat-pull-stub.js');
      initPullStub();
    },
  });
  W = shell.window;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  slots = await shell.importApp('chat-slots.js');
  stub = await shell.importApp('chat-pull-stub.js');
});

after(() => shell.restore());

// Every case starts on a phone with the note closed, so any one of them runs on
// its own (--test-name-pattern).
beforeEach(async () => {
  if (!pull()) return;   // the last case takes the stub down
  await viewport(PHONE);
  if (isOpen()) shell.key('Escape');
});

// ── app.css, cascaded against the live DOM ───────────────────────────────────

// app.css with its comments blanked out, so an offset in it is one in app.css.
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

// The index of the bracket that closes the '{' or '(' at `open`.
function closing(text, open) {
  const [o, c] = text[open] === '(' ? ['(', ')'] : ['{', '}'];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return i;
  }
  throw new Error(`app.css has an unbalanced '${o}'`);
}

// Its rules in source order, { at, media, selector, decls }: @media blocks
// opened, @keyframes left out, `at` the rule's offset in app.css and `decls` its
// [property, value] pairs in order.
function parseRules(text, base = 0, media = null, out = []) {
  for (let i = 0; ;) {
    const open = text.indexOf('{', i);
    if (open < 0) return out;
    const lead = text.slice(i, open);
    const prelude = lead.trim();
    const close = closing(text, open);
    const body = text.slice(open + 1, close);
    if (prelude.startsWith('@media')) parseRules(body, base + open + 1, prelude.slice('@media'.length).trim(), out);
    else if (!prelude.startsWith('@')) {
      const decls = [];
      for (const d of body.split(';')) {
        const c = d.indexOf(':');
        if (c > 0) decls.push([d.slice(0, c).trim(), d.slice(c + 1).trim()]);
      }
      out.push({ at: base + i + (lead.length - lead.trimStart().length), media, selector: prelude, decls });
    }
    i = close + 1;
  }
}
const SHEET = parseRules(BARE);

// A selector list's selectors, split at its top-level commas.
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

// One selector's specificity, [ids, classes, types]: :where() counts nothing,
// :is(), :not() and :has() their most specific argument, any other pseudo-class
// a class and a pseudo-element a type. Enough CSS for app.css: no escapes.
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
    else i++;   // '*', a combinator, whitespace
  }
  return s;
}

// One query list per @media condition, which the shell keeps current as the
// viewport changes.
const queries = new Map();
const holds = (media) => {
  if (!queries.has(media)) queries.set(media, W.matchMedia(media));
  return queries.get(media).matches;
};

// Of `rules`, the declaration of any of `props` that wins on `el` now — among
// those whose @media holds for the shell's viewport: !important first, then the
// more specific selector, then the later one. { prop, value }, or null.
function cascade(el, props, rules) {
  let win = null;
  for (const r of rules) {
    if (r.media && !holds(r.media)) continue;
    let spec = null;
    for (const sel of selectors(r.selector)) {
      let hit = false;
      try { hit = el.matches(sel); } catch { /* a selector jsdom cannot parse matches nothing here */ }
      if (hit) {
        const sp = specificity(sel);
        if (!spec || bySpec(sp, spec) > 0) spec = sp;
      }
    }
    if (!spec) continue;
    r.decls.forEach(([prop, raw], pos) => {
      if (!props.includes(prop)) return;
      const important = /!\s*important$/.test(raw);
      const d = { prop, value: raw.replace(/\s*!\s*important$/, ''), important, spec, at: r.at, pos };
      if (!win || beats(d, win)) win = d;
    });
  }
  return win;
}
function beats(a, b) {
  if (a.important !== b.important) return a.important;
  return (bySpec(a.spec, b.spec) || a.at - b.at || a.pos - b.pos) > 0;
}

// The rules the stub owns: its section, and §7.4's state table wherever app.css
// keeps it (in the section, or in the status bar's, as rules made only of the
// data-cs-* attributes).
const FROM = CSS.indexOf('/* ── U22c · the phone grip-tab stub');
const TO = FROM < 0 ? -1 : CSS.indexOf('/* ── ', FROM + 1);
const SECTION = FROM < 0 || TO < 0 ? '' : CSS.slice(FROM, TO);
const STATE_TABLE = /^(\[data-cs-(?:state|pace|cat)(?:="[^"]*")?\])+$/;
const OWN = SHEET.filter((r) => (r.at >= FROM && r.at < TO) || selectors(r.selector).every((s) => STATE_TABLE.test(s)));

// The value of `prop` the stub's rules give `el` now, or null.
function declared(el, prop) {
  const d = cascade(el, [prop], OWN);
  return d ? d.value : null;
}
// What all of app.css gives `el` for any of `props` (a shorthand beside its
// longhand, say): { prop, value }, or null.
const computed = (el, props) => cascade(el, props, SHEET);

// A custom property as `el` inherits it: its own, else its nearest ancestor's.
function inheritedIn(el, name, rules) {
  for (let n = el; n; n = n.parentElement) {
    const d = cascade(n, [name], rules);
    if (d) return d.value;
  }
  return null;
}
const inherited = (el, name) => inheritedIn(el, name, OWN);

// `value` with its var(--bb-h …) taken once, as a browser takes it: the --bb-h
// `el` inherits from all of app.css, else the var()'s own fallback (null when
// neither is there).
function viaBbH(value, el) {
  const start = value == null ? -1 : value.indexOf('var(--bb-h');
  if (start < 0) return value;
  const end = closing(value, start + 3);
  const inner = value.slice(start + 4, end);
  const comma = inner.indexOf(',');
  const own = inheritedIn(el, '--bb-h', SHEET);
  const taken = own !== null ? own : comma < 0 ? null : inner.slice(comma + 1).trim();
  return taken === null ? null : `${value.slice(0, start)}${taken}${value.slice(end + 1)}`;
}

// One side of a box declaration (0 top, 1 right, 2 bottom, 3 left): a longhand's
// value, or that side of its shorthand's one to four values.
function side(d, i) {
  if (!d) return null;
  if (!['inset', 'margin', 'padding'].includes(d.prop)) return d.value;
  const v = d.value.split(/\s+/);
  return v[[[0, 0, 0, 0], [0, 1, 0, 1], [0, 1, 2, 1], [0, 1, 2, 3]][v.length - 1][i]];
}

// What the tab looks like, as the stylesheet draws the stub's current attributes.
function look() {
  const p = pull();
  const bar = p.querySelector('.ps-bar');
  const word = p.querySelector('.ps-word');
  const anim = declared(bar, 'animation');
  return {
    shown: !p.hidden && declared(p, 'display') === 'block',
    ink: declared(bar, 'background') === 'var(--cs-st)' ? inherited(bar, '--cs-st') : declared(bar, 'background'),
    pulse: anim === 'none' ? 'still' : (/^wc-chat-pulse var\(--cs-pulse\)/.test(anim) ? inherited(bar, '--cs-pulse') : anim),
    width: declared(tab(), 'min-width'),
    word: declared(word, 'display') === 'none' ? '' : word.textContent,
  };
}

// §7.4's inks and pulses and §8.3's widths, per state.
const LOOKS = {
  working: { shown: true, ink: 'var(--wc-green)', pulse: '1.2s', width: '56px', word: '' },
  question: { shown: true, ink: 'var(--wc-gold)', pulse: '1s', width: '124px', word: 'QUESTION' },
  waiting: { shown: true, ink: 'var(--wc-comment)', pulse: '.8s', width: '124px', word: 'NEEDS YOU' },
  idle: { shown: true, ink: 'var(--wc-muted)', pulse: 'still', width: '56px', word: '' },
  offline: { shown: true, ink: 'color-mix(in srgb, var(--wc-gold) 55%, var(--wc-muted))', pulse: '2.4s', width: '56px', word: '' },
  suspended: { shown: true, ink: 'var(--wc-muted)', pulse: 'still', width: '56px', word: '' },
};

/* ── where it sits, and where it does not show ─────────────────────────────── */

test('the stub sits in the pull host, right after the bottom bar, with no badge and no chat view of its own', () => {
  const p = pull();
  assert.ok(p && p.classList.contains('pull-stub'), 'the pull host holds the stub');
  assert.equal(p.parentElement, $('stage'), 'a direct child of #stage, which the modality layer walks');
  const marks = {};
  for (const n of $('stage').childNodes) {
    const m = n.nodeType === W.Node.COMMENT_NODE && /^\s*(\/?)chat-host:pull\b/.exec(n.data);
    if (m) marks[m[1] ? 'end' : 'start'] = n;
  }
  const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & W.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(marks.start && marks.end, 'both pull-host markers are still there');
  assert.ok(follows(marks.start, p) && follows(p, marks.end), 'between the pull host\'s markers');
  assert.ok(follows($('bottombar'), p), 'after the bottom bar it rides');
  assert.ok(p.contains(tab()) && p.contains(note()), 'the tab and its note are the stub\'s');
  assert.equal(tab().getAttribute('aria-controls'), 'chat-sheet', 'the tab owns the note (a second tap toggles)');
  assert.equal(tab().getAttribute('aria-describedby'), 'chat-sheet', 'and a screen reader hears it on the tab');
  assert.equal($('chat-badge'), null, 'no running-tasks badge');
  // It stands in for the phone's chat view without being one: the bar asks that
  // registry whether a chat exists, and other views (the dock) may well be in it.
  assert.ok(!slots.chatViews().some((v) => v.id === stub.PHONE_CHAT_VIEW),
    'no phone chat view is registered while the stub stands in for it');
});

test('nothing renders on a desktop, nor on a narrow window that is not a phone', async () => {
  await viewport(DESKTOP);
  await show(snapshot([conversation('c1', WAITING)]));
  assert.equal(pull().hidden, true, 'hidden at 1280px');
  assert.equal(declared(pull(), 'display'), 'none', 'and the sheet draws nothing there');
  // The stylesheet's own gate, apart from the script's: shown on a desktop even
  // under <html class="phone">, the narrow breakpoint keeps it off the page.
  shownAnyway(() => withClass(W.document.documentElement, 'phone', () =>
    assert.equal(declared(pull(), 'display'), 'none', 'the stylesheet draws it only inside the narrow breakpoint')));
  await viewport({ width: 760, height: 1000 });
  assert.equal(pull().hidden, true, 'hidden at 760px, the first desktop width');
  await viewport(NARROW);
  assert.equal(pull().hidden, true, 'hidden on a narrow window the phone layout does not apply to');
  assert.equal(W.document.documentElement.classList.contains('phone'), false, 'which is no phone');
  shownAnyway(() =>
    assert.equal(declared(pull(), 'display'), 'none', 'and, shown there, the stylesheet keys it off <html class="phone">'));
  await viewport(PHONE);
  assert.equal(pull().hidden, false, 'shown on a phone');
  assert.deepEqual(look(), LOOKS.waiting);
});

/* ── the state it shows ─────────────────────────────────────────────────────── */

test('working: a 56px tab, its bar pulsing in the working ink, saying the step', async () => {
  await viewport(PHONE);
  await show(snapshot([conversation('c1', WORKING)]));
  assert.equal(pull().dataset.csState, 'working');
  assert.deepEqual(look(), LOOKS.working);
  assert.equal(label(), 'Claude is working — Edit · paths.js');
});

test('question: 124px, QUESTION in the question ink, tinted, pulsing at 1s', async () => {
  await show(snapshot([conversation('c1', QUESTION)]));
  assert.equal(pull().dataset.csState, 'question');
  assert.deepEqual(look(), LOOKS.question);
  assert.equal(declared(pull().querySelector('.ps-word'), 'color'), 'var(--cs-st)', 'the word in the state\'s ink');
  assert.equal(declared(tab(), 'background'), 'color-mix(in srgb, var(--cs-st) 20%, var(--wc-header-bg))',
    'a tint of the state\'s ink while closed (§8.3)');
  assert.equal(inherited(tab(), '--cs-st'), 'var(--wc-gold)', 'so a yellow one');
  assert.equal(label(), 'Claude has a question — answer it in the terminal');
});

test('waiting: 124px, NEEDS YOU in rust behind a rust border, pulsing at .8s', async () => {
  await show(snapshot([conversation('c1', WAITING)]));
  assert.equal(pull().dataset.csState, 'waiting');
  assert.deepEqual(look(), LOOKS.waiting);
  assert.equal(declared(tab(), 'border-color'), 'var(--cs-st-bd)', 'the state\'s border (§7.4)');
  assert.equal(inherited(tab(), '--cs-st-bd'), 'color-mix(in srgb, var(--cs-st) 55%, transparent)',
    'which is §7.4\'s 55% of the state\'s ink');
  assert.equal(label(), 'Claude needs you: Permission · Bash(npm test) — answer in the terminal');
});

test('idle: 56px and still, in the idle ink', async () => {
  await show(snapshot([conversation('c1', IDLE)]));
  assert.equal(pull().dataset.csState, 'idle');
  assert.deepEqual(look(), LOOKS.idle);
  assert.equal(label(), 'Chat with Claude — idle');
  // No conversation at all is idle too, and so is a mirror the daemon has off.
  await show(snapshot([]));
  assert.deepEqual([pull().dataset.csState, look().pulse], ['idle', 'still']);
  await show({ enabled: false, hint: 'claude-web-chat tunnel mirror on' });
  assert.deepEqual([pull().dataset.csState, look().pulse], ['idle', 'still']);
});

test('offline: a dropped socket pulses slowly in the offline ink, and the tab comes back with it', async () => {
  await show(snapshot([conversation('c1', IDLE)]));
  const sockets = shell.sockets.length;
  shell.socket().drop();
  assert.equal(pull().dataset.csState, 'offline');
  assert.deepEqual(look(), LOOKS.offline);
  assert.equal(label(), 'Chat with Claude — reconnecting');
  await waitUntil(() => shell.sockets.length > sockets && pull().dataset.csState === 'idle',
    { timeout: 5000, what: 'the reconnect to bring the tab back to idle' });
  assert.deepEqual(look(), LOOKS.idle);
});

test('suspended and quiet are still: suspended in the idle ink, quiet in the working ink', async () => {
  await show(snapshot([conversation('c1', { state: 'suspended' })]));
  assert.equal(pull().dataset.csState, 'suspended');
  assert.deepEqual(look(), LOOKS.suspended);
  assert.equal(label(), 'Claude is suspended — resume it in the terminal');
  await show(snapshot([conversation('c1', { ...WORKING, quiet: { since: at(240000) } })]));
  assert.deepEqual([pull().dataset.csState, pull().dataset.csPace], ['working', 'quiet']);
  assert.deepEqual(look(), { ...LOOKS.working, pulse: 'still' }, 'a still bar in the working ink');
  assert.equal(label(), 'Claude is working, quiet — check the terminal', 'no age to go stale in the label');
  await show(snapshot([conversation('c1', WORKING)]));
  assert.equal(pull().dataset.csPace, undefined, 'the pace mark goes with the quiet');
});

test('below `read` the label names the kind of step or wait, and a long command is cut short', async () => {
  // A remote viewer without the opt-in gets StatusRows: the kind of step, no label.
  await show(snapshot([{ id: 'c1', state: 'working', step_kind: 'Edit', since: at(5000) }], { level: 'basic' }));
  assert.equal(pull().dataset.csState, 'working');
  assert.equal(label(), 'Claude is working — Edit');
  await show(snapshot([{ id: 'c1', state: 'waiting', waiting_kind: 'permission', since: at(5000) }], { level: 'basic' }));
  assert.deepEqual(look(), LOOKS.waiting);
  assert.equal(label(), 'Claude needs you: permission — answer in the terminal');
  // A command that runs on is cut short in the label.
  const long = `Bash(${'x'.repeat(400)})`;
  await show(snapshot([conversation('c1', { state: 'waiting', waiting: { kind: 'permission', tool: 'Bash', summary: long } })]));
  assert.ok(label().length < 220, `the label stays short (${label().length} characters)`);
  assert.match(label(), /…/);
});

test('a wait\'s label says where to answer, once, even when its command mentions a terminal', async () => {
  // The command only mentions a terminal: the label still says where to answer.
  await show(snapshot([conversation('c1', { state: 'waiting',
    waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(tail -f terminal.log)' } })]));
  assert.equal(label(), 'Claude needs you: Permission · Bash(tail -f terminal.log) — answer in the terminal');
  // A wait chat-present can say nothing more about already reads "answer in the
  // terminal", in its own words, and the label says it once.
  await show(snapshot([conversation('c1', { state: 'waiting', waiting: { kind: 'other' } })]));
  assert.equal(pull().dataset.csState, 'waiting');
  assert.equal(label(), 'Claude needs you: answer in the terminal');
});

test('another session waiting on the user outranks the one followed (§8.3)', async () => {
  await show(snapshot([
    conversation('c1', WORKING),
    conversation('c2', WAITING, { title: 'Other work' }),
  ], { primary: 'c1' }));
  assert.equal(pull().dataset.csState, 'waiting', 'NEEDS YOU from the other session, over this one\'s working');
  assert.deepEqual(look(), LOOKS.waiting);
  assert.equal(label(), 'Claude needs you in another session: Permission · Bash(npm test) — answer in the terminal');
  await show(snapshot([
    conversation('c1', WAITING),
    conversation('c2', QUESTION, { title: 'Other work' }),
  ], { primary: 'c1' }));
  assert.equal(pull().dataset.csState, 'waiting', 'a question elsewhere does not outrank a wait here');
  assert.doesNotMatch(label(), /another session/);
});

test('running tasks add no badge in this build', async () => {
  const task = (id, kind) => ({ id, kind, conversation_id: 'c1', title: id, status: 'running', started_at: at(60000) });
  await show(snapshot([conversation('c1', WORKING, { counts: { shells: 1, agents: 1 } })],
    { tasks: [task('t1', 'shell'), task('t2', 'agent')] }));
  assert.deepEqual(look(), LOOKS.working);
  assert.equal(pull().querySelector('.chat-badge, .cb-n, .ct-count'), null, 'no count anywhere on the tab');
  assert.doesNotMatch(label(), /running/);
});

/* ── the note ─────────────────────────────────────────────────────────────── */

test('a tap opens the "Under development" note, and a second tap closes it', async () => {
  await show(snapshot([conversation('c1', WORKING)]));
  assert.equal(isOpen(), false);
  shell.press(tab());
  assert.equal(isOpen(), true, 'the tap opened the note');
  assert.equal(tab().getAttribute('aria-expanded'), 'true');
  assert.equal(note().querySelector('h4').textContent, 'Under development');
  assert.equal(note().querySelector('p').textContent,
    'Chat and tasks on your phone land in a later 0.8.5 build; the tab already shows what Claude is doing.');
  shell.press(tab());
  assert.equal(isOpen(), false, 'the second tap closed it (the dismiss layer left it to the tab)');
  assert.equal(tab().getAttribute('aria-expanded'), 'false');
});

test('Escape and an outside tap close the note; opening it closes any other panel', async () => {
  shell.press(tab());
  assert.equal(isOpen(), true);
  shell.key('Escape');
  assert.equal(isOpen(), false, 'Escape');
  assert.equal(tab().getAttribute('aria-expanded'), 'false', 'and the tab says so');

  shell.press(tab());
  assert.equal(isOpen(), true);
  shell.press($('main'));
  assert.equal(isOpen(), false, 'a tap on the page');

  // One panel at a time, even when the tab is worked without a pointer.
  $('more-menu').classList.remove('hidden');
  shell.click(tab());
  assert.equal(isOpen(), true);
  assert.ok($('more-menu').classList.contains('hidden'), 'the other panel closed');
  shell.key('Escape');
  assert.equal(isOpen(), false);
});

test('the note says what is coming in the user\'s words, never the build plan\'s', () => {
  const text = note().textContent.replace(/\s+/g, ' ').trim();
  assert.match(text, /^Under development /);
  assert.doesNotMatch(text, /tranche|stub|\bU\d|wave|unit/i);
});

test('leaving the phone layout hides the tab and closes its note', async () => {
  shell.press(tab());
  assert.equal(isOpen(), true);
  await viewport(DESKTOP);
  assert.equal(pull().hidden, true);
  assert.equal(isOpen(), false, 'no open panel is left behind on a hidden tab');
  assert.equal(tab().getAttribute('aria-expanded'), 'false');
  await viewport(PHONE);
  assert.equal(pull().hidden, false);
  assert.equal(isOpen(), false, 'and it comes back closed');
});

/* ── the geometry, as the stylesheet gives it ─────────────────────────────── */

test('the tab rides the bottom bar\'s top edge, right-justified, on the chat rung', async () => {
  assert.ok(SECTION, 'app.css carries the stub\'s section');
  await viewport(PHONE);
  const p = pull();
  assert.equal(p.hidden, false, 'on a phone');
  assert.equal(declared(p, 'position'), 'absolute');
  assert.equal(declared(p, 'z-index'), 'var(--z-chat)', 'above the bottom bar and the pins, below every panel');
  assert.equal(declared(p, 'right'), 'env(safe-area-inset-right)', 'right-justified');
  // Its bottom is the bottom bar's height less the bar's 1px top border, which
  // the tab covers so the two read as one: --bb-h once the narrow posture names
  // the height so (§8.2), the phone bar's own until then.
  assert.equal(declared(p, 'bottom'), `calc(var(--bb-h, ${PHONE_BAR}) - 1px)`);
  // And it meets the bar however app.css sizes the bar: the bar's height as the
  // whole sheet cascades it on a phone and the tab's bottom, each taken through
  // its var(--bb-h) the way a browser takes it, are that 1px apart.
  const bb = $('bottombar');
  const height = computed(bb, ['height']);
  assert.ok(height, 'app.css sizes the phone\'s bottom bar');
  assert.ok(viaBbH(height.value, bb), `the bar's height resolves (${height.value})`);
  assert.equal(viaBbH(declared(p, 'bottom'), p), `calc(${viaBbH(height.value, bb)} - 1px)`);
  const t = tab();
  assert.equal(declared(t, 'height'), '23px');
  assert.equal(declared(t, 'border-radius'), '10px 0 0 0');
  assert.equal(declared(t, 'border-right'), '0', 'flush with the screen\'s right edge');
  assert.equal(declared(t, 'border-bottom'), '0', 'open to the bar below it');
  const bar4 = p.querySelector('.ps-bar');
  assert.deepEqual([declared(bar4, 'width'), declared(bar4, 'height')], ['26px', '4px'], 'a 26×4 bar');
  assert.equal(declared(t, 'touch-action'), null, 'nothing to drag yet');
});

test('the queue screen stops where the tab begins, so the tab never sits on Push', async () => {
  // Below 760px the open rail covers the page down to the bottom bar, and the
  // tab rides that bar over the rail's foot, where Push is. The rail's column
  // (all of app.css, cascaded: the stub's rule against the rail's own inset)
  // ends at the tab's top edge instead: its 23px less the 1px it lays over the bar.
  await viewport(PHONE);
  assert.equal(pull().hidden, false, 'the tab is up');
  const rail = $('queue-rail');
  const column = rail.querySelector('.rail-expanded');
  assert.ok(column && column.querySelector('.rail-push'), 'the rail\'s column holds Push');
  const foot = () => side(computed(column, ['bottom', 'inset']), 2);
  assert.equal(rail.classList.contains('open'), false);
  assert.equal(foot(), '0', 'a closed rail keeps its own inset');
  withClass(rail, 'open', () => {
    assert.equal(foot(), `${parseFloat(declared(tab(), 'height')) - 1}px`, 'the open queue screen stops at the tab');
    // Only while the tab is there to clear: with the stub hidden the queue
    // screen reaches the bar again.
    const p = pull();
    p.hidden = true;
    try { assert.equal(foot(), '0', 'no tab, no gap'); } finally { p.hidden = false; }
  });
  assert.equal(pull().hidden, false, 'and the tab is up again');
  // And off the phone layout, where the stub never shows, the rail is the rail.
  await viewport(NARROW);
  withClass(rail, 'open', () => assert.equal(foot(), '0', 'a narrow window that is not a phone'));
  await viewport(DESKTOP);
  withClass(rail, 'open', () => assert.equal(foot(), '0', 'a desktop'));
});

test('the pulse is opacity only, and it stops under reduced motion', async () => {
  // §7.4's one pulse, wherever app.css keeps it (the stub's own block, the status
  // bar's section, or both while they share a branch): every copy, opacity only.
  const pulses = [...BARE.matchAll(/@keyframes\s+wc-chat-pulse\s*\{/g)].map((m) => {
    const open = m.index + m[0].length - 1;
    return BARE.slice(open + 1, closing(BARE, open));
  });
  assert.ok(pulses.length >= 1, 'app.css carries §7.4\'s pulse');
  for (const body of pulses) {
    const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(props)], ['opacity'], 'opacity only, like the Final\'s wcpulse');
  }
  await show(snapshot([conversation('c1', WORKING)]));
  assert.equal(look().pulse, '1.2s');
  shell.setViewport({ reducedMotion: true });
  try {
    assert.equal(look().pulse, 'still', 'no pulse under prefers-reduced-motion');
    assert.equal(declared(tab(), 'transition'), 'none');
  } finally { shell.setViewport({ reducedMotion: false }); }
});

test('the stub runs no timer, asks no media query and registers nothing; it reads the one store through the one model', () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/chat-pull-stub.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\bset(?:Timeout|Interval)\b|requestAnimationFrame|matchMedia|localStorage|sessionStorage/);
  const imports = [...src.matchAll(/^import\b[^;]*?from\s*'([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./bus.js', './chat-present.js', './chat-slots.js', './chat-state.js', './state.js', './viewport.js']);
  // Of the chat slots it only asks: the phone's chat view is the real sheet's to register.
  const fromSlots = /^import\s*\{([^}]*)\}\s*from\s*'\.\/chat-slots\.js';$/m.exec(src);
  assert.ok(fromSlots, 'it names what it takes from chat-slots.js');
  assert.deepEqual(fromSlots[1].split(',').map((s) => s.trim()).filter(Boolean), ['chatViews']);
  assert.doesNotMatch(code, /\bregister(?:ChatView|Composer|Approvals)\b/);
});

/* ── the seam: the real phone chat takes its place ───────────────────────── */

test('a chat view registered as \'sheet\' takes the stub off the page for good', async (t) => {
  await viewport(PHONE);
  // Any other chat view (the desktop dock is one) is not the phone's: the tab
  // stays. A test-only id, so no real view's registration is touched.
  const other = slots.registerChatView({ id: 'test-desktop-view', isOpen: () => false, escape: () => false, close() {} });
  await show(snapshot([conversation('c1', WORKING)]));
  assert.equal(stub.realPhoneChat(), false);
  assert.ok(pull() && !pull().hidden, 'a chat view other than the phone\'s leaves the phone tab alone');
  other.unregister();

  shell.press(tab());
  assert.equal(isOpen(), true, 'the note is open when the real chat arrives');
  const sheet = slots.registerChatView({ id: stub.PHONE_CHAT_VIEW, isOpen: () => false, escape: () => false, close() {} });
  t.after(() => sheet.unregister());
  assert.equal(stub.PHONE_CHAT_VIEW, 'sheet', 'the id the phone sheet registers under (§8.4)');
  assert.equal(stub.realPhoneChat(), true);

  // The registry announces nothing for a closed view; the stub's next draw sees it.
  await show(snapshot([conversation('c1', QUESTION)]));
  assert.equal(pull(), null, 'the tab is gone');
  assert.equal(shell.document.querySelector('.pull-stub, #chat-tab, #chat-sheet'), null, 'and its note with it');
  assert.equal(shell.document.querySelector('.popover.ps-note'), null, 'so no open panel is left for the dismiss layer');

  // For good: neither another draw nor another init brings it back.
  stub.initPullStub();
  await viewport(DESKTOP);
  await viewport(PHONE);
  await show(snapshot([conversation('c1', WAITING)]));
  assert.equal(shell.document.querySelector('.pull-stub'), null);
  stub.retirePullStub();   // and taking it down again is harmless
});
