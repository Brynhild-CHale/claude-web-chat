const { resolveReplayPath } = require('../domain/replay-path');

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
function mountReplayRoutes(app, { graph }) {
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
}

module.exports = { mountReplayRoutes };
