// The channel envelope — pure builders that turn a batch of queued signals into
// the one thing the bridge is allowed to push: a `notifications/claude/channel`
// payload of `{ content, meta }`.
//
// Two hard constraints from the wire contract, enforced HERE so the bridge never
// has to think about them:
//   * `content` is ONE string. It carries a sanitized SUMMARY only — never a
//     capture body or a signal payload (prompt-injection surface).
//     Claude hydrates the real payload by tool call (get_captures / get_store).
//   * `meta` keys are `[A-Za-z0-9_]` (the harness silently drops hyphens) and
//     values are strings. Anything else is coerced or dropped by sanitizeMeta.
//
// The meta vocabulary is a VERSIONED CONTRACT: the base keys below plus the
// kind-specific extras, tripwire-tested in test/conventions.test.js so a drift in
// what the bridge emits fails the build. Zero I/O — trivially unit-testable.

// The allowed meta keys — the versioned vocabulary. `kind|seq|origin|mount`
// are the base; the rest are kind-specific extras (batch bookkeeping + the ids
// Claude fetches by). NOTE: the event source is `origin`, NOT `source` — the
// harness stamps `source="<channel-name>"` (e.g. web-chat) on the <channel> tag
// itself, so a meta `source` would collide. The tripwire asserts wakeEnvelope
// emits nothing outside this set.
const META_KEYS = ['kind', 'seq', 'origin', 'mount', 'count', 'ids', 'captures'];

const SUMMARY_MAX = 200;
const META_VALUE_MAX = 160;
// The envelope `content` is delivered VERBATIM as prompt context — a live channel
// push, or turn-begin's parked-delivery injection — so a large batch (a capture
// flood, or a park merged over a whole session) must not blast an arbitrarily long
// per-item list into the user's next message. Cap the item lines; every id still
// rides the `ids`/`captures` meta, so Claude fetches the omitted bodies by tool
// call (the envelope's "summary only, bodies on demand" contract holds regardless).
const SUMMARY_LINES_MAX = 50;

// The skill-routing hint. Rides a comment's payload — both the wake
// content (when a batch carries a comment) and each get_comments item — so a pin
// submission tells Claude how to respond. Names the skill, not the mechanics.
const RESPOND_HINT = '↳ To respond to a comment, use the respond-to-comment skill: read the thread with get_comments, reply with reply_comment (keep it short, like a doc comment).';

// Matches C0 control chars + DEL. \s already covers \t\n\r\f\v; this catches the
// rest (NUL, bells, escape, etc.) which could smuggle terminal/markup tricks.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

// Collapse a summary to a single safe line: control chars → space, angle
// brackets stripped so a summary can't forge or close a `<channel>` tag,
// whitespace flattened, then length-capped with an ellipsis. This is the only
// defense a summary needs because it is ALWAYS ours (id/host/profile/key) —
// never third-party body text, which is the whole point of the envelope.
function sanitizeSummary(str, { max = SUMMARY_MAX } = {}) {
  let s = String(str == null ? '' : str);
  s = s.replace(CONTROL_CHARS, ' ');
  s = s.replace(/[<>]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s;
}

// Meta keys must match /[A-Za-z0-9_]/; drop every other char (matching the
// harness, which silently drops hyphens — we drop them here so the key we log is
// the key that actually lands).
function sanitizeMetaKey(key) {
  return String(key == null ? '' : key).replace(/[^A-Za-z0-9_]/g, '');
}

// Meta values must be strings; coerce, flatten control chars/whitespace, strip
// the angle-brackets/quotes that would break out of an XML attribute value, cap.
// Every current meta value is internally generated, but `mount` can carry a
// Claude-chosen id — so this is defense-in-depth, not decoration.
function sanitizeMetaValue(val) {
  let s = typeof val === 'string' ? val : (val == null ? '' : String(val));
  s = s.replace(CONTROL_CHARS, ' ').replace(/[<>"]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > META_VALUE_MAX) s = s.slice(0, META_VALUE_MAX - 1) + '…';
  return s;
}

// Sanitize a whole meta object: valid string-keyed, string-valued map with
// empty/nullish entries dropped (an absent attribute is cleaner than "").
function sanitizeMeta(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null || v === '') continue;
    const key = sanitizeMetaKey(k);
    if (!key) continue;
    const value = sanitizeMetaValue(v);
    if (value === '') continue;
    out[key] = value;
  }
  return out;
}

// Build the `{ content, meta }` a `wake` batch becomes. `batch` is the array of
// queue items (`{ id, kind, source, why_wake, summary, origin_mount, seq,
// capture_id? }`). Opts carry the wake's own `reason`/`source`/`seq` (from the
// flush) for meta, plus an optional `note` — free-text batch context the user typed
// in the rail (sanitized like a summary; never inlines any body).
function wakeEnvelope(batch, { reason, source, seq, note } = {}) {
  const items = (Array.isArray(batch) ? batch : []).filter(Boolean);

  const allLines = items.map((it) => {
    const kind = sanitizeSummary(it.kind || 'signal', { max: 24 });
    const summary = sanitizeSummary(it.summary || it.why_wake || it.id || '');
    return `- [${kind}] ${summary}`;
  });
  const n = items.length;
  // Bound the injected context (see SUMMARY_LINES_MAX): keep the most-recent lines
  // and disclose the omitted remainder, which Claude fetches via the ids meta.
  let lines = allLines;
  if (allLines.length > SUMMARY_LINES_MAX) {
    const omitted = allLines.length - SUMMARY_LINES_MAX;
    lines = [
      `- …${omitted} earlier signal${omitted === 1 ? '' : 's'} omitted (fetch by tool call)`,
      ...allLines.slice(-SUMMARY_LINES_MAX),
    ];
  }
  const header = n === 1
    ? 'A queued signal was pushed to Claude:'
    : `${n} queued signals were pushed to Claude:`;
  const noteText = note ? sanitizeSummary(note, { max: 280 }) : '';
  const noteLine = noteText ? `Context from the user: ${noteText}` : null;
  // A comment in the batch appends the skill-routing hint once (not per line).
  const hintLine = items.some((it) => (it.kind || '') === 'comment') ? RESPOND_HINT : null;
  const content = [
    noteLine,
    n ? header : 'A wake was pushed to Claude (no signals).',
    ...lines,
    hintLine,
  ].filter(Boolean).join('\n');

  const kinds = [...new Set(items.map((it) => it.kind || 'signal'))];
  const ids = items.map((it) => it.id).filter(Boolean);
  const captureIds = items.map((it) => it.capture_id).filter(Boolean);
  // A single item's source/mount are specific enough to surface; a mixed batch
  // reports the wake-level `source` (e.g. 'queue') and no single mount.
  const meta = sanitizeMeta({
    kind: kinds.length === 1 ? kinds[0] : 'batch',
    count: String(n),
    seq: seq != null
      ? String(seq)
      : (items.length ? String(Math.max(...items.map((it) => Number(it.seq) || 0))) : undefined),
    origin: source || (n === 1 ? items[0].source : undefined),
    mount: n === 1 ? items[0].origin_mount : undefined,
    ids: ids.join(','),
    captures: captureIds.join(','),
  });

  return { content, meta };
}

module.exports = { wakeEnvelope, sanitizeSummary, sanitizeMeta, sanitizeMetaKey, sanitizeMetaValue, META_KEYS, RESPOND_HINT };
