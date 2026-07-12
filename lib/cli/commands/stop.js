const { findProjectRoot } = require('../../core/paths');
const portfiles = require('../../core/portfiles');

async function stop() {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    console.log('(no server running)');
    return;
  }
  const info = portfiles.readPortfile('server', { root });
  if (!info) {
    console.log('(no server running)');
    return;
  }
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch (e) {
    console.log(`(could not signal pid ${info.pid}: ${e.message})`);
    return;
  }
  const gone = await portfiles.waitUntilGone({ role: 'server', root, maxMs: 5000 });
  if (gone) {
    console.log(`web-chat server stopped (pid ${info.pid})`);
    return;
  }
  console.log(`(sent SIGTERM to pid ${info.pid}, but portfile still present — server may not have shut down cleanly)`);
}

module.exports = stop;
