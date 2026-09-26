// The Cloudflare Access JWT check — the portal's MANDATORY local verification.
//
// Cloudflare Access sits in front of the tunnel and signs every request it lets
// through with a JWT (the `Cf-Access-Jwt-Assertion` header, and the
// `CF_Authorization` cookie on the browser side). Trusting Access alone would
// make the tunnel's configuration the whole of the access control: one
// hostname routed around the Access application, one policy edited in the
// dashboard, one `cloudflared` pointed at the portal by something else on the
// machine — and every surface on this machine is open. So the portal checks
// the token itself, against Cloudflare's published keys and against a LOCAL
// email allowlist that nothing in the dashboard can widen.
//
// What is checked, in order, and each failure's status:
//   401  missing / malformed token, alg other than RS256 (so `none` and the
//        HS256-signed-with-the-public-key confusion are both refused before a
//        key is touched), a kid the key set does not have, a bad signature,
//        wrong `iss`, an `aud` that does not contain ours, exp/nbf/iat outside
//        a ±60s skew.
//   403  a valid token WITHOUT an email (an Access service token — machine
//        credentials never reach a surface), or an email not on the allowlist.
//   503  the key set could not be fetched at all (cold) — fail closed.
//
// node:crypto only: createPublicKey({format:'jwk'}) in jwks.js, crypto.verify
// here. No JWT library — the surface of one is the thing being avoided.

const crypto = require('crypto');
const { JwksUnavailableError } = require('./jwks');

const SKEW_SEC = 60;
const MAX_TOKEN_BYTES = 16 * 1024;
const HEADER = 'cf-access-jwt-assertion';
const COOKIE = 'CF_Authorization';

function issuerFor(team) {
  return `https://${team}.cloudflareaccess.com`;
}

// The token a request carries: the header Cloudflare injects, else the cookie
// the browser holds (Cloudflare sets both; the header is authoritative).
function tokenFrom(headers) {
  const h = headers || {};
  const direct = h[HEADER];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const cookie = typeof h.cookie === 'string' ? h.cookie : '';
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE) {
      const v = part.slice(eq + 1).trim();
      if (v) return v;
    }
  }
  return null;
}

function b64urlJson(s) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

function no(status, reason) {
  return { ok: false, status, reason };
}

// Lowercase exact match on the full address; `domains` (off unless configured)
// admits any address whose part after the LAST @ is exactly one of them.
function emailAllowed(email, allow) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  if ((allow.emails || []).includes(e)) return true;
  const at = e.lastIndexOf('@');
  return at > 0 && (allow.domains || []).includes(e.slice(at + 1));
}

// verify(token) → { ok:true, email, claims } | { ok:false, status, reason }.
// Never throws.
function createVerifier({ team, aud, allow, jwks, now = Date.now, skewSec = SKEW_SEC }) {
  const iss = issuerFor(team);

  async function verify(token) {
    if (typeof token !== 'string' || !token) return no(401, 'missing');
    if (token.length > MAX_TOKEN_BYTES) return no(401, 'malformed');
    const parts = token.split('.');
    if (parts.length !== 3) return no(401, 'malformed');
    const header = b64urlJson(parts[0]);
    const claims = b64urlJson(parts[1]);
    if (!header || !claims) return no(401, 'malformed');
    // Before anything else touches the token: the algorithm is OURS to choose,
    // never the token's.
    if (header.alg !== 'RS256') return no(401, 'alg');
    if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) return no(401, 'malformed');
    if (typeof header.kid !== 'string' || !header.kid) return no(401, 'kid');

    let key;
    try {
      key = await jwks.getKey(header.kid);
    } catch (e) {
      if (e instanceof JwksUnavailableError) return no(503, 'jwks-unavailable');
      return no(401, 'kid');
    }
    if (!key) return no(401, 'kid');

    let good = false;
    try {
      good = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    } catch { good = false; }
    if (!good) return no(401, 'signature');

    if (claims.iss !== iss) return no(401, 'iss');
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(aud)) return no(401, 'aud');
    const t = now() / 1000;
    if (typeof claims.exp !== 'number' || t > claims.exp + skewSec) return no(401, 'exp');
    if (claims.nbf != null && (typeof claims.nbf !== 'number' || t < claims.nbf - skewSec)) return no(401, 'nbf');
    if (claims.iat != null && (typeof claims.iat !== 'number' || claims.iat > t + skewSec)) return no(401, 'iat');

    if (typeof claims.email !== 'string' || !claims.email.trim()) return no(403, 'no-email');
    if (!emailAllowed(claims.email, allow)) return no(403, 'not-allowed');
    return { ok: true, email: claims.email.trim().toLowerCase(), claims };
  }

  return { verify };
}

// What a refused viewer is told. Deliberately generic below the status: the
// portal's logs carry the reason; the page does not need to teach an attacker
// which check they failed.
const MESSAGES = {
  401: 'sign in through Cloudflare Access to reach this surface',
  403: 'this account is not allowed to reach this machine\'s surfaces',
  503: 'the portal cannot reach Cloudflare Access to check your sign-in — try again shortly',
};

module.exports = { createVerifier, tokenFrom, emailAllowed, issuerFor, MESSAGES, HEADER, COOKIE, SKEW_SEC };
