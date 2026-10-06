// Tranche 3 of the chat mirror, end to end in the chrome (design spec §11.6,
// "End-to-end check (U51)" and "What the maintainer sees"): the real
// public/app/main.js in jsdom (test-support/chrome-shell bootShell) on what a
// real daemon sent. The daemon half is test/t3-e2e.test.js.
//
// The chrome cannot share a process with a running daemon (bootShell replaces
// fetch and stubs the timers the daemon would use), so a daemon's session is
// recorded first, as test/t2-e2e.test.js does: every frame a socket with its
// chat open got (hello first), what GET /api/mirror answered at the moments
// that matter, and the answers of the routes the chrome reads (a task's
// output, the graph, a node, a node's turns, the nodes' summaries, the
// project). The shell then replays it.
//
// The recorded daemon runs in a scratch git repository (test-support/
// treesnap-fixture) with a private Claude tier (test-support/claude-home),
// played by Claude Code's own hook code and a synthetic transcript: a
// background shell that exits with code 3, a turn that edits one file and
// renders a pane (a committed node carrying node.mirror), and the identity CLI
// (bin/claude-web-chat.js identity logo … --dark auto).
//
// Pinned, a test per clause:
//   * main.js calls initChatTrays, initChatDetail and initGraphTurns once each,
//     after tranche 2's chat inits and after initGraph, and a second call of
//     each adds nothing;
//   * the shell: a "1 shell" chip → its tray row → Output, whose tail ends on
//     "[exited with code 3]";
//   * the turn that edited one file: the bar reads "Done · 1 file changed";
//   * the graph inspector lists the committed node's turns (#gi-turns);
//   * the favicon: #wc-favicon / #wc-favicon-dark move to the project's mark
//     from the CLI's project frames, light and dark;
//   * the stand-ins: the trays took the bar's chips (no "Under development"
//     chip, and a chip opens its tray), while the phone's grip tab — tranche
//     5's — still opens its "Under development" note (rulings, Install
//     checkpoints: 0.8.5-alpha.2).

const test = require('node:test');
const { describe, before, after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { withServer, waitUntil, wsConnect } = require('../test-support/helpers');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords } = require('../test-support/claude-records');
const { treesnapRepo } = require('../test-support/treesnap-fixture');
const { bootShell } = require('../test-support/chrome-shell');
const client = require('../lib/client');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { postEnvelope } = require('../lib/hooks/mirror');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'claude-web-chat.js');
const ICON = path.join(REPO, 'test', 'fixtures', 'icon', 'web-chat-dev-icon.png');
const S1 = '11111111-1111-4111-8111-111111111111';
const SHELL = 'bshell3';
const CALL_TIMEOUT_MS = 15000;
const WAIT = { timeout: 15000, interval: 10 };
const DATA = 'data:image/png;base64,RkFLRQ==';

// A scratch test context for the recording, where node:test hands the suite's
// `before` no `after`: the daemon's and the fixtures' cleanups run once the
// recording is done.
async function scratch(fn) {
  const afters = [];
  try {
    return await fn({ after: (f) => afters.push(f), diagnostic: () => {} });
  } finally {
    for (const f of afters) await f();
  }
}

function cli(cwd, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: process.env, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// One daemon's session, recorded for the chrome (the clauses above).
async function record(t) {
  let ctx = null;
  t.after(async () => { if (ctx) await ctx.stop(); });
  const repo = treesnapRepo(t, { files: { 'README.md': 'scratch\n', 'src/app.js': 'export const x = 1;\n' } });
  const ch = claudeHome(t, { root: repo.root, isolate: true });
  ctx = await withServer(t, { root: repo.root, writePortfile: true });
  const call = { port: ctx.port, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  const get = (p) => client.get(p, call);
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
  let clock = Date.now();
  const stamp = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
  const envelope = (event, extra = {}) => hookEnvelope({ hook_event_name: event, session_id: S1,
    transcript_path: ch.transcript(S1), cwd: ch.cwd, permission_mode: 'default', ...extra }, env, { now: stamp() });
  const fire = async (event, extra) => {
    assert.equal(await postEnvelope(envelope(event, extra), { root: ctx.root, timeout: CALL_TIMEOUT_MS }), 'posted');
  };
  const snapshots = async () => {
    const s = await get('/api/mirror');
    return (s.diagnostics && s.diagnostics.git && s.diagnostics.git.snapshots) || 0;
  };

  // The socket the chrome stands in for: its chat open.
  const ws = wsConnect(ctx.port, '/ws');
  t.after(() => { try { ws.terminate(); } catch {} });
  const frames = [];
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())); } catch {} });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { ...WAIT, what: 'the hello' });
  ws.send(JSON.stringify({ type: 'client', mirror: 'full' }));

  const out = {};
  await fire('SessionStart', { source: 'startup', model: 'claude-test' });

  // A background shell, from the transcript; its output file watched.
  const file = ch.writeTaskOutput(S1, SHELL, '');
  const r = createRecords({ seed: 9, sessionId: S1, cwd: ch.cwd, start: Date.now() - 5000, step: 10 });
  r.prompt(`run ${SHELL}`, { promptId: 'p-shell' });
  r.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'npm run dev', description: 'Start the dev server',
    run_in_background: true }, id: 'toolu_01Shell' }]);
  r.toolResult('toolu_01Shell', `Command running in background with ID: ${SHELL}. Output is being written to: ${file}.`, { taskId: SHELL });
  r.assistant(['Started.']);
  r.turnDuration({ durationMs: 50 });
  ch.writeTranscript(S1, r.records);
  out.running = await waitUntil(async () => {
    const s = await get('/api/mirror');
    return (s.tasks || []).some((x) => x.id === SHELL && x.status === 'running') ? s : null;
  }, { ...WAIT, what: 'the running shell in the snapshot' });
  ch.appendTaskOutput(S1, SHELL, 'building\noops\n\n[exited with code 3]\n');
  await waitUntil(async () => ((await get('/api/mirror/tasks')).tasks || []).some((x) => x.id === SHELL && x.exit_code === 3),
    { ...WAIT, what: 'the shell to exit' });
  out.output = await get(`/api/mirror/tasks/${SHELL}/output?tail=16384`);

  // A turn that edits one file and renders a pane: its node carries its turns.
  const seen = await snapshots();
  const begin = envelope('UserPromptSubmit', { prompt: 'fix the export', prompt_id: 'p-edit' });
  await client.post('/api/turn-begin', { message: 'fix the export', author: 'user', ...sessionFields(begin), prompt: begin.prompt }, call);
  await waitUntil(async () => (await snapshots()) > seen, { ...WAIT, what: 'the before-snapshot' });
  repo.write('src/app.js', 'export const x = 2;\n');
  const input = { file_path: path.join(repo.root, 'src/app.js'), old_string: '1', new_string: '2' };
  await fire('PreToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_01Edit', tool_input: input });
  await fire('PostToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_01Edit', tool_input: input,
    tool_response: { filePath: input.file_path }, duration_ms: 3 });
  await client.post('/api/render', { id: 't3e2e-pane', html: '<p>the export</p>' }, call);
  const stop = envelope('Stop', { last_assistant_message: 'Fixed.' });
  const end = await client.post('/api/turn-end', { author: 'claude', reply: 'Fixed.', ended: 'stop', ...sessionFields(stop),
    last_assistant_message: 'Fixed.' }, call);
  assert.ok(end.node_id, `the turn committed a node: ${JSON.stringify(end)}`);
  out.nodeId = end.node_id;
  out.done = await waitUntil(async () => {
    const s = await get('/api/mirror');
    const c = s.conversations.find((x) => x.id === S1);
    const last = c && c.live && c.live.last_turn;
    return last && last.id === 'p-edit' && last.code && last.code.files === 1 ? s : null;
  }, { ...WAIT, what: 'the turn\'s code, ready' });
  out.graph = await get('/api/graph');
  out.nodes = {};
  for (const n of out.graph.nodes) out.nodes[n.id] = await get(`/api/graph/node/${encodeURIComponent(n.id)}`);
  assert.ok(out.nodes[out.nodeId].mirror, 'the node as served (local) carries node.mirror');
  out.nodeTurns = {};
  for (const n of out.graph.nodes) out.nodeTurns[n.id] = await get(`/api/mirror/node/${encodeURIComponent(n.id)}`);
  out.summaries = await get('/api/mirror/nodes');

  // The project's logo, through the CLI: its project frames ride the socket.
  const id = await cli(repo.root, ['identity', 'logo', ICON, '--dark', 'auto']);
  assert.equal(id.code, 0, id.stderr || id.stdout);
  await waitUntil(() => frames.filter((f) => f.type === 'project').length >= 3, { ...WAIT, what: 'the project frames' });
  out.identity = await get('/api/project');
  out.page = await get(`/api/mirror/conversations/${S1}/turns?limit=30&items=summary`);
  out.frames = frames.slice();
  return out;
}

// A canvas whose 2d context records nothing it needs to (jsdom has none): the
// favicon's compositing, stubbed as test/favicon.test.js stubs it.
function fakeCanvas() {
  const ctx = { globalCompositeOperation: 'source-over', fillStyle: '#000', clearRect() {}, drawImage() {}, beginPath() {},
    arc() {}, fill() {} };
  return { width: 32, height: 32, getContext: (k) => (k === '2d' ? ctx : null), toDataURL: () => DATA };
}

describe('the real main.js in jsdom, on what a tranche-3 daemon sent', () => {
  let rec = null;
  let shell = null;
  let $ = null;
  const current = { mirror: null, identity: null };
  const stubs = { createCanvas: fakeCanvas, loadImage: async (src) => ({ src }) };

  before(async () => {
    rec = await scratch(record);
    const lastId = (url) => decodeURIComponent(url.split('?')[0].split('/').pop());
    shell = await bootShell({
      routes: {
        '/api/mirror': () => current.mirror,
        '/api/project': () => current.identity,
        '/api/graph': () => rec.graph,
        '/api/graph/node/*': (url) => rec.nodes[lastId(url)],
        '/api/mirror/node/*': (url) => rec.nodeTurns[lastId(url)],
        '/api/mirror/nodes': () => rec.summaries,
        '/api/mirror/tasks/*': () => rec.output,
        '/api/mirror/conversations/*': () => rec.page,
      },
      init: async (sh) => { (await sh.importApp('favicon.js')).initFavicon(stubs); },
    });
    $ = shell.$;
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

  test('main.js calls initChatTrays, initChatDetail and initGraphTurns once each, after tranche 2\'s and initGraph; again adds nothing', async () => {
    const calls = [...fs.readFileSync(path.join(REPO, 'public/app/main.js'), 'utf8').matchAll(/^(init\w+)\(/gm)].map((m) => m[1]);
    const tranche3 = ['initChatTrays', 'initChatDetail', 'initGraphTurns'];
    for (const name of tranche3) assert.equal(calls.filter((c) => c === name).length, 1, `${name} once`);
    const at = calls.indexOf('initChatTrays');
    assert.deepEqual(calls.slice(at, at + 3), tranche3, 'the three, in that order');
    for (const prior of ['initGraph', 'initChatBar', 'initChatDock', 'initChatPanel', 'initChatStream', 'initChatTools', 'initFavicon']) {
      assert.ok(calls.indexOf(prior) >= 0 && calls.indexOf(prior) < at, `after ${prior}`);
    }

    const panel = await shell.importApp('chat-panel.js');
    const shape = () => ({
      trays: shell.document.querySelectorAll('#cs-tray').length,
      tray: shell.document.querySelectorAll('#cs-tray.cs-tray').length,
      devchips: shell.document.querySelectorAll('.cs-devchip').length,
      details: ['task', 'diff', 'turn'].map((k) => panel.hasDetail(k)),
      intervals: shell.intervals().length,
    });
    const once = shape();
    assert.deepEqual(once.details, [true, true, false], 'the task and diff detail views are registered; turn is not');
    assert.equal(once.tray, 1, 'one tray, the trays\' own');
    assert.equal(once.devchips, 0, 'and no stand-in chip');
    (await shell.importApp('chat-trays.js')).initChatTrays();
    (await shell.importApp('chat-detail.js')).initChatDetail();
    (await shell.importApp('graph-turns.js')).initGraphTurns();
    await shell.tick();
    assert.deepEqual(shape(), once, 'a second init of each adds no tray, view, chip or ticker');
  });

  test('a background shell: the "1 shell" chip, its tray row, and an Output tail ending on [exited with code 3]', async () => {
    await show(rec.running);
    const chips = () => [...$('cs-chips').querySelectorAll('.cs-chip')];
    const chip = await waitUntil(() => chips().find((c) => c.dataset.csCat === 'shells'), { ...WAIT, what: 'the shells chip' });
    assert.equal(chip.querySelector('.cs-chip-label').textContent, '1 shell');
    shell.press(chip);
    await shell.tick();
    assert.ok(!$('cs-tray').classList.contains('hidden'), 'the chip opens its tray');
    const row = await waitUntil(() => $('cs-tray-rows').querySelector(`.cs-row[data-id="${SHELL}"]`)
      || [...$('cs-tray-rows').children].find((el) => el.textContent.includes('Start the dev server')), { ...WAIT, what: 'the shell\'s row' });
    assert.match(row.textContent, /Start the dev server/);
    const output = row.querySelector('button[data-action="output"]');
    assert.ok(output, 'the row offers Output');
    shell.click(output);
    const body = row.querySelector('.cs-row-body');
    const tail = await waitUntil(() => {
      const el = body && !body.hidden ? body.querySelector('.cs-row-tail') : null;
      return el && el.textContent.trimEnd().endsWith('[exited with code 3]') ? el : null;
    }, { ...WAIT, what: 'the Output tail' });
    assert.ok(shell.calls.some((c) => c.url.startsWith(`/api/mirror/tasks/${SHELL}/output`)), 'read from the output route');
    assert.match(tail.textContent, /building\noops/);
    assert.equal(body.querySelector('.cs-row-footer').textContent, '[exited with code 3]', 'its footer');
    (await shell.importApp('chat-trays.js')).closeTray({ returnFocus: false });
  });

  test('the turn that edited one file: the bar reads "Done · 1 file changed"', async () => {
    const S = await show(rec.done);
    S.followConversation(S1);
    await shell.tick();
    await waitUntil(() => $('cs-step-text').textContent === 'Done · 1 file changed',
      { ...WAIT, what: `the bar's last turn (it reads "${$('cs-step-text').textContent}")` });
  });

  test('the graph inspector lists the committed node\'s turns', async () => {
    const gv = await shell.importApp('graph-view.js');
    await gv.openOverlay();
    try {
      await gv.selectNode(rec.nodeId);
      const sec = await waitUntil(() => {
        const s = $('gi-turns');
        return s && s.querySelector('.gi-turn') ? s : null;
      }, { ...WAIT, what: '#gi-turns with its rows' });
      const want = rec.nodeTurns[rec.nodeId].turns;
      assert.equal(sec.querySelector('.gi-turns-head').textContent, `CHAT TURNS · ${want.length}`);
      const rows = [...sec.querySelectorAll('.gi-turn')];
      assert.equal(rows.length, want.length);
      const commit = rows.find((r) => r.dataset.role === 'commit');
      assert.ok(commit, 'the turn that committed it');
      assert.equal(commit.querySelector('.gi-turn-text').textContent, 'fix the export');
      assert.match(commit.querySelector('.gi-turn-meta').textContent, /files \+1 −1/, 'with its code totals');
    } finally {
      gv.closeOverlay();
    }
  });

  test('the favicon: #wc-favicon and #wc-favicon-dark move to the project\'s mark, light and dark', async () => {
    const icons = () => [$('wc-favicon').getAttribute('href'), $('wc-favicon-dark').getAttribute('href')];
    const project = rec.frames.filter((f) => f.type === 'project' && f.identity && f.identity.mark);
    assert.ok(project.length >= 3, 'the CLI\'s project frames were recorded');
    current.identity = rec.identity;
    shell.setViewport({ dark: false });
    for (const f of project) shell.socket().receive(f);
    await shell.tick();
    const last = project.at(-1).identity;
    assert.equal(last.mark, 'logo');
    assert.equal(last.mark_dark, true);
    const v = encodeURIComponent(last.logo.version);
    const vd = encodeURIComponent(last.logo_dark.version);
    await waitUntil(() => icons()[0] === `/project/mark?v=${v}`, { ...WAIT, what: `the light mark (${icons()})` });
    assert.deepEqual(icons(), [`/project/mark?v=${v}`, `/project/mark?v=${v}`], 'light: both links on the project\'s mark');
    shell.setViewport({ dark: true });
    await shell.tick();
    assert.deepEqual(icons(), [`/project/mark?mode=dark&v=${vd}`, `/project/mark?mode=dark&v=${vd}`],
      'dark: both links on the project\'s dark mark');
    shell.setViewport({ dark: false });
  });

  test('the stand-ins: the trays took the bar\'s chips, while the phone\'s grip tab still opens "Under development"', async () => {
    await show(rec.running);
    assert.equal($('cs-chips').querySelector('.cs-devchip'), null, 'no stand-in chip');
    assert.ok(!/under development/i.test($('cs-chips').textContent), 'no chip says it is under development');
    const chip = $('cs-chips').querySelector('.cs-chip');
    assert.ok(chip, 'a tray chip');
    shell.press(chip);
    await shell.tick();
    const tray = $('cs-tray');
    assert.ok(tray.classList.contains('cs-tray') && !tray.classList.contains('cs-dev'), '#cs-tray is the trays\' own');
    assert.ok(!tray.classList.contains('hidden'), 'and the chip opened it');
    assert.equal(tray.querySelector('.cs-dev-title'), null, 'not the "Under development" note');
    (await shell.importApp('chat-trays.js')).closeTray({ returnFocus: false });

    shell.setViewport({ width: 390, height: 844 });
    await shell.tick();
    try {
      assert.equal($('chat-pull').hidden, false, 'on a phone the grip tab shows');
      shell.press($('chat-tab'));
      assert.ok(!$('chat-sheet').hidden && !$('chat-sheet').classList.contains('hidden'), 'a tap opens its note');
      assert.equal($('chat-sheet').querySelector('h4').textContent, 'Under development');
      shell.key('Escape');
    } finally {
      shell.setViewport({ width: 1280, height: 800 });
      await shell.tick();
    }
  });
});
