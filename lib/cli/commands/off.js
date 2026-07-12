const fs = require('fs');
const { projectPaths, userPaths } = require('../../core/paths');

function parseScope(args) {
  if (args.includes('--global')) return { scope: 'user' };
  const sessionArg = args.find(a => a.startsWith('--session='));
  if (sessionArg) return { scope: 'session', id: sessionArg.slice('--session='.length) };
  if (args.includes('--session')) {
    const id = process.env.CLAUDE_SESSION_ID;
    if (!id) {
      console.error('--session requires --session=<id> (or CLAUDE_SESSION_ID env var)');
      process.exit(1);
    }
    return { scope: 'session', id };
  }
  return { scope: 'project' };
}

function off(args) {
  const { scope, id } = parseScope(args);

  if (scope === 'user') {
    const u = userPaths();
    fs.mkdirSync(u.root, { recursive: true });
    fs.writeFileSync(u.disabled, '');
    console.log('web-chat disabled globally (~/.web-chat/disabled)');
    return;
  }

  if (scope === 'session') {
    const u = userPaths();
    fs.mkdirSync(u.sessionsDir, { recursive: true });
    fs.writeFileSync(u.sessionFile(id), JSON.stringify({ enabled: false, ts: Date.now() }, null, 2));
    console.log(`web-chat disabled for session ${id}`);
    return;
  }

  // project
  const root = process.cwd();
  const p = projectPaths(root);
  if (!fs.existsSync(p.dir)) {
    console.error(`no .web-chat/ in ${root} — run \`claude-web-chat install\` first`);
    process.exit(1);
  }
  fs.writeFileSync(p.disabled, '');
  console.log(`web-chat disabled for project ${root}`);
}

module.exports = off;
