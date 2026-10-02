// lib/core/text.js — the one control, bidi and invisible-character guard.
//
// Text that came from outside the program and is shown or replayed somewhere
// else has three ways to say something other than what it appears to say:
//
//   controls    C0 and C1 control characters, DEL, and the two Unicode line
//               separators (U+2028, U+2029): an escape sequence reaching a
//               terminal, a NUL ending a C string early, a line break that
//               starts a new line of a block the text was meant to sit inside.
//   bidi        the directional marks, embeddings, overrides and isolates
//               (U+061C, U+200E/U+200F, U+202A to U+202E, U+2066 to U+2069):
//               they reorder what is drawn, so a name or a message can read
//               one way on screen and say another in the bytes.
//   invisible   the zero-width space (U+200B) and the BOM (U+FEFF): text that
//               looks equal to another and is not.
//
// Several places clean the same kind of value — a project's display name
// (lib/core/project-identity), a composer message, an answer's free text, a
// channel envelope's message block — and the first drafts of those had three
// different sets. So the sets live here, once, and every one of those callers
// asks this module: a field that REFUSES such text asks hasForbidden, a field
// that CLEANS it calls stripControls. A second filter of its own beside these
// is the defect the conventions tripwire exists to catch.
//
// What is NOT in the sets, on purpose: the zero-width joiner (U+200D) and
// non-joiner (U+200C), variation selectors, tag characters and every other
// format character an emoji sequence or a script needs. A family emoji, a
// flag, a coloured heart and a Persian word all survive both functions.
//
// The three expressions match ONE character of their set and are not global,
// so .test() and .exec() are stateless on them. To replace every match with
// something other than nothing, build a global copy from `.source`.
//
// Pure: no imports, no state.

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const BIDI_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const INVISIBLE_RE = /[\u200b\ufeff]/;

// The union, once as a test (not global: stateless) and twice as a remover —
// the second keeps a newline and a tab. A carriage return is NOT kept: a caller
// that wants line breaks normalises CRLF (and a lone CR) to LF first, as the
// composer does, so a kept line break is always exactly one LF.
const ANY = `${CONTROL_RE.source}|${BIDI_RE.source}|${INVISIBLE_RE.source}`;
const FORBIDDEN = new RegExp(ANY);
const STRIP = new RegExp(ANY, 'g');
const STRIP_KEEP_LINES = new RegExp(`(?![\\t\\n])(?:${CONTROL_RE.source})|${BIDI_RE.source}|${INVISIBLE_RE.source}`, 'g');

// `s` with every control, bidi and invisible character removed; with
// keepNewlines, `\n` and `\t` stay. Anything that is not a string is treated
// as empty text: the guard never invents text out of a value that was not text.
function stripControls(s, { keepNewlines = false } = {}) {
  if (typeof s !== 'string') return '';
  return s.replace(keepNewlines ? STRIP_KEEP_LINES : STRIP, '');
}

// Whether `s` holds any character of the three sets — for a field that refuses
// such text rather than cleaning it. Not a string: false (the caller checks the
// type; this answers only about characters).
function hasForbidden(s) {
  return typeof s === 'string' && FORBIDDEN.test(s);
}

module.exports = { CONTROL_RE, BIDI_RE, INVISIBLE_RE, stripControls, hasForbidden };
