// The settings-pane host (annotation engine 2D.6; DECISIONS.md I.6; notes-read-
// toolbar.md W-9; U336), against the real chrome booted once in jsdom
// (test-support/chrome-shell). GET /api/components/form-renderer is answered
// from the real templates/components/form-renderer: the host renders through
// the builtin component itself.
//
// Pinned here:
//   - openToolSettings mounts form-renderer inside the frame's one shadow host,
//     with the value selected; Save sends exactly one PATCH /api/toolbar
//     {settings: {type: values}} through toolbar-state.js; the live store
//     (window.store) is untouched and no store:set frame goes out;
//   - a named profile (passed, or the armed tool's, K.2-14): Save replaces that
//     profile's settings in the project's profile list and nothing else;
//   - readOnly: every field disabled, no Save; a refused PATCH shows the
//     daemon's hint as text in the frame;
//   - refusals: content 'tool' (tool-drawn, 4A/4B), a schema whose root is not
//     {type: 'object', properties}, a bad level or type;
//   - dismiss (GT-07, the S-18 shape): an outside pointerdown and Escape each
//     close the open frame through the shell's one dismiss layer and
//     handleEscape; a press inside keeps it; Escape from a field inside the
//     frame reaches handleEscape too; opening the other frame closes the first;
//     tool-settings.js adds no document keydown or pointerdown listener;
//   - placement of the small frame: below its anchor, flipped above near the
//     bottom edge and clamped inside the 16px gutter near the right one, placed
//     again on resize; at a 390×844 narrow viewport, above #bottombar;
//   - form-renderer's script starts no timer, subscription, request or
//     window/document listener — the precondition for running it with no
//     `life` (if this fails, the host must take mounts.js's release path);
//   - theming: app.css's U336 block and the host's shadow style spell no colour
//     (no #hex, rgb(), hsl() or named colour), only --wc-* tokens;
//   - RESERVED_IDS holds the two frame ids and U338's planned ids.
const test = require('node:test');
const { before, beforeEach, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { bootShell, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { stripComments, parseRules, createCascade } = require('../test-support/css-cascade');
const { RESERVED_IDS } = require('../lib/server/domain/mounts');

const REPO = path.resolve(__dirname, '..');
const FORM_DIR = path.join(REPO, 'templates/components/form-renderer');
const FORM_HTML = fs.readFileSync(path.join(FORM_DIR, 'component.html'), 'utf8');
const FORM_META = JSON.parse(fs.readFileSync(path.join(FORM_DIR, 'meta.json'), 'utf8'));
const CSS = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');
const SRC = fs.readFileSync(path.join(REPO, 'public/app/tool-settings.js'), 'utf8');

const SCHEMA = { type: 'object', properties: { color: { type: 'string', enum: ['gold', 'green'] } } };
const PROJECT = (profiles = {}) => ({ v: 1, pinned: [], hidden: [], settings: {}, profiles, bindings: {} });
const VIEW = (project = PROJECT()) => ({ ok: true, v: 1, project, user: { v: 1, bindings: {}, fingerDraws: false, settings: {} },
  merged: { bindings: {}, settings: {} }, canWrite: true, canWriteUser: true });

const DESKTOP = { width: 1280, height: 800, coarse: false };
const FRAME_W = 280;
const FRAME_H = 200;

let shell, W, $, TS, ts, ov, css;

// The toolbar route: GET answers `view`, PATCH answers `patchAnswer` (or the
// view back).
let view = VIEW();
let patchAnswer = null;
function routes() {
  return {
    '/api/components/form-renderer': { ...FORM_META, source: FORM_HTML, has_service: false },
    '/api/toolbar': (u, init) => {
      if (init && init.method === 'PATCH') return patchAnswer || view;
      return view;
    },
  };
}

before(async () => {
  shell = await bootShell({ routes: routes() });
  W = shell.window;
  $ = shell.$;
  TS = await shell.importApp('tool-settings.js');
  ts = await shell.importApp('toolbar-state.js');
  ov = await shell.importApp('overlay.js');
  css = createCascade(CSS, { win: () => W });
});

beforeEach(async () => {
  TS.closeToolSettings();
  ov.setArmed(null);
  view = VIEW();
  patchAnswer = null;
  shell.setRoutes(routes());
  shell.setViewport(DESKTOP);
  await ts.refreshToolbar();
});

after(async () => { await shell.restore(); });

const isOpen = (el) => !!el && el.isConnected && !el.classList.contains('hidden');
const small = () => $('tool-settings-small');
const large = () => $('tool-settings-large');
const hostOf = (frame) => frame.querySelector('.ts-host');
const rootOf = (frame) => { const h = hostOf(frame); return h && h.shadowRoot; };
const patches = () => shell.calls.filter((c) => c.url === '/api/toolbar' && c.method === 'PATCH');
const pointerdown = (target) => target.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }));

async function openFixture(extra = {}) {
  const r = TS.openToolSettings({ type: 'fixture', level: 'small', schema: SCHEMA, value: { color: 'gold' }, label: 'Fixture', ...extra });
  assert.equal(r.ok, true, `opened: ${JSON.stringify(r)}`);
  const done = await r.ready;
  assert.equal(done.ok, true, `the form mounted: ${JSON.stringify(done)}`);
  return r;
}

async function submit(frame, color) {
  const root = rootOf(frame);
  const sel = root.querySelector('#f_color');
  sel.value = color;
  root.querySelector('#submit').click();
  await shell.tick();
}

/* ── the schema path ─────────────────────────────────────────────────────── */

test('the form-renderer mounts inside the small frame\'s shadow host with the value selected', async () => {
  await openFixture();
  const frame = small();
  assert.ok(isOpen(frame), 'the small frame is open');
  assert.ok(frame.classList.contains('popover'), 'a .popover');
  assert.equal(TS.isToolSettingsOpen(), true);
  assert.equal(frame.querySelectorAll('.ts-host').length, 1, 'ONE shadow host');
  const root = rootOf(frame);
  assert.ok(root, 'the host carries an open shadow root');
  const sel = root.querySelector('#f_color');
  assert.ok(sel && sel.tagName === 'SELECT', 'the enum is drawn as a select, by form-renderer');
  assert.equal(sel.value, 'gold', 'the value is selected');
  assert.equal(root.querySelector('#submit').textContent, 'Save');
  assert.ok(shell.calls.some((c) => c.url === '/api/components/form-renderer' && c.method === 'GET'), 'read from the components route');
  assert.equal(frame.querySelector('.ts-title').textContent, 'Fixture');
  assert.ok(root.querySelector('style[data-wc-chrome="tool-settings"]'), 'the host\'s token-only style is in the root');
});

test('Save → exactly one PATCH /api/toolbar {settings: {fixture: …}}; the live store untouched, no store:set frame', async () => {
  const storeBefore = JSON.stringify(W.store.get());
  const framesBefore = shell.socket().frames('store:set').length;
  const before = patches().length;
  await openFixture();
  await submit(small(), 'green');
  await waitUntil(() => patches().length > before, { timeout: 2000, what: 'the PATCH' });
  await shell.tick();
  const sent = patches().slice(before);
  assert.equal(sent.length, 1, 'one PATCH');
  assert.deepEqual(sent[0].body, { settings: { fixture: { color: 'green' } } });
  assert.equal(JSON.stringify(W.store.get()), storeBefore, 'window.store unchanged');
  assert.equal(shell.socket().frames('store:set').length, framesBefore, 'no store:set frame');
  assert.ok(!shell.calls.slice(-5).some((c) => c.url === '/api/toolbar/user'), 'never the user tier');
  assert.equal(TS.isToolSettingsOpen(), false, 'an accepted Save closes the frame');
});

test('a second Save pressed while the first is in flight sends nothing more', async () => {
  const before = patches().length;
  await openFixture();
  const root = rootOf(small());
  root.querySelector('#f_color').value = 'green';
  root.querySelector('#submit').click();
  root.querySelector('#submit').click();
  await waitUntil(() => patches().length > before, { timeout: 2000, what: 'the PATCH' });
  await shell.tick();
  await shell.tick();
  assert.equal(patches().length - before, 1, 'one PATCH for a double press');
});

test('a named profile: Save replaces that profile\'s settings and nothing else', async () => {
  view = VIEW(PROJECT({ fixture: [{ name: 'cool', settings: { color: 'gold' } }, { name: 'warm', settings: { color: 'gold' } }] }));
  await ts.refreshToolbar();
  const before = patches().length;
  await openFixture({ profile: 'warm' });
  assert.match(small().querySelector('.ts-sub').textContent, /warm/);
  await submit(small(), 'green');
  await waitUntil(() => patches().length > before, { timeout: 2000, what: 'the PATCH' });
  const sent = patches().slice(before);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { profiles: { fixture: [
    { name: 'cool', settings: { color: 'gold' } }, { name: 'warm', settings: { color: 'green' } },
  ] } });
  assert.ok(!('settings' in sent[0].body), 'the plain settings are not written');
});

test('the armed profile is the default (K.2-14); null edits the plain settings', async () => {
  view = VIEW(PROJECT({ fixture: [{ name: 'warm', settings: { color: 'gold' } }] }));
  await ts.refreshToolbar();
  ov.setArmed('fixture', 'warm');
  let before = patches().length;
  await openFixture();
  await submit(small(), 'green');
  await waitUntil(() => patches().length > before, { timeout: 2000, what: 'the PATCH' });
  assert.deepEqual(patches().at(-1).body, { profiles: { fixture: [{ name: 'warm', settings: { color: 'green' } }] } });
  before = patches().length;
  await openFixture({ profile: null });
  await submit(small(), 'green');
  await waitUntil(() => patches().length > before, { timeout: 2000, what: 'the PATCH' });
  assert.deepEqual(patches().at(-1).body, { settings: { fixture: { color: 'green' } } });
});

test('readOnly: every field disabled, no Save, nothing sent', async () => {
  const before = patches().length;
  await openFixture({ readOnly: true });
  const root = rootOf(small());
  const fields = [...root.querySelectorAll('input, select, textarea')];
  assert.ok(fields.length >= 1);
  for (const f of fields) assert.equal(f.disabled, true, `${f.id} disabled`);
  assert.equal(root.querySelector('#submit'), null, 'no Save');
  assert.equal(root.querySelector('button[type=submit]'), null);
  root.querySelector('form').dispatchEvent(new W.Event('submit', { cancelable: true }));
  await shell.tick();
  assert.equal(patches().length, before, 'a read-only frame writes nothing');
});

test('a refused PATCH (403) shows the daemon\'s hint as text in the frame', async () => {
  const hint = 'Settings are written from the full level. Ask the host for full access.';
  patchAnswer = respond({ ok: false, remote: true, hint }, { status: 403 });
  shell.setRoutes(routes());
  await openFixture();
  await submit(small(), 'green');
  await waitUntil(() => small().querySelector('.ts-hint').textContent, { timeout: 2000, what: 'the hint' });
  const shown = small().querySelector('.ts-hint');
  assert.equal(shown.textContent, hint);
  assert.equal(shown.children.length, 0, 'as text');
  assert.ok(isOpen(small()), 'the frame stays open');
});

test('refusals: tool-drawn content, a non-object schema root, a bad level or type', () => {
  const tool = TS.openToolSettings({ type: 'fixture', level: 'small', content: 'tool', schema: SCHEMA, value: {} });
  assert.equal(tool.ok, false);
  assert.equal(tool.refused, 'tool-drawn');
  assert.equal(tool.hint, 'tool-drawn settings wait for pack review (4A/4B)');
  for (const schema of [{ type: 'string' }, { type: 'object' }, { type: 'object', properties: [] }, [], null, 'x']) {
    const r = TS.openToolSettings({ type: 'fixture', level: 'small', schema, value: {} });
    assert.equal(r.ok, false, JSON.stringify(schema));
    assert.equal(r.refused, 'bad-schema');
  }
  assert.equal(TS.openToolSettings({ type: 'fixture', level: 'medium', schema: SCHEMA }).refused, 'bad-level');
  assert.equal(TS.openToolSettings({ type: '', level: 'small', schema: SCHEMA }).refused, 'bad-type');
  assert.equal(TS.isToolSettingsOpen(), false, 'nothing opened');
  assert.ok(!isOpen(small()) && !isOpen(large()));
});

/* ── dismiss: the one layer and the one Escape owner ─────────────────────── */

test('an outside pointerdown closes the open frame; a press inside keeps it', async () => {
  await openFixture();
  pointerdown(rootOf(small()).querySelector('#f_color'));
  assert.ok(isOpen(small()), 'a press inside the shadow-rooted form keeps it');
  pointerdown(W.document.body);
  assert.ok(!isOpen(small()), 'an outside press closes it');
  assert.equal(TS.isToolSettingsOpen(), false);
  assert.equal(hostOf(small()), null, 'the host (and the form with it) is gone');
});

test('Escape closes the open frame through handleEscape, also from a field inside it', async () => {
  await openFixture();
  shell.key('Escape');
  assert.ok(!isOpen(small()), 'Escape closed it');
  assert.equal(TS.isToolSettingsOpen(), false, 'through the host\'s own close');
  assert.equal(hostOf(small()), null);
  await openFixture({ level: 'large' });
  shell.key('Escape', { target: rootOf(large()).querySelector('#f_color') });
  assert.ok(!isOpen(large()), 'Escape from the select inside closed it');
});

test('opening the other frame closes the first; one frame at a time', async () => {
  await openFixture();
  assert.ok(isOpen(small()));
  await openFixture({ level: 'large' });
  assert.ok(!isOpen(small()), 'the small frame closed');
  assert.ok(isOpen(large()), 'the large frame is open');
  assert.equal(hostOf(small()), null);
  const r = TS.openToolSettings({ type: 'fixture', level: 'small', schema: SCHEMA, value: {} });
  r.close();
  assert.ok(!isOpen(small()) && !isOpen(large()), 'close() closes it');
  await r.ready;
});

test('the frames are registered popovers: closeAllPopovers (another panel opening) closes them', async () => {
  await openFixture();
  W.dispatchEvent(new W.CustomEvent('wc:close-popovers'));
  assert.ok(!isOpen(small()));
});

test('tool-settings.js adds no document keydown or pointerdown listener', async () => {
  assert.doesNotMatch(SRC, /document\.addEventListener/, 'no document listener in the source');
  // A fresh instance of the module (its own frames), initialised and driven
  // under a wrapped addEventListener on the document and the window.
  const added = [];
  const wrap = (target, name) => {
    const orig = target.addEventListener;
    target.addEventListener = function (type, ...rest) { added.push(`${name}:${type}`); return orig.call(this, type, ...rest); };
    return () => { target.addEventListener = orig; };
  };
  const unwrapDoc = wrap(W.document, 'document');
  const unwrapWin = wrap(W, 'window');
  const already = new Set([...W.document.querySelectorAll('.tool-settings')]);
  try {
    const fresh = await import(`${pathToFileURL(path.join(REPO, 'public/app/tool-settings.js')).href}?listeners`);
    fresh.initToolSettings();
    const r = fresh.openToolSettings({ type: 'fixture', level: 'small', schema: SCHEMA, value: { color: 'gold' } });
    await r.ready;
    shell.key('Escape');
    fresh.closeToolSettings();
  } finally {
    unwrapDoc();
    unwrapWin();
    for (const el of W.document.querySelectorAll('.tool-settings')) if (!already.has(el)) el.remove();
  }
  assert.deepEqual(added.filter((a) => a.startsWith('document:')), [], 'no document listener at all');
  assert.deepEqual(added.filter((a) => /:(keydown|keyup|pointerdown|mousedown|click)$/.test(a)), [],
    'no keydown or pointerdown listener on the document or window');
});

/* ── placement of the small frame ────────────────────────────────────────── */

function anchorAt(rect) {
  const a = W.document.createElement('button');
  a.textContent = 'slot';
  W.document.body.appendChild(a);
  shell.scrollMetrics(a, { rect });
  return a;
}
const px = (v) => Number(String(v).replace(/px$/, ''));
const boxOf = (frame) => ({ left: px(frame.style.left), top: px(frame.style.top), right: px(frame.style.left) + FRAME_W, bottom: px(frame.style.top) + FRAME_H });

test('placement: below the anchor; flipped above and clamped inside the 16px gutter near the edges; placed again on resize', async () => {
  shell.scrollMetrics(small(), { rect: { width: FRAME_W, height: FRAME_H } });
  const ok = anchorAt({ left: 100, top: 40, width: 40, height: 30 });
  await openFixture({ anchor: ok });
  let b = boxOf(small());
  assert.equal(b.top, 40 + 30 + TS.GAP, 'below the anchor');
  assert.equal(b.left, 100, 'at its left');
  TS.closeToolSettings();

  const corner = anchorAt({ left: 1220, top: 740, width: 40, height: 30 });
  await openFixture({ anchor: corner });
  b = boxOf(small());
  assert.ok(b.bottom <= 740, `flipped above the anchor (bottom ${b.bottom})`);
  assert.equal(b.bottom, 740 - TS.GAP);
  assert.ok(b.left >= 16 && b.top >= 16, 'inside the gutter (left, top)');
  assert.ok(b.right <= DESKTOP.width - 16 && b.bottom <= DESKTOP.height - 16, `inside the gutter (right ${b.right})`);
  assert.equal(b.right, DESKTOP.width - 16, 'clamped against the right gutter');

  shell.setViewport({ width: 1000 });
  b = boxOf(small());
  assert.equal(b.right, 1000 - 16, 're-placed on resize');
  TS.closeToolSettings();
  ok.remove();
  corner.remove();
});

test('placement: at a 390×844 narrow viewport the small frame sits above #bottombar', async () => {
  shell.setViewport({ width: 390, height: 844, coarse: true });
  const narrowW = 390 - 32;
  shell.scrollMetrics(small(), { rect: { width: narrowW, height: FRAME_H } });
  shell.scrollMetrics($('bottombar'), { rect: { left: 0, top: 784, width: 390, height: 60 } });
  try {
    await openFixture({ anchor: $('bb-create') });
    const top = px(small().style.top);
    const left = px(small().style.left);
    assert.equal(top + FRAME_H, 784 - TS.GAP, 'its bottom is just above the bar');
    assert.ok(top >= 16, 'inside the top gutter');
    assert.ok(left >= 16 && left + narrowW <= 390 - 16, 'inside the side gutters');
    assert.equal(css.value(small(), 'width'), 'calc(100vw - 32px)', 'the narrow width: the viewport less two gutters');
  } finally {
    TS.closeToolSettings();
    shell.scrollMetrics(small(), { rect: { width: FRAME_W, height: FRAME_H } });
    shell.setViewport(DESKTOP);
  }
});

/* ── the no-life precondition, theming, reserved ids ─────────────────────── */

test('form-renderer\'s script starts no timer, subscription, request or window/document listener (no `life` is passed)', () => {
  const scripts = [...FORM_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'one script');
  const s = scripts[0];
  for (const [re, what] of [
    [/\bsetTimeout\b/, 'setTimeout'], [/\bsetInterval\b/, 'setInterval'], [/\brequestAnimationFrame\b/, 'requestAnimationFrame'],
    [/\.subscribe\(/, 'a store subscription'], [/\bfetch\(/, 'a request'],
    [/\b(window|document|globalThis|self)\s*\.\s*addEventListener\b/, 'a window/document listener'],
    [/\bon(keydown|keyup|pointerdown|click|resize|message)\s*=/, 'an on* handler property'],
  ]) assert.doesNotMatch(s, re, `form-renderer starts no ${what}: this host passes no life`);
  // Its one listener is on its own form, inside the root.
  assert.deepEqual([...s.matchAll(/([\w.()'"]+)\.addEventListener\(/g)].map((m) => m[1]), ["root.querySelector('form')"]);
});

// Every CSS named colour (CSS Color 4), plus the keywords that paint.
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
  + 'whitesmoke yellow yellowgreen transparent').split(/\s+/));
const COLOR_PROPS = /^(color|background|background-color|border|border-color|border-(top|right|bottom|left)(-color)?|outline|outline-color|accent-color|box-shadow|fill|stroke|caret-color|text-decoration-color)$/;

function colourFindings(text) {
  const out = [];
  for (const r of parseRules(stripComments(text))) {
    for (const [prop, raw] of r.decls) {
      const v = raw.replace(/var\(--wc-[\w-]+\)/g, ' ');
      if (/#[0-9a-fA-F]{3,8}\b/.test(v)) out.push(`${r.selector} ${prop}: hex`);
      if (/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(v)) out.push(`${r.selector} ${prop}: a colour function`);
      for (const w of v.toLowerCase().match(/[a-z][a-z-]*/g) || []) if (NAMED.has(w)) out.push(`${r.selector} ${prop}: ${w}`);
      if (COLOR_PROPS.test(prop) && !/var\(--wc-[\w-]+\)/.test(raw)) out.push(`${r.selector} ${prop}: not a --wc-* token`);
      if (/var\(--(?!wc-|z-)/.test(raw)) out.push(`${r.selector} ${prop}: a custom property outside --wc-*`);
    }
  }
  return out;
}

test('theming: app.css\'s U336 block and the host\'s shadow style spell no colour, only --wc-* tokens', () => {
  const at = CSS.indexOf('/* tool settings (U336)');
  assert.ok(at >= 0, 'the block is in app.css');
  const tail = CSS.slice(at);
  const next = tail.slice(2).search(/\n\/\* /);
  const block = next < 0 ? tail : tail.slice(0, next + 2);
  const rules = parseRules(stripComments(block));
  assert.ok(rules.length >= 5, `the block holds the frames' rules (${rules.length})`);
  assert.ok(rules.every((r) => /tool-settings|ts-/.test(r.selector)), 'the block styles only the host\'s own classes');
  assert.deepEqual(colourFindings(block), []);
  assert.deepEqual(colourFindings(TS.SHADOW_CSS), []);
  assert.ok(/var\(--wc-/.test(TS.SHADOW_CSS));
});

test('theming: an open frame is a fixed panel on the panel rung, hidden when closed', async () => {
  await openFixture();
  assert.equal(css.value(small(), 'position'), 'fixed');
  assert.equal(css.value(small(), 'z-index'), 'var(--z-panel)');
  assert.notEqual(css.value(small(), 'display'), 'none');
  TS.closeToolSettings();
  assert.equal(css.value(small(), 'display'), 'none');
  assert.equal(css.value(large(), 'transform'), 'translate(-50%, -50%)', 'the large frame is centred');
});

test('RESERVED_IDS holds the frame ids and U338\'s planned ids', () => {
  for (const id of ['tool-settings-small', 'tool-settings-large',
    'toolbar', 'tb-pointer', 'tb-slots', 'tb-reveal', 'tb-tray', 'tb-filter', 'bb-tools-reveal', 'bb-tools', 'bb-create']) {
    assert.ok(RESERVED_IDS.has(id), `${id} is reserved`);
  }
});
