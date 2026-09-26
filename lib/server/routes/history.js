// HTTP routes for pane history — the versions of one pane the page has shown on
// the way to the active node, and the user's "make current" that copies one back.
//
//   GET  /api/mounts/:id/history[?from=<node id>]
//        → { ok, id, from, versions:[{node_id, label, created_at, author, owner,
//            trigger_summary, spec_hash, current?}] }, newest first. Walks the
//        active node's ancestry (or `from`'s) — lib/server/domain/lineage.
//   POST /api/mounts/:id/restore {node_id, with_form?, after?}
//        → setMount's envelope. lib/server/domain/mounts restoreMount.
//
// The read-only render of one version is GET /preview/pane/:node/:mount, beside
// /preview/node in routes/graph.js (it is the same preview document).
const { computeLabels } = require('../graph');
const { mountHistory, findMount } = require('../domain/lineage');
const { restoreMount } = require('../domain/mounts');

function mountHistoryRoutes(app, { state, bus, graph }) {
  app.get('/api/mounts/:id/history', (req, res) => {
    const id = String(req.params.id);
    const from = req.query.from != null && req.query.from !== '' ? String(req.query.from) : graph.active;
    if (from != null && !graph.nodes.has(from)) return res.status(404).json({ error: 'node not found', from });
    // The live pane is a version only when the walk starts where the live
    // surface stands (the active node) — a walk from another node is that
    // node's history, and the live surface is not in it.
    const includeLive = from === graph.active;
    const versions = mountHistory(graph, {
      mountId: id,
      fromId: from,
      labels: computeLabels(graph),
      live: state.mounts.get(id) || null,
      includeLive,
    });
    res.json({ ok: true, id, from: from || null, versions });
  });

  // "Make current": copy one version's content into the live slot. A user write
  // like the × close, so it folds into the next commit; refused on a locked pane
  // and on any pane (or version) Claude does not own — see restoreMount.
  app.post('/api/mounts/:id/restore', (req, res) => {
    const id = String(req.params.id);
    const body = req.body || {};
    if (body.node_id == null || body.node_id === '') return res.status(400).json({ error: 'node_id required' });
    const node = graph.nodes.get(String(body.node_id));
    if (!node) return res.status(404).json({ error: 'node not found', node_id: String(body.node_id) });
    const version = findMount(node, id);
    if (!version || typeof version.html !== 'string') {
      return res.status(404).json({ error: `node ${node.id} has no pane '${id}'`, node_id: node.id, id });
    }
    const r = restoreMount(state, bus, { id, version, withForm: body.with_form === true, after: body.after });
    res.json(r.ok ? { ...r, restored_from: node.id } : r);
  });
}

module.exports = { mountHistoryRoutes };
