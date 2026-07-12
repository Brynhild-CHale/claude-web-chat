// The three intentional version facts, each with a single home. `core` imports
// nothing else from lib/, so this is a dependency leaf every layer can read.
//
//   packageVersion()  — the npm semver users see (package.json).
//   SCHEMA_VERSION    — on-disk .web-chat/ state schema; written ONLY by the
//                       migration runner (lib/update/migrations) into _version.json.
//   PROTOCOL_VERSION  — hub/instance wire protocol; drives the health self-heal.
//
// Consolidates what were scattered facts: SCHEMA_VERSION lived in
// migrations/index.js, and PROTOCOL_VERSION was HUB_PROTOCOL_VERSION in
// lib/util/hub.js. Those keep thin re-export aliases so existing callers/tests
// still resolve them.

const path = require('path');

// The package's semver, read from package.json. Not cached deliberately — read so
// rarely (status/mcp banner) that a require-cache hit is already free.
function packageVersion() {
  return require(path.join(__dirname, '..', '..', 'package.json')).version;
}

// On-disk state schema version. Bump whenever a breaking change to the layout of
// <root>/.web-chat/ ships, and register the upgrade in lib/update/migrations.
// v2 landed the first real migration (v1-to-v2: delete the orphaned server.pid).
const SCHEMA_VERSION = 2;

// Hub/instance wire-protocol version. Bump whenever the hub gains or changes
// routes the extension or instances depend on (e.g. /api/profile-match landed in
// v2). A long-running process from before a bump answers /api/health with a lower
// version; ensureHub detects that (isProtocolCurrent) and bounces the stale hub so
// the fresh code loads.
const PROTOCOL_VERSION = 2;

// True when a probed /api/health is at least the protocol this build expects. A
// health object without a `version` predates the field, so it counts as v1.
function isProtocolCurrent(health) {
  return ((health && health.version) || 1) >= PROTOCOL_VERSION;
}

module.exports = { packageVersion, SCHEMA_VERSION, PROTOCOL_VERSION, isProtocolCurrent };
