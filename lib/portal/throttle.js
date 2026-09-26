// The failed-sign-in throttle: a client that keeps presenting no token, or a
// bad one, is answered 429 for a while without the portal verifying anything.
//
// With Cloudflare Access in front, a legitimate browser never reaches the
// portal without a token — Access sends it to the Google sign-in first. So a
// run of 401s is something probing the portal (or a tunnel routed around
// Access), and each one costs a JWT parse, possibly a key-set refetch, and a
// portal log line. After `limit` 401s inside `windowMs`, the client is refused
// for `windowMs` before any of that happens.
//
// The client is keyed by `Cf-Connecting-Ip` — the address Cloudflare saw, set
// by its edge on every proxied request, and not something the visitor can
// choose through the tunnel — falling back to the socket address (loopback,
// for anything that is not arriving through cloudflared). A key that is
// blocked is blocked for valid tokens too: that is what makes it a limit rather
// than a filter, and it lasts one window.
//
// Bounded: at most `maxKeys` clients are remembered; past that the oldest
// entries go first.

const DEFAULT_LIMIT = 20;
const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_KEYS = 1024;

function clientKey(req) {
  const ip = req.headers && req.headers['cf-connecting-ip'];
  if (typeof ip === 'string' && ip.trim() && ip.length <= 64) return ip.trim().toLowerCase();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function createThrottle({ limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS, maxKeys = DEFAULT_MAX_KEYS, now = Date.now } = {}) {
  // key -> { start, count, blockedUntil }
  const seen = new Map();

  function prune(t) {
    for (const [k, v] of seen) {
      if (v.blockedUntil <= t && t - v.start >= windowMs) seen.delete(k);
    }
    while (seen.size > maxKeys) seen.delete(seen.keys().next().value);
  }

  // Seconds this key must still wait, or 0 when it may be verified.
  function retryAfter(key) {
    const v = seen.get(key);
    if (!v) return 0;
    const left = v.blockedUntil - now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  // Count one 401 for this key. True exactly when this failure starts a block
  // (so the caller logs the block once, not every refused request).
  function fail(key) {
    const t = now();
    let v = seen.get(key);
    if (!v || (t - v.start >= windowMs && v.blockedUntil <= t)) {
      seen.delete(key);
      v = { start: t, count: 0, blockedUntil: 0 };
      seen.set(key, v);
    }
    v.count += 1;
    if (v.count >= limit && v.blockedUntil <= t) {
      v.blockedUntil = t + windowMs;
      if (seen.size > maxKeys) prune(t);
      return true;
    }
    if (seen.size > maxKeys) prune(t);
    return false;
  }

  function blockedCount() {
    const t = now();
    let n = 0;
    for (const v of seen.values()) if (v.blockedUntil > t) n += 1;
    return n;
  }

  return { fail, retryAfter, blockedCount, get size() { return seen.size; } };
}

module.exports = { createThrottle, clientKey, DEFAULT_LIMIT, DEFAULT_WINDOW_MS, DEFAULT_MAX_KEYS };
