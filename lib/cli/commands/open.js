const { spawn } = require('child_process');
const { readPortfile, probeReachable } = require('../../core/portfiles');
const { findProjectRoot, projectPaths } = require('../../core/paths');
const { spawnDaemonProcess, waitForPortfile } = require('../../util/daemon');

function browserCommand() {
  if (process.platform === 'darwin') return { cmd: 'open', args: [] };
  if (process.platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', ''] };
  return { cmd: 'xdg-open', args: [] };
}

function launchBrowser(url) {
  const { cmd, args } = browserCommand();
  try {
    const child = spawn(cmd, [...args, url], { stdio: 'ignore', detached: true });
    child.unref();
  } catch (e) {
    console.error(`(could not launch browser: ${e.message})`);
    console.log(`open this URL manually: ${url}`);
  }
}

async function open() {
  const root = findProjectRoot(process.cwd()) || process.cwd();
  const paths = projectPaths(root);

  const existing = readPortfile('server', { root });
  if (existing) {
    const reachable = await probeReachable(existing.port, 500);
    if (reachable) {
      console.log(`web-chat server already running at ${existing.url}`);
      launchBrowser(existing.url);
      return;
    }
  }

  // Spawn detached daemon
  spawnDaemonProcess(root);
  const logFile = paths.serverLog;

  const info = await waitForPortfile(paths.dir, 8000);
  if (!info) {
    console.error(`web-chat server failed to start within 8s — check ${logFile}`);
    process.exit(1);
  }

  console.log(`web-chat server started at ${info.url} (pid ${info.pid})`);
  launchBrowser(info.url);
}

module.exports = open;
