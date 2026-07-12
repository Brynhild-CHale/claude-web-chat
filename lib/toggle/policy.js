const scopes = require('./scopes');

const ALL_SCOPES = ['user', 'project', 'session'];

// Resolve effective disabled state. Most-restrictive-wins: any scope that
// reports disabled flips the whole resolution to disabled, and we return
// which scope was responsible.
//
// opts: { cwd, sessionId, scopes? (subset of ALL_SCOPES) }
function resolve(opts = {}) {
  const names = opts.scopes || ALL_SCOPES;
  for (const name of names) {
    const scope = scopes[name];
    if (!scope) continue;
    if (scope.isDisabled(opts)) {
      return { enabled: false, by: name };
    }
  }
  return { enabled: true };
}

module.exports = { resolve, ALL_SCOPES };
