const fs = require('fs');
const { projectPaths, userPaths } = require('../../core/paths');
const { resolveRoot } = require('../../setup/registration');

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

function on(args, opts = {}) {
  const { scope, id } = parseScope(args);

  if (scope === 'user') {
    const marker = userPaths().disabled;
    if (fs.existsSync(marker)) {
      fs.unlinkSync(marker);
      console.log('web-chat re-enabled globally');
    } else {
      console.log('web-chat is not globally disabled');
    }
    return;
  }

  if (scope === 'session') {
    const sessionFile = userPaths().sessionFile(id);
    if (!fs.existsSync(sessionFile)) {
      console.log(`session ${id} is not disabled`);
      return;
    }
    fs.unlinkSync(sessionFile);
    console.log(`web-chat re-enabled for session ${id}`);
    return;
  }

  // project. The enclosing installed root, and a REFUSAL when there is none:
  // this used to anchor on process.cwd() with no guard at all, so in a
  // subdirectory (or a directory that was never installed) it printed the
  // reassuring "web-chat is not disabled for this project" — which is false
  // reassurance, not a no-op. `off` already refused; the pair now agrees.
  const { root } = resolveRoot(opts.cwd || process.cwd(), { mode: 'existing' });
  const marker = projectPaths(root).disabled;
  if (fs.existsSync(marker)) {
    fs.unlinkSync(marker);
    console.log(`web-chat re-enabled for project ${root}`);
  } else {
    console.log('web-chat is not disabled for this project');
  }
}

module.exports = on;
