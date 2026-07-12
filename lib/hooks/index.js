const fs = require('fs');
const { projectPaths } = require('../core/paths');
const { resolve: resolveToggle } = require('../toggle/policy');
const { findProjectRoot } = require('../util/root');

const SUBCOMMANDS = {
  'turn-begin': require('./turn-begin'),
  'turn-end': require('./turn-end'),
};

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function logError(subcmd, err, root) {
  try {
    const base = root || process.cwd();
    const paths = projectPaths(base);
    if (!fs.existsSync(paths.dir)) return;
    const logFile = process.env.WEB_CHAT_HOOK_LOG || paths.hookLog;
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${subcmd} error: ${err.message}\n`);
  } catch {}
}

async function main() {
  const subcmd = process.argv[2];
  const fn = SUBCOMMANDS[subcmd];
  if (!fn) process.exit(0);

  const input = await readStdin();
  let payload = {};
  if (input.trim()) {
    try { payload = JSON.parse(input); } catch {}
  }

  // Anchor to the project root (nearest ancestor with .web-chat), not the
  // agent's possibly-cd'd cwd. Claude Code spawns hooks with cwd tracking the
  // agent's `cd`, so process.cwd() can point into a subdirectory.
  const root = findProjectRoot(payload.cwd || process.cwd());

  const decision = resolveToggle({ cwd: root || process.cwd(), sessionId: payload.session_id });
  if (!decision.enabled) process.exit(0);

  try {
    await fn(payload, { root });
  } catch (e) {
    logError(subcmd, e, root);
  }
  process.exit(0);
}

main();
