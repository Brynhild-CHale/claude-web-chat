// The chat mirror's one client store (public/app/chat-state.js), in plain node:
// the store is DOM-free and its wiring is injected, so it loads with no jsdom —
// its fetch is a fake, its frames are folded by hand, and the chrome bus it
// listens to is the real one.
//
// What is pinned (design spec §7.3): the wire is read in one place (malformed
// records dropped, unknown fields ignored, every string capped again, the
// control layer's `process.interrupt` and capability keys read); a frame applies
// only when it is newer than what the store holds, and frames that arrive before
// the snapshot are replayed only when newer than it, and every mirror:reset
// reads the snapshot again; below `read` the store holds no content field
// whatever a frame carries; the followed conversation is the tab's choice while
// it is live, else the server's primary, and switching fetches its stream; no
// fallback follows a headless (`claude -p`) conversation (§2.2), and below `read`
// none is followed on a status row's word; the bounds (300 turns, finished tasks
// 15 minutes, a failure until seen) are kept on each fold, with no timer.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { waitUntil } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const APP = path.join(REPO, 'public/app');
const appUrl = (rel) => pathToFileURL(path.join(APP, rel)).href;

let bus;
let shared; // the store module as the chrome loads it, for its pure normalizers
let P;      // chat-present.js: what the bar says about a store
test.before(async () => {
  ({ bus } = await import(appUrl('bus.js')));
  shared = await import(appUrl('chat-state.js'));
  P = await import(appUrl('chat-present.js'));
});

// A store of its own for one test: the module loaded again under a URL of its
// own (its imports — the bus, storage — stay the shared instances), with a fake
// fetch, and its bus listeners removed when the test ends. `conn` is the
// socket's state when it starts ('live' for a test that reads what the bar says).
let loads = 0;
async function makeStore(t, routes = {}, { init = true, conn } = {}) {
  const store = await import(`${appUrl('chat-state.js')}?case=${++loads}`);
  const fetch = fakeFetch(routes);
  if (init) {
    const handle = store.initChatState({ fetch, conn });
    t.after(() => handle.stop());
  }
  return { store, fetch };
}

// Routes: a path (or a path prefix ending in `*`) → a function answering
// { status, body }, or a plain body for a 200. Unknown paths answer 404.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (u) => {
    calls.push(u);
    const pathOnly = u.split('?')[0];
    const key = Object.keys(routes).find((k) => k === u || k === pathOnly || (k.endsWith('*') && u.startsWith(k.slice(0, -1))));
    let v;
    if (key === undefined) v = { status: 404, body: { ok: false, error: 'not found' } };
    else if (typeof routes[key] === 'function') v = await routes[key](u);
    else v = { status: 200, body: routes[key] };
    const status = v.status || 200;
    return { ok: status >= 200 && status < 300, status, json: async () => v.body };
  };
  fn.calls = calls;
  return fn;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// A sessionStorage the storage engine can reach, for one test.
function withSessionStorage(t) {
  const data = new Map();
  const had = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => { data.set(k, String(v)); },
      removeItem: (k) => { data.delete(k); },
    },
  });
  t.after(() => {
    if (had) Object.defineProperty(globalThis, 'sessionStorage', had);
    else delete globalThis.sessionStorage;
  });
  return data;
}

function mirrorEvents(t) {
  const seen = [];
  t.after(bus.on('mirror', (d) => seen.push(d.what)));
  return seen;
}

// The next full read's end (a hydrate announces `mirror` {what: ['all']}). A
// hydrateMirror() called while one is under way queues ANOTHER read by design,
// so a test waits for the one it started this way instead.
function nextHydrate() {
  return new Promise((resolve) => {
    const off = bus.on('mirror', (d) => { if (d.what.includes('all')) { off(); resolve(); } });
  });
}

const T0 = 1_790_000_000_000;
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };
const conv = (id, live = {}, extra = {}) => ({
  id, rev: 1, title: `title of ${id}`, headless: false, counts: ZERO,
  live: { rev: 1, state: 'idle', since: T0 - 60000, last_activity_at: T0 - 60000, ...live }, ...extra,
});
const snapshot = (extra = {}) => ({
  v: 1, enabled: true, now: Date.now(), rev: 10, content: true, access: { level: 'local', remote: false },
  capabilities: {}, primary: 'c1', aggregate: { state: 'idle' }, conversations: [conv('c1')], tasks: [], asks: [],
  ...extra,
});
// A `claude -p` job (CI, a script): a conversation too, but one the store never
// follows on its own (§2.2: a headless session never becomes primary).
const job = (id, live = {}, extra = {}) => conv(id, {
  state: 'working', step: { kind: 'Bash', tool: 'Bash', label: 'Bash · npm run lint', started_at: Date.now() - 5000 }, ...live,
}, { headless: true, process: { pid: 7, kind: 'bg', entrypoint: 'sdk-cli' }, ...extra });
// The basic level's body and frames: StatusRows, which do not say whether a
// session is headless.
const row = (id, state, extra = {}) => ({ id, state, since: T0, last_activity_at: Date.now(), counts: ZERO, ...extra });
const basicSnapshot = (extra = {}) => ({
  v: 1, enabled: true, now: Date.now(), rev: 10, content: false, access: { level: 'basic', remote: true },
  primary: 'u1', aggregate: { state: 'working' }, conversations: [row('u1', 'working', { step_kind: 'Edit' })], asks: [],
  ...extra,
});
const statusFrame = (rev, aggregate, rows) => ({ type: 'mirror:status', rev, now: Date.now(), aggregate: { state: aggregate },
  conversations: rows });
const turn = (id, seq, extra = {}) => ({ id, seq, rev: 1, conversation_id: 'c1', status: 'done', started_at: T0 + seq, ...extra });
const item = (id, turnId, seq, extra = {}) => ({ id, turn_id: turnId, kind: 'reply', seq, rev: 1, text: `reply ${id}`, ...extra });
const page = (turns, extra = {}) => ({ conversation_id: 'c1', turns, next_before: null, total: turns.length, rev: 10, ...extra });

// ── the module itself ────────────────────────────────────────────────────────

test('the store imports only bus.js, storage.js and labels.js, touches no DOM and starts no timer', () => {
  const src = fs.readFileSync(path.join(APP, 'chat-state.js'), 'utf8');
  const imports = [...src.matchAll(/^\s*import\b[^;]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const i of imports) assert.ok(['./bus.js', './storage.js', './labels.js'].includes(i), `chat-state.js imports ${i}`);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\bdocument\b|\bwindow\b|\bHTMLElement\b|ws\.js/, 'DOM-free, and never the socket module');
  assert.doesNotMatch(code, /\bset(?:Timeout|Interval)\b/, 'no timer: the bounds are pruned on each fold');
});

// ── normalize*: the one reader of the wire ───────────────────────────────────

test('normalizeConversation reads process.interrupt and mod, ignores unknown fields and caps every string', () => {
  // As the wire delivers it: JSON, with a `__proto__` key of its own.
  const json = JSON.stringify(conv('c1', {
    step: { kind: 'Edit', tool: 'Edit', label: 'L'.repeat(1000), started_at: T0, secret: 'S' },
    waiting: { kind: 'permission', tool: 'Bash', summary: 'W'.repeat(9000) },
  }, {
    title: 'T'.repeat(5000), evil: 'unknown field',
    process: { pid: 42, kind: 'interactive', interrupt: 'tty', mod: true, token: 'not read' },
  })).replace('{', '{"__proto__":{"polluted":true},');
  const c = shared.normalizeConversation(JSON.parse(json));
  assert.equal(c.id, 'c1');
  assert.deepEqual(c.process, { pid: 42, kind: 'interactive', interrupt: 'tty', mod: true });
  assert.equal(c.title.length, 300);
  assert.equal(c.live.step.label.length, 200);
  assert.equal(c.live.waiting.summary.length, 2048);
  assert.ok(!('evil' in c) && !('secret' in c.live.step), 'unknown fields are ignored');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(c), Object.prototype);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.live) && Object.isFrozen(c.process), 'what the store hands out is frozen');

  for (const interrupt of ['pty', 'TTY', true, undefined]) {
    const p = shared.normalizeConversation(conv('c2', {}, { process: { pid: 1, interrupt } })).process;
    assert.equal(p.interrupt, null, `interrupt ${String(interrupt)} is not the probe's 'tty'`);
    assert.equal(p.mod, false);
  }
  assert.equal(shared.normalizeConversation(conv('c3', {}, { process: null })).process, null);
  for (const bad of [null, [], 'c1', 42, { title: 'no id' }, { id: '../etc' }, { id: '' }, { id: 7 }]) {
    assert.equal(shared.normalizeConversation(bad), null, `${JSON.stringify(bad)} is dropped`);
  }
});

test('normalizeCapabilities reads every capability key, the control layer\'s included, true only when the daemon says so', () => {
  assert.deepEqual([...shared.CAPABILITIES], ['answer', 'task_stop', 'queue_message', 'turn_diff', 'node_diff',
    'attachments', 'agent_items', 'interrupt', 'code_revert', 'fork', 'mod', 'rewind_in_place']);
  const none = shared.normalizeCapabilities(undefined);
  for (const k of shared.CAPABILITIES) assert.equal(none[k], false, `${k} is false until reported`);
  const caps = shared.normalizeCapabilities({
    interrupt: true, code_revert: true, fork: true, mod: true, rewind_in_place: true,
    task_stop: 'yes', answer: 1, extra: true,
  });
  assert.deepEqual(Object.keys(caps).filter((k) => caps[k]).sort(), ['code_revert', 'fork', 'interrupt', 'mod', 'rewind_in_place']);
  assert.ok(!('extra' in caps));
});

test('normalize* drop malformed records, ignore unknown fields and never throw', () => {
  const junk = [null, undefined, 0, 'x', [], [1], true, { constructor: 1 }];
  for (const fn of ['normalizeStatusRow', 'normalizeLive', 'normalizeTask', 'normalizeAsk', 'normalizeTurn', 'normalizeItem',
    'normalizeTurnPage', 'normalizeTurnDetail', 'normalizeSnapshot', 'normalizeFrame', 'normalizeAccess']) {
    for (const v of junk) assert.doesNotThrow(() => shared[fn](v), `${fn}(${JSON.stringify(v)})`);
  }
  // tasks: an id and a known kind, or nothing
  assert.equal(shared.normalizeTask({ id: 'k1', kind: 'daemon' }), null);
  assert.equal(shared.normalizeTask({ kind: 'shell' }), null);
  const t = shared.normalizeTask({ id: 'k1', kind: 'shell', status: 'zombie', title: 'x'.repeat(400), line: 'y'.repeat(400),
    pid: 99, meta: { port: 5173, cmd: 'rm -rf /' }, steps: Array.from({ length: 40 }, () => ({ label: 's', state: 'done' })) });
  assert.equal(t.status, 'unknown', 'an unknown status is read as unknown');
  assert.equal(t.title.length, 300);
  assert.equal(t.line.length, 300);
  assert.deepEqual(t.meta, { port: 5173 });
  assert.equal(t.steps.length, 32);
  assert.ok(!('pid' in t));
  // asks: an id and a kind
  assert.equal(shared.normalizeAsk({ id: 'ask_1' }), null);
  assert.equal(shared.normalizeAsk({ id: 'ask_1', kind: 'permission', subject: 'rm -rf /' }).subject, undefined);
  // status rows: a step kind is a word, never an MCP tool's full name
  const row = shared.normalizeStatusRow({ id: 'c1', state: 'working', step_kind: 'mcp__svc__do', counts: { shells: { running: 2, total: 3 } } });
  assert.equal(row.step_kind, undefined);
  assert.deepEqual(row.counts, { shells: 2, agents: 0, workflows: 0, monitors: 0 });
  assert.equal(shared.normalizeStatusRow({ state: 'idle' }), null);
  // items: a turn, a known kind, an id
  assert.equal(shared.normalizeItem({ id: 'r_1', kind: 'reply', text: 'x' }), null, 'no turn');
  assert.equal(shared.normalizeItem({ id: 'r_1', turn_id: 't1', kind: 'shout', text: 'x' }), null, 'unknown kind');
  const it = shared.normalizeItem({ id: 'toolu_1', turn_id: 't1', kind: 'tool_call', tool: 'Bash', label: 'Bash · x'.repeat(50),
    input: { command: 'c'.repeat(600), nested: { deep: 'd' } }, result: { preview: 'p'.repeat(3000), raw: 'no' } });
  assert.equal(it.label.length, 200);
  assert.equal(it.input.command.length, 512, 'tool input strings are cut at 512');
  assert.deepEqual(it.input.nested, { deep: 'd' });
  assert.equal(it.result.preview.length, 2048);
  assert.ok(!('raw' in it.result));
  const big = shared.normalizeItem({ id: 'toolu_2', turn_id: 't1', kind: 'tool_call',
    input: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'v'.repeat(500)])) });
  assert.equal(big.input, undefined, 'an input past its total is dropped whole');
  assert.equal(big.truncated, true);
  assert.equal(shared.normalizeItem({ id: 'r_2', turn_id: 't1', kind: 'reply', text: 'r'.repeat(40000) }).text.length, 32768);
  assert.equal(shared.normalizeItem({ id: 'r_3', turn_id: 't1', kind: 'reply', text: 'r'.repeat(40000) }, { caps: 'full' }).text.length, 40000);
  // frames: a frame with a rev must carry one; unknown types are nothing
  assert.equal(shared.normalizeFrame({ type: 'mirror:status', conversations: [] }), null);
  assert.equal(shared.normalizeFrame({ type: 'mirror:update', rev: 1 }), null, 'no conversation');
  assert.equal(shared.normalizeFrame({ type: 'mirror:telemetry', rev: 1 }), null);
  assert.equal(shared.normalizeFrame({ type: 'mirror:access', level: 'admin' }), null);
  assert.equal(shared.normalizeFrame({ type: 'mirror:ask', op: 'open', ask: { kind: 'plan' } }), null);
  const status = shared.normalizeFrame({ type: 'mirror:status', rev: 3, conversations: [{ id: 'c1', state: 'working' }, { nope: 1 }, 5] });
  assert.deepEqual(status.conversations.map((r) => r.id), ['c1'], 'a malformed row is dropped, the frame kept');
  const agg = (state) => shared.normalizeFrame({ type: 'mirror:status', rev: 3, aggregate: { state }, conversations: [] }).aggregate.state;
  assert.deepEqual([agg('none'), agg('waiting'), agg('asleep'), agg(5)], ['none', 'waiting', 'unknown', 'unknown']);
  // an ended conversation's row says why, from its live state
  const ended = shared.normalizeConversation(conv('c9', { state: 'ended', ended_reason: 'process-gone' }));
  assert.equal(shared.statusFromConversation(ended).ended_reason, 'process-gone');
});

test('normalizeSnapshot below read keeps states, counts and timings only, whatever the body carries', () => {
  const snap = shared.normalizeSnapshot({
    v: 1, enabled: true, now: T0, rev: 4, content: false, access: { level: 'basic', remote: true },
    capabilities: { task_stop: true, answer: true }, primary: 'c1',
    conversations: [{ id: 'c1', state: 'working', since: T0, quiet: false, step_kind: 'Edit', waiting_kind: undefined,
      last_activity_at: T0, counts: { shells: 2 }, title: 'SECRET title', live: { step: { label: 'Edit · SECRET.txt' } } }],
    tasks: [{ id: 'k1', kind: 'shell', title: 'SECRET command', status: 'running' }],
    asks: [{ id: 'ask_1', kind: 'permission', conversation_id: 'c1', tool_name: 'SECRET tool', tool_kind: 'Bash', state: 'pending' }],
  });
  assert.equal(snap.content, false);
  assert.equal(snap.access.level, 'basic');
  assert.deepEqual(snap.conversations, []);
  assert.deepEqual(snap.tasks, []);
  assert.deepEqual(Object.keys(snap.status[0]).sort(), ['counts', 'id', 'last_activity_at', 'quiet', 'since', 'state', 'step_kind']);
  assert.deepEqual(snap.asks[0], { id: 'ask_1', conversation_id: 'c1', kind: 'permission', tool_kind: 'Bash', state: 'pending', source: 'ask' });
  assert.ok(Object.values(snap.capabilities).every((v) => v === false), 'no capability below read');
  assert.doesNotMatch(JSON.stringify(snap), /SECRET/);
  // `content: false` wins over a level that claims more
  assert.equal(shared.normalizeSnapshot({ ...snapshot(), content: false }).content, false);
  // a disabled mirror
  assert.deepEqual({ ...shared.normalizeSnapshot({ ok: false, disabled: true, scope: 'project', hint: 'claude-web-chat on' }) },
    { disabled: true, hint: 'claude-web-chat on', scope: 'project' });
  assert.equal(shared.normalizeSnapshot({ v: 1, enabled: false }).disabled, true);
});

// ── hydration ────────────────────────────────────────────────────────────────

test('hydrateMirror: a 404 is an older daemon (unavailable), {enabled: false} is disabled with the server\'s hint', async (t) => {
  const old = await makeStore(t, {});
  await old.store.hydrateMirror();
  assert.equal(old.store.mirror.availability, 'unavailable');
  assert.deepEqual(old.fetch.calls, ['/api/mirror']);

  const off = await makeStore(t, { '/api/mirror': { v: 1, enabled: false, hint: 'web-chat is off here — claude-web-chat on' } });
  await off.store.hydrateMirror();
  assert.equal(off.store.mirror.availability, 'disabled');
  assert.equal(off.store.mirror.hint, 'web-chat is off here — claude-web-chat on');

  const ok = await makeStore(t, { '/api/mirror': snapshot({ capabilities: { interrupt: true } }) });
  const events = mirrorEvents(t);
  await ok.store.hydrateMirror();
  const m = ok.store.mirror;
  assert.equal(m.availability, 'ok');
  assert.equal(m.access.level, 'local');
  assert.equal(m.capabilities.interrupt, true);
  assert.equal(m.serverPrimary, 'c1');
  assert.equal(m.followed, 'c1');
  assert.equal(m.status.get('c1').state, 'idle', 'the status rows are derived from the conversations');
  assert.ok(Math.abs(ok.store.serverNow() - Date.now()) < 5000, 'skew from the snapshot\'s now');
  assert.deepEqual(events.at(-1), ['all']);
});

test('a frame applies only when it is newer than what the store holds', async (t) => {
  // A snapshot read at rev 10, whose objects last changed at rev 10.
  const { store } = await makeStore(t, { '/api/mirror': snapshot({
    conversations: [conv('c1', { rev: 10 }, { rev: 10 })],
    tasks: [{ id: 'k1', rev: 10, conversation_id: 'c1', kind: 'shell', title: 'npm run dev', status: 'running', started_at: T0 }],
  }) });
  await store.hydrateMirror();
  const m = store.mirror;
  const live = (rev, state) => ({ type: 'mirror:update', rev, now: Date.now(), conversation_id: 'c1', live: { rev, state, since: T0 } });

  store.foldMirrorFrame(live(9, 'working'));
  assert.equal(m.conversations.get('c1').live.state, 'idle', 'an older live state is ignored');
  store.foldMirrorFrame(live(11, 'working'));
  assert.equal(m.conversations.get('c1').live.state, 'working');
  store.foldMirrorFrame(live(11, 'question'));
  assert.equal(m.conversations.get('c1').live.state, 'working', 'the same rev again changes nothing');
  assert.equal(m.status.get('c1').state, 'working', 'the status row follows the newer live state');

  const task = (rev, status) => ({ type: 'mirror:update', rev, now: Date.now(), conversation_id: 'c1',
    tasks: [{ id: 'k1', rev, kind: 'shell', title: 'npm run dev', status, started_at: T0, ended_at: Date.now() }] });
  store.foldMirrorFrame(task(10, 'failed'));
  assert.equal(m.tasks.get('k1').status, 'running');
  store.foldMirrorFrame(task(12, 'done'));
  assert.equal(m.tasks.get('k1').status, 'done');
  assert.equal(m.tasks.get('k1').conversation_id, 'c1', 'a task row takes its frame\'s conversation');

  const status = (rev, state) => ({ type: 'mirror:status', rev, now: Date.now(), aggregate: { state },
    conversations: [{ id: 'c1', state, since: T0, counts: ZERO }] });
  store.foldMirrorFrame(status(10, 'question'));
  assert.equal(m.status.get('c1').state, 'working', 'a status frame at the snapshot\'s rev is not newer');
  store.foldMirrorFrame(status(13, 'question'));
  assert.equal(m.status.get('c1').state, 'question');
  assert.equal(m.aggregate.state, 'question');
});

test('frames that arrive before the snapshot are buffered, and only those newer than it applied', async (t) => {
  const gate = deferred();
  const { store } = await makeStore(t, { '/api/mirror': () => gate.promise });
  const m = store.mirror;
  const frame = (rev, state) => ({ type: 'mirror:update', rev, now: Date.now(), conversation_id: 'c1',
    live: { rev, state, since: T0 } });

  store.foldMirrorFrame(frame(8, 'question'));          // before any hello: waits
  const hydrating = store.hydrateMirror();
  store.foldMirrorFrame(frame(9, 'waiting'));           // during the read: waits
  store.foldMirrorFrame(frame(12, 'working'));
  store.foldMirrorFrame({ type: 'mirror:status', rev: 10, now: Date.now(), aggregate: { state: 'suspended' },
    conversations: [{ id: 'c1', state: 'suspended', counts: ZERO }] });
  assert.equal(m.conversations.size, 0, 'nothing applies before the snapshot');
  gate.resolve({ status: 200, body: snapshot({ rev: 10, conversations: [conv('c1', { rev: 10, state: 'idle' })] }) });
  await hydrating;
  assert.equal(m.conversations.get('c1').live.state, 'working', 'the frame newer than the snapshot applied');
  assert.equal(m.conversations.get('c1').live.rev, 12);
  assert.notEqual(m.status.get('c1').state, 'suspended', 'the status frame at the snapshot\'s rev did not');
});

test('a mirror:reset reads the snapshot again; mirror:access refetches, and a fall below read purges content', async (t) => {
  let reads = 0;
  let level = 'local';
  const { store, fetch } = await makeStore(t, {
    '/api/mirror': () => {
      reads++;
      return { status: 200, body: level === 'basic'
        ? { v: 1, enabled: true, now: Date.now(), rev: 20 + reads, content: false, access: { level: 'basic', remote: true },
          primary: 'c1', conversations: [{ id: 'c1', state: 'working', since: T0, counts: { shells: 1 } }], asks: [] }
        : snapshot({ rev: 20 + reads, tasks: [{ id: 'k1', kind: 'shell', title: 'npm run dev', status: 'running' }] }) };
    },
  });
  await store.hydrateMirror();
  const reread = nextHydrate();
  store.foldMirrorFrame({ type: 'mirror:reset', reason: 'catch-up' });
  await reread;
  assert.equal(reads, 2, 'the reset read the snapshot again');

  level = 'basic';
  store.foldMirrorFrame({ type: 'mirror:access', level: 'basic', remote: true });
  const m = store.mirror;
  assert.equal(m.access.level, 'basic');
  assert.equal(m.conversations.size, 0, 'content goes the moment the level falls');
  assert.equal(m.tasks.size, 0);
  await store.hydrateMirror();
  assert.equal(m.status.get('c1').state, 'working');
  assert.deepEqual(m.status.get('c1').counts, { shells: 1, agents: 0, workflows: 0, monitors: 0 });
  assert.ok(fetch.calls.filter((u) => u === '/api/mirror').length >= 3, 'the level change read the snapshot again');
});

test('a reset of the followed conversation reads the snapshot again, and its stream after it while a chat view is open', async (t) => {
  const task = (id, rev) => ({ id, rev, conversation_id: 'c1', kind: 'shell', title: id, status: 'running', started_at: T0 });
  let reads = 0;
  const { store, fetch } = await makeStore(t, {
    '/api/mirror': () => ({ status: 200, body: ++reads === 1
      ? snapshot({ conversations: [conv('c1', { rev: 10 }, { rev: 10 })], tasks: [task('old-task', 10)] })
      : snapshot({ rev: 12, conversations: [conv('c1', { rev: 12 }, { rev: 12 })], tasks: [task('new-task', 12)] }) }),
    '/api/mirror/conversations/c1/turns': page([{ ...turn('t1', 1), items: [] }], { rev: 12 }),
  });
  await store.hydrateMirror();
  const m = store.mirror;
  assert.equal(store.followed(), 'c1');
  assert.deepEqual([...m.tasks.keys()], ['old-task']);

  // c1 removed and added back between two flushes (lib/server/mirror/emit.js):
  // the update says what the new incarnation holds, and no delta can say that
  // the old one's rows are gone — the `rebuilt` reset after it does.
  store.foldMirrorFrame({ type: 'mirror:update', rev: 12, now: Date.now(), conversation_id: 'c1',
    conversation: conv('c1', { rev: 12 }, { rev: 12 }), tasks: [task('new-task', 12)] });
  assert.deepEqual([...m.tasks.keys()].sort(), ['new-task', 'old-task']);
  store.foldMirrorFrame({ type: 'mirror:reset', reason: 'rebuilt', conversation_id: 'c1' });
  await waitUntil(() => !m.tasks.has('old-task'), { what: 'the snapshot read again after the reset' });
  assert.equal(reads, 2, 'the reset read the snapshot again, though no chat view is open');
  assert.deepEqual([...m.tasks.keys()], ['new-task'], 'and the old incarnation\'s running task is gone');
  assert.deepEqual(P.categories(m, null).map((c) => c.label), ['1 shell'], 'so the chip no longer counts it');
  assert.deepEqual(fetch.calls, ['/api/mirror', '/api/mirror'], 'no stream is read while no chat view is open');

  // Every reason does the same: a catch-up's frames may include update frames
  // that failed to go out, since a reset already due keeps its own reason.
  // With a chat view open, the followed stream is read after the snapshot.
  bus.emit('chat:posture', { posture: 'full' });
  t.after(() => bus.emit('chat:posture', { posture: 'status' }));
  await waitUntil(() => m.stream.turns.length === 1 && !m.stream.loading, { what: 'the first page' });
  const opened = fetch.calls.length;
  store.foldMirrorFrame({ type: 'mirror:reset', reason: 'catch-up', conversation_id: 'c1' });
  await waitUntil(() => fetch.calls.length === opened + 2 && !m.stream.loading, { what: 'the snapshot, then the stream' });
  assert.deepEqual(fetch.calls.slice(opened), ['/api/mirror', '/api/mirror/conversations/c1/turns?limit=30&items=summary']);
  assert.deepEqual(m.stream.turns.map((x) => x.id), ['t1'], 'the stream shown meanwhile is kept, then replaced');
});

// ── below read ───────────────────────────────────────────────────────────────

test('below read the store holds no content field even when a frame carries one', async (t) => {
  const { store } = await makeStore(t, { '/api/mirror': {
    v: 1, enabled: true, now: Date.now(), rev: 5, content: false, access: { level: 'basic', remote: true }, primary: 'c1',
    conversations: [{ id: 'c1', state: 'working', since: T0, step_kind: 'Edit', counts: { shells: 1 }, title: 'SECRET' }],
    asks: [],
  } });
  await store.hydrateMirror();
  const m = store.mirror;
  bus.emit('chat:posture', { posture: 'full' });
  t.after(() => bus.emit('chat:posture', { posture: 'status' }));

  store.foldMirrorFrame({ type: 'mirror:update', rev: 6, now: Date.now(), conversation_id: 'c1',
    conversation: conv('c1', { step: { kind: 'Edit', label: 'Edit · SECRET.env' } }, { title: 'SECRET' }),
    live: { rev: 6, state: 'working', step: { kind: 'Edit', label: 'Edit · SECRET.env' }, waiting: { kind: 'other', summary: 'SECRET' } },
    tasks: [{ id: 'k1', kind: 'shell', title: 'SECRET cmd', status: 'running', line: 'SECRET out' }] });
  store.foldMirrorFrame({ type: 'mirror:stream', rev: 7, now: Date.now(), conversation_id: 'c1',
    turns: [turn('t1', 1, { prompt: { preview: 'SECRET prompt', origin: 'human' } })],
    items: [item('r_1', 't1', 1, { text: 'SECRET reply' })] });
  store.foldMirrorFrame({ type: 'mirror:status', rev: 8, now: Date.now(), aggregate: { state: 'waiting' },
    conversations: [{ id: 'c1', state: 'waiting', waiting_kind: 'permission', since: T0, counts: { shells: 1 },
      title: 'SECRET', step: { label: 'SECRET' }, summary: 'SECRET' }] });
  store.foldMirrorFrame({ type: 'mirror:ask', op: 'open', ask: { id: 'ask_1', conversation_id: 'c1', kind: 'permission',
    tool_name: 'SECRET', tool_kind: 'Bash', state: 'pending', answerable: true } });

  assert.equal(m.conversations.size, 0);
  assert.equal(m.tasks.size, 0);
  assert.equal(m.stream.turns.length, 0);
  assert.equal(m.status.get('c1').state, 'waiting', 'states, counts and timings stay');
  assert.equal(m.status.get('c1').waiting_kind, 'permission');
  const held = JSON.stringify({ status: [...m.status.values()], awaiting: [...m.awaiting.values()], stream: m.stream,
    conversations: [...m.conversations.values()], tasks: [...m.tasks.values()] });
  assert.doesNotMatch(held, /SECRET/, 'no content field is held');
  assert.deepEqual([...m.awaiting.keys()], ['ask_1']);
  assert.equal(m.awaiting.get('ask_1').tool_name, undefined);
});

// ── following ────────────────────────────────────────────────────────────────

test('the followed conversation is the tab\'s choice (wc:chat-follow) while it is live, else the server\'s primary', async (t) => {
  const saved = withSessionStorage(t);
  const body = snapshot({ conversations: [conv('c1', { state: 'working' }), conv('c2', { state: 'idle' })] });
  const { store } = await makeStore(t, { '/api/mirror': body });
  await store.hydrateMirror();
  const m = store.mirror;
  assert.equal(store.followed(), 'c1', 'the server\'s primary');
  assert.equal(store.followConversation('c2'), 'c2');
  assert.equal(saved.get('wc:chat-follow'), 'c2');
  assert.equal(m.followed, 'c2');

  store.foldMirrorFrame({ type: 'mirror:update', rev: 11, now: Date.now(), conversation_id: 'c2', live: { rev: 11, state: 'ended', since: T0 } });
  assert.equal(store.followed(), 'c1', 'an ended choice gives way to the primary');
  assert.equal(saved.get('wc:chat-follow'), 'c2', 'the choice itself is kept');

  store.foldMirrorFrame({ type: 'mirror:update', rev: 12, now: Date.now(), conversation_id: 'c2', live: { rev: 12, state: 'working', since: T0 } });
  assert.equal(store.followed(), 'c2', 'and it is followed again once it is live (a resume)');

  store.foldMirrorFrame({ type: 'mirror:update', rev: 13, now: Date.now(), conversation_id: 'c2', merged_into: 'c1' });
  assert.equal(saved.get('wc:chat-follow'), 'c1', 'a merge carries the choice to the conversation that absorbed it');
  assert.equal(store.followed(), 'c1');
  assert.equal(m.conversations.has('c2'), false);

  store.followConversation(null);
  assert.equal(saved.has('wc:chat-follow'), false);

  // A new store (a reload of the tab) reads the choice back.
  saved.set('wc:chat-follow', 'c2');
  const again = await makeStore(t, { '/api/mirror': body });
  await again.store.hydrateMirror();
  assert.equal(again.store.followed(), 'c2');

  // With the primary gone, the most urgent live conversation, never a headless one.
  saved.delete('wc:chat-follow');
  const urgent = await makeStore(t, { '/api/mirror': snapshot({ primary: 'gone', conversations: [
    conv('a', { state: 'idle', last_activity_at: T0 }),
    conv('b', { state: 'waiting', waiting: { kind: 'permission' } }, { headless: true }),
    conv('c', { state: 'question' }),
  ] }) });
  await urgent.store.hydrateMirror();
  assert.equal(urgent.store.followed(), 'c');
});

test('switching the followed conversation fetches its stream while a chat view is open', async (t) => {
  const body = snapshot({ conversations: [conv('c1', { state: 'working' }), conv('c2')] });
  const { store, fetch } = await makeStore(t, {
    '/api/mirror': body,
    '/api/mirror/conversations/c1/turns': page([{ ...turn('t1', 1), items: [item('r_1', 't1', 1)] }]),
    '/api/mirror/conversations/c2/turns': page([{ ...turn('u1', 1, { conversation_id: 'c2' }), items: [] }], { conversation_id: 'c2' }),
  });
  const turnReads = () => fetch.calls.filter((u) => u.includes('/turns'));
  await store.hydrateMirror();
  assert.deepEqual(turnReads(), [], 'no stream is read while no chat view is open');

  // A chat view opens: the stream's frames flow to this socket from now on, so
  // the followed conversation's newest page is read.
  bus.emit('chat:posture', { posture: 'full' });
  t.after(() => bus.emit('chat:posture', { posture: 'status' }));
  const m = store.mirror;
  await waitUntil(() => m.stream.turns.length === 1, { what: 'the first page of c1' });
  assert.deepEqual(turnReads(), ['/api/mirror/conversations/c1/turns?limit=30&items=summary']);
  assert.equal(m.stream.conversationId, 'c1');
  assert.deepEqual(m.stream.turns.map((x) => x.id), ['t1']);
  assert.deepEqual(m.stream.turns[0].items.map((x) => x.id), ['r_1']);

  store.followConversation('c2');
  assert.equal(m.stream.conversationId, 'c2', 'a new conversation starts its stream empty');
  await waitUntil(() => m.stream.turns.length === 1, { what: 'the first page of c2' });
  assert.equal(turnReads().at(-1), '/api/mirror/conversations/c2/turns?limit=30&items=summary');
  assert.deepEqual(m.stream.turns.map((x) => x.id), ['u1']);
  assert.equal(turnReads().length, 2);
});

test('at read and above no fallback follows a headless conversation: only the tab\'s own choice does', async (t) => {
  const saved = withSessionStorage(t);
  // Only a CI job is live; the server names no primary and its aggregate,
  // which speaks for interactive sessions only, says `none`.
  const { store } = await makeStore(t, { '/api/mirror': snapshot({ primary: null, aggregate: { state: 'none' },
    conversations: [job('ci')] }) }, { conn: 'live' });
  await store.hydrateMirror();
  const m = store.mirror;
  assert.equal(store.followed(), null, 'the job is not followed on its own');
  assert.equal(P.uiState(m).text, 'No Claude session', 'and the bar does not read `Bash · npm run lint · 0:05`');

  // Its frames move nothing.
  store.foldMirrorFrame(statusFrame(11, 'none', [row('ci', 'working', { step_kind: 'Bash' })]));
  store.foldMirrorFrame({ type: 'mirror:update', rev: 12, now: Date.now(), conversation_id: 'ci',
    live: { rev: 12, state: 'idle', since: T0, last_activity_at: Date.now() } });
  assert.equal(store.followed(), null);

  // An ended interactive session is followed before it, so the bar can say it ended.
  store.foldMirrorFrame({ type: 'mirror:update', rev: 13, now: Date.now(), conversation_id: 'u1',
    conversation: conv('u1', { rev: 13, state: 'ended', ended_reason: 'process-gone' }, { rev: 13 }) });
  assert.equal(store.followed(), 'u1');
  assert.match(P.uiState(m).text, /^Session ended/);

  // The switcher's "Show headless": a headless conversation is followed by choice.
  assert.equal(store.followConversation('ci'), 'ci');
  // Once it ends, no fallback keeps it.
  store.foldMirrorFrame({ type: 'mirror:update', rev: 14, now: Date.now(), conversation_id: 'ci',
    live: { rev: 14, state: 'ended', since: T0 } });
  assert.equal(store.followed(), 'u1', 'not the ended job: the last interactive session');
  store.foldMirrorFrame({ type: 'mirror:update', rev: 15, now: Date.now(), conversation_id: 'u1', removed: true });
  assert.equal(store.followed(), null, 'and with none, nothing');
  assert.equal(saved.get('wc:chat-follow'), 'ci', 'the choice itself is kept, for when the job is live again');

  // A primary that turns out to be headless is not followed either.
  saved.delete('wc:chat-follow');
  const odd = await makeStore(t, { '/api/mirror': snapshot({ primary: 'ci', aggregate: { state: 'none' },
    conversations: [job('ci')] }) });
  await odd.store.hydrateMirror();
  assert.equal(odd.store.followed(), null);
});

test('below read nothing is followed on a status row\'s word, so a headless job never becomes the bar\'s session', async (t) => {
  // The user's session ends while a CI job works. A StatusRow does not say
  // the job is headless, so the store follows only what the server named.
  const { store, fetch } = await makeStore(t, { '/api/mirror': basicSnapshot() }, { conn: 'live' });
  await store.hydrateMirror();
  const m = store.mirror;
  assert.equal(store.followed(), 'u1', 'the server\'s primary');

  store.foldMirrorFrame(statusFrame(11, 'ended', [row('ci', 'working', { step_kind: 'Bash' }),
    row('u1', 'ended', { ended_reason: 'process-gone' })]));
  assert.equal(store.followed(), 'u1', 'the ended session, never the working job');
  assert.match(P.uiState(m).text, /^Session ended/);
  assert.doesNotMatch(P.uiState(m).text, /Working|Bash/, 'the bar does not read `Working · Bash · 0:05`');

  // The ended session is gone too: no interactive conversation is left.
  store.foldMirrorFrame(statusFrame(12, 'none', [row('ci', 'working', { step_kind: 'Bash' })]));
  assert.equal(store.followed(), null);
  assert.equal(P.uiState(m).text, 'No Claude session');
  assert.deepEqual(fetch.calls, ['/api/mirror'], 'a headless job alone is no reason to ask the server again');

  // A tab that opens on the job alone.
  const fresh = await makeStore(t, { '/api/mirror': basicSnapshot({ primary: null, aggregate: { state: 'none' },
    conversations: [row('ci', 'working', { step_kind: 'Bash' })] }) }, { conn: 'live' });
  await fresh.store.hydrateMirror();
  assert.equal(fresh.store.followed(), null);
  assert.equal(P.uiState(fresh.store.mirror).text, 'No Claude session');
});

test('below read, a live interactive session the snapshot did not name makes the store ask the server again', async (t) => {
  // The tab opened before `claude` started: no primary, and nothing live.
  const answers = [
    basicSnapshot({ primary: null, aggregate: { state: 'none' }, conversations: [] }),
    basicSnapshot({ rev: 12, primary: 'v1', aggregate: { state: 'idle' }, conversations: [row('v1', 'idle')] }),
  ];
  let reads = 0;
  const { store } = await makeStore(t, { '/api/mirror': () => ({ status: 200, body: answers[Math.min(reads++, answers.length - 1)] }) },
    { conn: 'live' });
  await store.hydrateMirror();
  assert.equal(store.followed(), null);

  // The aggregate now speaks for an interactive session that is live, which
  // the rows alone cannot point at: the server is asked which one it is.
  store.foldMirrorFrame(statusFrame(11, 'idle', [row('v1', 'idle')]));
  assert.equal(store.followed(), null, 'never picked from the rows themselves');
  await waitUntil(() => store.followed() === 'v1', { what: 'the server\'s primary, read again' });
  assert.equal(reads, 2);
  assert.equal(P.uiState(store.mirror).key, 'idle');
  assert.notEqual(P.uiState(store.mirror).text, 'No Claude session');
  store.foldMirrorFrame(statusFrame(13, 'working', [row('v1', 'working', { step_kind: 'Edit' })]));
  assert.equal(reads, 2, 'followed and live: no reason to ask again');

  // A server that still names no primary is asked once per set of live
  // conversations, never again about the same ones.
  let lagging = 0;
  const lagBodies = [
    basicSnapshot({ primary: null, aggregate: { state: 'none' }, conversations: [] }),
    basicSnapshot({ rev: 20, primary: null, aggregate: { state: 'idle' }, conversations: [row('v1', 'idle')] }),
    basicSnapshot({ rev: 30, primary: null, aggregate: { state: 'working' },
      conversations: [row('v1', 'working', { step_kind: 'Edit' }), row('v2', 'idle')] }),
  ];
  const lag = await makeStore(t, { '/api/mirror': () => ({ status: 200, body: lagBodies[Math.min(lagging++, 2)] }) });
  await lag.store.hydrateMirror();
  lag.store.foldMirrorFrame(statusFrame(11, 'idle', [row('v1', 'idle')]));
  await waitUntil(() => lag.store.mirror.rev === 20, { what: 'the second read' });
  assert.equal(lagging, 2);
  lag.store.foldMirrorFrame(statusFrame(21, 'working', [row('v1', 'working', { step_kind: 'Edit' })]));
  assert.equal(lagging, 2, 'the same live session: not asked again');
  lag.store.foldMirrorFrame(statusFrame(22, 'working', [row('v1', 'working', { step_kind: 'Edit' }), row('v2', 'idle')]));
  await waitUntil(() => lag.store.mirror.rev === 30, { what: 'the third read' });
  assert.equal(lagging, 3, 'another live session: asked once more, and only once');
  assert.equal(lag.store.followed(), null, 'still nothing on a row\'s word');
});

// ── the stream ───────────────────────────────────────────────────────────────

test('stream frames: newer only, the alias of a provisional turn, and frames held while the page is read', async (t) => {
  const gate = deferred();
  const { store } = await makeStore(t, {
    '/api/mirror': snapshot(),
    '/api/mirror/conversations/c1/turns': () => gate.promise,
  });
  bus.emit('chat:posture', { posture: 'full' });
  t.after(() => bus.emit('chat:posture', { posture: 'status' }));
  const done = store.hydrateMirror();
  const m = store.mirror;
  const sframe = (rev, extra) => ({ type: 'mirror:stream', rev, now: Date.now(), conversation_id: 'c1', ...extra });
  await new Promise((r) => setImmediate(r));
  assert.equal(m.stream.loading, true);
  store.foldMirrorFrame(sframe(9, { items: [item('r_1', 't1', 1, { rev: 9, text: 'old' })] }));
  store.foldMirrorFrame(sframe(12, { turns: [turn('t2', 2, { rev: 12, status: 'open' })] }));
  gate.resolve({ status: 200, body: page([{ ...turn('t1', 1, { rev: 10 }), items: [item('r_1', 't1', 1, { rev: 10, text: 'page' })] }], { rev: 10 }) });
  await done;
  assert.deepEqual(m.stream.turns.map((x) => x.id), ['t1', 't2'], 'the frame newer than the page joined it');
  assert.equal(m.stream.turns[0].items[0].text, 'page', 'the one older than the page did not');

  store.foldMirrorFrame(sframe(13, { items: [item('r_1', 't1', 1, { rev: 13, text: 'newer' }), item('p_t2', 't2', 0, { rev: 13, kind: 'prompt', text: 'hi' })] }));
  assert.equal(m.stream.turns[0].items[0].text, 'newer');
  store.foldMirrorFrame(sframe(11, { items: [item('r_1', 't1', 1, { rev: 11, text: 'stale' })] }));
  assert.equal(m.stream.turns[0].items[0].text, 'newer', 'an older item is ignored');

  // The provisional t2 takes the transcript's id; its re-keyed items arrive, the old ids leave.
  store.foldMirrorFrame(sframe(14, {
    turns: [turn('T2', 2, { rev: 14, replaces: 't2', status: 'open' })],
    items: [item('p_T2', 'T2', 0, { rev: 14, kind: 'prompt', text: 'hi' })],
    removed_items: ['p_t2'],
  }));
  assert.deepEqual(m.stream.turns.map((x) => x.id), ['t1', 'T2']);
  assert.deepEqual(m.stream.turns[1].items.map((x) => x.id), ['p_T2']);
  assert.ok(Object.isFrozen(m.stream.turns) && Object.isFrozen(m.stream.turns[1]) && Object.isFrozen(m.stream.turns[1].items));

  // A frame about a turn older than the window does not open a gap at its top.
  store.foldMirrorFrame(sframe(15, { turns: [turn('t0', 0, { rev: 15 })] }));
  assert.equal(m.stream.turns.map((x) => x.id).join(), 't1,T2', 'already full from the first turn: nothing older joins');
});

test('the stream keeps 300 turns, and loadOlder reads one page at a time', async (t) => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...turn(`t${i + 400}`, i + 400), items: [] }));
  const older = deferred();
  const { store, fetch } = await makeStore(t, {
    '/api/mirror': snapshot(),
    '/api/mirror/conversations/c1/turns': (u) => (u.includes('before=')
      ? older.promise
      : { status: 200, body: page(many, { next_before: 400, total: 1000 }) }),
  });
  bus.emit('chat:posture', { posture: 'full' });
  t.after(() => bus.emit('chat:posture', { posture: 'status' }));
  await store.hydrateMirror();
  const m = store.mirror;
  assert.equal(m.stream.hasOlder, true);

  const a = store.loadOlder();
  const b = store.loadOlder();
  assert.equal(a, b, 'a second call while one is under way joins it');
  older.resolve({ status: 200, body: page(Array.from({ length: 30 }, (_, i) => ({ ...turn(`t${i + 370}`, i + 370), items: [] })),
    { next_before: 370, total: 1000 }) });
  assert.equal(await a, true);
  assert.equal(fetch.calls.filter((u) => u.includes('before=')).length, 1);
  assert.equal(fetch.calls.find((u) => u.includes('before=')), '/api/mirror/conversations/c1/turns?before=400&limit=30&items=summary');
  assert.equal(m.stream.turns.length, 60);
  assert.equal(m.stream.turns[0].id, 't370');

  // Live turns past the bound push the oldest out.
  const fresh = Array.from({ length: 260 }, (_, i) => turn(`n${i}`, 1000 + i, { rev: 20 }));
  store.foldMirrorFrame({ type: 'mirror:stream', rev: 20, now: Date.now(), conversation_id: 'c1', turns: fresh });
  assert.equal(m.stream.turns.length, store.MAX_TURNS);
  assert.equal(m.stream.turns.at(-1).id, 'n259');
  assert.equal(m.stream.turns[0].id, 't390', 'the oldest went first');
  assert.equal(m.stream.hasOlder, true);
  assert.equal(await store.loadOlder(), false, 'at the bound, nothing older is read');
});

// ── bounds and seen ──────────────────────────────────────────────────────────

test('finished tasks go 15 minutes after they end; a failure stays until it has been seen', async (t) => {
  const now = Date.now();
  const task = (id, status, endedAgoMin, extra = {}) => ({ id, rev: 10, conversation_id: 'c1', kind: 'shell', title: id, status,
    started_at: now - 3600000, ...(endedAgoMin === null ? {} : { ended_at: now - endedAgoMin * 60000 }), ...extra });
  const { store } = await makeStore(t, { '/api/mirror': snapshot({ now, tasks: [
    task('running', 'running', null), task('fresh', 'done', 5), task('old', 'done', 16), task('broke', 'failed', 40),
    task('killed', 'killed', 20, { stopped_by: 'claude' }),
  ] }) });
  await store.hydrateMirror();
  const m = store.mirror;
  assert.deepEqual([...m.tasks.keys()].sort(), ['broke', 'fresh', 'running'], 'pruned on the fold, failure kept');

  // The server's removal of an unseen failure does not lose it either.
  store.foldMirrorFrame({ type: 'mirror:update', rev: 11, now, conversation_id: 'c1', removed_tasks: ['broke', 'fresh'] });
  assert.deepEqual([...m.tasks.keys()].sort(), ['broke', 'running']);
  assert.deepEqual(store.tasksOf('c1').map((x) => x.id), ['running', 'broke']);

  const events = mirrorEvents(t);
  assert.equal(store.markSeen(['broke']), true);
  assert.deepEqual([...m.tasks.keys()], ['running'], 'seen, and long finished: it goes');
  assert.deepEqual(events.at(-1), ['tasks']);
});

// ── reads and wiring ─────────────────────────────────────────────────────────

test('awaiting holds the asks and each live wait, the wait\'s subject folded into its ask', async (t) => {
  const { store } = await makeStore(t, { '/api/mirror': snapshot({
    conversations: [
      conv('c1', { state: 'waiting', waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(npm test)', ask_id: 'ask_1' } }),
      conv('c2', { state: 'question', waiting: { kind: 'question', tool: 'AskUserQuestion', summary: 'Keep the rail?' } }),
    ],
    asks: [{ id: 'ask_1', conversation_id: 'c1', kind: 'permission', tool_name: 'Bash', state: 'pending', answerable: true, version: 1 }],
  }) });
  await store.hydrateMirror();
  const a = store.awaitingOf('c1');
  assert.equal(a.length, 1);
  assert.equal(a[0].id, 'ask_1');
  assert.equal(a[0].summary, 'Bash(npm test)');
  assert.equal(a[0].answerable, true);
  const q = store.awaitingOf('c2');
  assert.deepEqual({ ...q[0] }, { id: 'live:c2', conversation_id: 'c2', kind: 'question', state: 'pending', answerable: false,
    source: 'live', tool_name: 'AskUserQuestion', summary: 'Keep the rail?' });

  store.foldMirrorFrame({ type: 'mirror:ask', op: 'update', ask: { id: 'ask_1', conversation_id: 'c1', kind: 'permission',
    state: 'decided', version: 0 } });
  assert.equal(store.awaitingOf('c1')[0].state, 'pending', 'an older version of an ask is ignored');
  store.foldMirrorFrame({ type: 'mirror:ask', op: 'close', ask: { id: 'ask_1', conversation_id: 'c1', kind: 'permission' } });
  const left = store.awaitingOf('c1');
  assert.equal(left.length, 1, 'closed, the live wait still shows (the read-only card) until the state moves');
  assert.equal(left[0].source, 'live');
  assert.equal(left[0].summary, 'Bash(npm test)');
  assert.equal(store.statusOf('c2').state, 'question');
  assert.equal(store.statusOf().id, store.followed());
});

test('initChatState registers mirror: frames and a hello hook, follows the socket, and swaps only the fetch the second time', async (t) => {
  const store = await import(`${appUrl('chat-state.js')}?case=${++loads}`);
  const frames = [];
  const hellos = [];
  const fetch = fakeFetch({ '/api/mirror': snapshot() });
  const handle = store.initChatState({
    onFrame: (type, fn) => { frames.push([type, fn]); return () => frames.splice(0); },
    onHello: (fn) => { hellos.push(fn); return () => hellos.splice(0); },
    fetch,
    conn: 'reconnecting',
  });
  t.after(() => handle.stop());
  assert.equal(frames.length, 1);
  assert.equal(frames[0][0], 'mirror:');
  assert.equal(frames[0][1], store.foldMirrorFrame);
  assert.equal(hellos.length, 1);
  assert.equal(store.mirror.conn, 'reconnecting');
  assert.equal(store.initChatState({ fetch }), handle, 'once per page');
  assert.equal(frames.length, 1);

  const events = mirrorEvents(t);
  const read = nextHydrate();
  hellos[0]({ type: 'hello' });
  assert.equal(store.mirror.conn, 'live', 'a hello arrives only on an open socket');
  await read;
  assert.deepEqual(fetch.calls, ['/api/mirror']);
  assert.equal(store.mirror.availability, 'ok');

  bus.emit('conn', { state: 'reconnecting' });
  assert.equal(store.mirror.conn, 'reconnecting');
  assert.ok(events.some((w) => w.length === 1 && w[0] === 'conn'));
  const since = store.mirror.connSince;
  bus.emit('conn', { state: 'reconnecting' });
  assert.equal(store.mirror.connSince, since, 'only a change moves connSince');
  bus.emit('conn', { state: 'bogus' });
  assert.equal(store.mirror.conn, 'reconnecting');

  handle.stop();
  assert.equal(frames.length, 0, 'stop() unregisters');
  bus.emit('conn', { state: 'live' });
  assert.equal(store.mirror.conn, 'reconnecting', 'and stops listening');
});
