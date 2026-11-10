// The answer surface's port per session, as a LOCAL caller asks for it — the
// portal's answer host (lib/portal/answer.js) and the connector share it. It
// lived in lib/portal/answer.js until a second entry point needed it; that
// file re-exports it from here.
//
// The answer surface listens on an ephemeral port, started on demand and
// closed when idle. The relay asks for it as a local caller (lib/client: no
// Origin, no Sec-Fetch-*, no X-WC-Remote) with `GET /api/asks?ensure=1`, which
// starts an idle-closed surface and answers its port (ruled E2 (a)): a phone's
// Stop or answer works with no desktop browser open. /api/health alone never
// starts it, and since 0.8.5 reports the port to local callers only. Memoised
// for PORT_MEMO_MS per id:port:pid; no port is never kept.

const client = require('../client');

const PORT_MEMO_MS = 1000;
const PORT_TIMEOUT_MS = 3000;

//   createAnswerPorts({ client, memoMs, timeoutMs })
//     → { portOf(session) → Promise<port | null>, forget(session) }
function createAnswerPorts({ client: c = client, memoMs = PORT_MEMO_MS, timeoutMs = PORT_TIMEOUT_MS } = {}) {
  const memo = new Map(); // id:port:pid → { at, answer: Promise<port|null> }
  const keyOf = (s) => `${s.id}:${s.port}:${s.pid}`;

  function ask(session) {
    return c.get('/api/asks?ensure=1', { port: session.port, noSpawn: true, timeout: timeoutMs }).then(
      (body) => {
        const p = body && body.answer && body.answer.port;
        return Number.isSafeInteger(p) && p > 0 && p < 65536 ? p : null;
      },
      () => null,
    );
  }

  function portOf(session) {
    if (!session || !Number.isInteger(session.port)) return Promise.resolve(null);
    const key = keyOf(session);
    const at = Date.now();
    for (const [k, v] of memo) if (at - v.at >= memoMs) memo.delete(k);
    const hit = memo.get(key);
    if (hit) return hit.answer;
    const entry = { at, answer: ask(session) };
    memo.set(key, entry);
    // No port is never kept: the next request asks again.
    entry.answer.then((p) => { if (p == null && memo.get(key) === entry) memo.delete(key); });
    return entry.answer;
  }

  function forget(session) {
    if (session) memo.delete(keyOf(session));
  }

  return { portOf, forget };
}

module.exports = { createAnswerPorts, PORT_MEMO_MS, PORT_TIMEOUT_MS };
