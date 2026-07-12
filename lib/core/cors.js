// Shared CORS for the endpoints the browser extension hits cross-origin (from a
// chrome-extension:// origin). One copy for both the instance server's capture
// routes and the hub. No credentials are used; the origin is reflected.

function setCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-WC-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// Optional helper folding the `app.options(path, ...)` preflight boilerplate.
function mountCors(app, path) {
  app.options(path, (req, res) => { setCors(req, res); res.status(204).end(); });
}

module.exports = { setCors, mountCors };
