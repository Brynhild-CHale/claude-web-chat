// The server-side accessor for the anchor resolver's DOCUMENT copy (annotation
// engine, PLAN.md 1C.1): the text every node preview, replay frame and export
// carries in its own <script>, right after the shared mount runtime, so the
// factory installs window.__wcMount.anchor in each of them — the same code the
// live chrome imports from GET /app/anchors.js (lib/server/routes/page.js). The
// server never executes it; it only splices the source.
//
// Compacted: lib/core/anchors.js documentSource() with whole-line `//` comments,
// blank lines and leading indentation dropped, so the bytes each document
// carries stay small (DECISIONS.md B3: overlay code under 5% of a typical
// export). The line rule is safe because the factory's authoring rules (the
// head of lib/core/anchors.js, scanned by test/anchors.test.js) allow comments
// only on whole lines, never a block comment, and ES5 has no multi-line string;
// test/anchors-served.test.js holds the compacted copy's answers equal to the
// full one's.
//
// Memoized, and read on first use, never at require time, so it adds nothing to
// the daemon's boot. Editing lib/core/anchors.js reflects in previews, replays
// and exports (and in /app/anchors.js) only after `claude-web-chat restart`.

const anchors = require('../../core/anchors');

function compact(src) {
  return src.split('\n')
    .map((line) => line.replace(/^[ \t]+/, ''))
    .filter((line) => line !== '' && !line.startsWith('//'))
    .join('\n');
}

let cached = null;
function source() {
  if (cached == null) cached = compact(anchors.documentSource());
  return cached;
}

module.exports = { source };
