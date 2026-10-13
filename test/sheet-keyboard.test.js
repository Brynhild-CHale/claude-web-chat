// The phone sheet over the on-screen keyboard (public/app/sheet-keyboard.js and
// U71's section of app.css), through the real shell
// (test-support/chrome-shell.js): design spec §8.5, §8.2, §7.13 and §7.1.
//
// main.js does not start the sheet or the keyboard until U73 wires them, so the
// boot's init does (spec §10.1); the composer is registered by main.js's
// tranche-4 inits. jsdom lays nothing out: #topbar and #bottombar get
// rectangles (shell.scrollMetrics) so the available height is 644 (full 622,
// half 341), and the keyboard is shell.setViewport({visualHeight, visualTop}),
// which moves window.visualViewport and fires its resize and scroll events. The
// real keyboard (iOS Safari portrait and landscape, a home-screen web app,
// Android Chrome) is the phone gate V39's, run by the maintainer.
//
// app.css is read the way test/chat-sheet.test.js reads it — its rules matched
// against the live DOM and cascaded as a browser does (a trimmed copy of that
// file's cascade: see the hand-off).
const test = require('node:test');
const { before, beforeEach, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');
const SRC = fs.readFileSync(path.join(REPO, 'public/app/sheet-keyboard.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8');

const PHONE = { width: 390, height: 844, visualHeight: 844, visualTop: 0 };
const DESKTOP = { width: 1280, height: 800, visualHeight: 800, visualTop: 0 };

let rev = 0;
function snapshot() {
  rev += 1;
  return {
    v: 1, enabled: true, now: Date.now(), rev, content: true, access: { level: 'local', remote: false },
    capabilities: { queue_message: true }, primary: 'c1', aggregate: { state: 'working' }, tasks: [], asks: [],
    conversations: [{ id: 'c1', rev: 1, title: 'Session c1', headless: false,
      live: { state: 'idle', since: Date.now() - 60000, last_activity_at: Date.now() - 1000 } }],
  };
}

let shell, W, doc, $, bus, sheet, kbd, model;
const scrolled = [];

const pull = () => $('chat-pull');
const tab = () => $('chat-tab');
const sh = () => $('chat-sheet');
const composerInput = () => $('chat-composer-input');
const prop = (name) => pull().style.getPropertyValue(name);

async function viewport(vp) {
  shell.setViewport(vp);
  await shell.tick();
}

function layout(avail = 644) {
  shell.scrollMetrics($('topbar'), { rect: { top: 0, height: 44, width: 390 } });
  shell.scrollMetrics($('bottombar'), { rect: { top: 44 + avail, height: 60, width: 390 } });
}

function blurAll() {
  const a = doc.activeElement;
  if (a && a !== doc.body && typeof a.blur === 'function') a.blur();
}

// The sheet open at half on Chat, the composer focused, the keyboard up.
async function keyboardUp({ visualHeight = 508, visualTop = 0 } = {}) {
  sheet.openSheet({ view: 'chat' });
  await shell.tick();
  assert.equal(sheet.sheetState().stop, 'half');
  const input = composerInput();
  assert.ok(input && sh().contains(input), 'the composer is in the sheet');
  input.focus();
  assert.equal(doc.activeElement, input);
  await viewport({ visualHeight, visualTop });
}

before(async () => {
  shell = await bootShell({
    viewport: PHONE,
    routes: { '/api/mirror': () => snapshot(), '/api/queue': () => ({ items: [], count: 0 }) },
    init: async (s) => {
      const ws = await s.importApp('ws.js');
      const { initChatState } = await s.importApp('chat-state.js');
      initChatState({ onFrame: ws.onFrame, onHello: ws.onHello });
      const { initChatSheet } = await s.importApp('chat-sheet.js');
      initChatSheet();
      const { initSheetKeyboard } = await s.importApp('sheet-keyboard.js');
      initSheetKeyboard();
    },
  });
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  sheet = await shell.importApp('chat-sheet.js');
  kbd = await shell.importApp('sheet-keyboard.js');
  model = await shell.importApp('sheet-model.js');
  W.scrollTo = (...args) => { scrolled.push(args); };
  // The store reads the mirror (a viewer who may queue messages has the composer).
  let read = false;
  const off = bus.on('mirror', (d) => { if (d && Array.isArray(d.what) && d.what.includes('all')) read = true; });
  try {
    await shell.frame(helloFrame());
    await waitUntil(() => read, { timeout: 5000, what: 'the store to read GET /api/mirror' });
  } finally { off(); }
  await shell.tick();
});

after(() => shell.restore());

// Every case starts on a phone with no keyboard, nothing focused, the sheet
// closed on Chat, avail 644.
beforeEach(async () => {
  blurAll();
  await viewport(PHONE);
  layout(644);
  sheet.closeSheet({ returnFocus: false });
  blurAll();
  await waitUntil(() => !(W.history.state && W.history.state.wcSheet), { timeout: 2000, what: 'the sheet\'s entry to go' });
  await shell.tick();
  assert.equal(pull().classList.contains('kb'), false, 'no case starts in keyboard mode');
  scrolled.length = 0;
});

// ── app.css, cascaded against the live DOM ───────────────────────────────────

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
const queries = new Map();
const holds = (media) => {
  if (!queries.has(media)) queries.set(media, W.matchMedia(media));
  return queries.get(media).matches;
};
function value(el, prop) {
  let win = null;
  for (const r of RULES) {
    if (r.media && !holds(r.media)) continue;
    let spec = null;
    for (const sel of selectors(r.selector)) {
      let hit = false;
      try { hit = el.matches(sel); } catch { /* jsdom cannot parse it: no match */ }
      if (hit) {
        const sp = specificity(sel);
        if (!spec || bySpec(sp, spec) > 0) spec = sp;
      }
    }
    if (!spec) continue;
    r.decls.forEach(([p, raw], pos) => {
      if (p !== prop) return;
      const important = /!\s*important$/.test(raw);
      const d = { value: raw.replace(/\s*!\s*important$/, ''), important, spec, at: r.at, pos };
      if (!win || (win.important !== d.important ? d.important : (bySpec(d.spec, win.spec) || d.at - win.at || d.pos - win.pos) > 0)) win = d;
    });
  }
  return win ? win.value : null;
}
// U71's own section of app.css, without its comments.
const FROM = CSS.indexOf('/* ── U71 · the keyboard');
const TO = CSS.indexOf('/* ── ', FROM + 1);
const SECTION = CSS.slice(FROM, TO).replace(/\/\*[\s\S]*?\*\//g, '');

/* ═════════════════════════════ keyboard mode ═══════════════════════════════ */

test('the composer focused and the keyboard up: .kb, the pull pinned to the visual viewport, and it follows a pan', async () => {
  await keyboardUp({ visualHeight: 508 });
  assert.ok(pull().classList.contains('kb'), 'keyboard mode');
  assert.equal(prop('--kb-top'), '8px', 'the visual viewport\'s top + 8');
  assert.equal(prop('--kb-h'), '500px', 'its height − 8');
  assert.equal($('stage').style.getPropertyValue('--kb-top'), '', 'never on #stage');
  assert.equal($('stage').style.getPropertyValue('--kb-h'), '');
  await viewport({ visualTop: 40 });
  assert.equal(prop('--kb-top'), '48px', 'a pan moves the pull with the visual viewport');
  assert.equal(prop('--kb-h'), '500px');
  assert.equal(sheet.sheetState().stop, 'half', 'the sheet\'s own stop is untouched while pinned');
});

test('the cascade under .kb: fixed at --kb-top and --kb-h, no transition; the tab and the badge hidden', async () => {
  await keyboardUp();
  assert.equal(value(pull(), 'position'), 'fixed');
  assert.equal(value(pull(), 'top'), 'var(--kb-top)');
  assert.equal(value(pull(), 'bottom'), 'auto');
  assert.equal(value(pull(), 'height'), 'var(--kb-h)');
  assert.equal(value(pull(), 'transition'), 'none');
  assert.equal(value(tab(), 'display'), 'none', 'the tab hides');
  assert.equal(value($('chat-badge'), 'display'), 'none', 'the badge hides');
  // And out of keyboard mode, U68's geometry stands.
  pull().classList.remove('kb');
  try {
    assert.equal(value(pull(), 'position'), 'absolute');
    assert.equal(value(pull(), 'height'), 'var(--sheet-h, 0px)');
    assert.notEqual(value(tab(), 'display'), 'none');
  } finally { pull().classList.add('kb'); }
});

test('a pointerdown on the tab in keyboard mode starts no drag', async () => {
  await keyboardUp();
  const h = sheet.sheetState().h;
  const pe = (type, init, target) => target.dispatchEvent(new W.PointerEvent(type,
    { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', button: 0, pointerId: 77, ...init }));
  pe('pointerdown', { clientX: 360, clientY: 700 }, tab());
  pe('pointermove', { clientX: 360, clientY: 600 }, doc);
  await shell.tick(5);
  assert.equal(pull().classList.contains('dragging'), false, 'no drag frame');
  pe('pointerup', { clientX: 360, clientY: 600 }, doc);
  await shell.tick(5);
  assert.equal(sheet.sheetState().h, h, 'the height is unchanged');
  assert.ok(pull().classList.contains('kb'));
});

test('focus gone and the keyboard down: .kb and both properties go, half comes back, and the panned page scrolls home once', async () => {
  await keyboardUp({ visualHeight: 508 });
  await viewport({ visualTop: 40 });
  const stops = [];
  const off = bus.on('sheet', (d) => stops.push(d.stop));
  try {
    composerInput().blur();
    await shell.tick();
    assert.ok(pull().classList.contains('kb'), 'the keyboard still animating away: still pinned');
    assert.equal(scrolled.length, 0);
    await viewport({ visualHeight: 844 });
    assert.equal(pull().classList.contains('kb'), false, 'keyboard mode left');
    assert.equal(prop('--kb-top'), '');
    assert.equal(prop('--kb-h'), '');
    assert.equal(sheet.sheetState().stop, 'half', 'the previous stop is back');
    assert.equal(sheet.sheetState().h, 341);
    assert.deepEqual(stops, ['half'], 'brought back through setStop');
    assert.deepEqual(scrolled, [[0, 0]], 'window.scrollTo(0, 0) once: visualTop was left at 40');
    await viewport({ visualTop: 0 });
    assert.equal(scrolled.length, 1, 'once');
  } finally { off(); }
});

test('a full sheet comes back full; an unpanned page is not scrolled', async () => {
  sheet.openSheet({ view: 'chat' });
  sheet.setStop(sheet.sheetState().stops.full);
  assert.equal(sheet.sheetState().stop, 'full');
  composerInput().focus();
  await viewport({ visualHeight: 500 });
  assert.ok(pull().classList.contains('kb'));
  composerInput().blur();
  await viewport({ visualHeight: 844 });
  assert.equal(pull().classList.contains('kb'), false);
  assert.equal(sheet.sheetState().stop, 'full');
  assert.equal(scrolled.length, 0, 'scrollY and visualTop were 0');
});

test('moving between two editables in the sheet keeps keyboard mode', async () => {
  await keyboardUp();
  const note = doc.createElement('input');
  note.type = 'text';
  $('sh-chat').append(note);
  try {
    note.focus();
    await shell.tick();
    assert.ok(pull().classList.contains('kb'));
    await viewport({ visualTop: 12 });
    assert.equal(prop('--kb-top'), '20px', 'still following the visual viewport');
  } finally { note.remove(); }
});

test('an inset of 60px (visualHeight 784) with the composer focused never enters keyboard mode', async () => {
  await keyboardUp({ visualHeight: 784 });
  assert.equal(model.keyboardInset({ innerHeight: 844, vvHeight: 784, vvOffsetTop: 0 }), 60);
  assert.equal(pull().classList.contains('kb'), false);
  assert.equal(prop('--kb-top'), '');
  assert.equal(sheet.sheetState().stop, 'half');
});

test('focus outside the sheet (a pane\'s input) with a 336px inset never enters keyboard mode', async () => {
  sheet.openSheet({ view: 'chat' });
  const paneInput = doc.createElement('input');
  doc.querySelector('.body').append(paneInput);
  try {
    paneInput.focus();
    assert.equal(doc.activeElement, paneInput);
    await viewport({ visualHeight: 508 });
    assert.equal(pull().classList.contains('kb'), false);
    await viewport({ visualTop: 30 });
    assert.equal(pull().classList.contains('kb'), false);
    assert.equal(prop('--kb-top'), '');
  } finally { paneInput.remove(); }
});

test('focus moved to a pane\'s input with the keyboard still up leaves keyboard mode, the stop back, and never scrolls', async () => {
  // iOS's previous/next arrows or a hardware Tab move focus out of the sheet
  // while the keyboard stays up; iOS has panned to show that field, and a
  // scrollTo(0, 0) would put it back under the keyboard.
  await keyboardUp({ visualHeight: 508, visualTop: 40 });
  assert.ok(pull().classList.contains('kb'));
  const paneInput = doc.createElement('input');
  doc.querySelector('.body').append(paneInput);
  try {
    paneInput.focus();
    assert.equal(doc.activeElement, paneInput);
    await shell.tick();
    assert.equal(pull().classList.contains('kb'), false, 'keyboard mode left with the keyboard still up');
    assert.equal(prop('--kb-top'), '');
    assert.equal(prop('--kb-h'), '');
    assert.equal(sheet.sheetState().stop, 'half', 'the previous stop is back');
    assert.deepEqual(scrolled, [], 'no scroll: the inset is still 296px');
  } finally { paneInput.remove(); }
});

test('a checkbox in the sheet is no editable: focusing it never enters keyboard mode', async () => {
  sheet.openSheet({ view: 'chat' });
  const box = doc.createElement('input');
  box.type = 'checkbox';
  $('sh-chat').append(box);
  try {
    box.focus();
    assert.equal(doc.activeElement, box);
    await viewport({ visualHeight: 508 });
    assert.equal(pull().classList.contains('kb'), false);
  } finally { box.remove(); }
});

test('a [contenteditable] in the sheet is an editable unless it says "false"', async () => {
  sheet.openSheet({ view: 'chat' });
  const off = doc.createElement('div');
  off.setAttribute('contenteditable', 'false');
  off.tabIndex = 0;
  $('sh-chat').append(off);
  try {
    off.focus();
    assert.equal(doc.activeElement, off);
    await viewport({ visualHeight: 508 });
    assert.equal(pull().classList.contains('kb'), false, 'contenteditable="false" raises no keyboard');
  } finally { off.remove(); }
  await viewport({ visualHeight: 844 });
  const on = doc.createElement('div');
  on.setAttribute('contenteditable', '');
  on.tabIndex = 0;
  $('sh-chat').append(on);
  try {
    on.focus();
    assert.equal(doc.activeElement, on);
    await viewport({ visualHeight: 508 });
    assert.ok(pull().classList.contains('kb'), 'an empty contenteditable is editable');
  } finally { on.remove(); }
});

test('closing the sheet in keyboard mode leaves it at once, with no scroll', async () => {
  await keyboardUp({ visualHeight: 508, visualTop: 40 });
  assert.ok(pull().classList.contains('kb'));
  sheet.closeSheet();
  assert.equal(pull().classList.contains('kb'), false, 'at once, before any frame');
  assert.equal(prop('--kb-top'), '');
  assert.equal(prop('--kb-h'), '');
  await shell.tick();
  assert.equal(sheet.sheetState().open, false, 'the close stands: no stop is brought back');
  assert.equal(scrolled.length, 0, 'no scroll');
});

test('the flip to 1280 wide leaves keyboard mode at once, with no scroll', async () => {
  await keyboardUp({ visualHeight: 508, visualTop: 40 });
  assert.ok(pull().classList.contains('kb'));
  shell.setViewport(DESKTOP);
  assert.equal(pull().classList.contains('kb'), false, 'at once');
  assert.equal(prop('--kb-top'), '');
  await shell.tick();
  assert.equal(sheet.sheetState().open, false);
  assert.equal(scrolled.length, 0, 'no scroll');
});

/* ═════════════════════════════ start and stop ══════════════════════════════ */

test('initSheetKeyboard({vv: null}): nothing happens and nothing throws on focus', async () => {
  kbd.stopSheetKeyboard();
  try {
    assert.doesNotThrow(() => kbd.initSheetKeyboard({ vv: null }));
    await keyboardUp({ visualHeight: 508 });
    await viewport({ visualTop: 40 });
    assert.equal(pull().classList.contains('kb'), false);
    assert.equal(prop('--kb-top'), '');
    composerInput().blur();
    await viewport({ visualHeight: 844, visualTop: 0 });
    assert.equal(scrolled.length, 0);
  } finally {
    kbd.stopSheetKeyboard();
    kbd.initSheetKeyboard();
  }
});

test('initSheetKeyboard twice adds no second listener (a resize writes once); stopSheetKeyboard removes them all', async () => {
  const vv = W.visualViewport;
  const added = [];
  const removed = [];
  const add = vv.addEventListener;
  const rm = vv.removeEventListener;
  vv.addEventListener = function (type, ...rest) { added.push(type); return add.call(this, type, ...rest); };
  vv.removeEventListener = function (type, ...rest) { removed.push(type); return rm.call(this, type, ...rest); };
  const style = pull().style;
  const set = style.setProperty;
  let writes = 0;
  style.setProperty = function (name, ...rest) { if (name === '--kb-top') writes += 1; return set.call(this, name, ...rest); };
  try {
    kbd.stopSheetKeyboard();
    assert.deepEqual(removed.sort(), ['resize', 'scroll'], 'stop removes both visual viewport listeners');
    kbd.initSheetKeyboard();
    kbd.initSheetKeyboard();
    assert.deepEqual(added.sort(), ['resize', 'scroll'], 'one of each, however often it is called');
    await keyboardUp({ visualHeight: 508 });
    assert.equal(writes, 1, 'the first frame writes once');
    writes = 0;
    W.visualViewport.dispatchEvent(new W.Event('resize'));
    await shell.tick();
    assert.equal(writes, 1, 'one resize, one write');
    // Focus cycles add nothing.
    for (let i = 0; i < 3; i++) { composerInput().blur(); composerInput().focus(); }
    await shell.tick();
    assert.equal(added.length, 2, 'never re-added per focus');
    // Stopped: keyboard mode goes, and the viewport is not listened to.
    kbd.stopSheetKeyboard();
    assert.equal(pull().classList.contains('kb'), false, 'stop leaves keyboard mode');
    writes = 0;
    await viewport({ visualTop: 20 });
    assert.equal(writes, 0, 'nothing listens once stopped');
    assert.equal(removed.length, 4);
  } finally {
    vv.addEventListener = add;
    vv.removeEventListener = rm;
    style.setProperty = set;
    kbd.stopSheetKeyboard();
    kbd.initSheetKeyboard();
  }
});

/* ═════════════════════════════ 16 px ═══════════════════════════════════════ */

test('every editable in the sheet is 16px: the composer, the rail\'s note field moved into the sheet, the inline editor', async () => {
  sheet.openSheet({ view: 'chat' });
  await shell.tick();
  assert.equal(value(composerInput(), 'font-size'), '16px', 'the composer\'s input');

  // The rail's note field: 16px once the rail sits in the sheet — where U70
  // (main.js) moved it at boot, into Tasks → Queue — and 14px at narrow widths
  // in the rail's own place in .body (the case takes it there and back).
  const rail = $('queue-rail');
  const add = $('rail-add');
  assert.ok(rail && add && add.classList.contains('rail-add'));
  assert.ok($('chat-sheet').contains(rail), 'the rail is in the sheet (U70)');
  assert.equal(value(add, 'font-size'), '16px', 'in the sheet the id-scoped rule wins');
  const parent = rail.parentNode;
  const next = rail.nextSibling;
  doc.querySelector('.body').append(rail);
  try {
    assert.equal(value(add, 'font-size'), '14px', 'outside the sheet the narrow .rail-add stands');
  } finally { parent.insertBefore(rail, next); }

  // U62's inline message editor: a textarea in a row's .cs-row-body.
  const row = doc.createElement('div');
  row.className = 'cs-row';
  row.dataset.density = 'touch';
  row.innerHTML = '<div class="cs-row-body"><div class="cs-edit"><textarea class="cs-edit-text"></textarea></div></div>';
  $('sh-chat').append(row);
  try {
    assert.equal(value(row.querySelector('textarea'), 'font-size'), '16px', 'the inline editor\'s textarea');
  } finally { row.remove(); }

  // The list, edge by edge.
  const probe = (html) => {
    const d = doc.createElement('div');
    d.innerHTML = html;
    $('sh-chat').append(d);
    try { return value(d.firstElementChild, 'font-size'); } finally { d.remove(); }
  };
  assert.equal(probe('<input type="search">'), '16px');
  assert.equal(probe('<select></select>'), '16px');
  assert.equal(probe('<div contenteditable="true"></div>'), '16px');
  assert.equal(probe('<div contenteditable=""></div>'), '16px');
  for (const t of ['checkbox', 'radio', 'range', 'button', 'submit', 'file']) {
    assert.notEqual(probe(`<input type="${t}">`), '16px', `an input of type ${t} is no editable`);
  }
  assert.notEqual(probe('<div contenteditable="false"></div>'), '16px');
});

/* ═════════════════════════════ the source ══════════════════════════════════ */

test('the source and the CSS: the seams it may use, and none it may not', () => {
  const code = SRC.replace(/\/\/[^\n]*/g, '');
  assert.match(code, /from '\.\/sheet-model\.js'/, 'its numbers are sheet-model.js\'s');
  assert.match(code, /registerSheetView\(KEYBOARD_VIEW/, 'it plugs in through registerSheetView');
  assert.equal(kbd.KEYBOARD_VIEW, 'keyboard');
  assert.doesNotMatch(code, /matchMedia/, 'never asks a media query');
  assert.doesNotMatch(code, /window\.addEventListener/, 'no window listener (U68 re-measures on resize)');
  assert.doesNotMatch(code, /'stage'|#stage/, 'nothing on #stage');
  assert.doesNotMatch(code, /\b80\b|\b8px\b/, 'no number of its own: KB_MIN and KB_INSET are sheet-model.js\'s');
  assert.equal(model.KB_MIN, 80);
  assert.equal(model.KB_INSET, 8);
  // The viewport meta is not changed (interactive-widget would change every pane input).
  const meta = /<meta name="viewport" content="([^"]*)">/.exec(INDEX);
  assert.ok(meta);
  assert.equal(meta[1], 'width=device-width, initial-scale=1, viewport-fit=cover');
  assert.doesNotMatch(INDEX, /interactive-widget/);
  // U71's section: tokens only, nothing on #stage, no filters.
  assert.match(SECTION, /\.chat-pull\.kb\s*\{/);
  assert.doesNotMatch(SECTION, /#stage|z-index|filter|#[0-9a-fA-F]{3,8}\b/);
});
