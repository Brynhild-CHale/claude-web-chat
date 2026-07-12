const client = require('../mcp/client');
const portfiles = require('../core/portfiles');

module.exports = async function turnEnd(_payload, ctx = {}) {
  const info = portfiles.readPortfile('server', { root: ctx.root || process.cwd() });
  if (!info) return;
  const reachable = await portfiles.probeReachable(info.port, 500);
  if (!reachable) {
    // The server didn't answer the probe but the portfile points at a live pid,
    // so it may just be momentarily busy. A turn-begin acquired the lock; if we
    // bail outright the lock orphans for the full TTL and wedges the graph. Make
    // one best-effort unlock attempt instead (the server no-ops if there's no
    // lock). turn-end's commit is forfeit, but the surface stays navigable.
    try {
      await client.post('/api/unlock', {}, { port: info.port, noSpawn: true });
    } catch {}
    return;
  }
  try {
    await client.post('/api/turn-end', { author: 'claude' }, { port: info.port });
  } catch (e) {
    if (e && e.code === 'NO_SERVER') return;
    throw e;
  }
};
