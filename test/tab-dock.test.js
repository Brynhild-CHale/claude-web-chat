// Docking the phone's grip tab (public/app/tab-dock.js, U72's section of
// app.css), through the real shell (test-support/chrome-shell.js): design spec
// §8.9, §8.3 (the badge's inner side, the merged count, the aria-label's
// ", N running"), §8.4's axis rule and ruling N2.
//
// main.js does not start the sheet or the dock until U73 wires them, so the
// boot's init does (spec §10.1): initChatState, initChatSheet, initTabDock.
// jsdom lays nothing out: #topbar and #bottombar get rectangles so the sheet has
// stops (avail 644: full 622, half 341), #chat-pull a 390px one, and the tab the
// rectangle its dock would give it. bootShell boots once per file and cannot
// seed storage before main.js, so "the dock survives a reload" is stopTabDock()
// then initTabDock(), the code path a reload runs (notes-A D10). app.css is read
// the way test/chat-sheet.test.js reads it — its rules matched against the live
// DOM and cascaded as a browser does.
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
const DOCK_SRC = fs.readFileSync(path.join(REPO, 'public/app/tab-dock.js'), 'utf8');

const PHONE = { width: 390, height: 844 };
const KEY = 'wc:chat-tab';
const PULL_W = 390;

let { mirrorBody, queueBody } = finalFixture({ now: Date.now() });

let shell, W, doc, $, bus, sheet, drag, dock;

const pull = () => $('chat-pull');
const tab = () => $('chat-tab');
const badge = () => $('chat-badge');
const stored = () => W.localStorage.getItem(KEY);

async function show() {
  let read = false;
  const off = bus.on('mirror', (d) => { if (d && Array.isArray(d.what) && d.what.includes('all')) read = true; });
  try {
    await shell.frame(helloFrame());
    await waitUntil(() => read, { timeout: 5000, what: 'the store to read GET /api/mirror' });
  } finally { off(); }
  await shell.tick();
}

// #topbar's bottom at 44, #bottombar's top at 44 + 644; the pull 390px wide.
function layout() {
  shell.scrollMetrics($('topbar'), { rect: { top: 0, height: 44, width: PULL_W } });
  shell.scrollMetrics($('bottombar'), { rect: { top: 688, height: 60, width: PULL_W } });
  shell.scrollMetrics(pull(), { rect: { left: 0, top: 688, width: PULL_W, height: 0 } });
}
// The tab where its dock puts it (56px wide), as a browser would lay it out.
const TAB_LEFT = { right: PULL_W - 56, center: (PULL_W - 56) / 2, left: 0 };
function placeTab() {
  const d = pull().dataset.dock || 'right';
  shell.scrollMetrics(tab(), { rect: { left: TAB_LEFT[d], top: 665, width: 56, height: 23 } });
}
const tabCentre = () => TAB_LEFT[pull().dataset.dock || 'right'] + 28;

// ── pointer gestures on the tab ──────────────────────────────────────────────

let pid = 100;
function pe(type, init, target = tab()) {
  const e = new W.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', button: 0, ...init });
  target.dispatchEvent(e);
  return e;
}
// A drag of the tab by (dx, dy) from its centre, in `steps` moves with a frame
// between them; `during` runs before the release.
async function dragBy(dx, dy, { steps = 3, end = 'pointerup', during } = {}) {
  placeTab();
  const id = ++pid;
  const x0 = tabCentre();
  const y0 = 676;
  pe('pointerdown', { pointerId: id, clientX: x0, clientY: y0 });
  for (let i = 1; i <= steps; i++) {
    pe('pointermove', { pointerId: id, clientX: x0 + (dx * i) / steps, clientY: y0 + (dy * i) / steps }, doc);
    await shell.tick(5);
  }
  if (during) await during();
  pe(end, { pointerId: id, clientX: x0 + dx, clientY: y0 + dy }, doc);
  await shell.tick(5);
}
// A sideways drag that lands the tab's centre at x.
const dragTo = (x, opts) => dragBy(x - tabCentre(), 0, opts);
async function reload() {
  dock.stopTabDock();
  dock.initTabDock();
  await shell.tick();
}

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
      const { initTabDock } = await s.importApp('tab-dock.js');
      initTabDock();
    },
  });
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  sheet = await shell.importApp('chat-sheet.js');
  drag = await shell.importApp('sheet-drag.js');
  dock = await shell.importApp('tab-dock.js');
  layout();
  await show();
});

after(() => shell.restore());

beforeEach(async () => {
  if (sheet.sheetState().open) sheet.closeSheet({ returnFocus: false });
  await waitUntil(() => !(W.history.state && W.history.state.wcSheet), { timeout: 2000, what: 'the sheet\'s entry to go' });
  await shell.tick();
});

// ── app.css, cascaded against the live DOM (as test/chat-sheet.test.js) ──────

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
function cascade(el, prop) {
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
      if (!win || beats(d, win)) win = d;
    });
  }
  return win;
}
function beats(a, b) {
  if (a.important !== b.important) return a.important;
  return (bySpec(a.spec, b.spec) || a.at - b.at || a.pos - b.pos) > 0;
}
const value = (el, prop) => { const d = cascade(el, prop); return d ? d.value : null; };
// U72's own section of app.css.
const FROM = CSS.indexOf('/* ── U72 · docking the tab');
const TO = CSS.indexOf('/* ── ', FROM + 1);
const SECTION = CSS.slice(FROM, TO).replace(/\/\*[\s\S]*?\*\//g, '');

/* ═════════════════════════════ the stored dock ═════════════════════════════ */

test('nothing stored: docked right; the Final\'s fixture puts 6 on the badge', () => {
  assert.equal(stored(), null);
  assert.equal(pull().dataset.dock, 'right');
  assert.equal(badge().querySelector('.cb-n').textContent, '6');
  assert.equal(pull().querySelector('.ct-count').textContent, '', 'no merged count off the centre');
  assert.doesNotMatch(tab().getAttribute('aria-label'), /running/);
});

test('an invalid stored dock reads as right', async () => {
  W.localStorage.setItem(KEY, 'diagonal');
  pull().dataset.dock = 'left';
  await reload();
  assert.equal(pull().dataset.dock, 'right');
  assert.equal(stored(), 'diagonal', 'reading never rewrites the key');
  W.localStorage.removeItem(KEY);
});

/* ═════════════════════════════ docking ═════════════════════════════════════ */

test('a sideways drag into the left third docks left: .docking and --tab-dx while it moves, then stored', async () => {
  const stage = $('stage');
  const stageStyle = stage.getAttribute('style');
  let mid = null;
  await dragTo(60, {
    during: () => {
      mid = { docking: pull().classList.contains('docking'), dx: pull().style.getPropertyValue('--tab-dx') };
      assert.equal(stage.style.getPropertyValue('--tab-dx'), '', 'never on #stage');
    },
  });
  assert.deepEqual(mid, { docking: true, dx: `${60 - (TAB_LEFT.right + 28)}px` }, 'the tab follows the finger');
  assert.equal(pull().dataset.dock, 'left');
  assert.equal(stored(), 'left');
  assert.equal(pull().style.getPropertyValue('--tab-dx'), '', '--tab-dx gone');
  assert.equal(pull().classList.contains('docking'), false, '.docking gone');
  assert.equal(stage.getAttribute('style'), stageStyle, '#stage untouched');
  assert.equal(sheet.sheetState().open, false, 'a dock never opens the sheet');
  // The click a browser sends after the release is the drag's, not a tap.
  tab().dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
  assert.equal(sheet.sheetState().open, false, 'and its click is swallowed');
});

test('docked left: the tab\'s radius 0 10px 0 0 with no left border; the badge on its right (inner) side', () => {
  assert.equal(pull().dataset.dock, 'left');
  assert.equal(value(tab(), 'left'), '0');
  assert.equal(value(tab(), 'border-radius'), '0 10px 0 0');
  assert.equal(value(tab(), 'border-left'), '0');
  assert.equal(value(tab(), 'border-right'), '1px solid var(--wc-border)');
  assert.equal(value(badge(), 'right'), 'auto');
  assert.equal(value(badge(), 'left'), 'calc(var(--tab-w) + 4px)', 'the badge just right of the tab');
  assert.match(value(badge(), 'transform'), /^translateX\(0\) translateX\(var\(--tab-dx, 0px\)\)$/);
  assert.notEqual(value(badge(), 'visibility'), 'hidden');
  assert.equal(badge().classList.contains('off'), false);
});

test('a drag into the middle third docks centre: the badge fades into the tab\'s count and aria-label', async () => {
  await dragTo(PULL_W / 2 + 10);
  assert.equal(pull().dataset.dock, 'center');
  assert.equal(stored(), 'center');
  await shell.tick();   // refreshPull's frame
  assert.equal(value(tab(), 'left'), '50%');
  assert.match(value(tab(), 'transform'), /^translateX\(-50%\)/);
  assert.equal(value(tab(), 'border-radius'), '10px 10px 0 0');
  assert.equal(value(tab(), 'border-right'), '1px solid var(--wc-border)');
  assert.equal(value(badge(), 'opacity'), '0', 'the badge fades out');
  assert.equal(value(badge(), 'pointer-events'), 'none');
  assert.equal(value(badge(), 'visibility'), 'hidden', 'and leaves the tab order once faded');
  assert.match(value(badge(), 'transition'), /visibility 0s \.28s/, 'hidden only after the fade');
  const count = pull().querySelector('.ct-count');
  assert.equal(count.textContent, '6');
  assert.equal(value(count, 'display'), 'inline', 'the count shows in the tab');
  assert.ok(pull().querySelector('.ct-bar').compareDocumentPosition(count) & W.Node.DOCUMENT_POSITION_FOLLOWING,
    'after the bar');
  assert.match(tab().getAttribute('aria-label'), /, 6 running$/);
});

test('reload: stopTabDock then initTabDock reads the dock back from wc:chat-tab', async () => {
  assert.equal(stored(), 'center');
  pull().dataset.dock = 'right';   // what a fresh page's stamped pull would carry
  sheet.refreshPull();
  await shell.tick();
  assert.equal(pull().querySelector('.ct-count').textContent, '', 'drawn as the fresh pull');
  await reload();
  assert.equal(pull().dataset.dock, 'center');
  assert.equal(pull().querySelector('.ct-count').textContent, '6', 'refreshPull redrew the merged count');
  assert.match(tab().getAttribute('aria-label'), /, 6 running$/);
});

test('a cancelled drag restores the previous dock and writes nothing', async () => {
  assert.equal(pull().dataset.dock, 'center');
  W.localStorage.removeItem(KEY);
  await dragTo(30, { end: 'pointercancel' });
  assert.equal(pull().dataset.dock, 'center');
  assert.equal(pull().classList.contains('docking'), false);
  assert.equal(pull().style.getPropertyValue('--tab-dx'), '');
  assert.equal(stored(), null, 'nothing written');
  W.localStorage.setItem(KEY, 'center');
});

test('a drag ending in the same third writes nothing', async () => {
  W.localStorage.removeItem(KEY);
  await dragTo(PULL_W / 2 - 40);
  assert.equal(pull().dataset.dock, 'center');
  assert.equal(stored(), null, 'nothing written');
  assert.equal(pull().classList.contains('docking'), false);
  W.localStorage.setItem(KEY, 'center');
});

test('the badge travels with the tab between the sides: right again, it sits on the left (inner) side', async () => {
  await dragTo(PULL_W - 20);
  assert.equal(pull().dataset.dock, 'right');
  assert.equal(stored(), 'right');
  await shell.tick();
  assert.equal(value(tab(), 'border-radius'), '10px 0 0 0', 'U68\'s right-docked shape');
  assert.match(value(tab(), 'transform'), /^translateX\(-100%\)/);
  assert.equal(value(badge(), 'left'), 'calc(100% - var(--tab-w) - 4px)', 'left of the tab, on the left/transform scheme');
  assert.match(value(badge(), 'transform'), /^translateX\(-100%\)/);
  assert.notEqual(value(badge(), 'visibility'), 'hidden');
  assert.equal(pull().querySelector('.ct-count').textContent, '', 'the count back on the badge');
  assert.doesNotMatch(tab().getAttribute('aria-label'), /running/);
  for (const el of [tab(), badge()]) {
    assert.match(value(el, 'transition'), /left \.28s/, 'left animates');
    assert.match(value(el, 'transition'), /transform \.28s/, 'transform animates');
  }
  pull().classList.add('docking');
  for (const el of [tab(), badge()]) assert.equal(value(el, 'transition'), 'none', 'nothing transitions mid-drag');
  pull().classList.remove('docking');
});

test('with the sheet open a sideways drag does not dock; a vertical drag still opens and closes it', async () => {
  sheet.openSheet();
  assert.equal(sheet.sheetState().open, true);
  await dragTo(40);
  assert.equal(pull().dataset.dock, 'right', 'an open sheet never docks');
  assert.equal(pull().classList.contains('docking'), false);
  sheet.closeSheet({ returnFocus: false });
  await waitUntil(() => !(W.history.state && W.history.state.wcSheet), { timeout: 2000, what: 'the sheet\'s entry to go' });
  await dragBy(0, -200);
  assert.equal(sheet.sheetState().open, true, 'a vertical drag opens it');
  assert.equal(pull().dataset.dock, 'right');
  await dragBy(0, 400);
  assert.equal(sheet.sheetState().open, false, 'and closes it');
  assert.equal(pull().dataset.dock, 'right');
});

test('move writes --tab-dx at most once per frame (one pending frame), the latest dx', async () => {
  placeTab();
  const id = ++pid;
  const x0 = tabCentre();
  pe('pointerdown', { pointerId: id, clientX: x0, clientY: 676 });
  const raf = globalThis.requestAnimationFrame;
  let frames = 0;
  globalThis.requestAnimationFrame = (fn) => { frames += 1; return raf(fn); };
  try {
    for (const dx of [-20, -40, -60, -80]) pe('pointermove', { pointerId: id, clientX: x0 + dx, clientY: 676 }, doc);
  } finally { globalThis.requestAnimationFrame = raf; }
  assert.equal(frames, 1, 'four moves in one frame ask for one frame');
  assert.equal(pull().style.getPropertyValue('--tab-dx'), '', 'nothing before the frame');
  await shell.tick(5);
  assert.equal(pull().style.getPropertyValue('--tab-dx'), '-80px', 'the latest dx');
  pe('pointercancel', { pointerId: id, clientX: x0 - 80, clientY: 676 }, doc);
  await shell.tick(5);
  assert.equal(pull().dataset.dock, 'right');
});

test('stopTabDock mid-drag drops the drag: .docking and --tab-dx go, and the release docks nothing', async () => {
  W.localStorage.removeItem(KEY);
  placeTab();
  const id = ++pid;
  const x0 = tabCentre();
  pe('pointerdown', { pointerId: id, clientX: x0, clientY: 676 });
  pe('pointermove', { pointerId: id, clientX: 40, clientY: 676 }, doc);
  await shell.tick(5);
  assert.ok(pull().classList.contains('docking'));
  dock.stopTabDock();
  assert.equal(pull().classList.contains('docking'), false);
  assert.equal(pull().style.getPropertyValue('--tab-dx'), '');
  pe('pointerup', { pointerId: id, clientX: 40, clientY: 676 }, doc);
  await shell.tick(5);
  assert.equal(pull().dataset.dock, 'right', 'the release after a stop docks nothing');
  assert.equal(stored(), null);
  dock.initTabDock();
  assert.equal(pull().dataset.dock, 'right', 'nothing stored reads as right');
});

test('reduced motion: the tab and the badge move at once', async () => {
  const views = [{ ...PHONE, reducedMotion: true }, { ...PHONE, reducedMotion: false }];
  shell.setViewport(views[0]);
  await shell.tick();
  try {
    for (const d of ['right', 'left', 'center']) {
      pull().dataset.dock = d;
      assert.equal(value(tab(), 'transition'), 'none', `${d}: the tab`);
      assert.equal(value(badge(), 'transition'), 'none', `${d}: the badge`);
    }
    assert.equal(value(pull().querySelector('.ct-count'), 'animation'), 'none');
  } finally {
    pull().dataset.dock = 'right';
    shell.setViewport(views[1]);
    await shell.tick();
  }
});

test('the CSS and the module: tokens only, no filter; storage through storage.js; never #stage', () => {
  assert.ok(FROM > 0 && TO > FROM, 'U72 has its section');
  assert.doesNotMatch(SECTION, /#[0-9a-fA-F]{3,8}\b/, 'no hex');
  assert.doesNotMatch(SECTION, /backdrop-filter|(^|[^-])filter\s*:|mix-blend-mode|z-index/m, 'no filter, blend or z-index');
  const code = DOCK_SRC.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /localStorage|sessionStorage/, 'storage only through storage.js');
  assert.match(code, /from '\.\/storage\.js'/);
  assert.doesNotMatch(code, /getElementById\('stage'\)|#stage|matchMedia|addEventListener|setInterval|setTimeout/,
    'no #stage, no media query, no listener or timer of its own');
});

test('stopTabDock unregisters: a later sideways drag reaches no handler; initTabDock is idempotent', async () => {
  assert.ok(drag.dockHandler(), 'registered');
  const h = drag.dockHandler();
  dock.initTabDock();
  assert.equal(drag.dockHandler(), h, 'a second init registers nothing new');
  dock.stopTabDock();
  assert.equal(drag.dockHandler(), null, 'unregistered');
  W.localStorage.removeItem(KEY);
  await dragTo(40);
  assert.equal(pull().dataset.dock, 'right', 'the attribute stays, and nothing moves it');
  assert.equal(pull().classList.contains('docking'), false);
  assert.equal(stored(), null);
  assert.equal(sheet.sheetState().open, false, 'the swipe toggles nothing either');
  dock.initTabDock();
  assert.ok(drag.dockHandler(), 'registered again');
  dock.stopTabDock();
});

test('the dock follows the tab\'s centre, not the finger: a grab off the tab\'s middle lands by where the tab goes', async () => {
  W.localStorage.removeItem(KEY);
  dock.initTabDock();
  assert.equal(pull().dataset.dock, 'right');
  placeTab();
  const id = ++pid;
  // Grabbed 22px right of the tab's centre (362): the tab's centre ends at 120,
  // in the left third (under 130), while the finger ends at 142, in the middle.
  const x0 = tabCentre() + 22;
  const dx = 120 - tabCentre();
  pe('pointerdown', { pointerId: id, clientX: x0, clientY: 676 });
  for (let i = 1; i <= 3; i++) {
    pe('pointermove', { pointerId: id, clientX: x0 + (dx * i) / 3, clientY: 676 }, doc);
    await shell.tick(5);
  }
  pe('pointerup', { pointerId: id, clientX: x0 + dx, clientY: 676 }, doc);
  await shell.tick(5);
  assert.equal(pull().dataset.dock, 'left', 'the tab\'s centre picks the third');
  assert.equal(stored(), 'left');
  dock.stopTabDock();
});
