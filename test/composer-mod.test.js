// U91 — the composer on the mod in the chrome (public/app/composer-mod.js,
// and chat-composer.js's three seams): design spec §15.7, §7.13; ruled D4 (a),
// D6 (a), F7 (a).
//
//   * The '/' rows: with the followed conversation's process.mod and the mod
//     capability, plan, compact, context, rename and recap lead the list with
//     2.1.296's descriptions, labelled 'runs in the terminal'; Enter inserts
//     '/plan '. With no mod none is listed; /model never is.
//   * The chrome's SAFE_MOD_COMMANDS equals lib/server/composer.js's, and the
//     module loads with no DOM (a node process of its own).
//   * Images: a pasted PNG posts once to /api/attachments with the File as the
//     body and its type; the answered path becomes a chip with the File's own
//     preview, and rides the message's files; one upload at a time; a sixth
//     file is refused with the composer's hint; a refusal shows its hint; a
//     dropped image uploads too; the button shows at level full only.
//   * stopComposerMod removes the button and the provider and revokes every
//     object URL; init adds no document- or window-level listener.
const test = require('node:test');
const { before, after, afterEach } = test;
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const T0 = Date.UTC(2026, 9, 13, 9, 0, 0);
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };
const SAFE = ['plan', 'compact', 'context', 'rename', 'recap'];

let shell, W, doc, bus, S, C, M, dock;
let current = null;
let rev = 9000;
let attachAnswer = null;   // (call) => body | respond(...) | a promise of one
let attachN = 0;
const daemon = { message: null };

const SKILLS = [
  { name: 'capture-profile', description: 'Author a capture profile', origin: 'project' },
  { name: 'planner', description: 'A user skill named like a command', origin: 'user' },
];

function snapshot({ level = 'local', remote = false, mod = true, cap = true, cid = 'c1' } = {}) {
  const row = { id: cid, rev: 1, headless: false, counts: ZERO, process: { pid: 4242, mod },
    live: { state: 'idle', since: T0, last_activity_at: T0 } };
  return { v: 1, enabled: true, now: Date.now(), rev: ++rev, content: true, access: { level, remote },
    capabilities: { queue_message: true, mod: cap }, primary: cid, aggregate: { state: 'idle' },
    conversations: [row], tasks: [], asks: [] };
}

async function show(opts = {}) {
  current = snapshot(opts);
  await shell.frame(helloFrame());
  await waitUntil(() => S.mirror.rev >= current.rev, { what: 'the snapshot' });
  await shell.tick();
}

const input = () => shell.$('chat-composer-input');
const slot = () => shell.$('chat-composer-slot');
const tool = () => slot().querySelector('.cc-image-tool');
const msgNote = () => slot().querySelector('.cc-msg');
const chips = () => [...slot().querySelectorAll('.cc-chip')];
const options = () => [...shell.$('chat-composer-list').querySelectorAll('[role="option"]')];
const optNames = () => options().map((o) => o.querySelector('.cc-opt-name').textContent);
const uploads = () => shell.calls.filter((c) => c.url === '/api/attachments');
const frames = () => shell.tick(30);

function type(text) {
  const ta = input();
  ta.focus();
  ta.value = text;
  ta.setSelectionRange(text.length, text.length);
  ta.dispatchEvent(new W.Event('input', { bubbles: true }));
}
const key = (k) => shell.key(k, { target: input() });

const png = (name = 'shot.png', type = 'image/png') => new W.File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], name, { type });
function paste(files, text = '') {
  const ev = new W.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { files, types: files.length ? ['Files'] : [], getData: () => text } });
  input().dispatchEvent(ev);
  return ev;
}
function drop(files) {
  const dt = { files, types: ['Files'] };
  const over = new W.Event('dragover', { bubbles: true, cancelable: true });
  Object.defineProperty(over, 'dataTransfer', { value: dt });
  input().dispatchEvent(over);
  const ev = new W.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  input().dispatchEvent(ev);
  return { over, ev };
}

// Object URLs: jsdom has none, so the test stands one in and counts.
const urls = { made: [], revoked: [] };
let urlRestore = null;
function stubUrls() {
  const U = globalThis.URL;
  const orig = { create: U.createObjectURL, revoke: U.revokeObjectURL };
  U.createObjectURL = () => { const u = `blob:test/${urls.made.length + 1}`; urls.made.push(u); return u; };
  U.revokeObjectURL = (u) => { urls.revoked.push(u); };
  urlRestore = () => { U.createObjectURL = orig.create; U.revokeObjectURL = orig.revoke; };
}

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/mirror': () => current,
      '/api/mirror/conversations/*': (url) => {
        const id = decodeURIComponent(url.split('?')[0].split('/')[4]);
        return { conversation_id: id, turns: [], next_before: null, total: 0, rev };
      },
      '/api/queue*': (url, init = {}) => {
        const method = String(init.method || 'GET').toUpperCase();
        const p = url.split('?')[0];
        if (p === '/api/queue' && method === 'GET') return { items: [], count: 0, receipts: [] };
        if (p === '/api/queue/pending') return { pending: null };
        if (p === '/api/queue/message' && method === 'POST') {
          const body = JSON.parse(init.body);
          return daemon.message ? daemon.message(body) : { ok: true, id: 'q900', msg_id: 'm-0000aaaa', mode: 'wake' };
        }
        return { ok: true };
      },
      '/api/skills*': () => ({ ok: true, conversation: 'c1', source: 'session', partial: false, skills: SKILLS, note: 'n' }),
      '/api/files*': () => ({ ok: true, files: [], truncated: false, source: 'git', indexed_at: 1 }),
      '/api/attachments': (url, init) => {
        attachN += 1;
        if (attachAnswer) return attachAnswer({ url, init, n: attachN });
        return { ok: true, path: `.web-chat/attachments/20261013-0000000${attachN % 10}.png`, bytes: 7, type: 'image/png' };
      },
    },
    init: async (sh) => {
      current = snapshot();
      (await sh.importApp('chat-dock.js')).initChatDock();
      (await sh.importApp('chat-panel.js')).initChatPanel();
      (await sh.importApp('chat-stream.js')).initChatStream();
      await (await sh.importApp('chat-composer.js')).initChatComposer();
      (await sh.importApp('composer-mod.js')).initComposerMod();
    },
  });
  W = shell.window;
  doc = shell.document;
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  C = await shell.importApp('chat-composer.js');
  M = await shell.importApp('composer-mod.js');
  dock = await shell.importApp('chat-dock.js');
  stubUrls();
  await show();
  bus.emit('chat:open', { view: 'chat' });
  await shell.tick();
  assert.ok(dock.isChatOpen(), 'the dock is open');
});

after(() => {
  if (urlRestore) urlRestore();
  shell.restore();
});

afterEach(async () => {
  attachAnswer = null;
  daemon.message = null;
  if (input()) {
    key('Escape');
    input().value = '';
    input().dispatchEvent(new W.Event('input', { bubbles: true }));
    for (let x = slot().querySelector('.cc-chip-x'); x; x = slot().querySelector('.cc-chip-x')) shell.click(x);
    input().blur();
  }
  await frames();
});

// ── the pin ──────────────────────────────────────────────────────────────────

test('the chrome\'s SAFE_MOD_COMMANDS equals lib/server/composer.js\'s, and composer-mod.js loads with no DOM', () => {
  const server = require('../lib/server/composer');
  assert.deepEqual([...M.SAFE_MOD_COMMANDS], [...server.SAFE_MOD_COMMANDS]);
  assert.deepEqual(Object.keys(M.MOD_COMMAND_DESCRIPTIONS), [...server.SAFE_MOD_COMMANDS]);
  assert.deepEqual([...M.IMAGE_TYPES], [...require('../lib/server/routes/attachments').ATTACHMENT_TYPES]);
  // A node process of its own, with no DOM: the module loads, its list is the
  // server's, and init with no document wires nothing.
  const href = pathToFileURL(path.join(__dirname, '..', 'public/app/composer-mod.js')).href;
  const src = `const M = await import(${JSON.stringify(href)});
    if (typeof globalThis.document !== 'undefined') throw new Error('a DOM');
    M.initComposerMod(); M.stopComposerMod();
    process.stdout.write(JSON.stringify(M.SAFE_MOD_COMMANDS));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [...server.SAFE_MOD_COMMANDS]);
});

// ── the '/' rows ─────────────────────────────────────────────────────────────

test('with a mod, the five lead the / list with 2.1.296\'s descriptions, labelled; Enter inserts \'/plan \'', async () => {
  type('/');
  await waitUntil(() => options().length === SAFE.length + SKILLS.length, { what: 'the rows' });
  assert.deepEqual(optNames(), [...SAFE.map((n) => `/${n}`), '/capture-profile', '/planner']);
  const first = options()[0];
  assert.equal(first.querySelector('.cc-opt-desc').textContent, 'Enable plan mode or view the current session plan');
  assert.equal(first.querySelector('.cc-opt-tag').textContent, 'runs in the terminal');
  assert.equal(options()[1].querySelector('.cc-opt-desc').textContent, 'Free up context by summarizing the conversation so far');
  assert.equal(options()[2].querySelector('.cc-opt-desc').textContent, 'Show current context usage');
  assert.equal(options()[3].querySelector('.cc-opt-desc').textContent, 'Rename the current conversation');
  assert.equal(options()[4].querySelector('.cc-opt-desc').textContent, 'Generate a one-line session recap now');
  assert.equal(options()[5].querySelector('.cc-opt-tag').textContent, 'project', 'a catalog row keeps its origin');
  type('/pl');
  await waitUntil(() => optNames()[0] === '/plan', { what: 'the filtered rows' });
  assert.deepEqual(optNames(), ['/plan', '/planner']);
  key('Enter');
  await frames();
  assert.equal(input().value, '/plan ');
});

test('with no mod — the process has none, or the daemon reports no capability — none of the five is listed', async () => {
  for (const opts of [{ mod: false }, { cap: false }]) {
    await show(opts);
    type('/');
    await waitUntil(() => options().length === SKILLS.length, { what: 'the catalog rows' });
    assert.deepEqual(optNames(), ['/capture-profile', '/planner']);
    key('Escape');
    await frames();
  }
  await show();
});

test('/model is never listed, with a mod or without', async () => {
  for (const opts of [{}, { mod: false }]) {
    await show(opts);
    type('/mod');
    await frames();
    await waitUntil(() => !slot().querySelector('.cc-pop').hidden, { what: 'the list' });
    assert.ok(!optNames().some((n) => /model|config|permissions|autocompact/.test(n)), optNames().join(','));
    key('Escape');
  }
  await show();
});

// ── images ───────────────────────────────────────────────────────────────────

test('a pasted PNG posts once with the File as the body and its type; the path becomes a chip with the File\'s preview, and rides the send', async () => {
  const before = uploads().length;
  const file = png();
  const ev = paste([file]);
  assert.equal(ev.defaultPrevented, true, 'the image is the paste');
  await waitUntil(() => chips().length === 1, { what: 'the chip' });
  const calls = uploads().slice(before);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, file, 'the File itself, never base64 or JSON');
  assert.deepEqual(calls[0].headers, { 'Content-Type': 'image/png' });
  const chip = chips()[0];
  assert.match(chip.querySelector('.cc-chip-path').textContent, /^\.web-chat\/attachments\/\d{8}-[0-9a-f]{8}\.png$/);
  const thumb = chip.querySelector('.cc-chip-thumb');
  assert.ok(thumb, 'a preview');
  assert.equal(thumb.getAttribute('src'), urls.made[urls.made.length - 1]);
  const path0 = chip.querySelector('.cc-chip-path').textContent;

  let sent = null;
  daemon.message = (body) => { sent = body; return { ok: true, id: 'q1', msg_id: 'm-0000abcd', mode: 'wake' }; };
  type('describe the attached image');
  shell.click(slot().querySelector('.cc-send'));
  await waitUntil(() => sent !== null, { what: 'the send' });
  assert.deepEqual(sent.files, [path0]);
  await waitUntil(() => chips().length === 0, { what: 'the chips cleared' });
  assert.ok(urls.revoked.includes(thumb.getAttribute('src')), 'the preview is revoked when the chip goes');
});

test('a paste carrying text beside the image keeps its default; a non-image paste does nothing', async () => {
  const before = uploads().length;
  const ev = paste([png()], 'shot.png');
  assert.equal(ev.defaultPrevented, false);
  await waitUntil(() => chips().length === 1, { what: 'the chip' });
  const plain = paste([], 'just text');
  assert.equal(plain.defaultPrevented, false);
  await frames();
  assert.equal(uploads().length - before, 1);
});

test('one upload at a time: the second waits for the first', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  attachAnswer = async ({ n }) => {
    if (n % 2 === 1) await gate;
    return { ok: true, path: `.web-chat/attachments/20261013-1111111${n % 10}.png`, bytes: 7, type: 'image/png' };
  };
  attachN = 0;
  const before = uploads().length;
  paste([png('a.png'), png('b.png')]);
  await frames();
  assert.equal(uploads().length - before, 1, 'the second is not sent yet');
  release();
  await waitUntil(() => chips().length === 2, { what: 'both chips' });
  assert.equal(uploads().length - before, 2);
});

test('a sixth file is refused with the composer\'s hint, and its preview revoked', async () => {
  for (let i = 0; i < 5; i++) assert.deepEqual(C.addAttachment({ path: `src/f${i}.js` }), { ok: true });
  assert.equal(chips().length, 5);
  const made = urls.made.length;
  paste([png()]);
  await waitUntil(() => !msgNote().hidden, { what: 'the hint' });
  assert.equal(msgNote().textContent, 'A message attaches at most 5 files.');
  assert.equal(chips().length, 5);
  assert.equal(urls.made.length, made + 1);
  assert.ok(urls.revoked.includes(urls.made[urls.made.length - 1]));
});

test('a refusal shows its hint under the input; a non-image is refused here, never uploaded', async () => {
  attachAnswer = () => respond({ ok: false, refused: 'mismatch', hint: 'the file is not the image its type says' }, { status: 415 });
  paste([png()]);
  await waitUntil(() => !msgNote().hidden, { what: 'the hint' });
  assert.equal(msgNote().textContent, 'the file is not the image its type says');
  assert.equal(chips().length, 0);
  attachAnswer = null;
  const before = uploads().length;
  drop([new W.File(['x'], 'notes.txt', { type: 'text/plain' })]);
  await frames();
  assert.equal(uploads().length, before);
  assert.equal(msgNote().textContent, 'Add a PNG, JPEG, GIF or WebP image.');
});

test('a dropped image uploads; its dragover is accepted', async () => {
  const before = uploads().length;
  const { over, ev } = drop([png('d.png')]);
  assert.equal(over.defaultPrevented, true);
  assert.equal(ev.defaultPrevented, true);
  await waitUntil(() => chips().length === 1, { what: 'the chip' });
  assert.equal(uploads().length - before, 1);
});

test('the image button sits beside Send at level full, with or without a mod; below full it is hidden', async () => {
  const t = tool();
  assert.ok(t, 'the tool is in the composer');
  assert.equal(t.nextElementSibling, slot().querySelector('.cc-send'), 'beside Send');
  assert.equal(t.querySelector('.cc-image').getAttribute('aria-label'), 'Add image');
  assert.equal(t.hidden, false);
  assert.equal(t.querySelector('[id]'), null, 'no new id');
  await show({ mod: false, cap: false });
  assert.equal(tool().hidden, false, 'no mod: still shown');
  current = snapshot({ level: 'read', remote: true });
  await shell.frame(helloFrame());
  await waitUntil(() => S.mirror.access.level === 'read', { what: 'the level' });
  await shell.tick();
  assert.equal(t.hidden, true, 'below full');
  await show();
  assert.equal(tool().hidden, false);
});

// ── stop, and no global listener ─────────────────────────────────────────────

test('stopComposerMod removes the button and the provider and revokes its object URLs; init again restores them', async () => {
  paste([png()]);
  await waitUntil(() => chips().length === 1, { what: 'the chip' });
  const live = urls.made[urls.made.length - 1];
  M.stopComposerMod();
  assert.equal(tool(), null, 'the button is gone');
  assert.ok(urls.revoked.includes(live), 'its URL revoked');
  type('/');
  await waitUntil(() => options().length === SKILLS.length, { what: 'the catalog rows only' });
  assert.ok(!optNames().includes('/plan'));
  key('Escape');
  M.initComposerMod();
  M.initComposerMod();   // idempotent
  assert.equal(slot().querySelectorAll('.cc-image-tool').length, 1);
});

test('the tool survives a stop and re-init of the composer, inside its root', async () => {
  C.stopChatComposer();
  await C.initChatComposer();
  await show();
  assert.ok(tool(), 'placed again in the new root');
  assert.ok(slot().querySelector('.cc-root').contains(tool()));
});

test('initComposerMod adds no document- or window-level listener', async () => {
  M.stopComposerMod();
  const added = [];
  const spies = [doc, W].map((t) => {
    const orig = t.addEventListener;
    t.addEventListener = function spy(type, ...rest) { added.push(type); return orig.call(this, type, ...rest); };
    return () => { t.addEventListener = orig; };
  });
  try {
    M.initComposerMod();
    await show();
    paste([png()]);
    await waitUntil(() => chips().length === 1, { what: 'the chip' });
    type('/');
    await waitUntil(() => options().length === SAFE.length + SKILLS.length);
    key('Escape');
  } finally {
    for (const undo of spies) undo();
  }
  assert.deepEqual(added, []);
});
