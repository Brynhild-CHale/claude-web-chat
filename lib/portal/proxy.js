// The streamed HTTP proxy from a remote viewer to one loopback daemon, and the
// header hygiene on both legs of it, now live in lib/relay (headers.js and
// http.js), the relay code the portal and the connector share (C-06.4 step 7,
// 05 §4). This file re-exports the portal's eight names from there — the same
// function and Set objects — so its importers keep requiring it unchanged.
// Nothing is defined here.

const {
  proxyHttp, forwardHeaders, responseHeaders, securityHeaders, answerSecurityHeaders, pathnameOf, isPreviewPath, FORWARD,
} = require('../relay');

module.exports = {
  proxyHttp, forwardHeaders, responseHeaders, securityHeaders, answerSecurityHeaders, pathnameOf, isPreviewPath, FORWARD,
};
