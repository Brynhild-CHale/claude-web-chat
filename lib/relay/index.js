// lib/relay — the relay code the tunnel portal (lib/portal) and the connector
// share (C-06.4 step 7; 05 §4: SHARED, as lib/tunnel is; no ./relay package
// export in v1). Each name is DEFINED in exactly one file below and exported
// here once; lib/portal re-requires them, nothing is copied.
//
// lib/relay requires node builtins, 'ws', lib/client and lib/core only — never
// an entry point (lib/portal, lib/server, lib/connector, …), lib/util or
// lib/tunnel (test/relay.test.js pins it).

const {
  FORWARD, HOP_BY_HOP, ANSWER_HEADER, forwardHeaders, isPreviewPath, securityHeaders,
  answerSecurityHeaders, withoutFrameAncestors, responseHeaders, pathnameOf,
} = require('./headers');
const { isAncestorOrigin, embedHeaders, isHealthRead } = require('./headers');
const { proxyHttp, NOT_ANSWERING } = require('./http');
const { createAnswerPorts, PORT_MEMO_MS, PORT_TIMEOUT_MS } = require('./answer-ports');
const { probeHealthIdentity, createIdentityCheck, IDENTITY_TIMEOUT_MS } = require('./identity');
const { START_EVERY_MS, START_WAIT_MS } = require('./limits');
const { openUpstream, UPSTREAM_TIMEOUT_MS } = require('./ws-upstream');

module.exports = {
  // headers.js — the request allowlist, the X-WC-Remote label, the response hygiene
  FORWARD, HOP_BY_HOP, ANSWER_HEADER, forwardHeaders, isPreviewPath, securityHeaders,
  answerSecurityHeaders, withoutFrameAncestors, responseHeaders, pathnameOf,
  // headers.js — the embedded mode's ancestors check and the health embed headers (U712)
  isAncestorOrigin, embedHeaders, isHealthRead,
  // http.js — the streamed HTTP proxy
  proxyHttp, NOT_ANSWERING,
  // answer-ports.js — the answer surface's port, asked as a local caller
  createAnswerPorts, PORT_MEMO_MS, PORT_TIMEOUT_MS,
  // identity.js — step 6's one engine
  probeHealthIdentity, createIdentityCheck, IDENTITY_TIMEOUT_MS,
  // limits.js — the start rate limit
  START_EVERY_MS, START_WAIT_MS,
  // ws-upstream.js — the WebSocket's upstream half (early, pause/resume, the daemon's codes)
  openUpstream, UPSTREAM_TIMEOUT_MS,
};
