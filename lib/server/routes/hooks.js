// POST /api/hooks/event — the hook intake (spec §1.4): where the `mirror` hook
// posts envelope v1 (lib/hooks/envelope.js), and the way onto the hook tap
// (ctx.hooks, lib/server/hook-tap.js) for everything outside the daemon. The
// `ask` hook posts its envelope, nested, to POST /api/asks instead
// (lib/server/routes/asks.js), and the asks domain publishes it on the tap.
//
// HOST ONLY (pane-isolation class P1, §5.7). ctx.audience.isHost(req) is the
// one host-only test (§5.4): a loopback peer, not a remote viewer, that sent no
// Origin or Sec-Fetch-* header. Hooks post through lib/client over loopback and
// send neither; a pane's `fetch` always sends one. So a pane cannot forge a hook
// event (a fake SessionEnd would end Claude's turn), a remote viewer cannot,
// and — Q9, carve-strict — neither can a peer on a WEB_CHAT_HOST network bind,
// which could otherwise write into the mirror every local viewer reads. Without
// an audience on ctx the route refuses everyone: it fails closed, never open.
// Remotely the portal refuses the whole path before it gets here
// (`* /api/hooks/*`, HOST_ONLY, lib/core/remote-policy.js).
//
// In order: 403 for anyone but the host; 413 for a body over MAX_BODY_BYTES
// (64 KB; a hook bounds its envelope to 32 KB, so this is the transport's
// ceiling); 400 for a body that is not envelope v1: not JSON, not an object,
// another `v`, an event this intake does not take, a field v1 does not have,
// a field of the wrong type, an `ask` (only the asks domain associates one,
// in process), or `synthetic` (only the daemon's own envelopes are synthetic,
// and they never cross HTTP). Then `{ok: true}` at once, and the envelope is
// published on the tap AFTER the response (setImmediate), so no subscriber's
// work ever holds a hook.
//
// The daemon parses every JSON body before any route runs (express.json at
// 200 MB, lib/server/index.js), so the 64 KB cap is enforced here: by the
// declared Content-Length, else by the parsed body's size. A host without that
// global parser (a test's bare app) gets this route's own, at 64 KB.
//
// Two event lists. ENVELOPE_EVENTS is what checkEnvelope, the one envelope
// validator, takes: the mirror's events, PermissionRequest and Elicitation,
// whose envelopes POST /api/asks validates here too (and checks their event
// itself). Like PermissionRequest, Elicitation is never an intake event: the
// elicit hook posts it to the asks domain, which publishes it on the tap.
// INTAKE_EVENTS is what this route publishes: the events the `mirror`
// subcommand posts. PermissionRequest is not among them: the ask bridge posts
// it to the asks domain, which publishes it on the tap with its ask, and one
// posted here is refused (400) rather than published without one.
// UserPromptSubmit, Stop and StopFailure reach the tap only through the turn
// routes, beside the turn lock they move (§3.1), and an envelope of theirs
// posted here is refused rather than published behind the lock's back. lib/server
// may not import lib/hooks, so these lists are the intake's own;
// test/hook-intake.test.js holds them, and ENVELOPE_KEYS, to the template and
// to what hookEnvelope builds.
//
// Field caps are the hook's to apply (bounding happens in the hook, §1.3); this
// route checks the shape and the size of what arrives, not each field's cap.

const express = require('express');
const { classify } = require('../../core/remote-policy');

const INTAKE_PATH = '/api/hooks/event';
const MAX_BODY_BYTES = 64 * 1024;

const INTAKE_EVENTS = Object.freeze([
  'SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStop', 'PreCompact',
]);
const ENVELOPE_EVENTS = Object.freeze([...INTAKE_EVENTS, 'PermissionRequest', 'Elicitation']);

// Envelope v1's fields, every one of them.
const ENVELOPE_KEYS = Object.freeze([
  'v', 'event', 'ts', 'session_id', 'transcript_path', 'cwd', 'prompt_id', 'claude_pid',
  'entrypoint', 'permission_mode', 'agent', 'tool', 'result', 'session', 'compact', 'stop',
  'prompt', 'ask',
]);
const ENVELOPE_KEY_SET = new Set(ENVELOPE_KEYS);
const STRING_FIELDS = ['session_id', 'transcript_path', 'cwd', 'prompt_id', 'entrypoint', 'permission_mode'];
const SECTION_FIELDS = ['agent', 'tool', 'result', 'session', 'compact', 'stop', 'prompt'];

// The refusal's hint, read from the one route table rather than copied.
const HOST_HINT = classify('POST', INTAKE_PATH).hint;

const parseJson = express.json({ limit: MAX_BODY_BYTES });

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function absent(v) {
  return v === undefined || v === null;
}

function isScalar(v) {
  return typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
}

// Why `body` is not an envelope this intake takes, or null when it is. The
// reasons name fields, never echo values.
function checkEnvelope(body) {
  if (!isPlain(body)) return 'not an envelope';
  if (Object.hasOwn(body, 'synthetic')) return 'synthetic envelopes exist only inside the daemon';
  for (const k of Object.keys(body)) {
    if (!ENVELOPE_KEY_SET.has(k)) return /^[A-Za-z0-9_]{1,40}$/.test(k) ? `unknown field ${k}` : 'unknown field';
  }
  if (body.v !== 1) return 'unsupported envelope version';
  if (!ENVELOPE_EVENTS.includes(body.event)) return 'not an event this intake takes';
  if (!(typeof body.ts === 'number' && Number.isFinite(body.ts) && body.ts > 0)) return 'bad ts';
  for (const k of STRING_FIELDS) {
    if (!absent(body[k]) && typeof body[k] !== 'string') return `bad ${k}`;
  }
  if (!absent(body.claude_pid) && !(Number.isSafeInteger(body.claude_pid) && body.claude_pid >= 2)) return 'bad claude_pid';
  for (const k of SECTION_FIELDS) {
    if (!absent(body[k]) && !isPlain(body[k])) return `bad ${k}`;
  }
  if (body.tool && !absent(body.tool.input) && !isPlain(body.tool.input)) return 'bad tool.input';
  if (body.result && !absent(body.result.fields)) {
    const f = body.result.fields;
    if (!isPlain(f) || !Object.values(f).every(isScalar)) return 'bad result.fields';
  }
  if (body.stop && !absent(body.stop.background_tasks)) {
    const list = body.stop.background_tasks;
    if (!Array.isArray(list) || !list.every(isPlain)) return 'bad stop.background_tasks';
  }
  if (!absent(body.ask)) return 'ask is set by the asks domain, in process';
  return null;
}

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

function mountHookRoutes(app, ctx) {
  const tooLarge = (res) => res.status(413).json({ ok: false, error: `body over ${MAX_BODY_BYTES} bytes` });
  const malformed = (res, error) => res.status(400).json({ ok: false, error });

  // The path is spelled out, not INTAKE_PATH: the remote-policy ratchet finds
  // routes by their literal (test/remote-policy.test.js).
  app.post('/api/hooks/event', (req, res) => {
    if (!isHost(ctx, req)) return res.status(403).json({ ok: false, hint: HOST_HINT });
    const declared = declaredLength(req);
    if (declared !== null && declared > MAX_BODY_BYTES) return tooLarge(res);
    if (!req.is('application/json')) return malformed(res, 'not JSON');
    parseJson(req, res, (err) => {
      if (err) return err.status === 413 || err.type === 'entity.too.large' ? tooLarge(res) : malformed(res, 'not JSON');
      if (declared === null && bytesOf(req.body) > MAX_BODY_BYTES) return tooLarge(res);
      const problem = checkEnvelope(req.body);
      if (problem) return malformed(res, problem);
      if (!INTAKE_EVENTS.includes(req.body.event)) return malformed(res, 'not an event this intake takes');
      const tap = ctx.hooks;
      if (!tap || typeof tap.publish !== 'function') return res.status(503).json({ ok: false, error: 'no hook tap' });
      const envelope = req.body;
      res.json({ ok: true });
      setImmediate(() => { try { tap.publish(envelope); } catch {} });
    });
  });
}

module.exports = {
  mountHookRoutes, checkEnvelope, INTAKE_PATH, INTAKE_EVENTS, ENVELOPE_EVENTS, ENVELOPE_KEYS, MAX_BODY_BYTES,
};
