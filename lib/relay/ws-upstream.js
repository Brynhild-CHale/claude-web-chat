// The upstream half of a relayed WebSocket: one client socket to a loopback
// daemon's `ws://127.0.0.1:<port>/ws`, shared by the tunnel portal
// (lib/portal/ws-relay.js, the viewer's side handed back in the same process)
// and the connector (05 C-05.34: the viewer's side is the hub's, across the
// link). This half carries bytes and headers; it decides nothing — what a
// stamp grants is the daemon's to check, and what a close code becomes on the
// other leg is the caller's.
//
// THE UPGRADE. No Origin, ever: the daemon's verifyUpgrade then sees what it
// sees from any local non-browser client (the viewer's Origin was matched by
// the caller). The headers are, in this order: the caller's `stamp` (checked
// by headers.js checkStamp, the one stamp rule, before anything is dialled),
// then X-WC-Remote: 1 last of the x-wc-* headers, then the viewer's
// User-Agent when there is one. Never a cookie or an Authorization header.
// perMessageDeflate off; the handshake times out after UPSTREAM_TIMEOUT_MS.
// `maxPayload` reaches the ws client only when given: omitted, ws's client
// default stands (100 MiB, C-05.23).
//
// EARLY. Messages the daemon sends before the caller calls deliver() — the
// portal calls it once the viewer's handshake completes — are kept in arrival
// order and handed to 'message' first (C-05.35, the portal's `early`).
//
// PAUSE. pause() stops reading the daemon's socket (ws's WebSocket#pause), so
// backpressure reaches the daemon and its own rules apply (C-05.22: holdStream
// at 4 MiB, its 30 s heartbeat — whose close comes back here like any other).
// A message ws had already parsed when pause() was called is held, never
// delivered while paused; resume() hands the held ones over in order, then
// resumes the socket.
//
// EVENTS. 'open'; 'message'(data, isBinary) — only after deliver() and while
// not paused; before 'open' exactly one of 'refused'(status, body) — the
// daemon answered the upgrade with an HTTP response; `body` is its bytes (at
// most maxRefusalBytes) when collectRefusal, else null and the response is
// drained unread — and 'error'(err) — no answer, or the handshake timed out;
// after 'open', 'close'(code, reason) once, with the daemon's code and reason
// exactly as ws reports them (1005 and 1006 included: mapping a code no close
// frame may carry is the caller's). When the daemon sends a message this
// client refuses (over maxPayload: 1009; invalid UTF-8: 1007), ws closes with
// that code but reports 1006; the code it closed with is reported instead. An
// 'error' after 'open' is told too (the portal cuts its pair on one) and a
// 'close' always follows it. After the caller's own close() or terminate()
// before 'open', nothing more is emitted. An 'error' is emitted only to a
// listener (an unhandled 'error' would end the process, C-05.10a), and ws's own
// 'error' always has one here.

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { LOOPBACK, REMOTE_HEADER, REMOTE_HEADER_VALUE } = require('../core/cors');
const { checkStamp } = require('./headers');

const UPSTREAM_TIMEOUT_MS = 5000;

// ws marks a receiver error with the close code it sent under a symbol it does
// not export; for one without it, the codes ws's receiver uses.
const RECEIVER_CODES = { WS_ERR_UNSUPPORTED_MESSAGE_LENGTH: 1009, WS_ERR_INVALID_UTF8: 1007 };
function receiverCloseCode(err) {
  if (!err || typeof err !== 'object') return null;
  for (const s of Object.getOwnPropertySymbols(err)) {
    if (s.description === 'status-code' && Number.isInteger(err[s])) return err[s];
  }
  const code = typeof err.code === 'string' ? err.code : '';
  if (RECEIVER_CODES[code]) return RECEIVER_CODES[code];
  return code.startsWith('WS_ERR_') ? 1002 : null;
}

// The stamp's headers, checked by headers.js checkStamp (the one stamp rule in
// lib/relay: a plain object of string values whose keys are x-wc-* in
// lowercase and never X-WC-Remote, which this module sets last). It throws a
// TypeError before anything is dialled.
function stampHeaders(stamp) {
  return Object.fromEntries(checkStamp(stamp));
}

// The url and the ws client options openUpstream dials with (exported for the
// test that pins them without sending a large message).
function upstreamOptions({ port, userAgent = null, stamp = null, maxPayload } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('openUpstream: port must be a TCP port');
  const headers = { ...stampHeaders(stamp), [REMOTE_HEADER]: REMOTE_HEADER_VALUE };
  if (userAgent) headers['user-agent'] = String(userAgent);
  const options = { perMessageDeflate: false, handshakeTimeout: UPSTREAM_TIMEOUT_MS, headers };
  if (maxPayload !== undefined) options.maxPayload = maxPayload;
  return { url: `ws://${LOOPBACK}:${port}/ws`, options };
}

function openUpstream({ port, userAgent = null, stamp = null, collectRefusal = false, maxRefusalBytes = 65536, maxPayload } = {}) {
  const { url, options } = upstreamOptions({ port, userAgent, stamp, maxPayload });
  const h = new EventEmitter();
  const ws = new WebSocket(url, options);

  let opened = false;
  let settled = false; // before 'open': a refusal, an error or the caller's own end was told
  let delivered = false;
  let paused = false;
  let localCode = null; // the code ws closed with on a message it refused
  const held = [];

  const tellError = (err) => { if (h.listenerCount('error') > 0) h.emit('error', err); };
  const drain = () => {
    while (delivered && !paused && held.length) {
      const [data, isBinary] = held.shift();
      h.emit('message', data, isBinary);
    }
  };

  ws.on('message', (data, isBinary) => {
    held.push([data, isBinary]);
    drain();
  });
  ws.once('open', () => {
    if (settled) return;
    opened = true;
    if (paused) ws.pause();
    h.emit('open');
  });
  ws.once('unexpected-response', (_req, res) => {
    const status = res.statusCode;
    const finish = (body) => {
      if (settled) return;
      settled = true;
      h.emit('refused', status, body);
      try { ws.terminate(); } catch {}
    };
    if (!collectRefusal) { res.resume(); finish(null); return; }
    const chunks = [];
    let size = 0;
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      finish(Buffer.concat(chunks, size));
    };
    const t = setTimeout(end, UPSTREAM_TIMEOUT_MS);
    t.unref();
    res.on('data', (c) => {
      if (done) return;
      const take = Math.min(c.length, maxRefusalBytes - size);
      if (take > 0) { chunks.push(take === c.length ? c : c.subarray(0, take)); size += take; }
      if (size >= maxRefusalBytes) { end(); try { res.destroy(); } catch {} }
    });
    res.on('end', end);
    res.on('error', end);
    res.on('close', end);
  });
  ws.on('error', (err) => {
    if (opened) {
      const code = receiverCloseCode(err);
      if (code != null && localCode == null) localCode = code;
      tellError(err);
      return;
    }
    if (settled) return;
    settled = true;
    tellError(err);
  });
  ws.on('close', (code, reason) => {
    if (!opened) return;
    if (code === 1006 && localCode != null) h.emit('close', localCode, Buffer.alloc(0));
    else h.emit('close', code, reason);
  });

  h.deliver = () => { delivered = true; drain(); };
  h.send = (data, { binary = false } = {}) => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(data, { binary });
    return true;
  };
  h.pause = () => {
    paused = true;
    if (ws.readyState === WebSocket.OPEN) ws.pause();
  };
  h.resume = () => {
    paused = false;
    drain();
    if (!paused && ws.readyState === WebSocket.OPEN) ws.resume();
  };
  h.close = (code, reason) => {
    // ws throws on a code no close frame may carry (1005, 1006, …): a caller's
    // mistake, told to the caller.
    if (!opened) settled = true;
    ws.close(code, reason);
  };
  h.terminate = () => {
    if (!opened) settled = true;
    try { ws.terminate(); } catch {}
  };
  Object.defineProperty(h, 'readyState', { get: () => ws.readyState, enumerable: true });
  Object.defineProperty(h, 'isPaused', { get: () => paused, enumerable: true });
  Object.defineProperty(h, 'bufferedAmount', { get: () => ws.bufferedAmount, enumerable: true });
  return h;
}

module.exports = { openUpstream, upstreamOptions, UPSTREAM_TIMEOUT_MS };
