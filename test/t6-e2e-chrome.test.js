// Tranche 6's end-to-end check in the chrome (design spec §11.9, U94a): the mod,
// through the REAL main.js booted once in jsdom (test-support/chrome-shell.js)
// with nothing initialised by the test — main.js starts the mod's controls
// (U89), the composer's mod half (U91) and the session controls (U93) itself.
// It boots narrow (390×844, as test/t5-e2e-chrome.test.js does), then flips to
// a 1280 desktop.
//
// Pinned, a test per clause:
//   * main.js calls initModControls, initComposerMod and initSessionOps once
//     each, after initTabDock (tranche 5's last) and before connect(), each
//     after its prerequisite (initTurnActions and initSessionControl;
//     initChatComposer); a second call of each adds nothing;
//   * narrow: with a mod attached, #cp-ops in the phone sheet's panel holds
//     the meter, Compact now and Plan mode, and Compact now's confirm frame is
//     sized 'sheet' (taps inside the sheet are pointerdown + pointerup + click);
//   * desktop: with a mod #cp-ops holds the meter, Compact now and Plan mode;
//     with none it is empty and hidden (tier 1, not a stand-in);
//   * the composer's / list leads with the five safe commands with a mod, and
//     holds the skills only without one;
//   * the trays' Kill mounts the mod stopper's confirm frame (task-stop on the
//     answer origin) only with a mod; without, the inline confirm, as before;
//   * no "Under development" text belongs to tranche 6: none in its modules,
//     #cp-ops or the / list.
//
// jsdom lays nothing out: the attributes and the frames' URLs are asserted,
// and the one cascade read (#cp-ops hidden while empty) goes through
// test-support/css-cascade.js.
const test = require('node:test');
const { describe, before, after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { createCascade } = require('../test-support/css-cascade');

const REPO = path.resolve(__dirname, '..');
const MAIN = fs.readFileSync(path.join(REPO, 'public/app/main.js'), 'utf8');
const CSS = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const TRANCHE6 = ['initModControls', 'initComposerMod', 'initSessionOps'];
const PORT = 4567;                       // the answer surface's port GET /api/asks names
const LOOP = `http://127.0.0.1:${PORT}`;
const S1 = '11111111-1111-4111-8111-111111111111';
const T0 = Date.now() - 120000;
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };
const SAFE = ['plan', 'compact', 'context', 'rename', 'recap'];
const SKILLS = [{ name: 'capture-profile', description: 'Author a capture profile', origin: 'project' }];
const WAIT = { timeout: 5000, interval: 10 };
// The files tranche 6 put in the chrome and the daemon (spec §11.9's table).
const TRANCHE6_FILES = [
  'public/app/mod-controls.js', 'public/app/composer-mod.js', 'public/app/session-ops.js', 'public/app/prompts-mod.js',
  'lib/server/domain/bridge.js', 'lib/server/routes/bridge.js', 'lib/server/control/mod.js', 'lib/server/control/session-ops.js',
  'lib/server/mirror/mod-live.js', 'lib/server/mod-transport.js', 'lib/server/routes/attachments.js',
  'lib/server/routes/mirror-context.js', 'lib/hooks/elicitation.js', 'lib/core/mod-protocol.js', 'lib/cli/commands/mod.js',
];

let rev = 20000;
function snapshot({ mod = true, task = true } = {}) {
  rev += 1;
  return {
    v: 1, enabled: true, now: Date.now(), rev, content: true, access: { level: 'local', remote: false },
    capabilities: { interrupt: true, task_stop: true, queue_message: true, mod, rewind_in_place: false },
    primary: 'c1', aggregate: { state: 'idle' },
    conversations: [{ id: 'c1', rev: 1, title: 'Wire the mod', headless: false, counts: ZERO, current_session_id: S1,
      permission_mode: 'default', turn_count: 1, process: { pid: 4242, mod },
      live: { state: 'idle', since: T0, last_activity_at: T0 } }],
    tasks: task ? [{ id: 'b7f3k2q9', kind: 'shell', conversation_id: 'c1', title: 'npm run dev', status: 'running', started_at: T0 }] : [],
    asks: [],
  };
}

describe('tranche 6 in the chrome: the real main.js in jsdom', () => {
  let shell = null;
  let W = null;
  let doc = null;
  let $ = null;
  let bus = null;
  let S = null;
  let sheet = null;
  let current = snapshot();
  const cascade = createCascade(CSS, { win: () => W });

  const ops = () => $('cp-ops');
  const opsFrames = () => [...ops().querySelectorAll('iframe.wc-answer-frame')];
  const input = () => $('chat-composer-input');
  const options = () => [...$('chat-composer-list').querySelectorAll('[role="option"]')];
  const optNames = () => options().map((o) => o.querySelector('.cc-opt-name').textContent);

  // A hello, then the store's GET /api/mirror (served `current`) folded in.
  async function show(over) {
    current = snapshot(over);
    const want = current.rev;
    await shell.frame(helloFrame());
    await waitUntil(() => S.mirror.rev >= want, { ...WAIT, what: 'the snapshot' });
    await shell.tick();
    await shell.tick();
  }

  // A tap as a phone sends it, inside the sheet.
  function tap(el) {
    el.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', button: 0 }));
    el.dispatchEvent(new W.PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', button: 0 }));
    shell.click(el);
  }
  function type(text) {
    const ta = input();
    ta.focus();
    ta.value = text;
    ta.setSelectionRange(text.length, text.length);
    ta.dispatchEvent(new W.Event('input', { bubbles: true }));
  }
  async function clearInput() {
    shell.key('Escape', { target: input() });
    input().value = '';
    input().dispatchEvent(new W.Event('input', { bubbles: true }));
    input().blur();
    await shell.tick(30);
  }

  // The trays' Kill on the running shell's row, as chat-actions runs it.
  async function kill() {
    const CA = await shell.importApp('chat-actions.js');
    const R = await shell.importApp('chat-rows.js');
    const P = await shell.importApp('chat-present.js');
    const Q = await shell.importApp('queue.js');
    const row = P.categories(S.mirror, Q.queueSnapshot(), { now: S.serverNow() })
      .find((e) => e.cat === 'shells').rows.find((r) => r.id === 'b7f3k2q9');
    assert.ok(row, 'the running shell\'s row');
    const list = doc.createElement('div');
    doc.body.append(list);
    const rowEl = R.rowEl(row, { density: 'compact' });
    list.append(rowEl);
    const button = rowEl.querySelector('.cs-row-actions [data-action="kill"]');
    assert.ok(button, 'a Kill');
    CA.runAction(row, 'kill', { rowEl, density: 'compact', button });
    return { list, rowEl, frames: [...rowEl.querySelectorAll('iframe.wc-answer-frame')] };
  }

  // The phone's layout, which jsdom does not do: #topbar's bottom at 44 and
  // #bottombar's top at 688 (the sheet measures its stops from them).
  function layout() {
    shell.scrollMetrics($('topbar'), { rect: { top: 0, height: 44, width: PHONE.width } });
    shell.scrollMetrics($('bottombar'), { rect: { top: 688, height: 60, width: PHONE.width } });
    const pull = $('chat-pull');
    if (pull) shell.scrollMetrics(pull, { rect: { left: 0, top: 688, width: PHONE.width, height: 0 } });
  }

  before(async () => {
    shell = await bootShell({
      viewport: PHONE,
      routes: {
        '/api/mirror': () => current,
        '/api/mirror/conversations/*': (url) => {
          const id = decodeURIComponent(url.split('?')[0].split('/')[4]);
          return { conversation_id: id, turns: [], next_before: null, total: 0, rev };
        },
        '/api/mirror/context': () => ({ ok: true, context: { tokens: 76000, window: 200000, percent: 38, at: Date.now() } }),
        '/api/asks': () => ({ asks: [], answer: { port: PORT } }),
        '/api/skills*': () => ({ ok: true, conversation: 'c1', source: 'session', partial: false, skills: SKILLS, note: 'n' }),
        '/api/files*': () => ({ ok: true, files: [], truncated: false, source: 'git', indexed_at: 1 }),
        '/api/queue/task-stop': () => ({ ok: true }),
      },
    });
    W = shell.window;
    doc = shell.document;
    $ = shell.$;
    ({ bus } = await shell.importApp('bus.js'));
    S = await shell.importApp('chat-state.js');
    sheet = await shell.importApp('chat-sheet.js');
    layout();
    await show();
  });

  after(() => (shell ? shell.restore() : undefined));

  test('main.js calls the three tranche-6 inits once each, after initTabDock and before connect(), each after its prerequisite; a second call of each adds nothing', async () => {
    const calls = [...MAIN.matchAll(/^(init\w+|connect)\(/gm)].map((m) => m[1]);
    for (const name of TRANCHE6) assert.equal(calls.filter((c) => c === name).length, 1, `${name} once`);
    const at6 = calls.indexOf('initModControls');
    assert.deepEqual(calls.slice(at6 - 1, at6 + TRANCHE6.length + 1), ['initTabDock', ...TRANCHE6, 'connect'],
      'right after initTabDock (tranche 5\'s last), then connect()');
    for (const [init, prereqs] of [['initModControls', ['initTurnActions', 'initSessionControl']],
      ['initComposerMod', ['initChatComposer']], ['initSessionOps', ['initSessionControl']]]) {
      for (const p of prereqs) assert.ok(calls.indexOf(p) < calls.indexOf(init), `${init} after ${p}`);
    }

    // Ran at boot: each one's own mark is in the chrome now.
    const MC = await shell.importApp('mod-controls.js');
    const CM = await shell.importApp('composer-mod.js');
    const SO = await shell.importApp('session-ops.js');
    await waitUntil(() => ops().querySelector('.so-compact'), { ...WAIT, what: 'initSessionOps drew #cp-ops' });
    assert.ok($('chat-composer-slot').querySelector('.cc-image-tool'), 'initComposerMod added the image tool');
    const first = await kill();
    assert.equal(first.frames.length, 1, 'initModControls registered the stopper');
    first.list.remove();

    const shape = () => ({
      ops: ops().childNodes.length,
      opsControls: ops().querySelectorAll('button').length,
      tools: doc.querySelectorAll('.cc-image-tool').length,
      pops: doc.querySelectorAll('.so-pop').length,
      intervals: shell.intervals().length,
    });
    const once = shape();
    assert.equal(MC.initModControls(), MC.initModControls(), 'the same handle');
    CM.initComposerMod();
    assert.equal(SO.initSessionOps(), SO.initSessionOps(), 'the same handle');
    await shell.tick();
    assert.deepEqual(shape(), once, 'a second init of each adds no control, tool, popover or ticker');
    const again = await kill();
    assert.equal(again.frames.length, 1, 'one stopper: one frame for one Kill');
    again.list.remove();
  });

  test('narrow: with a mod, #cp-ops in the phone sheet\'s panel holds the meter, Compact now and Plan mode; Compact now\'s frame is sized sheet', async () => {
    await show({ mod: true });
    layout();
    assert.equal(sheet.openSheet(), true, 'the sheet opens below 760px');
    await waitUntil(() => $('chat-panel') && $('chat-panel').dataset.variant === 'sheet', { ...WAIT, what: 'the panel in the sheet' });
    assert.ok($('chat-sheet').contains(ops()), '#cp-ops is in the sheet');
    await waitUntil(() => ops().querySelector('.so-meter'), { ...WAIT, what: 'the meter' });
    assert.equal(ops().querySelector('.so-meter .so-text').textContent, '38% · 76k of 200k');
    assert.equal(ops().querySelector('.so-compact').textContent, 'Compact now');
    assert.equal(ops().querySelector('.so-plan').textContent, 'Plan mode');
    tap(ops().querySelector('.so-compact'));
    await shell.tick();
    const [frame] = await waitUntil(() => (opsFrames().length ? opsFrames() : null), { ...WAIT, what: 'Compact now\'s frame' });
    assert.equal(opsFrames().length, 1, 'one frame');
    const u = new URL(frame.src);
    assert.equal(u.origin, LOOP);
    assert.equal(u.pathname, '/answer/control/session-compact');
    assert.equal(u.searchParams.get('conversation_id'), 'c1');
    assert.equal(u.searchParams.get('layout'), 'confirm');
    assert.equal(u.searchParams.get('size'), 'sheet', 'sized for the sheet');
    assert.ok(ops().querySelector('.so-confirm[data-so-size="sheet"]'), 'its holder marked sheet');
    sheet.closeSheet({ returnFocus: false });
    await shell.tick();
  });

  test('desktop: with a mod #cp-ops holds the meter, Compact now and Plan mode; with none it is empty and hidden', async () => {
    shell.setViewport(DESKTOP);
    await shell.tick();
    bus.emit('chat:open', { view: 'chat' });
    await shell.tick();
    await show({ mod: true });
    await waitUntil(() => $('chat-panel').dataset.variant !== 'sheet', { ...WAIT, what: 'the panel back in the dock' });
    await waitUntil(() => ops().querySelector('.so-meter') && ops().querySelector('.so-compact') && ops().querySelector('.so-plan'),
      { ...WAIT, what: 'the meter, Compact now and Plan mode' });
    assert.notEqual(cascade.value(ops(), 'display'), 'none', 'shown');
    assert.equal(ops().querySelectorAll('[id]').length, 0, 'no id of its own');

    await show({ mod: false });
    await waitUntil(() => ops().childNodes.length === 0, { ...WAIT, what: '#cp-ops emptied' });
    assert.equal(cascade.value(ops(), 'display'), 'none', 'hidden while empty: tier 1');
  });

  test('the composer\'s / list leads with the five safe commands with a mod, and holds the skills only without one', async () => {
    await show({ mod: true });
    type('/');
    await waitUntil(() => options().length === SAFE.length + SKILLS.length, { ...WAIT, what: 'the mod\'s rows and the skills' });
    assert.deepEqual(optNames(), [...SAFE.map((n) => `/${n}`), '/capture-profile']);
    assert.ok(!optNames().includes('/model'), '/model never');
    await clearInput();

    await show({ mod: false });
    type('/');
    await waitUntil(() => options().length === SKILLS.length, { ...WAIT, what: 'the skills only' });
    assert.deepEqual(optNames(), ['/capture-profile']);
    await clearInput();
  });

  test('the trays\' Kill mounts the mod stopper\'s confirm frame only with a mod; without, the inline confirm', async () => {
    await show({ mod: true });
    const withMod = await kill();
    assert.equal(withMod.frames.length, 1, 'one frame');
    const u = new URL(withMod.frames[0].src);
    assert.equal(u.origin, LOOP);
    assert.equal(u.pathname, '/answer/control/task-stop');
    assert.equal(u.searchParams.get('task_id'), 'b7f3k2q9');
    assert.equal(u.searchParams.get('layout'), 'confirm');
    assert.equal(withMod.frames[0].dataset.kind, 'control');
    withMod.list.remove();

    await show({ mod: false });
    const posts = () => shell.calls.filter((c) => c.url === '/api/queue/task-stop' && c.method === 'POST').length;
    const n = posts();
    const without = await kill();
    assert.equal(without.frames.length, 0, 'no frame without a mod');
    const yes = without.rowEl.querySelector('.cs-confirm-yes');
    assert.ok(yes, 'the inline confirm, as in tier 1');
    shell.click(yes);
    await waitUntil(() => posts() > n, { ...WAIT, what: 'the queue route' });
    without.list.remove();
  });

  test('no "Under development" text belongs to tranche 6: none in its modules, #cp-ops or the / list', async () => {
    for (const rel of TRANCHE6_FILES) {
      assert.doesNotMatch(fs.readFileSync(path.join(REPO, rel), 'utf8'), /under development/i, rel);
    }
    // main.js's tranche-6 block (tranche 4's comment above it names tranche 4's own).
    const block = MAIN.slice(MAIN.indexOf('// Tranche 6'), MAIN.indexOf('\nconnect();'));
    assert.ok(block.includes('initSessionOps();'), 'the tranche-6 block');
    assert.doesNotMatch(block, /under development|stand-in/i, 'main.js\'s tranche-6 block names no stand-in');
    await show({ mod: true });
    await waitUntil(() => ops().querySelector('.so-compact'), { ...WAIT, what: '#cp-ops' });
    assert.doesNotMatch(ops().textContent, /under development/i);
    for (const el of ops().querySelectorAll('*')) {
      for (const a of ['aria-label', 'title']) assert.doesNotMatch(el.getAttribute(a) || '', /under development/i);
    }
    type('/');
    await waitUntil(() => options().length === SAFE.length + SKILLS.length, { ...WAIT, what: 'the rows' });
    assert.doesNotMatch($('chat-composer-list').textContent, /under development/i);
    await clearInput();
  });
});
