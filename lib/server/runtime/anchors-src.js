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
// Spliced only where it is needed, and only the kinds needed: a document
// carries it when its node carries records the resolver answers
// (carriesElements — DECISIONS.md I.2 C-confirm (2) and I.5 G4), cut to the
// sections those records' anchor kinds need (kindsOf; lib/core/anchors.js
// KIND_SECTIONS — PLAN.md 2A.7, condition C-05-1), so a preview, replay frame
// or export of a node without records keeps the bytes it had before the
// splice, and a comment-only node carries no range or source section.
//
// Memoized per kind-set, and read on first use, never at require time, so it
// adds nothing to the daemon's boot. Editing lib/core/anchors.js reflects in
// previews, replays and exports (and in /app/anchors.js) only after
// `claude-web-chat restart`.

const anchors = require('../../core/anchors');

// The resolver kinds, in KIND_SECTIONS' order (which is sorted: element, point,
// range, source): the kinds a document copy can be cut to. A kind's sections
// need not hold the ones before it (point's do not hold range's): closeKinds
// closes any set.
const RESOLVER_KINDS = Object.freeze(Object.keys(anchors.KIND_SECTIONS));

// A kind-set closed under the sections it needs (range needs the element
// sections, so ['range'] is ['element', 'range']), sorted, without repeats —
// the one key a kind-set is memoised and named by.
function closeKinds(kinds) {
  const sections = new Set();
  for (const k of kinds) for (const s of anchors.KIND_SECTIONS[k]) sections.add(s);
  return RESOLVER_KINDS.filter((k) => anchors.KIND_SECTIONS[k].every((s) => sections.has(s)));
}

function compact(src) {
  return src.split('\n')
    .map((line) => line.replace(/^[ \t]+/, ''))
    .filter((line) => line !== '' && !line.startsWith('//'))
    .join('\n');
}

// The kind-set a `{kinds}` argument names: every kind when omitted; refuses a
// kind outside the resolver's.
function kindSet(opts) {
  const kinds = opts && opts.kinds !== undefined ? opts.kinds : RESOLVER_KINDS;
  if (!Array.isArray(kinds)) throw new TypeError('anchors-src: {kinds} must be an array');
  for (const k of kinds) {
    if (!RESOLVER_KINDS.includes(k)) throw new TypeError(`anchors-src: no resolver kind ${k}`);
  }
  return closeKinds(kinds);
}

// The kind-set's key: its closed, sorted kinds joined by '+' ('' for none).
function kindKey(kinds) {
  return closeKinds(kinds).join('+');
}

const cached = new Map();
// source({kinds}) → the compacted document copy cut to those kinds ('' for an
// empty list); no argument: every kind, the whole factory.
function source(opts) {
  const kinds = kindSet(opts);
  const key = kinds.join('+');
  if (!cached.has(key)) cached.set(key, kinds.length ? compact(anchors.documentSource({ kinds })) : '');
  return cached.get(key);
}

// The resolver as a document splices it: its own <script> element, then the
// newline that separates it from the element after it ('' for an empty kind
// list). The ONE spelling of the element — the preview template's hole, the
// export and the replay payload's `anchors` all splice this string, so a filled
// replay frame is byte-equal to the node's preview.
function scriptElement(opts) {
  const src = source(opts);
  return src ? `<script>${src}</script>\n` : '';
}

// The anchor kind of a comment copy's anchor: a 0.8.5 locator ({mount,
// selector, text, ordinal}, no kind) and a converted pin-locator@1 are element
// anchors; an anchor naming its own kind is that kind. A page note (no anchor)
// has nothing to re-find.
function copyKind(c) {
  const a = c && c.anchor;
  if (!a || typeof a !== 'object') return null;
  return typeof a.kind === 'string' ? a.kind : 'element';
}

// THE field table: each node field that holds element records, and the anchor
// kinds one entry of it needs. Tranche 2's types plug in HERE (a new field, or
// a kindOf the caller binds), never as a call-site test.
//   comments  the 0.8.5 copies (lib/core/element-log.js maps them): copyKind.
//   elements  id@v references (E-STORE (a), 'h3@1'): kindOf(ref) when the
//             caller gives it, else every resolver kind — never under-spliced.
const FIELDS = [
  ['comments', (c) => [copyKind(c)]],
  ['elements', (ref, kindOf) => {
    const k = typeof kindOf === 'function' ? kindOf(ref) : null;
    return k == null ? RESOLVER_KINDS : [k];
  }],
];

// kindsOf(node, {kindOf}) → the sorted resolver kinds the node's records need,
// closed under KIND_SECTIONS ([] when it carries none). A kind outside the
// resolver's ('page' alone: a box grab's anchor never re-resolves) adds none;
// a point record adds point (['element', 'point']); a kindOf that cannot
// answer (null, undefined) adds every kind.
function kindsOf(node, { kindOf } = {}) {
  if (!node || typeof node !== 'object') return [];
  const want = new Set();
  for (const [field, kindsFor] of FIELDS) {
    const list = node[field];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      for (const k of kindsFor(entry, kindOf)) if (RESOLVER_KINDS.includes(k)) want.add(k);
    }
  }
  return closeKinds([...want]);
}

// Whether a node's document needs the resolver: true when the node carries a
// record of a resolver kind. THE one test of it — preview.js, export.js and
// the replay document all ask here, never a `comments.length` of their own,
// and decide on the node alone; which sections they splice is kindsOf's.
function carriesElements(node, opts) {
  return kindsOf(node, opts).length > 0;
}

module.exports = { source, scriptElement, carriesElements, kindsOf, kindKey, RESOLVER_KINDS, compact };
