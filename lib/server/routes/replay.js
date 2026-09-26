const { PREVIEW_CSP } = require('../../core/cors');
const { escapeHtml } = require('../../core/html');
const { resolveReplayPath } = require('../domain/replay-path');
const { buildReplay } = require('../replay/document');

// Replay. A replay plays one lineage of the graph, node by node, as the graph
// viewer draws it (domain/replay-path is the whole decision of WHICH nodes and
// what each one's caption says; this file is HTTP translation only).
//
//   GET /api/replay/path?from=&to=&include_collapsed=1
//        → { ok, from, to, from_default, steps[], skipped, truncated, total_steps }
//
// `from`/`to` take any node ref domain/refs resolves — a label (n1.7), a stored
// id, or `active` — except `live`: a replay is committed history. Both are
// optional: `to` defaults to the active node, `from` to the nearest bookmark at
// or above it (else the tree's root). Read-only, no side effects.
//
//   GET /replay?from=&to=&hold_ms=&pacing=&transition=&captions=&size=&chrome=
//        → the replay DOCUMENT (lib/server/replay/document.js): what the player
//          overlay iframes, and what a headless renderer seeks through.
//   GET /api/replay/html?…same
//        → the same document as an attachment, replay-<from>_<to>.html.
//
// The document runs every step's pane scripts, same-origin, exactly like the
// graph viewer's /preview/node documents — so it is served under the same
// PREVIEW_CSP (connect-src 'none'; its srcdoc frames inherit it), on every
// branch including the errors.
function mountReplayRoutes(app, { graph, paths }) {
  app.get('/api/replay/path', (req, res) => {
    const q = req.query || {};
    const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
    const r = resolveReplayPath(graph, {
      from: one(q.from) || undefined,
      to: one(q.to) || undefined,
      includeCollapsed: ['1', 'true'].includes(String(one(q.include_collapsed) || '')),
    });
    if (!r.ok) {
      const status = (r.code === 'not-found' || r.code === 'no-active') ? 404 : 400;
      return res.status(status).json({ error: r.error, code: r.code, which: r.which });
    }
    res.json(r);
  });

  app.get('/replay', (req, res) => {
    res.setHeader('Content-Security-Policy', PREVIEW_CSP);
    res.setHeader('Cache-Control', 'no-store');
    const r = buildReplay({ graph, paths }, req.query || {});
    if (!r.ok) {
      return res.status(r.status).type('text/html')
        .send(`<!doctype html><meta charset="utf-8"><title>replay</title><p>${escapeHtml(r.error)}</p>`);
    }
    res.type('text/html').send(r.html);
  });

  app.get('/api/replay/html', (req, res) => {
    const r = buildReplay({ graph, paths }, req.query || {});
    if (!r.ok) return res.status(r.status).json({ error: r.error, code: r.code, which: r.which });
    res.setHeader('Content-Security-Policy', PREVIEW_CSP);
    res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
    res.type('text/html').send(r.html);
  });
}

module.exports = { mountReplayRoutes };
