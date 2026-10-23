// The annotation toolbar's GUI (annotation engine 2D.8 and 2D.7's "comment on
// the registry", U338; DECISIONS.md I.6, K.1 C2 = b, rulings H-2 (b), H-3 (a),
// H-6 (a), H-7, D1 (b), D2 (c), F2 (a), K.2-14, K.2-15, K.2-67).
//
// The real chrome (test-support/chrome-shell, booted once as a 1280×800
// desktop), GET /api/toolbar answering the built-in pack's GENERATED tools[]
// (chrome-shell's DEFAULT_ROUTES) plus fixtures: `sticker` (pack `fun`, icons,
// small and large settings), `stamp` (pack `fun`, no icons, no settings) and a
// hidden `marker` whose label and pack name are markup. A PATCH is applied to
// the route's own record and answered with the new view, as the daemon does.
//
// Pinned here:
//   - the bar: #toolbar in #topbar right after #dock, the pointer first, one
//     .tb-slot per pinned type in pinned order, each an <img> from
//     /api/toolbar/icon/<type> (?mode=dark under web-chat's dark mode), its
//     title and aria-label the manifest label plus the bound key; no
//     #btn-pin-mode;
//   - the tray: hidden types listed under "Hidden · by pack", a type neither
//     pinned nor hidden in the tray only (H-7); pin, hide and move-down each
//     send exactly ONE PATCH /api/toolbar with the new {pinned} / {hidden} and
//     write nothing to browser storage; a `toolbar` frame redraws the slots;
//   - comment on the registry: C arms comment (body.pin-mode, the slot's armed
//     class), C again puts it down, Escape puts it down and closes the tray in
//     one press; the legend's "Pin comment" row and the palette's key are the
//     head's byte for byte;
//   - the armed slot pressed again opens U336's small frame anchored to it
//     (comment's "Visible to Claude", F2 a; a fixture's settings.small too,
//     with "More settings…" to its large frame); a type without settings is put
//     down instead;
//   - remote read (canWrite false): every tray control disabled but this
//     device's finger-draws switch, the view-only line, an arm refused with
//     U337's notice drawn as text; at full, enabled;
//   - pack strings as text; narrow (390×844, coarse): #toolbar hidden, #bb-tools
//     in the bottom bar between ↩ active and Graph, its reveal opening the tray
//     above the bottom bar; the app.css block spells no colour; every id the
//     module creates is reserved; the finger-draws switch (auto by default,
//     with whether a pen was seen) writes this device's storage through U334
//     and sends no PATCH /api/toolbar/user;
//   - K.2-67: after a rebind of P, Q, G and N the rail's Push button and the
//     empty page's tips show the new keys, and no owner spells one literally.
const test = require('node:test');
const { before, beforeEach, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame, DEFAULT_ROUTES } = require('../test-support/chrome-shell');
const { stripComments, parseRules, createCascade } = require('../test-support/css-cascade');
const { RESERVED_IDS, RESERVED_ID_PATTERNS } = require('../lib/server/domain/mounts');

const REPO = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');
const FORM_DIR = path.join(REPO, 'templates/components/form-renderer');
const FORM_HTML = fs.readFileSync(path.join(FORM_DIR, 'component.html'), 'utf8');
const FORM_META = JSON.parse(fs.readFileSync(path.join(FORM_DIR, 'meta.json'), 'utf8'));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const BASE = JSON.parse(JSON.stringify(DEFAULT_ROUTES['/api/toolbar']));
const BUILTINS = BASE.tools.map((t) => t.type);
const icons = (type) => ({ light: `/api/toolbar/icon/${type}`, dark: `/api/toolbar/icon/${type}?mode=dark` });
const STICKER = {
  type: 'sticker', label: 'Sticker', pack: { name: 'fun', version: '1.0.0' }, builtin: false, icons: icons('sticker'),
  hotkeys: [], profiles: false, input: 'taps', installed: true,
  settings: {
    small: { type: 'object', properties: { size: { type: 'string', title: 'Sticker size', enum: ['s', 'm'], default: 's' } } },
    large: { type: 'object', properties: { set: { type: 'string', title: 'Sticker set', enum: ['work', 'any'], default: 'work' } } },
  },
};
const STAMP = { type: 'stamp', label: 'Stamp', pack: { name: 'fun', version: '1.0.0' }, builtin: false, icons: null,
  hotkeys: [], settings: null, profiles: false, input: 'taps', installed: true };
const MARKER = { type: 'marker', label: '<b>x</b>', pack: { name: '<i>ink</i>', version: '1.0.0' }, builtin: false,
  icons: icons('marker'), hotkeys: [], settings: null, profiles: false, input: 'strokes', installed: true };
const TOOLS = [...BASE.tools, STICKER, STAMP, MARKER];

const PROJECT = () => ({ v: 1, pinned: BUILTINS.slice(), hidden: ['marker'], settings: {}, profiles: {}, bindings: {} });
const USER = () => ({ v: 1, bindings: {}, fingerDraws: false, settings: {} });
let project = PROJECT();
let user = USER();
let access = { canWrite: true, canWriteUser: true };
const view = () => ({ ok: true, v: 1, project: JSON.parse(JSON.stringify(project)), user: JSON.parse(JSON.stringify(user)),
  merged: { bindings: {}, settings: {} }, ...access, tools: TOOLS });
function routes() {
  return {
    '/api/components/form-renderer': { ...FORM_META, source: FORM_HTML, has_service: false },
    '/api/toolbar/user': (u, init) => {
      if (init && init.method === 'PATCH') Object.assign(user, JSON.parse(init.body));
      return view();
    },
    '/api/toolbar': (u, init) => {
      if (init && init.method === 'PATCH') {
        const body = JSON.parse(init.body);
        for (const k of ['pinned', 'hidden']) if (body[k] !== undefined) project[k] = body[k];
        if (body.settings) Object.assign(project.settings, body.settings);
      }
      return view();
    },
  };
}

const DESKTOP = { width: 1280, height: 800, coarse: false, visualHeight: 800, visualTop: 0 };
const PHONE = { width: 390, height: 844, coarse: true, visualHeight: 844, visualTop: 0 };

let shell, W, doc, $, css, ts, ov, TS, TB, IM;

before(async () => {
  shell = await bootShell({ routes: routes() });
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
  css = createCascade(CSS, { win: () => W });
  ts = await shell.importApp('toolbar-state.js');
  ov = await shell.importApp('overlay.js');
  TS = await shell.importApp('tool-settings.js');
  TB = await shell.importApp('toolbar.js');
  IM = await shell.importApp('input-mode.js');
  await shell.frame(helloFrame());
});

beforeEach(async () => {
  TS.closeToolSettings();
  TB.closeTray();
  ov.setArmed(null);
  project = PROJECT();
  user = USER();
  access = { canWrite: true, canWriteUser: true };
  shell.setRoutes(routes());
  shell.setViewport(DESKTOP);
  doc.documentElement.dataset.theme = 'light';
  await ts.refreshToolbar();
  await shell.tick();
});

after(async () => { if (shell) await shell.restore(); });

const slots = () => [...$('tb-slots').querySelectorAll('.tb-slot')];
const slotOf = (type) => $('tb-slots').querySelector(`.tb-slot[data-type="${type}"]`);
const trayOpen = () => !$('tb-tray').classList.contains('hidden');
const patches = (url = '/api/toolbar') => shell.calls.filter((c) => c.url === url && c.method === 'PATCH');
const armedType = () => { const a = ov.armed(); return a ? a.type : null; };
const rowIn = (sectionTitle) => {
  // The rows after a section heading, up to the next heading.
  const list = $('tb-tray').querySelector('.tb-tray-list');
  const out = [];
  let inside = false;
  for (const n of list.children) {
    if (n.classList.contains('tb-sec')) { inside = n.textContent === sectionTitle; continue; }
    if (inside && n.classList.contains('tb-row')) out.push(n.dataset.type);
  }
  return out;
};
const actIn = (type, label) => [...$('tb-tray').querySelectorAll(`.tb-row[data-type="${type}"] .tb-act`)]
  .find((b) => b.textContent === label);
async function openTray(reveal = $('tb-reveal')) {
  shell.press(reveal);
  await shell.tick();
  assert.ok(trayOpen(), 'the tray is open');
}
const toolbarKeys = () => {
  const out = [];
  for (let i = 0; i < W.localStorage.length; i++) out.push(W.localStorage.key(i));
  return out.filter((k) => /toolbar|pinned|hidden|armed|slot/i.test(k));
};

/* ── the bar ─────────────────────────────────────────────────────────────── */

test('the bar: #toolbar right after #dock, the pointer first, one slot per pinned type in order, each an icon <img>; no ✎', () => {
  const bar = $('toolbar');
  assert.ok(bar, '#toolbar exists');
  assert.equal(bar.parentElement, $('topbar'), 'in #topbar');
  assert.equal(bar.previousElementSibling, $('dock'), 'right after #dock');
  assert.equal($('btn-pin-mode'), null, 'the ✎ button is retired');
  assert.equal(bar.firstElementChild, $('tb-pointer'), 'the pointer tool first');
  assert.equal(bar.children[1], $('tb-slots'));
  assert.equal(bar.lastElementChild, $('tb-reveal'));
  assert.deepEqual(slots().map((s) => s.dataset.type), BUILTINS, 'the pinned order');
  for (const s of slots()) {
    const img = s.querySelector('img');
    assert.ok(img, `${s.dataset.type}: an <img>`);
    assert.equal(img.getAttribute('src'), `/api/toolbar/icon/${s.dataset.type}`);
    assert.equal(img.getAttribute('alt'), '');
  }
  const c = slotOf('comment');
  assert.equal(c.getAttribute('aria-label'), 'Comment (C)', 'the manifest label and its bound key');
  assert.equal(c.title, 'Comment · C');
  assert.equal(slotOf('highlight').getAttribute('aria-label'), 'Highlight', 'no key bound: the label alone');
  assert.ok($('tb-pointer').classList.contains('armed'), 'nothing armed: the pointer is');
  assert.equal(slotOf('sticker'), null, 'sticker is listed, not pinned: not on the bar');
  assert.equal(slotOf('marker'), null, 'a hidden type is not on the bar');
});

test('the tray: hidden types under "Hidden · by pack", a type neither pinned nor hidden in the tray only (H-7)', async () => {
  await openTray();
  const tray = $('tb-tray');
  assert.ok(tray.classList.contains('popover'), 'a .popover');
  assert.equal($('tb-reveal').getAttribute('aria-expanded'), 'true');
  assert.equal(tray.querySelector('.tb-tray-head').textContent, 'Tools · 6 from 3 packs');
  assert.ok($('tb-filter'), 'the filter');
  assert.deepEqual(rowIn('Pinned · slot order'), BUILTINS);
  assert.deepEqual(rowIn('Hidden · by pack'), ['marker']);
  assert.deepEqual(rowIn('Listed · not pinned'), ['sticker', 'stamp']);
  assert.equal(tray.querySelector('.tb-tray-note').textContent, 'Slot keys 1–9 follow the pinned order');
  assert.ok(tray.querySelector('.tb-view-only').hidden, 'no view-only line at full');
  // The filter narrows by name and pack.
  $('tb-filter').value = 'fun';
  $('tb-filter').dispatchEvent(new W.Event('input', { bubbles: true }));
  assert.deepEqual(rowIn('Listed · not pinned'), ['sticker', 'stamp']);
  assert.deepEqual(rowIn('Pinned · slot order'), []);
  $('tb-filter').value = '';
  $('tb-filter').dispatchEvent(new W.Event('input', { bubbles: true }));
  assert.equal(doc.activeElement, $('tb-filter'), 'the desktop tray focuses its filter');
  // A key goes to the focused element: Escape in the filter is forwarded to the
  // one Escape owner.
  shell.key('Escape', { target: doc.activeElement });
  assert.ok(!trayOpen(), 'Escape closes the tray');
});

test('pin, hide and move-down each send exactly one PATCH /api/toolbar with the new list, and nothing to browser storage', async () => {
  const before = toolbarKeys();
  await openTray();
  let n = patches().length;
  shell.click(actIn('sticker', 'Pin'));
  await shell.tick();
  assert.equal(patches().length, n + 1, 'one PATCH');
  assert.deepEqual(patches().at(-1).body, { pinned: [...BUILTINS, 'sticker'] });
  assert.deepEqual(slots().map((s) => s.dataset.type), [...BUILTINS, 'sticker'], 'the answer redraws the bar');

  n = patches().length;
  shell.click(actIn('stamp', 'Hide'));
  await shell.tick();
  assert.equal(patches().length, n + 1);
  assert.deepEqual(patches().at(-1).body, { hidden: ['marker', 'stamp'] });
  assert.deepEqual(rowIn('Hidden · by pack').sort(), ['marker', 'stamp']);

  n = patches().length;
  shell.click(actIn('comment', '↓'));
  await shell.tick();
  assert.equal(patches().length, n + 1);
  assert.deepEqual(patches().at(-1).body, { pinned: ['highlight', 'comment', 'box-grab', 'sticker'] });

  n = patches().length;
  shell.click(actIn('marker', 'Pin'));
  await shell.tick();
  assert.equal(patches().length, n + 1, 'pinning a hidden type: one PATCH naming both lists');
  assert.deepEqual(patches().at(-1).body, { pinned: ['highlight', 'comment', 'box-grab', 'sticker', 'marker'], hidden: ['stamp'] });

  assert.deepEqual(toolbarKeys(), before, 'no toolbar key in browser storage');
  assert.equal(patches('/api/toolbar/user').length, 0);
});

test('a `toolbar` frame redraws the slots in the new order', async () => {
  await shell.frame({ type: 'toolbar', v: 1, project: { ...PROJECT(), pinned: ['box-grab', 'comment'] }, user: USER(),
    merged: { bindings: {}, settings: {} } });
  assert.deepEqual(slots().map((s) => s.dataset.type), ['box-grab', 'comment']);
  await shell.frame({ type: 'toolbar', v: 1, project: PROJECT(), user: USER(), merged: { bindings: {}, settings: {} } });
  assert.deepEqual(slots().map((s) => s.dataset.type), BUILTINS);
});

/* ── comment on the registry ─────────────────────────────────────────────── */

test('C arms comment (pin mode, the slot armed), C again puts it down; Escape puts it down and closes the tray in one press', async () => {
  const pin = () => doc.body.classList.contains('pin-mode');
  shell.key('c');
  assert.equal(armedType(), 'comment');
  assert.ok(pin(), 'body.pin-mode on');
  assert.ok(slotOf('comment').classList.contains('armed'), 'the slot has the armed class');
  assert.equal(slotOf('comment').getAttribute('aria-pressed'), 'true');
  assert.ok(!$('tb-pointer').classList.contains('armed'));
  shell.key('c');
  assert.equal(armedType(), null, 'C again puts it down');
  assert.ok(!pin() && !slotOf('comment').classList.contains('armed'));
  shell.key('c');
  await openTray();
  shell.key('Escape', { target: doc.activeElement });
  assert.equal(armedType(), null, 'Escape put the tool down…');
  assert.ok(!trayOpen(), '…and closed the tray, in one press');
  assert.ok(!pin());
});

test('the legend\'s "Pin comment" row and the palette\'s key are the head\'s, from comment\'s element.json C', async () => {
  const card = $('key-legend').querySelector('.legend-card');
  const rows = [...card.querySelectorAll('.legend-row')].map((r) => r.outerHTML);
  const row = '<div class="legend-row"><span>Pin comment</span><span class="keys"><kbd>C</kbd></span></div>';
  const i = rows.indexOf(row);
  assert.ok(i > 0, 'the row is drawn, byte for byte');
  assert.equal(rows[i - 1], '<div class="legend-row"><span>Replay to node</span><span class="keys"><kbd>R</kbd></span></div>');
  assert.equal(rows[i + 1], '<div class="legend-row"><span>Previous / next node</span><span class="keys"><kbd>[</kbd><kbd>]</kbd></span></div>');
  const shellMod = await shell.importApp('shell.js');
  shell.key('k', { metaKey: true });
  await shell.tick();
  const pinRow = [...$('cmd-list').querySelectorAll('.palette-item')].find((r) => r.querySelector('.label').textContent === 'Pin comment');
  assert.ok(pinRow, 'the palette row');
  assert.equal(pinRow.querySelector('kbd.hint').textContent, 'C');
  shellMod.handleEscape();
  await shell.tick();
  // No chrome row holds C any more: the tool binding does.
  const hk = await shell.importApp('hotkeys.js');
  const c = hk.bindingsView().find((b) => b.chord === 'C' && !b.descriptive);
  assert.deepEqual(c.target, { kind: 'tool', type: 'comment' });
  assert.equal(hk.conflicts().filter((x) => x.chord === 'C').length, 0, 'no conflict on C');
});

/* ── the small settings ──────────────────────────────────────────────────── */

test('the armed comment slot pressed again opens U336\'s small frame anchored to it, "Visible to Claude" (F2 a)', async () => {
  const slot = slotOf('comment');
  shell.scrollMetrics(slot, { rect: { left: 600, top: 8, width: 30, height: 30 } });
  shell.press(slot);
  assert.equal(armedType(), 'comment', 'the first press arms');
  assert.ok(!TS.isToolSettingsOpen());
  shell.press(slot);
  assert.ok(TS.isToolSettingsOpen(), 'the second opens the small frame');
  const frame = $('tool-settings-small');
  assert.ok(!frame.classList.contains('hidden'));
  assert.equal(slot.getAttribute('aria-controls'), 'tool-settings-small');
  await waitForForm(frame);
  assert.match(frame.querySelector('.ts-host').shadowRoot.textContent, /Visible to Claude/);
  assert.equal(frame.querySelector('.ts-title').textContent, 'Comment');
  assert.equal(frame.style.top, `${38 + TS.GAP}px`, 'anchored below the slot');
  assert.equal(frame.style.left, '600px');
  assert.equal(frame.querySelector('.tb-more'), null, 'comment declares no large settings');
  assert.equal(armedType(), 'comment', 'the tool stays armed');
  shell.press(slot);
  assert.ok(!TS.isToolSettingsOpen(), 'the slot again closes it');
  shell.key('c');
  assert.equal(armedType(), null, 'the tool\'s key puts it down');
});

async function waitForForm(frame) {
  for (let i = 0; i < 40; i++) {
    const h = frame.querySelector('.ts-host');
    if (h && h.shadowRoot && h.shadowRoot.querySelector('form')) return;
    await shell.tick(10);
  }
  assert.fail('the settings form mounted');
}

test('a fixture with settings.small opens its frame (with "More settings…" to settings.large); a type without settings is put down', async () => {
  project.pinned = [...BUILTINS, 'sticker', 'stamp'];
  await ts.refreshToolbar();
  shell.press(slotOf('sticker'));
  shell.press(slotOf('sticker'));
  const frame = $('tool-settings-small');
  assert.ok(TS.isToolSettingsOpen());
  await waitForForm(frame);
  assert.match(frame.querySelector('.ts-host').shadowRoot.textContent, /Sticker size/);
  const more = frame.querySelector('.tb-more');
  assert.ok(more, 'More settings…');
  assert.equal(more.textContent, 'More settings…');
  shell.press(more);
  const large = $('tool-settings-large');
  assert.ok(!large.classList.contains('hidden'), 'the large frame');
  await waitForForm(large);
  assert.match(large.querySelector('.ts-host').shadowRoot.textContent, /Sticker set/);
  TS.closeToolSettings();

  shell.press(slotOf('stamp'));
  assert.equal(armedType(), 'stamp');
  assert.ok(slotOf('stamp').querySelector('.tb-glyph'), 'no icons: the generic glyph');
  shell.press(slotOf('stamp'));
  assert.equal(armedType(), null, 'no settings: the armed slot puts the tool down');
  assert.ok(!TS.isToolSettingsOpen());
});

/* ── remote levels ───────────────────────────────────────────────────────── */

test('remote read: the tray is view only but for this device\'s finger-draws switch; arming is refused with U337\'s notice as text', async () => {
  access = { canWrite: false, canWriteUser: false };
  await ts.refreshToolbar();
  await openTray();
  const tray = $('tb-tray');
  const controls = [...tray.querySelectorAll('button, input, select, textarea')];
  const fd = controls.filter((c) => c.name === 'tb-finger-draws');
  assert.equal(fd.length, 3, 'auto / on / off');
  assert.ok(fd.every((c) => !c.disabled), 'the finger-draws switch is live');
  const rest = controls.filter((c) => !fd.includes(c));
  assert.ok(rest.length >= 10, `the other controls (${rest.length})`);
  assert.deepEqual(rest.filter((c) => !c.disabled).map((c) => c.outerHTML), [], 'every other control disabled');
  const vo = tray.querySelector('.tb-view-only');
  assert.ok(!vo.hidden);
  assert.equal(vo.textContent, 'View only: pins and order belong to the host.');
  assert.equal(tray.querySelector('.tb-fd-default'), null, '"make this my default" is the host\'s');
  shell.key('Escape', { target: doc.activeElement });
  shell.press(slotOf('highlight'));
  assert.equal(armedType(), null, 'refused');
  const notice = doc.querySelector('.tb-notice');
  assert.equal(notice.textContent, 'View only: tools need full access');
  assert.equal(notice.children.length, 0, 'text only');

  access = { canWrite: true, canWriteUser: false };
  await ts.refreshToolbar();
  await openTray();
  for (const [type, label] of [['sticker', 'Pin'], ['sticker', 'Hide'], ['marker', 'Unhide'], ['marker', 'Pin'], ['comment', 'Unpin'], ['comment', '↓']]) {
    assert.ok(!actIn(type, label).disabled, `at full: ${type} ${label} enabled`);
  }
  assert.ok(!$('tb-filter').disabled, 'and the filter');
  assert.ok([...tray.querySelectorAll('.tb-row-arm')].every((b) => !b.disabled), 'and every arm button');
  assert.ok(tray.querySelector('.tb-view-only').hidden);
});

test('web-chat\'s dark mode: the slots\' icons carry ?mode=dark', async () => {
  doc.documentElement.dataset.theme = 'dark';
  await shell.tick();
  for (const s of slots()) assert.equal(s.querySelector('img').getAttribute('src'), `/api/toolbar/icon/${s.dataset.type}?mode=dark`);
  doc.documentElement.dataset.theme = 'light';
  await shell.tick();
  for (const s of slots()) assert.equal(s.querySelector('img').getAttribute('src'), `/api/toolbar/icon/${s.dataset.type}`);
});

test('pack strings are text: a label `<b>x</b>` and a pack `<i>ink</i>` render literally', async () => {
  await openTray();
  const row = $('tb-tray').querySelector('.tb-row[data-type="marker"]');
  assert.equal(row.querySelector('.tb-row-name').textContent, '<b>x</b>');
  assert.equal(row.querySelector('.tb-row-pack').textContent, '<i>ink</i>');
  assert.equal($('tb-tray').querySelectorAll('b, i').length, 0, 'no <b> or <i> element');
  assert.ok([...$('tb-tray').querySelectorAll('.tb-pack-name')].some((p) => p.textContent === '<i>ink</i>'));
  // Armed through its key-less row: the visiting slot carries the label as text too.
  shell.click(row.querySelector('.tb-row-arm'));
  assert.equal(armedType(), 'marker', 'a hidden tool armed from the tray');
  const v = slotOf('marker');
  assert.ok(v && v.classList.contains('visiting'), 'shown as the visiting slot');
  assert.equal(v.getAttribute('aria-label'), '<b>x</b>, hidden tool, armed');
  assert.equal($('toolbar').querySelectorAll('b, i').length, 0);
  shell.press(v);
  assert.equal(armedType(), null, 'the visiting slot puts it down');
  assert.equal(slotOf('marker'), null);
});

/* ── the finger-draws switch ─────────────────────────────────────────────── */

test('the finger-draws switch: this device\'s auto / on / off (auto by default, with whether a pen was seen), storage only', async () => {
  W.localStorage.removeItem(IM.FINGER_DRAWS_KEY);
  await openTray();
  const radios = () => [...$('tb-tray').querySelectorAll('input[name="tb-finger-draws"]')];
  assert.deepEqual(radios().map((r) => [r.value, r.checked]), [['auto', true], ['on', false], ['off', false]]);
  const note = () => $('tb-tray').querySelector('.tb-fd-note').textContent;
  assert.equal(note(), `auto: finger-draws on until a pen is seen on this device · ${IM.fingerDrawsMode().penSeen ? 'a pen has been seen here' : 'no pen seen here yet'}`);
  const mk = $('tb-tray').querySelector('.tb-fd-default');
  assert.ok(mk && mk.disabled, 'the host may make it the default, once a device value is chosen');
  const userPatches = patches('/api/toolbar/user').length;
  const on = radios().find((r) => r.value === 'on');
  on.checked = true;
  on.dispatchEvent(new W.Event('change', { bubbles: true }));
  await shell.tick();
  assert.equal(W.localStorage.getItem(IM.FINGER_DRAWS_KEY), 'on', 'written through U334 to this device\'s storage');
  assert.equal(IM.fingerDrawsMode().mode, 'on');
  assert.deepEqual(radios().map((r) => [r.value, r.checked]), [['auto', false], ['on', true], ['off', false]]);
  assert.equal(patches('/api/toolbar/user').length, userPatches, 'no PATCH /api/toolbar/user');
  // The host's "make this my default": the user record, through U332's user route (K.2-15).
  const mk2 = $('tb-tray').querySelector('.tb-fd-default');
  assert.ok(!mk2.disabled);
  shell.click(mk2);
  await shell.tick();
  assert.equal(patches('/api/toolbar/user').length, userPatches + 1);
  assert.deepEqual(patches('/api/toolbar/user').at(-1).body, { fingerDraws: true });
  IM.setFingerDraws('auto');
});

/* ── narrow: the phone half ──────────────────────────────────────────────── */

test('narrow (390×844, coarse): #toolbar hidden, #bb-tools between ↩ active and Graph; its reveal opens the tray above the bottom bar', async () => {
  shell.setViewport(PHONE);
  await shell.tick();
  try {
    const shown = (el) => { for (let n = el; n && n !== doc.documentElement; n = n.parentElement) if (css.value(n, 'display') === 'none') return false; return true; };
    assert.ok(!shown($('toolbar')), '#toolbar is hidden under 760px');
    const bb = $('bb-tools');
    assert.ok(shown(bb), '#bb-tools is shown');
    assert.equal(bb.parentElement, $('bottombar'));
    const follows = (a, b) => !!(a.compareDocumentPosition(b) & W.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(follows($('bb-return'), bb) && follows(bb.parentElement.querySelector('.bb-stepper'), bb), 'after the stepper and ↩ active');
    assert.ok(follows(bb, $('bb-graph')), 'before Graph');
    assert.ok(bb.querySelector('.bb-armed'), 'the armed tool (or the pointer)');
    assert.ok(bb.querySelector('.tb-slot[data-type="comment"]'), 'the first pinned slot fits');
    assert.equal(css.value(bb.querySelector('.tb-slot[data-type="comment"]'), 'height'), '44px');
    const reveal = $('bb-tools-reveal');
    assert.equal(reveal.parentElement, bb);
    shell.scrollMetrics($('bottombar'), { rect: { left: 0, top: 784, width: 390, height: 60 } });
    shell.scrollMetrics($('tb-tray'), { rect: { width: 358, height: 300 } });
    await openTray(reveal);
    const top = parseFloat($('tb-tray').style.top);
    assert.equal(top + 300, 784 - TB.GAP, 'the tray\'s bottom sits just above the bottom bar');
    assert.equal(reveal.getAttribute('aria-expanded'), 'true');
    TB.closeTray();
    // The phone half arms and puts down through the one armed state.
    shell.press(bb.querySelector('.tb-slot[data-type="comment"]'));
    assert.equal(armedType(), 'comment');
    assert.equal(bb.querySelector('.bb-armed').getAttribute('aria-label'), 'Put down Comment');
    shell.press(bb.querySelector('.bb-armed'));
    assert.equal(armedType(), null);
  } finally {
    shell.setViewport(DESKTOP);
    await shell.tick();
  }
});

/* ── the CSS block, the ids ──────────────────────────────────────────────── */

const NAMED = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown '
  + 'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod '
  + 'darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen '
  + 'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue '
  + 'firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew '
  + 'hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan '
  + 'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray '
  + 'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue '
  + 'mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred '
  + 'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid '
  + 'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple '
  + 'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue '
  + 'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white '
  + 'whitesmoke yellow yellowgreen transparent currentcolor').split(/\s+/));
const COLOR_PROPS = /^(color|background|background-color|border|border-color|border-(top|right|bottom|left)(-color)?|outline|outline-color|accent-color|box-shadow|fill|stroke|caret-color|text-decoration-color)$/;

test('app.css: ONE `toolbar (U338)` block, tokens only — no #hex, rgb(), hsl() or named colour', () => {
  const at = CSS.indexOf('/* toolbar (U338)');
  assert.ok(at >= 0, 'the block is in app.css');
  assert.equal(CSS.indexOf('/* toolbar (U338)', at + 1), -1, 'one block');
  const tail = CSS.slice(at);
  const next = tail.slice(2).search(/\n\/\* /);
  const block = next < 0 ? tail : tail.slice(0, next + 2);
  const rules = parseRules(stripComments(block));
  assert.ok(rules.length >= 20, `the bar's, the phone half's and the tray's rules (${rules.length})`);
  const out = [];
  for (const r of rules) {
    for (const [prop, raw] of r.decls) {
      const v = raw.replace(/var\(--wc-[\w-]+\)/g, ' ');
      if (/#[0-9a-fA-F]{3,8}\b/.test(v)) out.push(`${r.selector} ${prop}: hex`);
      if (/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(v)) out.push(`${r.selector} ${prop}: a colour function`);
      for (const w of v.toLowerCase().match(/[a-z][a-z-]*/g) || []) if (NAMED.has(w)) out.push(`${r.selector} ${prop}: ${w}`);
      if (COLOR_PROPS.test(prop) && !/var\(--wc-[\w-]+\)/.test(raw)) out.push(`${r.selector} ${prop}: not a --wc-* token`);
      // Custom properties: the --wc-* tokens, the z rungs and the bottom bar's height.
      if (/var\(--(?!wc-|z-|bb-h\))/.test(raw)) out.push(`${r.selector} ${prop}: a custom property outside --wc-*`);
    }
  }
  assert.deepEqual(out, []);
  assert.ok(rules.every((r) => /toolbar|tb-|bb-/.test(r.selector)), 'the block styles only the toolbar\'s own classes');
});

test('every id the toolbar creates is reserved, and the module spells no id of its own beyond them', async () => {
  await openTray();
  const ids = new Set();
  for (const root of [$('toolbar'), $('bb-tools'), $('tb-tray'), doc.querySelector('.tb-notice')]) {
    if (root.id) ids.add(root.id);
    for (const e of root.querySelectorAll('[id]')) ids.add(e.id);
  }
  const reserved = (id) => RESERVED_IDS.has(id) || RESERVED_ID_PATTERNS.some((re) => re.test(id));
  assert.deepEqual([...ids].filter((id) => !reserved(id)), []);
  for (const id of ['toolbar', 'tb-pointer', 'tb-slots', 'tb-reveal', 'tb-tray', 'tb-filter', 'bb-tools', 'bb-tools-reveal']) {
    assert.ok(ids.has(id), `${id} is drawn`);
  }
  const src = read('public/app/toolbar.js');
  const spelled = [...src.matchAll(/\bid:\s*'([\w-]+)'|\.id\s*=\s*'([\w-]+)'|getElementById\('([\w-]+)'\)/g)].map((m) => m[1] || m[2] || m[3]);
  assert.deepEqual(spelled.filter((id) => !reserved(id)), [], 'every id the source names is reserved');
});

/* ── K.2-67: keyed texts read the registry ───────────────────────────────── */

test('after a rebind of P, Q, G and N the rail\'s Push and the empty page\'s tips show the new keys; no owner spells one', async () => {
  const chrome = (action) => ({ kind: 'chrome', action });
  const bindings = { P: null, Q: null, G: null, N: null, J: chrome('chrome.push'), K: chrome('chrome.rail'),
    H: chrome('chrome.graph'), L: chrome('chrome.add') };
  try {
    await shell.frame({ type: 'toolbar', v: 1, project: PROJECT(), user: { ...USER(), bindings }, merged: { bindings: {}, settings: {} } });
    const push = doc.querySelector('.rail-push');
    assert.equal(push.querySelector('kbd').textContent, 'J', 'the Push button\'s key, redrawn at the rebind');
    assert.ok(!/\bP\b/.test(push.querySelector('kbd').textContent));
    await shell.frame(helloFrame());
    const zs = $('main').querySelector('.zero-state');
    assert.ok(zs, 'the empty page');
    assert.deepEqual([...zs.querySelectorAll('.zs-keys kbd')].map((k) => k.textContent), ['H', 'L', '?']);
  } finally {
    await shell.frame({ type: 'toolbar', v: 1, project: PROJECT(), user: USER(), merged: { bindings: {}, settings: {} } });
  }
  assert.equal(doc.querySelector('.rail-push kbd').textContent, 'P', 'the default key back');
  // The owners spell no key of their own.
  assert.doesNotMatch(read('public/app/queue.js'), /<kbd>P<\/kbd>/);
  assert.doesNotMatch(read('public/app/page.js'), /<kbd>[GN?]<\/kbd>/);
  assert.doesNotMatch(read('public/app/chat-panel.js'), /\(Q\)/);
  // The inspector's titles (the glance's own close is not one of K.2-67's lines).
  assert.doesNotMatch(read('public/app/graph-view.js'), /(?:onto|Glance|Bookmark|Export|this node) \((?:A|B|E|R|Space)\)"/);
  assert.doesNotMatch(read('public/index.html'), /<kbd>P<\/kbd>/);
});
