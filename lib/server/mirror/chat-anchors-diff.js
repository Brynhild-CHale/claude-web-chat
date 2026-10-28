// lib/server/mirror/chat-anchors-diff.js — the chat anchor on one line of a
// turn's code diff (PLAN.md 3A.4; DECISIONS.md L1, L4, L5; RULED Q7 and
// S1-confirm), a kind of the chat-anchor resolver (./chat-anchors.js).
//
//   diffLineKind = {kind: 'diff-line', record(input, k), resolve(anchor, k)}
//
// It plugs in through the resolver's `kinds` option — the chat-anchors SOURCES
// row in ./index.js is `createChatAnchorsSource({kinds: [diffLineKind]})` — so
// the resolver itself is never edited for it (the engines rule). `k` is the
// resolver's helper bag (chat-anchors.js's header): this kind reads the turn's
// diff only through k.read.diff({turn}) — the facade's own served codediff
// answer, after redactOut — and the turn only through k.turnOf (the model's
// alias map, so U413's re-keys are followed). It never reads the shadow store
// or a diff file, never parses a patch itself (rows come from lib/core/markdown
// diffRows, the one hunk-counting grammar renderDiff draws with), writes
// nothing and keeps nothing between calls.
//
// THE KEY is the turn: turn_id with a line fingerprint. node_id is a hint the
// caller may hand in and the record keeps; nothing ever resolves through it (a
// node's diff is recomputed from shadow trees, never the turn's record).
//
// RECORD. input {kind: 'diff-line', turn_id, file, side: 'new' | 'old', line,
// node_id?}. `file` names a file the way the turn's record lists it (relative
// to the project root, files[].path) or as its patch header spells it: its
// section is the one whose `diff --git` header ends ` b/<file>` or
// ` a/<file>`, or whose `--- a/` / `+++ b/` row names it; else the one section
// whose header or row ends `/<file>` (a project below the repository's top
// level), the chrome's own splitPatch rule. The row is the one of that section
// whose number on `side` is `line` (a context row has both). The anchor, U415's
// diff-line row of the one record table (S1-confirm), in this order:
//   {v: 1, kind: 'diff-line', conversation_id, session_id, turn_id, file, side,
//    line, line_fp: {h}, quote: {exact, prefix, suffix}, marks, label, node_id?}
// with no fp. conversation_id, session_id and turn_id are the model header's
// (turn_id its current id). line_fp.h is the first FP_HEX hex of stableHash
// over [file, side, the row's text, [up to 2 rows before it], [up to 2 after
// it]] — rows of the same hunk only. quote is anchors.js quoteOf over those
// rows joined by '\n' around the row: exact the row's text (its first
// quote_max characters when longer), prefix and suffix at most ctx_n (32)
// characters each — the ±2-row context lives whole in line_fp only. marks is
// marksIn's count over exact; label `diff line <file>:<line>`.
// Answers: {anchor}; a pending diff {refused: 'pending', hint: PENDING_HINT};
// an unavailable or expired diff, or none, {unavailable: true, rule}; a bad
// request, a file not in the diff or no row at that line {invalid, hint}. A
// provisional turn (a hook id no transcript opener has bound) is NOT refused:
// its diff is keyed by the turn and stays readable after the re-key (codediff's
// turnDiff tries the header's `replaces`), and D3 refuses rh_/rm_ ITEMS, whose
// text may still change; a diff line's text never does.
//
// RESOLVE, after the resolver's (i) indexing and (ii) the turn through the
// alias map (k.turn_id is the turn's current id):
//   the diff pending  → indexing, how 'diff-pending', note PENDING_NOTE (Q7 = a:
//                       the chrome shows the note instead of EXPLAIN.indexing)
//   unavailable       → unavailable, rule its reason
//   expired           → unavailable, its rule and its note (the retention row
//                       that removed it and that row's user_text)
//   none              → unavailable, rule 'gone'
//   a record: the anchored file's rows on `side`, then, in order —
//     (a) the row at `line` whose fingerprint is line_fp     → exact, how 'line'
//     (b) the rows whose fingerprint is line_fp: one         → re-resolved, how
//         'fingerprint' (`at` its line); several → the nearest the recorded
//         line (ties: the first), how 'position'
//     (c) a row redact.js matchMasked aligns the quote with THROUGH a mark (a
//         value learned after create), over the same ±2-row window the quote
//         was made over → masked, how 'mask' (several: the nearest)
//     (d) the one row whose text alone equals quote.exact, when that text
//         holds at least TEXT_LITERAL_MIN characters besides its marks and
//         its +/-/space column (a row that is all mask is no evidence of a
//         place) → re-resolved, how 'text'
//     (e) none → unavailable, how 'line-not-found': the line is not in this
//         record — a record written before tranche 1's line-preserving
//         redaction collapsed a multi-line secret into one row and shifted
//         every number after it (R4 §4).
//   A row found by (a), (b) or (d) that holds more marks than the anchor's
//   `marks` answers masked (a value learned after create), never exact.
// `at` is {file, side, line}. An answer carries ids, numbers and its lines,
// never the diff's text.
//
// Dependency direction: lib/server; imports lib/core and ./chat-anchors (FP_HEX).

'use strict';

const { diffRows } = require('../../core/markdown');
const { stableHash } = require('../../core/stable-json');
const { FP_HEX } = require('./chat-anchors');

const KIND = 'diff-line';
const RECORD_V = 1;
const SIDES = Object.freeze(['new', 'old']);
// The rows of the same hunk on each side of the anchored one that its
// fingerprint covers (and its quote's prefix and suffix are cut from).
const CONTEXT_ROWS = 2;
// The text-alone match (d) needs this many characters of the row besides its
// marks and its first column: a row that is a mask, or a brace, places nothing
// (matchMasked's evidence floor, MATCH_LITERAL_MIN, has the same size).
const TEXT_LITERAL_MIN = 8;
// The longest `file` a request may name, and a node id hint's grammar.
const FILE_MAX = 4096;
const NODE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
// Q7 = a: the pending diff's own line, carried in the answer's `note`.
const PENDING_NOTE = 'the code diff for this turn is still being prepared';
const PENDING_HINT = 'the diff for this turn is still being prepared';
const HINTS = Object.freeze({
  request: 'A diff-line pin names a turn, a file, a side (new or old) and a line.',
  node: 'A node hint is a node id.',
  file: 'That file is not in this turn\'s code diff.',
  line: 'There is no line with that number on that side of the file in this turn\'s code diff.',
  text: 'There are no words on this line to pin.',
});

function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
const isId = (v) => typeof v === 'string' && v.length > 0;
const isLine = (v) => Number.isSafeInteger(v) && v >= 1;
const isSide = (v) => SIDES.includes(v);

// ── the diff, as served ──────────────────────────────────────────────────────

// The turn's served diff: {patch} for a record, else {pending} | {gone, rule, note?}.
async function readDiff(k, turnId) {
  const read = k.read && typeof k.read.diff === 'function' ? k.read.diff : null;
  const d = read ? await read({ turn: turnId }) : null;
  if (!isPlain(d) || d.unavailable === true) return { gone: true, rule: 'gone' };
  if (d.status === 'pending') return { pending: true };
  if (typeof d.patch === 'string' && d.status === 'ready') return { patch: d.patch };
  const rule = (isId(d.rule) && d.rule) || (isId(d.reason) && d.reason) || (d.status === 'unavailable' ? 'unavailable' : 'gone');
  return { gone: true, rule, note: isId(d.note) ? d.note : null };
}

// The patch's file sections, each {head, names, rows}: every add, del and ctx
// row of a hunk, as {text, old, new, hunk, i} (`hunk` the hunk's row list, `i`
// the row's place in it). Rows come from diffRows alone; a row outside any
// hunk carries no number and is left out, and the rows past diffRows's cap
// ('more') are not shown anywhere, so none is pinnable.
function sectionsOf(patch) {
  const out = [];
  let sec = null;
  let hunk = null;
  for (const r of diffRows(patch)) {
    if (r.kind === 'more') break;
    if (r.kind === 'meta') {
      if (r.text.startsWith('diff --git ')) {
        sec = { head: r.text, names: [], rows: [] };
        out.push(sec);
        hunk = null;
      } else if (r.text.charAt(0) !== '\\') { // "\ No newline at end of file" stays in its hunk
        hunk = null;
        const m = sec ? /^(?:--- a\/|\+\+\+ b\/)(.+?)\t?$/.exec(r.text) : null;
        if (m) sec.names.push(m[1]);
      }
      continue;
    }
    if (r.kind === 'hunk') { hunk = sec ? [] : null; continue; }
    if (!hunk || (r.old === null && r.new === null)) continue;
    const row = { text: r.text, old: r.old, new: r.new, hunk, i: hunk.length };
    hunk.push(row);
    sec.rows.push(row);
  }
  return out;
}

// The section a request's `file` names (the header comment's rule), or null.
function sectionFor(sections, file) {
  const exact = sections.find((s) => s.head.endsWith(` b/${file}`) || s.head.endsWith(` a/${file}`) || s.names.includes(file));
  if (exact) return exact;
  const tail = `/${file}`;
  const near = sections.filter((s) => s.head.endsWith(tail) || s.names.some((n) => n.endsWith(tail)));
  return near.length === 1 ? near[0] : null;
}

// A row's ±CONTEXT_ROWS neighbours inside its hunk.
function around(row) {
  return {
    before: row.hunk.slice(Math.max(0, row.i - CONTEXT_ROWS), row.i).map((r) => r.text),
    after: row.hunk.slice(row.i + 1, row.i + 1 + CONTEXT_ROWS).map((r) => r.text),
  };
}

function lineFp(file, side, row) {
  const { before, after } = around(row);
  return stableHash([file, side, row.text, before, after]).slice(0, FP_HEX);
}

// The rows around `row` joined by '\n', and the row's span in that text.
function windowOf(row) {
  const { before, after } = around(row);
  const head = before.length ? `${before.join('\n')}\n` : '';
  const text = `${head}${row.text}${after.length ? `\n${after.join('\n')}` : ''}`;
  return { text, start: head.length, end: head.length + row.text.length };
}

// The row's text as a quote holds it (its first quote_max characters).
const quotedText = (k, text) => text.slice(0, k.quote.CONFIG.quote_max);

// The characters of a row's quoted text besides its marks and its first column.
function literalCount(k, exact) {
  let n = exact.length - 1;
  for (const m of k.quote.marksIn(exact)) n -= m.end - m.start;
  return n;
}

// The row of `rows` nearest `line` on `side` (ties: the first).
function nearest(rows, side, line) {
  let best = null;
  for (const r of rows) if (!best || Math.abs(r[side] - line) < Math.abs(best[side] - line)) best = r;
  return best;
}

// ── record ───────────────────────────────────────────────────────────────────

async function record(input, k) {
  const { turn_id: turnId, file, side, line } = input;
  if (!isId(turnId) || typeof file !== 'string' || !file || file.length > FILE_MAX || !isSide(side) || !isLine(line)) {
    return k.invalid(HINTS.request);
  }
  if (input.node_id !== undefined && input.node_id !== null && !(typeof input.node_id === 'string' && NODE_ID_RE.test(input.node_id))) {
    return k.invalid(HINTS.node);
  }
  const t = k.turnOf(turnId);
  if (!t) return k.unavailable('gone');
  const d = await readDiff(k, t.id);
  if (d.pending) return { refused: 'pending', hint: PENDING_HINT };
  if (d.gone) return k.unavailable(d.rule);
  const sec = sectionFor(sectionsOf(d.patch), file);
  if (!sec) return k.invalid(HINTS.file);
  const row = sec.rows.find((r) => r[side] === line);
  if (!row) return k.invalid(HINTS.line);
  const w = windowOf(row);
  const q = row.text ? k.quote.quoteOf({}, w.text, w.start, w.start + quotedText(k, row.text).length) : null;
  if (!q) return k.invalid(HINTS.text);
  const anchor = {
    v: RECORD_V,
    kind: KIND,
    conversation_id: t.conversation_id,
    session_id: t.session_id || null,
    turn_id: t.id,
    file,
    side,
    line,
    line_fp: { h: lineFp(file, side, row) },
    quote: q.quote,
    marks: k.quote.marksIn(q.quote.exact).length,
    label: `diff line ${file}:${line}`,
  };
  if (typeof input.node_id === 'string') anchor.node_id = input.node_id;
  return { anchor };
}

// ── resolve ──────────────────────────────────────────────────────────────────

function validAnchor(a) {
  return typeof a.file === 'string' && a.file && isSide(a.side) && isLine(a.line)
    && isPlain(a.line_fp) && isId(a.line_fp.h)
    && isPlain(a.quote) && isId(a.quote.exact);
}

async function resolve(anchor, k) {
  const turnId = k.turn_id;
  if (!validAnchor(anchor)) return k.answer('unavailable', { rule: 'invalid', turn_id: turnId });
  const d = await readDiff(k, turnId);
  if (d.pending) return k.answer('indexing', { how: 'diff-pending', note: PENDING_NOTE, turn_id: turnId });
  if (d.gone) return k.answer('unavailable', { rule: d.rule, note: d.note, turn_id: turnId });
  const { file, side, line } = anchor;
  const sec = sectionFor(sectionsOf(d.patch), file);
  const rows = sec ? sec.rows.filter((r) => r[side] !== null) : [];
  const marks = Number.isSafeInteger(anchor.marks) && anchor.marks >= 0 ? anchor.marks : 0;
  const placed = (state, how, row) => {
    const more = k.quote.marksIn(quotedText(k, row.text)).length > marks;
    return k.answer(more ? 'masked' : state, { how, at: { file, side, line: row[side] }, turn_id: turnId });
  };
  // (a) the recorded line, (b) its fingerprint elsewhere.
  const fp = anchor.line_fp.h;
  const at = rows.find((r) => r[side] === line);
  if (at && lineFp(file, side, at) === fp) return placed('exact', 'line', at);
  const same = rows.filter((r) => lineFp(file, side, r) === fp);
  if (same.length === 1) return placed('re-resolved', 'fingerprint', same[0]);
  if (same.length > 1) return placed('re-resolved', 'position', nearest(same, side, line));
  // (c) through a mark learned after create.
  const quote = { exact: anchor.quote.exact, prefix: String(anchor.quote.prefix || ''), suffix: String(anchor.quote.suffix || '') };
  const hits = [];
  for (const r of rows) {
    const w = windowOf(r);
    const m = k.quote.matchMasked(w.text, quote, { pos: { start: w.start, end: w.end } });
    if (m && m.masked && m.start >= w.start && m.end <= w.end) hits.push(r);
  }
  if (hits.length) {
    const r = nearest(hits, side, line);
    return k.answer('masked', { how: 'mask', at: { file, side, line: r[side] }, turn_id: turnId });
  }
  // (d) the text alone, unique and with words of its own.
  if (literalCount(k, quote.exact) >= TEXT_LITERAL_MIN) {
    const texts = rows.filter((r) => quotedText(k, r.text) === quote.exact);
    if (texts.length === 1) return placed('re-resolved', 'text', texts[0]);
  }
  // (e) not in this record.
  return k.answer('unavailable', { how: 'line-not-found', turn_id: turnId });
}

const diffLineKind = Object.freeze({ kind: KIND, record, resolve });

module.exports = {
  diffLineKind,
  PENDING_NOTE,
  PENDING_HINT,
  CONTEXT_ROWS,
  TEXT_LITERAL_MIN,
};
