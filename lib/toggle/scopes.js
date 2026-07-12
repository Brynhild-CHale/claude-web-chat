const fs = require('fs');
const { projectPaths, userPaths } = require('../core/paths');

// Each scope exposes isDisabled(opts) returning true/false.
// opts can carry: cwd (defaults to process.cwd()), sessionId.

const user = {
  name: 'user',
  marker() { return userPaths().disabled; },
  isDisabled() {
    return fs.existsSync(this.marker());
  },
};

const project = {
  name: 'project',
  dir(opts = {}) { return projectPaths(opts.cwd || process.cwd()).dir; },
  marker(opts = {}) { return projectPaths(opts.cwd || process.cwd()).disabled; },
  isDisabled(opts = {}) {
    const d = this.dir(opts);
    if (!fs.existsSync(d)) return true; // not installed in this project = silent no-op
    return fs.existsSync(this.marker(opts));
  },
};

const session = {
  name: 'session',
  sessionFile(opts = {}) {
    if (!opts.sessionId) return null;
    return userPaths().sessionFile(opts.sessionId);
  },
  isDisabled(opts = {}) {
    const f = this.sessionFile(opts);
    if (!f || !fs.existsSync(f)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      return data.enabled === false;
    } catch {
      return false;
    }
  },
};

module.exports = { user, project, session };
