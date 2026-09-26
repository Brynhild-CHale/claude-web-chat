// The live surface's WebSocket, relayed from a remote viewer to one loopback
// daemon.
//
// Two sockets, not a byte pipe. The downstream (viewer) handshake is completed
// by the portal only once the UPSTREAM socket to `ws://127.0.0.1:<port>/ws` is
// open — so a dead daemon is a clean 502 on the handshake, not a socket that
// opens and immediately dies — and the upstream is opened with NO Origin
// header: the daemon's verifyUpgrade then sees what it sees from any local
// non-browser client. The viewer's Origin has already been matched against the
// session's public origin by the caller; nothing from the viewer's handshake is
// forwarded at all.
//
// Frames are relayed as they are (text stays text, binary stays binary), in
// both directions; a close on either side closes the other.
//
// The Access token that admitted the viewer has an expiry, and an HTTP request
// is re-checked on every call but a socket is not. So the relay is cut at the
// token's `exp` plus a short grace (EXPIRY_GRACE_MS) with close code 4401: the
// SPA reconnects, and that reconnect is a fresh handshake that has to present a
// fresh token.

const WebSocket = require('ws');
const { LOOPBACK } = require('../core/cors');

const EXPIRY_GRACE_MS = 5000;
const CLOSE_EXPIRED = 4401;
const UPSTREAM_TIMEOUT_MS = 5000;

// Answer a refused upgrade on the raw socket. The handshake never reached a ws
// server, so this is plain HTTP/1.1.
function refuseUpgrade(socket, status, body, reasonText = 'Refused') {
  if (socket.destroyed) return;
  const payload = JSON.stringify(body || { ok: false });
  try {
    socket.end(
      `HTTP/1.1 ${status} ${reasonText}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Type: application/json\r\n'
      + `Content-Length: ${Buffer.byteLength(payload)}\r\n`
      + 'Referrer-Policy: no-referrer\r\n'
      + '\r\n'
      + payload,
    );
  } catch {}
  setTimeout(() => { try { socket.destroy(); } catch {} }, 1000).unref();
}

function createWsRelay({ now = Date.now, graceMs = EXPIRY_GRACE_MS } = {}) {
  const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
  wss.on('error', () => {});
  const live = new Set();

  // Relay one admitted upgrade. `expSec` is the admitting token's exp claim.
  function relay(req, socket, head, { port, expSec }) {
    socket.on('error', () => {});
    const upstream = new WebSocket(`ws://${LOOPBACK}:${port}/ws`, {
      perMessageDeflate: false,
      handshakeTimeout: UPSTREAM_TIMEOUT_MS,
    });
    const early = [];
    let down = null;
    let timer = null;
    // The viewer gave up before the daemon answered: drop the upstream too.
    socket.once('close', () => { if (!down) { try { upstream.terminate(); } catch {} } });

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (pair) live.delete(pair);
    };
    const pair = {
      close(code, reason) {
        try { if (down) down.close(code, reason); } catch {}
        try { upstream.close(); } catch {}
        // A peer that never answers the close frame must not pin the pair.
        setTimeout(() => {
          try { if (down) down.terminate(); } catch {}
          try { upstream.terminate(); } catch {}
        }, 1000).unref();
      },
      terminate() {
        try { if (down) down.terminate(); } catch {}
        try { upstream.terminate(); } catch {}
      },
    };

    upstream.on('message', (data, isBinary) => {
      if (down && down.readyState === WebSocket.OPEN) down.send(data, { binary: isBinary });
      else if (!down) early.push([data, isBinary]);
    });
    upstream.once('unexpected-response', (_r, res) => {
      res.resume();
      refuseUpgrade(socket, 502, { ok: false, remote: true, error: 'the session refused the socket' }, 'Bad Gateway');
      try { upstream.terminate(); } catch {}
    });
    upstream.on('error', () => {
      if (!down) refuseUpgrade(socket, 502, { ok: false, remote: true, error: 'this session\'s daemon is not answering' }, 'Bad Gateway');
      else pair.terminate();
    });
    upstream.once('open', () => {
      if (socket.destroyed) { try { upstream.terminate(); } catch {} return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        down = ws;
        live.add(pair);
        for (const [data, isBinary] of early.splice(0)) ws.send(data, { binary: isBinary });
        ws.on('message', (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        });
        ws.on('close', () => { cleanup(); try { upstream.close(); } catch {} });
        ws.on('error', () => { cleanup(); try { upstream.terminate(); } catch {} });
        upstream.on('close', () => { cleanup(); try { ws.close(); } catch {} });
        const left = (Number(expSec) * 1000) + graceMs - now();
        timer = setTimeout(() => {
          timer = null;
          pair.close(CLOSE_EXPIRED, 'access token expired — reconnect to sign in again');
        }, Math.max(0, Number.isFinite(left) ? left : 0));
        timer.unref();
      });
    });
  }

  // Every relayed pair, cut (shutdown).
  function closeAll() {
    for (const p of [...live]) p.terminate();
    live.clear();
  }

  return { relay, closeAll, get size() { return live.size; } };
}

module.exports = { createWsRelay, refuseUpgrade, CLOSE_EXPIRED, EXPIRY_GRACE_MS };
