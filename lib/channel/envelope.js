// The channel envelope — pure builders that turn a batch of queued items into
// the one thing the bridge is allowed to push: a `notifications/claude/channel`
// payload of `{ content, meta }`. A parked delivery (lib/hooks/turn-begin.js)
// injects the same `content`, so everything here holds for both paths.
//
// Two hard constraints from the wire contract, enforced HERE so the bridge never
// has to think about them:
//   * `content` is ONE string. For every signal kind it carries a sanitized
//     SUMMARY only — never a capture body or a signal payload (prompt-injection
//     surface). Claude hydrates the real payload by tool call (get_captures /
//     get_store). The one exception is a composer message (kind 'message'):
//     it is the user's own words, so its text is the payload, rendered as a
//     quoted, marked block that no text inside it can end or forge (spec §6.5,
//     messageBlock below). A stop request (source 'task-stop') is its own
//     block and carries a task id and nothing else.
//   * `meta` keys are `[A-Za-z0-9_]` (the harness silently drops hyphens) and
//     values are strings. Anything else is coerced or dropped by sanitizeMeta.
//
// The meta vocabulary is a VERSIONED CONTRACT: the base keys below plus the
// kind-specific extras, tripwire-tested in test/conventions.test.js so a drift in
// what the bridge emits fails the build. Zero I/O — trivially unit-testable.
//
// Dependency direction: lib/channel is a shared library; it imports lib/core
// only (never lib/server), so the constants the envelope needs live here.

const { CONTROL_RE, stripControls } = require('../core/text');
const { messageMarker } = require('../core/prompt-class');

// The allowed meta keys — the versioned vocabulary. `kind|seq|origin|mount`
// are the base; the rest are kind-specific extras (batch bookkeeping + the ids
// Claude fetches by). NOTE: the event source is `origin`, NOT `source` — the
// harness stamps `source="<channel-name>"` (e.g. web-chat) on the <channel> tag
// itself, so a meta `source` would collide. The tripwire asserts wakeEnvelope
// emits nothing outside this set.
//
// `push_origin` (`local`|`remote`) and `device` (`desktop`|`mobile`) are the
// push's provenance (lib/server/domain/queue provenance): remote = pushed through
// the tunnel portal. The key is `push_origin`, not `origin`, because `origin`
// already means the event source above and is part of this contract.
const META_KEYS = ['kind', 'seq', 'origin', 'mount', 'count', 'ids', 'captures', 'push_origin', 'device'];

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

// The budget for an envelope's `content` (spec §6.3, §6.5). A parked delivery is
// a UserPromptSubmit `additionalContext` that also carries turn-begin's prefix
// and possibly its skew, drift and notice lines, under Claude Code's 10,000
// characters per string; gate V29 (a) measures that ceiling, and this value
// (and the composer's limits with it) follows the measurement. Its one home is
// here: lib/channel may not import lib/server, so the composer
// (lib/server/composer.js) imports it from this module when it needs it.
// Signal lines are dropped, oldest first, to stay inside it; a message block
// never is (see wakeEnvelope).
const ENVELOPE_MAX = 9000;

// ── the one control, bidi and invisible guard ───────────────────────────────
//
// lib/core/text.js owns the three character sets. A summary or a meta value is
// one line, so a control character becomes a space (through ONE global copy of
// CONTROL_RE, built from its source as text.js's header says) and the bidi and
// invisible characters go with stripControls. A message keeps its line breaks:
// stripControls(text, {keepNewlines: true}).
const CONTROLS = new RegExp(CONTROL_RE.source, 'g');

// The delivery-marker defang. `[web-chat message m-…]` is how the mirror's
// transcript scan (lib/server/mirror/carriers.js, through prompt-class
// messageMarkers) confirms that a composer message reached Claude. Only
// messageBlock and stopRequestBlock may write one, so every other text that
// reaches the envelope — a capture summary, a Push note, a store key, a mount
// id, a message's own text and args — has its `[` turned into `(`, in any case.
// It runs after the control strip and the whitespace collapse, which could
// otherwise assemble the phrase out of pieces.
const MARKER_PHRASE = /\[(?=web-chat message)/gi;
function defangMarker(s) {
  return s.replace(MARKER_PHRASE, '(');
}

// Collapse a summary to a single safe line: control chars → space, bidi and
// invisible chars removed, angle brackets stripped so a summary can't forge or
// close a `<channel>` tag, whitespace flattened, the delivery marker defanged,
// then length-capped with an ellipsis. This is the only defense a summary needs
// because it is ALWAYS ours (id/host/profile/key) — never third-party body text,
// which is the whole point of the envelope.
function sanitizeSummary(str, { max = SUMMARY_MAX } = {}) {
  let s = String(str == null ? '' : str);
  s = stripControls(s.replace(CONTROLS, ' '));
  s = s.replace(/[<>]/g, '');
  s = defangMarker(s.replace(/\s+/g, ' ').trim());
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s;
}

// Meta keys must match /[A-Za-z0-9_]/; drop every other char (matching the
// harness, which silently drops hyphens — we drop them here so the key we log is
// the key that actually lands).
function sanitizeMetaKey(key) {
  return String(key == null ? '' : key).replace(/[^A-Za-z0-9_]/g, '');
}

// Meta values must be strings; coerce, flatten control chars/whitespace, drop
// bidi and invisible chars, strip the angle-brackets/quotes that would break out
// of an XML attribute value, defang the delivery marker (the harness writes meta
// into the <channel> tag the transcript keeps), cap. Every current meta value is
// internally generated, but `mount` can carry a Claude-chosen id — so this is
// defense-in-depth, not decoration.
function sanitizeMetaValue(val) {
  let s = typeof val === 'string' ? val : (val == null ? '' : String(val));
  s = stripControls(s.replace(CONTROLS, ' '));
  s = defangMarker(s.replace(/[<>"]/g, '').replace(/\s+/g, ' ').trim());
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

// ── the message text ────────────────────────────────────────────────────────

// The tags Claude Code writes around its own text in the prompt position. A
// message that could open or close one of them could end the block it sits in,
// or pose as the harness, so inside a message (text, args, a path) each such tag
// loses its brackets to look-alikes; every other `<…>` (pasted code: `<div>`,
// `Array<string>`, `a < b`) survives byte for byte.
const HARNESS_TAGS = Object.freeze([
  'channel',
  'system-reminder',
  'task-notification',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
]);
// `<`, an optional `/`, one of the names as a whole tag name (not followed by a
// name character, so `<channels>` is not one), any case.
const HARNESS_TAG_OPEN = new RegExp(`<\\/?(?:${HARNESS_TAGS.join('|')})(?![A-Za-z0-9_-])`, 'gi');

// Every harness tag's `<` becomes `‹` (U+2039), and the first `>` after it on the
// same line becomes `›` (U+203A); a tag with no `>` on its line still loses its
// `<`. Positions are found first and replaced after, so two tags that share one
// `>` (`<channel <channel>`) are both caught.
function defangHarnessTags(s) {
  const opens = [];
  for (const m of s.matchAll(HARNESS_TAG_OPEN)) opens.push(m.index);
  if (!opens.length) return s;
  const closes = new Set();
  for (const at of opens) {
    const nl = s.indexOf('\n', at);
    const gt = s.indexOf('>', at);
    if (gt >= 0 && (nl < 0 || gt < nl)) closes.add(gt);
  }
  const lt = new Set(opens);
  let out = '';
  let from = 0;
  for (const at of [...lt, ...closes].sort((a, b) => a - b)) {
    out += s.slice(from, at) + (lt.has(at) ? '‹' : '›');
    from = at + 1;
  }
  return out + s.slice(from);
}

// A message's text, made safe to quote: any CR to LF (the composer normalises
// first; this is the backstop), the one guard (lib/core/text.js) keeping line
// breaks and tabs, the harness-tag defang, then the marker defang. With
// `oneLine`, every line break becomes one space before the defangs (args and
// paths sit inside a single line, and a joined line must not assemble a marker).
function cleanMessage(text, { oneLine = false } = {}) {
  let s = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : '';
  s = stripControls(s, { keepNewlines: true });
  if (oneLine) s = s.replace(/\n/g, ' ');
  return defangMarker(defangHarnessTags(s));
}

function sanitizeMessage(text) {
  return cleanMessage(text);
}

// A file's size as the File line shows it: bytes under 1 KiB, one decimal of KB
// under 1 MiB, one decimal of MB above.
function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${Math.floor(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── the blocks ──────────────────────────────────────────────────────────────

// A stop request's task id comes from the mirror's task row (spec §6.9); it is
// the only field of the item the block reads.
const STOP_TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// The marker for an item, or null when the id is not one messageMarker accepts
// (the queue mints the ids, so a bad one renders nothing rather than a header
// the scan could never confirm).
function markerOf(item) {
  try {
    return messageMarker(item && item.msg_id);
  } catch {
    return null;
  }
}

// The Skill line, from the shape the composer's validation stored (ruling C2
// (d)): `{name, args}` repeats args that fit its limit, `{name, args_in_text:
// true}` points Claude at the quoted text after `/name`, because those args were
// too long to copy. This module measures nothing: SKILL_ARGS_MAX's one home is
// lib/server/composer.js, which chose the shape.
function skillLine(skill) {
  if (!skill || typeof skill !== 'object') return null;
  const name = cleanMessage(skill.name, { oneLine: true }).trim();
  if (!name) return null;
  const head = `Skill requested: /${name} — call the Skill tool with skill ${JSON.stringify(name)}`;
  if (skill.args_in_text === true) {
    return `${head} and, as its args, the message text after "/${name}" quoted above (without the > marks), before you answer.`;
  }
  const args = cleanMessage(skill.args, { oneLine: true }).trim();
  return `${head}${args ? ` and args ${JSON.stringify(args)}` : ''} before you answer.`;
}

function fileLine(file) {
  if (!file || typeof file !== 'object') return null;
  const p = cleanMessage(file.path, { oneLine: true });
  if (!p.trim()) return null;
  const size = formatSize(file.bytes);
  return `File attached: ${p}${size ? ` (${size})` : ''} — read it with the Read tool before acting on the message.`;
}

// The two block headers. The rules files quote them (§6.8), and
// test/rules-text-truth.test.js holds the two together.
const MESSAGE_HEADER = 'Message from the user';
const STOP_REQUEST_HEADER = 'Stop request from the web-chat page';

// A stop request (spec §6.5, §6.9): the task id and nothing else. The task's
// title is model-written, so neither it nor any text, skill or file the item
// carries is ever read here.
function stopRequestBlock(item) {
  const marker = markerOf(item);
  const taskId = item && item.task_id;
  if (!marker || typeof taskId !== 'string' || !STOP_TASK_ID_RE.test(taskId)) return null;
  return `${STOP_REQUEST_HEADER} ${marker}: stop background task ${taskId} with the TaskStop tool. This block carries no other instruction.`;
}

// A composer message (spec §6.5): the header with its marker, every line of the
// text quoted (`> `, an empty line a lone `>`), then the Skill line and one File
// line per attachment. An item from a task stop renders as a stop request,
// never as a message, whatever text it carries.
function messageBlock(item) {
  if (item && item.source === 'task-stop') return stopRequestBlock(item);
  const marker = markerOf(item);
  if (!marker) return null;
  const lines = [`${MESSAGE_HEADER} ${marker}:`];
  const text = sanitizeMessage(item.text);
  if (text !== '') for (const line of text.split('\n')) lines.push(line === '' ? '>' : `> ${line}`);
  const skill = skillLine(item.skill);
  if (skill) lines.push(skill);
  for (const f of Array.isArray(item.files) ? item.files : []) {
    const l = fileLine(f);
    if (l) lines.push(l);
  }
  return lines.join('\n');
}

const isMessage = (it) => it.kind === 'message';

// ── the envelope ────────────────────────────────────────────────────────────

// Build the `{ content, meta }` a `wake` batch becomes. `batch` is the array of
// queue items (`{ id, kind, source, why_wake, summary, origin_mount, seq,
// capture_id? }`, and for a message `msg_id, text, skill, files, task_id?`).
// Opts carry the wake's own `reason`/`source`/`seq` (from the flush) for meta,
// plus an optional `note` — free-text batch context the user typed in the rail
// (sanitized like a summary; never inlines any body) — and the push's
// provenance `origin`/`device`, which lands as meta `push_origin`/`device` AND as
// one content line, since a parked delivery reaches Claude as the content alone.
//
// Order: the provenance line, the note line, the message blocks in batch order
// (a blank line between blocks, and before the signals), the signal header and
// its `- [kind] summary` lines (messages are not signals and are not counted),
// the respond-to-comment hint last. Budget: the content stays within
// ENVELOPE_MAX by dropping signal lines oldest first behind the "…N earlier
// signals omitted" line, which counts every dropped line. A block is never cut
// or dropped: should the blocks alone pass the budget, every signal line goes
// and the content is allowed over (a cut block would quote half a request).
function wakeEnvelope(batch, { reason, source, seq, note, origin, device } = {}) {
  const items = (Array.isArray(batch) ? batch : []).filter(Boolean);
  const signals = items.filter((it) => !isMessage(it));
  const blocks = items.filter(isMessage).map(messageBlock).filter(Boolean);

  const allLines = signals.map((it) => {
    const kind = sanitizeSummary(it.kind || 'signal', { max: 24 });
    const summary = sanitizeSummary(it.summary || it.why_wake || it.id || '');
    return `- [${kind}] ${summary}`;
  });
  const n = signals.length;
  const header = n === 1
    ? 'A queued signal was pushed to Claude:'
    : `${n} queued signals were pushed to Claude:`;
  const noteText = note ? sanitizeSummary(note, { max: 280 }) : '';
  const noteLine = noteText ? `Context from the user: ${noteText}` : null;
  // A comment in the batch appends the skill-routing hint once (not per line).
  const hintLine = signals.some((it) => (it.kind || '') === 'comment') ? RESPOND_HINT : null;
  const pushOrigin = origin === 'local' || origin === 'remote' ? origin : null;
  const pushDevice = device === 'desktop' || device === 'mobile' ? device : null;
  const provLine = pushOrigin || pushDevice
    ? `Pushed from: ${[pushOrigin && `origin=${pushOrigin}`, pushDevice && `device=${pushDevice}`].filter(Boolean).join(' ')}`
    : null;

  // Keep the most-recent `keep` signal lines and disclose the omitted remainder,
  // which Claude fetches via the ids meta (see SUMMARY_LINES_MAX).
  const render = (keep) => {
    const omitted = allLines.length - keep;
    const lines = omitted > 0
      ? [`- …${omitted} earlier signal${omitted === 1 ? '' : 's'} omitted (fetch by tool call)`, ...allLines.slice(allLines.length - keep)]
      : allLines;
    const signalPart = n
      ? [header, ...lines].join('\n')
      : (blocks.length ? null : 'A wake was pushed to Claude (no signals).');
    const body = [blocks.length ? blocks.join('\n\n') : null, signalPart].filter(Boolean).join('\n\n');
    return [provLine, noteLine, body, hintLine].filter(Boolean).join('\n');
  };
  let keep = Math.min(allLines.length, SUMMARY_LINES_MAX);
  let content = render(keep);
  while (content.length > ENVELOPE_MAX && keep > 0) {
    keep -= 1;
    content = render(keep);
  }

  const kinds = [...new Set(items.map((it) => it.kind || 'signal'))];
  const ids = items.map((it) => it.id).filter(Boolean);
  const captureIds = items.map((it) => it.capture_id).filter(Boolean);
  // A single item's source/mount are specific enough to surface; a mixed batch
  // reports the wake-level `source` (e.g. 'queue') and no single mount.
  const count = items.length;
  const meta = sanitizeMeta({
    kind: kinds.length === 1 ? kinds[0] : 'batch',
    count: String(count),
    seq: seq != null
      ? String(seq)
      : (count ? String(Math.max(...items.map((it) => Number(it.seq) || 0))) : undefined),
    origin: source || (count === 1 ? items[0].source : undefined),
    mount: count === 1 ? items[0].origin_mount : undefined,
    ids: ids.join(','),
    captures: captureIds.join(','),
    push_origin: pushOrigin,
    device: pushDevice,
  });

  return { content, meta };
}

module.exports = {
  wakeEnvelope,
  sanitizeSummary,
  sanitizeMeta,
  sanitizeMetaKey,
  sanitizeMetaValue,
  sanitizeMessage,
  messageBlock,
  stopRequestBlock,
  formatSize,
  META_KEYS,
  RESPOND_HINT,
  ENVELOPE_MAX,
  HARNESS_TAGS,
  STOP_TASK_ID_RE,
  MESSAGE_HEADER,
  STOP_REQUEST_HEADER,
};
