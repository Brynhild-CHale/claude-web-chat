// The code revert's one route on the main origin (spec §15.3 "Gates and
// actions", §5.3's `GET /api/code/preview` row at level read, §5.7 P0): the
// preview of a restore, a READ. Restoring and undoing are control actions on
// the answer origin (lib/server/control/revert.js, through U81's action table)
// and never a route here: no acting control route is pane-callable (C46).
//
//   GET /api/code/preview?turn=<id>|node=<ref>[&point=before|after]
//     → 200 {ok: true, preview_id, target: {turn_id, node_id, label, point,
//            conversation_id, at}, written: [{path, status}], deleted: [path],
//            notCovered: [{path, reason}], headMoved, counts: {rewritten,
//            recreated, deleted, not_covered}, blocked: null|{reason, hint},
//            notes}
//     Exactly one of `turn` and `node` (neither, both, an empty or repeated
//     value → 400); `point` before (the default) or after, else 400; a value
//     over ID_MAX characters → 404, as the mirror's routes answer one.
//     400 {ok: false, error}                         a bad query
//     404 {ok: false, refused: 'no-record', hint}    the turn changed no files,
//                                                    or its record is not ready
//     404 {ok: false, refused: 'unknown', hint}      no such node
//     410 {ok: false, refused: 'tree-missing', hint} the snapshot was pruned
//     429 {ok: false, refused: 'rate_limited', hint} another preview within 1 s
//     503 {ok: false, unavailable: true, reason}     revert cannot serve here
//                                                    (diffs-off, not-a-git-repo,
//                                                    git-too-old, …; or no
//                                                    control domain / revert)
//     409 {ok: false, refused, hint}                 any other refusal
//
// Behind ctx.audience.requireMirror('read') (P0, §5.7): a remote viewer below
// read, and every network peer, gets the audience's 403 and hint. The portal's
// table (lib/core/remote-policy) allows the route at read and refuses every
// other /api/code/* method and path first.
//
// The query through routes/mirror-query's parsers (param, oneOf, notBoth,
// idParam — never a private BadParam). The body through the redactor as the
// diffs are (§5.5): redactHostPaths(ctx.redactor.value(body), {root}) — a
// secret in a file name is masked, the project root shown as <project>.
//
// Mounted by U66a (lib/server/index.js); test/code-routes.test.js mounts it on
// a bare Express app with a fake ctx.

const { redactHostPaths } = require('../../core/paths');
const { BadParam, NotFound, param, oneOf, notBoth, idParam, NOT_FOUND } = require('./mirror-query');

const POINT = oneOf(['before', 'after']);

const STATUS = Object.freeze({
  'bad-target': 400,
  'no-record': 404,
  unknown: 404,
  'tree-missing': 410,
  rate_limited: 429,
});

// The query: exactly one of turn and node, and point.
function previewQuery(q) {
  notBoth(q, 'turn', 'node', 'a preview is of a turn or of a node');
  const turn = idParam(q, 'turn');
  const node = idParam(q, 'node');
  if (turn === undefined && node === undefined) throw new BadParam('turn: exactly one of turn and node');
  const point = param(q, 'point', POINT, 'before');
  return turn !== undefined ? { turn, point } : { node, point };
}

function mountCodeRoutes(app, ctx) {
  const audience = ctx && ctx.audience;
  if (!audience || typeof audience.requireMirror !== 'function') {
    // Fail at boot rather than serve the working tree's lists with no gate.
    throw new TypeError('mountCodeRoutes needs ctx.audience (lib/server/audience): requireMirror');
  }
  if (!ctx.redactor || typeof ctx.redactor.value !== 'function') {
    // Never a body whose paths skipped the redactor.
    throw new TypeError('mountCodeRoutes needs ctx.redactor (lib/core/redact createRedactor)');
  }
  const gate = audience.requireMirror('read');
  const out = (body) => redactHostPaths(ctx.redactor.value(body), { root: ctx.root || null });

  app.get('/api/code/preview', gate, async (req, res) => {
    let q;
    try {
      q = previewQuery(req.query || {});
    } catch (e) {
      if (e instanceof BadParam) return res.status(400).json({ ok: false, error: e.message });
      if (e instanceof NotFound) return res.status(404).json(NOT_FOUND);
      return res.status(400).json({ ok: false, error: 'bad query' });
    }
    const control = ctx.control;
    const revert = control && typeof control.use === 'function' ? control.use('revert') : null;
    if (!revert || typeof revert.preview !== 'function') {
      return res.status(503).json({ ok: false, unavailable: true, reason: control ? 'not-installed' : 'no-control' });
    }
    let answer;
    try {
      answer = await revert.preview(q);
    } catch {
      // Never the error's message: it may carry a path.
      return res.status(500).json({ ok: false, error: 'the preview failed' });
    }
    if (!answer || typeof answer !== 'object') return res.status(500).json({ ok: false, error: 'the preview failed' });
    if (answer.ok === true) return res.json(out(answer));
    if (answer.unavailable === true) {
      return res.status(503).json(out({ ok: false, unavailable: true, reason: typeof answer.reason === 'string' ? answer.reason : 'unavailable' }));
    }
    const refused = typeof answer.refused === 'string' ? answer.refused : 'failed';
    return res.status(STATUS[refused] || 409).json(out({ ok: false, refused, hint: typeof answer.hint === 'string' ? answer.hint : 'refused' }));
  });
}

module.exports = { mountCodeRoutes, previewQuery };
