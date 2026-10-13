// The asks routes (spec §4.3, §5.7), on ctx.asks (lib/server/domain/asks.js),
// ctx.audience and ctx.answerSurface (optional).
//
// CHROME-FACING, P0 read-open:
//   GET  /api/asks                     {asks: [AskPublic], answer: {port}|null}
//     Readable by any same-origin script, so it carries no subject, input,
//     questions or plan; below `read` each ask passes projectValue with
//     ASK_SCHEMA (the domain's list({level})). `answer` is null for any request
//     that is not local: a remote page cannot use a loopback port (tranche 7's
//     remote origin rides the portal's header). `?ensure=1` from a local
//     request starts the answer surface first (at most 2 s, errors swallowed),
//     so the chrome can mount a control frame before any ask exists — never
//     once the asks are stopped (teardown), when it answers without listening.
//
// HOOK-FACING, P1 host only (ctx.audience.isHost — a browser, a remote viewer
// and a network peer are each refused 403, §5.4; the portal also refuses
// `* /api/asks/*`), and a decision reaches the hook only by its per-ask secret:
//   POST /api/asks                     the create body (≤ 300 KB) → the create answer:
//                                      a PermissionRequest (the ask hook) or an
//                                      Elicitation (the elicit hook, tranche 6)
//   GET  /api/asks/:id/decision?wait=  X-WC-Ask-Secret → {state:'pending'} |
//                                      {state:'decided', decision} | {state:'resolved', by}
//   POST /api/asks/:id/withdraw        {reason: 'sigterm'|'deadline'|'resolved-elsewhere'}
//   POST /api/asks/:id/handed          the hook has printed the decision
//
// A 400 names the field, never echoes a value. Without an audience on ctx the
// hook-facing routes refuse everyone: they fail closed, never open.

const express = require('express');
const { checkEnvelope } = require('./hooks');
const { checkCreate, POLL_WAIT_MAX } = require('../domain/asks');
const { HOST_ONLY } = require('../audience');

const MAX_BODY_BYTES = 300 * 1024;
const SMALL_BODY_BYTES = 4 * 1024;
const ENSURE_WAIT_MS = 2000;
const SECRET_HEADER = 'x-wc-ask-secret';
const CREATE_EVENTS = new Set(['PermissionRequest', 'Elicitation']);

const parseCreate = express.json({ limit: MAX_BODY_BYTES });
const parseSmall = express.json({ limit: SMALL_BODY_BYTES });

function bytesOf(v) {
  try { return Buffer.byteLength(JSON.stringify(v), 'utf8'); } catch { return Infinity; }
}

function declaredLength(req) {
  const raw = req.headers['content-length'];
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return null;
  return Number(raw);
}

// Only a plain `true` from the audience lets a request through; a missing
// audience, or one that throws, refuses.
function isHost(ctx, req) {
  const a = ctx.audience;
  if (!a || typeof a.isHost !== 'function') return false;
  try { return a.isHost(req) === true; } catch { return false; }
}

function levelOf(ctx, req) {
  const a = ctx.audience;
  if (!a || typeof a.levelOf !== 'function') return 'basic';
  try { return a.levelOf(req); } catch { return 'basic'; }
}

function surfaceOf(ctx) {
  const s = ctx.answerSurface;
  try { return typeof s === 'function' ? s() : s; } catch { return null; }
}

function portOf(ctx) {
  const s = surfaceOf(ctx);
  const p = s ? s.port : null;
  return Number.isSafeInteger(p) && p > 0 ? { port: p } : null;
}

// True once the asks domain has been stopped (teardown); a domain that cannot
// say, by throwing, is taken as stopped.
function asksStopped(ctx) {
  const a = ctx.asks;
  if (!a || typeof a.stopped !== 'function') return false;
  try { return a.stopped() !== false; } catch { return true; }
}

// Starts the answer surface, waiting at most ENSURE_WAIT_MS; never throws.
// Refused once the asks are stopped: teardown stops them before it closes the
// surface, and close() is re-openable (the idle close needs that), so a
// straggler's ensure=1 landing after that would open a fresh listener and its
// idle timer the teardown has already passed (U53c). The request is still
// answered, without listening.
async function ensureSurface(ctx) {
  if (asksStopped(ctx)) return;
  const s = surfaceOf(ctx);
  if (!s || typeof s.ensure !== 'function') return;
  let timer = null;
  const cap = new Promise((resolve) => {
    timer = setTimeout(resolve, ENSURE_WAIT_MS);
    if (timer.unref) timer.unref();
  });
  try {
    await Promise.race([Promise.resolve().then(() => (asksStopped(ctx) ? null : s.ensure())).catch(() => {}), cap]);
  } catch {} finally {
    clearTimeout(timer);
  }
}

// A domain answer as an HTTP response: `status` is the domain's, and never
// leaves in the body.
function send(res, answer) {
  if (!answer || typeof answer !== 'object') return res.status(500).json({ ok: false, error: 'no answer' });
  const { status, ...body } = answer;
  return res.status(Number.isInteger(status) ? status : 200).json(body);
}

function mountAskRoutes(app, ctx) {
  const hostOnly = (req, res, next) => (isHost(ctx, req) ? next() : res.status(403).json({ ok: false, hint: HOST_ONLY }));
  const noDomain = (res) => res.status(503).json({ ok: false, error: 'no asks domain' });
  const tooLarge = (res, max) => res.status(413).json({ ok: false, error: `body over ${max} bytes` });
  const malformed = (res, error) => res.status(400).json({ ok: false, error });

  // The mirror's own gate (requireMirror('basic')): every level may list the
  // asks, and the domain projects them for the level. Without an audience the
  // request is judged basic.
  const mirrorGate = (req, res, next) => {
    const a = ctx.audience;
    if (!a || typeof a.requireMirror !== 'function') return next();
    return a.requireMirror('basic')(req, res, next);
  };

  app.get('/api/asks', mirrorGate, async (req, res) => {
    const asks = ctx.asks;
    if (!asks) return noDomain(res);
    const level = levelOf(ctx, req);
    const local = level === 'local';
    if (local && req.query && req.query.ensure === '1') await ensureSurface(ctx);
    res.json({ asks: asks.list({ level }), answer: local ? portOf(ctx) : null });
  });

  // A body parser that enforces `max` by the declared Content-Length, else by
  // the parsed body's size (the daemon's global parser has already run).
  const body = (max, parser) => (req, res, next) => {
    const declared = declaredLength(req);
    if (declared !== null && declared > max) return tooLarge(res, max);
    if (!req.is('application/json')) return malformed(res, 'not JSON');
    parser(req, res, (err) => {
      if (err) return err.status === 413 || err.type === 'entity.too.large' ? tooLarge(res, max) : malformed(res, 'not JSON');
      if (declared === null && bytesOf(req.body) > max) return tooLarge(res, max);
      next();
    });
  };

  app.post('/api/asks', hostOnly, body(MAX_BODY_BYTES, parseCreate), async (req, res) => {
    const asks = ctx.asks;
    if (!asks) return noDomain(res);
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b) || b.v !== 1) return malformed(res, 'bad v');
    // The envelope's shape is the intake's one validator; the event is this
    // route's own check, never INTAKE_EVENTS (which takes neither): the ask
    // hook's PermissionRequest or the elicit hook's Elicitation.
    const problem = checkEnvelope(b.envelope);
    if (problem) return malformed(res, `bad envelope: ${problem}`);
    if (!CREATE_EVENTS.has(b.envelope.event)) return malformed(res, 'bad envelope.event');
    const invalid = checkCreate(b);
    if (invalid) return malformed(res, `bad ${invalid}`);
    let answer;
    try { answer = await asks.create(b); } catch { return res.status(500).json({ ok: false, error: 'create failed' }); }
    if (answer && answer.invalid) return malformed(res, `bad ${answer.invalid}`);
    return send(res, answer);
  });

  app.get('/api/asks/:id/decision', hostOnly, async (req, res) => {
    const asks = ctx.asks;
    if (!asks) return noDomain(res);
    const raw = req.query ? req.query.wait : undefined;
    const wait = typeof raw === 'string' && /^[0-9]{1,6}$/.test(raw) ? Math.min(POLL_WAIT_MAX, Number(raw)) : 0;
    const answer = await asks.poll(req.params.id, req.get(SECRET_HEADER), { wait });
    return send(res, answer);
  });

  app.post('/api/asks/:id/withdraw', hostOnly, body(SMALL_BODY_BYTES, parseSmall), (req, res) => {
    const asks = ctx.asks;
    if (!asks) return noDomain(res);
    const reason = req.body && typeof req.body === 'object' ? req.body.reason : undefined;
    const answer = asks.withdraw(req.params.id, req.get(SECRET_HEADER), reason);
    if (answer && answer.invalid) return malformed(res, `bad ${answer.invalid}`);
    return send(res, answer);
  });

  app.post('/api/asks/:id/handed', hostOnly, (req, res) => {
    const asks = ctx.asks;
    if (!asks) return noDomain(res);
    return send(res, asks.handed(req.params.id, req.get(SECRET_HEADER)));
  });
}

module.exports = { mountAskRoutes, MAX_BODY_BYTES, SECRET_HEADER, ENSURE_WAIT_MS };
