// The phone's pull (public/app/chat-sheet.js, public/app/sheet-drag.js, U68's
// section of app.css), through the real shell (test-support/chrome-shell.js):
// design spec §8.1–§8.4, §8.8, §7.2, §7.8 and §7.9, ruling B1 (a) (the template
// the sheet stamps in), B2 (a) (the sheet's Stop) and B-defaults (a) (M on a
// narrow window that is not a phone).
//
// main.js starts the sheet (U73); the boot's init calls initChatSheet again,
// which adds nothing (it is idempotent). jsdom lays nothing out: #topbar and
// #bottombar get rectangles (shell.scrollMetrics) so the available height is
// 644 (full 622, half 341), or 500 (full 478, half 265) where a case needs
// half under 320; app.css is read as a browser would — its rules matched
// against the live DOM and cascaded.
const test = require('node:test');
const { before, beforeEach, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { finalFixture } = require('../test-support/final-fixture');

const REPO = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');
const SHEET_SRC = fs.readFileSync(path.join(REPO, 'public/app/chat-sheet.js'), 'utf8');
const DRAG_SRC = fs.readFileSync(path.join(REPO, 'public/app/sheet-drag.js'), 'utf8');

const PHONE = { width: 390, height: 844 };
const NARROW = { width: 700, height: 900 };   // a terminal beside a browser: narrow, not a phone
const DESKTOP = { width: 1280, height: 800 };

// ── the store's answers ──────────────────────────────────────────────────────

let rev = 0;
function snapshot(conversations, { level = 'local', primary, tasks = [], asks = [], caps = {} } = {}) {
  rev += 1;
  return {
    v: 1, enabled: true, now: Date.now(), rev, content: true, access: { level, remote: false }, capabilities: caps,
    primary: primary !== undefined ? primary : (conversations[0] ? conversations[0].id : null),
    aggregate: { state: conversations.length ? 'working' : 'none' }, conversations, tasks, asks,
  };
}
const conversation = (id, live, extra = {}) => ({
  id, rev: 1, title: `Session ${id}`, headless: false,
  live: { since: Date.now() - 60000, last_activity_at: Date.now() - 1000, ...live }, ...extra,
});
const at = (ms) => Date.now() - ms;
const WORKING = { state: 'working', step: { kind: 'Edit', tool: 'Edit', label: 'Edit · paths.js', started_at: at(12000) } };
const QUIET = { ...WORKING, quiet: { since: at(240000) } };
const QUESTION = { state: 'question', waiting: { kind: 'question', summary: 'Keep the 56px rail?' } };
const WAITING = { state: 'waiting', waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(npm test)' } };
const IDLE = { state: 'idle', last_turn: { id: 't1', outcome: 'done', ended_at: at(240000), reply_preview: 'Done.' } };
const SUSPENDED = { state: 'suspended' };
const ASK = { id: 'ask-1', conversation_id: 'c1', kind: 'permission', state: 'pending', answerable: true,
  tool_name: 'Bash', summary: 'Bash(npm test)', created_at: at(2000) };

let mirrorBody = snapshot([]);
let queueBody = { items: [], count: 0 };

let shell, W, doc, $, bus, slots, sheet, drag, model, panel, viewportMod;

const pull = () => $('chat-pull');
const tab = () => $('chat-tab');
const sh = () => $('chat-sheet');
const scrim = () => $('chat-scrim');
const badge = () => $('chat-badge');
const label = () => tab().getAttribute('aria-label');

async function show(body) {
  mirrorBody = body;
  let read = false;
  const off = bus.on('mirror', (d) => { if (d && Array.isArray(d.what) && d.what.includes('all')) read = true; });
  try {
    await shell.frame(helloFrame());
    await waitUntil(() => read, { timeout: 5000, what: 'the store to read GET /api/mirror' });
  } finally { off(); }
  await shell.tick();   // the coalesced frame draws
}

async function viewport(vp) {
  shell.setViewport(vp);
  await shell.tick();
}

// #topbar's bottom at 44, #bottombar's top at 44 + avail.
function layout(avail = 644) {
  shell.scrollMetrics($('topbar'), { rect: { top: 0, height: 44, width: 390 } });
  shell.scrollMetrics($('bottombar'), { rect: { top: 44 + avail, height: 60, width: 390 } });
}

const sheetEvents = [];
function lastSheet() { return sheetEvents[sheetEvents.length - 1]; }

before(async () => {
  shell = await bootShell({
    viewport: PHONE,
    routes: { '/api/mirror': () => mirrorBody, '/api/queue': () => queueBody },
    init: async (s) => {
      const ws = await s.importApp('ws.js');
      const { initChatState } = await s.importApp('chat-state.js');
      initChatState({ onFrame: ws.onFrame, onHello: ws.onHello });
      const { initChatSheet } = await s.importApp('chat-sheet.js');
      initChatSheet();
    },
  });
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  slots = await shell.importApp('chat-slots.js');
  sheet = await shell.importApp('chat-sheet.js');
  drag = await shell.importApp('sheet-drag.js');
  model = await shell.importApp('sheet-model.js');
  panel = await shell.importApp('chat-panel.js');
  viewportMod = await shell.importApp('viewport.js');
  bus.on('sheet', (d) => sheetEvents.push(d));
});

after(() => shell.restore());

// Every case starts on a phone, the sheet closed on Chat at its root, avail 644.
beforeEach(async () => {
  if (W.innerWidth !== PHONE.width || W.innerHeight !== PHONE.height) await viewport(PHONE);
  layout(644);
  sheet.closeSheet({ returnFocus: false });
  while (sheet.popPage('tasks'));
  while (sheet.popPage('chat'));
  if (sheet.sheetState().view !== 'chat') shell.click($('sh-tab-chat'));
  // A close's history.back() lands (jsdom sends popstate later).
  await waitUntil(() => !(W.history.state && W.history.state.wcSheet), { timeout: 2000, what: 'the sheet\'s entry to go' });
  await shell.tick();
  sheetEvents.length = 0;
});

// ── app.css, cascaded against the live DOM ──

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
const SHEET_RULES = parseRules(BARE);
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
function cascade(el, props, rules = SHEET_RULES) {
  let win = null;
  for (const r of rules) {
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
const value = (el, prop) => { const d = cascade(el, [prop]); return d ? d.value : null; };
function inherited(el, name) {
  for (let n = el; n; n = n.parentElement) {
    const d = cascade(n, [name]);
    if (d) return d.value;
  }
  return null;
}
// U68's own section of app.css.
const FROM = CSS.indexOf('/* ── U68 · the pull and its drag');
const TO = CSS.indexOf('/* ── ', FROM + 1);
const SECTION = CSS.slice(FROM, TO).replace(/\/\*[\s\S]*?\*\//g, '');   // its rules, without its comments

// ── pointer gestures on the tab ──────────────────────────────────────────────

let pid = 10;
function pe(type, init, target = tab()) {
  const e = new W.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', button: 0, ...init });
  target.dispatchEvent(e);
  return e;
}
// A drag of the tab by (dx, dy), in `steps` moves, with a frame between them.
async function dragBy(dx, dy, { steps = 3, end = 'pointerup', id = ++pid } = {}) {
  const x0 = 360;
  const y0 = 700;
  pe('pointerdown', { pointerId: id, clientX: x0, clientY: y0 });
  for (let i = 1; i <= steps; i++) {
    pe('pointermove', { pointerId: id, clientX: x0 + (dx * i) / steps, clientY: y0 + (dy * i) / steps }, doc);
    await shell.tick(5);
  }
  pe(end, { pointerId: id, clientX: x0 + dx, clientY: y0 + dy }, end === 'lostpointercapture' ? tab() : doc);
  await shell.tick(5);
}
// The click a browser sends after a pointerup on the tab.
function clickTab() {
  const e = new W.MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
  tab().dispatchEvent(e);
  return e;
}

/* ═════════════════════════════ stamping ════════════════════════════════════ */

test('stamping: #chat-scrim then #chat-pull, direct children of #stage between the pull host\'s markers; the stand-in gone', () => {
  const stage = $('stage');
  assert.equal(scrim().parentElement, stage);
  assert.equal(pull().parentElement, stage);
  assert.equal(scrim().nextElementSibling, pull(), 'the scrim first, then the pull');
  const marks = {};
  for (const n of stage.childNodes) {
    const m = n.nodeType === W.Node.COMMENT_NODE && /^\s*(\/?)chat-host:pull\b/.exec(n.data);
    if (m) marks[m[1] ? 'end' : 'start'] = n;
  }
  const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & W.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(marks.start && marks.end, 'both markers kept');
  assert.ok(follows(marks.start, scrim()) && follows(pull(), marks.end), 'between the markers');
  for (const id of ['chat-scrim', 'chat-pull', 'chat-badge', 'chat-tab', 'chat-sheet', 'sh-tab-chat', 'sh-tab-tasks',
    'sh-chat', 'sh-tasks', 'chat-live']) {
    assert.equal(doc.querySelectorAll(`[id="${id}"]`).length, 1, `#${id} appears once`);
  }
  assert.equal(doc.querySelector('.pull-stub'), null, 'the stand-in\'s element is gone');
  assert.ok(doc.querySelector('template.chat-pull-tpl'), 'the template stays, the markup\'s home');
  assert.equal(pull().dataset.stop, 'closed');
  assert.ok(sh().hasAttribute('inert'), 'a closed sheet is inert');
});

test('a second initChatSheet adds nothing', () => {
  const before = $('stage').children.length;
  const views = slots.chatViews().length;
  sheet.initChatSheet();
  assert.equal($('stage').children.length, before);
  assert.equal(slots.chatViews().length, views);
  assert.equal(doc.querySelectorAll('#chat-pull').length, 1);
});

/* ═════════════════════════════ visibility ══════════════════════════════════ */

test('visibility from app.css alone: shown at 390×844 and at 700×900, hidden at 1280×800', async () => {
  assert.equal(value(pull(), 'display'), 'block', 'a phone');
  assert.equal(value(scrim(), 'display'), 'block');
  await viewport(NARROW);
  assert.equal(viewportMod.isPhone(), false, '700×900 is no phone');
  assert.equal(value(pull(), 'display'), 'block', 'a narrow window that is not a phone');
  assert.equal(value(scrim(), 'display'), 'block');
  await viewport(DESKTOP);
  assert.equal(value(pull(), 'display'), 'none', 'a desktop');
  assert.equal(value(scrim(), 'display'), 'none');
});

test('the CSS: tokens only, the geometry of §8.2, no filters, transitions off under reduced motion', async () => {
  assert.doesNotMatch(SECTION, /#[0-9a-fA-F]{3,8}\b/, 'no hex');
  assert.doesNotMatch(SECTION, /backdrop-filter|(^|[^-])filter\s*:|mix-blend-mode/m, 'no filter, backdrop-filter or blend');
  assert.doesNotMatch(SHEET_SRC + DRAG_SRC, /matchMedia/, 'no media query in script');
  const p = pull();
  assert.equal(value(p, 'position'), 'absolute');
  assert.equal(value(p, 'bottom'), 'var(--bb-h)');
  assert.equal(value(p, 'height'), 'var(--sheet-h, 0px)');
  assert.equal(value(p, 'z-index'), 'var(--z-chat)');
  assert.equal(value(p, 'transition'), 'height .32s cubic-bezier(.3,.7,.2,1)');
  p.classList.add('dragging');
  assert.equal(value(p, 'transition'), 'none', '.dragging has no transition');
  p.classList.remove('dragging');
  assert.equal(value(tab(), 'touch-action'), 'none', 'the tab alone takes touch');
  // U68's own geometry, before U72's dock (main.js sets data-dock at boot):
  // without data-dock this section's rules stand (test/tab-dock.test.js has
  // the docks).
  const dockAttr = p.dataset.dock;
  delete p.dataset.dock;
  try {
    assert.equal(value(tab(), 'left'), '100%');
    assert.equal(value(tab(), 'transform'), 'translateX(-100%)');
    assert.equal(value(tab(), 'height'), '23px');
    assert.equal(value(tab(), 'border-radius'), '10px 0 0 0');
    assert.equal(value(badge(), 'right'), 'calc(var(--tab-w) + 4px)');
  } finally { if (dockAttr !== undefined) p.dataset.dock = dockAttr; }
  assert.equal(value(scrim(), 'pointer-events'), 'none');
  assert.equal(value(scrim(), 'top'), 'var(--chat-top, 0px)');
  scrim().classList.add('on');
  assert.equal(value(scrim(), 'pointer-events'), 'auto', 'deviation 13: an open scrim takes the tap');
  assert.equal(value(scrim(), 'touch-action'), 'none');
  scrim().classList.remove('on');
  for (const el of [$('sh-chat'), $('sh-tasks')]) assert.equal(value(el, 'overscroll-behavior'), 'contain');
  assert.equal(value($('sh-tab-chat'), 'height'), '36px', 'the segments are 36px');
  await viewport({ ...PHONE, reducedMotion: true });
  assert.equal(value(p, 'transition'), 'none');
  assert.equal(value(tab(), 'transition'), 'none');
  assert.equal(value(p.querySelector('.ct-bar'), 'animation'), 'none');
  await viewport({ ...PHONE, reducedMotion: false });
});

/* ═════════════════════════════ setStop ═════════════════════════════════════ */

test('setStop writes the pull and the scrim, never #stage; data-stop, open, aria-expanded, the scrim\'s on; bus sheet', async () => {
  const stage = $('stage');
  const stageStyle = stage.getAttribute('style');
  sheet.openSheet();
  let s = sheet.sheetState();
  assert.equal(s.h, 341);
  assert.equal(pull().style.getPropertyValue('--sheet-h'), '341px');
  assert.equal(pull().style.getPropertyValue('--sheet-frac'), String(Math.round((341 / 622) * 1000) / 1000));
  assert.equal(scrim().style.getPropertyValue('--sheet-frac'), pull().style.getPropertyValue('--sheet-frac'));
  assert.equal(scrim().style.getPropertyValue('--chat-top'), '44px');
  assert.equal(pull().dataset.stop, 'half');
  assert.ok(pull().classList.contains('open'));
  assert.equal(tab().getAttribute('aria-expanded'), 'true');
  assert.ok(scrim().classList.contains('on'));
  assert.equal(sh().hasAttribute('inert'), false);
  assert.deepEqual(lastSheet(), { open: true, stop: 'half', view: 'chat', page: null });
  sheet.setStop(622);
  assert.equal(pull().dataset.stop, 'full');
  sheet.setStop(500);
  assert.equal(pull().dataset.stop, 'between');
  s = sheet.setStop(0);
  assert.equal(s.open, false);
  assert.equal(pull().dataset.stop, 'closed');
  assert.equal(pull().classList.contains('open'), false);
  assert.equal(tab().getAttribute('aria-expanded'), 'false');
  assert.equal(scrim().classList.contains('on'), false);
  assert.deepEqual(lastSheet(), { open: false, stop: 'closed', view: 'chat', page: null });
  assert.equal(stage.getAttribute('style'), stageStyle, 'nothing written on #stage');
  assert.equal(stage.style.length, 0);
});

test('closing sets inert with focus moved back to the tab first', async () => {
  shell.click(tab());
  assert.equal(doc.activeElement, $('sh-tab-chat'));
  shell.click(tab());
  assert.ok(sh().hasAttribute('inert'));
  assert.equal(doc.activeElement, tab(), 'focus came back to the tab');
});

/* ═════════════════════════════ opening ═════════════════════════════════════ */

test('a tab click opens half (341) on Chat and focuses #sh-tab-chat; a second click closes; Enter and Space open', async () => {
  shell.click(tab());
  assert.equal(sheet.sheetState().h, 341);
  assert.equal(sheet.sheetState().view, 'chat');
  assert.equal(doc.activeElement, $('sh-tab-chat'), 'the selected segment, never an input');
  shell.click(tab());
  assert.equal(sheet.sheetState().open, false);
  const enter = shell.key('Enter', { target: tab() });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(sheet.sheetState().h, 341, 'Enter opens');
  shell.key('Enter', { target: tab() });
  assert.equal(sheet.sheetState().open, false, 'and closes');
  shell.key(' ', { target: tab() });
  assert.equal(sheet.sheetState().h, 341, 'Space opens');
});

test('with an ask pending at avail 500 (half 265) a tap opens full; at avail 644 it opens half', async () => {
  await show(snapshot([conversation('c1', WAITING)], { asks: [ASK] }));
  layout(500);
  shell.click(tab());
  assert.equal(sheet.sheetState().h, 478, 'full');
  assert.equal(pull().dataset.stop, 'full');
  sheet.closeSheet();
  layout(644);
  shell.click(tab());
  assert.equal(sheet.sheetState().h, 341, 'half is tall enough for the card and the composer');
  sheet.closeSheet();
  await show(snapshot([conversation('c1', IDLE)]));
});

// §8.2: avail is re-measured on resize (the update banner can push the topbar
// down), and an open sheet keeps its named stop across it.
test('a re-measure keeps the named stop: half → the new half, or full once half has gone; full → the new full', async () => {
  const resize = async (avail) => { layout(avail); W.dispatchEvent(new W.Event('resize')); await shell.tick(); };
  sheet.openSheet();
  assert.equal(sheet.sheetState().h, 341);
  await resize(500);
  assert.equal(sheet.sheetState().h, 265, 'half → the new half');
  assert.equal(pull().dataset.stop, 'half');
  await resize(300);
  assert.equal(sheet.sheetState().stops.half, null, 'a short sheet has no half');
  assert.equal(sheet.sheetState().h, 278, 'half went: full');
  assert.equal(pull().dataset.stop, 'full');
  await resize(644);
  assert.equal(sheet.sheetState().h, 622, 'full → the new full');
  assert.equal(pull().dataset.stop, 'full');
  sheet.closeSheet({ returnFocus: false });
  await resize(500);
  assert.equal(sheet.sheetState().open, false, 'a closed sheet stays closed');
  assert.equal(pull().dataset.stop, 'closed');
});

test('opening a closed sheet closes the other panels (wc:close-popovers)', async () => {
  let seen = 0;
  const fn = () => { seen += 1; };
  W.addEventListener('wc:close-popovers', fn);
  try {
    sheet.openSheet();
    sheet.openSheet();
    assert.equal(seen, 1, 'once, on the open');
  } finally { W.removeEventListener('wc:close-popovers', fn); }
});

/* ═════════════════════════════ the drag ════════════════════════════════════ */

test('drag: 45px up from closed → half; 42px down from full → half; 30px from half → half; .dragging only during', async () => {
  let during = false;
  const off = bus.on('sheet', () => {});
  await (async () => {
    pe('pointerdown', { pointerId: 50, clientX: 360, clientY: 700 });
    pe('pointermove', { pointerId: 50, clientX: 360, clientY: 655 }, doc);
    await shell.tick(5);
    during = pull().classList.contains('dragging');
    assert.equal(pull().style.getPropertyValue('--sheet-h'), '45px', 'the finger moves the sheet');
    pe('pointerup', { pointerId: 50, clientX: 360, clientY: 655 }, doc);
    await shell.tick(5);
  })();
  off();
  assert.ok(during, '.dragging during the move');
  assert.equal(pull().classList.contains('dragging'), false, 'and gone after');
  assert.equal(sheet.sheetState().h, 341, '45px up from closed opens half');
  assert.equal(clickTab().defaultPrevented, true, 'the click that follows a drag is swallowed');
  assert.equal(sheet.sheetState().open, true, 'and toggles nothing');
  sheet.setStop(622);
  await dragBy(0, 42);
  assert.equal(sheet.sheetState().h, 341, '42px down from full drops to half');
  clickTab();
  await dragBy(0, -30);
  assert.equal(sheet.sheetState().h, 341, '30px from half stays');
  clickTab();
  await dragBy(0, 30);
  assert.equal(sheet.sheetState().h, 341, '30px down from half stays');
  clickTab();
});

test('drag: one --sheet-h write per frame', async () => {
  const writes = [];
  const orig = pull().style.setProperty;
  pull().style.setProperty = function setProperty(k, v, p) { if (k === '--sheet-h') writes.push(v); return orig.call(this, k, v, p); };
  try {
    pe('pointerdown', { pointerId: 60, clientX: 360, clientY: 700 });
    for (let y = 690; y >= 600; y -= 10) pe('pointermove', { pointerId: 60, clientX: 360, clientY: y }, doc);
    assert.equal(writes.length, 0, 'nothing before the frame');
    await shell.tick(5);
    assert.equal(writes.length, 1, 'ten moves, one frame, one write');
    assert.equal(writes[0], '100px', 'the latest height');
    pe('pointerup', { pointerId: 60, clientX: 360, clientY: 600 }, doc);
    await shell.tick(5);
  } finally { delete pull().style.setProperty; }
  clickTab();
  assert.equal(sheet.sheetState().h, 341);
});

test('a tap\'s click is not swallowed: it toggles', async () => {
  pe('pointerdown', { pointerId: 70, clientX: 360, clientY: 700 });
  pe('pointerup', { pointerId: 70, clientX: 362, clientY: 698 }, doc);
  const e = clickTab();
  assert.equal(e.defaultPrevented, false);
  assert.equal(sheet.sheetState().h, 341, 'the tap opened half');
});

test('pointercancel and lostpointercapture settle to the nearest stop and are never a tap', async () => {
  await dragBy(0, -200, { end: 'pointercancel' });
  assert.equal(sheet.sheetState().h, 341, '200 up from closed is nearest half (no push on a cancel)');
  assert.equal(clickTab().defaultPrevented, true, 'the next click is swallowed too');
  assert.equal(sheet.sheetState().h, 341);
  await dragBy(0, 3, { steps: 1, end: 'pointercancel' });
  assert.equal(sheet.sheetState().h, 341, 'a cancelled still pointer settles where it was');
  assert.equal(clickTab().defaultPrevented, true, 'and is not a tap');
  await dragBy(0, -250, { end: 'lostpointercapture' });
  assert.equal(sheet.sheetState().h, 622, 'lostpointercapture: the nearest stop');
  clickTab();
});

test('a second pointer is ignored while the first drags', async () => {
  pe('pointerdown', { pointerId: 80, clientX: 360, clientY: 700 });
  pe('pointerdown', { pointerId: 81, clientX: 100, clientY: 700 });
  pe('pointermove', { pointerId: 81, clientX: 100, clientY: 300 }, doc);
  pe('pointermove', { pointerId: 80, clientX: 360, clientY: 650 }, doc);
  await shell.tick(5);
  assert.equal(pull().style.getPropertyValue('--sheet-h'), '50px', 'only the first pointer moves it');
  pe('pointerup', { pointerId: 81, clientX: 100, clientY: 300 }, doc);
  assert.ok(pull().classList.contains('dragging'), 'the second pointer\'s release ends nothing');
  pe('pointerup', { pointerId: 80, clientX: 360, clientY: 650 }, doc);
  await shell.tick(5);
  clickTab();
  assert.equal(sheet.sheetState().h, 341);
});

test('sideways: no dock handler moves nothing; with one and the sheet closed it gets begin/move/end; open, never', async () => {
  await dragBy(20, 0);
  assert.equal(sheet.sheetState().h, 0, 'a 20px sideways swipe with no handler: nothing');
  assert.equal(pull().style.getPropertyValue('--sheet-h'), '0px');
  clickTab();
  assert.equal(sheet.sheetState().open, false, 'and its click is not a tap');
  const calls = [];
  const off = drag.setDockHandler({
    begin: (d) => calls.push(['begin', d]), move: (d) => calls.push(['move', d]), end: (d) => calls.push(['end', d]),
  });
  try {
    await dragBy(-120, 4, { steps: 2 });
    assert.deepEqual(calls.map((c) => c[0]), ['begin', 'move', 'move', 'end']);
    assert.equal(calls[0][1].x, 360);
    assert.equal(calls[3][1].dx, -120);
    assert.equal(calls[3][1].cancelled, false);
    assert.equal(sheet.sheetState().h, 0, 'the sheet did not move');
    clickTab();
    calls.length = 0;
    sheet.openSheet();
    await dragBy(-120, 4, { steps: 2 });
    assert.deepEqual(calls, [], 'an open sheet never docks');
    clickTab();
  } finally { off(); }
  assert.equal(drag.dockHandler(), null, 'unregistered');
  const a = { begin() {}, move() {}, end() {} };
  const b = { begin() {}, move() {}, end() {} };
  const offA = drag.setDockHandler(a);
  const offB = drag.setDockHandler(b);
  assert.equal(drag.dockHandler(), b, 'a second registration replaces the first');
  offA();
  assert.equal(drag.dockHandler(), b, 'and the first one\'s unregister does nothing');
  offB();
});

test('ArrowUp and ArrowDown on the tab step closed → half → full and back', () => {
  const up = shell.key('ArrowUp', { target: tab() });
  assert.equal(up.defaultPrevented, true);
  assert.equal(sheet.sheetState().h, 341);
  shell.key('ArrowUp', { target: tab() });
  assert.equal(sheet.sheetState().h, 622);
  shell.key('ArrowUp', { target: tab() });
  assert.equal(sheet.sheetState().h, 622, 'held at the top');
  shell.key('ArrowDown', { target: tab() });
  assert.equal(sheet.sheetState().h, 341);
  shell.key('ArrowDown', { target: tab() });
  assert.equal(sheet.sheetState().h, 0);
});

test('after 30 drags a pointermove dispatched on document reaches no handler of the drag', async () => {
  for (let i = 0; i < 30; i++) {
    await dragBy(0, i % 2 ? 60 : -60, { steps: 1 });
    clickTab();
  }
  sheet.closeSheet();
  const before = pull().style.getPropertyValue('--sheet-h');
  const writes = [];
  const off = bus.on('sheet', (d) => writes.push(d));
  pe('pointermove', { pointerId: pid, clientX: 360, clientY: 100 }, doc);
  pe('pointerup', { pointerId: pid, clientX: 360, clientY: 100 }, doc);
  await shell.tick(5);
  off();
  assert.equal(pull().style.getPropertyValue('--sheet-h'), before);
  assert.deepEqual(writes, [], 'no handler left on the document');
  assert.equal(pull().classList.contains('dragging'), false);
});

test('sheet-drag: detach() leaves nothing behind on its handle', async () => {
  const el = doc.createElement('button');
  doc.body.append(el);
  const settles = [];
  const detach = drag.attachSheetDrag(el, {
    stops: () => model.computeStops(644), height: () => 0, enabled: () => true, closed: () => true,
    onMove: () => {}, onSettle: (px) => settles.push(px),
  });
  el.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.deepEqual(settles, [341]);
  detach();
  el.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  el.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, pointerId: 99, clientX: 0, clientY: 500 }));
  doc.dispatchEvent(new W.PointerEvent('pointermove', { bubbles: true, pointerId: 99, clientX: 0, clientY: 300 }));
  doc.dispatchEvent(new W.PointerEvent('pointerup', { bubbles: true, pointerId: 99, clientX: 0, clientY: 300 }));
  await shell.tick(5);
  assert.deepEqual(settles, [341], 'deaf once detached');
  el.remove();
  assert.throws(() => drag.attachSheetDrag(el, {}), TypeError);
  assert.throws(() => drag.setDockHandler({ begin() {} }), TypeError);
});

test('dragging is off while the pull has .kb (the keyboard, U71)', async () => {
  pull().classList.add('kb');
  try {
    await dragBy(0, -100);
    assert.equal(sheet.sheetState().h, 0);
    shell.key('ArrowUp', { target: tab() });
    assert.equal(sheet.sheetState().h, 0);
  } finally { pull().classList.remove('kb'); }
});

/* ═════════════════════════════ closing ═════════════════════════════════════ */

test('closing paths: the scrim, the panel\'s Close, Escape, and a flip to wide (at once, the dock left closed)', async () => {
  sheet.openSheet();
  shell.click(scrim());
  assert.equal(sheet.sheetState().open, false, 'a scrim click');

  sheet.openSheet();
  const p = panel.panelEl();
  assert.ok($('sh-chat').contains(p), 'the panel is in the sheet');
  shell.click(p.querySelector('.cp-close'));
  assert.equal(sheet.sheetState().open, false, 'the panel\'s Close');

  sheet.openSheet();
  shell.key('Escape');
  assert.equal(sheet.sheetState().open, false, 'Escape (shell.js → escapeChatViews)');

  sheet.openSheet();
  sheetEvents.length = 0;
  const seen = [];
  const mo = new W.MutationObserver((recs) => { for (const r of recs) if (r.attributeName === 'class') seen.push(r.oldValue || ''); });
  mo.observe(pull(), { attributes: true, attributeOldValue: true });
  await viewport(DESKTOP);
  mo.disconnect();
  assert.equal(sheet.sheetState().open, false, 'a flip to 1280 wide');
  assert.ok(seen.some((c) => /\bdragging\b/.test(c)), 'written under .dragging, so nothing animates');
  assert.equal(pull().classList.contains('dragging'), false, 'and no .dragging left');
  assert.ok(sheetEvents.some((d) => d.open === false), 'sheet {open: false}');
  const dock = $('chat-dock');
  assert.ok(dock.classList.contains('hidden'), 'the dock stays closed');
});

/* ═════════════════════════════ the chat view ═══════════════════════════════ */

test('the chat view: posture full while open, status after; chat:host moves the panel in once (variant sheet, a 16px input)', async () => {
  assert.ok(slots.chatViews().some((v) => v.id === 'sheet'));
  const hosts = [];
  const off = bus.on('chat:host', (d) => hosts.push(d));
  try {
    // Wherever the panel was, the dock's body takes it back first; a viewer who
    // may queue messages has the composer's input.
    await show(snapshot([conversation('c1', IDLE)], { caps: { queue_message: true } }));
    bus.emit('chat:host', { host: $('cd-body'), variant: 'desktop' });
    hosts.length = 0;
    sheet.openSheet();
    assert.equal(slots.posture(), 'full');
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].host, $('sh-chat'));
    assert.equal(hosts[0].variant, 'sheet');
    const p = panel.panelEl();
    assert.equal(p.dataset.variant, 'sheet');
    assert.equal(p.querySelector('.cp-close').textContent, 'Close');
    await shell.tick();
    const input = $('chat-composer-input');
    assert.ok(input && $('sh-chat').contains(input), 'the composer came with the panel');
    assert.equal(value(input, 'font-size'), '16px', 'the composer\'s input is 16px in the sheet');
    sheet.closeSheet();
    assert.equal(slots.posture(), 'status');
    sheet.openSheet();
    assert.equal(hosts.length, 1, 'a second open announces nothing');
    sheet.closeSheet();
  } finally {
    off();
    await show(snapshot([conversation('c1', IDLE)]));
  }
});

test('chat:open while narrow opens the sheet on Chat (awaiting at openStopFor) and the dock stays closed; wide, ignored', async () => {
  await show(snapshot([conversation('c1', WAITING)], { asks: [ASK] }));
  layout(500);
  bus.emit('chat:open', { view: 'awaiting', id: 'ask-1' });
  assert.equal(sheet.sheetState().h, 478, 'awaiting with half under 320: full');
  assert.equal(sheet.sheetState().view, 'chat');
  assert.ok($('chat-dock').classList.contains('hidden'), 'the dock stays closed');
  sheet.closeSheet();
  layout(644);
  bus.emit('chat:open', { view: 'task', id: 'b1' });
  assert.equal(sheet.sheetState().h, 341, 'a task: at least half');
  shell.click($('sh-tab-tasks'));
  bus.emit('chat:open', { view: 'chat' });
  assert.equal(sheet.sheetState().view, 'chat', 'chat:open selects Chat');
  sheet.closeSheet();
  await viewport(DESKTOP);
  bus.emit('chat:open', { view: 'chat' });
  assert.equal(sheet.sheetState().open, false, 'wide: the dock\'s, not the sheet\'s');
  const { closeChat } = await shell.importApp('chat-dock.js');
  closeChat({ returnFocus: false });
  await viewport(PHONE);
  await show(snapshot([conversation('c1', IDLE)]));
});

test('chat:open {focus: composer}: on 700×900 the composer takes focus; on a phone the selected segment does', async () => {
  await show(snapshot([conversation('c1', IDLE)], { caps: { queue_message: true } }));
  await viewport(NARROW);
  layout(644);
  bus.emit('chat:open', { view: 'chat', focus: 'composer' });
  assert.equal(sheet.sheetState().open, true);
  const a = doc.activeElement;
  assert.ok(a && sh().contains(a), 'focus is in the sheet');
  assert.ok(a.matches('textarea, input, [contenteditable]'), `the message box has it (${a.tagName}#${a.id})`);
  sheet.closeSheet();
  await viewport(PHONE);
  layout(644);
  bus.emit('chat:open', { view: 'chat', focus: 'composer' });
  assert.equal(doc.activeElement, $('sh-tab-chat'), 'on a phone the keyboard never rises by itself');
  await show(snapshot([conversation('c1', IDLE)]));
});

test('the awaiting card in the sheet: an answerable ask at level local mounts through mountSheet, never mountCard', async () => {
  const got = [];
  const off = slots.registerApprovals({
    mountBar: () => false,
    mountCard: () => { got.push('card'); return true; },
    mountSheet: (body) => { got.push('sheet'); body.append(doc.createElement('iframe')); return true; },
    unmount: () => {},
  });
  try {
    // The panel last in the dock (where the card is mountCard's), then the sheet opens.
    bus.emit('chat:host', { host: $('cd-body'), variant: 'desktop' });
    await show(snapshot([conversation('c1', WAITING)], { asks: [ASK] }));
    got.length = 0;
    sheet.openSheet();
    await shell.tick();
    assert.ok(got.includes('sheet'), 'mountSheet');
    assert.ok(!got.includes('card'), 'never mountCard');
    sheet.closeSheet();
  } finally {
    off();
    await show(snapshot([conversation('c1', IDLE)]));
  }
});

/* ═════════════════════════════ the tab's states ════════════════════════════ */

test('the tab\'s six states: data-cs-state, data-cs-pace, .ct-word, --tab-w and the aria-label (§8.3)', async () => {
  const word = () => pull().querySelector('.ct-word').textContent;
  const w = () => pull().style.getPropertyValue('--tab-w');

  await show(snapshot([conversation('c1', WORKING)]));
  assert.equal(pull().dataset.csState, 'working');
  assert.equal(pull().dataset.csPace, undefined);
  assert.equal(w(), '56px');
  assert.equal(word(), '');
  assert.equal(label(), 'Claude is working — Edit · paths.js');
  assert.equal(inherited(pull().querySelector('.ct-bar'), '--cs-pulse'), '1.2s');

  await show(snapshot([conversation('c1', QUIET)]));
  assert.equal(pull().dataset.csState, 'working');
  assert.equal(pull().dataset.csPace, 'quiet');
  assert.equal(value(pull().querySelector('.ct-bar'), 'animation'), 'none', 'quiet is still');

  await show(snapshot([conversation('c1', QUESTION)]));
  assert.equal(pull().dataset.csState, 'question');
  assert.equal(w(), '124px');
  assert.equal(word(), 'QUESTION');
  assert.equal(value(pull().querySelector('.ct-word'), 'display'), 'inline');
  assert.equal(label(), 'Claude has a question — open the chat');
  assert.equal(value(tab(), 'background'), 'var(--cs-st-tint)', 'closed: the yellow tint');

  await show(snapshot([conversation('c1', WAITING)]));
  assert.equal(pull().dataset.csState, 'waiting');
  assert.equal(w(), '124px');
  assert.equal(word(), 'NEEDS YOU');
  assert.equal(label(), 'Claude needs you: permission prompt');
  assert.equal(value(tab(), 'border-color'), 'var(--cs-st-bd)', 'closed: the rust border');

  await show(snapshot([conversation('c1', SUSPENDED)]));
  assert.equal(pull().dataset.csState, 'suspended');
  assert.equal(label(), 'Claude is suspended — resume it in the terminal', 'never offline');
  assert.equal(value(pull().querySelector('.ct-bar'), 'animation'), 'none');

  await show(snapshot([conversation('c1', IDLE)]));
  assert.equal(pull().dataset.csState, 'idle');
  assert.equal(w(), '56px');
  assert.equal(label(), 'Chat with Claude — idle');
  assert.equal(value(pull().querySelector('.ct-bar'), 'animation'), 'none');

  bus.emit('conn', { state: 'reconnecting' });
  await shell.tick();
  assert.equal(pull().dataset.csState, 'offline');
  assert.equal(label(), 'Chat with Claude — reconnecting');
  assert.equal(inherited(pull().querySelector('.ct-bar'), '--cs-pulse'), '2.4s');
  await show(snapshot([conversation('c1', IDLE)]));
  assert.equal(pull().dataset.csState, 'idle');
});

test('another session waiting outranks the followed working one', async () => {
  await show(snapshot([conversation('c1', WORKING), conversation('c2', WAITING)], { primary: 'c1' }));
  assert.equal(pull().dataset.csState, 'waiting');
  assert.equal(label(), 'Claude needs you in another session: permission prompt');
  await show(snapshot([conversation('c1', IDLE)]));
});

test('#chat-live speaks only transitions into waiting, question and offline, at most once per 2 s', async () => {
  const realNow = Date.now;
  let t = realNow() + 60000;
  Date.now = () => t;
  try {
    const live = () => $('chat-live').textContent;
    await show(snapshot([conversation('c1', IDLE)]));
    $('chat-live').textContent = '';
    t += 3000;
    await show(snapshot([conversation('c1', WORKING)]));
    assert.equal(live(), '', 'into working: silent');
    t += 3000;
    await show(snapshot([conversation('c1', QUESTION)]));
    assert.equal(live(), 'Claude has a question — open the chat');
    t += 3000;
    await show(snapshot([conversation('c1', SUSPENDED)]));
    assert.equal(live(), 'Claude has a question — open the chat', 'suspended is never announced');
    t += 3000;
    await show(snapshot([conversation('c1', WAITING)]));
    assert.equal(live(), 'Claude needs you: permission prompt');
    t += 3000;
    bus.emit('conn', { state: 'reconnecting' });
    await shell.tick();
    assert.equal(live(), 'Chat with Claude — reconnecting');
    // A flapping socket inside the gap says 'reconnecting' once.
    $('chat-live').textContent = '';
    t += 500;
    bus.emit('conn', { state: 'live' });
    await shell.tick();
    t += 500;
    bus.emit('conn', { state: 'reconnecting' });
    await shell.tick();
    t += 3000;
    bus.emit('mirror', { what: ['conn'] });
    await shell.tick();
    assert.equal(live(), '', 'the repeat inside the gap is dropped, and not said later');
    bus.emit('conn', { state: 'live' });
    t += 3000;
    await show(snapshot([conversation('c1', IDLE)]));
  } finally { Date.now = realNow; }
});

test('#chat-live: a text held inside the 2 s gap is said when the gap ends, with no further store change', async () => {
  const realNow = Date.now;
  let t = realNow() + 3600000;   // past the clock the case above left the region at
  Date.now = () => t;
  try {
    const live = () => $('chat-live').textContent;
    await show(snapshot([conversation('c1', IDLE)]));
    t += 3000;
    await show(snapshot([conversation('c1', QUESTION)]));
    assert.equal(live(), 'Claude has a question — open the chat');
    // WAITING 500 ms later: inside the gap, so it is held, not said yet.
    t += 500;
    await show(snapshot([conversation('c1', WAITING)]));
    assert.equal(live(), 'Claude has a question — open the chat', 'held inside the gap');
    // No further mirror event: the gap's own timer (1.5 s of the shell's
    // tracked setTimeout) says the held text once the gap has passed.
    t += 2000;
    await shell.tick(2000);   // real time (Date.now is frozen here, so no waitUntil)
    assert.equal(live(), 'Claude needs you: permission prompt', 'the held text is said when the gap ends');
    // The flap stays dropped: a repeat of the text just said, inside the gap.
    $('chat-live').textContent = '';
    t += 500;
    await show(snapshot([conversation('c1', IDLE)]));
    t += 500;
    await show(snapshot([conversation('c1', WAITING)]));
    t += 3000;
    await shell.tick(2000);
    assert.equal(live(), '', 'the repeat inside the gap is dropped, and not said later');
    t += 3000;
    await show(snapshot([conversation('c1', IDLE)]));
  } finally { Date.now = realNow; }
});

/* ═════════════════════════════ the badge ═══════════════════════════════════ */

test('the badge: off at 0; the Final\'s fixture reads 6, working, "6 running tasks — open Tasks"; .sh-run "6 running"', async () => {
  assert.ok(badge().classList.contains('off'));
  assert.equal(badge().tabIndex, -1);
  assert.equal(value(badge(), 'opacity'), '0');
  assert.equal(value(badge(), 'pointer-events'), 'none');
  assert.equal($('sh-tab-tasks').querySelector('.sh-run').textContent, '');
  const { mirrorBody: body, queueBody: q } = finalFixture({ now: Date.now() });
  queueBody = q;
  await show(body);
  assert.equal(badge().classList.contains('off'), false);
  assert.equal(badge().querySelector('.cb-n').textContent, '6');
  assert.equal(pull().dataset.csState, 'working');
  assert.equal(value(badge(), 'opacity'), '1', 'the working look');
  assert.equal(badge().getAttribute('aria-label'), '6 running tasks — open Tasks');
  assert.equal($('sh-tab-tasks').querySelector('.sh-run').textContent, '6 running');
  sheet.pushPage('tasks', { key: 'deep', title: 'Deep' });
  shell.click(badge());
  assert.equal(sheet.sheetState().view, 'tasks');
  assert.equal(sheet.sheetState().page, null, 'Tasks at its root (§8.4): the pushed page popped');
  assert.equal(sheet.sheetState().h, 341, 'Tasks at least half');
  sheet.setStop(622);
  shell.click(badge());
  assert.equal(sheet.sheetState().h, 622, 'never lowered');
  queueBody = { items: [], count: 0 };
  await show(snapshot([conversation('c1', IDLE)]));
});

test('the centred dock merges the count into the tab (U72 sets data-dock; refreshPull redraws)', async () => {
  const { mirrorBody: body } = finalFixture({ now: Date.now() });
  await show(body);
  pull().dataset.dock = 'center';
  sheet.refreshPull();
  await shell.tick();
  assert.equal(pull().querySelector('.ct-count').textContent, '6');
  assert.match(label(), /, 6 running$/);
  delete pull().dataset.dock;
  sheet.refreshPull();
  await shell.tick();
  assert.equal(pull().querySelector('.ct-count').textContent, '');
  await show(snapshot([conversation('c1', IDLE)]));
});

test('a mirror event while closed changes the tab, the badge and .sh-run only', async () => {
  await show(snapshot([conversation('c1', IDLE)]));
  // The panel elsewhere: what changes inside the sheet is then the sheet's own
  // drawing (the panel, when it is there, redraws itself: chat-panel.js).
  bus.emit('chat:host', { host: $('cd-body'), variant: 'desktop' });
  const changed = new Set();
  // #queue-rail sits in Tasks → Queue's kept page from boot (U70, main.js)
  // and redraws itself on every hello (queue.js), as the panel does: it is
  // not the sheet's own drawing either.
  const mo = new W.MutationObserver((recs) => {
    for (const r of recs) {
      const n = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (!n.closest('#queue-rail')) changed.add(n.id || n.className);
    }
  });
  mo.observe(sh(), { subtree: true, childList: true, attributes: true, characterData: true });
  const { mirrorBody: body } = finalFixture({ now: Date.now() });
  await show(body);
  mo.disconnect();
  for (const k of changed) assert.equal(k, 'sh-run', `only the segment count changes inside a closed sheet (saw ${k})`);
  assert.equal($('sh-tab-tasks').querySelector('.sh-run').textContent, '6 running');
  await show(snapshot([conversation('c1', IDLE)]));
});

/* ═════════════════════════════ segments and pages ══════════════════════════ */

test('segments: Tasks then Chat; tapping the selected one pops to its root; a tap-open selects Chat and keeps Tasks\' page', async () => {
  sheet.openSheet();
  shell.click($('sh-tab-tasks'));
  assert.equal(sheet.sheetState().view, 'tasks');
  assert.ok($('sh-chat').classList.contains('hidden'));
  assert.equal($('sh-tasks').classList.contains('hidden'), false);
  assert.equal($('sh-tab-tasks').getAttribute('aria-selected'), 'true');
  assert.deepEqual(lastSheet(), { open: true, stop: 'half', view: 'tasks', page: null });
  sheet.pushPage('tasks', { key: 'shells', title: 'Shells', back: '‹ Tasks', render: () => {} });
  assert.equal(sheet.sheetState().page, 'shells');
  shell.click($('sh-tab-tasks'));
  assert.equal(sheet.sheetState().page, null, 'the selected segment pops to the root');
  sheet.pushPage('tasks', { key: 'shells', title: 'Shells', back: '‹ Tasks', render: () => {} });
  shell.click($('sh-tab-chat'));
  assert.equal(sheet.sheetState().view, 'chat');
  sheet.closeSheet();
  shell.click($('sh-tab-tasks') && tab());
  assert.equal(sheet.sheetState().view, 'chat', 'a tap-open selects Chat');
  shell.click($('sh-tab-tasks'));
  assert.equal(sheet.sheetState().page, 'shells', 'Tasks\' stack is as it was');
});

test('pages: pushPage builds .sh-page > .sh-phead + .sh-pbody, hides the page under it, runs the cleanup on popPage', () => {
  const cleaned = [];
  const a = sheet.pushPage('tasks', { key: 'a', title: 'Shells', sub: '2 running', back: '‹ Tasks',
    render: (body) => { body.textContent = 'A'; return () => cleaned.push('a'); } });
  const pageA = a.page;
  assert.ok(pageA.matches('.sh-page'));
  assert.equal(pageA.parentElement, $('sh-tasks'));
  const [head, body] = pageA.children;
  assert.ok(head.matches('.sh-phead') && body.matches('.sh-pbody'));
  assert.equal(head.querySelector('button.sh-back').textContent, '‹ Tasks');
  assert.equal(head.querySelector('.sh-ptitle').textContent, 'Shells');
  assert.equal(head.querySelector('.sh-psub').textContent, '2 running');
  assert.equal(body.textContent, 'A');
  assert.equal($('sh-tasks').getAttribute('data-depth'), '1');
  const b = sheet.pushPage('tasks', { key: 'b', title: 'npm run dev', back: '‹ Shells', render: () => () => cleaned.push('b') });
  assert.equal(pageA.hidden, true, 'the page under the top one is hidden');
  assert.equal(b.page.hidden, false);
  shell.click(b.page.querySelector('.sh-back'));
  assert.deepEqual(cleaned, ['b'], 'its back button pops it');
  assert.equal(b.page.isConnected, false);
  assert.equal(pageA.hidden, false);
  assert.equal(sheet.popPage('tasks'), true);
  assert.deepEqual(cleaned, ['b', 'a']);
  assert.equal($('sh-tasks').hasAttribute('data-depth'), false);
  assert.equal(sheet.popPage('tasks'), false, 'nothing left');
  assert.equal(sheet.pushPage('nope', { key: 'x' }), null);
});

test('a keep page stays in the DOM, hidden, across pops; ensurePage builds it once; showPage pushes it by key', () => {
  let built = 0;
  // Not 'queue': U70's Queue page (main.js) holds that key from boot.
  const spec = { key: 'kept', title: 'Kept', back: '‹ Tasks', keep: true, render: () => { built += 1; } };
  const h1 = sheet.ensurePage('tasks', spec);
  assert.equal(built, 1);
  assert.equal(h1.page.hidden, true, 'built hidden');
  assert.equal(sheet.ensurePage('tasks', spec).page, h1.page, 'once');
  assert.equal(sheet.showPage('tasks', 'kept'), true);
  assert.equal(h1.page.hidden, false);
  assert.equal(sheet.sheetState().view === 'tasks' ? sheet.sheetState().page : 'kept', 'kept');
  sheet.popPage('tasks');
  assert.equal(h1.page.isConnected, true, 'kept in the document');
  assert.equal(h1.page.hidden, true);
  sheet.pushPage('tasks', spec);
  assert.equal(built, 1, 'never rebuilt');
  sheet.popPage('tasks');
  assert.equal(sheet.showPage('tasks', 'nothing'), false, 'no such kept page: nothing');
});

test('registerSheetView mounts a view registered before init and one after, each once; cleanup on unregister', async () => {
  // Before init: stop, register, init again.
  sheet.stopChatSheet();
  const log = [];
  const offA = sheet.registerSheetView('a', (api) => {
    log.push(['mount a', Object.keys(api).sort().join(',')]);
    api.on('sheet', () => log.push('a heard'));
    return () => log.push('cleanup a');
  });
  assert.deepEqual(log, [], 'not before init');
  sheet.initChatSheet();
  layout(644);
  assert.equal(log.length, 1);
  assert.equal(log[0][1], 'badge,closeSheet,ensurePage,on,openSheet,popPage,pull,pushPage,refresh,scrim,setStop,sheet,showPage,state,tab,views');
  const offB = sheet.registerSheetView('b', (api) => {
    log.push('mount b');
    assert.equal(api.views.tasks, $('sh-tasks'));
    return () => log.push('cleanup b');
  });
  assert.ok(log.includes('mount b'), 'after init: at once');
  sheet.openSheet();
  assert.ok(log.includes('a heard'), 'api.on wraps the bus sheet event');
  sheet.closeSheet();
  offA();
  assert.ok(log.includes('cleanup a'));
  const heard = log.filter((l) => l === 'a heard').length;
  sheet.openSheet();
  sheet.closeSheet();
  assert.equal(log.filter((l) => l === 'a heard').length, heard, 'its listeners went with it');
  offB();
  assert.equal(log.filter((l) => l === 'mount b').length, 1);
  assert.ok(log.includes('cleanup b'));
});

/* ═════════════════════════════ Back ════════════════════════════════════════ */

test('Back on a phone: opening pushes {wcSheet: true}; a UI close goes back and its popstate does nothing more', async () => {
  const pushes = [];
  const realPush = W.history.pushState;
  W.history.pushState = function pushState(st, ...rest) { pushes.push(st); return realPush.call(this, st, ...rest); };
  try {
    sheet.openSheet();
    assert.equal(W.history.state && W.history.state.wcSheet, true);
    assert.equal(pushes.length, 1, 'one entry');
    sheet.setStop(622);
    assert.equal(pushes.length, 1, 'a move between stops pushes nothing');
  } finally { delete W.history.pushState; }
  sheet.closeSheet();
  await waitUntil(() => !(W.history.state && W.history.state.wcSheet), { timeout: 2000, what: 'history.back() to land' });
  await shell.tick();
  assert.equal(sheet.sheetState().open, false);
  // A reopen right away still works: the ignored popstate was ours.
  sheet.openSheet();
  assert.equal(sheet.sheetState().open, true);
  assert.equal(W.history.state.wcSheet, true);
  sheet.closeSheet();
  await waitUntil(() => !(W.history.state && W.history.state.wcSheet), { timeout: 2000, what: 'back' });
  await shell.tick();
});

test('Back on a phone: opening on top of an entry that is already ours pushes none', async () => {
  sheet.openSheet();
  sheet.closeSheet();
  await waitUntil(() => !(W.history.state && W.history.state.wcSheet), { timeout: 2000, what: 'the close\'s Back' });
  await shell.tick();
  W.history.forward();
  await waitUntil(() => W.history.state && W.history.state.wcSheet, { timeout: 2000, what: 'Forward onto the old entry' });
  await shell.tick();
  assert.equal(sheet.sheetState().open, false, 'Forward does not open the sheet');
  const length = W.history.length;
  const pushes = [];
  const realPush = W.history.pushState;
  W.history.pushState = function pushState(st, ...rest) { pushes.push(st); return realPush.call(this, st, ...rest); };
  try { sheet.openSheet(); } finally { delete W.history.pushState; }
  assert.equal(pushes.length, 0, 'the top entry already has wcSheet: nothing pushed');
  assert.equal(W.history.length, length);
  sheet.closeSheet();
  await waitUntil(() => !(W.history.state && W.history.state.wcSheet), { timeout: 2000, what: 'back' });
  await shell.tick();
});

test('Back on a phone: reopened before the close\'s Back lands, the sheet takes a fresh entry once it has', async () => {
  sheet.openSheet();
  sheet.closeSheet();
  sheet.openSheet();
  assert.equal(sheet.sheetState().open, true);
  await waitUntil(() => W.history.state && W.history.state.wcSheet && sheet.sheetState().open, { timeout: 2000, what: 'a fresh entry' });
  await shell.tick();
  assert.equal(sheet.sheetState().open, true, 'the landing Back did not close the reopened sheet');
  W.history.back();
  await waitUntil(() => !sheet.sheetState().open, { timeout: 2000, what: 'Back to close it' });
});

test('Back on a phone: a popstate without wcSheet closes an open sheet', async () => {
  sheet.openSheet();
  W.history.back();
  await waitUntil(() => !sheet.sheetState().open, { timeout: 2000, what: 'the popstate to close the sheet' });
  assert.equal(pull().dataset.stop, 'closed');
});

test('on a 700×900 window nothing is pushed; init with a stale wcSheet entry replaces it', async () => {
  await viewport(NARROW);
  layout(644);
  const pushes = [];
  const realPush = W.history.pushState;
  W.history.pushState = function pushState(st, ...rest) { pushes.push(st); return realPush.call(this, st, ...rest); };
  try { sheet.openSheet(); } finally { delete W.history.pushState; }
  assert.equal(pushes.length, 0, 'nothing pushed');
  assert.ok(!(W.history.state && W.history.state.wcSheet));
  sheet.closeSheet();
  await viewport(PHONE);
  W.history.pushState({ other: 1, wcSheet: true }, '');
  sheet.stopChatSheet();
  sheet.initChatSheet();
  layout(644);
  assert.deepEqual(W.history.state, { other: 1 }, 'the stale entry replaced, the rest kept');
});

/* ═════════════════════════════ timers and teardown ═════════════════════════ */

test('no setInterval is created and no animation frame is left pending once idle', async () => {
  const intervals = shell.intervals().length;
  const { mirrorBody: body } = finalFixture({ now: Date.now() });
  await show(body);
  sheet.openSheet();
  sheet.closeSheet();
  W.dispatchEvent(new W.Event('resize'));
  await shell.tick();
  assert.equal(shell.intervals().length, intervals, 'no interval');
  assert.match(SHEET_SRC, /requestAnimationFrame/);
  assert.doesNotMatch(SHEET_SRC + DRAG_SRC, /setInterval\(|Observer\(/, 'no interval or observer in either module');
  assert.doesNotMatch(DRAG_SRC, /setTimeout\(/, 'no timeout in the drag');
  // The one timeout is the live region's self-ending wake for a held text (§10.1).
  assert.equal((SHEET_SRC.match(/setTimeout\(/g) || []).length, 1, 'one timeout in the sheet: the held announcement\'s');
  await show(snapshot([conversation('c1', IDLE)]));
});

test('the module touches no storage directly and asks no media query', () => {
  assert.doesNotMatch(SHEET_SRC + DRAG_SRC, /localStorage|sessionStorage|matchMedia/);
  assert.doesNotMatch(SHEET_SRC, /chat-pull-stub/, 'the stand-in is never named: U73 deletes it');
  assert.doesNotMatch(SHEET_SRC, /getElementById\('stage'\)\.style|stage\.style/, 'nothing written on #stage');
});

/* ═════════════════════════════ the Stop (B2 (a)) ═══════════════════════════ */

test('B2 (a): the panel in the sheet sizes #cp-stop \'sheet\'; below 760px #cs-stop holds no frame; at 1280 it returns', async () => {
  const SC = await shell.importApp('session-control.js');
  const asks = await shell.importApp('asks.js');
  const S = await shell.importApp('chat-state.js');
  shell.setRoutes({ '/api/asks': { asks: [], answer: { port: 4567 } } });
  asks.stopAsks();
  const ws = await shell.importApp('ws.js');
  asks.initAsks({ onFrame: ws.onFrame, onHello: ws.onHello });
  SC.stopSessionControl();
  SC.initSessionControl();
  try {
    await show(snapshot([conversation('c1', WORKING)], { caps: { interrupt: true } }));
    await waitUntil(() => S.mirror.capabilities.interrupt === true, { timeout: 2000 });
    sheet.openSheet();
    await waitUntil(() => $('cp-stop').querySelector('iframe'), { timeout: 3000, what: 'the panel\'s Stop' });
    assert.equal($('cp-stop').getAttribute('data-wc-stop'), 'sheet');
    assert.ok($('cp-stop').matches('[data-wc-stop="sheet"]'));
    assert.match($('cp-stop').querySelector('iframe').src, /size=sheet/);
    assert.equal($('cs-stop').querySelector('iframe'), null, 'narrow: no frame in the hidden bar');
    sheet.closeSheet();
    await viewport(DESKTOP);
    await waitUntil(() => $('cs-stop').querySelector('iframe'), { timeout: 3000, what: 'the bar\'s Stop back at 1280' });
    assert.equal($('cs-stop').getAttribute('data-wc-stop'), 'bar');
    await viewport(PHONE);
    await waitUntil(() => !$('cs-stop').querySelector('iframe'), { timeout: 3000, what: 'the bar\'s Stop gone narrow' });
  } finally {
    SC.stopSessionControl();
    shell.setRoutes({});
    await show(snapshot([conversation('c1', IDLE)]));
  }
});
