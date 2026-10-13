// The Final's chips and trays (Claude Design, ChatFinalDesktop) as the daemon's
// WIRE BODIES, for every test that draws the chat chrome from them: two shells,
// a running agent and a finished one, a workflow at step 3 of 5, two monitors —
// both live, which the Final counted as one (deviation 19: `2 monitors`,
// `6 running`) — and two queued messages. One working conversation, c1.
//
//   finalFixture({now, level}) → {mirrorBody, queueBody, now}
//     mirrorBody: GET /api/mirror — at `local` (the default) the whole body,
//       capabilities task_stop, queue_message and interrupt; at `basic` the
//       content-free one (status rows with counts, no tasks).
//     queueBody: GET /api/queue.
//   storeOf(body, S, opts) → the store chat-state.js would hold after that
//     body, built through chat-state's own normalizers (S is the imported
//     chat-state module), for plain-node tests of chat-present / sheet-model.
//   queueOf(queueBody, {parked}) → queue.js's queueSnapshot() shape.
//
// A jsdom test serves the bodies through bootShell's routes
// ({'/api/mirror': () => mirrorBody, '/api/queue': () => queueBody}); a plain
// test builds the store with storeOf. test/chat-present.test.js keeps its own
// copy (restated here as wire bodies; its numbers are the same).
'use strict';

const NOW = 1_790_000_000_000;
const sec = (n) => n * 1000;
const min = (n) => n * 60000;

function tasksAt(now) {
  return [
    { id: 'b1', conversation_id: 'c1', kind: 'shell', title: 'npm run dev', status: 'running', started_at: now - min(14),
      meta: { port: 5173 }, line: '✓ ready in 412ms — hmr update /src/rail/QueueRail.tsx', can: { output: true, stop: true } },
    { id: 'b2', conversation_id: 'c1', kind: 'shell', title: 'npm test -- --watch', status: 'running', started_at: now - min(3),
      line: 'Tests 42 passed (42) · watching for changes' },
    { id: 'a1', conversation_id: 'c1', kind: 'agent', title: 'Explore rail tests', status: 'running', started_at: now - sec(72),
      meta: { tools: 6 }, line: 'Read · tests/rail.spec.ts' },
    { id: 'a2', conversation_id: 'c1', kind: 'agent', title: 'Audit CSS tokens', status: 'done', started_at: now - min(9),
      ended_at: now - min(4), line: '“Found 3 hard-coded colors in app.css.”' },
    { id: 'w1', conversation_id: 'c1', kind: 'workflow', title: 'release-check', status: 'running', started_at: now - min(6),
      meta: { step: { index: 3, total: 5 } }, line: 'eslint src --max-warnings 0 · 118 files',
      steps: [{ label: 'build', state: 'done' }, { label: 'types', state: 'done' }, { label: 'lint', state: 'running' },
        { label: 'e2e', state: 'pending' }, { label: 'tag', state: 'pending' }] },
    { id: 'm1', conversation_id: 'c1', kind: 'monitor', title: 'PR #212 CI', status: 'running', started_at: now - min(30),
      meta: { events: 4, last_event_at: now - sec(10) }, line: 'waiting on e2e (chromium), e2e (webkit), deploy-preview' },
    { id: 'm2', conversation_id: 'c1', kind: 'monitor', title: 'Build errors', status: 'running', started_at: now - min(20),
      meta: { events: 2, last_event_at: now - min(6) }, line: 'tail -f .logs/build.log | grep -i error' },
  ];
}

// What runs, per category, as a conversation's (and a status row's) counts.
const COUNTS = Object.freeze({ shells: 2, agents: 1, workflows: 1, monitors: 2 });

function message(id, text, device, at) {
  return { id, kind: 'message', msg_id: `m-${id}`, conversation_id: null, text, skill: null, files: [], autosend: false,
    staged: true, chars: text.length, source: 'composer', why_wake: 'message from the user', origin: 'local', device,
    summary: `message · ${text.length} chars`, enqueued_at: at };
}

function finalFixture({ now = NOW, level = 'local' } = {}) {
  const live = { rev: 1, state: 'working', since: now - min(1),
    step: { kind: 'Edit', tool: 'Edit', label: 'Edit · QueueRail.tsx', started_at: now - sec(10) }, last_activity_at: now - sec(2) };
  const conversation = { id: 'c1', rev: 1, title: 'Queue rail redesign', headless: false, counts: { ...COUNTS }, live };
  let mirrorBody;
  if (level === 'local' || level === 'full' || level === 'read') {
    mirrorBody = {
      v: 1, enabled: true, now, rev: 1, content: true, access: { level, remote: false },
      capabilities: { task_stop: true, queue_message: true, interrupt: true },
      primary: 'c1', aggregate: { state: 'working' },
      conversations: [conversation], tasks: tasksAt(now), asks: [],
    };
  } else {
    // Below `read`: the status rows (content-free), no tasks, no capabilities.
    mirrorBody = {
      v: 1, enabled: true, now, rev: 1, content: false, access: { level, remote: level !== 'local' },
      primary: 'c1', aggregate: { state: 'working' },
      conversations: [{ id: 'c1', state: 'working', since: live.since, quiet: false, step_kind: 'Edit',
        last_activity_at: live.last_activity_at, counts: { ...COUNTS } }],
      asks: [],
    };
  }
  const queueBody = {
    items: [
      message('q1', 'Also update the README screenshot', 'mobile', now - min(2)),
      message('q2', 'Then run the e2e suite and push', 'desktop', now - min(1)),
    ],
    count: 2,
    receipts: [],
  };
  return { mirrorBody, queueBody, now };
}

// The store chat-state.js holds after a GET /api/mirror body (its applySnapshot,
// restated over the module's own normalizers): `conn` live unless told,
// following the server's primary unless told, the server's clock as now (skew 0
// when `now` is the body's).
function storeOf(body, S, { conn = 'live', connSince, followed, seen = [], now } = {}) {
  const snap = S.normalizeSnapshot(body);
  const at = Number.isFinite(now) ? now : snap && Number.isFinite(snap.now) ? snap.now : NOW;
  const base = {
    v: 1, conn, connSince: Number.isFinite(connSince) ? connSince : at - sec(12), skew: 0,
    availability: 'unknown', hint: null, access: { level: 'basic', remote: false },
    capabilities: S.normalizeCapabilities(null), aggregate: { state: 'unknown' },
    conversations: new Map(), status: new Map(), tasks: new Map(), awaiting: new Map(), seen: new Set(seen),
    followed: null, serverPrimary: null, rev: -1,
    stream: { conversationId: null, turns: [], hasOlder: false, loading: false },
  };
  if (!snap) return { ...base, availability: 'unavailable' };
  if (snap.disabled) return { ...base, availability: 'disabled', hint: snap.hint };
  const follow = followed === undefined ? snap.primary : followed;
  return {
    ...base,
    availability: 'ok',
    hint: snap.hint,
    access: { ...snap.access },
    capabilities: snap.capabilities,
    aggregate: { ...snap.aggregate },
    conversations: new Map(snap.conversations.map((c) => [c.id, c])),
    status: new Map(snap.status.map((r) => [r.id, r])),
    tasks: new Map(snap.tasks.map((t) => [t.id, t])),
    awaiting: new Map(snap.asks.map((a) => [a.id, a])),
    followed: follow,
    serverPrimary: snap.primary,
    rev: snap.rev,
    stream: { conversationId: follow, turns: [], hasOlder: false, loading: false },
  };
}

// queue.js's queueSnapshot() for a GET /api/queue body: every item with its
// `staged` (default true), the counts, and `parked` when a push has parked.
function queueOf(queueBody, { parked = null } = {}) {
  const items = (queueBody && Array.isArray(queueBody.items) ? queueBody.items : [])
    .map((it) => Object.freeze({ ...it, staged: it.staged !== false }));
  const staged = items.filter((it) => it.staged).length;
  return Object.freeze({
    items: Object.freeze(items),
    count: items.length,
    staged,
    held: items.length - staged,
    parked: parked ? Object.freeze({ id: parked.id || null, count: Number.isFinite(parked.count) ? parked.count : 1 }) : null,
    messages: Object.freeze([]),
  });
}

module.exports = { finalFixture, storeOf, queueOf, NOW, COUNTS };
