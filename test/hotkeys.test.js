// The hotkey registry, public/app/hotkeys.js (annotation engine 2D.3, W-6), as a
// module: its table, the one key normaliser, the per-key merge of default ⊕
// user ⊕ project bindings, the seams later units resolve through, and what the
// hotkey pane will draw. No DOM: each test builds a registry of its own
// (createRegistry) over records it hands in — except the last-tool key's cases
// at the end (U404, F.4), which read the chrome's own registry as tools.js
// registers 'tools.last' in it (the real chrome, test-support/chrome-shell,
// booted once in before). The chrome itself — the key matrix, the legend, the
// palette and the titles — is test/hotkeys-shell.test.js's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { validChord } = require('../lib/core/toolbar-record');
const { bootShell } = require('../test-support/chrome-shell');

const REPO = path.resolve(__dirname, '..');
let hk, shell;
test.before(async () => {
  shell = await bootShell({});
  hk = await import(pathToFileURL(path.join(REPO, 'public/app/hotkeys.js')).href);
});
test.after(async () => { if (shell) await shell.restore(); });

const chrome = (action) => ({ kind: 'chrome', action });

// A registry with a few of the chrome's rows, over the records `rec` holds.
function fixture(rec = {}) {
  const ran = [];
  const reg = hk.createRegistry({ records: () => rec });
  const row = (id, chord, extra = {}) => reg.registerAction({ id, label: id, defaultChord: chord, run: () => ran.push(id), ...extra });
  row('chrome.graph', 'G');
  row('chrome.comment', 'C');
  row('chrome.replay', 'R');
  row('chrome.prev', '[');
  row('chrome.palette', 'Mod+K', { context: ['page', 'overlay'], whenField: true, rebindable: false });
  row('chrome.legend', ['?', 'Shift+/'], { context: ['page', 'overlay'] });
  reg.registerAction({ id: 'graph.bookmark', label: 'Bookmark node', defaultChord: 'B', context: 'overlay', run: null });
  const press = (chord, ctx, opts) => { const a = reg.lookup(chord, ctx, opts); if (a) a.run(); return a; };
  return { reg, ran, press, rec };
}

test('registerAction refuses a duplicate id, a bad id, a bad context', () => {
  const { reg } = fixture();
  assert.throws(() => reg.registerAction({ id: 'chrome.graph', label: 'again', defaultChord: 'H', run: () => {} }),
    /already registered/);
  assert.throws(() => reg.registerAction({ id: 'Chrome Graph', label: 'x', run: () => {} }), /not an action id/);
  assert.throws(() => reg.registerAction({ id: 'chrome.x', label: 'x', context: 'everywhere', run: () => {} }),
    /context 'everywhere'/);
  assert.throws(() => reg.registerAction({ id: 'chrome.y', label: 'y', run: 'nope' }), /run is a function or null/);
});

test('lookup honours the context: G does nothing while the overlay owns the keys; ? and ⌘K answer there', () => {
  const { press, ran } = fixture();
  assert.equal(press('G', 'overlay'), null);
  assert.deepEqual(ran, []);
  assert.equal(press('G', 'page').id, 'chrome.graph');
  assert.equal(press('?', 'overlay').id, 'chrome.legend');
  assert.equal(press('Mod+K', 'overlay').id, 'chrome.palette');
  // A descriptive row is never looked up, in its own context or any other.
  assert.equal(press('B', 'overlay'), null);
  assert.equal(press('B', 'page'), null);
  assert.deepEqual(ran, ['chrome.graph', 'chrome.legend', 'chrome.palette']);
});

test('a single key never answers from a field; ⌘K (whenField) does', () => {
  const { press } = fixture();
  assert.equal(press('C', 'page', { inField: true }), null);
  assert.equal(press('?', 'page', { inField: true }), null);
  assert.equal(press('Mod+K', 'page', { inField: true }).id, 'chrome.palette');
});

test('Shift: a binding on X answers Shift+X unless Shift+X has an entry of its own', () => {
  const rec = { user: { bindings: {} } };
  const { press, reg } = fixture(rec);
  assert.equal(press('Shift+[', 'page').id, 'chrome.prev', 'the head matched [ whatever Shift said');
  assert.equal(press('Shift+G', 'page').id, 'chrome.graph');
  assert.equal(press('/', 'page'), null, 'a bare / is not the legend');
  assert.equal(press('Shift+/', 'page').id, 'chrome.legend');
  assert.equal(press('Shift+?', 'page').id, 'chrome.legend');
  rec.user.bindings = { 'Shift+G': null, 'Shift+R': chrome('chrome.comment') };
  reg.refresh();
  assert.equal(press('Shift+G', 'page'), null, 'an explicit unbind of Shift+G holds');
  assert.equal(press('Shift+R', 'page').id, 'chrome.comment', 'Shift+R has its own binding');
  assert.equal(press('R', 'page').id, 'chrome.replay');
});

test('enabled() false: the press is the page\'s', () => {
  const reg = hk.createRegistry();
  let on = false;
  reg.registerAction({ id: 'chrome.chat', label: 'Chat', defaultChord: 'M', enabled: () => on, run: () => {} });
  assert.equal(reg.lookup('M', 'page'), null);
  on = true;
  assert.equal(reg.lookup('M', 'page').id, 'chrome.chat');
});

test('a user-tier binding H → chrome.graph makes H open the graph and leaves G bound', () => {
  const { press, reg } = fixture({ user: { bindings: { H: chrome('chrome.graph') } }, project: null });
  assert.equal(press('H', 'page').id, 'chrome.graph');
  assert.equal(press('G', 'page').id, 'chrome.graph');
  assert.deepEqual(reg.keysFor('chrome.graph'), ['G', 'H'], 'the default first, then the user\'s');
  const h = reg.bindingsView().find((b) => b.chord === 'H');
  assert.equal(h.tier, 'user');
  assert.equal(h.inert, null);
  assert.deepEqual(h.context, ['page']);
});

test('a project-tier {G: null} unbinds G for this project; the user tier\'s G is kept, shadowed', () => {
  const rec = { user: { bindings: { G: chrome('chrome.graph') } }, project: { bindings: { G: null } } };
  const { press, reg } = fixture(rec);
  assert.equal(press('G', 'page'), null);
  const g = reg.bindingsView().find((b) => b.chord === 'G');
  assert.equal(g.unbound, true);
  assert.equal(g.tier, 'project');
  assert.deepEqual(g.shadows.map((s) => s.tier), ['user', 'default']);
  assert.deepEqual(g.shadows[0].value, chrome('chrome.graph'));
  assert.equal(reg.keyFor('chrome.graph'), '', 'no key runs it here');
  // Another project (no project record) keeps the user's G.
  rec.project = null;
  reg.refresh();
  assert.equal(press('G', 'page').id, 'chrome.graph');
});

test('a chrome action is rebound in the user record only: a project chrome binding is inert (G1)', () => {
  const { press, reg } = fixture({ project: { bindings: { J: chrome('chrome.graph') } } });
  assert.equal(press('J', 'page'), null);
  assert.match(reg.bindingsView().find((b) => b.chord === 'J').inert, /user record only/);
});

test('a binding to an unknown action, to a fixed row, or of an unregistered kind is inert with a reason', () => {
  const { press, reg } = fixture({ user: { bindings: {
    U: chrome('chrome.nope'), V: { kind: 'slot', n: 1 }, W: chrome('chrome.palette'), X: chrome('graph.bookmark'),
  } } });
  const view = Object.fromEntries(reg.bindingsView().filter((b) => !b.descriptive).map((b) => [b.chord, b]));
  assert.match(view.U.inert, /no chrome action 'chrome\.nope'/);
  assert.match(view.V.inert, /no resolver for the kind 'slot'/);
  assert.match(view.W.inert, /not rebindable/);
  assert.match(view.X.inert, /descriptive row/);
  for (const c of ['U', 'V', 'W', 'X']) assert.equal(press(c, 'page'), null, `${c} does nothing`);
  assert.equal(view.G.inert, null);
});

test('registerTargetKind: a slot or tool binding resolves through its kind\'s resolver', () => {
  const ran = [];
  const { reg, press } = fixture({ user: { bindings: { 1: { kind: 'slot', n: 1 }, 2: { kind: 'slot', n: 2 } } } });
  const off = reg.registerTargetKind('slot', (t) => (t.n === 1 ? { label: 'Slot 1', run: () => ran.push(t.n) } : null));
  assert.equal(press('1', 'page').label, 'Slot 1');
  assert.deepEqual(ran, [1]);
  assert.equal(press('2', 'page'), null);
  assert.match(reg.bindingsView().find((b) => b.chord === '2').inert, /found nothing/);
  assert.throws(() => reg.registerTargetKind('chrome', () => null), /cannot be registered/);
  off();
  assert.equal(press('1', 'page'), null);
});

test('conflicts(): a later default source\'s claim on C is left unbound and listed; C stays the chrome\'s', () => {
  const { reg, press } = fixture();
  reg.registerTargetKind('tool', (t) => ({ label: t.type, run: () => {} }));
  reg.setDefaultSource('tools', () => [
    { chord: 'H', target: { kind: 'tool', type: 'highlight' }, label: 'Highlight' },
    { chord: 'C', target: { kind: 'tool', type: 'comment' }, label: 'Comment' },
    { chord: 'C', target: { kind: 'tool', type: 'box-grab' }, label: 'Box grab' },
  ]);
  assert.equal(press('C', 'page').id, 'chrome.comment');
  assert.equal(press('H', 'page').label, 'highlight');
  assert.deepEqual(reg.conflicts().map((c) => [c.chord, c.winner.source, c.winner.target, c.source, c.target]), [
    ['C', 'chrome', chrome('chrome.comment'), 'tools', { kind: 'tool', type: 'box-grab' }],
    ['C', 'chrome', chrome('chrome.comment'), 'tools', { kind: 'tool', type: 'comment' }],
  ], 'by target within a source, deterministic');
  const h = reg.bindingsView().find((b) => b.chord === 'H');
  assert.equal(h.tier, 'default');
  assert.equal(h.label, 'highlight');
});

test('keyFor: the display of the first bound chord', () => {
  const { reg } = fixture({ user: { bindings: { R: null, 'Shift+R': chrome('chrome.replay') } } });
  assert.equal(reg.keyFor('chrome.palette'), '⌘K');
  assert.equal(reg.keyFor('chrome.comment'), 'C');
  assert.equal(reg.keyFor('chrome.prev'), '[');
  assert.equal(reg.keyFor('chrome.legend'), '?');
  assert.equal(reg.keyFor('chrome.replay'), '⇧R');
  assert.equal(reg.keyFor('graph.bookmark'), 'B', 'a descriptive row shows what it lists');
  assert.equal(reg.keyFor('chrome.none'), '');
  assert.equal(hk.displayChord('ArrowLeft'), '←');
  assert.equal(hk.displayChord('Enter'), '↵');
  assert.equal(hk.displayChord('Escape'), 'Esc');
});

test('a record that cannot be merged leaves the defaults', () => {
  const { press } = fixture({ user: { bindings: ['not', 'a', 'record'] } });
  const orig = console.error;
  console.error = () => {};
  try { assert.equal(press('G', 'page').id, 'chrome.graph'); } finally { console.error = orig; }
});

// The key matrix's events (test/hotkeys-shell.test.js's axes): every chord
// chordOf makes of them is one the toolbar record's grammar accepts — there is
// no second chord grammar — except the Mod+ chords, which that grammar refuses
// by design (no record may bind one), and of which the chrome claims only ⌘K.
test('chordOf: every chord it makes of the matrix\'s events is lib/core/toolbar-record\'s', () => {
  const keys = [...'qpgntsrcmb'].map((k) => ({ key: k }))
    .concat([{ key: '[' }, { key: ']' }, { key: '?' }, { key: '/', shiftKey: true }, { key: '/' },
      { key: 'k', metaKey: true }, { key: 'k', ctrlKey: true }]);
  const mods = [
    (i) => ({ ...i }),
    (i) => ({ ...i, key: /^[a-z]$/.test(i.key) ? i.key.toUpperCase() : i.key, shiftKey: true }),
    (i) => ({ ...i, altKey: true }),
  ];
  const seen = new Set();
  for (const k of keys) for (const m of mods) seen.add(hk.chordOf(m(k)));
  assert.ok(!seen.has(null));
  const mod = [...seen].filter((c) => c.startsWith('Mod+'));
  assert.deepEqual(mod, ['Mod+K']);
  assert.equal(validChord('Mod+K'), null, 'the grammar refuses Mod+: no record can bind it');
  for (const c of seen) if (!c.startsWith('Mod+')) assert.equal(validChord(c), c, `${c} is the grammar's own spelling`);
  // Alt is never read; Shift is kept; a letter is uppercased.
  assert.equal(hk.chordOf({ key: 'q', altKey: true }), 'Q');
  assert.equal(hk.chordOf({ key: 'Q', shiftKey: true }), 'Shift+Q');
  assert.equal(hk.chordOf({ key: 'K', metaKey: true, shiftKey: true }), 'Mod+K');
  // Every single key and named key the grammar accepts comes out as the grammar spells it.
  for (const k of [...'abcxyz0123456789', '[', ']', '/', '?', ',', '.', ';', '\'', '-', '=', '\\', '`',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'F1', 'F12']) {
    assert.equal(hk.chordOf({ key: k }), validChord(k), k);
    assert.equal(hk.chordOf({ key: k, shiftKey: true }), validChord(`Shift+${k}`), `Shift+${k}`);
  }
  assert.equal(hk.chordOf({ key: ' ' }), validChord('Space'));
  for (const k of ['Escape', 'Tab', 'Shift', 'Meta', 'Control', 'Alt', '']) assert.equal(hk.chordOf({ key: k }), null, k);
});

test('the chrome\'s registry is one module-wide table: its exports are bound to it', () => {
  assert.equal(typeof hk.registerAction, 'function');
  assert.equal(typeof hk.lookup, 'function');
  assert.deepEqual(hk.CONTEXTS, ['page', 'overlay', 'replay', 'drawer', 'sheet']);
});

// The conventions ratchet's single-key row (test/conventions.test.js, the last
// PATTERNS row), read from that file so there is no second copy of its regex:
// shell.js holds none now, graph-view.js's overlay switch its baseline, and a
// `case 'x':` or an `e.key === 'x'` planted in a scratch copy of a public/app
// file is counted, which the ratchet reports against a baseline of 0.
test('the single-key ratchet row: shell.js 0, graph-view.js its baseline, a planted comparison reported', (t) => {
  const src = fs.readFileSync(path.join(REPO, 'test/conventions.test.js'), 'utf8');
  const at = src.indexOf('name: "e.key === \'x\' / case \'x\':');
  assert.notEqual(at, -1, 'the row is in PATTERNS');
  const m = /\n\s*re: \/(.+)\/([a-z]*),\n/.exec(src.slice(at));
  assert.ok(m, 'the row has a regex literal');
  const re = new RegExp(m[1], m[2]);
  const count = (text) => (text.match(re) || []).length;
  const appDir = path.join(REPO, 'public/app');
  const counts = {};
  for (const f of fs.readdirSync(appDir, { recursive: true })) {
    if (!String(f).endsWith('.js')) continue;
    const n = count(fs.readFileSync(path.join(appDir, f), 'utf8'));
    if (n) counts[`public/app/${String(f).split(path.sep).join('/')}`] = n;
  }
  assert.deepEqual(counts, { 'public/app/graph-view.js': 8 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotkeys-ratchet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const copy = path.join(dir, 'shell.js');
  fs.writeFileSync(copy, fs.readFileSync(path.join(appDir, 'shell.js'), 'utf8')
    + "\nfunction planted(e) { switch (e.key) { case 'x': break; } return e.key === 'y'; }\n");
  assert.equal(count(fs.readFileSync(copy, 'utf8')), 2, 'both planted comparisons are counted');
});

// ── the last-tool key (U404; F.4, REQ@tool-toggle-key M1) ────────────────────
// ONE chrome action, 'tools.last', which tools.js registers in the chrome's
// registry (the one hk's module-wide exports are bound to): Space by default,
// in the page context only; never from a field; stood down while focus sits
// on a control (pierced through a shadow root), never on a focus sink.
async function records(user = {}, project = {}) {
  await shell.frame({ type: 'toolbar', v: 1, project: { v: 1, pinned: [], hidden: [], settings: {}, profiles: {}, ...project },
    user: { v: 1, bindings: {}, fingerDraws: false, settings: {}, ...user }, merged: { bindings: {}, settings: {} } });
}
function blurAll() {
  const W = shell.window;
  let a = W.document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) { const inner = a.shadowRoot.activeElement; inner.blur(); a = W.document.activeElement; if (a === inner) break; }
  if (W.document.activeElement && W.document.activeElement !== W.document.body) W.document.activeElement.blur();
}
const idOf = (a) => (a ? a.id : null);

test('tools.last: Space in the page context; never in a field, never in the overlay or the replay context', async () => {
  await records();
  blurAll();
  assert.equal(idOf(hk.lookup('Space', 'page')), 'tools.last');
  assert.equal(idOf(hk.lookup('Shift+Space', 'page')), 'tools.last', 'Shift+Space answers it too (the Shift fallback)');
  assert.equal(hk.lookup('Space', 'page', { inField: true }), null, 'a field keeps Space');
  assert.equal(hk.lookup('Space', 'overlay'), null, 'the graph overlay keeps its own Space (the glance)');
  assert.equal(hk.lookup('Space', 'replay'), null, 'the replay player keeps its own Space');
  const row = hk.bindingsView().find((b) => b.chord === 'Space' && !b.descriptive);
  assert.equal(row.action, 'tools.last');
  assert.equal(row.tier, 'default');
  assert.deepEqual(row.context, ['page']);
  assert.equal(row.label, 'Put down / pick up the last tool');
  assert.equal(hk.keyFor('tools.last'), 'Space');
});

test('tools.last enabled(): false with focus on a control (a pane button or a chrome checkbox, pierced through a shadow root); true on #stage, on body and on a [tabindex=-1] container', async (t) => {
  await records();
  const W = shell.window;
  const d = W.document;
  const host = d.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const paneBtn = d.createElement('button');
  paneBtn.textContent = 'in a pane';
  const paneBox = d.createElement('input');
  paneBox.type = 'checkbox';
  root.append(paneBtn, paneBox);
  d.getElementById('main').appendChild(host);
  const box = d.createElement('input');
  box.type = 'checkbox';
  d.getElementById('topbar').appendChild(box);
  const sink = d.createElement('div');
  sink.tabIndex = -1;
  d.getElementById('topbar').appendChild(sink);
  const sinkBtn = d.createElement('button');
  sinkBtn.tabIndex = -1;
  d.getElementById('topbar').appendChild(sinkBtn);
  t.after(() => { host.remove(); box.remove(); sink.remove(); sinkBtn.remove(); blurAll(); });
  for (const [name, el] of [['a pane button', paneBtn], ['a pane checkbox', paneBox], ['a chrome checkbox', box],
    ['a [tabindex=-1] button', sinkBtn]]) {
    blurAll();
    el.focus();
    assert.equal(hk.lookup('Space', 'page'), null, `focus on ${name}: Space is the control's`);
  }
  assert.equal(d.activeElement, sinkBtn);
  for (const [name, focus] of [
    ['#stage', () => d.getElementById('stage').focus()],
    ['body', () => blurAll()],
    ['a [tabindex=-1] container', () => sink.focus()],
  ]) {
    blurAll();
    focus();
    assert.equal(idOf(hk.lookup('Space', 'page')), 'tools.last', `focus on ${name}: the key is the page's`);
  }
  assert.equal(d.activeElement, sink);
});

test('tools.last: rebound in the user record, unbound by a project record, inert as a project chrome binding (G1)', async () => {
  blurAll();
  const last = { kind: 'chrome', action: 'tools.last' };
  await records({ bindings: { Space: null, L: last } });
  assert.equal(hk.lookup('Space', 'page'), null, 'the user moved it off Space');
  assert.equal(idOf(hk.lookup('L', 'page')), 'tools.last');
  assert.deepEqual(hk.keysFor('tools.last'), ['L']);
  await records({}, { bindings: { Space: null } });
  assert.equal(hk.lookup('Space', 'page'), null, 'unbound in this project');
  assert.equal(hk.keyFor('tools.last'), '');
  await records({}, { bindings: { J: last } });
  assert.equal(hk.lookup('J', 'page'), null);
  assert.match(hk.bindingsView().find((b) => b.chord === 'J').inert, /user record only/);
  assert.equal(idOf(hk.lookup('Space', 'page')), 'tools.last', 'the default holds');
  await records();
});
