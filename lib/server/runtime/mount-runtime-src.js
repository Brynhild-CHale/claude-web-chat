// The server-side accessor for the shared mount runtime's TEXT. The server never
// executes the runtime (it's browser/DOM code) — it only splices the source
// verbatim into the export + preview HTML documents. This reads public/
// mount-runtime.js once and memoizes it, keeping assembleExport / renderPreviewHtml
// fs-free.
//
// Memoized: editing public/mount-runtime.js reflects in export/preview only after
// a server restart (the browser picks it up on refresh). See the file header.

const fs = require('fs');
const path = require('path');
const { PUBLIC_DIR } = require('../../core/paths');

let cached = null;
function source() {
  if (cached == null) cached = fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8');
  return cached;
}

module.exports = { source };
