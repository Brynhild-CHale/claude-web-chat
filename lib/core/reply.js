// lib/core/reply.js — the one shape of "what Claude said back", as a node keeps it.
//
// A node records the prompt that started its turn (trigger.message) but, until
// now, nothing of the answer — so a replay caption could show only one side of
// the conversation. The Stop hook now sends a short summary of Claude's final
// reply and the daemon stores it as `trigger.reply` (and on a folded entry, for
// a turn that changed nothing). This is that summary's one definition.
//
// It lives in core because two processes apply it: the hook, which summarises
// before sending (a long reply never crosses the wire), and the daemon, which
// re-applies it to whatever the request body carried (a request body is not
// trusted to already be short). Applying it twice is a no-op — the output of
// summarizeReply is a fixed point of it.

// The cap, in characters (code points — an emoji is not split in half). Long
// enough for the gist of an answer's first sentence or two; short enough that
// fifty folded entries in _meta.json stay small.
const REPLY_SUMMARY_MAX = 280;

// Bound the work before collapsing: a reply can be megabytes, and only its head
// is ever kept. Generous, so a reply that opens with a wall of whitespace (a
// fenced block's indentation) still yields its first real words.
const SCAN_MAX = 64 * 1024;

// summarizeReply(text) → string ('' for anything that is not a non-blank string)
// Whitespace — newlines included — collapses to single spaces, the result is
// trimmed, and anything past REPLY_SUMMARY_MAX is cut with a trailing '…'
// (which counts toward the cap).
function summarizeReply(text) {
  if (typeof text !== 'string') return '';
  const flat = text.slice(0, SCAN_MAX).replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  if (chars.length <= REPLY_SUMMARY_MAX) return flat;
  return chars.slice(0, REPLY_SUMMARY_MAX - 1).join('').trimEnd() + '…';
}

module.exports = { REPLY_SUMMARY_MAX, summarizeReply };
