// The chrome's read-only at a stamped read (annotation engine tranche 6, U757;
// PLAN-T6 §2.3 6B.2; contract 04 C-04.18b, C-04.25; 06 C-06.34a; RULED
// U757@read-level-hint (c), U743-U757@remote-private-create-vs-ink (b),
// U742@reports-remote-relayed (b)), in the real chrome (test-support/
// chrome-shell, booted once) as a REMOTE page with an answer origin, its
// mirror level answered by GET /api/mirror (and /api/mirror/access) from one
// variable the tests move.
//
// Pinned here:
//   - at level read every pane is content read-only and layout-locked:
//     typing, a checkbox toggle and a submit are refused, the pane's host
//     carries data-wc-readonly, and the note shows READ_LEVEL_HINT, which
//     names no host command;
//   - a mirror:access frame read → full makes the same pane (no remount)
//     editable, full → read read-only again;
//   - a preview at full (and at read) still shows READONLY_HINT;
//   - at read a tray action and the highlight popover show READ_LEVEL_HINT and
//     send nothing (TRAY_REFUSAL is the same object, its hint the chooser's);
//   - a plug-in type's create ctx carries private_allowed, frozen: false on a
//     remote or embedded chrome, true on a local one; the type's create sends
//     what it chose;
//   - at a stamped read no elements report frame is mounted
//     (overlay-report-remote.js's mayAct gate); at full it is.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const { bootShell, helloFrame, respond, DEFAULT_ROUTES } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const AORIGIN = 'https://wc-0a1b2c3d-a.example.com';
const HUB = 'https://hub.example.com';
const PANE = { id: 'sr-form', target: 'main', params: {}, gen: 0,
  html: '<form id="f"><input id="t" type="text"><input id="c" type="checkbox"><button id="s">Go</button></form>' };
const OLD = { id: 'sr-old', target: 'main', params: {}, gen: 0, html: '<form><input id="o" type="text"></form>' };
const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: 1 },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: 2 },
];

let shell, W, M, topbar, ET, HL, cs, st, remote;
let access = { level: 'read', remote: true };
let rev = 100;
const snapshot = () => ({
  v: 1, enabled: true, now: Date.now(), rev: ++rev, content: true, access, capabilities: {},
  primary: null, aggregate: { state: 'idle' }, conversations: [], tasks: [], asks: [],
});

const REMOTE_HEALTH = () => respond({ ok: true, remote: true }, { headers: { 'X-WC-Answer-Origin': AORIGIN } });
let health = REMOTE_HEALTH;

const SHA = 'd'.repeat(64);
const BASE = DEFAULT_ROUTES['/api/elements/types'];
const plugRow = (type) => ({
  type, schema: `${type}@1`, reads: [`${type}@1`], anchors: ['element'], family: 'page',
  remote: { see: 'read', send: 'full' }, private: false, builtin: false, tier: 'local', pack: 'ink-pack',
  toolbar: { input: 'taps', payload: { keys: ['anchor', 'shared', 'tool'] } }, draw: { sha256: SHA },
});
let listing = { ok: true, types: [...BASE.types], reserved: [...BASE.reserved] };

const writes = () => shell.calls.filter((c) => c.method !== 'GET' && c.url.startsWith('/api/elements')
  && !c.url.startsWith('/api/elements/types'));
const noteText = () => { const n = W.document.querySelector('#reaim-note .reaim-note-text'); return n ? n.textContent : ''; };
const clearNote = () => { const n = W.document.querySelector('#reaim-note .reaim-note-text'); if (n) n.textContent = ''; };
const reportFrames = () => [...W.document.querySelectorAll('iframe.wc-answer-frame[data-kind="elements"]')];
const pane = (id) => M.panes.get(id);
const q = (id, sel) => pane(id).root.querySelector(sel);
const HOST_COMMAND = /claude-web-chat|tunnel|terminal|\brun\b|`|set this node active/i;

// One gesture of each kind on the form pane: whether each was refused.
function gestures(id = PANE.id) {
  const input = q(id, '#t');
  const box = q(id, '#c');
  const form = q(id, '#f');
  const key = new W.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true, composed: true });
  input.dispatchEvent(key);
  const bi = new W.InputEvent('beforeinput', { data: 'a', inputType: 'insertText', bubbles: true, cancelable: true, composed: true });
  input.dispatchEvent(bi);
  const wasChecked = box.checked;
  const toggle = new W.MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
  box.dispatchEvent(toggle);
  const toggled = box.checked !== wasChecked;
  if (toggled) box.checked = wasChecked;   // put it back for the next round
  const submit = new W.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(submit);
  return { typing: key.defaultPrevented && bi.defaultPrevented, toggle: toggle.defaultPrevented && !toggled, submit: submit.defaultPrevented };
}

// Move the mirror level the way the daemon does: the next read answers it,
// and the mirror:access frame says it.
async function moveLevel(level) {
  access = { level, remote: true };
  await shell.frame({ type: 'mirror:access', level, remote: true });
  await waitUntil(() => cs.mirror.access.level === level, { timeout: 5000, what: `the mirror level ${level}` });
  await shell.tick();
}

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/health': () => health(),
      '/api/mirror': () => snapshot(),
      '/api/mirror/access': () => ({ ok: true, level: access.level, remote: true, commands: {} }),
      '/api/asks': () => ({ asks: [], answer: null }),
      '/api/graph': { nodes: NODES.map((n) => ({ ...n })), active: 'n1' },
      '/api/graph/node/n2': { id: 'n2', label: 'n1.1', mounts: [OLD], store: {} },
      '/api/elements/types': () => listing,
      '/api/elements': (url, init) => (String((init && init.method) || 'GET').toUpperCase() === 'GET'
        ? { ok: true, elements: [], next_cursor: 0 } : { ok: true, element: { id: 'e1', v: 1, type: 'ink' } }),
    },
  });
  W = shell.window;
  M = await shell.importApp('mounts.js');
  topbar = await shell.importApp('topbar.js');
  ET = await shell.importApp('element-types.js');
  HL = await shell.importApp('highlight.js');
  cs = await shell.importApp('chat-state.js');
  st = await shell.importApp('state.js');
  remote = await shell.importApp('remote.js');
  await shell.frame(helloFrame({ mounts: [PANE], elements: [] }));
  await waitUntil(() => cs.mirror.access.level === 'read' && pane(PANE.id), { timeout: 5000, what: 'the read hello' });
  await shell.tick();
});

after(async () => { if (shell) await shell.restore(); });

test('at a stamped read every pane is content read-only and layout-locked, and the note names no host command', async () => {
  assert.equal(M.readLevel(), true);
  assert.equal(M.contentReadOnly(), true, 'content read-only with no preview');
  assert.equal(st.view.previewing, false);
  assert.equal(M.layoutLocked(), true, 'layout-locked through it');
  assert.equal(pane(PANE.id).host.hasAttribute('data-wc-readonly'), true, 'the host is marked');
  clearNote();
  const r = gestures();
  assert.deepStrictEqual(r, { typing: true, toggle: true, submit: true }, 'typing, the toggle and the submit refused');
  assert.equal(noteText(), topbar.READ_LEVEL_HINT, 'the read level\'s words');
  assert.doesNotMatch(topbar.READ_LEVEL_HINT, HOST_COMMAND, 'no host command (C-06.34a)');
  assert.notEqual(topbar.READ_LEVEL_HINT, topbar.READONLY_HINT);
  assert.equal(topbar.readOnlyHint(), topbar.READ_LEVEL_HINT);
  // A layout gesture is refused with the same words (not the phone's).
  clearNote();
  M.refuseLayoutGesture({ id: PANE.id });
  assert.equal(noteText(), topbar.READ_LEVEL_HINT);
});

test('a mirror:access frame read → full makes the same pane editable with no remount; full → read read-only again', async () => {
  const host = pane(PANE.id).host;
  await moveLevel('full');
  assert.strictEqual(pane(PANE.id).host, host, 'the same pane, no remount');
  assert.equal(M.contentReadOnly(), false);
  assert.equal(M.layoutLocked(), false, 'a desktop at full is not layout-locked');
  assert.equal(host.hasAttribute('data-wc-readonly'), false);
  clearNote();
  assert.deepStrictEqual(gestures(), { typing: false, toggle: false, submit: false }, 'editable at full');
  assert.equal(noteText(), '', 'no note at full');
  await moveLevel('read');
  assert.strictEqual(pane(PANE.id).host, host, 'still the same pane');
  assert.equal(host.hasAttribute('data-wc-readonly'), true);
  assert.deepStrictEqual(gestures(), { typing: true, toggle: true, submit: true });
  // Levels other than read are unchanged: basic arms nothing.
  await moveLevel('basic');
  assert.equal(M.contentReadOnly(), false, 'basic is not the read arm');
  assert.equal(host.hasAttribute('data-wc-readonly'), false);
  await moveLevel('read');
});

test('a preview shows READONLY_HINT, at full and at read alike', async () => {
  for (const level of ['full', 'read']) {
    await moveLevel(level);
    await topbar.previewNode('n2');
    await waitUntil(() => pane(OLD.id), { timeout: 5000, what: 'the previewed pane' });
    try {
      assert.equal(st.view.previewing, true);
      assert.equal(topbar.readOnlyHint(), topbar.READONLY_HINT, `${level}: the preview's words`);
      clearNote();
      const key = new W.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true, composed: true });
      q(OLD.id, '#o').dispatchEvent(key);
      assert.equal(key.defaultPrevented, true);
      assert.equal(noteText(), topbar.READONLY_HINT, `${level}: the note is the preview's, unchanged`);
    } finally {
      topbar.leavePreview({ restoreSnapshot: true });
      await shell.tick();
    }
  }
  assert.equal(st.view.previewing, false);
  assert.equal(M.readLevel(), true);
});

test('at read a tray action and the highlight popover show READ_LEVEL_HINT and send nothing', async () => {
  assert.equal(M.readLevel(), true);
  const n0 = writes().length;
  let ran = 0;
  clearNote();
  const r = ET.trayAction(() => { ran += 1; return { ok: true }; });
  assert.strictEqual(r, ET.TRAY_REFUSAL, 'the guard\'s one refusal object');
  assert.equal(ran, 0, 'run never called');
  assert.deepStrictEqual([r.ok, r.refused, r.hint], [false, 'read-only', topbar.READ_LEVEL_HINT]);
  assert.equal(noteText(), topbar.READ_LEVEL_HINT);
  assert.equal(ET.trayReadOnly(), true);
  // Send to Claude through the guard: refused, nothing sent.
  const s = await ET.sendToClaude('e1');
  assert.strictEqual(s, ET.TRAY_REFUSAL);
  // The highlight popover draws its read-only branch with the read words.
  const box = W.document.createElement('div');
  box._hlIds = new Set(['h-read']);
  W.document.body.appendChild(box);
  const pop = HL.openNote(box);
  try {
    assert.ok(pop, 'the note opened');
    assert.equal(pop.querySelector('textarea'), null, 'nothing to edit');
    assert.equal(pop.querySelector('.hl-save, .hl-delete, .hl-send'), null, 'no save, delete or send');
    assert.equal(pop.querySelector('.hl-pop-hint').textContent, topbar.READ_LEVEL_HINT);
  } finally {
    W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    box.remove();
  }
  assert.equal(writes().length, n0, 'no request at all');
  // At full the refusal's hint is the preview's again, and the guard lets a write through.
  await moveLevel('full');
  assert.equal(ET.TRAY_REFUSAL.hint, topbar.READONLY_HINT);
  assert.deepStrictEqual(ET.trayAction(() => ({ ok: true })), { ok: true });
  await moveLevel('read');
});

test('at a stamped read no elements report frame is mounted; at full on this remote page it is', async () => {
  await moveLevel('full');
  await waitUntil(() => reportFrames().length === 1, { timeout: 5000, what: 'the report frame at full' });
  await moveLevel('read');
  await waitUntil(() => reportFrames().length === 0, { timeout: 5000, what: 'the report frame taken down at read' });
  // A fresh hello at read mounts none either.
  await shell.frame(helloFrame({ mounts: [PANE], surface: 3001, elements: [] }));
  await shell.tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(reportFrames().length, 0, 'none at read');
});

// ── private_allowed on a plug-in type's create ctx ──────────────────────────
const regs = new Map();
const stub = {
  registerType(type, spec) { regs.set(type, spec); return () => { if (regs.get(type) === spec) regs.delete(type); }; },
  onAnswers() { return () => {}; },
};
const seenCreate = [];
const fixture = {
  default: function draw(group) { group.container.textContent = 'ink'; },
  create(input, ctx) {
    seenCreate.push(ctx);
    // The type decides: shared where private is not offered.
    ctx.tray.add({ anchor: null, payload: { anchor: null, shared: ctx.private_allowed !== true, tool: 'pen' } });
  },
};
const fakeImport = (url) => (url === ET.drawPath('ink', SHA) ? Promise.resolve(fixture) : Promise.reject(new Error(`no module at ${url}`)));

async function settle(answer, { framed = false } = {}) {
  health = answer;
  await remote.resetEmbedForTests({ framed, parent: { postMessage() {} } });
  await shell.tick();
}
async function createOnce() {
  const added = [];
  const tray = { add: (a) => { added.push(a); return Promise.resolve({ ok: true }); } };
  seenCreate.length = 0;
  regs.get('ink').create({ phase: 'click' }, { probe: 7, tray });
  assert.equal(seenCreate.length, 1, 'the type\'s create ran');
  return { ctx: seenCreate[0], added };
}

test('a plug-in type\'s create ctx carries private_allowed, frozen: false remote or embedded, true local; the type\'s create sends what it chose', async () => {
  ET.initElementTypes({ importModule: fakeImport, overlay: stub });
  listing = { ok: true, types: [...BASE.types, plugRow('ink')], reserved: [...BASE.reserved] };
  assert.equal((await ET.loadTypes()).ok, true);
  await ET.loadPluginTypes();
  assert.ok(regs.get('ink') && typeof regs.get('ink').create === 'function', 'the plug-in type is registered with its create');
  try {
    // This page is remote.
    assert.equal(remote.remoteNow(), true);
    let { ctx, added } = await createOnce();
    assert.equal(ctx.private_allowed, false, 'remote: private is not offered');
    assert.equal(ctx.probe, 7, 'the overlay\'s ctx passes through');
    const d = Object.getOwnPropertyDescriptor(ctx, ET.PRIVATE_ALLOWED_KEY);
    assert.deepStrictEqual([d.writable, d.configurable, d.enumerable], [false, false, true]);
    assert.throws(() => { 'use strict'; ctx.private_allowed = true; }, TypeError);
    assert.equal(ctx.private_allowed, false, 'an assignment leaves it unchanged');
    assert.deepStrictEqual(added, [{ anchor: null, payload: { anchor: null, shared: true, tool: 'pen' } }], 'the type sent shared: true');
    // A local chrome offers private.
    await settle(() => ({ ok: true, remote: false }));
    assert.equal(remote.remoteNow(), false);
    ({ ctx, added } = await createOnce());
    assert.equal(ctx.private_allowed, true, 'local: private is offered');
    assert.deepStrictEqual(added[0].payload, { anchor: null, shared: false, tool: 'pen' }, 'the type\'s own choice, not rewritten');
    // The embedded chrome (L.8 V1's one flag) does not.
    await settle(() => respond({ ok: true, remote: false }, { headers: { 'X-WC-Embedded': '1', 'X-WC-Embed-Parent': HUB } }), { framed: true });
    assert.equal(remote.isEmbedded(), true);
    ({ ctx } = await createOnce());
    assert.equal(ctx.private_allowed, false, 'embedded: private is not offered');
    // A built-in's create is the overlay's own, with no such field.
    let builtinCtx = null;
    const off = ET.registerElementType('plain-create', { draw() {}, create: (input, c) => { builtinCtx = c; } });
    try {
      const given = { probe: 1 };
      regs.get('plain-create').create({}, given);
      assert.strictEqual(builtinCtx, given, 'a built-in\'s create ctx is untouched');
    } finally { off(); }
  } finally {
    await settle(REMOTE_HEALTH);
    listing = { ok: true, types: [...BASE.types], reserved: [...BASE.reserved] };
  }
});
