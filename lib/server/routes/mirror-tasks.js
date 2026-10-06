// The chat mirror's background work over HTTP (spec §2.10, "Work and code"):
// the task rows, one shell's or monitor's output paged, one agent's own stream,
// and one workflow's phases and agents. The chrome reads these from the chips'
// trays and the detail views (U46, U47).
//
//   GET /api/mirror/tasks
//     {tasks: [TaskRow], counts, rev}: the facade's own read (ctx.mirror.tasks(),
//     sync, over the model), its `rev` kept.
//   GET /api/mirror/tasks/:taskId/output[?from=&max=&tail=]
//     {task_id, text, from, to, size, eof, ended, footer, exit_code?, rev},
//     redacted and bounded by the tasks source. `from` an integer ≥ 0 (default
//     0), `max` an integer 1..262144 (default 262144), `tail` an integer
//     1..262144 (the last `tail` bytes; absent, none). `tail` with `from` is
//     400: one window or the other. Pass `to` back as `from` for the next page:
//     the source answers `to` at a line boundary (U21's hand-off), and the route
//     passes the numbers through.
//   GET /api/mirror/agents/:agentId[?before=&after=&limit=]
//     {agent: TaskRow, items, next_before, rev}. `before` and `after` each a
//     finite number ≥ 0 (an item seq, which can be fractional, §2.9), not both;
//     `limit` an integer 1..100 (default 50).
//   GET /api/mirror/workflows/:runId
//     {workflow: TaskRow, phases: [{title, state}], agents: [...], rev}; the id
//     is a runId or the row's id (the source resolves either).
//
// The bounds and defaults the spec leaves open are the critic's (U45@param-
// bounds (a), taken provisionally on 2026-10-06): out of range is 400, never
// clamped, as U29's are.
//
// Every route sits behind the audience's gate at `read` (ctx.audience
// requireMirror('read'), §5.4): a remote viewer whose project has not opted in,
// and every network peer, gets its 403 and hint. The portal's table refuses
// them first (lib/core/remote-policy, `GET /api/mirror/*` at `read`, no row of
// this module's own); this is the daemon's second lock. P0 read-open (§5.7):
// GETs only.
//
// THIN, as routes/mirror.js and routes/mirror-content.js are. Each route
// validates its parameters and calls the facade (ctx.mirror: tasks, taskOutput,
// agent, workflow; §2.12). Every file read, fence and redaction is the sources'
// and the facade's (§2.9's read boundary): this module requires only ./mirror
// and ./mirror-query — never fs, lib/core/claude-files or a path helper — and
// opens, fences and redacts nothing. A body is the facade's answer cut to §2.10's keys
// (a key a source adds beside them is dropped, so no task-output, transcript or
// tool-results path a source might put there leaves here), plus `rev`.
//
// `rev`: /tasks keeps the facade's own (its read carries it); every other body
// takes ctx.mirror.status().rev read BEFORE the dispatched call, so a frame
// emitted while the read ran carries a newer rev and the chrome, which
// re-applies any frame newer than the body it holds, misses nothing.
//
// The answers every mirror route shares come from routes/mirror.js (mirrorFor,
// isUnavailable, sendUnavailable, sendFailure): the wait on `mirror.ready` (at
// most READY_WAIT_MS), the disabled 200 with its hint, the 503 for a source not
// registered yet, and the 500 that never carries the error's message; the
// query parsers and the JSON route from routes/mirror-query.js. Besides those:
//   400 {ok:false, error}             a malformed, out-of-range, empty or
//                                     repeated parameter, or two that exclude
//                                     each other
//   404 {ok:false, error:'not found'} an id over ID_MAX characters, or a source
//                                     that answered null
//
// Mounted by lib/server/index.js (tranche 3's integration, U51); a route test
// mounts it on a bare Express app with a fake ctx.mirror and ctx.audience
// (test/mirror-routes-work.test.js).

const { READY_WAIT_MS } = require('./mirror');
// The query parsers and the JSON route every mirror route group shares (one
// home, routes/mirror-query.js); ID_MAX, the longest path id, is its.
const { ID_MAX, param, intIn, finiteAtLeastZero, notBoth, jsonRoute } = require('./mirror-query');

// GET …/output: the longest window, and the longest tail.
const OUTPUT_MAX = 262144;
// GET /api/mirror/agents/:agentId: the page size.
const AGENT_LIMIT_DEFAULT = 50;
const AGENT_LIMIT_MAX = 100;

// The keys of each body (§2.10), `rev` stamped by the route.
const TASKS_KEYS = Object.freeze(['tasks', 'counts']);
const OUTPUT_KEYS = Object.freeze(['task_id', 'text', 'from', 'to', 'size', 'eof', 'ended', 'footer', 'exit_code']);
const AGENT_KEYS = Object.freeze(['agent', 'items', 'next_before']);
const WORKFLOW_KEYS = Object.freeze(['workflow', 'phases', 'agents']);

const FROM = intIn(0, Number.MAX_SAFE_INTEGER);
const MAX = intIn(1, OUTPUT_MAX);
const TAIL = intIn(1, OUTPUT_MAX);
const SEQ = finiteAtLeastZero();
const LIMIT = intIn(1, AGENT_LIMIT_MAX);

function mountMirrorTasksRoutes(app, ctx, { readyWaitMs = READY_WAIT_MS } = {}) {
  const audience = ctx && ctx.audience;
  if (!audience || typeof audience.requireMirror !== 'function') {
    // Fail at boot rather than serve the background work with no gate in front of it.
    throw new TypeError('mountMirrorTasksRoutes needs ctx.audience (lib/server/audience): requireMirror');
  }
  const gate = audience.requireMirror('read');
  const host = { app, gate, ctx, readyWaitMs };

  jsonRoute(host, '/api/mirror/tasks', {
    // The facade's own read, sync; awaited all the same (U12b's hand-off 9).
    call: (mirror) => mirror.tasks(),
    keys: TASKS_KEYS,
    ownRev: true,
  });

  jsonRoute(host, '/api/mirror/tasks/:taskId/output', {
    ids: ['taskId'],
    query: (q) => {
      notBoth(q, 'tail', 'from', 'one window or the other');
      return {
        from: param(q, 'from', FROM, 0),
        max: param(q, 'max', MAX, OUTPUT_MAX),
        tail: param(q, 'tail', TAIL, null),
      };
    },
    call: (mirror, p, args) => mirror.taskOutput(p.taskId, args),
    keys: OUTPUT_KEYS,
  });

  jsonRoute(host, '/api/mirror/agents/:agentId', {
    ids: ['agentId'],
    query: (q) => {
      notBoth(q, 'after', 'before', 'one direction or the other');
      return {
        before: param(q, 'before', SEQ, null),
        after: param(q, 'after', SEQ, null),
        limit: param(q, 'limit', LIMIT, AGENT_LIMIT_DEFAULT),
      };
    },
    call: (mirror, p, args) => mirror.agent(p.agentId, args),
    keys: AGENT_KEYS,
  });

  jsonRoute(host, '/api/mirror/workflows/:runId', {
    ids: ['runId'],
    call: (mirror, p) => mirror.workflow(p.runId),
    keys: WORKFLOW_KEYS,
  });
}

module.exports = {
  mountMirrorTasksRoutes,
  ID_MAX,
  OUTPUT_MAX,
  AGENT_LIMIT_DEFAULT,
  AGENT_LIMIT_MAX,
  TASKS_KEYS,
  OUTPUT_KEYS,
  AGENT_KEYS,
  WORKFLOW_KEYS,
};
