// GET /tunnel/setup — the chrome's way into the remote-access setup page
// (⌘K "Set up remote access…", ⋯ → Set up remote access). It starts the
// page's own listener if it is not running and redirects the new tab there.
//
// The page is NOT served from this origin, deliberately: panes run in this
// origin, and the page takes a Cloudflare API token that decides where this
// machine's surfaces are published. lib/server/tunnel-setup explains the
// separate origin and the gate on every setup call.
//
// This route hands out nothing secret — the setup page's address is no more
// than a loopback port, and a page that learns it can neither read the setup
// page (cross-origin) nor call its API (Origin + nonce + no CORS). The worst a
// pane can do with it is open a tab showing the setup page, which it could do
// with any URL. Refused to a remote viewer (and by lib/core/remote-policy
// before the portal would even ask): remote access is set up on the host.

const { isRemoteRequest } = require('../../core/cors');
const { createTunnelSetup } = require('../tunnel-setup');

// `opts` are createTunnelSetup's (a test's fake Cloudflare env, fetchJwks, a
// stand-in for tunnel control). Returns { close } for the daemon's shutdown.
function mountTunnelRoutes(app, { paths }, opts = {}) {
  const setup = createTunnelSetup({ paths, ...opts });

  app.get('/tunnel/setup', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    if (isRemoteRequest(req)) {
      return res.status(403).json({ ok: false, remote: true, hint: 'remote access is set up on the host: ⌘K → Set up remote access…, or claude-web-chat tunnel setup' });
    }
    let url;
    try { ({ url } = await setup.ensure()); } catch (e) {
      return res.status(500).type('text/plain').send(`could not open the setup page: ${e.message}`);
    }
    res.redirect(302, url);
  });

  return { close: () => setup.close(), setup };
}

module.exports = { mountTunnelRoutes };
