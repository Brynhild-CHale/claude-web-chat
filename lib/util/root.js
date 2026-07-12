// Re-export of the path authority. findProjectRoot / resolveWebChatDir now live in
// lib/core/paths.js; this shim keeps the ~14 existing `require('../util/root')`
// importers unchanged.
module.exports = require('../core/paths');
