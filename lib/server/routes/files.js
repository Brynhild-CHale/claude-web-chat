// The composer's `@` file search over HTTP (spec §6.2, U57).
//
//   GET /api/files?q=&limit=
//     behind ctx.audience.requireMirror('full') (§5.4; the portal's row is
//     lib/core/remote-policy's): a local viewer, or a remote one whose project
//     opted in at `full`. A pane may call it locally by design (§5.7, P0 read-
//     open: names only).
//     q      the query, at most Q_MAX characters (absent: the shallowest paths)
//     limit  1..LIMIT_MAX, default LIMIT_DEFAULT
//     → 200 {ok: true, files: [{path, bytes}], truncated, source: 'git'|'walk', indexed_at}
//     → 200 {ok: true, disabled: true, files: []} while the chat mirror is off
//     → 400 {ok: false, error} for a malformed q or limit
//     → 500 through routes/mirror's sendFailure, which never sends the error's
//       message
//
// The body is relative POSIX paths and their sizes: never a file's content
// (ruling Q5: a path is attached, not its content) and never an absolute path.
//
// THIN. The index is ctx.projectFiles (lib/server/project-files
// createProjectFiles), built once by lib/server/index.js so the queue's
// message route checks a message's files against the same listing the popover
// offered (notes-D, Q-D1). The query is parsed with routes/mirror-query's
// param and intIn, the one home of the mirror routes' parsers (U45b).

const { sendFailure } = require('./mirror');
const { param, intIn, isPlain, BadParam } = require('./mirror-query');
const { Q_MAX, LIMIT_DEFAULT, LIMIT_MAX } = require('../project-files');

const FILES_ROUTE = '/api/files';

// q: any single string up to Q_MAX characters (an empty one is the empty query).
function queryText() {
  const parse = (raw) => (raw.length <= Q_MAX ? raw : undefined);
  parse.expects = `at most ${Q_MAX} characters`;
  return parse;
}
const parseQ = queryText();
const parseLimit = intIn(1, LIMIT_MAX);

// Only {path, bytes} pairs of the right types leave the route.
function filesOf(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const f of list) {
    if (!isPlain(f) || typeof f.path !== 'string' || !Number.isFinite(f.bytes)) continue;
    if (f.path.startsWith('/')) continue;
    out.push({ path: f.path, bytes: f.bytes });
  }
  return out;
}

function mountFilesRoutes(app, ctx) {
  const audience = ctx && ctx.audience;
  if (!audience || typeof audience.requireMirror !== 'function') {
    throw new TypeError('mountFilesRoutes needs ctx.audience (lib/server/audience): requireMirror');
  }
  const files = ctx.projectFiles;
  if (!files || typeof files.search !== 'function') {
    throw new TypeError('mountFilesRoutes needs ctx.projectFiles (lib/server/project-files createProjectFiles)');
  }

  app.get('/api/files', audience.requireMirror('full'), async (req, res) => {
    let q;
    let limit;
    try {
      const query = req.query || {};
      q = param(query, 'q', parseQ, '');
      limit = param(query, 'limit', parseLimit, LIMIT_DEFAULT);
    } catch (e) {
      if (e instanceof BadParam) return res.status(400).json({ ok: false, error: e.message });
      return sendFailure(res, e, `GET ${FILES_ROUTE}`);
    }
    try {
      const mirror = ctx.mirror;
      // enabled() may answer at once or as a Promise.
      const on = mirror && typeof mirror.enabled === 'function' ? await mirror.enabled() : null;
      if (isPlain(on) && on.enabled === false) return res.json({ ok: true, disabled: true, files: [] });
      const r = await files.search(q, { limit });
      if (!isPlain(r)) throw new TypeError('the file index answered no object');
      return res.json({
        ok: true,
        files: filesOf(r.files),
        truncated: r.truncated === true,
        source: r.source === 'walk' ? 'walk' : 'git',
        indexed_at: Number.isFinite(r.indexed_at) ? r.indexed_at : null,
      });
    } catch (e) {
      return sendFailure(res, e, `GET ${FILES_ROUTE}`);
    }
  });
}

module.exports = { mountFilesRoutes, FILES_ROUTE };
