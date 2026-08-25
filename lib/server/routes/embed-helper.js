// Historical mount point. The install-page engine now covers BOTH bundled
// extensions (the tab-stream extension is the half the product is named after,
// and it had no install page at all), so it lives in ./extensions.js — this file
// keeps the name lib/server/index.js mounts, and nothing else. There is exactly
// one extension-page implementation; see routes/extensions.js.
const { mountExtensionRoutes } = require('./extensions');

module.exports = { mountEmbedHelperRoutes: mountExtensionRoutes };
