// The control domain's one route on the main origin (spec §15.3, §15.5, C46,
// C47): turn-begin's claim of the one-shot notices Claude is owed.
//
//   POST /api/control/notices/claim  {session_id?, claude_pid?, max_chars}
//     → 200 {ok: true, notices: [{id, text}]}
//     P1, host only (ctx.audience.requireHost(): a browser — a pane's fetch
//     included —, a remote viewer and a network peer are refused 403 with the
//     host-only hint; lib/core/remote-policy refuses /api/control/* at the
//     portal too). At least one of session_id (a safe id) and claude_pid (a
//     positive integer); max_chars a positive integer, the room turn-begin has
//     left in its context string. Any other key, or a bad value → 400.
//     The notices come oldest first, whole, together within max_chars, and are
//     claimed exactly once (ctx.control.notices.claim).
//
// Nothing else here: every ACTING control lives on the answer origin, behind
// its gate (lib/server/control/index.js), so no acting control route is
// pane-callable (C46).

const { isSafeId } = require('../../core/paths');
const { HOST_ONLY } = require('../audience');

const CLAIM_KEYS = new Set(['session_id', 'claude_pid', 'max_chars']);

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;

function hostOnly(ctx) {
  const a = ctx.audience;
  if (a && typeof a.requireHost === 'function') return a.requireHost();
  // No audience wired: fail closed.
  return (req, res) => res.status(403).json({ ok: false, hint: HOST_ONLY });
}

function mountControlRoutes(app, ctx) {
  app.post('/api/control/notices/claim', hostOnly(ctx), (req, res) => {
    const body = req.body;
    const bad = (error) => res.status(400).json({ ok: false, error });
    if (!isPlain(body)) return bad('the body must be a JSON object');
    for (const k of Object.keys(body)) if (!CLAIM_KEYS.has(k)) return bad(`unknown key: ${k.slice(0, 40)}`);
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    if (!has('session_id') && !has('claude_pid')) return bad('session_id or claude_pid is required');
    if (has('session_id') && !isSafeId(body.session_id)) return bad('session_id is not a session id');
    if (has('claude_pid') && !isPositiveInt(body.claude_pid)) return bad('claude_pid must be a positive integer');
    if (!isPositiveInt(body.max_chars)) return bad('max_chars must be a positive integer');
    const control = ctx.control;
    if (!control || !control.notices || typeof control.notices.claim !== 'function') {
      return res.status(503).json({ ok: false, error: 'control is not running' });
    }
    let notices = [];
    try {
      notices = control.notices.claim({
        session_id: has('session_id') ? body.session_id : null,
        claude_pid: has('claude_pid') ? body.claude_pid : null,
        max_chars: body.max_chars,
      });
    } catch {
      return res.status(500).json({ ok: false, error: 'claim failed' });
    }
    const out = (Array.isArray(notices) ? notices : [])
      .filter((n) => isPlain(n) && typeof n.id === 'string' && typeof n.text === 'string')
      .map((n) => ({ id: n.id, text: n.text }));
    return res.json({ ok: true, notices: out });
  });
}

module.exports = { mountControlRoutes };
