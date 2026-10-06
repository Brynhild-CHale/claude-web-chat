// The chat mirror's code changes and graph link over HTTP (spec §2.10, "Work
// and code"; §2.7 the diff record; §2.8 the graph link; §15.4 the rewind marks):
// a turn's or a node's diff, a node's turns, and every node's turn counts. The
// chrome reads these from the diff view (U47), the graph inspector and its
// rewind marks (U80).
//
//   GET /api/mirror/diff?turn=<id>
//     the turn's diff record (§2.7: {v, turn_id, conversation_id, status,
//     reason?, before, after, files, totals, patch, patch_truncated, flags,
//     outside, attr_exact, created_at}) + rev.
//   GET /api/mirror/diff?node=<ref>[&context=<0..20>]
//     {node: {id, label}, turns: [record without patch], combined: record|null,
//     rev}. `context` an integer 0..20 (default 3, the -U3 the record's patch
//     uses).
//     Exactly one of `turn` and `node`: neither, both, or `context` beside
//     `turn` is 400. A `turn` or `node` value is passed through as given, and
//     one over ID_MAX characters is 404, as a path id is.
//   GET /api/mirror/node/:ref
//     {node: {id, label}, turns: [Turn header + role], rev}; `live` lists the
//     pending turns.
//   GET /api/mirror/nodes
//     {nodes: {[node_id]: {turns, superseded, rewound_at?}}, rev}.
//
// A node ref (`n1.7`, a stored id, `active`, `live`) is never resolved here:
// the route hands the raw ref to the facade, whose source resolves it through
// lib/server/domain/refs (the codediff source for diff, the graph-link source
// for nodeTurns) and answers null for an unknown one → 404 (notes-B Q7).
//
// Every route sits behind the audience's gate at `read` (ctx.audience
// requireMirror('read'), §5.4): a remote viewer whose project has not opted in,
// and every network peer, gets its 403 and hint. The portal's table refuses
// them first (lib/core/remote-policy, `GET /api/mirror/*` at `read`, no row of
// this module's own); this is the daemon's second lock. P0 read-open (§5.7):
// GETs only.
//
// THIN, as routes/mirror.js and routes/mirror-content.js are. Each route
// validates its parameters and calls the facade (ctx.mirror: diff, nodeTurns,
// nodeSummaries; §2.12 — diff a Promise, the other two sync and awaited all the
// same, U12b's hand-off 9). Every file read, fence and redaction is the
// sources' and the facade's (§2.9's read boundary): this module requires only
// ./mirror — never fs, lib/core/claude-files or lib/server/domain/refs — and
// opens, fences, resolves and redacts nothing. A body is the facade's answer
// cut to §2.10's keys (a key a source adds beside them is dropped, so no path
// leaves here), plus `rev`: ctx.mirror.status().rev read BEFORE the dispatched
// call, so the chrome, which re-applies any frame newer than the body it holds,
// misses nothing that changed while the read ran.
//
// The answers every mirror route shares come from routes/mirror.js (mirrorFor,
// isUnavailable, sendUnavailable, sendFailure): the wait on `mirror.ready` (at
// most READY_WAIT_MS), the disabled 200 with its hint, the 503 for a source not
// registered yet, and the 500 that never carries the error's message. Besides
// those:
//   400 {ok:false, error}             a malformed, out-of-range, empty or
//                                     repeated parameter, or a wrong pairing
//   404 {ok:false, error:'not found'} an id or ref over ID_MAX characters, or a
//                                     source that answered null (an unknown
//                                     turn or ref)
//
// Mounted by lib/server/index.js (tranche 3's integration, U51); a route test
// mounts it on a bare Express app with a fake ctx.mirror and ctx.audience
// (test/mirror-routes-work.test.js).

const { mirrorFor, isUnavailable, sendUnavailable, sendFailure, READY_WAIT_MS } = require('./mirror');

// A path id, ref or `turn`/`node` value longer than this names nothing.
const ID_MAX = 128;
// GET /api/mirror/diff?node=: the combined patch's context lines.
const CONTEXT_DEFAULT = 3;
const CONTEXT_MAX = 20;

// The keys of each body (§2.10, §2.7), `rev` stamped by the route.
const DIFF_KEYS = Object.freeze(['v', 'turn_id', 'conversation_id', 'status', 'reason', 'before', 'after', 'files',
  'totals', 'patch', 'patch_truncated', 'flags', 'outside', 'attr_exact', 'created_at']);
const NODE_DIFF_KEYS = Object.freeze(['node', 'turns', 'combined']);
const NODE_KEYS = Object.freeze(['node', 'turns']);
const NODES_KEYS = Object.freeze(['nodes']);

// Digits only (routes/mirror-content.js's rule).
const INT_RE = /^\d{1,16}$/;

const NOT_FOUND = Object.freeze({ ok: false, error: 'not found' });

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// A parameter that failed validation (400), or one too long to name anything (404).
class BadParam extends Error {}
class NotFound extends Error {}

// One query parameter, read as given: absent → `dflt`; present, it must be a
// single string `parse` accepts (an empty one, a repeat, a bracketed list or
// object never is).
function param(query, name, parse, dflt) {
  const raw = query[name];
  if (raw === undefined) return dflt;
  const v = typeof raw === 'string' ? parse(raw) : undefined;
  if (v === undefined) throw new BadParam(`${name}: ${parse.expects}`);
  return v;
}

function intIn(min, max) {
  const parse = (raw) => {
    if (!INT_RE.test(raw)) return undefined;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
  };
  parse.expects = `an integer from ${min} to ${max}`;
  return parse;
}

// An id or ref in the query: a non-empty single string, passed through as
// given; one over ID_MAX characters is 404, as a path id is.
function idParam(query, name) {
  const raw = query[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw === '') throw new BadParam(`${name}: an id`);
  if (raw.length > ID_MAX) throw new NotFound(name);
  return raw;
}

const CONTEXT = intIn(0, CONTEXT_MAX);

// A path id is passed through as given; one too long to be an id is 404.
function idOk(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= ID_MAX;
}

// The facade's answer cut to `keys`.
function pick(v, keys) {
  const out = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = v[k];
  return out;
}

// GET /api/mirror/diff's query: exactly one of turn and node, `context` only
// beside `node`.
function diffQuery(q) {
  const turn = idParam(q, 'turn');
  const node = idParam(q, 'node');
  if ((turn === undefined) === (node === undefined)) throw new BadParam('turn: exactly one of turn and node');
  if (turn !== undefined) {
    if (q.context !== undefined) throw new BadParam('context: only with node');
    return { q: { turn }, keys: DIFF_KEYS };
  }
  return { q: { node, context: param(q, 'context', CONTEXT, CONTEXT_DEFAULT) }, keys: NODE_DIFF_KEYS };
}

function mountMirrorCodeRoutes(app, ctx, { readyWaitMs = READY_WAIT_MS } = {}) {
  const audience = ctx && ctx.audience;
  if (!audience || typeof audience.requireMirror !== 'function') {
    // Fail at boot rather than serve the code changes with no gate in front of them.
    throw new TypeError('mountMirrorCodeRoutes needs ctx.audience (lib/server/audience): requireMirror');
  }
  const gate = audience.requireMirror('read');
  const opts = { readyWaitMs };

  // A JSON route: validate (400 / 404 before anything waits), wait for the
  // mirror, read the status's rev, then the dispatched call; null is 404,
  // `unavailable` 503, any other non-object a failure. `query` answers the
  // call's arguments and may name the keys the body is cut to.
  function jsonRoute(route, { ids = [], query = () => ({}), call, keys }) {
    app.get(route, gate, async (req, res) => {
      let args;
      try {
        if (!ids.every((name) => idOk(req.params[name]))) return res.status(404).json(NOT_FOUND);
        args = query(req.query || {});
      } catch (e) {
        if (e instanceof BadParam) return res.status(400).json({ ok: false, error: e.message });
        if (e instanceof NotFound) return res.status(404).json(NOT_FOUND);
        return sendFailure(res, e, `GET ${route}`);
      }
      try {
        const mirror = await mirrorFor(ctx, res, opts);
        if (!mirror) return undefined;
        const status = await mirror.status();
        if (isUnavailable(status)) return sendUnavailable(res);
        if (!isPlain(status)) throw new TypeError('the mirror\'s status is not an object');
        const rev = Number.isFinite(status.rev) ? status.rev : null;
        const body = await call(mirror, req.params, args);
        if (body === null || body === undefined) return res.status(404).json(NOT_FOUND);
        if (isUnavailable(body)) return sendUnavailable(res);
        if (!isPlain(body)) throw new TypeError('the mirror\'s answer is not an object');
        return res.json({ ...pick(body, args.keys || keys), rev });
      } catch (e) {
        return sendFailure(res, e, `GET ${route}`);
      }
    });
  }

  jsonRoute('/api/mirror/diff', {
    query: diffQuery,
    call: (mirror, p, args) => mirror.diff(args.q),
  });

  jsonRoute('/api/mirror/node/:ref', {
    ids: ['ref'],
    // The ref as given: the graph-link source resolves it (and `live`).
    call: (mirror, p) => mirror.nodeTurns(p.ref),
    keys: NODE_KEYS,
  });

  jsonRoute('/api/mirror/nodes', {
    call: (mirror) => mirror.nodeSummaries(),
    keys: NODES_KEYS,
  });
}

module.exports = {
  mountMirrorCodeRoutes,
  ID_MAX,
  CONTEXT_DEFAULT,
  CONTEXT_MAX,
  DIFF_KEYS,
  NODE_DIFF_KEYS,
  NODE_KEYS,
  NODES_KEYS,
};
