// /api/comments is GONE (U327a; PLAN 2C.4, ruling COMMENTS@alias b): the
// comment's routes moved to the element API (lib/server/routes/elements.js,
// type 'comment'), replaced outright — no alias, no removal item. The
// get_comments and reply_comment tools and the chrome read and write there
// now; the respond-to-comment skill names the tools, never a route.
//
// What is left here is the refusal a caller of the OLD paths gets: a Claude
// Code session that loaded the web-chat tools before the upgrade keeps calling
// /api/comments until it is reopened (lib/mcp/* loads once, at session start).
// Every method on /api/comments and everything below it answers
//
//   410 {ok: false, error: 'gone', code: 'comments-route-replaced', hint}
//
// JSON, so that session's tool result prints the hint verbatim
// (lib/mcp/index.js's `Error: <method> <path> → <status>: <body>`), and not a
// 404, which lib/mcp/skew.js reads (as a non-JSON 404) for a daemon older than
// the tools — the opposite drift, with the opposite fix.
//
// No level check: the refusal carries nothing. A protocol-12 portal refuses
// /api/comments itself (one row, its hint naming the element API; K.4); an
// older portal lets it through and this 410 answers.

const COMMENTS_GONE = Object.freeze({
  ok: false,
  error: 'gone',
  code: 'comments-route-replaced',
  hint: 'web-chat\'s comment API moved to /api/elements. This Claude Code session loaded the web-chat tools before the upgrade: tell the user to /exit and reopen Claude Code.',
});

function mountCommentsGone(app) {
  // app.use matches /api/comments and every path below it, for every method.
  app.use('/api/comments', (req, res) => {
    res.status(410).json(COMMENTS_GONE);
  });
}

module.exports = { mountCommentsGone, COMMENTS_GONE };
