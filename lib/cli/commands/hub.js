const { createHub } = require('../../hub');
const {
  hubPort,
  probeHubHealth,
  ensureHub,
} = require('../../util/hub');

async function hub(args) {
  const sub = args[0] || 'status';

  if (sub === 'run') {
    // Foreground: this is what the detached daemon execs.
    const h = createHub();
    h.installSignalHandlers();
    await h.start();
    return;
  }

  if (sub === 'start') {
    const info = await ensureHub();
    if (info) console.log(`web-chat hub running at ${info.url}`);
    else { console.error('hub failed to start — check ~/.web-chat/hub.log'); process.exit(1); }
    return;
  }

  if (sub === 'stop') {
    // Pid from the hub's own /api/health, not a portfile — the live process is
    // authoritative. The hub's SIGTERM handler clears its own registry entry.
    const port = hubPort();
    const health = await probeHubHealth(port);
    if (!health || health.role !== 'hub') { console.log('hub not running'); return; }
    if (health.pid) { try { process.kill(health.pid, 'SIGTERM'); } catch {} }
    console.log(`hub stopped (pid ${health.pid})`);
    return;
  }

  if (sub === 'status') {
    const port = hubPort();
    const health = await probeHubHealth(port);
    if (health && health.role === 'hub') console.log(`hub: running on http://localhost:${port}${health.pid ? ` (pid ${health.pid})` : ''}`);
    else console.log(`hub: not running (would use port ${port})`);
    return;
  }

  console.error(`unknown hub subcommand: ${sub} (use start|stop|status|run)`);
  process.exit(1);
}

module.exports = hub;
