// Tranche 4 of the chat mirror, end to end in the chrome (design spec §11.7,
// "What the maintainer sees"; rulings 'Install checkpoints' and E-confirm
// (4)): the real public/app/main.js in jsdom (test-support/chrome-shell
// bootShell) on what a real daemon sent. The daemon halves are
// test/t4-e2e.test.js and test/t4-e2e-control.test.js.
//
// bootShell replaces fetch and the timers a running daemon would use, so the
// daemon's session is recorded first (as test/t3-e2e-chrome.test.js does): a
// conversation working, then waiting on a permission the REAL ask hook (a
// child process) put up while a local tab watched; what GET /api/mirror
// answered then, and what GET /api/asks?ensure=1 answered — the composed
// daemon's answer surface, listening, with its port. The shell then replays
// it: the boot's own ensure=1 fetch answers that port, so asks.js registers
// the approvals provider by itself (never stubbed).
//
// Pinned, a test per clause:
//   * main.js calls initAsks, initChatComposer, initSessionControl and
//     initTurnActions once each, in that order, after tranche 3's inits; a
//     second call of each adds nothing;
//   * an answerable ask mounts the answer frame on the answer origin's host in
//     #cs-act, with no "under development" hint;
//   * the composer replaces the panel's "Reply in the terminal" note;
//   * #cs-stop holds the Stop control: a control frame for the conversation
//     the bar displays (mirror.followed);
//   * a REMOTE viewer (no X-WC-Answer-Origin, tranche 4) sees Review › in the
//     bar and the read-only card — never the "under development" stand-in;
//   * on a phone the grip tab is tranche 5's real pull: a tap opens the
//     sheet, and nothing reads "Under development".

const test = require('node:test');
const { describe, before, after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { withServer, withTempHome, tmpRoot, waitUntil, wsConnect } = require('../test-support/helpers');
const { claudeHome } = require('../test-support/claude-home');
const { bootShell } = require('../test-support/chrome-shell');
const client = require('../lib/client');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { postEnvelope } = require('../lib/hooks/mirror');
const { sampleProcs, formatProcStart } = require('../lib/core/portfiles');

const REPO = path.resolve(__dirname, '..');
const HOOK_BIN = path.join(REPO, 'bin', 'claude-web-chat-hook.js');
const S1 = '11111111-1111-4111-8111-111111111111';
const CALL_TIMEOUT_MS = 15000;
const WAIT = { timeout: 15000, interval: 10 };
const TRANCHE4 = ['initAsks', 'initChatComposer', 'initSessionControl', 'initTurnActions'];

// A scratch test context for the recording (node:test hands `before` no
// `after`): the daemon's and the fixtures' cleanups run once it is recorded.
async function scratch(fn) {
  const afters = [];
  try {
    return await fn({ after: (f) => afters.push(f), diagnostic: () => {} });
  } finally {
    for (const f of afters.reverse()) await f();
  }
}

// One daemon's session, recorded for the chrome.
async function record(t) {
  withTempHome(t);
  const dir = tmpRoot('wc-t4chrome-');
  const ch = claudeHome(t, { root: dir, isolate: true });
  const procStart = formatProcStart((await sampleProcs([process.pid])).get(process.pid).startedAt);
  ch.writeSession({ pid: process.pid, procStart, sessionId: S1, status: 'busy' });
  const ctx = await withServer(t, { root: dir, writePortfile: true });
  const call = { port: ctx.port, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  const get = (p) => client.get(p, call);
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: String(process.pid) };
  let clock = Date.now();
  const stamp = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
  const envelope = (event, extra = {}) => hookEnvelope({ hook_event_name: event, session_id: S1,
    transcript_path: ch.transcript(S1), cwd: ch.cwd, permission_mode: 'default', ...extra }, env, { now: stamp() });
  const fire = async (event, extra) => {
    assert.equal(await postEnvelope(envelope(event, extra), { root: ctx.root, timeout: CALL_TIMEOUT_MS }), 'posted');
  };

  // The tab the chrome stands in for: local, its chat open.
  const ws = wsConnect(ctx.port, '/ws');
  t.after(() => { try { ws.terminate(); } catch {} });
  const frames = [];
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())); } catch {} });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { ...WAIT, what: 'the hello' });
  ws.send(JSON.stringify({ type: 'client', mirror: 'full' }));

  const out = {};
  await fire('SessionStart', { source: 'startup', model: 'claude-test' });
  const begin = envelope('UserPromptSubmit', { prompt: 'rebuild it', prompt_id: 'p-build' });
  await client.post('/api/turn-begin', { message: 'rebuild it', author: 'user', ...sessionFields(begin), prompt: begin.prompt }, call);
  await fire('PreToolUse', { tool_name: 'Read', tool_use_id: 'toolu_01Read', tool_input: { file_path: path.join(dir, 'README.md') } });
  out.working = await waitUntil(async () => {
    const s = await get('/api/mirror');
    const c = (s.conversations || []).find((x) => x.id === S1);
    return c && c.live && c.live.state === 'working' ? s : null;
  }, { ...WAIT, what: 'S1 working' });

  // The real ask hook puts up a permission prompt.
  const hookEnv = { ...process.env, ...env };
  delete hookEnv.WEB_CHAT_HOOK_LOG;
  const child = spawn(process.execPath, [HOOK_BIN, 'ask'], { cwd: dir, env: hookEnv });
  const exited = new Promise((resolve) => child.on('close', resolve));
  t.after(async () => { child.kill('SIGTERM'); await exited; });
  child.stdin.end(JSON.stringify({ session_id: S1, transcript_path: ch.transcript(S1), cwd: ch.cwd,
    hook_event_name: 'PermissionRequest', prompt_id: 'p-build', permission_mode: 'default', tool_name: 'Bash',
    tool_input: { command: 'npm run build', description: 'Build' } }));
  await waitUntil(async () => ((await get('/api/asks')).asks || []).some((a) => a.state === 'pending'), { ...WAIT, what: 'the ask' });
  // Claude Code shows the prompt: its sessions file says waiting.
  ch.writeSession({ pid: process.pid, procStart, sessionId: S1, status: 'waiting' });
  out.waiting = await waitUntil(async () => {
    const s = await get('/api/mirror');
    const c = (s.conversations || []).find((x) => x.id === S1);
    const ask = (s.asks || []).find((a) => a.state === 'pending' && a.answerable === true);
    return c && c.live && c.live.state === 'waiting' && ask ? s : null;
  }, { ...WAIT, what: 'S1 waiting on an answerable ask' });
  out.ask = out.waiting.asks.find((a) => a.state === 'pending');
  out.asks = await get('/api/asks?ensure=1');
  assert.ok(out.asks.answer && Number.isInteger(out.asks.answer.port), 'the composed daemon\'s answer surface listens');
  out.frames = frames.slice();
  return out;
}

describe('the real main.js in jsdom, on what a tranche-4 daemon sent', () => {
  let rec = null;
  let shell = null;
  let $ = null;
  let doc = null;
  const current = { mirror: null };

  before(async () => {
    rec = await scratch(record);
    shell = await bootShell({
      routes: {
        '/api/mirror': () => current.mirror,
        '/api/asks': () => rec.asks,
      },
    });
    $ = shell.$;
    doc = shell.document;
  });

  after(() => (shell ? shell.restore() : undefined));

  // A (re)connect on a snapshot: its hello, then GET /api/mirror's answer.
  async function show(snapshot) {
    current.mirror = snapshot;
    const S = await shell.importApp('chat-state.js');
    shell.socket().receive(rec.frames[0]);
    await waitUntil(() => S.mirror.rev >= snapshot.rev, { ...WAIT, what: 'the snapshot' });
    await shell.tick();
    return S;
  }
  const origin = () => `http://127.0.0.1:${rec.asks.answer.port}`;

  test('main.js calls the four tranche-4 inits once each, in order, after tranche 3\'s; a second call adds nothing', async () => {
    const calls = [...fs.readFileSync(path.join(REPO, 'public/app/main.js'), 'utf8').matchAll(/^(init\w+)\(/gm)].map((m) => m[1]);
    for (const name of TRANCHE4) assert.equal(calls.filter((c) => c === name).length, 1, `${name} once`);
    const at = calls.indexOf('initAsks');
    assert.deepEqual(calls.slice(at, at + TRANCHE4.length), TRANCHE4, 'in that order');
    for (const prior of ['initChatState', 'initChatBar', 'initChatPanel', 'initChatStream', 'initChatTrays', 'initChatDetail', 'initGraphTurns']) {
      assert.ok(calls.indexOf(prior) >= 0 && calls.indexOf(prior) < at, `after ${prior}`);
    }
    assert.ok(shell.calls.some((c) => c.url === '/api/asks?ensure=1'), 'the boot asked for the answer surface\'s port');

    await show(rec.waiting);
    const slots = await shell.importApp('chat-slots.js');
    const shape = () => ({
      frames: doc.querySelectorAll('iframe.wc-answer-frame').length,
      composers: doc.querySelectorAll('.cc-root').length,
      approvals: Boolean(slots.approvals()),
      composer: Boolean(slots.composer()),
      intervals: shell.intervals().length,
    });
    const once = shape();
    assert.equal(once.approvals, true, 'the approvals provider is registered');
    assert.equal(once.composer, true, 'the composer is registered');
    const ws = await shell.importApp('ws.js');
    (await shell.importApp('asks.js')).initAsks({ onFrame: ws.onFrame, onHello: ws.onHello });
    await (await shell.importApp('chat-composer.js')).initChatComposer();
    (await shell.importApp('session-control.js')).initSessionControl();
    (await shell.importApp('turn-actions.js')).initTurnActions();
    await shell.tick();
    assert.deepEqual(shape(), once, 'a second init of each adds no frame, composer, provider or ticker');
  });

  test('an answerable ask mounts the answer frame on the answer origin\'s host in #cs-act, with no "under development" hint', async () => {
    await show(rec.waiting);
    const act = $('cs-act');
    const frame = await waitUntil(() => act.querySelector('iframe.wc-answer-frame'), { ...WAIT, what: `the bar's frame (#cs-act reads "${act.textContent}")` });
    const src = new URL(frame.src);
    assert.equal(src.origin, origin(), 'served from the answer origin, never the chrome\'s');
    assert.equal(src.pathname, `/answer/ask/${rec.ask.id}`);
    assert.equal(src.searchParams.get('layout'), 'bar');
    assert.equal(act.querySelector('.cs-act-hint'), null, 'no stand-in hint');
    assert.ok(!/under development/i.test(act.textContent), 'nothing in the bar says answering is under development');
    assert.ok(!/under development/i.test($('chat-statusbar').textContent));
  });

  test('the composer replaces the panel\'s "Reply in the terminal" note', async () => {
    await show(rec.waiting);
    const { bus } = await shell.importApp('bus.js');
    bus.emit('chat:open', { view: 'chat', focus: 'none' });
    await shell.tick();
    const slot = $('chat-composer-slot');
    const root = await waitUntil(() => slot.querySelector('.cc-root'), { ...WAIT, what: 'the composer in its slot' });
    assert.equal(root.dataset.mode, 'input', 'a local viewer with queue_message on types into it');
    assert.ok(root.querySelector('textarea'), 'its field');
    assert.equal(slot.querySelector('.cp-composer-note'), null, 'the panel\'s note is gone');
    assert.ok(!slot.textContent.includes('Reply in the terminal, or add a note in the queue rail'));
    (await shell.importApp('chat-dock.js')).closeChat({ returnFocus: false });
    await shell.tick();
  });

  test('#cs-stop holds the Stop control, for the conversation the bar displays', async () => {
    const S = await show(rec.working);
    assert.equal(S.mirror.followed, S1, 'the bar follows S1 (the server\'s primary, this tab having chosen none)');
    const frame = await waitUntil(() => $('cs-stop').querySelector('iframe.wc-answer-frame'), { ...WAIT, what: 'the Stop frame in #cs-stop' });
    const src = new URL(frame.src);
    assert.equal(src.origin, origin());
    assert.equal(src.pathname, '/answer/control/interrupt');
    assert.equal(src.searchParams.get('layout'), 'stop');
    assert.equal(src.searchParams.get('size'), 'bar');
    assert.equal(src.searchParams.get('conversation_id'), S.mirror.followed, 'it stops the conversation beside it');
    assert.equal($('cs-stop').dataset.wcStop, 'bar');
  });

  test('a remote viewer (no answer origin in tranche 4) sees Review › and the read-only card, never the stand-in', async () => {
    const A = await shell.importApp('asks.js');
    const ws = await shell.importApp('ws.js');
    const slots = await shell.importApp('chat-slots.js');
    const remote = { isRemote: async () => true, remoteNow: () => true, remoteKnown: () => true, answerOrigin: () => null };
    A.stopAsks();
    A.initAsks({ onFrame: ws.onFrame, onHello: ws.onHello, remote });
    try {
      await shell.tick();
      assert.ok(slots.approvals(), 'the provider is registered for a remote page too');
      await show({ ...rec.waiting, rev: rec.waiting.rev + 1 });
      const act = $('cs-act');
      const review = await waitUntil(() => act.querySelector('button.cs-review'), { ...WAIT, what: `Review › (#cs-act reads "${act.textContent}")` });
      assert.equal(review.textContent, 'Review ›');
      assert.equal(act.querySelector('iframe'), null, 'no frame: nothing is answerable remotely in tranche 4');
      assert.ok(!/under development/i.test(act.textContent), 'and no stand-in');
      const { bus } = await shell.importApp('bus.js');
      bus.emit('chat:open', { view: 'chat', focus: 'none' });
      await shell.tick();
      const card = $('chat-awaiting');
      await waitUntil(() => !card.hidden && card.querySelector('.cp-aw-hint'), { ...WAIT, what: 'the read-only card' });
      assert.equal(card.querySelector('iframe'), null);
      assert.ok(!/under development/i.test(card.textContent));
      (await shell.importApp('chat-dock.js')).closeChat({ returnFocus: false });
    } finally {
      A.stopAsks();
      A.initAsks({ onFrame: ws.onFrame, onHello: ws.onHello });
      await shell.tick();
    }
  });

  test('on a phone the grip tab is the real pull (tranche 5): a tap opens the sheet, with no "Under development"', async () => {
    shell.setViewport({ width: 390, height: 844 });
    await shell.tick();
    const sheet = await shell.importApp('chat-sheet.js');
    try {
      assert.ok($('chat-pull').classList.contains('chat-pull'), 'on a phone the real pull');
      assert.equal(doc.querySelector('.pull-stub'), null, 'no stand-in');
      shell.click($('chat-tab'));
      await shell.tick();
      assert.equal(sheet.sheetState().open, true, 'a tap opens the sheet');
      assert.ok(!/under development/i.test($('chat-sheet').textContent), 'no "Under development" note');
      shell.key('Escape');
      assert.equal(sheet.sheetState().open, false);
    } finally {
      shell.setViewport({ width: 1280, height: 800 });
      await shell.tick();
    }
  });
});
