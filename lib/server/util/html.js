// Compat re-export. The escaper moved to lib/core/html.js (the dependency leaf)
// so lib/capture and lib/server can share it without either importing the other.
// Left here so the server routes that already say `require('../util/html')` keep
// resolving unchanged.
module.exports = { escapeHtml: require('../../core/html').escapeHtml };
