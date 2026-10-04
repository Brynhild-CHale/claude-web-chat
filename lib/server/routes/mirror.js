// The chat mirror's state over HTTP (spec §2.10, "State"): the snapshot the
// chrome reads after every `hello` and `mirror:reset`, and the heartbeat's
// status rows.
//
//   GET /api/mirror[?since=<ms>]
//     at `read` and above (a local viewer, or a remote one whose project opted
//     in): the facade's snapshot, {v, enabled, now, rev, content: true, access,
//     capabilities, primary, aggregate, conversations: [Conversation],
//     tasks: [TaskRow], counts, asks: [AskPublic], diagnostics}. `since` bounds
//     which conversations it lists; absent or malformed, it is the facade's
//     clock less 24 hours.
//     below `read` (a remote viewer whose project has not opted in, and any
//     peer on a network bind, Q9): {v, enabled, now, rev, content: false,
//     access, primary, aggregate, conversations: [StatusRow], asks: [AskPublic]},
//     where the rows, the aggregate, the asks and the primary are typed values
//     only (below).
//   GET /api/mirror/status
//     {v, now, rev, aggregate, conversations: [StatusRow]}: the facade's status
//     as it is for a local viewer, and through the basic projection at every
//     level below `local`.
//
// THIN. Both routes are the facade's (ctx.mirror, lib/server/mirror: snapshot
// and status, its own reads over the model) behind the audience's gate
// (ctx.audience, lib/server/audience: requireMirror('basic'), levelOf). What
// the facade returns is already redacted and holds no path the engine read
// (§2.9's read boundary), so a route never redacts, fences or opens a file:
// this module requires neither fs nor lib/core/claude-files, and adds nothing
// to a body but its envelope — the version, the flags and the request's own
// `access`.
//
// ONE BASIC PROJECTION. Below `read` a body is built only from values that
// passed lib/core/remote-policy `projectValue` with the schemas FRAME_RULES
// gives `mirror:status` (STATUS_SCHEMA, whose rows are STATUS_ROW_SCHEMA) and
// `mirror:ask` (ASK_SCHEMA), exported by name: so a field added to the status
// or to an ask cannot reach a basic viewer over HTTP and not over the socket,
// or the reverse. The types are narrow (a word, an id, a number, a boolean,
// counts), so a field of the wrong shape — a command in `step_kind`, an MCP
// tool's full name, a path — is dropped, never sent; and no type passes a `/`,
// so no path reaches a basic viewer whatever the facade holds. The status rows
// come from status(), the same rows a `mirror:status` frame carries; the asks
// and the primary from the snapshot.
//
// The answers every mirror route group shares (§2.10), exported for the
// content, work and code routes (routes/mirror-content.js, mirror-tasks.js,
// mirror-code.js) so each says them the same way:
//   403 {ok:false, mirror, remote, hint}       the audience's requireMirror (§5.4)
//   200 {ok:false, disabled:true, scope, hint} web-chat is switched off; the hint
//                                              names the command that turns it on
//   503 {ok:false, unavailable:true}           no mirror is wired, or the facade
//                                              answered `unavailable` (a source
//                                              not registered yet, §2.12)
//   500 {ok:false, error}                      the facade threw. Never its message,
//                                              which can name the file the engine
//                                              was reading or quote what was in it
// and each waits on `mirror.ready` at most READY_WAIT_MS before it answers with
// whatever the facade holds: a catch-up that is still running ends in a
// `mirror:reset`, and the chrome reads the snapshot again then.
//
// Mounted by lib/server/index.js (tranche 1's integration); a route test mounts
// it on a bare Express app with a fake ctx.mirror and ctx.audience.

const { projectValue, atLeast, STATUS_SCHEMA, ASK_SCHEMA } = require('../../core/remote-policy');
const { isRemoteRequest } = require('../../core/cors');

// The version of the bodies these routes answer (`v`).
const BODY_VERSION = 1;
// How long a route waits for the facade's start (spec §2.12: "routes wait on it
// at most 2 s").
const READY_WAIT_MS = 2000;
// GET /api/mirror's default `since`: the conversations of the last day.
const SINCE_DEFAULT_MS = 24 * 60 * 60 * 1000;
// `since` is milliseconds since the epoch, digits only.
const SINCE_RE = /^\d{1,16}$/;

// The asks below `read`: a list, each projected by the schema the `mirror:ask`
// frame's basic row gives its `ask`.
const ASKS_SCHEMA = Object.freeze({ rows: ASK_SCHEMA });

const ON_HINT = 'web-chat is off for this project — on the host: claude-web-chat on';
const ON_GLOBAL_HINT = 'web-chat is off on this machine — on the host: claude-web-chat on --global';
const SCOPES = new Set(['user', 'project', 'session']);
// What the host's log may say about a failure: a class or a code, one word.
const LOG_WORD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// The facade's "this source is not registered yet" (spec §2.12).
function isUnavailable(v) {
  return isPlain(v) && v.unavailable === true;
}

function sendUnavailable(res) {
  return res.status(503).json({ ok: false, unavailable: true });
}

// The disabled answer. `scope` is the toggle scope that switched web-chat off
// (lib/toggle/policy); the hint names the command that turns it back on, and
// the user scope's flag is `--global` (lib/cli/commands/on.js).
function disabledBody(scope) {
  const s = SCOPES.has(scope) ? scope : null;
  return { ok: false, disabled: true, scope: s, hint: s === 'user' ? ON_GLOBAL_HINT : ON_HINT };
}

// A failed answer. A rejection with the facade's `unavailable` code is a 503
// like the `{unavailable: true}` answer; anything else is a 500 that says only
// that the mirror could not answer. Neither the response nor the host's log
// gets the error's message (the header says why): the log line names the
// route and the error's class or code.
function sendFailure(res, e, what) {
  if (res.headersSent) return undefined;
  if (e && e.code === 'unavailable') return sendUnavailable(res);
  const word = [e && e.code, e && e.name].find((w) => typeof w === 'string' && LOG_WORD_RE.test(w)) || 'Error';
  console.error(`[web-chat] ${what}: the chat mirror could not answer (${word})`);
  return res.status(500).json({ ok: false, error: 'the chat mirror could not answer' });
}

// Wait for `ready` to settle, or `ms`, whichever comes first. A start that
// failed is no reason to hold a request: the facade answers what it holds.
function waitReady(ready, ms) {
  if (!ready || typeof ready.then !== 'function') return Promise.resolve();
  let timer = null;
  const bound = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  const settled = Promise.resolve(ready).then(() => {}, () => {});
  return Promise.race([settled, bound]).finally(() => clearTimeout(timer));
}

// What every mirror route does before it reads: the mirror wired, waited on,
// and enabled. Resolves to the mirror, or to null once it has answered the
// request itself (503 unavailable, or the disabled answer).
async function mirrorFor(ctx, res, { readyWaitMs = READY_WAIT_MS } = {}) {
  const mirror = ctx && ctx.mirror;
  if (!mirror) {
    sendUnavailable(res);
    return null;
  }
  await waitReady(mirror.ready, readyWaitMs);
  // Awaited like every facade read, so a promise is never taken for "enabled".
  const on = await mirror.enabled();
  if (isPlain(on) && on.enabled === false) {
    res.json(disabledBody(on.scope));
    return null;
  }
  return mirror;
}

function sinceOf(raw, now) {
  if (typeof raw === 'string' && SINCE_RE.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return n;
  }
  return now - SINCE_DEFAULT_MS;
}

// A facade read that must be an object (its `unavailable` answer is one, and is
// checked first): anything else is a failure, answered 500, never sent as a body.
function objectOf(v, what) {
  if (!isPlain(v)) throw new TypeError(`the mirror's ${what} is not an object`);
  return v;
}

// GET /api/mirror below `read`.
function basicSnapshot(status, snap, access) {
  const st = projectValue(STATUS_SCHEMA, status);
  const primary = projectValue('id', snap.primary);
  const asks = projectValue(ASKS_SCHEMA, snap.asks);
  return {
    v: BODY_VERSION,
    enabled: true,
    now: st.now,
    rev: st.rev,
    content: false,
    access,
    primary: primary === undefined ? null : primary,
    aggregate: st.aggregate,
    conversations: st.conversations,
    asks: Array.isArray(asks) ? asks : [],
  };
}

// GET /api/mirror/status below `local`: the `mirror:status` frame's basic
// projection, with the body's version where the frame has its type.
function basicStatus(status) {
  return { v: BODY_VERSION, ...projectValue(STATUS_SCHEMA, status) };
}

function mountMirrorRoutes(app, ctx, { readyWaitMs = READY_WAIT_MS } = {}) {
  const audience = ctx && ctx.audience;
  if (!audience || typeof audience.requireMirror !== 'function' || typeof audience.levelOf !== 'function') {
    // Fail at boot rather than serve the mirror with no gate in front of it.
    throw new TypeError('mountMirrorRoutes needs ctx.audience (lib/server/audience): requireMirror and levelOf');
  }
  // Every level a viewer can have meets `basic`: the gate refuses no viewer
  // here, and the level it reads decides what the body may carry.
  const gate = audience.requireMirror('basic');
  const opts = { readyWaitMs };

  app.get('/api/mirror', gate, async (req, res) => {
    try {
      const mirror = await mirrorFor(ctx, res, opts);
      if (!mirror) return undefined;
      const level = audience.levelOf(req);
      const access = { level, remote: isRemoteRequest(req) };
      // The status first: below `read` it is the body's rows, and at every
      // level its `now` is the facade's clock, which `since` defaults from.
      const status = await mirror.status();
      if (isUnavailable(status)) return sendUnavailable(res);
      objectOf(status, 'status');
      const now = Number.isFinite(status.now) ? status.now : Date.now();
      const snap = await mirror.snapshot({ level, since: sinceOf(req.query.since, now) });
      if (isUnavailable(snap)) return sendUnavailable(res);
      objectOf(snap, 'snapshot');
      if (!atLeast(level, 'read')) return res.json(basicSnapshot(status, snap, access));
      // The facade's body, under the envelope this request decides.
      return res.json(Object.assign({ v: BODY_VERSION, enabled: true }, snap,
        { v: BODY_VERSION, enabled: true, content: true, access }));
    } catch (e) {
      return sendFailure(res, e, 'GET /api/mirror');
    }
  });

  app.get('/api/mirror/status', gate, async (req, res) => {
    try {
      const mirror = await mirrorFor(ctx, res, opts);
      if (!mirror) return undefined;
      const level = audience.levelOf(req);
      const status = await mirror.status();
      if (isUnavailable(status)) return sendUnavailable(res);
      objectOf(status, 'status');
      if (level !== 'local') return res.json(basicStatus(status));
      return res.json(Object.assign({ v: BODY_VERSION }, status, { v: BODY_VERSION }));
    } catch (e) {
      return sendFailure(res, e, 'GET /api/mirror/status');
    }
  });
}

module.exports = {
  mountMirrorRoutes,
  // The answers the other mirror route groups share.
  mirrorFor,
  isUnavailable,
  sendUnavailable,
  sendFailure,
  disabledBody,
  BODY_VERSION,
  READY_WAIT_MS,
  SINCE_DEFAULT_MS,
};
