// A stand-in for Cloudflare Access, for the tunnel portal's tests.
//
// Real Access signs a JWT per request with a key from its published JWKS. This
// mints RSA keys, serves them as a JWKS through an injectable `fetchJwks`
// (counting calls, and able to go down), and signs tokens with any claim or
// header a test needs to get wrong — including the two classic forgeries the
// portal must refuse: `alg: none`, and HS256 "signed" with the RSA PUBLIC key
// as the HMAC secret.
//
// Nothing here touches the network. Key generation is the slow part (RSA-2048),
// so generated pairs are pooled per process and reused across fakes.

const crypto = require('crypto');

const POOL = [];
function keyPair(i) {
  while (POOL.length <= i) {
    POOL.push(crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }));
  }
  return POOL[i];
}

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

function createFakeAccess({ team = 'testteam', aud = 'test-aud-0123456789', email = 'me@example.com', now = () => Date.now() } = {}) {
  const keys = new Map(); // kid -> { privateKey, publicKey }
  let nextPair = 0;
  const state = { calls: 0, down: false };

  function addKey(kid) {
    keys.set(kid, keyPair(nextPair++));
    return kid;
  }
  function removeKey(kid) { keys.delete(kid); }
  addKey('k1');

  function jwks() {
    return {
      keys: [...keys.entries()].map(([kid, { publicKey }]) => ({
        ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig',
      })),
    };
  }

  async function fetchJwks(t) {
    state.calls++;
    if (t !== team) throw new Error(`fake access: asked for team ${t}, expected ${team}`);
    if (state.down) throw new Error('fake access: JWKS endpoint is down');
    return jwks();
  }

  function claims(over = {}) {
    const t = Math.floor(now() / 1000);
    return {
      iss: `https://${team}.cloudflareaccess.com`,
      aud: [aud],
      email,
      sub: 'user-1',
      type: 'app',
      iat: t,
      nbf: t,
      exp: t + 600,
      ...over,
    };
  }

  // A signed token. `claims` overrides merge over valid defaults (pass a key as
  // undefined to drop it); `kid` picks the signing key; `signWith` a key not
  // in the set.
  function mint(over = {}, { kid = 'k1', header = {}, signWith } = {}) {
    const c = claims(over);
    for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
    const h = { alg: 'RS256', kid, typ: 'JWT', ...header };
    const input = `${b64(h)}.${b64(c)}`;
    const key = signWith || (keys.get(kid) || keyPair(0)).privateKey;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(input), key).toString('base64url');
    return `${input}.${sig}`;
  }

  function mintNone(over = {}) {
    return `${b64({ alg: 'none', typ: 'JWT', kid: 'k1' })}.${b64(claims(over))}.`;
  }

  // HS256 with the RSA public key's PEM as the shared secret — the forgery
  // that works against a verifier that lets the token choose the algorithm.
  function mintHs256WithPublicKey(over = {}, kid = 'k1') {
    const input = `${b64({ alg: 'HS256', kid, typ: 'JWT' })}.${b64(claims(over))}`;
    const secret = keys.get(kid).publicKey.export({ format: 'pem', type: 'spki' });
    const sig = crypto.createHmac('sha256', secret).update(input).digest('base64url');
    return `${input}.${sig}`;
  }

  // A config object in tunnel.json's shape (normalise it with
  // lib/portal/config normalizeConfig).
  function config(over = {}) {
    return {
      hostname: 'wc.example.test',
      style: 'flat',
      access: { team, aud },
      allow: { emails: [email], domains: [] },
      ...over,
    };
  }

  return { team, aud, email, state, addKey, removeKey, jwks, fetchJwks, claims, mint, mintNone, mintHs256WithPublicKey, config, keyPair };
}

module.exports = { createFakeAccess };
