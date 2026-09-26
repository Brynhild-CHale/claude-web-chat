// Preloaded (NODE_OPTIONS=--require) into a DETACHED child a test spawns — the
// tunnel portal — so nothing it does can reach the public internet. The portal
// warms Cloudflare Access's key set at boot; in a test that would be a real
// DNS lookup and HTTPS request to <team>.cloudflareaccess.com. Every https
// request fails at once instead, which the portal treats as a cold key set
// (logged, retried later) — exactly the offline behaviour, with no product seam.

const https = require('https');

function refuse() {
  throw new Error('no-outbound: public-internet requests are disabled in tests');
}
https.request = refuse;
https.get = refuse;
