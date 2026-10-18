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
// Spliced only where it is needed: a document carries it when its node carries
// element records (carriesElements below — DECISIONS.md I.2 C-confirm (2) and
// I.5 G4: the factory's share of the typical export read over B3's 5% line), so
// a preview, replay frame or export of a node without records keeps the bytes
// it had before the splice.
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

// The resolver as a document splices it: its own <script> element, then the
// newline that separates it from the element after it. The ONE spelling of the
// element — the preview template's hole, the export and the replay payload's
// `anchors` all splice this string, so a filled replay frame is byte-equal to
// the node's preview.
function scriptElement() {
  return `<script>${source()}</script>\n`;
}

// Whether a node's document needs the resolver: true when the node carries
// element records. THE one test of it — preview.js, export.js and the replay
// document all ask here, never a `comments.length` of their own, and decide on
// the node alone. In tranche 1 a node's element records are its pins
// (node.comments, the copies lib/core/element-log.js maps); tranche 2's element
// types add their own field HERE, and nowhere else.
function carriesElements(node) {
  return !!node && Array.isArray(node.comments) && node.comments.length > 0;
}

module.exports = { source, scriptElement, carriesElements };
