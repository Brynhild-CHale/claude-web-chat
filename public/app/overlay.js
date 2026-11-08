// The element overlay (annotation engine 2A.1, 3C.1): a registry of HOSTS,
// each drawing the anchored elements it holds into a body-level layer of its
// own at its rung of the z ladder, from the resolver's (or its own place's)
// answers, clipped to what its well actually shows. The page well is the
// FIRST host of the registry: initOverlay registers it ('page') before any
// other, on #main, its layer #el-layer at --z-pins. It is the one home of the
// overlay concept (PLAN.md §0's engines rule): the element types (comment,
// highlight, box grab), the hidden-state probe, the report batching, the
// input-mode policy, the tool arming, the orphan stand-in and every later
// host (the chat's, the graph inspector's turn list: registerHost) all plug in
// through the seams below, never by editing this file.
//
// What the page draws. Two element sets, 'live' and 'preview'; the one the
// page host draws is the one matching view.previewing. 'live' is filled from the hello and reset
// frames' `elements` (with the frame's `surface` counter kept beside it); a
// later unit relays incremental element frames through setElements /
// upsertElements / removeElements. 'preview' is filled from the previewed
// node (topbar.js previewNode emits bus 'preview:node'): its `lean_elements`
// (the daemon's projection of the node's 0.8.5 comment copies, anchors already
// in the resolver's form) and its `elements` id@v references, held as pending
// rows that draw nothing until a later unit hands their anchors back through
// upsertElements('preview', …). The chrome converts no 0.8.5 locator: every
// anchor reaches it already in the resolver's form.
//
// How it resolves. One anchors.watch() per mount that has element or range
// rows in the drawn set: the resolver's one settle listener turns a pane's
// settle into a coalesced pass against its cached index (PLAN.md §7 items 2
// and 3), and a set change starts one resolveAll pass per touched mount (the
// same cached index). A source row (an anchor on a markdown item) is resolved
// by resolveSource over the item's current page text and its sourceMap, on a
// markdown frame, after the hello / reset applier and on a set change, in a
// frame of its own. resolve() is never called per record.
//
// How it draws. An answer delivered by the resolver is only STORED here and a
// draw frame is asked for, so the overlay's box reads never share the
// resolver's delivering frame (condition C-05-3). A draw frame reads boxes for
// at most the budget (10 ms, the resolver's) and carries the rest to the next
// frame — its look-ahead is THIS frame's own cost per group (the costliest
// after its first, which pays any layout flush), never a figure kept across
// frames, so one slow read never throttles the frames after it; a frame reads
// every box of its slice before it writes any marker style; markers are rebuilt only when the drawn set's signature changes and
// otherwise moved (comments.js's F11 rule). Each frame is reported on bus
// 'overlay:frame' and summed in stats().
//
// The clip (S-1). A marker is drawn only when its anchor point lies inside the
// intersection of the viewport, its host's well's box (#main for the page) and
// the client box of
// every overflow-clipping ancestor from the anchor up through each shadow host
// (getRootNode().host); the glyph's own box — the anchor point plus the
// marker's transform offset and size, both written inline from the type's
// glyph, so the clip reads exactly what is drawn — is clipped to that
// intersection with clip-path, so no part of a glyph paints over the rail,
// the minbar or the bottom bar.
//
// THE PAGE ARM (U614, plan 5A.2; REQ@ink-scope-v2 b+). A stroke's PAGE
// RECORD (lib/core/strokes.js) is no resolver row — placeOf answers null for
// it, so no watch, pass or answer ever names one (C5's honesty) — and is
// placed beside the resolver paths by its ITEMS: one group per (type,
// from.item, to.item), its box the union of its members' boxes mapped by THE
// ONE MAPPING (mapPage) over the endpoint items' current rects, a box marker in
// #el-layer that never takes a press; its clip starts at the well
// (.well-wrap), and a displayed frame masks it, never hides it whole
// (PAGE@mask-frames); orphans() lists it with kind 'page' when its items go,
// faded at its guess when one of an arrow's goes or, below 760 px, for a margin
// stroke; a draw's record(id) reads it mapped into the group's box
// (pageRecordView, through element-types.js recordOf). The page host's
// listeners sit on the .well-wrap, so a strokes type's press reaches the
// gutters (REQ@margins a), every other tool keeping #main's reach. A
// ResizeObserver on box targets (and page groups' items) re-places a stroke
// whose target resizes alone. The full rules: THE PAGE ARM's section below.
//
// The hosts (3C.1, R2 §3 'a host registry: one overlay layer per host at its
// rung'). registerHost(name, {root, well, rung, kinds, place, hidden?,
// settle?, animates?, glyph?}) → unregister. A row whose anchor kind a host lists in
// `kinds` is that host's, never the page resolver's; one row may be several
// hosts' (a chat pin drawn in the dock and listed in the turn list), so a
// host's answers are kept per (host, id), apart from the page's. A host's rows
// live in the 'live' set and are drawn whatever view.previewing says (a chat
// pin is not a node's content, C1): a preview, a hello or reset frame, a Wipe
// or New graph swap the page's rows only. A host is marked dirty at its
// registration, by its settle and by a mutation under its root; the next draw
// frame re-places each dirty host's rows ONCE — place(row) (DOM queries only,
// no box read), then hidden(), then DRAW_RULES — and a scroll or a resize only
// re-measures. THE SETTLE SOURCES (U432a, C-3C-1): what moves a well with no
// mutation, scroll or resize — an animation or transition of an element the
// host names in `animates` (the dock's cd-pop and cd-slide, the sheet's pull)
// re-measures every frame while it runs and re-places the host once when the
// last one ends, so a marker and its clip-path are read from the at-rest
// geometry; and a ResizeObserver on every well a group was clipped to (#main
// the first) asks for one draw when a well's box changes size. Its layer is #el-layer-<name> (class el-host-layer) at
// var(<rung>), appended to <body> after #stage, so it paints over its host and
// under every panel; its well (an element, or fn(group) for a host whose rows
// sit in two scroll boxes) takes #main's place in the clip. THE NEVER-DRAW
// RULE: a frame is never a host (an iframe root or well, or one in another
// document, is refused), and no layer paints a glyph over a displayed iframe
// (each draw frame's census: the document's iframes, and for the page those
// in the shadow root of each pane holding a group). Answers, reports and
// orphans() are the page's alone: a host's state is the daemon's (D5).
//
// THE DETACHABLE GLYPH (U587, H.7; DECISIONS L.1 M4 a, K.2-151; RULED
// U587@glyph-offset-store AI5 a). A type registered with `detach: {leader}`
// (element-types.js passes it from element.json's `glyph: {detach: true}`;
// the built-in comment adopts it first) gets its glyph dragged off its anchor
// by the ENGINE — never by a pack, whose draw never sees layout — through a
// listener on the page layer under the input-mode policy's pointer reading
// (input-mode.js pointerTypeOf, never a second table): a pen or a mouse drags
// once it travels past TAP_SLOP (a press that does not still clicks: the
// thread opens); a finger drags only after a press-and-hold (GLYPH_HOLD_MS)
// while it stays within the slop, so a pan that starts at once is never
// stolen — the browser keeps it. A drag starts through the tray action guard
// (element-types.js trayAction: a previewed node refuses it with
// READONLY_HINT and nothing is written); its drop is the one write this file
// makes — POST /api/elements/:id/glyph {dx, dy, corner} through http.js, per
// element of the group — and the click that follows a drag is the drag's.
// THE OFFSET (a row's `display.glyph`, the version's display sibling) is CSS
// px from the corner of the anchor's box (its rect; a point's point) nearest
// the drop, so the glyph follows its anchor through a re-layout; the glyph is
// placed, clipped and kept off a frame by the same rules as an attached one,
// at its offset point. THE LEADER is one <svg class="el-leader"> per detached
// group, drawn under the markers from the nearest edge of the anchor's box to
// the glyph, its box the group's clip and its line clipped to it, hidden when
// it would cross a displayed frame; its style ('dotted', 'faint', 'hover':
// GLYPH_LEADERS) is the type's (read per draw: the tool's setting), and it
// collapses to 'hover' past LEADER_PANE_MAX detached glyphs on one pane or
// with the glyph within LEADER_NEAR_PX of its anchor. 'hover' draws it only
// while the glyph or its anchor is hovered, or after a tap on the glyph on
// touch. A carried guess keeps its offset at the guess, its leader styled
// as an orphan. A box group never detaches; no layer or placement mode is
// added (HOST_NAMES unchanged), and the look is app.css's tokens.
// THE GLYPH CLAMP (U631, plan 5B.1; corrects U587; RULED U631@refusal-feedback
// I3 a). A drag keeps the glyph's painted box inside the clip it was last
// drawn in (clampedOffset: the clip placeLeader keeps as lastClip — the pane
// well ∩ the viewport for a pane anchor, the page well for a markdown item's),
// its anchor point inside it too (measureGroup's own start test); a drop whose
// LAST measure was 'framed' or 'clipped' (applyGroup's lastRes) writes
// nothing: the glyph is drawn back at its stored offset, and bus
// 'overlay:glyph-refused' {id, hint: GLYPH_DROP_HINT} is emitted per element
// (commitMove's shape) — the glyph drawn back is the feedback, no notice.
// THE PHONE PIN (U629, plan 5B.7; RULED U614@phone-margin-pin H2 b). Below
// 760 px a shared margin ('beside') stroke group whose picture is ready is
// drawn as one glyph marker with the comment pin's look, and its tap opens the
// picture with and without the ink; the full rules: its section below. Its
// one read is GET picturePath(id) (and the pair's two <img>); it never posts.
//
// It makes no other network call, sends no report (U314's, through
// onAnswers), and assigns `hidden` only through the probe seam (U303's). Previews are
// read-only (D2): no create and no pick runs while previewing. Tranche 2 draws
// in the live chrome only (F-DOCS (a)): a preview, export or replay document
// draws no element.
import { bus } from './bus.js';
import { view, $ } from './state.js';
import { page } from './page.js';
import { onFrame, onHello } from './ws.js';
import { sourceMap } from './markdown.js';
import anchors from './anchors.js';
import { hiddenProbe, installRetriggers } from './overlay-hidden.js';
// How a tool takes the pointer routed to it (capture, cancel its default) is
// the input-mode policy's answer, never a rule of this file's. input-mode.js
// imports this module too: the cycle is safe because neither reads the other's
// bindings while it evaluates (dispatchMode is read only inside onPointer).
import { dispatchMode, pointerTypeOf } from './input-mode.js';
import { isTap } from './sheet-model.js';
import { request } from './http.js';
import { settingsSnapshot } from './toolbar-state.js';
// The page arm (U614): the one page stroke record and its one mapping
// (lib/core/strokes.js, served at /app/strokes.js), and the narrow answer.
import { isPageRecord, pageShape, mapPage, reboxPoints, isStrokePayload, frameKindOf } from './strokes.js';
import { isNarrow } from './viewport.js';
import { effectiveMode } from './theme.js';

// ── the vocabulary ──────────────────────────────────────────────────────────
// The states come from the one vocabulary (lib/core/anchor-states, carried by
// the resolver's module), never spelled as a bare literal here.
function stateOf(name) {
  if (!anchors.STATES || anchors.STATES.indexOf(name) < 0) throw new Error(`overlay: the state vocabulary has no ${name}`);
  return name;
}
const EXACT = stateOf('exact');
const RE_RESOLVED = stateOf('re-resolved');
const ORPHANED = stateOf('orphaned');
const HIDDEN = stateOf('hidden');
// L4's drawn states (RULED REQ@visible-states): a host's answers carry them
// (the daemon's, U414 / U416); the page resolver never answers one. A page
// row reads MASKED only when the daemon served its record masked
// (servedAnswerOf, U415d).
const MASKED = stateOf('masked');
const SUPERSEDED = stateOf('superseded');
const INDEXING = stateOf('indexing');
const UNAVAILABLE = stateOf('unavailable');

export const DEFAULT_BUDGET_MS = 10;
export const SCOPES = Object.freeze(['live', 'preview']);
// The input kinds a tool registers (U335's manifest field `taps | strokes |
// selection`, K.2-6). A `taps` tool gets the gesture's click; a `strokes` or
// `selection` tool gets every event of the gesture (input.phase names it).
export const INPUT_KINDS = Object.freeze(['taps', 'strokes', 'selection']);
// The placement modes a type registers (U516, plan 4A.2; the manifest field
// `place`, lib/packs/elements.js PLACE_MODES, held equal by a test): 'glyph'
// (the default) puts a glyph-sized marker at its anchor's top-left; 'box'
// sizes the marker of an element row's group to the target's own rect (the
// guess's, for a guess), clipped to its well, never over a displayed frame.
export const PLACE_MODES = Object.freeze(['glyph', 'box']);
// THE BLEND PER MARKER PART (U624; HIGHLIGHTER@blend-seam, H4 = b; HAND FOLD 1,
// DECISIONS.md K.2-271). A box type whose `composite` (lib/packs/elements.js
// COMPOSITE_MODES, held equal by test/overlay-blend-chrome.test.js) names a
// mode gets, for each page-host group, a SECOND container: group.blend, a
// div.el-blend in #el-layer-blend — a body-level layer of the page host (not a
// host: no HOST_NAMES entry, registerHost unchanged), before #el-layer in tree
// order at the same --z-pins, so every glyph stays above it — whose element
// blends against the page: multiply in the theme's light mode, screen in its
// dark (theme.js effectiveMode, re-read on the bus's 'mode'; never the OS
// scheme, which the ◑ toggle overrides). #el-layer is its own stacking
// context, so a blend inside it composites against nothing
// (HIGHLIGHTER@blend-isolated); this layer is the seam. The type draws its
// blending paths into group.blend and the rest into group.container; its
// marker is NEVER re-parented: group.container, its glyph, leader and
// selection stay in #el-layer. group.blend mirrors group.container on every
// pass: the same left/top/width/height, clip-path (inset or the frame mask)
// and display — so it is hidden, unplaced, framed and masked exactly as the
// container is — and carries the group's data-el-ids but no data-place, and
// no listener: it is never a hit-test target. The draw and move ctx carry it
// as ctx.blend. A type with no composite has no group.blend, and the layer is
// hidden while it holds no container.
export const COMPOSITE_MODES = Object.freeze(['multiply']);
// THE MARKER ALLOWLIST (U632; CHROME@element-module-reach's engine half,
// DECISIONS.md K.2-245; RULED CHROME@csp C3 = a, U632@allowlist-elements H8 =
// a, U632@post-draw-writes H7 = a). After every type's draw returns
// (runDraw) and after every move returns (applyGroup), built-in or plug-in
// alike, the overlay walks the group's containers — group.container and, for
// a type that declares composite, group.blend — each one's own attributes and
// every descendant (an open shadow root's too). An element is kept only when
// it is one of MARKER_ALLOWLIST.svg in the SVG namespace or .html in the XHTML
// namespace (localName and namespaceURI, never tagName text); any other is
// removed with its subtree. An attribute is removed when its localName is
// href, src or srcset (any namespace: xlink:href too) or starts with `on`; and,
// on every attribute but the inert text ones (MARKER_INERT_ATTRS: title,
// role, class, id, aria-*, data-* — a comment's title holds the user's text,
// and no browser fetches from them), when its value holds `url(` or
// `image-set(` (any case), `javascript:` once ASCII whitespace is taken out,
// or a backslash (a CSS escape: style and every SVG presentation attribute
// are read as CSS). A container's own style the type made refused is put
// back to what the overlay wrote before the call (its placement). What passed
// stays drawn (never draw-failed); each removed node and attribute is counted
// in stats().dom_refused, and the type is named once per page load on the
// console. This narrows the DOM channel only: a write a module makes after its
// draw returns (a timer, a later callback) is code-level reach — the pack
// check's reading and the surface page's Content-Security-Policy-Report-Only
// header's measurement (lib/core/cors.js SURFACE_CSP_REPORT_ONLY) — and a type
// in the chrome realm keeps the chrome's reach (K.5 K2): pack review and
// approve are the boundary. The walk runs per draw and per move, never per
// pointer sample (the wet layer is not a marker).
export const MARKER_ALLOWLIST = Object.freeze({
  svg: Object.freeze(['svg', 'g', 'path', 'line', 'polyline', 'circle', 'rect']),
  html: Object.freeze(['div', 'span']),
});
export const MARKER_INERT_ATTRS = Object.freeze(['title', 'role', 'class', 'id', 'aria-*', 'data-*']);
// The create ctx's own keys (toolCtx): no registerCreateCtx name may take one.
// `settings` (U512c): settings() → the armed type and profile's frozen
// {small, large} as they stood at the gesture's start (toolbar-state.js
// settingsSnapshot — the saved values over element.json's defaults); a lone
// click's are the click's own moment. A reader, never a writer.
export const CREATE_CTX_KEYS = Object.freeze(['anchors', 'sourceMap', 'markdownText', 'scope', 'armed', 'settings']);
// A registered create-ctx member's name.
export const CREATE_CTX_NAME = /^[a-z][A-Za-z0-9]{0,31}$/;
// The pointer policy's three answers.
export const POINTER_ANSWERS = Object.freeze(['tool', 'page', 'ignore']);
// A pick's kinds: a point (4C.1, U532) re-anchors onto a fixed-aspect target.
export const PICK_KINDS = Object.freeze(['element', 'range', 'source', 'point']);
// The generic marker's glyph: a 26px box whose bottom centre is the anchor
// point (the comment pin's shape). A type may register its own.
export const MARKER_GLYPH = Object.freeze({ dx: -13, dy: -26, w: 26, h: 26 });
// The blocks of a markdown item a taps tool with targets 'items' takes (F.3,
// M3): a press inside one of these, inside a [data-md-id] item, is the tool's;
// a press on the item's gaps, or on the chrome inside #main, is the page's.
export const MD_BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre';
// The hosts a layer may be registered for: each one's layer id is reserved
// (lib/server/domain/mounts.js RESERVED_IDS: 'el-layer', 'el-layer-chat',
// 'el-layer-turns', and 'el-layer-blend' — the page host's blend layer, a
// second layer of the page host and never a host of its own, so it has no
// name here and registerHost cannot take it; U624). A later host adds its
// name here and its id there in one change. The page is registered by
// initOverlay; U432 registers 'chat', U433 'turns'.
export const HOST_NAMES = Object.freeze(['page', 'chat', 'turns']);
// The anchor kinds the page host holds (plus the kind-less and 'page' rows it
// keeps — a box grab's page anchor never drawn, a stroke's page record drawn
// by THE PAGE ARM, never by the resolver): no other host may list one. A point
// row (4C.1, U532) is placed in its pane as an element row is, at its x/y
// (pointAt).
export const PAGE_KINDS = Object.freeze(['element', 'range', 'source', 'point']);
// THE PAGE ARM's names (U614): the attribute a drawn page group's marker and a
// pane-framed box group's marker carry their measured drift on (3 decimals;
// DRIFT@beside, U531@aspect-drift (a): read by F4's rows, never a class, a
// state or anything shown), and the most rectangles a page marker's mask may
// keep around the displayed frames that meet it (past it the marker is kept
// off the frames whole, as 'framed').
export const DRIFT_ATTR = 'data-el-drift';
export const MASK_RECTS_MAX = 64;
// THE DETACHABLE GLYPH's numbers (U587, H.7; the header's paragraph). The
// leaders are lib/packs/elements.js GLYPH_LEADERS', the corners and the bound
// lib/server/domain/elements.js GLYPH_CORNERS / GLYPH_OFFSET_MAX — each held
// equal by test/overlay-detach-glyph.test.js (the chrome cannot require lib/).
export const GLYPH_LEADERS = Object.freeze(['dotted', 'faint', 'hover']);
export const GLYPH_CORNERS = Object.freeze(['tl', 'tr', 'bl', 'br']);
export const GLYPH_OFFSET_MAX = 4096;
// How long a finger stays down, within the tap slop, before it may drag a glyph.
export const GLYPH_HOLD_MS = 450;
// A leader whose glyph sits this near its anchor's box collapses to 'hover'.
export const LEADER_NEAR_PX = 8;
// A drop the glyph clamp refuses (U631): the hint on bus 'overlay:glyph-refused'.
export const GLYPH_DROP_HINT = 'This pin cannot be dropped over a frame or outside its pane, so it went back where it was.';
// The last measures that refuse a drop (applyGroup's lastRes).
const REFUSED_DROPS = new Set(['framed', 'clipped']);
// More detached glyphs than this on one pane: their leaders collapse to 'hover'.
export const LEADER_PANE_MAX = 8;
// The route a drop writes (lib/server/routes/element-glyph.js).
export const glyphPath = (id) => `/api/elements/${encodeURIComponent(String(id))}/glyph`;
// THE PHONE PIN (U629): the picture a pin opens (lib/server/routes/
// element-picture.js GET, read only: the newest picture of the element's
// stroke group, or with 'without' the same clip without its ink), and the
// pin's words.
export const picturePath = (id, which) => `/api/elements/${encodeURIComponent(String(id))}/picture${which === 'without' ? '?which=without' : ''}`;
export const PIN_LABEL = 'Ink in the margin: open its picture, with and without the ink';

// THE DRAW RULES: how an answer is drawn, first matching row wins. `how` and
// `guess` null match anything. A section answer (re-resolved, how 'section')
// is a SECTION GUESS, never drawn as a hit (RULED GT-03@source-section-fallback,
// DECISIONS.md I.5 F2 (a)); an orphan the resolver carried a guess for (how
// 'locator-guess', a guess element) is drawn at the guess as a carried guess,
// flagged for the re-anchor seam (I.8 O1, I.7 M1, alpha.1 finding K-10); an
// orphan with no guess is never drawn and is listed by orphans(); a hidden
// element (the probe's) is neither drawn nor listed. L4's four drawn states
// (masked, superseded, indexing, unavailable: a host's answers, the daemon's)
// are drawn at the element their host placed them on, each with its own class,
// and never listed; their one-line explanation is the answer's own (`explain`,
// the daemon's EXPLAIN), never a table here. 'Placed' is exact | re-resolved
// (the rows above); 'refused' is never stored (D3) and has no row.
export const DRAW_RULES = Object.freeze([
  Object.freeze({ state: EXACT, how: null, guess: null, draw: 'hit', cls: 'el-hit', listed: false }),
  Object.freeze({ state: RE_RESOLVED, how: 'section', guess: null, draw: 'section', cls: 'el-section', listed: false }),
  // The re-resolved row's draw relies on the edit-tolerance reading below.
  Object.freeze({ state: RE_RESOLVED, how: null, guess: null, draw: 'hit', cls: 'el-hit', listed: false }),
  Object.freeze({ state: ORPHANED, how: null, guess: true, draw: 'guess', cls: 'el-guess', listed: true }),
  Object.freeze({ state: ORPHANED, how: null, guess: false, draw: 'none', cls: null, listed: true }),
  Object.freeze({ state: HIDDEN, how: null, guess: null, draw: 'none', cls: null, listed: false }),
  Object.freeze({ state: MASKED, how: null, guess: null, draw: 'hit', cls: 'el-masked', listed: false }),
  Object.freeze({ state: SUPERSEDED, how: null, guess: null, draw: 'hit', cls: 'el-superseded', listed: false }),
  Object.freeze({ state: INDEXING, how: null, guess: null, draw: 'hit', cls: 'el-indexing', listed: false }),
  Object.freeze({ state: UNAVAILABLE, how: null, guess: null, draw: 'hit', cls: 'el-unavailable', listed: false }),
]);

// The edited-element reading the re-resolved row's draw relies on (PLAN.md §7
// item 6; H4, G8): P-1, the share of edited elements the resolver re-finds,
// read 0.7589 over 589 anchors at the 1C gate on 39b52f8
// (results/gate-t1-1C.md); H4's four-anchor margin read as five anchors above
// the 0.75 refute line there. THE TRIGGER STAYS LIVE: if a later gate reads
// P-1 under 0.75, G8 fires and the edit-tolerant text term is built in the
// resolver. Nothing here changes a resolver rule (lib/core/anchors.js is
// U307's alone in tranche 2).
export const EDIT_TOLERANCE = Object.freeze({
  reading: 'P-1',
  value: 0.7589,
  of: 589,
  gate: '1C',
  head: '39b52f8',
  source: 'results/gate-t1-1C.md',
  margin_anchors: 5,
  refute_line: 0.75,
  trigger: 'G8: a P-1 reading under 0.75 builds the edit-tolerant text term',
  live: true,
});

export function drawRuleOf(answer) {
  const st = answer && answer.state;
  const hasGuess = !!(answer && answer.guess);
  for (const r of DRAW_RULES) {
    if (r.state !== st) continue;
    if (r.how != null && r.how !== answer.how) continue;
    if (r.guess != null && r.guess !== hasGuess) continue;
    return r;
  }
  return null;
}

// ── configuration (injectable for tests) ───────────────────────────────────
const cfg = {
  rectOf: (x) => defaultRectOf(x),
  raf: (fn) => requestAnimationFrame(fn),
  now: () => performance.now(),
  budget_ms: DEFAULT_BUDGET_MS,
  clips: (el) => defaultClips(el),
  hold_ms: GLYPH_HOLD_MS,
};
function defaultRectOf(x) {
  if (!x) return null;
  if (typeof x.getClientRects === 'function' && x.nodeType === undefined) {
    // a Range: its first client rect is the anchor point's line
    const rs = x.getClientRects();
    if (rs && rs.length) return rs[0];
  }
  return typeof x.getBoundingClientRect === 'function' ? x.getBoundingClientRect() : null;
}
function defaultClips(el) {
  const w = el.ownerDocument && el.ownerDocument.defaultView;
  if (!w || typeof w.getComputedStyle !== 'function') return false;
  const cs = w.getComputedStyle(el);
  const clipping = (v) => !!v && v !== 'visible';
  return clipping(cs.overflow) || clipping(cs.overflowX) || clipping(cs.overflowY);
}

// ── state ───────────────────────────────────────────────────────────────────
const scopes = { live: { rows: new Map(), surface: null }, preview: { rows: new Map(), surface: null, node: null } };
let drawnScope = 'live';
const answers = new Map();        // id → {row, raw, state, rule, mount, scope, gen, hidden}
const watches = new Map();        // mount → {unwatch, ids, scope}
const initial = new Map();        // mount → a resolveAll handle (a set change's pass)
let initialQueued = new Set();
let initialScheduled = false;
let sourcesPending = false;
const mapCache = new Map();       // md id → {text, map}
const types = new Map();          // type → {draw, create, input, glyph, move, place, detach, composite}
const answerSubs = new Set();
const armedSubs = new Set();
let probe = null;
let policy = null;
let armedState = null;            // {type, profile} or null
let pickState = null;
let layer = null;                 // the page host's layer, #el-layer
let blendLayer = null;            // the page host's blend layer, #el-layer-blend (U624)
let inited = false;
let pass = null;                  // a position pass carried across frames (every host's groups)
// THE host registry: name → its record, in registration order, the page first.
// Each record holds its layer, its built groups (markers) and their signature,
// its last pass's numbers, and its pointer state: {listeningOn, gestures
// (pointerId → {decision, pointerType, mode, up}: each pointer's gesture),
// lastDown (the newest pointerdown's id)}. A non-page host also holds its
// answers (id → entry) and its dirty flag.
const registry = new Map();
let drawPending = false;
let drawAgain = false;
let lastOrphanSig = '';
const scrollRoots = new WeakSet();
const elTokens = new WeakMap();
let nextToken = 1;
const failed = new Map();         // id → {type, error} for a draw that threw
// The detachable glyph's state (U587): the press on a glyph under way, the
// click a drag owes, the hover-mode leaders drawn, the glyphs a touch tapped
// (their hover leader shown), and the tray action guard (element-types.js
// trayAction, loaded lazily: that module imports this one).
let drag = null;
let swallowClick = false;
const hoverable = new Set();
const tapShown = new Set();
let trayGuard = null;
const SVG_NS = 'http://www.w3.org/2000/svg';
// THE PAGE ARM's state (U614): the page orphans of the last page-host build
// (id → orphans()'s entry), the mapped record views of the last measure (id →
// {type, src, points, width, aspect}: pageRecordView's cache), the drawn
// scope's page rows counted at that build (the layout observer's guard), and
// element-types.js, loaded lazily for its stored records (it imports this
// module; recordOf(type, id, RAW_READ) is the record as stored).
const pageOrphans = new Map();
const pageViews = new Map();
let pageRowCount = 0;
let typesApi = null;
let typesLoading = false;
const RAW_READ = Object.freeze({ raw: true });
// THE PHONE PIN's state (U629): what the picture GET last answered per probe
// key (`<id>@<v>` of a candidate group's newest member → {state: 'pending' |
// 'ready' | 'none', type}), and the pair's look while one is open.
const pictures = new Map();
let pairLook = null;

const totals = { frames: 0, longest_frame_ms: 0, box_reads: 0, box_ms: 0, well_resizes: 0, dom_refused: 0 };
const lastPass = { drawn: 0, clipped: 0, guesses: 0, sections: 0, frame_hidden: 0 };   // the page host's
// The page host's record: its pointer state is live from the start (a tool may
// be armed before initOverlay); initOverlay gives it its layer and registers
// it, first.
const pageHost = newHost('page', { root: null, well: null, rung: '--z-pins', kinds: PAGE_KINDS, layer: null });

// ── rows ────────────────────────────────────────────────────────────────────
function checkScope(scope) {
  if (!SCOPES.includes(scope)) throw new TypeError(`overlay: scope must be one of ${SCOPES.join(', ')}`);
}
function normRow(r) {
  if (!r || typeof r !== 'object' || r.id == null || r.id === '') return null;
  const row = {
    id: String(r.id),
    v: r.v == null ? null : r.v,
    type: r.type == null ? null : String(r.type),
    schema: typeof r.schema === 'string' ? r.schema : null,
    anchor: r.anchor && typeof r.anchor === 'object' ? r.anchor : null,
    shared: r.shared === undefined ? null : !!r.shared,
    replies: Number.isFinite(r.replies) ? r.replies : 0,
    pending: !!r.pending,
  };
  if (r.answered !== undefined) row.answered = !!r.answered;
  // A detached glyph's offset (U587): the version's display sibling, as served.
  const display = displayOf(r.display);
  if (display) row.display = display;
  // The daemon's answer for a row that carries one (a host's row: {state,
  // explain, how, and its placement fields — an item-range's start and end, a
  // diff-line's file, line and side}), copied as given: the chrome invents no
  // state.
  if (r.answer && typeof r.answer === 'object') row.answer = copyAnswer(r.answer);
  // A lean row the daemon served masked (U415e: the hello, reset and node
  // read lean rows go through the read view) carries its served state on the
  // row itself; that is the row's answer (servedAnswerOf), so a previewed
  // node's pin over a learned value draws masked.
  else { const a = servedAnswerOf(r); if (a) row.answer = a; }
  return row;
}
// A row's display {glyph: {dx, dy, corner}}, checked and frozen; null when it
// holds no glyph offset (an attached glyph).
function offsetOf(g) {
  if (!g || typeof g !== 'object') return null;
  if (!['dx', 'dy'].every((k) => Number.isFinite(g[k]) && Math.abs(g[k]) <= GLYPH_OFFSET_MAX)) return null;
  if (!GLYPH_CORNERS.includes(g.corner)) return null;
  return Object.freeze({ dx: g.dx, dy: g.dy, corner: g.corner });
}
function displayOf(d) {
  const glyph = d && typeof d === 'object' ? offsetOf(d.glyph) : null;
  return glyph ? Object.freeze({ glyph }) : null;
}
// A page record the daemon served masked (U415c: a learned value's fragment
// inside its own words, so its quote holds a mark the pane's raw DOM never
// does) carries the served answer {state, visible, explain} on its row: that
// state beats the page resolver's own for the record (X3, Y3 = a). Null for
// any other record. comments.js and highlight.js pass it as the row's answer.
export function servedAnswerOf(rec) {
  if (!rec || typeof rec !== 'object' || rec.state !== MASKED) return null;
  return {
    state: MASKED,
    visible: typeof rec.visible === 'string' ? rec.visible : null,
    explain: typeof rec.explain === 'string' ? rec.explain : null,
  };
}
const servedMasked = (row) => !!(row && row.answer && row.answer.state === MASKED);
// Whether a held row already draws what record `rec` would give it: rec through
// normRow, compared with the row field for field as JSON (the one list of the
// fields a row draws by is normRow's; U512b's relay in element-types.js asks
// here, U590 / engineering contract (p)). A pending row, or a record carrying
// a host answer, never matches (a false "changed" only costs an upsert).
export function sameRow(held, rec) {
  const row = normRow(rec);
  if (!held || !row || held.pending || row.pending || (rec.answer && typeof rec.answer === 'object')) return false;
  try { return JSON.stringify(held) === JSON.stringify(row); } catch { return false; }
}
function copyAnswer(a) {
  const out = { ...a };
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (v && typeof v === 'object') out[k] = Array.isArray(v) ? [...v] : { ...v };
  }
  return out;
}
// The non-page hosts that list a row's anchor kind (a row is routed to its
// hosts before the page's resolver paths).
function hostsOfKind(kind) {
  const out = [];
  if (kind == null) return out;
  for (const h of registry.values()) if (!h.page && h.kinds.includes(kind)) out.push(h);
  return out;
}
function isHostRow(row) {
  return !!(row && row.anchor && hostsOfKind(row.anchor.kind).length);
}
// Where a row resolves: a pane mount (element and range anchors, a converted
// pin), a markdown item (a source anchor), or nowhere (pending, no anchor, a
// 'page' record, or a row another host holds).
function placeOf(row) {
  if (row.pending || !row.anchor) return null;
  const a = row.anchor;
  if (a.kind === 'page') return null;
  if (isHostRow(row)) return null;
  // A row of another host's kind (a chat kind) with no host registered for it
  // yet, or none still: unplaced, never the page's pane path (K.2-161).
  if (a.kind != null && !PAGE_KINDS.includes(a.kind)) return null;
  if (a.kind === 'source') return { kind: 'md', key: a.md == null ? null : String(a.md) };
  return { kind: 'pane', key: a.mount == null || a.mount === '' ? null : String(a.mount) };
}
function mountsOf(rows) {
  const out = new Set();
  for (const r of rows) {
    const p = placeOf(r);
    if (p && p.kind === 'pane' && p.key != null) out.add(p.key);
  }
  return out;
}

export function setElements(scope, rows) {
  checkScope(scope);
  const S = scopes[scope];
  const before = [...S.rows.values()];
  S.rows = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const row = normRow(r);
    if (row) S.rows.set(row.id, row);
  }
  changed(scope, [...before, ...S.rows.values()]);
}
export function upsertElements(scope, rows) {
  checkScope(scope);
  const S = scopes[scope];
  const touched = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const row = normRow(r);
    if (!row) continue;
    const old = S.rows.get(row.id);
    if (old) touched.push(old);
    S.rows.set(row.id, row);
    touched.push(row);
  }
  changed(scope, touched);
}
export function removeElements(scope, ids) {
  checkScope(scope);
  const S = scopes[scope];
  const touched = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const old = S.rows.get(String(id));
    if (!old) continue;
    S.rows.delete(old.id);
    touched.push(old);
  }
  changed(scope, touched);
}
export function elementsOf(scope) {
  checkScope(scope);
  return [...scopes[scope].rows.values()].map((r) => ({ ...r }));
}
export function surfaceOf(scope = 'live') {
  checkScope(scope);
  return scopes[scope].surface;
}
export function drawnScopeOf() { return drawnScope; }

// A set changed: the drawn set's watches, passes and answers follow, and a
// host whose rows were touched is re-placed (its rows are the live set's,
// drawn whatever the page's scope).
function changed(scope, touchedRows) {
  if (scope === 'live') {
    for (const r of touchedRows) for (const h of hostsOfKind(r.anchor && r.anchor.kind)) markDirty(h);
  }
  if (scope !== drawnScope) return;
  const rows = scopes[scope].rows;
  for (const id of [...answers.keys()]) if (!rows.has(id)) { answers.delete(id); failed.delete(id); }
  for (const r of touchedRows) {
    const cur = rows.get(r.id);
    if (!cur || placeOf(cur) == null) answers.delete(r.id);
  }
  syncWatches();
  let sources = false;
  for (const r of touchedRows) {
    const p = placeOf(r);
    if (!p) continue;
    if (p.kind === 'md') sources = true;
    else if (p.key == null) noMount(r);
    else queueInitial(p.key);
  }
  if (sources) scheduleSources();
  orphansChanged();
  requestDraw();
}

// A pane row whose anchor names no mount answers orphaned, once.
function noMount(row) {
  const cur = scopes[drawnScope].rows.get(row.id);
  if (!cur) return;
  const raw = { state: ORPHANED, el: null, i: -1, how: 'no-mount' };
  deliver(drawnScope, null, [cur.id], [raw], { records: 1, gen: null, absent: true });
}

// ── watching ────────────────────────────────────────────────────────────────
function rowsOfMount(scope, mount) {
  const out = [];
  for (const r of scopes[scope].rows.values()) {
    const p = placeOf(r);
    if (p && p.kind === 'pane' && p.key === mount) out.push(r);
  }
  return out;
}
function syncWatches() {
  const want = mountsOf(scopes[drawnScope].rows.values());
  for (const [m, w] of [...watches]) {
    if (want.has(m) && w.scope === drawnScope) continue;
    w.unwatch();
    watches.delete(m);
    const h = initial.get(m);
    if (h) { h.cancel(); initial.delete(m); }
  }
  for (const m of want) {
    if (watches.has(m)) continue;
    const w = { scope: drawnScope, ids: [], unwatch: null };
    w.unwatch = anchors.watch(m, {
      records: () => {
        const list = rowsOfMount(w.scope, m);
        w.ids = list.map((r) => r.id);
        return list.map((r) => r.anchor);
      },
      onAnswers: (ans, report) => deliver(w.scope, m, w.ids, ans, report),
    });
    watches.set(m, w);
  }
}
function unwatchAll() {
  for (const w of watches.values()) w.unwatch();
  watches.clear();
  for (const h of initial.values()) h.cancel();
  initial.clear();
  initialQueued = new Set();
}

function paneRoot(mount) {
  const M = window.__wcMount;
  const it = M && typeof M.itemEl === 'function' ? M.itemEl(document, mount) : null;
  return it && it.kind === 'pane' && it.el && it.el.shadowRoot ? it.el.shadowRoot : null;
}
// A set change's passes, one per touched mount, started together on a
// microtask so a burst of changes starts each mount's pass once.
function queueInitial(mount) {
  initialQueued.add(mount);
  if (initialScheduled) return;
  initialScheduled = true;
  Promise.resolve().then(runInitial);
}
function runInitial() {
  initialScheduled = false;
  const list = [...initialQueued];
  initialQueued = new Set();
  for (const m of list) {
    if (!watches.has(m)) continue;
    const scope = drawnScope;
    const rows = rowsOfMount(scope, m);
    if (!rows.length) continue;
    const ids = rows.map((r) => r.id);
    const prev = initial.get(m);
    if (prev) prev.cancel();
    initial.delete(m);
    const root = paneRoot(m);
    if (!root) {
      deliver(scope, m, ids, rows.map(() => ({ state: ORPHANED, el: null, i: -1, how: 'mount-absent' })),
        { records: rows.length, gen: null, absent: true });
      continue;
    }
    const handle = anchors.resolveAll(root, rows.map((r) => r.anchor), {}, (ans, report) => {
      if (initial.get(m) === handle) initial.delete(m);
      deliver(scope, m, ids, ans, report);
    });
    initial.set(m, handle);
  }
}

// ── sources (markdown items) ────────────────────────────────────────────────
function scheduleSources() {
  if (sourcesPending) return;
  sourcesPending = true;
  cfg.raf(resolveSources);
}
function mapOf(md, text) {
  const c = mapCache.get(md);
  if (c && c.text === text) return c.map;
  const map = sourceMap(text);
  mapCache.set(md, { text, map });
  return map;
}
function resolveSources() {
  sourcesPending = false;
  const scope = drawnScope;
  const byMd = new Map();
  for (const r of scopes[scope].rows.values()) {
    const p = placeOf(r);
    if (!p || p.kind !== 'md') continue;
    if (!byMd.has(p.key)) byMd.set(p.key, []);
    byMd.get(p.key).push(r);
  }
  const M = window.__wcMount;
  for (const [md, rows] of byMd) {
    const it = md != null && M && typeof M.itemEl === 'function' ? M.itemEl(document, md) : null;
    const item = page.markdown && md != null ? page.markdown.get(md) : null;
    const ids = rows.map((r) => r.id);
    let ans;
    if (it && it.kind === 'md' && item) {
      const text = String(item.text == null ? '' : item.text);
      const map = mapOf(md, text);
      ans = rows.map((r) => anchors.resolveSource(it.el, text, map, r.anchor));
    } else {
      ans = rows.map(() => ({ state: ORPHANED, range: null, start: null, end: null, how: 'item-absent', occ: 0 }));
    }
    deliver(scope, md, ids, ans, { records: rows.length, gen: null, source: true });
  }
}

// ── answers ─────────────────────────────────────────────────────────────────
function probed(row, raw, mount, scope) {
  if (!probe) return null;
  try {
    const reason = probe({ row: { ...row }, answer: raw, mount, scope });
    return reason == null || reason === false ? null : reason;
  } catch (e) {
    console.error('[web-chat] overlay: the hidden probe failed', e);
    return null;
  }
}
// A page row served masked (servedAnswerOf) reads masked whatever the
// resolver answered — a hidden one stays hidden — and is drawn with the MASKED
// row at what the resolver found (buildGroups), never listed as an orphan.
function entryOf(row, raw, mount, scope, gen) {
  const hidden = probed(row, raw, mount, scope);
  const masked = !hidden && servedMasked(row);
  const state = hidden ? HIDDEN : masked ? MASKED : raw.state;
  return { row, raw, state, hidden, masked, rule: drawRuleOf({ ...raw, state }), mount, scope, gen };
}
// A pass delivered (the resolver's, a set change's or the sources'): the
// answers are STORED, the probe applied, the listeners told, and a draw frame
// asked for. No box is read here (C-05-3).
function deliver(scope, mount, ids, ans, report) {
  if (scope !== drawnScope) return;
  const rows = scopes[scope].rows;
  const items = [];
  const n = Math.min(ids.length, Array.isArray(ans) ? ans.length : 0);
  for (let i = 0; i < n; i++) {
    const row = rows.get(ids[i]);
    if (!row || !ans[i]) continue;
    const e = entryOf(row, ans[i], mount, scope, report && report.gen != null ? report.gen : null);
    answers.set(row.id, e);
    failed.delete(row.id);
    const raw = e.raw;
    items.push({ id: row.id, v: row.v, type: row.type, state: e.state, how: raw.how == null ? null : raw.how,
      tie: raw.tie == null ? null : raw.tie, why: raw.why == null ? null : raw.why, el: raw.el || null });
  }
  if (items.length) {
    const msg = { mount, scope, surface: scopes[scope].surface, gen: report && report.gen != null ? report.gen : null,
      items, report: report || null };
    for (const fn of [...answerSubs]) {
      try { fn(msg); } catch (e) { console.error('[web-chat] overlay: an onAnswers listener failed', e); }
    }
  }
  orphansChanged();
  requestDraw();
}

export function onAnswers(fn) {
  if (typeof fn !== 'function') throw new TypeError('onAnswers: expects a function');
  const h = (m) => fn(m);
  answerSubs.add(h);
  return () => { answerSubs.delete(h); };
}

// The one hidden-state probe (U303's): fn({row, answer, mount, scope}) → null
// or a hidden reason. The last set wins; setting re-applies it to the answers
// held.
export function setHiddenProbe(fn) {
  if (fn != null && typeof fn !== 'function') throw new TypeError('setHiddenProbe: expects a function or null');
  const mine = fn || null;
  probe = mine;
  reprobe();
  return () => { if (probe === mine) { probe = null; reprobe(); } };
}
function reprobe() {
  for (const [id, e] of answers) answers.set(id, entryOf(e.row, e.raw, e.mount, e.scope, e.gen));
  orphansChanged();
  requestDraw();
}

// ── orphans ─────────────────────────────────────────────────────────────────
// The resolver's orphans, and THE PAGE ARM's (U614): a page stroke whose items
// are all gone (how 'page-gone', never drawn), an arrow with one item gone
// (how 'page-guess', drawn faded at its guess) and, below 760 px, a margin
// stroke (how 'page-narrow', drawn faded at its guess) — each with kind
// 'page' and its record's item as `mount` (only a page orphan carries kind).
export function orphans() {
  const out = [];
  for (const e of answers.values()) {
    if (e.scope !== drawnScope || e.state !== ORPHANED || !e.rule || !e.rule.listed) continue;
    out.push({ id: e.row.id, v: e.row.v, type: e.row.type, mount: e.mount, scope: e.scope,
      how: e.raw.how == null ? null : e.raw.how, guess: !!e.raw.guess });
  }
  for (const o of pageOrphans.values()) if (o.scope === drawnScope) out.push({ ...o });
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
function orphansChanged() {
  const list = orphans();
  const sig = drawnScope + '|' + list.map((o) => `${o.id}@${o.v}:${o.how}:${o.guess ? 1 : 0}`).join(',');
  if (sig === lastOrphanSig) return;
  lastOrphanSig = sig;
  bus.emit('overlay:orphans', { scope: drawnScope, orphans: list });
}

// ── the drawn scope ─────────────────────────────────────────────────────────
function syncScope() {
  const want = view.previewing ? 'preview' : 'live';
  if (want === drawnScope) return;
  drawnScope = want;
  unwatchAll();
  answers.clear();
  failed.clear();
  pageOrphans.clear();
  pageViews.clear();
  if (want === 'live') { scopes.preview.rows = new Map(); scopes.preview.node = null; }
  // The page's rows only: a host's rows are drawn in either scope (C1), so a
  // preview neither clears nor re-places them.
  const rows = [...scopes[want].rows.values()].filter((r) => !isHostRow(r));
  changed(want, rows);
}
// The hello and reset frames' lean rows replace the PAGE host's rows: every
// row whose kind another host lists is kept (a Wipe, Set active, Branch or New
// graph never drops a chat marker, REQ@chat-wipe), the frame's own copy of one
// winning.
function takeLive(msg) {
  scopes.live.surface = msg && msg.surface != null ? msg.surface : null;
  const S = scopes.live;
  const before = [...S.rows.values()];
  S.rows = new Map();
  for (const r of before) if (isHostRow(r)) S.rows.set(r.id, r);   // kept as they are: not re-placed
  const fresh = [];
  for (const r of msg && Array.isArray(msg.elements) ? msg.elements : []) {
    const row = normRow(r);
    if (!row) continue;
    S.rows.set(row.id, row);
    fresh.push(row);
  }
  changed('live', [...before.filter((r) => !isHostRow(r)), ...fresh]);
  scheduleSources();
}
// A previewed node's rows: its lean comment rows, and its id@v references held
// pending. The split at the last '@' is U353's parsePin rule (element-log is
// node-only, so the chrome cannot import it).
function refRow(ref) {
  const s = String(ref);
  const at = s.lastIndexOf('@');
  if (at <= 0) return null;
  const v = Number(s.slice(at + 1));
  return { id: s.slice(0, at), v: Number.isSafeInteger(v) && v > 0 ? v : null, pending: true };
}
function takePreview(d) {
  const node = d && d.node;
  const rows = [];
  for (const r of Array.isArray(node && node.lean_elements) ? node.lean_elements : []) rows.push(r);
  const have = new Set(rows.map((r) => r && r.id != null && String(r.id)));
  for (const ref of Array.isArray(node && node.elements) ? node.elements : []) {
    const r = refRow(ref);
    if (r && !have.has(r.id)) rows.push(r);
  }
  scopes.preview.node = d && d.id != null ? d.id : null;
  setElements('preview', rows);
  syncScope();
}

// ── the draw ────────────────────────────────────────────────────────────────
function tokenOf(el) {
  let t = elTokens.get(el);
  if (!t) { t = nextToken++; elTokens.set(el, t); }
  return t;
}
function rangeKey(range) {
  return `r${tokenOf(range.startContainer)}:${range.startOffset}-${tokenOf(range.endContainer)}:${range.endOffset}`;
}
// The signature unchanged, the built groups (and their markers) stay; each
// takes the fresh pass's DOM objects and items, so a placement and a type's
// move read the current Range and answers, never a stale pass's.
function refreshKept(h, gs) {
  for (let i = 0; i < gs.length; i++) {
    const g = h.groups[i];
    const f = gs[i];
    if (!g || g.key !== f.key) continue;
    g.el = f.el;
    g.range = f.range;
    g.items = f.items;
    g.mount = f.mount;
    g.mdItem = f.mdItem;
    // A page group (U614) takes the pass's members and endpoint items.
    if (f.page) { g.members = f.members; g.endEls = f.endEls; }
  }
}
function glyphOf(type, h) {
  if (h && h.glyph) {
    const own = typeof h.glyph === 'function' ? checkGlyph(h.glyph(type)) : h.glyph;
    if (own) return own;
  }
  const t = types.get(type);
  const g = t && t.glyph;
  return g || MARKER_GLYPH;
}
// A glyph {dx, dy, w, h} in px, frozen; null when it is not one.
function checkGlyph(g) {
  if (!g || typeof g !== 'object') return null;
  if (!['dx', 'dy', 'w', 'h'].every((k) => Number.isFinite(g[k])) || g.w <= 0 || g.h <= 0) return null;
  return Object.freeze({ dx: g.dx, dy: g.dy, w: g.w, h: g.h });
}
// THE MARGIN GLYPH (F.3): a range group whose start lies inside a markdown
// item ([data-md-id]) and whose type registered `sourceGlyph` is anchored at
// the item's left edge, level with the range's first line, and drawn with
// sourceGlyph's offsets (the type's glyph size kept) — so a pin on a heading
// or a paragraph sits in the item's left gutter. The clip and the inset are
// the placement's own (measureGroup): never drawn outside the well's clip.
// No box read: the item is found by the DOM alone.
function marginItemOf(type, range) {
  const t = types.get(type);
  if (!t || !t.sourceGlyph) return null;
  const sc = range.startContainer;
  const start = sc && (sc.nodeType === 1 ? sc : sc.parentNode);
  return start && typeof start.closest === 'function' ? start.closest('[data-md-id]') : null;
}
function marginGlyph(type) {
  const gl = glyphOf(type);
  const sg = types.get(type).sourceGlyph;
  return Object.freeze({ dx: sg.dx, dy: sg.dy, w: gl.w, h: gl.h });
}
// THE BOX PLACEMENT (U516, plan 4A.2): a row of a type registered with place
// 'box' whose anchor is an element anchor is drawn as a box — its marker the
// target's own rect (the carried guess's, for a guess), clipped to its well
// and never over a displayed frame (measureBox). Any other row of such a type
// (a range, a source, an item-box fallback, a point) is drawn as a glyph,
// as every other type's is — a point's at its x/y (pointAt).
function boxRow(type, row) {
  const t = types.get(type);
  return !!(t && t.place === 'box' && row && row.anchor && row.anchor.kind === 'element');
}
// A point answer's stored point (resolvePoint's pt): {x, y}, both finite
// numbers, frozen; else null (the row is drawn as an element row).
function pointOfAnswer(raw) {
  const p = raw && raw.pt;
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? Object.freeze({ x: p.x, y: p.y }) : null;
}
// A point group's anchor point in the viewport: THE one mapping
// (anchors.pointAt, U531) of its stored point onto the target's rect now.
function pointPlace(pt, r) {
  return typeof anchors.pointAt === 'function' ? anchors.pointAt({ pt }, r) : null;
}
// Whether a type's glyph detaches (registerType's `detach`, U587).
function detachable(type) {
  const t = types.get(type);
  return !!(t && t.detach);
}
// A detached type's leader style now: its registration's (a function is read
// per draw: the tool's setting), one of GLYPH_LEADERS, else the first.
function leaderOf(type) {
  const t = types.get(type);
  let v = t && t.detach ? t.detach.leader : null;
  if (typeof v === 'function') { try { v = v(); } catch { v = null; } }
  return GLYPH_LEADERS.includes(v) ? v : GLYPH_LEADERS[0];
}
function leaderEl() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'el-leader');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.display = 'none';
  svg.appendChild(document.createElementNS(SVG_NS, 'line'));
  return svg;
}
// Write a detached group's leader from its measure (applyGroup's write slice):
// its box the group's clip, its line the clipped segment; hidden when there is
// none or it would cross a frame. The style is the type's, collapsed to
// 'hover' by the density rule or a glyph near its anchor.
function placeLeader(g, m) {
  g.lastX = m.x;
  g.lastY = m.y;
  g.lastAbox = m.abox || null;
  g.lastGbox = m.gbox || null;
  // The clip it was drawn in (U631: the drag's clamp), a plain copy.
  g.lastClip = m.clip ? { left: m.clip.left, top: m.clip.top, right: m.clip.right, bottom: m.clip.bottom } : null;
  const svg = g.leader;
  if (!svg) return;
  const L = m.leader;
  g.leaderFramed = !!(L && L.framed);
  if (!L || L.empty || L.framed) { svg.style.display = 'none'; hoverable.delete(g); return; }
  const mode = g.dense || L.near ? 'hover' : leaderOf(g.type);
  const c = m.clip;
  const w = Math.max(0, c.right - c.left);
  const h = Math.max(0, c.bottom - c.top);
  svg.style.left = c.left + 'px';
  svg.style.top = c.top + 'px';
  svg.style.width = w + 'px';
  svg.style.height = h + 'px';
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  const line = svg.firstChild;
  line.setAttribute('x1', String(L.sx - c.left));
  line.setAttribute('y1', String(L.sy - c.top));
  line.setAttribute('x2', String(L.ex - c.left));
  line.setAttribute('y2', String(L.ey - c.top));
  svg.dataset.leader = mode;
  svg.classList.toggle('el-leader-orphan', g.kind === 'guess');
  svg.style.display = '';
  if (mode === 'hover') hoverable.add(g); else hoverable.delete(g);
  syncLeaderOn(g);
}
// Whether a leader shows: always but in 'hover', where only while its glyph or
// its anchor is hovered, a touch tapped the glyph, or the glyph is dragged.
function syncLeaderOn(g) {
  const svg = g.leader;
  if (!svg) return;
  const on = svg.dataset.leader !== 'hover' || !!g.hovered || tapShown.has(g.key)
    || !!(drag && drag.started && drag.key === g.key);
  svg.classList.toggle('el-leader-on', on);
}
const inBox = (b, x, y) => !!b && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
// The hover reading: one passive listener, idle while no hover leader is drawn.
function onHoverMove(e) {
  if (!hoverable.size || e.pointerType === 'touch') return;
  for (const g of hoverable) {
    const on = inBox(g.lastAbox, e.clientX, e.clientY) || inBox(g.lastGbox, e.clientX, e.clientY);
    if (on !== !!g.hovered) { g.hovered = on; syncLeaderOn(g); }
  }
}
// ── THE PAGE ARM (U614, plan 5A.2; REQ@ink-scope-v2 b+, REQ@arrow-endpoints
// a, REQ@margins a, REQ@page-stroke-phone a, PAGE@mask-frames, DRIFT@beside,
// ARROW@tolerance, MAP@engine) ───────────────────────────────────────────────
// A stroke's PAGE RECORD (lib/core/strokes.js isPageRecord) is never the
// resolver's (placeOf answers null for it: C5's honesty) — it is placed by its
// ITEMS. At each page-host build, the drawn scope's rows whose anchor is a page
// record, whose type registered place 'box' and whose stored record
// (element-types.js recordOf, read as stored) carries a stroke (isStrokePayload)
// are grouped ONE GROUP PER (type, from.item, to.item) — sameTarget's page arm
// — against ONE item map of the pass (one querySelectorAll over #main's
// .mount-host and [data-md-id] blocks, keyed as mount-runtime's itemEl keys
// them; never itemEl per row). A box grab's page anchor is no page record: it
// stays undrawn. The measure reads each endpoint item's rect once per frame
// (counted with the frame's reads) and maps each member by THE ONE MAPPING
// (mapPage); the group's box is the union of its members' mapped boxes, its
// marker a box marker (data-place 'box', data-el-ids, pointer-events none:
// no stroke ever takes a control's press) in #el-layer, and the type's draw
// reads each member's record mapped into that box (pageRecordView), so a
// pack's draw stays frame-agnostic. The draw runs again when the mapped shape
// changes (an arrow's ends moved apart, or it turned), never per sample.
// THE CLIP starts at the well (.well-wrap's visible box), never inside a pane,
// so a gutter stroke shows (REQ@margins a). PAGE@mask-frames: the chrome
// covers a page stroke by z-order (#el-layer at --z-pins, under the dock's
// --z-chat and every panel's --z-panel); a displayed frame of the census (the
// document's iframes and every pane's own) never hides it whole — the marker
// is MASKED around each meeting frame (clip-path: path() over the painted box
// less every meeting frame's rect, cut into disjoint rectangles), so 0 px are
// painted over a frame. ORPHANS: every needed item gone → listed, never drawn
// at a stale position; an arrow with one item gone → drawn faded at its guess
// (group.kind 'guess') and listed; below 760 px (viewport.js isNarrow) an
// arrow maps between its stacked items as anywhere (it turns vertical), a
// margin ('beside') stroke is drawn faded at its guess and listed, and an
// 'inside' stroke draws as on the desktop. DRIFT@beside: each drawn page
// group's marker carries DRIFT_ATTR (mapPage's drift, the members' largest).
function boxType(type) {
  const t = types.get(type);
  return !!(t && t.place === 'box');
}
// The pass's item map: id → the item's element (a pane's .mount-host, a
// markdown item's [data-md-id] block), a pane before a markdown item of the
// same id and the first of each in document order, as itemEl answers.
function itemMapOf(main) {
  const out = new Map();
  if (!main) return out;
  const md = new Map();
  for (const el of main.querySelectorAll('.mount-host, [data-md-id]')) {
    if (el.classList.contains('mount-host')) {
      const k = (el.dataset && el.dataset.mountId) || el.id;
      if (k && !out.has(k)) out.set(k, el);
    } else {
      const k = el.getAttribute('data-md-id');
      if (k && !md.has(k)) md.set(k, el);
    }
  }
  for (const [k, el] of md) if (!out.has(k)) out.set(k, el);
  return out;
}
// element-types.js, once (a relative lazy import: it imports this module):
// the stored records, and the tray action guard (U587's drag). A draw is
// asked for when it lands.
function loadTypes() {
  if (typesApi || typesLoading) return;
  typesLoading = true;
  import('./element-types.js').then((m) => {
    typesApi = m;
    if (typeof m.trayAction === 'function') trayGuard = m.trayAction;
    requestDraw();
  }, (err) => {
    typesLoading = false;
    console.error('[web-chat] overlay: the element types module did not load', err);
  });
}
// A plug-in type's stored record (never the page arm's mapped view), or null.
function rawRecordOf(type, id) {
  if (!typesApi || typeof typesApi.recordOf !== 'function') return null;
  try { return typesApi.recordOf(type, id, RAW_READ) || null; } catch { return null; }
}
// The page host's page groups, into byKey (buildGroups' map), and the page
// orphans of this build. DOM queries only: no box read.
function buildPageArm(byKey) {
  const rows = [];
  for (const r of scopes[drawnScope].rows.values()) {
    if (!r.pending && r.anchor && isPageRecord(r.anchor) && boxType(r.type)) rows.push(r);
  }
  pageRowCount = rows.length;
  pageOrphans.clear();
  // Only a row grouped in this build keeps its mapped view (its measure
  // renews it): a gone, unloaded or orphaned-whole row's record(id) is null.
  const grouped = new Set();
  if (rows.length && !typesApi) loadTypes();
  if (rows.length && typesApi) {
    const items = itemMapOf($('main'));
    const narrow = isNarrow();
    for (const row of rows) {
      // Its record not loaded yet (or no stroke): unplaced, never listed.
      const rec = rawRecordOf(row.type, row.id);
      if (!rec || !isStrokePayload(rec) || !isPageRecord(rec.anchor)) continue;
      const a = row.anchor;
      const shape = pageShape(a);
      const fromEl = items.get(a.from.item) || null;
      const toEl = shape === 'between' ? items.get(a.to.item) || null : fromEl;
      let how = null;
      if (!fromEl && !toEl) how = 'page-gone';
      else if (shape === 'between' && (!fromEl || !toEl)) how = 'page-guess';
      else if (shape === 'beside' && narrow) how = 'page-narrow';
      if (how) {
        pageOrphans.set(row.id, { id: row.id, v: row.v, type: row.type, mount: a.item, scope: drawnScope, how,
          guess: how !== 'page-gone', kind: 'page' });
      }
      if (how === 'page-gone') continue;
      const guess = !!how;
      const type = row.type;
      const key = `${type}|page|${JSON.stringify([a.from.item, a.to.item])}${guess ? '|guess' : ''}`;
      let g = byKey.get(key);
      if (!g) {
        g = { key, type, kind: guess ? 'guess' : 'hit', cls: guess ? 'el-guess' : 'el-hit', el: null, range: null,
          mount: a.item, scope: drawnScope, host: 'page', items: [], container: null, glyph: glyphOf(type), mdItem: null,
          failed: false, place: 'box', page: true, forceGuess: guess, drawn: false, boxW: 0, boxH: 0, members: [], endEls: [] };
        g.box = Object.freeze({ get w() { return g.boxW; }, get h() { return g.boxH; } });
        byKey.set(key, g);
        // A margin stroke faded on a narrow screen (U629: its guess clamped
        // into the well's width, and a phone pin's candidate).
        if (how === 'page-narrow') g.narrowBeside = true;
      }
      g.members.push({ id: row.id, rec, fromEl, toEl });
      grouped.add(row.id);
      for (const el of [fromEl, toEl]) if (el && !g.endEls.includes(el)) g.endEls.push(el);
      const state = guess ? ORPHANED : EXACT;
      g.items.push({ id: row.id, v: row.v, type, row, state, how: how || 'page', answer: { state, how: how || 'page', guess } });
    }
  }
  pinGroups(byKey);
  for (const id of [...pageViews.keys()]) if (!grouped.has(id)) pageViews.delete(id);
  orphansChanged();
}
// ── THE PHONE PIN (U629, plan 5B.7; RULED U614@phone-margin-pin H2 b,
// REQ@page-stroke-phone a with the maintainer's note, PICTURE@when a, AD5/J2,
// PHONE@gutter-guess G9 a; DECISIONS L.1 M4) ─────────────────────────────────
// On a narrow screen a SHARED 'beside' group of the live scope — every member
// row and stored record shared — whose picture is READY is drawn as ONE PIN in
// place of its faded box marker: a glyph marker (MARKER_GLYPH, the comment
// pin's .pin-marker look and app.css's tokens; nothing new) whose tip sits at
// the centre of the group's guess, placed, clipped and kept off a frame by the
// glyph rules, taking a press. An opting type's group.blend is never built for
// it, so no blended ink paints beside the pin. A tap (its click) opens THE
// PAIR: the picture with the ink and the same clip without it, two <img> of GET
// picturePath(id) and picturePath(id, 'without') in a .popover.bg-look (the box
// grab look's classes) registered through shell.js registerPopover; an image
// that fails to load is taken out, and with none left the look closes. The
// pin never asks for a picture (PICTURE@when: no POST, only a host renders
// one), never drags (no stored offset is written), and is never a private
// group's (G3) or a preview's. HOW THE CHROME LEARNS A PICTURE IS READY: the
// picture GET itself — one GET of picturePath(id) for the newest member of a
// candidate group, answered 200 (ready) or 404 'no picture' (a 403 below the
// read floor, a network peer at basic, reads as none), kept per `<id>@<v>`:
// asked again only when a frame of its type's elements arrives (element:<type>:
// a Send to Claude's picture folds there), on a hello or a reset, or when the
// group is a candidate again after it was not (the narrow flip) — never per
// pass or per sample. A private or never-pictured group, an arrow, an
// 'inside' stroke and the desktop keep U614's presentation; orphans() is
// unchanged.
function pinGroups(byKey) {
  const wanted = new Set();
  for (const [key, g] of [...byKey]) {
    if (!g.page || !g.narrowBeside || g.scope !== 'live' || !g.members.length) continue;
    if (!g.items.every((it) => it.row && it.row.shared === true) || !g.members.every((mb) => mb.rec.shared === true)) continue;
    const it = g.items[g.items.length - 1];
    const pk = `${it.id}@${it.v}`;
    wanted.add(pk);
    const st = pictures.get(pk);
    if (!st) { probePicture(pk, it.id, g.type); continue; }
    if (st.state !== 'ready') continue;
    byKey.delete(key);
    g.key = `${key}|pin`;
    g.pin = Object.freeze({ id: String(it.id), pk });
    g.kind = 'pin';
    g.cls = 'el-hit';
    g.glyph = MARKER_GLYPH;
    byKey.set(g.key, g);
  }
  for (const [pk, st] of [...pictures]) if (!wanted.has(pk) && st.state !== 'pending') pictures.delete(pk);
}
// One GET of a candidate's picture; its answer asks for a draw.
function probePicture(pk, id, type) {
  pictures.set(pk, { state: 'pending', type });
  Promise.resolve(request('GET', picturePath(id))).then((r) => {
    // A ready picture is a PNG: a 2xx whose body is no JSON.
    pictures.set(pk, { state: r && r.ok && r.body === null ? 'ready' : 'none', type });
    requestDraw();
  }, () => { pictures.set(pk, { state: 'none', type }); requestDraw(); });
}
// A frame of a type's elements: that type's unready answers are asked again.
function repictureType(msg) {
  const type = msg && typeof msg.type === 'string' ? msg.type.slice('element:'.length) : null;
  let any = false;
  for (const [pk, st] of [...pictures]) if (st.state === 'none' && st.type === type) { pictures.delete(pk); any = true; }
  if (any) requestDraw();
}
// A hello or a reset: every settled answer is asked again.
function repictureAll() {
  for (const [pk, st] of [...pictures]) if (st.state !== 'pending') pictures.delete(pk);
}
const PIN_SVG = '<svg viewBox="0 0 16 16" width="26" height="26" aria-hidden="true">'
  + '<path d="M8 1.4c-2.5 0-4.4 2-4.4 4.4 0 3.2 4.4 8.8 4.4 8.8s4.4-5.6 4.4-8.8C12.4 3.4 10.5 1.4 8 1.4z" fill="currentColor"/>'
  + '<circle cx="8" cy="5.8" r="1.55" style="fill:var(--wc-panel-bg)"/></svg>';
// The pin's own marker content (the overlay draws it: no type's draw runs).
function drawPin(g, c) {
  c.classList.add('pin-marker');
  c.dataset.elPin = 'picture';
  c.setAttribute('role', 'button');
  c.setAttribute('aria-label', PIN_LABEL);
  c.title = PIN_LABEL;
  c.innerHTML = PIN_SVG + (g.items.length > 1 ? `<span class="pin-count">${g.items.length}</span>` : '');
}
// Measure a pin (measurePage's last step, READS ONLY): its tip at the centre
// of the group's box, the glyph clipped to the well and never over a frame of
// the page census (the glyph's never-draw rule).
function measurePin(g, out, box, clip, fr, read) {
  const x = box.left + box.w / 2;
  const y = box.top + box.h / 2;
  if (!(x >= clip.left && x < clip.right && y >= clip.top && y < clip.bottom)) return { ...out, res: 'clipped' };
  const gl = g.glyph;
  const gx = x + gl.dx;
  const gy = y + gl.dy;
  const top = Math.max(0, clip.top - gy);
  const left = Math.max(0, clip.left - gx);
  const right = Math.max(0, gx + gl.w - clip.right);
  const bottom = Math.max(0, gy + gl.h - clip.bottom);
  if (top + bottom >= gl.h || left + right >= gl.w) return { ...out, res: 'clipped' };
  const painted = { left: gx + left, top: gy + top, right: gx + gl.w - right, bottom: gy + gl.h - bottom };
  if (pageCensus(fr, read).some((b) => meets(painted, b))) return { ...out, res: 'framed' };
  return { ...out, res: 'drawn', x, y, clip, inset: [top, right, bottom, left] };
}
// THE GUESS CLAMP (G9 a): the shift that puts [lo, hi] inside [L, R] (its left
// edge at L when it is the wider).
function clampShift(lo, hi, L, R) {
  if (hi - lo >= R - L) return L - lo;
  if (hi > R) return R - hi;
  if (lo < L) return L - lo;
  return 0;
}
// THE PAIR: the two pictures of the pin's element in the box grab look.
function closePair() {
  const l = pairLook;
  pairLook = null;
  if (!l) return;
  try { l.unregister(); } catch { /* gone */ }
  l.el.remove();
}
async function openPair(g) {
  closePair();
  const id = g.pin.id;
  const el = document.createElement('div');
  el.className = 'popover bg-look';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Ink in the margin');
  el.dataset.element = id;
  const h = document.createElement('h4');
  h.textContent = 'Ink in the margin — with and without it';
  el.append(h);
  const entry = { el, unregister: () => {} };
  const frames = [];
  for (const [which, alt] of [['with', 'The page with the ink'], ['without', 'The same place without the ink']]) {
    const frame = document.createElement('div');
    frame.className = 'bg-look-frame';
    const img = document.createElement('img');
    img.className = 'bg-look-img';
    img.alt = alt;
    img.decoding = 'async';
    img.dataset.which = which;
    // A GET that answers no picture (a 404, withdrawn since): not shown.
    img.addEventListener('error', () => {
      frame.remove();
      if (pairLook !== entry || el.querySelector('img.bg-look-img')) return;
      closePair();
      // No picture left: the group is drawn faded again until it is asked again.
      pictures.set(g.pin.pk, { state: 'none', type: g.type });
      requestDraw();
    }, { once: true });
    img.src = picturePath(id, which);
    frame.append(img);
    frames.push(frame);
  }
  const acts = document.createElement('div');
  acts.className = 'bg-look-acts';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'bg-close';
  close.textContent = 'Close';
  close.addEventListener('click', () => { if (pairLook === entry) closePair(); });
  acts.append(close);
  el.append(...frames, acts);
  pairLook = entry;
  let shell;
  try { shell = await import('./shell.js'); } catch (err) {
    console.error('[web-chat] overlay: the shell module did not load', err);
    if (pairLook === entry) pairLook = null;
    return null;
  }
  if (pairLook !== entry) return null;
  document.body.appendChild(el);
  entry.unregister = shell.registerPopover({ el, close: () => { if (pairLook === entry) closePair(); } });
  return el;
}
// pageRecordView(type, rec) → what a draw's record(id) answers for rec
// (element-types.js recordOf hands every plug-in record through here): a page
// stroke's flat record (U522b) with points, width and aspect replaced by its
// mapping into its group's CURRENT box (the last measure's: reboxPoints from
// its own mapped box to the group's, J2 (a)), a fresh frozen object per call;
// null while it is unplaced (orphaned, its items unmeasured); any other record
// as it is.
export function pageRecordView(type, rec) {
  if (!rec || typeof rec !== 'object' || !isPageRecord(rec.anchor)) return rec;
  const v = pageViews.get(String(rec.id));
  if (!v || v.src !== rec || v.type !== type) return null;
  return Object.freeze({ ...rec, points: v.points, width: v.width, aspect: v.aspect });
}

// A host's drawn set as marker groups: per type, the elements grouped by the
// DOM element they resolve to (a range or a section, one group each). The
// page's are the drawn scope's answers; another host's, its own answers (the
// live set's, whatever the scope). No box read.
function buildGroups(h) {
  const byKey = new Map();
  const M = window.__wcMount;
  const list = h.page ? answers.values() : h.answers.values();
  for (const e of list) {
    if ((h.page && e.scope !== drawnScope) || !e.rule || e.rule.draw === 'none' || e.row.pending) continue;
    const kind = e.rule.draw;
    const raw = e.raw;
    let el = null;
    let range = null;
    // Whether el is the element the row's anchor resolved to (its hit or its
    // carried guess), never the item's box a fallback stands in with: only
    // such an element may size a box marker (boxRow).
    let own = false;
    if (kind === 'guess') { el = raw.guess; own = true; }
    else if (raw.range) range = raw.range;
    else if (raw.el) { el = raw.el; own = true; }
    // A row served masked: at the element the resolver's own pass found (its
    // range or element above, else its carried guess), else at its item's box.
    else if (e.masked && raw.guess) { el = raw.guess; own = true; }
    else if (h.page && (kind === 'section' || e.masked) && e.mount != null && M && typeof M.itemEl === 'function') {
      const it = M.itemEl(document, e.mount);
      el = it ? it.el : null;
    }
    if (!el && !range) continue;
    const type = e.row.type || 'element';
    // Keyed by the DOM position it answers: an element by its identity, a
    // range by its boundary points (each container's identity and offset),
    // never by the Range object — the resolver builds a fresh Range every
    // pass, and a key on it would rebuild every marker in the layer on a pass
    // that moved nothing (F11). A re-render that replaced the text keeps no
    // container, so its key changes and the group is rebuilt over the new
    // Range; a kept group takes the pass's current Range (refreshKept).
    // A box group (boxRow) is keyed apart from any glyph group on the same
    // element, so a type re-registered with another place rebuilds it.
    const box = own && boxRow(type, e.row);
    // A pane-framed box row (U614) reports its aspect's drift against its
    // stored record's: the records' module is loaded at the first one.
    if (box && !typesApi && frameKindOf(e.row.anchor) === 'pane') loadTypes();
    // A point answer (4C.1, U532) is keyed by its element AND its point, so
    // two points on one svg are two markers; the group keeps pt for pointAt.
    const pt = own && el && e.row.anchor && e.row.anchor.kind === 'point' ? pointOfAnswer(raw) : null;
    // A detached type's glyph (U587): its offset is the live row's display (an
    // answer holds the row it was delivered for; a move upserts a newer one),
    // and rows on one element with different offsets are separate markers.
    const det = h.page && !box && detachable(type);
    const cur = det ? (scopes[e.scope] && scopes[e.scope].rows.get(e.row.id)) || e.row : null;
    const off = cur && cur.display ? cur.display.glyph : null;
    const dkey = off ? `|d${off.dx},${off.dy},${off.corner}` : '';
    const key = el ? `${type}|${kind}|e${tokenOf(el)}${box ? '|box' : ''}${pt ? `|p${pt.x},${pt.y}` : ''}${dkey}` : `${type}|${kind}|${rangeKey(range)}${dkey}`;
    let g = byKey.get(key);
    if (!g) {
      const mdItem = h.page && range ? marginItemOf(type, range) : null;
      g = { key, type, kind, cls: e.rule.cls, el, range, mount: e.mount, scope: e.scope, host: h.name, items: [],
        container: null, glyph: mdItem ? marginGlyph(type) : glyphOf(type, h.page ? null : h), mdItem, failed: false };
      if (pt) g.pt = pt;
      if (det) { g.detach = true; g.offset = off; }
      if (box) {
        g.place = 'box';
        g.drawn = false;
        g.boxW = 0;
        g.boxH = 0;
        g.box = Object.freeze({ get w() { return g.boxW; }, get h() { return g.boxH; } });
      }
      byKey.set(key, g);
    }
    g.items.push({ id: e.row.id, v: e.row.v, type, row: e.row, state: e.state, how: raw.how == null ? null : raw.how,
      answer: raw });
  }
  if (h.page) buildPageArm(byKey);
  const out = [...byKey.values()];
  for (const g of out) g.items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // THE DENSITY RULE (U587): past LEADER_PANE_MAX detached glyphs on one pane,
  // their leaders collapse to 'hover'.
  const perMount = new Map();
  for (const g of out) if (g.detach && g.offset) perMount.set(g.mount, (perMount.get(g.mount) || 0) + 1);
  for (const g of out) if (g.detach && g.offset && perMount.get(g.mount) > LEADER_PANE_MAX) g.dense = true;
  return out;
}
// A host's signature: the page's as it always was (its drawn scope first); a
// host's also carries each row's daemon answer (its state, line and how), so
// a changed explanation rebuilds the marker that shows it.
function sigOf(h, gs) {
  const head = h.page ? drawnScope : 'live';
  return head + '#' + gs.map((g) => g.key + ':' + g.items.map((it) => {
    const r = it.row;
    const own = `${it.id}@${it.v}:${it.state}:${r.shared ? 1 : 0}${r.answered ? 1 : 0}:${r.replies}`;
    if (h.page) return own;
    const a = r.answer;
    return a ? `${own}:${a.state}~${a.how}~${a.explain}~${a.note}` : own;
  }).join(',')).join('|');
}
// One delegated click on each layer for every marker: a carried guess, or a
// section fallback (K.2-74), is offered to the re-anchor seam; `how` says
// which (a host's group also names its host).
function onLayerClick(ev) {
  const m = ev.target && ev.target.closest ? ev.target.closest('.el-marker') : null;
  const g = m && m._group;
  // A phone pin's tap (U629) opens its pair.
  if (g && g.pin) { ev.stopPropagation(); openPair(g); return; }
  if (!g || (g.kind !== 'guess' && g.kind !== 'section')) return;
  ev.stopPropagation();
  for (const it of g.items) {
    const d = { id: it.id, v: it.v, type: it.type, mount: g.mount, scope: g.scope, how: g.kind };
    if (g.host && g.host !== 'page') d.host = g.host;
    bus.emit('overlay:guess', d);
  }
}
// A box group's ctx also carries `box`: {w, h}, the target's rect at the last
// measure, read live (the same frozen object answers the newest measure). No
// ctx carries the host's layer (U632, H9 = a: withdrawn in both realms, one
// draw-ctx shape): a type writes only into its group's containers.
function drawCtx(g) {
  const ctx = {
    host: g.host || 'page', scope: g.scope, glyph: g.glyph, previewing: view.previewing,
    rectOf: (x) => cfg.rectOf(x),
    rectsOf: (range) => (range && typeof range.getClientRects === 'function' ? [...range.getClientRects()] : []),
  };
  if (g.place === 'box') ctx.box = g.box;
  if (g.blend) ctx.blend = g.blend;
  return ctx;
}
// A type's draw into its group's container, walked by the marker allowlist
// once it returns; false (the container gone, the failure recorded) when it
// threw.
function runDraw(g, t) {
  try {
    const before = stylesOf(g);
    t.draw(g, drawCtx(g));
    reachWalk(g, before, 'draw');
    return true;
  } catch (err) {
    console.error(`[web-chat] overlay: the '${g.type}' draw failed`, err);
    if (g.container) g.container.remove();
    g.container = null;
    dropBlend(g);
    g.failed = true;
    for (const it of g.items) failed.set(it.id, { type: g.type, error: String((err && err.message) || err) });
    return false;
  }
}
// THE MARKER ALLOWLIST's walk (the header's paragraph). allowlistWalk(root,
// style?) → the nodes and attributes it removed under root (root's own
// attributes included; `style` is what root's style is put back to when the
// walk refuses it, else it is removed). reachWalk(g, before, what) walks both
// of a group's containers, counts, and names the type once.
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const MARKER_EL = new Map([[SVG_NS, new Set(MARKER_ALLOWLIST.svg)], [XHTML_NS, new Set(MARKER_ALLOWLIST.html)]]);
const URL_NAMES = new Set(['href', 'src', 'srcset']);
const INERT_NAMES = new Set(MARKER_INERT_ATTRS.filter((n) => !n.endsWith('*')));
const ASCII_WS = /[\t\n\f\r ]/g;
const domWarned = new Set();
function refusedValue(v) {
  const x = v.toLowerCase();
  return x.includes('url(') || x.includes('image-set(') || x.includes('\\') || x.replace(ASCII_WS, '').includes('javascript:');
}
function refusedAttr(a) {
  const n = a.localName.toLowerCase();
  if (URL_NAMES.has(n) || n.startsWith('on')) return true;
  if (INERT_NAMES.has(n) || n.startsWith('aria-') || n.startsWith('data-')) return false;
  return refusedValue(a.value);
}
function walkAttrs(el, style) {
  let n = 0;
  const as = el.attributes;
  for (let i = as.length - 1; i >= 0; i--) {
    const a = as[i];
    if (!refusedAttr(a)) continue;
    n++;
    if (style && a.localName === 'style' && !a.namespaceURI && !refusedValue(style)) el.setAttribute('style', style);
    else el.removeAttributeNode(a);
  }
  return n;
}
export function allowlistWalk(root, style) {
  if (!root || root.nodeType !== 1) return 0;
  let n = walkAttrs(root, typeof style === 'string' ? style : null);
  const stack = [...root.children];
  if (root.shadowRoot) stack.push(...root.shadowRoot.children);
  while (stack.length) {
    const el = stack.pop();
    const ok = MARKER_EL.get(el.namespaceURI);
    if (!ok || !ok.has(el.localName)) { el.remove(); n++; continue; }
    n += walkAttrs(el, null);
    for (const c of el.children) stack.push(c);
    if (el.shadowRoot) stack.push(...el.shadowRoot.children);
  }
  return n;
}
function stylesOf(g) {
  return [g.container ? g.container.getAttribute('style') || '' : '', g.blend ? g.blend.getAttribute('style') || '' : ''];
}
function reachWalk(g, before, what) {
  const n = allowlistWalk(g.container, before[0]) + allowlistWalk(g.blend, before[1]);
  if (!n) return;
  totals.dom_refused += n;
  if (domWarned.has(g.type)) return;
  domWarned.add(g.type);
  console.warn(`[web-chat] overlay: the '${g.type}' ${what} wrote what the marker allowlist refuses; removed`);
}
// A glyph-sized marker (a type's glyph, or THE PHONE PIN): sized and offset
// by g.glyph, hidden until its first measure, and made the group's container
// (one helper for both of rebuild's glyph branches; HAND FOLD 8, U690).
function glyphContainer(g, c) {
  const gl = g.glyph;
  c.style.width = gl.w + 'px';
  c.style.height = gl.h + 'px';
  c.style.transform = `translate(${gl.dx}px, ${gl.dy}px)`;
  c.style.display = 'none';
  c._group = g;
  g.container = c;
}
function rebuild(h, gs) {
  const layer = h.layer;
  for (const m of [...layer.querySelectorAll('.el-marker, .el-leader')]) m.remove();
  if (h.page && blendLayer) blendLayer.replaceChildren();
  if (h.page) hoverable.clear();
  for (const g of gs) {
    const c = document.createElement('div');
    c.className = `el-marker ${g.cls}`;
    c.dataset.type = g.type;
    c.dataset.elIds = g.items.map((it) => it.id).join(' ');
    const t = types.get(g.type);
    // THE PHONE PIN (U629): a glyph marker the overlay draws, taking a press.
    if (g.pin) {
      glyphContainer(g, c);
      drawPin(g, c);
      layer.appendChild(c);
      continue;
    }
    if (g.place === 'box' && t) {
      // A box marker: applyGroup sizes and places it at each measure, and the
      // type's draw runs at its first drawn placement (so ctx.box is a real
      // rect), then again only when the signature changes. It never takes a
      // press: the target under it stays the page's and the armed tool's.
      c.dataset.place = 'box';
      if (g.page) c.dataset.elFrame = 'page';   // THE PAGE ARM's marker (U614): F4's own row
      c.style.pointerEvents = 'none';
      c.style.display = 'none';
      c._group = g;
      g.container = c;
      layer.appendChild(c);
      if (h.page && t.composite && blendLayer) {
        const b = document.createElement('div');
        b.className = 'el-blend';
        b.dataset.elIds = c.dataset.elIds;
        b.style.display = 'none';
        g.blend = b;
        blendLayer.appendChild(b);
      }
      continue;
    }
    glyphContainer(g, c);
    // A detached glyph's leader (U587): drawn under the markers, placed by
    // applyGroup at each measure.
    if (g.detach) {
      c.dataset.detach = '1';
      g.leader = leaderEl();
      layer.appendChild(g.leader);
    }
    layer.appendChild(c);
    if (t) runDraw(g, t);
    else {
      c.classList.add('el-generic');
      c.title = g.type;
      const s = document.createElement('span');
      s.className = 'el-generic-name';
      s.textContent = g.type;
      c.appendChild(s);
    }
  }
  if (h.page) syncBlendLayer();
}
// The blend layer is hidden while it holds no group.blend (so a page with no
// opting type composites as it did before U624).
function syncBlendLayer() {
  if (blendLayer) blendLayer.hidden = !blendLayer.firstChild;
}
function dropBlend(g) {
  if (!g.blend) return;
  g.blend.remove();
  g.blend = null;
  syncBlendLayer();
}
// group.blend takes group.container's placement (THE BLEND PER MARKER PART):
// written after applyGroup on every pass, and by hide. A container the gate
// turned into a stand-in (its draw failed or parked) leaves no blended path.
const BLEND_STYLE = Object.freeze(['left', 'top', 'width', 'height', 'clipPath', 'display']);
function syncBlend(g) {
  const b = g.blend;
  if (!b) return;
  const c = g.container;
  if (!c) { b.style.display = 'none'; return; }
  for (const k of BLEND_STYLE) b.style[k] = c.style[k];
  b.classList.toggle('el-guess', g.kind === 'guess');
  if (b.firstChild && c.classList.contains('el-standin')) b.replaceChildren();
}
// The blend's mode follows the theme's effective mode (light: multiply; dark:
// screen).
function setBlendMode(mode) {
  if (blendLayer) blendLayer.style.mixBlendMode = mode === 'dark' ? 'screen' : COMPOSITE_MODES[0];
}

export function requestDraw() {
  if (!layer) return;
  if (pass) { drawAgain = true; return; }
  if (drawPending) return;
  drawPending = true;
  cfg.raf(drawFrame);
}

function intersect(a, b) {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
}
function boxOf(r) {
  return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height };
}
// One frame's reads: every box read goes through here and is counted.
function reader(fr) {
  return (x) => {
    fr.reads++;
    return cfg.rectOf(x);
  };
}
// The client box of a clipping element (its border box less borders and
// scrollbars, when the browser reports them), or null when it clips nothing.
function clipBoxOf(el, fr, read, well) {
  const isWell = el === well;
  const cache = isWell ? fr.wellCache : fr.clipCache;
  if (cache.has(el)) return cache.get(el);
  let box = null;
  if (isWell || cfg.clips(el)) {
    const r = read(el);
    if (r) {
      box = boxOf(r);
      if (el.clientWidth > 0 || el.clientHeight > 0) {
        const l = r.left + (el.clientLeft || 0);
        const t = r.top + (el.clientTop || 0);
        box = { left: l, top: t, right: l + el.clientWidth, bottom: t + el.clientHeight };
      }
    }
  }
  cache.set(el, box);
  return box;
}
// The clip of an anchor: the viewport ∩ the well (its host's: #main for the
// page) ∩ every overflow-clipping ancestor from `start` up through each
// shadow host to the document.
function clipFrom(start, fr, read, well) {
  let byStart = fr.startCache.get(well);
  if (!byStart) { byStart = new Map(); fr.startCache.set(well, byStart); }
  if (byStart.has(start)) return byStart.get(start);
  let clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  if (well) {
    const w = clipBoxOf(well, fr, read, well);
    if (w) clip = intersect(clip, w);
  }
  const de = document.documentElement;
  for (let n = start; n && n !== de && n.nodeType !== 9;) {
    if (n.nodeType === 11) { n = n.host || null; continue; }
    if (n.nodeType === 1 && n !== well && n !== document.body) {
      const b = clipBoxOf(n, fr, read, well);
      if (b) clip = intersect(clip, b);
    }
    n = n.parentNode;
  }
  byStart.set(start, clip);
  return clip;
}
// One frame's reading state: its read count and the clip caches (per well).
// THE PAGE ARM's (U614): pageWrap the well a page group is clipped to (the
// .well-wrap holding #main, else #main), itemRects each endpoint item's rect
// read once, pageCensus the page census.
function frameOf() {
  const main = $('main');
  return { reads: 0, clipCache: new Map(), wellCache: new Map(), startCache: new Map(), pageWell: main,
    census: null, shadowCensus: new Map(), pageWrap: wellWrapOf(main), itemRects: new Map(), pageCensus: null };
}
// The page's well: the .well-wrap that holds #main (its column's padding and,
// on a wide window, the gutters beside it: REQ@margins (a)), else #main.
function wellWrapOf(main) {
  return main ? (typeof main.closest === 'function' && main.closest('.well-wrap')) || main : null;
}
// The well a group is clipped to: the page's #main, or its host's well (an
// element, or fn(group) → element). A well that is a frame, or lies in another
// document, is no well: the group is not placed (the never-draw rule).
function wellOf(g, fr) {
  if (!g.host || g.host === 'page') return fr.pageWell;
  const h = registry.get(g.host);
  if (!h) return undefined;
  let w = h.well;
  if (typeof w === 'function') {
    try { w = w(g); } catch (err) {
      console.error(`[web-chat] overlay: the '${h.name}' host's well failed`, err);
      return undefined;
    }
  }
  return w == null ? null : (frameReason(w) ? undefined : w);
}
function hide(g) {
  if (g.container) g.container.style.display = 'none';
  if (g.blend) g.blend.style.display = 'none';
  if (g.leader) { g.leader.style.display = 'none'; hoverable.delete(g); }
}

// ── the never-draw rule (3C.1 finding (6)) ──────────────────────────────────
const FRAME_TAGS = new Set(['iframe', 'frame']);
// Why an element can be no host's root or well: it is a frame, lies inside
// one, or belongs to another document than the chrome's (a sandboxed or
// cross-origin frame's). Null when it may be one. Exported read-only (U516)
// so the wet layer (U517) applies the never-draw rule with no second copy.
export function frameReason(el) {
  if (!el || el.nodeType !== 1) return 'not an element';
  if (el.ownerDocument !== document) return 'in another document';
  if (FRAME_TAGS.has(el.localName)) return 'a frame';
  if (typeof el.closest === 'function' && el.closest('iframe, frame')) return 'inside a frame';
  return null;
}
// Whether a census frame is shown: no [hidden] or .hidden on it or on any
// ancestor up through each shadow host (a DOM walk, no read); its box is read
// after (a zero box is not shown).
function frameShown(el) {
  for (let n = el; n;) {
    if (n.nodeType === 11) { n = n.host || null; continue; }
    if (n.nodeType !== 1) break;
    if (n.hasAttribute('hidden') || (n.classList && n.classList.contains('hidden'))) return false;
    if (n.style && n.style.display === 'none') return false;
    n = n.parentNode;
  }
  return true;
}
// The boxes of the displayed frames among `els` (each read counted).
function frameBoxes(els, read) {
  const out = [];
  for (const el of els) {
    if (!el.isConnected || !frameShown(el)) continue;
    const r = read(el);
    if (!r) continue;
    const b = boxOf(r);
    if (b.right > b.left && b.bottom > b.top) out.push(b);
  }
  return out;
}
// The frame's census, taken once per draw frame at its first need: the
// connected iframes of the document's light DOM (the answer and control
// frames, the preview and glance frames, the replay's) — and, for a page
// group, the iframes in its pane's shadow root (a pane's own iframe).
function censusFor(g, startEl, fr, read) {
  if (!fr.census) fr.census = frameBoxes([...document.querySelectorAll('iframe, frame')], read);
  if (g.host && g.host !== 'page') return fr.census;
  const root = startEl && startEl.getRootNode ? startEl.getRootNode() : null;
  if (!root || root.nodeType !== 11) return fr.census;
  let own = fr.shadowCensus.get(root);
  if (!own) {
    own = frameBoxes([...root.querySelectorAll('iframe, frame')], read);
    fr.shadowCensus.set(root, own);
  }
  return own.length ? fr.census.concat(own) : fr.census;
}
function meets(a, b) {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}
// Whether any client rect of a range meets the clip (one read, counted).
function anyRectIn(range, clip, fr) {
  if (!range || typeof range.getClientRects !== 'function') return false;
  fr.reads++;
  let rs;
  try { rs = range.getClientRects(); } catch { return false; }
  for (const r of rs || []) {
    const right = r.right != null ? r.right : r.left + r.width;
    const bottom = r.bottom != null ? r.bottom : r.top + r.height;
    if (right > clip.left && r.left < clip.right && bottom > clip.top && r.top < clip.bottom) return true;
  }
  return false;
}
// Measure one group — READS ONLY: its anchor's box and its clip, and the
// glyph's inset against that clip. Returns {res: 'drawn' | 'clipped' |
// 'unplaced', x, y, clip, inset}; nothing is written until the frame's whole
// slice is measured (applyGroup), so reads and writes never interleave.
// THE PLACEMENT RULE: a glyph group (a pin) is placed while its anchor point
// is inside the clip and some of its glyph shows; a RANGE group whose type has
// a move seam is placed while ANY of its client rects meets the clip (K.2-74),
// so a multi-line range whose start scrolled out keeps its visible rectangles
// (the glyph, then wholly outside, is inset away entirely).
function measureGroup(g, fr, read) {
  if (!g.container) return { res: 'unplaced' };
  if (g.page) return measurePage(g, fr, read);
  const well = wellOf(g, fr);
  if (well === undefined) return { res: 'unplaced' };
  if (well && g.host && g.host !== 'page') observeWell(well, g.host);
  let startEl;
  if (g.range) {
    const sc = g.range.startContainer;
    if (!sc || !sc.isConnected) return { res: 'unplaced' };
    startEl = sc.nodeType === 1 ? sc : sc.parentNode;
  } else {
    if (!g.el || !g.el.isConnected) return { res: 'unplaced' };
    startEl = g.el.parentNode;
  }
  const rootNode = startEl && startEl.getRootNode ? startEl.getRootNode() : null;
  if (rootNode && rootNode.nodeType === 11 && !scrollRoots.has(rootNode)) {
    scrollRoots.add(rootNode);
    rootNode.addEventListener('scroll', requestDraw, { capture: true, passive: true });
  }
  const r = read(g.range || g.el);
  if (!r || (r.width === 0 && r.height === 0 && r.left === 0 && r.top === 0)) return { res: 'unplaced' };
  if (g.place === 'box') {
    const mb = measureBox(g, r, startEl, fr, read, well);
    mb.drift = paneDrift(g, r);
    return mb;
  }
  let x = r.left;
  let y = r.top;
  // A point group (4C.1, U532): the glyph's anchor point at the stored point
  // mapped onto the target's rect now (pointAt), not the rect's top-left.
  if (g.pt) {
    const p = pointPlace(g.pt, r);
    if (!p) return { res: 'unplaced' };
    x = p.x;
    y = p.y;
  }
  // The margin glyph (marginItemOf): the anchor point is the item's left edge
  // at the range's first line.
  if (g.mdItem) {
    if (!g.mdItem.isConnected) return { res: 'unplaced' };
    const ir = read(g.mdItem);
    if (!ir) return { res: 'unplaced' };
    x = ir.left;
  }
  // A detached glyph (U587): at its offset from the corner of the anchor's box
  // it is measured from — a drag's live offset while one is under way — so it
  // follows its anchor through a re-layout; the box is kept for its leader.
  let abox = null;
  let off = null;
  if (g.detach) {
    abox = g.pt ? { left: x, top: y, right: x, bottom: y }
      : { left: x, top: y, right: Math.max(x, r.left + r.width), bottom: Math.max(y, r.top + r.height) };
    off = (drag && drag.started && drag.key === g.key && drag.offset) || g.offset;
    if (off) {
      const c = cornerOf(abox, off.corner);
      x = c.x + off.dx;
      y = c.y + off.dy;
    }
  }
  const clip = clipFrom(startEl, fr, read, well);
  const t = g.range ? types.get(g.type) : null;
  const spans = !!(t && t.move);
  const startIn = x >= clip.left && x < clip.right && y >= clip.top && y < clip.bottom;
  if (!startIn && !(spans && anyRectIn(g.range, clip, fr))) return { res: 'clipped' };
  const gl = g.glyph;
  const gx = x + gl.dx;
  const gy = y + gl.dy;
  const top = Math.max(0, clip.top - gy);
  const left = Math.max(0, clip.left - gx);
  const right = Math.max(0, gx + gl.w - clip.right);
  const bottom = Math.max(0, gy + gl.h - clip.bottom);
  if (top + bottom >= gl.h || left + right >= gl.w) {
    if (!spans) return { res: 'clipped' };
    return { res: 'drawn', x, y, clip, inset: [gl.h, 0, 0, 0] };
  }
  // THE NEVER-DRAW RULE: a glyph whose painted box meets a displayed frame is
  // not drawn (a range with a move keeps its rectangles, its glyph inset away).
  const painted = { left: gx + left, top: gy + top, right: gx + gl.w - right, bottom: gy + gl.h - bottom };
  const frames = censusFor(g, startEl, fr, read);
  if (frames.some((b) => meets(painted, b))) {
    if (!spans) return { res: 'framed' };
    return { res: 'drawn', x, y, clip, inset: [gl.h, 0, 0, 0], framed: true };
  }
  const m = { res: 'drawn', x, y, clip, inset: [top, right, bottom, left] };
  if (abox) {
    m.abox = abox;
    m.gbox = { left: gx, top: gy, right: gx + gl.w, bottom: gy + gl.h };
    if (off) m.leader = leaderOfBoxes(abox, m.gbox, clip, frames);
  }
  return m;
}
// ── the detachable glyph's geometry (U587) ─────────────────────────────────
// A box's corner (GLYPH_CORNERS) as a point.
function cornerOf(b, corner) {
  return { x: corner === 'tr' || corner === 'br' ? b.right : b.left, y: corner === 'bl' || corner === 'br' ? b.bottom : b.top };
}
// The offset {dx, dy, corner} of point p from the corner of box b nearest it,
// rounded to the half px and bounded (the daemon's grammar).
function offsetFrom(p, b) {
  let best = null;
  for (const corner of GLYPH_CORNERS) {
    const c = cornerOf(b, corner);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (!best || d < best.d) best = { d, c, corner };
  }
  const step = (n) => Math.max(-GLYPH_OFFSET_MAX, Math.min(GLYPH_OFFSET_MAX, Math.round(n * 2) / 2)) + 0;
  return Object.freeze({ dx: step(p.x - best.c.x), dy: step(p.y - best.c.y), corner: best.corner });
}
const clampTo = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// THE GLYPH CLAMP (U631): the offset of a dragged point p from box b's nearest
// corner (offsetFrom, its grammar untouched), the point first clamped so the
// glyph gl {dx, dy, w, h} painted there lies inside `clip` and its anchor point
// does too (measureGroup's start test: left/top inclusive, right/bottom not);
// a clip narrower (shorter) than the glyph clamps to its left (top) edge. The
// half-px rounding is nudged back inside. No clip (never drawn): as offsetFrom.
function clampedOffset(p, b, clip, gl) {
  if (!clip || !gl) return offsetFrom(p, b);
  const span = (lo, hi, d, w) => ({ lo: Math.max(lo - d, lo), hi: Math.min(hi - d - w, hi - 0.5) });
  const bx = span(clip.left, clip.right, gl.dx, gl.w);
  const by = span(clip.top, clip.bottom, gl.dy, gl.h);
  const off = offsetFrom({ x: clampTo(p.x, bx.lo, bx.hi), y: clampTo(p.y, by.lo, by.hi) }, b);
  const c = cornerOf(b, off.corner);
  const fit = (d, at, r) => {
    if (r.hi - r.lo < 0.5) return d;
    const n = at + d > r.hi ? d - 0.5 : at + d < r.lo ? d + 0.5 : d;
    return Math.max(-GLYPH_OFFSET_MAX, Math.min(GLYPH_OFFSET_MAX, n)) + 0;
  };
  const dx = fit(off.dx, c.x, bx);
  const dy = fit(off.dy, c.y, by);
  return dx === off.dx && dy === off.dy ? off : Object.freeze({ dx, dy, corner: off.corner });
}
// The part of segment a→b inside box (Liang–Barsky), or null.
function clipSegment(a, b, box) {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - box.left, box.right - a.x, a.y - box.top, box.bottom - a.y];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return { a: { x: a.x + t0 * dx, y: a.y + t0 * dy }, b: { x: a.x + t1 * dx, y: a.y + t1 * dy } };
}
// THE LEADER: from the nearest edge point of the anchor's box to the glyph's
// box, clipped to the group's clip; `near` when the glyph is within
// LEADER_NEAR_PX of its anchor; `framed` when what is left crosses a displayed
// frame (it is then not drawn: never over a frame).
function leaderOfBoxes(abox, gbox, clip, frames) {
  const cx = (gbox.left + gbox.right) / 2;
  const cy = (gbox.top + gbox.bottom) / 2;
  const s = { x: clampTo(cx, abox.left, abox.right), y: clampTo(cy, abox.top, abox.bottom) };
  const e = { x: clampTo(s.x, gbox.left, gbox.right), y: clampTo(s.y, gbox.top, gbox.bottom) };
  const near = Math.hypot(e.x - s.x, e.y - s.y) <= LEADER_NEAR_PX;
  const seg = clipSegment(s, e, clip);
  if (!seg) return { empty: true, near };
  const framed = frames.some((f) => !!clipSegment(seg.a, seg.b, f));
  return { sx: seg.a.x, sy: seg.a.y, ex: seg.b.x, ey: seg.b.y, near, framed };
}
// Measure a box group (boxRow) — READS ONLY, past measureGroup's shared
// checks: the target's rect `r` ∩ its clip (clipFrom) is the painted box,
// empty → 'clipped'; a painted box meeting a displayed frame in the census →
// 'framed' (THE NEVER-DRAW RULE: a box is never drawn over a frame, in part or
// whole); else 'drawn' with the target's rect {x, y, w, h} and the clip's
// insets [top, right, bottom, left] into it.
function measureBox(g, r, startEl, fr, read, well) {
  const target = boxOf(r);
  const clip = clipFrom(startEl, fr, read, well);
  const painted = intersect(target, clip);
  if (!(painted.right > painted.left && painted.bottom > painted.top)) return { res: 'clipped' };
  if (censusFor(g, startEl, fr, read).some((b) => meets(painted, b))) return { res: 'framed' };
  const inset = [painted.top - target.top, target.right - painted.right, target.bottom - painted.bottom, painted.left - target.left];
  return { res: 'drawn', box: true, x: r.left, y: r.top, w: r.width, h: r.height, clip, inset };
}
const round3 = (v) => Math.round(v * 1e3) / 1e3;
// A pane-framed box group's drift (U614, DRIFT@beside; strokes.js frameKindOf
// 'pane'): the relative change of its target's w ÷ h now against the stored
// record's aspect, the members' largest, rounded to 1e-3; null for a group
// with no pane-framed member whose record carries an aspect.
function paneDrift(g, r) {
  if (!r || !(r.width > 0) || !(r.height > 0)) return null;
  let d = null;
  for (const it of g.items) {
    if (frameKindOf(it.row && it.row.anchor) !== 'pane') continue;
    const rec = rawRecordOf(g.type, it.id);
    if (!rec || !(typeof rec.aspect === 'number' && rec.aspect > 0)) continue;
    const v = Math.abs(r.width / r.height / rec.aspect - 1);
    if (d == null || v > d) d = v;
  }
  return d == null ? null : round3(d);
}
// The page census (U614): the document's displayed frames and every pane's
// own (each .mount-host's shadow root under #main), taken once per frame.
function pageCensus(fr, read) {
  if (fr.pageCensus) return fr.pageCensus;
  if (!fr.census) fr.census = frameBoxes([...document.querySelectorAll('iframe, frame')], read);
  let all = fr.census;
  const main = fr.pageWell;
  if (main) {
    for (const host of main.querySelectorAll('.mount-host')) {
      const root = host.shadowRoot;
      if (!root) continue;
      let own = fr.shadowCensus.get(root);
      if (!own) {
        own = frameBoxes([...root.querySelectorAll('iframe, frame')], read);
        fr.shadowCensus.set(root, own);
      }
      if (own.length) all = all.concat(own);
    }
  }
  fr.pageCensus = all;
  return all;
}
// The part of each box in `boxes` outside box f, as disjoint boxes (at most
// four per box f meets).
function subtractBox(boxes, f) {
  const out = [];
  for (const b of boxes) {
    if (!meets(b, f)) { out.push(b); continue; }
    if (f.top > b.top) out.push({ left: b.left, top: b.top, right: b.right, bottom: f.top });
    if (f.bottom < b.bottom) out.push({ left: b.left, top: f.bottom, right: b.right, bottom: b.bottom });
    const top = Math.max(b.top, f.top);
    const bottom = Math.min(b.bottom, f.bottom);
    if (f.left > b.left) out.push({ left: b.left, top, right: f.left, bottom });
    if (f.right < b.right) out.push({ left: f.right, top, right: b.right, bottom });
  }
  return out;
}
// THE MASK (PAGE@mask-frames): disjoint client boxes as one clip-path path()
// in the marker's own px (its border box from x, y), each edge rounded INWARD
// to 1e-3 px so no rounding paints over a frame.
function maskPath(boxes, x, y) {
  const inLo = (v) => Math.ceil(v * 1e3) / 1e3;
  const inHi = (v) => Math.floor(v * 1e3) / 1e3;
  let d = '';
  for (const b of boxes) {
    const l = inLo(b.left - x);
    const t = inLo(b.top - y);
    const r = inHi(b.right - x);
    const bt = inHi(b.bottom - y);
    if (r > l && bt > t) d += `M${l} ${t}H${r}V${bt}H${l}Z`;
  }
  return d ? `path("${d}")` : null;
}
// Measure a page group (THE PAGE ARM, U614) — READS ONLY: each member's
// endpoint items' rects (once per frame per item, through the frame's reader),
// each member mapped by mapPage, the group's box their union; the clip is the
// well's (.well-wrap's visible box ∩ the viewport ∩ each clipping ancestor of
// the well), never a pane's; a displayed frame of the page census meeting the
// painted box masks it (`mask`, the painted box less every meeting frame, as
// disjoint boxes) — 'framed' only when nothing of it is left or the mask would
// pass MASK_RECTS_MAX. Every answer that mapped carries `views` (the members'
// records mapped into the group's box), `kind` ('guess' when a member's
// mapping answered guess, or the build said so), `shape` (the mapped shape's
// key: the draw runs again when it changes) and `drift`.
function measurePage(g, fr, read) {
  const wrap = fr.pageWrap;
  if (!wrap || !wrap.isConnected) return { res: 'unplaced' };
  const rectOfItem = (el) => {
    if (!el || !el.isConnected) return null;
    if (fr.itemRects.has(el)) return fr.itemRects.get(el);
    const r = read(el) || null;
    fr.itemRects.set(el, r);
    return r;
  };
  const maps = [];
  let guess = !!g.forceGuess;
  let drift = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const mb of g.members || []) {
    const mp = mapPage(mb.rec.anchor, mb.rec, rectOfItem(mb.fromEl), rectOfItem(mb.toEl));
    if (!mp || !mp.points) continue;
    maps.push([mb, mp]);
    if (mp.guess) guess = true;
    if (mp.drift > drift) drift = mp.drift;
    x0 = Math.min(x0, mp.box.left);
    y0 = Math.min(y0, mp.box.top);
    x1 = Math.max(x1, mp.box.left + mp.box.w);
    y1 = Math.max(y1, mp.box.top + mp.box.h);
  }
  if (!maps.length) return { res: 'unplaced' };
  // THE GUESS CLAMP (U629, G9 a): a margin stroke faded on a narrow screen is
  // moved across into the well's visible width (a wide window's gutter is
  // past a phone's well), every member by the same shift.
  if (g.narrowBeside) {
    const well = clipFrom(wrap, fr, read, wrap);
    const dx = clampShift(x0, x1, well.left, well.right);
    if (dx) {
      x0 += dx;
      x1 += dx;
      for (const pair of maps) pair[1] = { ...pair[1], box: { ...pair[1].box, left: pair[1].box.left + dx } };
    }
  }
  const box = { left: x0, top: y0, w: x1 - x0, h: y1 - y0 };
  const views = new Map();
  const shape = [round3(box.w), round3(box.h)];
  for (const [mb, mp] of maps) {
    const points = reboxPoints(mp.points, mp.box, box);
    if (!points) continue;
    views.set(mb.id, Object.freeze({ type: g.type, src: mb.rec, points: Object.freeze(points),
      width: mp.width * mp.box.w / box.w, aspect: box.w / box.h }));
    shape.push(mb.id, round3(mp.box.left - box.left), round3(mp.box.top - box.top), round3(mp.box.w), round3(mp.box.h),
      round3(mp.scale), round3(mp.angle));
  }
  const out = { views, kind: guess ? 'guess' : 'hit', shape: JSON.stringify(shape), drift: round3(drift) };
  const target = { left: box.left, top: box.top, right: box.left + box.w, bottom: box.top + box.h };
  const clip = clipFrom(wrap, fr, read, wrap);
  if (g.pin) return measurePin(g, out, box, clip, fr, read);
  const painted = intersect(target, clip);
  if (!(painted.right > painted.left && painted.bottom > painted.top)) return { ...out, res: 'clipped' };
  const frames = pageCensus(fr, read).filter((b) => meets(painted, b));
  let mask = null;
  if (frames.length) {
    let left = [painted];
    for (const f of frames) {
      left = subtractBox(left, f);
      if (left.length > MASK_RECTS_MAX) break;
    }
    if (!left.length || left.length > MASK_RECTS_MAX) return { ...out, res: 'framed' };
    mask = left;
  }
  const inset = [painted.top - target.top, target.right - painted.right, target.bottom - painted.bottom, painted.left - target.left];
  return { ...out, res: 'drawn', box: true, x: box.left, y: box.top, w: box.w, h: box.h, clip, inset, mask };
}
// A page group's measure written (applyGroup, before anything else): the
// members' mapped views (pageRecordView's cache; a member that did not map is
// unplaced: null), the kind its mapping answered (the marker's class follows,
// and the type draws again), and the shape key (a changed shape draws again).
function applyPage(g, m) {
  for (const mb of g.members || []) {
    const v = m.views && m.views.get(mb.id);
    if (v) pageViews.set(mb.id, v); else pageViews.delete(mb.id);
  }
  if (!m.views || g.pin) return;
  const c = g.container;
  if (m.kind && m.kind !== g.kind) {
    g.kind = m.kind;
    g.cls = m.kind === 'guess' ? 'el-guess' : 'el-hit';
    c.classList.toggle('el-guess', m.kind === 'guess');
    c.classList.toggle('el-hit', m.kind !== 'guess');
    g.drawn = false;
  }
  if (m.shape !== g.shapeKey) {
    g.shapeKey = m.shape;
    g.drawn = false;
  }
}
// Write one measured group: left/top and the glyph's clip-path, or hidden;
// then the type's move, if any. Runs only after the slice's reads. A box
// group's marker also takes the target's width and height, and its type's
// draw runs here at its first drawn placement (a draw that throws marks the
// measure unplaced, so the frame counts it as nothing drawn).
function applyGroup(g, m) {
  const c = g.container;
  if (!c) return;
  if (g.page) applyPage(g, m);
  // A detached group's every measure, a hidden one too (U631: the drop reads it).
  if (g.detach) g.lastRes = m.res;
  if (m.res !== 'drawn') { hide(g); return; }
  const [top, right, bottom, left] = m.inset;
  c.style.left = m.x + 'px';
  c.style.top = m.y + 'px';
  if (m.box) {
    c.style.width = m.w + 'px';
    c.style.height = m.h + 'px';
    g.boxW = m.w;
    g.boxH = m.h;
  }
  // A page group meeting a displayed frame is masked around it (its path
  // holds the clip too); every other marker is inset to its clip.
  const masked = m.mask ? maskPath(m.mask, m.x, m.y) : null;
  if (m.mask && !masked) { hide(g); m.res = 'framed'; return; }
  c.style.clipPath = masked || (top || right || bottom || left ? `inset(${top}px ${right}px ${bottom}px ${left}px)` : '');
  // DRIFT@beside (U614): a page group's, a pane-framed box group's; never shown.
  if (m.box) {
    if (typeof m.drift === 'number') c.setAttribute(DRIFT_ATTR, m.drift.toFixed(3));
    else if (c.hasAttribute(DRIFT_ATTR)) c.removeAttribute(DRIFT_ATTR);
  }
  const t = types.get(g.type);
  if (m.box && !g.drawn) {
    if (!t || !runDraw(g, t)) { m.res = 'unplaced'; return; }
    g.drawn = true;
  }
  c.style.display = '';
  if (g.detach) placeLeader(g, m);
  if (t && t.move && !g.pin) {
    const before = stylesOf(g);
    try { t.move(g, { ...drawCtx(g), x: m.x, y: m.y, clip: m.clip }); } catch (err) {
      console.error(`[web-chat] overlay: the '${g.type}' move failed`, err);
    }
    reachWalk(g, before, 'move');
  }
}

function drawFrame() {
  drawPending = false;
  if (!layer) return;
  const now = cfg.now;
  const t0 = now();
  if (!pass) {
    drawAgain = false;
    // A followed animation that ended with no end event (its element gone, a
    // cancel the engine never sent): the host settles here, re-placed below.
    for (const h of registry.values()) {
      if (h.animating.length && !stillAnimating(h)) { endFollow(h); if (!h.page) h.dirty = true; }
    }
    // Each dirty host's rows re-placed ONCE, at the frame's start (DOM queries
    // only: no box read), then every host's groups built — the page's first.
    for (const h of registry.values()) if (!h.page && h.dirty) replace(h);
    const list = [];
    for (const h of registry.values()) {
      const gs = buildGroups(h);
      const sig = sigOf(h, gs);
      if (sig !== h.lastSig) {
        h.lastSig = sig;
        h.groups = gs;
        rebuild(h, gs);
      } else refreshKept(h, gs);
      if (h.page) syncBoxTargets(h.groups);
      h.passCount = { drawn: 0, clipped: 0, guesses: 0, sections: 0, frame_hidden: 0 };
      for (const g of h.groups) list.push([h, g]);
    }
    pass = { i: 0, list };
  }
  const fr = frameOf();
  const read = reader(fr);
  const budget = cfg.budget_ms;
  // The read phase: measure groups while this frame's own look-ahead fits the
  // budget. The look-ahead is the costliest group of THIS frame after its first
  // (the first pays the clip reads and any layout flush; alone, it is its own
  // estimate) — nothing carries across frames, so one slow read throttles only
  // the frame it lands in. ONE loop and one budget across every host's groups.
  const slice = [];
  let firstMs = 0;
  let restMax = 0;
  while (pass.i < pass.list.length) {
    const n = slice.length;
    if (n > 0 && now() - t0 + (n === 1 ? firstMs : restMax) > budget) break;
    const [h, g] = pass.list[pass.i];
    const s = now();
    const m = g.failed || registry.get(h.name) !== h ? { res: 'unplaced' } : measureGroup(g, fr, read);
    const d = now() - s;
    if (n === 0) firstMs = d;
    else if (d > restMax) restMax = d;
    slice.push([h, g, m]);
    pass.i++;
  }
  // The write phase: every marker style of the slice, after all its reads.
  for (const [h, g, m] of slice) {
    if (!g.failed) { applyGroup(g, m); syncBlend(g); }
    const c = h.passCount || {};
    if (m.res === 'drawn') {
      c.drawn++;
      if (g.kind === 'guess') c.guesses++;
      if (g.kind === 'section') c.sections++;
      if (m.framed) c.frame_hidden++;
    } else if (m.res === 'clipped') c.clipped++;
    else if (m.res === 'framed') c.frame_hidden++;
  }
  const placed = slice.length;
  const ms = now() - t0;
  const done = pass.i >= pass.list.length;
  totals.frames++;
  totals.box_reads += fr.reads;
  totals.box_ms += ms;
  if (ms > totals.longest_frame_ms) totals.longest_frame_ms = ms;
  const carried = pass.list.length - pass.i;
  if (done) {
    for (const h of registry.values()) if (h.passCount) { Object.assign(h.lastPass, h.passCount); h.passCount = null; }
    pass = null;
    sweepWells();
  }
  bus.emit('overlay:frame', { frame: totals.frames, ms, box_reads: fr.reads, groups: placed, carried, done,
    anchors: answers.size, budget_ms: budget });
  if (!done) { drawPending = true; cfg.raf(drawFrame); return; }
  if (drawAgain) { drawAgain = false; requestDraw(); }
  else if (following()) requestDraw();   // a named animation runs: the next frame re-measures
}

// stats(host?) — with no host, the page host's numbers (the fields they always
// were); with a host's name, that host's (frame_hidden: the glyphs the
// never-draw rule kept off a frame in its last pass), or null for no host.
export function stats(name) {
  if (name != null && name !== 'page') {
    const h = registry.get(String(name));
    if (!h) return null;
    return {
      drawn: h.lastPass.drawn,
      clipped: h.lastPass.clipped,
      frame_hidden: h.lastPass.frame_hidden,
      anchors: h.answers.size,
      places: h.places,
      listening: !!h.listeningOn,
      layer: h.layer.id,
      animating: h.animating.length > 0,
      animation_settles: h.settles,
    };
  }
  const out = {
    frames: totals.frames,
    longest_frame_ms: totals.longest_frame_ms,
    box_reads: totals.box_reads,
    box_ms: totals.box_ms,
    drawn: lastPass.drawn,
    clipped: lastPass.clipped,
    guesses: lastPass.guesses,
    sections: lastPass.sections,
    orphans: orphans().length,
    anchors: answers.size,
    draw_failed: failed.size,
    listening: !!(pageHost && pageHost.listeningOn),
    well_resizes: totals.well_resizes,
    dom_refused: totals.dom_refused,
  };
  if (name === 'page') out.frame_hidden = lastPass.frame_hidden;
  return out;
}
// The elements whose type's draw threw (recorded, never drawn).
export function failedDraws() {
  return [...failed].map(([id, f]) => ({ id, ...f }));
}

// ── the host registry (3C.1) ────────────────────────────────────────────────
// registerHost(name, {root, well, rung, kinds, place, hidden?, settle?,
// glyph?}) → unregister. `name` one of HOST_NAMES ('page' is initOverlay's);
// `root` the element whose presses and mutations are the host's; `well` the
// element its markers are clipped to, or fn(group) → element; `rung` the
// ladder token its layer sits at ('--z-chat-pins'); `kinds` the anchor kinds
// whose rows are its (never one of the page's); `place(row)` → {state, how?,
// el?, range?} | null, DOM queries only (null: unplaced, not drawn, not
// listed); `hidden({row, answer, host})` → a reason (drawn as hidden) or null;
// `settle(trigger)` → off, a subscription whose trigger marks the host dirty;
// `animates` an element, a list of them, or fn() → one or a list, read at each
// animation event: the elements whose animations and transitions (their own
// and their descendants', bubbling) move the host's well — followed frame by
// frame while one runs, the host re-placed once when the last one ends (the
// settle sources below); a static `well` element is observed for its size;
// `glyph` {dx, dy, w, h} or fn(type) → glyph, sizing its markers (default:
// the type's glyph). Refused: a name outside HOST_NAMES or already
// registered, and a root or well that is a frame, inside one, or in another
// document (the never-draw rule).
export function registerHost(name, spec) {
  if (!HOST_NAMES.includes(name)) throw new TypeError(`registerHost: the host must be one of ${HOST_NAMES.join(', ')}`);
  if (registry.has(name)) throw new TypeError(`registerHost: a host named '${name}' is already registered`);
  if (!inited) throw new TypeError('registerHost: initOverlay registers the page host first');
  const o = spec || {};
  const rootWhy = frameReason(o.root);
  if (rootWhy) throw new TypeError(`registerHost: the root is ${rootWhy}; a frame is never a host`);
  if (typeof o.well === 'function') { /* a per-group well: checked at each draw */ } else {
    const wellWhy = frameReason(o.well);
    if (wellWhy) throw new TypeError(`registerHost: the well is ${wellWhy}; a frame is never a host`);
  }
  if (typeof o.rung !== 'string' || !/^--z-[a-z]+(?:-[a-z]+)*$/.test(o.rung)) {
    throw new TypeError('registerHost: rung is a ladder token\'s name (--z-…)');
  }
  const kinds = Array.isArray(o.kinds) ? o.kinds.map(String) : [];
  if (!kinds.length || kinds.some((k) => !k || PAGE_KINDS.includes(k) || k === 'page')) {
    throw new TypeError(`registerHost: kinds is a list of anchor kinds, none of the page's (${PAGE_KINDS.join(', ')}, page)`);
  }
  if (typeof o.place !== 'function') throw new TypeError('registerHost: place(row) is required');
  if (o.hidden != null && typeof o.hidden !== 'function') throw new TypeError('registerHost: hidden must be a function');
  if (o.settle != null && typeof o.settle !== 'function') throw new TypeError('registerHost: settle must be a function');
  if (o.animates != null && typeof o.animates !== 'function') {
    const list = Array.isArray(o.animates) ? o.animates : [o.animates];
    const why = list.map(frameReason).find(Boolean);
    if (why) throw new TypeError(`registerHost: animates is an element, a list of them or fn() → one; one is ${why}`);
  }
  let glyph = null;
  if (o.glyph != null) {
    glyph = typeof o.glyph === 'function' ? o.glyph : checkGlyph(o.glyph);
    if (!glyph) throw new TypeError('registerHost: glyph is {dx, dy, w, h} in px, or fn(type) → one');
  }
  const hl = document.createElement('div');
  hl.id = `el-layer-${name}`;
  hl.className = 'el-host-layer';
  hl.style.zIndex = `var(${o.rung})`;
  hl.addEventListener('click', onLayerClick);
  document.body.appendChild(hl);
  const h = newHost(name, { root: o.root, well: o.well, rung: o.rung, kinds: Object.freeze(kinds), layer: hl,
    place: o.place, hidden: o.hidden || null, glyph, animates: o.animates || null });
  h.onPointer = (e) => pointerIn(h, e);
  registry.set(name, h);
  // Its own layout watch, as #main's: a mutation under its root re-places it.
  if (typeof MutationObserver === 'function') {
    h.observer = new MutationObserver(() => { if (rowsOfHost(h).length || h.groups.length) markDirty(h); });
    h.observer.observe(o.root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] });
  }
  if (o.settle) {
    try {
      const off = o.settle(() => markDirty(h));
      h.settleOff = typeof off === 'function' ? off : null;
    } catch (err) { console.error(`[web-chat] overlay: the '${name}' host's settle failed`, err); }
  }
  if (typeof o.well !== 'function') observeWell(o.well, name);
  rehome(kinds);
  markDirty(h);
  syncListening();
  return () => {
    if (registry.get(name) !== h) return;
    registry.delete(name);
    releaseWells(name);
    h.animating = [];
    if (h.observer) h.observer.disconnect();
    if (h.settleOff) { try { h.settleOff(); } catch { /* the host's own */ } }
    if (h.listeningOn) for (const t of POINTER_EVENTS) h.listeningOn.removeEventListener(t, h.onPointer, true);
    h.listeningOn = null;
    h.gestures.clear();
    h.answers.clear();
    hl.remove();
    rehome(kinds);
    requestDraw();
  };
}
function newHost(name, o) {
  return {
    name, page: name === 'page', root: o.root, well: o.well, rung: o.rung, kinds: o.kinds, layer: o.layer,
    place: o.place || null, hidden: o.hidden || null, glyph: o.glyph || null, animates: o.animates || null,
    answers: new Map(), dirty: false, places: 0, animating: [], settles: 0,
    groups: [], lastSig: null, passCount: null,
    lastPass: name === 'page' ? lastPass : { drawn: 0, clipped: 0, guesses: 0, sections: 0, frame_hidden: 0 },
    listeningOn: null, gestures: new Map(), lastDown: null, onPointer: null, observer: null, settleOff: null,
  };
}
// The kinds the hosts hold changed: the page lets go of (or takes back) the
// rows of those kinds, which another host now lists (or no longer does); no
// other page row is touched.
function rehome(kinds) {
  const rows = [...scopes[drawnScope].rows.values()].filter((r) => r.anchor && kinds.includes(r.anchor.kind));
  if (rows.length) changed(drawnScope, rows);
}
function rowsOfHost(h) {
  const out = [];
  for (const r of scopes.live.rows.values()) {
    if (!r.pending && r.anchor && h.kinds.includes(r.anchor.kind)) out.push(r);
  }
  return out;
}
function markDirty(h) {
  if (!h || h.page || registry.get(h.name) !== h) return;
  h.dirty = true;
  requestDraw();
}
// Re-place a host's rows (once per draw frame, at its start): place, then
// hidden, then DRAW_RULES. DOM queries only: no box read.
function replace(h) {
  h.dirty = false;
  h.places++;
  const next = new Map();
  for (const row of rowsOfHost(h)) {
    let p = null;
    try { p = h.place({ ...row }); } catch (err) {
      console.error(`[web-chat] overlay: the '${h.name}' host's place failed`, err);
      p = null;
    }
    if (!p || typeof p !== 'object') continue;   // unplaced: not drawn, not listed
    const raw = { ...p };
    let reason = null;
    if (h.hidden) {
      try {
        const r = h.hidden({ row: { ...row }, answer: raw, host: h.name });
        reason = r == null || r === false ? null : r;
      } catch (err) { console.error(`[web-chat] overlay: the '${h.name}' host's hidden failed`, err); }
    }
    const state = reason ? HIDDEN : raw.state;
    next.set(row.id, { row, raw, state, hidden: reason, rule: drawRuleOf({ ...raw, state }), mount: null, scope: 'live',
      gen: null, host: h.name });
  }
  h.answers = next;
}
// ── the settle sources (U432a; C-3C-1) ──────────────────────────────────────
// (1) A host's named animations. One capture listener per event on the
// document (initOverlay's) hears every animation and transition start and end;
// one whose target is an element a host names in `animates`, or inside one,
// is that host's. A start is followed: every draw frame re-measures while it
// runs (the glyph and its clip-path follow the moving well). An end, when no
// followed animation still runs — getAnimations({subtree: true}) on the named
// elements where the engine has it, else the starts heard with no end, each
// followed at most ANIMATION_FOLLOW_MAX_MS — re-places the host once
// (markDirty), so its markers are measured from the at-rest geometry. An
// infinite animation is never followed, nor a transition that only paints. A
// host that names nothing gets no draw from it.
// (2) A well's box. One ResizeObserver watches every well a group was clipped
// to (#main, a host's static well, and each one a per-group well returned at a
// draw); a change of a watched box's size (never its first observation) asks
// for a draw, which requestDraw coalesces into one per frame. A well no longer
// in the document is let go at the end of a pass.
const ANIM_STARTS = Object.freeze(['animationstart', 'transitionrun']);
const ANIM_ENDS = Object.freeze(['animationend', 'animationcancel', 'transitionend', 'transitioncancel']);
export const ANIMATION_FOLLOW_MAX_MS = 1000;
const PAINT_ONLY = /^(?:color|background(?:-color|-image|-position)?|opacity|box-shadow|text-shadow|outline(?:-color|-offset)?|border(?:-(?:top|right|bottom|left))?-color|fill|stroke|filter|backdrop-filter|caret-color|text-decoration-color)$/;
let wellRO = null;
const wellUsers = new Map();      // a watched well → the names of the hosts it clips
const wellSizes = new WeakMap();  // a watched well → its last observed [inline, block] size
function animRootsOf(h) {
  let v = h.animates;
  if (typeof v === 'function') {
    try { v = v(); } catch (err) {
      console.error(`[web-chat] overlay: the '${h.name}' host's animates failed`, err);
      return [];
    }
  }
  return (Array.isArray(v) ? v : [v]).filter((el) => !frameReason(el));
}
function paintsOnly(e) {
  return e.type.startsWith('transition') && PAINT_ONLY.test(String(e.propertyName || ''));
}
function onAnimEvent(e) {
  const t = e.target;
  if (!t || t.nodeType !== 1 || paintsOnly(e)) return;
  const start = ANIM_STARTS.includes(e.type);
  const key = e.type.startsWith('transition') ? `t:${e.propertyName || ''}` : `a:${e.animationName || ''}`;
  for (const h of registry.values()) {
    if (!h.animates || registry.get(h.name) !== h) continue;
    if (!animRootsOf(h).some((r) => r === t || r.contains(t))) continue;
    h.animating = h.animating.filter((a) => !(a.el === t && a.key === key));
    if (start) {
      h.animating.push({ el: t, key, until: cfg.now() + ANIMATION_FOLLOW_MAX_MS });
      requestDraw();
    } else if (!stillAnimating(h)) {
      endFollow(h);
      markDirty(h);
    }
  }
}
// Whether a followed animation of the host still runs.
function stillAnimating(h) {
  const roots = animRootsOf(h);
  if (roots.length && roots.every((r) => typeof r.getAnimations === 'function')) {
    for (const r of roots) {
      let list = [];
      try { list = r.getAnimations({ subtree: true }); } catch { list = []; }
      for (const a of list) if (runsFinite(a)) return true;
    }
    return false;
  }
  const now = cfg.now();
  h.animating = h.animating.filter((a) => a.until > now && a.el.isConnected);
  return h.animating.length > 0;
}
function runsFinite(a) {
  if (!a || a.playState !== 'running') return false;
  if (a.transitionProperty && PAINT_ONLY.test(String(a.transitionProperty))) return false;
  let end = Infinity;
  try { end = a.effect ? a.effect.getComputedTiming().endTime : Infinity; } catch { end = Infinity; }
  return Number.isFinite(end);
}
function endFollow(h) {
  h.animating = [];
  h.settles++;
}
function following() {
  for (const h of registry.values()) if (h.animating.length) return true;
  return false;
}
function observeWell(el, name) {
  if (!wellRO || !el || el.nodeType !== 1) return;
  let users = wellUsers.get(el);
  if (!users) {
    users = new Set();
    wellUsers.set(el, users);
    try { wellRO.observe(el); } catch { wellUsers.delete(el); return; }
  }
  users.add(name);
}
function unobserveWell(el) {
  wellUsers.delete(el);
  wellSizes.delete(el);
  try { wellRO.unobserve(el); } catch { /* already gone */ }
}
function releaseWells(name) {
  for (const [el, users] of [...wellUsers]) {
    users.delete(name);
    if (!users.size) unobserveWell(el);
  }
}
function sweepWells() {
  for (const el of [...wellUsers.keys()]) if (!el.isConnected) unobserveWell(el);
}
function onWellResize(entries) {
  let moved = false;
  for (const en of entries || []) {
    if (!wellUsers.has(en.target)) continue;
    const b = en.borderBoxSize && en.borderBoxSize[0];
    const r = en.contentRect || {};
    const size = b ? [b.inlineSize, b.blockSize] : [r.width, r.height];
    const prev = wellSizes.get(en.target);
    wellSizes.set(en.target, size);
    if (prev && (prev[0] !== size[0] || prev[1] !== size[1])) moved = true;
  }
  if (moved) {
    totals.well_resizes++;
    requestDraw();
  }
}
// (3) A box target's box (U614; U516's residual). One more ResizeObserver,
// made at the first box target, observes each page-host box group's resolved
// target and each page group's endpoint items — re-observed at every build
// (syncBoxTargets: the pass's groups, after their rebuild or refresh) and let
// go once no group names it — so a pane-framed stroke follows its target's
// resize, and an arrow its item's, with no re-render, scroll, settle or
// window resize. As the wells': a first observation draws nothing; a changed
// size asks for one draw (coalesced per frame).
let boxRO = null;
const boxTargets = new Set();
const boxSizes = new WeakMap();
function syncBoxTargets(groups) {
  const want = new Set();
  for (const g of groups) {
    if (g.place !== 'box' || g.failed) continue;
    if (g.page) { for (const el of g.endEls || []) want.add(el); } else if (g.el && g.el.nodeType === 1) want.add(g.el);
  }
  for (const el of [...boxTargets]) {
    if (want.has(el)) continue;
    boxTargets.delete(el);
    boxSizes.delete(el);
    try { boxRO.unobserve(el); } catch { /* already gone */ }
  }
  if (!want.size) return;
  if (!boxRO) {
    if (typeof ResizeObserver !== 'function') return;
    boxRO = new ResizeObserver(onBoxResize);
  }
  for (const el of want) {
    if (boxTargets.has(el)) continue;
    try { boxRO.observe(el); boxTargets.add(el); } catch { /* not observable */ }
  }
}
function onBoxResize(entries) {
  let moved = false;
  for (const en of entries || []) {
    if (!boxTargets.has(en.target)) continue;
    const b = en.borderBoxSize && en.borderBoxSize[0];
    const r = en.contentRect || {};
    const size = b ? [b.inlineSize, b.blockSize] : [r.width, r.height];
    const prev = boxSizes.get(en.target);
    boxSizes.set(en.target, size);
    if (prev && (prev[0] !== size[0] || prev[1] !== size[1])) moved = true;
  }
  if (moved) requestDraw();
}

// hosts() → [{name, layer, rung, root, kinds}], the page first: each host's
// layer id, its rung (a ladder token's name) and root (GT-07's host half).
export function hosts() {
  return [...registry.values()].map((h) => ({ name: h.name, layer: h.layer.id, rung: h.rung,
    root: h.page ? $('main') : h.root, kinds: [...h.kinds] }));
}
// isHostRoot(el): el is a registered host's root (#main for the page). The
// input-mode policy's interactive walk ends there, as at #main.
export function isHostRoot(el) {
  if (!el || el.nodeType !== 1) return false;
  for (const h of registry.values()) if ((h.page ? $('main') : h.root) === el) return true;
  return false;
}

// ── types ───────────────────────────────────────────────────────────────────
// registerType(type, {draw(group, ctx), create?(input, ctx), input?, glyph?,
// sourceGlyph?, move?(group, ctx)}) → unregister. draw fills the group's
// container (a marker the overlay positions and clips) for the type's elements
// resolved to one DOM element; move, when given, runs after each placement;
// create takes the armed tool's input. sourceGlyph {dx, dy}, when given, puts
// the type's glyph in a markdown item's left margin (marginItemOf). `host`
// (default 'page') is the host whose presses its create takes, and `tool`
// (default its own name) the armed tool whose presses it takes there. `place`
// (PLACE_MODES, default 'glyph') 'box' draws an element row's group as a box
// marker sized to its target (boxRow, measureBox): the draw gets ctx.box
// {w, h} and draws in the target's normalised space (an <svg viewBox="0 0 1
// 1" preserveAspectRatio="none"> at 100 % of the marker), so a resize
// rescales it with no second draw. `composite` (COMPOSITE_MODES, a 'box'
// type's only; U624) gives each of its page groups group.blend, the blend
// part (THE BLEND PER MARKER PART above). `detach` {leader?} (U587; leader one of
// GLYPH_LEADERS or fn() → one, read per draw; default 'dotted'), a page
// type's, gives its glyph the engine's drag, stored offset and leader (the
// header's THE DETACHABLE GLYPH). An element whose type has none draws a
// generic marker.
export function registerType(type, spec) {
  if (typeof type !== 'string' || !type) throw new TypeError('registerType: a type name is required');
  if (!spec || typeof spec.draw !== 'function') throw new TypeError('registerType: {draw(group, ctx)} is required');
  if (spec.create != null && typeof spec.create !== 'function') throw new TypeError('registerType: create must be a function');
  if (spec.move != null && typeof spec.move !== 'function') throw new TypeError('registerType: move must be a function');
  if (spec.input != null && !INPUT_KINDS.includes(spec.input)) {
    throw new TypeError(`registerType: input must be one of ${INPUT_KINDS.join(', ')}`);
  }
  let glyph = null;
  if (spec.glyph != null) {
    const g = spec.glyph;
    if (!['dx', 'dy', 'w', 'h'].every((k) => Number.isFinite(g[k])) || g.w <= 0 || g.h <= 0) {
      throw new TypeError('registerType: glyph is {dx, dy, w, h} in px');
    }
    glyph = Object.freeze({ dx: g.dx, dy: g.dy, w: g.w, h: g.h });
  }
  let sourceGlyph = null;
  if (spec.sourceGlyph != null) {
    const g = spec.sourceGlyph;
    if (!Number.isFinite(g.dx) || !Number.isFinite(g.dy)) throw new TypeError('registerType: sourceGlyph is {dx, dy} in px');
    sourceGlyph = Object.freeze({ dx: g.dx, dy: g.dy });
  }
  const host = spec.host == null ? 'page' : spec.host;
  if (!HOST_NAMES.includes(host)) throw new TypeError(`registerType: host must be one of ${HOST_NAMES.join(', ')}`);
  const tool = spec.tool == null ? type : spec.tool;
  if (typeof tool !== 'string' || !tool) throw new TypeError('registerType: tool is an armed tool\'s name');
  const place = spec.place == null ? 'glyph' : spec.place;
  if (!PLACE_MODES.includes(place)) throw new TypeError(`registerType: place must be one of ${PLACE_MODES.join(', ')}`);
  // `detach` {leader?} (U587): the engine's detachable glyph, a page type's.
  let detach = null;
  if (spec.detach != null) {
    const d = spec.detach;
    const l = d && typeof d === 'object' ? d.leader : undefined;
    if (!d || typeof d !== 'object' || (l != null && typeof l !== 'function' && !GLYPH_LEADERS.includes(l))) {
      throw new TypeError(`registerType: detach is {leader?}, leader one of ${GLYPH_LEADERS.join(', ')} or fn() → one`);
    }
    if (host === 'page') detach = Object.freeze({ leader: l == null ? GLYPH_LEADERS[0] : l });
  }
  if (detach) loadGuard();
  // `composite` (U624): a box type's blend part; refused on a glyph type.
  if (spec.composite != null && (!COMPOSITE_MODES.includes(spec.composite) || place !== 'box')) {
    throw new TypeError(`registerType: composite is one of ${COMPOSITE_MODES.join(', ')}, on a type placed 'box'`);
  }
  const composite = spec.composite == null ? null : spec.composite;
  const entry = { draw: spec.draw, create: spec.create || null, move: spec.move || null, input: spec.input || null, glyph,
    sourceGlyph, targets: spec.targets === 'panes' ? 'panes' : 'items', host, tool, place, detach, composite };
  types.set(type, entry);
  resetSigs(type);
  syncListening();
  requestDraw();
  return () => {
    if (types.get(type) !== entry) return;
    types.delete(type);
    resetSigs(type);
    syncListening();
    requestDraw();
  };
}
// A type (un)registered: the page rebuilds its markers (as it always did); a
// host only when it holds a group of that type, so a type listing re-read on a
// hello never rebuilds a chat marker the frame did not touch.
function resetSigs(type) {
  pageHost.lastSig = null;
  for (const h of registry.values()) if (!h.page && h.groups.some((g) => g.type === type)) h.lastSig = null;
}
// The type that takes the armed tool's presses in a host: the one registered
// for (that host, the armed tool), or null. For the page, the armed type
// itself when it is the page's (as it always was); else a page type whose
// tool is the armed one; else PASS for an armed type registered for another
// host only (a press in #main passes through, the tool still armed); else
// null (a type nobody registered: its presses are the tool's, as always).
const PASS = 'pass';
function typeFor(h, armedType) {
  if (h.page) {
    const own = types.get(armedType);
    if (own && own.host === 'page') return own;
    for (const t of types.values()) if (t.host === 'page' && t.tool === armedType && t.create) return t;
    return own ? PASS : null;
  }
  for (const t of types.values()) if (t.host === h.name && t.tool === armedType && t.create) return t;
  return null;
}
export function inputKindOf(type) {
  const t = types.get(type);
  return (t && t.input) || null;
}

// ── the armed tool: THE one armed-tool state of the chrome (K.2-3, K.2-14) ──
export function setArmed(type, profile) {
  const next = type == null ? null : { type: String(type), profile: profile == null ? null : String(profile) };
  const cur = armedState;
  if ((next === null && cur === null) || (next && cur && next.type === cur.type && next.profile === cur.profile)) return;
  armedState = next;
  dropGestures();
  syncListening();
  const snap = armed();
  for (const fn of [...armedSubs]) {
    try { fn(snap); } catch (e) { console.error('[web-chat] overlay: an onArmedChange listener failed', e); }
  }
}
export function armed() { return armedState ? { ...armedState } : null; }
export function onArmedChange(fn) {
  if (typeof fn !== 'function') throw new TypeError('onArmedChange: expects a function');
  const h = (v) => fn(v);
  armedSubs.add(h);
  return () => { armedSubs.delete(h); };
}

// THE one pointer dispatch (fn(event, {armed}) → 'tool' | 'page' | 'ignore'),
// consulted while a tool is armed at each pointer's pointerdown, at a lone
// click (no live gesture of its own: a keyboard's or a script's click), and
// once more at the click of a gesture it gave to the tool — with a stand-in
// carrying that gesture's pointerType — because only where the gesture ended
// can it tell a tap from a pan (a finger that travelled past the slop): an
// answer other than 'tool' there makes that click nobody's. 'tool' hands the
// gesture to the armed type's create; 'page' lets every event of it reach the
// page untouched with the tool still armed (K.2-9); 'ignore' swallows it
// (neither the tool nor the page gets it). The last set wins.
export function setPointerPolicy(fn) {
  if (fn != null && typeof fn !== 'function') throw new TypeError('setPointerPolicy: expects a function or null');
  const mine = fn || null;
  policy = mine;
  return () => { if (policy === mine) policy = null; };
}

const POINTER_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click'];
// The capture listeners sit on the well only while a tool is armed or a pick
// is pending; on another host's root only while the armed tool has a type
// registered there that creates (a press there with none passes through).
// THE WELL LISTENER (U614; REQ@margins (a)): the page's sit on the
// .well-wrap that holds #main (wellWrapOf), so a strokes type's press in the
// gutters beside the column reaches its create; pointerIn leaves a press
// outside #main to the page for every other input kind, and a pick is
// #main's alone, so every other tool keeps exactly #main's reach.
function syncListening() {
  const ph = pageHost;
  const want = !!(armedState || pickState);
  if (want && !ph.listeningOn) {
    const well = wellWrapOf($('main'));
    if (well) {
      for (const t of POINTER_EVENTS) well.addEventListener(t, onPointer, true);
      ph.listeningOn = well;
    }
  } else if (!want && ph.listeningOn) {
    for (const t of POINTER_EVENTS) ph.listeningOn.removeEventListener(t, onPointer, true);
    ph.listeningOn = null;
    dropGestures(ph);
  }
  for (const h of registry.values()) {
    if (h.page) continue;
    const wantH = !!armedState && !!typeFor(h, armedState.type);
    if (wantH && !h.listeningOn) {
      for (const t of POINTER_EVENTS) h.root.addEventListener(t, h.onPointer, true);
      h.listeningOn = h.root;
    } else if (!wantH && h.listeningOn) {
      for (const t of POINTER_EVENTS) h.listeningOn.removeEventListener(t, h.onPointer, true);
      h.listeningOn = null;
      dropGestures(h);
    }
  }
}
function dropGestures(h) {
  for (const x of h ? [h] : [pageHost, ...registry.values()]) {
    x.gestures.clear();
    x.lastDown = null;
  }
}
function innerTarget(e) {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  for (const n of path) if (n && n.nodeType === 1) return n;
  return e.target && e.target.nodeType === 1 ? e.target : null;
}
function whereOf(target) {
  const out = { root: document, mount: null, md: null };
  if (!target) return out;
  const root = target.getRootNode ? target.getRootNode() : document;
  if (root && root.nodeType === 11 && root.host) {
    out.root = root;
    const h = root.host;
    out.mount = (h.dataset && h.dataset.mountId) || h.id || null;
  } else {
    const b = target.closest ? target.closest('[data-md-id]') : null;
    if (b) out.md = b.getAttribute('data-md-id');
  }
  return out;
}
// A markdown block of a page item (MD_BLOCKS, inside a [data-md-id] item).
function isMdBlock(n) {
  return !!n && n.nodeType === 1 && typeof n.matches === 'function' && n.matches(MD_BLOCKS)
    && typeof n.closest === 'function' && !!n.closest('[data-md-id]');
}
function swallow(e, prevent) {
  e.stopPropagation();
  if (prevent && e.cancelable) e.preventDefault();
}
// THE CREATE-CTX SEAM (U516, plan 4A.2; BOX@mode / WET@engine / FRAME@shared):
// registerCreateCtx(name, value) → unregister puts `value` on every create
// ctx as ctx[name] — the wet layer's `wet` (U517), the target frame's
// `frameAt` (U561), the tray's `tray` (U514) — so an engine module plugs into
// a type's create without an edit here. The name is CREATE_CTX_NAME, never one
// of the ctx's own keys (CREATE_CTX_KEYS) and never one already registered (a
// TypeError naming it). The members live in one frozen object rebuilt only
// at a (un)registration: an event spreads it into today's ctx and does no
// other work.
const createCtxMembers = new Map();   // name → {value}
let createCtxExtra = Object.freeze({});
function rebuildCreateCtx() {
  const out = {};
  for (const [k, m] of createCtxMembers) out[k] = m.value;
  createCtxExtra = Object.freeze(out);
}
export function registerCreateCtx(name, value) {
  if (typeof name !== 'string' || !CREATE_CTX_NAME.test(name)) {
    throw new TypeError(`registerCreateCtx: ${JSON.stringify(name)} is not a member name (a lower-case letter, then up to 31 letters or digits)`);
  }
  if (CREATE_CTX_KEYS.includes(name)) throw new TypeError(`registerCreateCtx: "${name}" is one of the create ctx's own keys`);
  if (createCtxMembers.has(name)) throw new TypeError(`registerCreateCtx: "${name}" is already registered`);
  if (value === undefined) throw new TypeError(`registerCreateCtx: "${name}" needs a value`);
  const m = { value };
  createCtxMembers.set(name, m);
  rebuildCreateCtx();
  return () => {
    if (createCtxMembers.get(name) !== m) return;
    createCtxMembers.delete(name);
    rebuildCreateCtx();
  };
}
function toolCtx(settings) {
  return { ...createCtxExtra, anchors, sourceMap, markdownText, scope: 'live', armed: armed(), settings: settings || settingsNow() };
}
// The armed tool's settings now, as the create ctx's settings(): one snapshot,
// taken once per gesture (at its press) and kept on the gesture.
function settingsNow() {
  const snap = armedState ? settingsSnapshot(armedState.type, armedState.profile) : settingsSnapshot(null);
  return () => snap;
}
// THE SAMPLES (U516): a strokes tool's pointer event carries the browser's
// coalesced samples (input.samples: getCoalescedEvents() when it answers a
// non-empty list, else [the event]) and its predicted ones (input.predicted:
// getPredictedEvents(), else []) — both feature-detected (Safari's support
// varies) and handed as the browser gave them, never copied. A predicted
// sample is flagged by being in input.predicted: a type draws it
// provisionally on the wet layer and never stores it; the engine keeps none.
// A pointercancel's input (dispatched, or cancelGesture's) carries [] and [].
const NO_SAMPLES = Object.freeze([]);
function samplesOf(e) {
  let list = null;
  if (typeof e.getCoalescedEvents === 'function') {
    try { list = e.getCoalescedEvents(); } catch { list = null; }
  }
  return list && list.length ? list : [e];
}
function predictedOf(e) {
  if (typeof e.getPredictedEvents !== 'function') return NO_SAMPLES;
  let list = null;
  try { list = e.getPredictedEvents(); } catch { list = null; }
  return list || NO_SAMPLES;
}
function markdownText(md) {
  const m = page.markdown && md != null ? page.markdown.get(String(md)) : null;
  return m ? String(m.text == null ? '' : m.text) : null;
}
// Each pointer's gesture is its own (a palm landing during a pen stroke never
// re-decides the pen's): decided at its pointerdown, read by its pointermove,
// pointerup and pointercancel, dropped at its pointercancel, at its click, at
// the next pointerdown of its id, at a move of its pointer with no button down
// while the well has not heard it up (it was released outside #main), and —
// once it is up — at any later pointerdown (a click follows its pointerup in
// the same task, or never). A click that names a pointer takes that pointer's
// gesture alone; one that names none takes the newest pointerdown's only once
// that pointer is up, its click unspent and a pointer pressed it (detail >= 1).
// With neither it is a lone click (a keyboard's Enter, pointerId -1; a script's
// el.click(); or the click a pan's gesture never got), and the policy is asked
// about it afresh.
function askPolicy(e) {
  let decision = 'tool';
  if (policy) {
    try { decision = policy(e, { armed: armed() }); } catch (err) {
      console.error('[web-chat] overlay: the pointer policy failed', err);
      decision = 'page';
    }
  }
  return POINTER_ANSWERS.includes(decision) ? decision : 'page';
}
function gestureOfClick(h, e) {
  const gestures = h.gestures;
  const lastDown = h.lastDown;
  // A click that names a pointer takes that pointer's gesture or none: never the
  // newest pointerdown's, which may be another pointer's (a mouse released
  // outside the well leaves its entry not up; a pen may still be down). A
  // keyboard's click names -1, a lone one by any reading.
  if (typeof e.pointerId === 'number') return gestures.has(e.pointerId) ? [e.pointerId, gestures.get(e.pointerId)] : null;
  // A click that names no pointer (a browser whose click is a MouseEvent): the
  // newest pointerdown's only once the well heard it up, with its own click
  // unspent, and only when a pointer pressed the click (detail >= 1; any later
  // pointerdown would have dropped this gesture). A press still not up is no
  // click's: its pointer was released where the well could not hear it (U302b).
  const g = lastDown == null ? null : gestures.get(lastDown);
  return g && g.up && e.detail >= 1 ? [lastDown, g] : null;
}
// The click of a gesture the tool took, judged again where it ended: the
// stand-in names the gesture's pointer (a click event may carry none) and not
// the click's type, so the policy reads it as that pointer at its release.
function clickStillTool(e, g) {
  const stand = {
    pointerId: e.pointerId, pointerType: g.pointerType, target: e.target,
    composedPath: () => (typeof e.composedPath === 'function' ? e.composedPath() : []),
    clientX: e.clientX, clientY: e.clientY,
  };
  return askPolicy(stand) === 'tool';
}
// Whether a press lies inside #main (its composed path, else its target).
function inMain(e) {
  const main = $('main');
  if (!main) return false;
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  if (path && path.length) return path.includes(main);
  const t = e.target;
  return !!(t && t.nodeType === 1 && main.contains(t));
}
// The page well's capture listener (on the .well-wrap since U614).
function onPointer(e) {
  pointerIn(pageHost, e);
}
// A press in a host: handed to the type registered for (that host, the armed
// tool), with input.host set. A pick is the page's alone; the `.mount-host`
// and markdown narrowing is the page's alone.
function pointerIn(h, e) {
  if (view.previewing) return;   // D2: a preview creates and picks nothing, in any host
  if (h.page && pickState) { if (inMain(e)) onPick(e); return; }
  if (!armedState) return;
  const found = typeFor(h, armedState.type);
  if (found === PASS) return;   // the armed tool has no type for this host: the press is the page's
  const t = found || undefined;
  if (!h.page && !t) return;
  const gestures = h.gestures;
  const kind = (t && t.input) || 'taps';
  // The policy's 'tool', narrowed by the type's targets (element-types.js
  // TARGETS, K.2-78): a 'panes' tool (a pack's) leaves a press outside every
  // pane's content (.mount-host) to the page — a markdown link follows, the
  // chrome inside #main works — with the tool still armed. A 'taps' tool with
  // targets 'items' (the comment, F.3) takes a pane's content and a markdown
  // block (MD_BLOCKS inside a [data-md-id] item) — a link in prose pins — and
  // leaves everything else (a pane's header controls, the run controls, the
  // Contents nav, a gap between blocks) to the page, as K.2-78 (c) made it.
  // The highlight ('selection') and the box grab ('strokes') are not narrowed.
  const decide = (ev) => {
    // THE WELL LISTENER (U614): a press outside #main (the well's gutters) is
    // the page's for every input kind but 'strokes', with no policy asked.
    if (h.page && kind !== 'strokes' && !inMain(ev)) return 'page';
    const d = askPolicy(ev);
    if (d !== 'tool' || !t || !h.page) return d;
    const narrowed = t.targets === 'panes' || kind === 'taps';
    if (!narrowed) return d;
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    if (path.some((n) => n && n.classList && n.classList.contains('mount-host'))) return d;
    if (t.targets === 'panes') return 'page';
    return path.some(isMdBlock) ? d : 'page';
  };
  let decision;
  let g = null;
  if (e.type === 'pointerdown') {
    for (const [id, old] of gestures) if (old.up || id === e.pointerId) gestures.delete(id);
    decision = decide(e);
    g = { decision, pointerType: e.pointerType || '', mode: decision === 'tool' ? dispatchMode(e, kind) : null, up: false,
      settings: decision === 'tool' && t && t.create ? settingsNow() : null };
    gestures.set(e.pointerId, g);
    h.lastDown = e.pointerId;
  } else if (e.type === 'click') {
    const own = gestureOfClick(h, e);
    if (own) {
      gestures.delete(own[0]);   // its click is spent
      g = own[1];
      decision = g.decision === 'tool' && !clickStillTool(e, g) ? 'ignore' : g.decision;
    } else {
      decision = decide(e);   // a lone click
    }
  } else {
    g = gestures.get(e.pointerId);
    if (!g) return;   // a hover, or the tail of a gesture that began before the arming
    // A move with no button down on a press the well never heard end (released
    // outside #main): the press is over, so its gesture goes and this move, a
    // hover, is the page's (U302b).
    if (e.type === 'pointermove' && e.buttons === 0 && !g.up) { gestures.delete(e.pointerId); return; }
    // A move after this entry's own pointerup is a hover: it passes through and
    // the entry stays for its click (a browser that sends no click when the
    // down and up targets differ would otherwise swallow it; K.2-51).
    if (e.type === 'pointermove' && g.up) return;
    decision = g.decision;
    if (e.type === 'pointerup') g.up = true;
    else if (e.type === 'pointercancel') gestures.delete(e.pointerId);
  }
  if (decision === 'page') return;
  if (decision === 'ignore') { swallow(e, e.type !== 'pointermove'); return; }
  // 'tool': the page never hears it. The tool takes the click (its default —
  // a link's, a button's — never runs); a pointer event's default is cancelled
  // and the pointer captured as the policy's dispatchMode answers for this
  // pointer (a drawing pointer's default only: a pen's, a mouse's as the pen's).
  const mode = (g && g.mode) || dispatchMode(e, kind);
  swallow(e, e.type === 'click' || mode.cancelDefault);
  const target = innerTarget(e);
  if (e.type === 'pointerdown' && mode.capture) capture(target, e.pointerId, h);
  if (!t || !t.create) return;
  if (kind === 'taps' && e.type !== 'click') return;
  const where = whereOf(target);
  const input = { event: e, phase: e.type, kind, target, root: where.root, mount: where.mount, md: where.md,
    clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType || 'mouse',
    profile: armedState.profile, host: h.name };
  if (kind === 'strokes') {
    // A cancel carries no samples, as cancelGesture's does: nothing to draw.
    const cancel = e.type === 'pointercancel';
    input.samples = cancel ? NO_SAMPLES : samplesOf(e);
    input.predicted = cancel ? NO_SAMPLES : predictedOf(e);
  }
  try { t.create(input, toolCtx(g && g.settings)); } catch (err) {
    console.error(`[web-chat] overlay: the '${armedState.type}' create failed`, err);
  }
}
// cancelGesture(pointerId) → boolean: end that pointer's gesture as its
// pointercancel would — a gesture the tool took has the armed type's create
// hear phase 'pointercancel' (a strokes tool drops what it drew and creates
// nothing), and the gesture is dropped, so the rest of that pointer's events
// are no gesture's — with no event dispatched, so no pane hears it. The one
// caller is input-mode.js's two-finger pan (U334a, K.4 I1 = b). True when the
// pointer had a gesture.
export function cancelGesture(pointerId) {
  let h = null;
  for (const x of [pageHost, ...registry.values()]) if (x.gestures.has(pointerId)) { h = x; break; }
  if (!h) return false;
  const g = h.gestures.get(pointerId);
  h.gestures.delete(pointerId);
  if (g.decision !== 'tool' || !armedState) return true;
  const found = typeFor(h, armedState.type);
  const t = found === PASS ? null : found;
  const kind = (t && t.input) || 'taps';
  if (!t || !t.create || kind === 'taps') return true;   // a taps tool acts only at the click
  const pointerType = g.pointerType || 'mouse';
  const input = { event: { type: 'pointercancel', pointerId, pointerType }, phase: 'pointercancel', kind,
    target: null, root: document, mount: null, md: null, clientX: null, clientY: null, pointerType,
    profile: armedState.profile, host: h.name };
  if (kind === 'strokes') {
    input.samples = NO_SAMPLES;
    input.predicted = NO_SAMPLES;
  }
  try { t.create(input, toolCtx(g.settings)); } catch (err) {
    console.error(`[web-chat] overlay: the '${armedState.type}' create failed`, err);
  }
  return true;
}
function capture(el, pointerId, h) {
  const at = el && typeof el.setPointerCapture === 'function' ? el : h.listeningOn;
  if (!at || typeof at.setPointerCapture !== 'function') return;
  try { at.setPointerCapture(pointerId); } catch { /* the pointer is gone (no active pointer with that id) */ }
}

// ── the detachable glyph's drag (U587, H.7; the header's paragraph) ────────
// The tray action guard, loaded once a detached type registers (a relative
// lazy import: element-types.js imports this module). Until it has loaded no
// drag starts (fail closed). The one lazy load is loadTypes (the page arm's
// stored records come with it).
function loadGuard() {
  if (trayGuard) return;
  loadTypes();
}
// The guard's answer for a drag starting now: false (a preview: READONLY_HINT
// shown, nothing written) or true.
function dragAllowed() {
  if (!trayGuard) return false;
  try { return trayGuard(() => true) === true; } catch { return false; }
}
function groupOfKey(key) {
  return pageHost.groups.find((g) => g.key === key) || null;
}
function listenDrag(on) {
  const f = on ? 'addEventListener' : 'removeEventListener';
  window[f]('pointermove', onDragMove, true);
  window[f]('pointerup', onDragUp, true);
  window[f]('pointercancel', onDragCancel, true);
}
// A finger past its hold drags: its touchmove's default (a pan) is cancelled
// from then on, so the browser does not take the gesture under the drag.
function stopPan(e) { if (drag && drag.held && e.cancelable) e.preventDefault(); }
function holdTouch(on) {
  if (on) document.addEventListener('touchmove', stopPan, { capture: true, passive: false });
  else document.removeEventListener('touchmove', stopPan, { capture: true });
}
function onGlyphDown(e) {
  if (drag) return;   // one glyph press at a time: a palm under a pen's drag starts none
  const m = e.target && e.target.closest ? e.target.closest('.el-marker') : null;
  const g = m && m._group;
  // A carried guess's and a section's press is the re-anchor seam's (their
  // click), never a drag.
  if (!g || !g.detach || g.failed || g.kind !== 'hit' || !Number.isFinite(g.lastX)) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const kind = pointerTypeOf(e);
  // The policy's palm row (input-mode.js: touch → 'ignore' while a pen pointer
  // is down): a finger the policy ignores starts no drag. The glyph's layer is
  // outside #main, so the one dispatch never sees this press: it asks here.
  if (kind === 'touch' && askPolicy(e) === 'ignore') return;
  drag = { pointerId: e.pointerId, kind, key: g.key, group: g, marker: m, x0: e.clientX, y0: e.clientY,
    p0: { x: g.lastX, y: g.lastY }, held: kind !== 'touch', started: false, moved: false, offset: null, timer: null };
  if (kind === 'touch') {
    const mine = drag;
    drag.timer = setTimeout(() => {
      if (drag !== mine || mine.moved) return;
      // A pen may land after the finger: asked again at the hold, with a
      // stand-in naming the finger, an 'ignore' drops the drag.
      if (askPolicy({ pointerType: 'touch', pointerId: mine.pointerId, target: mine.marker }) === 'ignore') { endDrag(); return; }
      mine.held = true;
      holdTouch(true);
    }, cfg.hold_ms);
  } else if (e.cancelable) {
    e.preventDefault();   // no text selection or focus under a pen's or a mouse's drag
  }
  listenDrag(true);
}
function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.x0;
  const dy = e.clientY - drag.y0;
  if (!drag.started) {
    if (isTap(dx, dy)) return;
    drag.moved = true;
    // A finger that travelled before its hold is a pan: the browser's, untouched.
    if (!drag.held) { endDrag(); return; }
    if (!dragAllowed()) { endDrag(); return; }
    drag.started = true;
    drag.marker.classList.add('el-dragging');
    try { if (typeof drag.marker.setPointerCapture === 'function') drag.marker.setPointerCapture(e.pointerId); } catch { /* gone */ }
  }
  if (e.cancelable) e.preventDefault();
  const g = groupOfKey(drag.key) || drag.group;
  const abox = g.lastAbox || drag.group.lastAbox;
  if (!abox) return;
  // Clamped into the clip it was last drawn in (U631; never drawn: unclamped).
  const clip = g.lastClip || drag.group.lastClip || null;
  drag.offset = clampedOffset({ x: drag.p0.x + dx, y: drag.p0.y + dy }, abox, clip, g.glyph || drag.group.glyph);
  syncLeaderOn(g);
  requestDraw();
}
function onDragUp(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  endDrag();
  if (d.started) {
    // The click this release makes is the drag's, never the glyph's own.
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
    // The LAST measure decides (U631): framed or clipped writes nothing.
    const g = groupOfKey(d.key) || d.group;
    if (REFUSED_DROPS.has(g.lastRes)) refuseDrop(d);
    else if (d.offset) commitMove(d);
  } else if (d.kind === 'touch') {
    // A tap on the glyph on touch shows (or hides) its hover leader.
    if (tapShown.has(d.key)) tapShown.delete(d.key); else tapShown.add(d.key);
    const g = groupOfKey(d.key);
    if (g) syncLeaderOn(g);
  }
}
// A refused drop (U631): nothing sent; the drag is already cleared (endDrag),
// so the next frame draws the glyph back at its stored offset; one bus
// 'overlay:glyph-refused' {id, hint} per element, commitMove's shape.
function refuseDrop(d) {
  requestDraw();
  for (const it of d.group.items) bus.emit('overlay:glyph-refused', { id: String(it.id), hint: GLYPH_DROP_HINT });
}
function onDragCancel(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  endDrag();
}
function endDrag() {
  const d = drag;
  drag = null;
  if (!d) return;
  if (d.timer) clearTimeout(d.timer);
  holdTouch(false);
  listenDrag(false);
  if (d.marker) d.marker.classList.remove('el-dragging');
  if (d.started) requestDraw();
}
function onLayerCapture(ev) {
  if (!swallowClick) return;
  swallowClick = false;
  ev.stopPropagation();
  ev.preventDefault();
}
// THE DROP: each element of the group takes the offset at once (its row's
// display, so the glyph stays where it was dropped), then ONE request per
// element through the tray action guard; the daemon's answer settles the
// row's v and display, a refusal puts the row's display back (announced on
// bus 'overlay:glyph-refused' {id, hint}).
async function commitMove(d) {
  const off = d.offset;
  const ids = d.group.items.map((it) => String(it.id));
  const S = scopes.live;
  const before = new Map();
  const rows = [];
  for (const id of ids) {
    const r = S.rows.get(id);
    if (!r) continue;
    before.set(id, r.display || null);
    rows.push({ ...r, display: { glyph: off } });
  }
  if (!rows.length) return;
  upsertElements('live', rows);
  for (const id of before.keys()) {
    let r;
    try {
      r = await Promise.resolve(trayGuard(() => request('POST', glyphPath(id), {
        body: { dx: off.dx, dy: off.dy, corner: off.corner }, device: true,
      })));
    } catch (err) { r = { ok: false, hint: String((err && err.message) || err) }; }
    const cur = S.rows.get(id);
    if (!cur) continue;
    if (r && r.ok && r.body && typeof r.body === 'object') {
      upsertElements('live', [{ ...cur, v: r.body.v == null ? cur.v : r.body.v, display: r.body.display || null }]);
    } else {
      upsertElements('live', [{ ...cur, display: before.get(id) }]);
      bus.emit('overlay:glyph-refused', { id, hint: (r && r.hint) || null });
    }
  }
}
// leaders() → the page's detached groups' leaders as drawn: {ids, drawn, mode,
// on, orphan, framed, dense, box: {left, top, width, height}, line: {x1, y1,
// x2, y2}} (client px; the line in the box's own coordinates). Read-only.
export function leaders() {
  const out = [];
  for (const g of pageHost.groups) {
    if (!g.leader) continue;
    const svg = g.leader;
    const line = svg.firstChild;
    const num = (v) => (v == null || v === '' ? null : Number(String(v).replace('px', '')));
    out.push({
      ids: g.items.map((it) => it.id), drawn: svg.style.display !== 'none', mode: svg.dataset.leader || null,
      on: svg.classList.contains('el-leader-on'), orphan: svg.classList.contains('el-leader-orphan'),
      framed: !!g.leaderFramed, dense: !!g.dense,
      box: { left: num(svg.style.left), top: num(svg.style.top), width: num(svg.style.width), height: num(svg.style.height) },
      line: { x1: num(line.getAttribute('x1')), y1: num(line.getAttribute('y1')), x2: num(line.getAttribute('x2')), y2: num(line.getAttribute('y2')) },
    });
  }
  return out;
}

// pick({kind}) → {promise, cancel}: the next qualifying press records an anchor
// of that kind through the resolver (record, recordRange, recordSource,
// recordPoint) and
// resolves with {kind, record, mount}; cancel (or a newer pick) resolves null.
// The caller registers cancel with the popover registry. While previewing it
// resolves null at once.
export function pick({ kind } = {}) {
  if (!PICK_KINDS.includes(kind)) throw new TypeError(`pick: kind must be one of ${PICK_KINDS.join(', ')}`);
  let resolveFn;
  const promise = new Promise((r) => { resolveFn = r; });
  if (pickState) pickState.finish(null);
  if (view.previewing) {
    resolveFn(null);
    return { promise, cancel() {} };
  }
  const st = {
    kind,
    finish(v) {
      if (pickState === st) { pickState = null; syncListening(); }
      resolveFn(v);
    },
  };
  pickState = st;
  syncListening();
  return { promise, cancel: () => st.finish(null) };
}
function selectionRange(root) {
  const sel = (root && root.getSelection ? root.getSelection() : null) || (document.getSelection && document.getSelection());
  return sel && sel.rangeCount ? sel.getRangeAt(0) : null;
}
function onPick(e) {
  const st = pickState;
  const fires = st.kind === 'element' || st.kind === 'point' ? e.type === 'click' : (e.type === 'pointerup' || e.type === 'click');
  if (!fires) return;
  const target = innerTarget(e);
  const where = whereOf(target);
  let rec = null;
  if (st.kind === 'element') {
    if (where.mount != null) rec = anchors.record(where.root, target, { mount: where.mount });
  } else if (st.kind === 'point') {
    // A point only on a fixed-aspect target (C5): a refusal records nothing
    // and the pick keeps waiting, as a range pick does without a selection.
    if (where.mount != null && typeof anchors.recordPoint === 'function') {
      const p = anchors.recordPoint(where.root, target, e.clientX, e.clientY, { mount: where.mount });
      rec = p && !p.refused ? p : null;
    }
  } else if (st.kind === 'range') {
    const range = where.mount != null ? selectionRange(where.root) : null;
    if (range) rec = anchors.recordRange(where.root, range, { mount: where.mount });
  } else {
    const text = markdownText(where.md);
    const block = target && target.closest ? target.closest('[data-md-id]') : null;
    const range = block && text != null ? selectionRange(document) : null;
    if (range) rec = anchors.recordSource(block, range, mapOf(where.md, text), text, { md: where.md });
  }
  if (!rec) return;
  swallow(e, true);
  st.finish({ kind: st.kind, record: rec, mount: st.kind === 'source' ? where.md : where.mount });
}

// ── the elements under a point (F.6, U406) ─────────────────────────────────
// elementsAt(x, y) → [{id, type, area}], smallest first (ties by id): the
// drawn scope's elements whose PLACED answer holds the viewport point — a
// range answer whose client rects hold it (area: the rects' total), an
// element answer whose box holds it (rectOf; its area), a point answer whose
// glyph's box at its point (pointAt) holds it (the glyph's area) — and every live box
// grab's page record whose rect, placed in its item's current content box
// (a pane's .mount-host, a markdown item's block: K.2-72's frame of
// reference) and moved by its content box's scroll since the grab (K.2-80:
// the rect was measured at the grab's own scroll), holds it. The point must
// also lie inside the element's clip (the viewport ∩ the well ∩ every
// clipping ancestor: clipFrom, the placement's own), so an element scrolled
// out of a rows-capped pane is never under a press beside it. A hidden, an
// orphaned, a carried guess's or a section answer is never one, nor is a
// pending row. A comment's pick (comments.js) reads it as the chain of the
// live elements under the press. Box reads go through rectOf; nothing is
// drawn or stored here. With {host} (a registered host's name other than the
// page's), the same over THAT host's drawn answers instead, clipped to its own
// well (a chat pin's chain, U434); a host that is not registered answers [].
export function elementsAt(x, y, opts) {
  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return [];
  const hostName = opts && opts.host != null && opts.host !== 'page' ? String(opts.host) : null;
  const h = hostName ? registry.get(hostName) : pageHost;
  if (!h) return [];
  const holds = (r) => !!r && px >= r.left && px <= r.left + r.width && py >= r.top && py <= r.top + r.height;
  const areaOf = (r) => Math.max(0, r.width) * Math.max(0, r.height);
  const fr = frameOf();
  const read = reader(fr);
  const clipped = (start, well) => {
    if (!start) return false;
    const c = clipFrom(start, fr, read, well);
    return !(px >= c.left && px <= c.right && py >= c.top && py <= c.bottom);
  };
  const hits = new Map();
  const hit = (row, area) => {
    const prior = hits.get(row.id);
    if (!prior || area < prior.area) hits.set(row.id, { id: row.id, type: row.type, area });
  };
  const placedHit = (e, well) => {
    const raw = e.raw;
    if (raw.range) {
      let rs = [];
      try { rs = typeof raw.range.getClientRects === 'function' ? [...raw.range.getClientRects()] : []; } catch { rs = []; }
      if (!rs.length) { const r = cfg.rectOf(raw.range); if (r) rs = [r]; }
      const box = (r) => ({ left: r.left, top: r.top,
        width: r.width != null ? r.width : r.right - r.left, height: r.height != null ? r.height : r.bottom - r.top });
      const bs = rs.map(box);
      const sc = raw.range.startContainer;
      if (bs.some(holds) && !clipped(sc && (sc.nodeType === 1 ? sc : sc.parentNode), well)) hit(e.row, bs.reduce((n, b) => n + areaOf(b), 0));
    } else if (raw.el) {
      const r = cfg.rectOf(raw.el);
      // A point answer (4C.1, U532) is held by its glyph's box around the
      // point (pointAt), never by its whole target.
      const pt = e.row.anchor && e.row.anchor.kind === 'point' ? pointOfAnswer(raw) : null;
      if (pt) {
        const p = r ? pointPlace(pt, r) : null;
        const gl = glyphOf(e.row.type || 'element');
        const gb = p ? { left: p.x + gl.dx, top: p.y + gl.dy, width: gl.w, height: gl.h } : null;
        if (gb && holds(gb) && !clipped(raw.el, well)) hit(e.row, areaOf(gb));
      } else if (holds(r) && !clipped(raw.el, well)) hit(e.row, areaOf(r));
    }
  };
  if (!h.page) {
    // The host's drawn groups (its last frame's), each item clipped to the
    // group's own well.
    for (const g of h.groups) {
      if (g.kind !== 'hit' || g.failed) continue;
      const well = wellOf(g, fr);
      if (well === undefined) continue;
      for (const it of g.items) {
        const e = h.answers.get(it.id);
        if (e && e.rule && e.rule.draw === 'hit' && !e.row.pending) placedHit(e, well);
      }
    }
    return [...hits.values()].sort((m, n) => (m.area - n.area) || (m.id < n.id ? -1 : m.id > n.id ? 1 : 0));
  }
  for (const e of answers.values()) {
    if (e.scope !== drawnScope || !e.rule || e.rule.draw !== 'hit' || e.row.pending) continue;
    placedHit(e, fr.pageWell);
  }
  const well = $('main');
  for (const row of scopes[drawnScope].rows.values()) {
    const a = row.anchor;
    if (row.pending || !a || a.kind !== 'page' || a.item == null || !a.rect || !well) continue;
    const item = String(a.item);
    let base = null;
    if (a.mount != null) {
      const pane = [...well.querySelectorAll('.pane[data-pane-id]')].find((el) => el.dataset.paneId === item);
      base = pane ? pane.querySelector('.mount-host') : null;
    } else {
      base = [...well.querySelectorAll('[data-md-id]')].find((el) => el.getAttribute('data-md-id') === item) || null;
    }
    const frame = base ? cfg.rectOf(base) : null;
    if (!frame) continue;
    const sc = a.scroll && typeof a.scroll === 'object' ? a.scroll : {};
    const dx = (Number(sc.left) || 0) - (Number(base.scrollLeft) || 0);
    const dy = (Number(sc.top) || 0) - (Number(base.scrollTop) || 0);
    const r = { left: frame.left + (Number(a.rect.x) || 0) + dx, top: frame.top + (Number(a.rect.y) || 0) + dy,
      width: Number(a.rect.w) || 0, height: Number(a.rect.h) || 0 };
    if (holds(r) && !clipped(base, fr.pageWell)) hit(row, areaOf(r));
  }
  return [...hits.values()].sort((m, n) => (m.area - n.area) || (m.id < n.id ? -1 : m.id > n.id ? 1 : 0));
}

// ── init ────────────────────────────────────────────────────────────────────
// initOverlay(opts?) creates the layer once and wires its inputs; every call
// may set the injectables: {rectOf, raf, now, budget_ms, clips, hold_ms}.
export function initOverlay(opts = {}) {
  for (const k of ['rectOf', 'raf', 'now', 'clips']) {
    if (opts[k] != null) {
      if (typeof opts[k] !== 'function') throw new TypeError(`initOverlay: ${k} must be a function`);
      cfg[k] = opts[k];
    }
  }
  if (opts.budget_ms != null) {
    if (!(opts.budget_ms >= 0)) throw new TypeError('initOverlay: budget_ms must be a number >= 0');
    cfg.budget_ms = opts.budget_ms;
  }
  if (opts.hold_ms != null) {
    if (!(opts.hold_ms >= 0)) throw new TypeError('initOverlay: hold_ms must be a number >= 0');
    cfg.hold_ms = opts.hold_ms;
  }
  if (inited) return;
  inited = true;
  layer = document.createElement('div');
  layer.id = 'el-layer';
  document.body.appendChild(layer);
  // THE BLEND PER MARKER PART's layer (U624): before #el-layer, so the glyphs
  // stay above; no listener (never a hit-test target).
  blendLayer = document.createElement('div');
  blendLayer.id = 'el-layer-blend';
  blendLayer.hidden = true;
  document.body.insertBefore(blendLayer, layer);
  setBlendMode(effectiveMode());
  bus.on('mode', (e) => setBlendMode(e && e.mode ? e.mode : effectiveMode()));
  // The page well, the registry's first host: root and well #main, its layer
  // #el-layer at --z-pins; its place is the resolver paths above, its hidden
  // the one probe (setHiddenProbe), its settle the mount runtime's onSettle
  // and the observer on #main below.
  pageHost.layer = layer;
  registry.set('page', pageHost);
  layer.addEventListener('click', onLayerClick);
  // The detachable glyph (U587): its press, the click a drag owes, the hover.
  layer.addEventListener('pointerdown', onGlyphDown);
  layer.addEventListener('click', onLayerCapture, true);
  document.addEventListener('pointermove', onHoverMove, { capture: true, passive: true });
  onHello(takeLive);
  onFrame('reset', takeLive);
  // THE PHONE PIN's re-asks (U629): a hello or a reset, and a type's frame.
  onHello(repictureAll);
  onFrame('reset', repictureAll);
  onFrame('element:', repictureType);
  onFrame('markdown', scheduleSources);
  onFrame('markdown:remove', scheduleSources);
  bus.on('preview:node', takePreview);
  bus.on('view', syncScope);
  // The phone's answer flipped (U614, REQ@page-stroke-phone): a margin stroke
  // is faded and listed below 760 px, so the page arm builds again.
  bus.on('viewport:narrow', requestDraw);
  // Hidden versus gone, and the store / hidden-state re-resolve (U303,
  // overlay-hidden.js): settles only the mounts watched here.
  setHiddenProbe(hiddenProbe);
  installRetriggers({ watched: () => [...watches.keys()], raf: (fn) => cfg.raf(fn), resolveMount: queueInitial });
  const M = window.__wcMount;
  if (M && typeof M.onSettle === 'function') M.onSettle(() => requestDraw());
  window.addEventListener('scroll', requestDraw, { capture: true, passive: true });
  window.addEventListener('resize', requestDraw, { passive: true });
  // The settle sources: the hosts' named animations, and every well's box.
  for (const t of [...ANIM_STARTS, ...ANIM_ENDS]) document.addEventListener(t, onAnimEvent, { capture: true, passive: true });
  if (typeof ResizeObserver === 'function') {
    wellRO = new ResizeObserver(onWellResize);
    observeWell($('main'), 'page');
  }
  // A layout change of the well moves a pane with no settle, scroll or resize
  // (mounts.js layoutPage: a drag, a resize handle's drop, a run cut by a
  // markdown item, a remote pane:state): one observer asks for a draw while
  // any marker is built — or any page stroke is held (U614: a page whose only
  // elements are page strokes, every one orphaned, still sees its items come
  // back; a run re-order is a style or child change here, so the arrow over
  // it is re-placed with no other subscription).
  const well = $('main');
  if (well && typeof MutationObserver === 'function') {
    new MutationObserver(() => { if (pageHost.groups.length || pageRowCount) requestDraw(); })
      .observe(well, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] });
  }
}
