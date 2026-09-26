// The server-side accessor for the page stylesheet's TEXT (public/page.css): how
// a page sequence is laid out — prose at reading width, each run of panes its
// own 12-column grid — and how its markdown reads. The live chrome links the
// file; the node preview (lib/server/preview.js) and the page export
// (lib/server/export.js) inline these same bytes, so the three draw a page one
// way. Read once and memoized, like mount-runtime-src.js beside it: an edit to
// the file reaches previews and exports after a server restart.

const fs = require('fs');
const path = require('path');
const { PUBLIC_DIR } = require('../../core/paths');

let cached = null;
function source() {
  if (cached == null) cached = fs.readFileSync(path.join(PUBLIC_DIR, 'page.css'), 'utf8');
  return cached;
}

module.exports = { source };
