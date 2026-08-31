const client = require('../mcp/client');
const portfiles = require('../core/portfiles');

// Injectable wall-clock probe budget — see the note on turn-begin's PROBE_MS.
const PROBE_MS = 500;

module.exports = async function turnEnd(_payload, ctx = {}) {
  const root = ctx.root || process.cwd();
  const info = portfiles.readPortfile('server', { root });
  if (!info) return;
  const reachable = await portfiles.probeReachable(info.port, Number.isFinite(ctx.probeMs) ? ctx.probeMs : PROBE_MS);
  if (!reachable) {
    // The server didn't answer the probe but the portfile points at a live pid,
    // so it may just be momentarily busy. A turn-begin acquired the lock; if we
    // bail outright the lock orphans for the full TTL and wedges the graph. Make
    // one best-effort unlock attempt instead (the server no-ops if there's no
    // lock). turn-end's commit is forfeit, but the surface stays navigable.
    try {
      await client.post('/api/unlock', {}, { port: info.port, root, noSpawn: true });
    } catch {}
    return;
  }
  // root + noSpawn for the same reason turn-begin passes them: a retry must never
  // resolve to another project's daemon (or spawn one there). See turn-begin.js.
  try {
    await client.post('/api/turn-end', { author: 'claude' }, { port: info.port, root, noSpawn: true });
  } catch (e) {
    if (e && e.code === 'NO_SERVER') return;
    throw e;
  }
};
