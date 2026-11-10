// THE identity check (C-06.4 step 6): is the daemon listening on a target's
// port the one the caller's record names? A record names a port, and a port is
// not a project — a stopped project's port is the first one the next daemon's
// walk takes, and a crashed one's entry lives on while its pid is reused — so
// a relay that skipped this could serve one project under another's name.
//
// ONE engine, the predicate a parameter. It lived inside lib/portal/index.js
// (probeIdentity + confirmIdentity) until the connector needed it too
// (PIPELINE@relay-steps (a)); the portal now builds it with its own probe rule
// and REGISTRY_MEMO_MS, unchanged.
//
//   probeHealthIdentity(target, { timeoutMs = IDENTITY_TIMEOUT_MS })
//     → Promise<'ok' | 'mismatch' | 'down'>
//   The portal's rule (C-05.30 records it as the portal's): the daemon's
//   GET /api/health, through lib/client and never spawning, answers role
//   'instance' with target.pid → 'ok'; any other answer, or a non-2xx
//   (client.HttpError) → 'mismatch' (something answered, and it is not that
//   daemon); no answer at all → 'down'.
//
//   createIdentityCheck({ probe = probeHealthIdentity, memoMs, now = Date.now })
//     → { confirm(target, { fresh = false }) → Promise<answer>, clear() }
//   `probe(target)` → Promise<'ok' | 'mismatch' | 'down'> is THE contract a
//   caller's own predicate meets (it must resolve, never reject); it is handed
//   the target object as given. `target` carries { id, port, pid }. An answer
//   is reused for `memoMs` per `${id}:${port}:${pid}` — the in-flight probe
//   too, so a burst of asset requests asks once — and entries that old are
//   dropped on each call. `fresh` (every WebSocket upgrade: a relay is
//   long-lived) always asks and neither reads nor writes the memo. 'down' is
//   never kept. `clear()` drops every answer (the caller's registry memo was
//   forgotten).

const client = require('../client');

// How long the identity probe waits for a daemon's /api/health.
const IDENTITY_TIMEOUT_MS = 5000;

function probeHealthIdentity(target, { timeoutMs = IDENTITY_TIMEOUT_MS } = {}) {
  return client.get('/api/health', { port: target.port, noSpawn: true, timeout: timeoutMs }).then(
    (h) => (h && h.role === 'instance' && h.pid === target.pid ? 'ok' : 'mismatch'),
    (e) => (e instanceof client.HttpError ? 'mismatch' : 'down'),
  );
}

function createIdentityCheck({ probe = probeHealthIdentity, memoMs, now = Date.now } = {}) {
  if (!Number.isFinite(memoMs)) throw new TypeError('createIdentityCheck: memoMs must be a finite number');
  const memo = new Map(); // id:port:pid → { at, answer: Promise<answer> }

  function confirm(target, { fresh = false } = {}) {
    const key = `${target.id}:${target.port}:${target.pid}`;
    const at = now();
    for (const [k, v] of memo) if (at - v.at >= memoMs) memo.delete(k);
    const hit = fresh ? null : memo.get(key);
    if (hit) return hit.answer;
    const entry = { at, answer: probe(target) };
    if (!fresh) memo.set(key, entry);
    entry.answer.then((a) => { if (a === 'down' && memo.get(key) === entry) memo.delete(key); });
    return entry.answer;
  }

  function clear() { memo.clear(); }

  return { confirm, clear };
}

module.exports = { probeHealthIdentity, createIdentityCheck, IDENTITY_TIMEOUT_MS };
