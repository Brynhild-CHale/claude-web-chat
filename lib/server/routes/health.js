const { PROTOCOL_VERSION } = require('../../core/versions');

// Lightweight liveness endpoint. Used by `probeReachable`, the `doctor` command,
// and the MCP client's auto-spawn retry to confirm a daemon is up and to surface
// just enough state (active node, node count, lock) to diagnose a wedged graph
// without pulling the full graph payload.
//
// `role`/`version` mirror the hub's health shape so the same protocol self-heal
// generalizes: probeHub keys on role==='hub', so an instance advertising
// role:'instance' is never mistaken for one.
function mountHealthRoutes(app, { graph, bus }) {
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      role: 'instance',
      version: PROTOCOL_VERSION,
      pid: process.pid,
      active: graph.active,
      nodes: graph.nodes.size,
      lock: graph.lock,
      // The daemon's per-boot token. The channel bridge reads it at connect BEFORE
      // choosing its reconnect cursor: a changed token means the
      // seq space reset, so it must full-replay instead of resuming a dead cursor.
      boot: bus ? bus.bootId : null,
    });
  });
}

module.exports = { mountHealthRoutes };
