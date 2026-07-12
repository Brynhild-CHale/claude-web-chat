const { readPortfile, waitUntilGone } = require('../../core/portfiles');
const { findProjectRoot } = require('../../core/paths');

async function restart() {
  const root = findProjectRoot(process.cwd()) || process.cwd();
  const info = readPortfile('server', { root });

  if (info) {
    try {
      process.kill(info.pid, 'SIGTERM');
      console.log(`stopped daemon (pid ${info.pid})`);
    } catch {
      console.log(`(portfile pointed at pid ${info.pid}, but no such process — was stale)`);
    }
    // Wait for graceful shutdown to delete portfile and persist draft.
    await waitUntilGone({ role: 'server', root, maxMs: 10_000 });
  } else {
    console.log('(no server running)');
  }

  await require('./start')(['--daemon']);
}

module.exports = restart;
