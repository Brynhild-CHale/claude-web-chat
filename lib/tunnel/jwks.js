// Cloudflare Access's signing keys — fetched, cached, and turned into KeyObjects
// the JWT check (access-jwt.js) can verify against.
//
// The fetch goes through lib/util/outbound (https only, bounded in time and
// size) — the shared home for small outbound JSON exchanges, extracted when the
// Cloudflare API client became the fourth requester (docs/extending.md, "the
// outbound requesters").
//
// Policy, and why:
//   * The URL is fixed by the team name: https://<team>.cloudflareaccess.com/
//     cdn-cgi/access/certs. Nothing a request carries can steer it.
//   * COLD failure is fatal to the request (the caller answers 503): with no
//     keys there is nothing to verify against, and "let it through" is not an
//     option. Cold retries are spaced (COLD_RETRY_MS) so a Cloudflare outage
//     does not become one outbound fetch per incoming request.
//   * An UNKNOWN kid refetches — that is how a key rotation arrives — but at
//     most once per MIN_REFETCH_MS. Anyone who can reach the portal can mint a
//     token header with a random kid; without the limit that is a free
//     request-amplifier aimed at Cloudflare.
//   * A cache older than MAX_AGE_MS refreshes before it is trusted again, so a
//     key Cloudflare withdrew stops verifying within the hour. A failed refresh
//     keeps the keys already held (warm failure is not an outage).
//   * Only RSA signing keys are admitted; anything else in the set is ignored.

const crypto = require('crypto');
const outbound = require('../util/outbound');

const MIN_REFETCH_MS = 60 * 1000;
const COLD_RETRY_MS = 5 * 1000;
const MAX_AGE_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 256 * 1024;

class JwksUnavailableError extends Error {
  constructor(cause) {
    super(`Cloudflare Access signing keys are unavailable${cause ? `: ${cause.message || cause}` : ''}`);
    this.name = 'JwksUnavailableError';
  }
}

function jwksUrl(team) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(String(team || ''))) {
    throw new Error(`jwks: invalid Access team name "${team}"`);
  }
  return `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`;
}

// GET a JSON document, bounded in time and size (lib/util/outbound: https
// only, plain http to loopback for a test's local server).
function fetchJson(url, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  return outbound.fetchJson(url, { timeoutMs, maxBytes });
}

function defaultFetchJwks(team) {
  return fetchJson(jwksUrl(team));
}

// A JWKS document → Map<kid, KeyObject>, admitting only RSA signature keys.
function parseJwks(doc) {
  const out = new Map();
  const keys = doc && Array.isArray(doc.keys) ? doc.keys : [];
  for (const k of keys) {
    if (!k || typeof k !== 'object' || k.kty !== 'RSA' || typeof k.kid !== 'string' || !k.kid) continue;
    if (k.alg != null && k.alg !== 'RS256') continue;
    if (k.use != null && k.use !== 'sig') continue;
    try {
      out.set(k.kid, crypto.createPublicKey({ key: { kty: k.kty, n: k.n, e: k.e }, format: 'jwk' }));
    } catch {}
  }
  return out;
}

function createJwksCache({
  team,
  fetchJwks = defaultFetchJwks,
  now = Date.now,
  minRefetchMs = MIN_REFETCH_MS,
  coldRetryMs = COLD_RETRY_MS,
  maxAgeMs = MAX_AGE_MS,
} = {}) {
  let keys = new Map();
  let loadedAt = 0;      // last SUCCESSFUL load (0 = cold)
  let attemptAt = -Infinity; // last attempt, success or not
  let fetches = 0;
  let lastError = null;
  let inflight = null;

  function refresh() {
    if (inflight) return inflight;
    attemptAt = now();
    fetches++;
    inflight = (async () => {
      try {
        const next = parseJwks(await fetchJwks(team));
        if (next.size === 0) throw new Error('the key set holds no RSA signing keys');
        keys = next;
        loadedAt = now();
        lastError = null;
      } catch (e) {
        lastError = e;
        throw e;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  // The KeyObject for `kid`, or null when no such key exists (after the
  // rate-limited refetch). Throws JwksUnavailableError only when COLD.
  async function getKey(kid) {
    if (!loadedAt) {
      if (now() - attemptAt < coldRetryMs && !inflight) throw new JwksUnavailableError(lastError);
      try { await refresh(); } catch (e) { throw new JwksUnavailableError(e); }
      return keys.get(kid) || null;
    }
    const stale = now() - loadedAt >= maxAgeMs;
    if ((stale || !keys.has(kid)) && now() - attemptAt >= minRefetchMs) {
      try { await refresh(); } catch {}
    }
    return keys.get(kid) || null;
  }

  function status() {
    return {
      loaded_at: loadedAt || null,
      last_attempt_at: Number.isFinite(attemptAt) ? attemptAt : null,
      keys: keys.size,
      fetches,
      error: lastError ? String(lastError.message || lastError) : null,
    };
  }

  return { getKey, refresh, status };
}

module.exports = {
  createJwksCache, parseJwks, fetchJson, jwksUrl, defaultFetchJwks, JwksUnavailableError,
  MIN_REFETCH_MS, COLD_RETRY_MS, MAX_AGE_MS,
};
