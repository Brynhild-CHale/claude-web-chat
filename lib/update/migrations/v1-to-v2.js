const fs = require('fs');
const path = require('path');

// v1 → v2: delete the orphaned server.pid.
//
// Early builds wrote a bare `<root>/.web-chat/server.pid` beside server.json;
// nothing reads or writes it anymore (the pid lives inside server.json, minted by
// core/portfiles). It is project-scoped with no reader, so removing it can't
// straddle a running process. Idempotent: a missing file is a no-op, and any
// unlink error is swallowed so a permission-locked orphan never wedges boot — the
// file is inert junk either way.
module.exports = function v1ToV2(stateDir) {
  try { fs.unlinkSync(path.join(stateDir, 'server.pid')); } catch {}
};
