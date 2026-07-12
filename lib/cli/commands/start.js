const fs = require('fs');
const { findProjectRoot } = require('../../util/root');
const { projectPaths } = require('../../core/paths');
const { readPortfile, probeReachable, waitUntilReachable } = require('../../core/portfiles');
const { spawnDaemonProcess } = require('../../util/daemon');

async function start(args) {
  const daemon = args.includes('--daemon') || args.includes('-d');

  if (!daemon) {
    const root = findProjectRoot(process.cwd()) || process.cwd();
    const srv = require('../../server').createServer({ root });
    await srv.start();
    srv.installSignalHandlers();
    return;
  }

  const root = findProjectRoot(process.cwd()) || process.cwd();
  const paths = projectPaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const logFile = paths.serverLog;

  const existing = readPortfile('server', { root });
  if (existing) {
    const reachable = await probeReachable(existing.port, 500);
    if (reachable) {
      console.error(`already running at ${existing.url} (pid ${existing.pid}) — use \`claude-web-chat restart\` to bounce it`);
      process.exit(1);
    }
  }

  const child = spawnDaemonProcess(root);

  // Wait for the daemon to bind and answer so we can report the URL.
  const info = await waitUntilReachable({ role: 'server', root });
  if (info) {
    console.log(`web-chat server started as daemon at ${info.url} (pid ${info.pid}, log ${logFile})`);
    return;
  }
  console.log(`web-chat server spawned (pid ${child.pid}, log ${logFile}) — portfile not yet visible`);
}

module.exports = start;
