// The mod bridge's routes (spec §15.7), thin over ctx.bridge
// (lib/server/domain/bridge.js), with the wire in lib/core/mod-protocol:
//
//   POST /api/bridge/hello         a mod says hello → {ok, token, protocol,
//                                  wait_max_ms, flush_ms, permission_wait_ms,
//                                  ops, events} or a 400/409 refusal
//   GET  /api/bridge/ops?wait=ms   the mod's long-poll for ops (≤ 20 s)
//   POST /api/bridge/result        an op's result {id, ok, result?, refused?, error?}
//   POST /api/bridge/events        a batch of mod events {events: [≤ 50]}
//   GET  /api/bridge/status        content-free, for `claude-web-chat mod
//                                  status` (an addition to §15.7's four,
//                                  notes-B decision 6): no token needed, none
//                                  reported
//
// HOST ONLY (class P1, §5.7), every one of them. ctx.audience.isHost(req) is
// the one host-only test (§5.4): a loopback peer, not a remote viewer, that
// sent no Origin or Sec-Fetch-* header. The mod's $.http.fetch and lib/client
// send neither; any browser's fetch — a pane's included — sends one. So a
// pane can neither say hello as a mod nor reach a session's ops; a remote
// viewer cannot; and — Q9, carve-strict — a peer on a WEB_CHAT_HOST network
// bind gets nothing either. Without an audience on ctx every request is
// refused: the route fails closed. The portal refuses `* /api/bridge/*` before
// any of it gets here (HOST_ONLY, lib/core/remote-policy.js).
//
// THERE IS NO CHROME-FACING OP ROUTE (C46): nothing here enqueues an op. The
// chrome reaches the mod only through control actions, whose frames are
// served by the answer origin (§15.5); those call ctx.bridge.enqueue in
// process.
//
// The four mod routes take the session's token in the X-WC-Bridge header —
// never the query string, which would reach logs — and a missing or wrong one
// is 401 {refused: 'token'} (or 'superseded' / 'detached' for a token that once
// was). POST bodies are JSON only (415 otherwise), at most 64 KB — by the
// declared Content-Length, else by the parsed body, because the daemon's global
// express.json has already parsed every body at 200 MB — and a malformed one
// is 400. No ctx.bridge is 503 {ok: false, unavailable: true}.

const express = require('express');
const { classify } = require('../../core/remote-policy');
const { BODY_MAX, OPS_WAIT_MAX_MS } = require('../../core/mod-protocol');

const TOKEN_HEADER = 'x-wc-bridge';

// The refusal's hint, read from the one route table rather than copied.
const HOST_HINT = classify('POST', '/api/bridge/hello').hint;

const parseJson = express.json({ limit: BODY_MAX });

function bytesOf(v) {
  try { return Buffer.byteLength(JSON.stringify(v) || '', 'utf8'); } catch { return Infinity; }
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

function tokenOf(req) {
  const v = req.headers[TOKEN_HEADER];
  return typeof v === 'string' && v ? v : null;
}

function send(res, a) {
  res.status(a.status).json(a.body);
}

function mountBridgeRoutes(app, ctx) {
  const tooLarge = (res) => res.status(413).json({ ok: false, error: `body over ${BODY_MAX} bytes` });
  const malformed = (res, error) => res.status(400).json({ ok: false, error });
  const noToken = (res) => res.status(401).json({ ok: false, refused: 'token', hint: 'say hello again: POST /api/bridge/hello' });

  // The host gate and the bridge, in that order; null when the request has
  // been answered.
  function gate(req, res) {
    if (!isHost(ctx, req)) { res.status(403).json({ ok: false, hint: HOST_HINT }); return null; }
    const bridge = ctx.bridge;
    if (!bridge || typeof bridge.hello !== 'function') {
      res.status(503).json({ ok: false, unavailable: true, hint: 'the mod bridge is not running' });
      return null;
    }
    return bridge;
  }

  // A JSON body inside BODY_MAX, then fn(body).
  function withBody(req, res, fn) {
    const declared = declaredLength(req);
    if (declared !== null && declared > BODY_MAX) return tooLarge(res);
    if (!req.is('application/json')) return res.status(415).json({ ok: false, error: 'JSON only' });
    parseJson(req, res, (err) => {
      if (err) return err.status === 413 || err.type === 'entity.too.large' ? tooLarge(res) : malformed(res, 'not JSON');
      if (declared === null && bytesOf(req.body) > BODY_MAX) return tooLarge(res);
      return fn(req.body);
    });
  }

  // The paths are spelled out: the remote-policy ratchet finds routes by their
  // literal (test/remote-policy.test.js).
  app.post('/api/bridge/hello', (req, res) => {
    const bridge = gate(req, res);
    if (!bridge) return;
    withBody(req, res, (body) => send(res, bridge.hello(body)));
  });

  app.get('/api/bridge/ops', (req, res) => {
    const bridge = gate(req, res);
    if (!bridge) return;
    const token = tokenOf(req);
    if (!token) return noToken(res);
    const raw = req.query.wait;
    let waitMs = 0;
    if (raw !== undefined) {
      if (typeof raw !== 'string' || !/^[0-9]{1,6}$/.test(raw)) return malformed(res, 'wait is a number of milliseconds');
      waitMs = Math.min(OPS_WAIT_MAX_MS, Number(raw));
    }
    // A mod that goes away mid-poll frees its waiter at once.
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    bridge.poll(token, { waitMs, signal: ac.signal }).then(
      (a) => { if (!res.writableEnded && !res.destroyed) send(res, a); },
      () => { if (!res.headersSent) res.status(500).json({ ok: false }); },
    );
  });

  app.post('/api/bridge/result', (req, res) => {
    const bridge = gate(req, res);
    if (!bridge) return;
    const token = tokenOf(req);
    if (!token) return noToken(res);
    withBody(req, res, (body) => send(res, bridge.result(token, body)));
  });

  app.post('/api/bridge/events', (req, res) => {
    const bridge = gate(req, res);
    if (!bridge) return;
    const token = tokenOf(req);
    if (!token) return noToken(res);
    withBody(req, res, (body) => send(res, bridge.events(token, body)));
  });

  app.get('/api/bridge/status', (req, res) => {
    const bridge = gate(req, res);
    if (!bridge) return;
    res.json(bridge.status());
  });
}

module.exports = { mountBridgeRoutes, TOKEN_HEADER };
