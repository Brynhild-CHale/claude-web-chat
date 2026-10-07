// lib/core/prompt-class.js — what a turn's opening text is, and the composer's
// delivery marker.
//
// A Claude Code turn does not always open with something the user typed. The
// harness writes its own text into the prompt position, each kind behind a
// leading tag: a background task's completion (`<task-notification>`), a
// channel wake (`<channel …>`), a slash command (`<command-name>`), bash mode
// (`<bash-input>`), a local command's output, an interrupt marker, a system
// reminder. The UserPromptSubmit hook receives that text as `prompt`, and the
// transcript keeps it as a user record's string content, so the turn-begin hook
// (which authors a task notification as `task`, not as the user), the mirror's
// turn machine and its record table all ask the same question of the same
// text. lib/hooks may not import lib/server, so the one answer lives in core.
//
//   promptLead(text)      the record class the leading tag marks, or null. The
//                         table is the validation's record inventory
//                         (design/chat-mirror-validation/record-inventory.js
//                         `lead`), which classified every transcript on the
//                         machine; the record table builds `user/<class>` on it
//                         rather than keeping a second list of tags.
//   classifyPrompt(text)  one of PROMPT_CLASSES: `human` for text with no
//                         harness tag in front (an empty prompt, such as an
//                         image sent alone, included), `task-notification`,
//                         `channel`, `command`, `shell`, and `other` for every
//                         other harness text and for anything not a string.
//
// The tags are matched after leading whitespace, at the start only: a prompt
// that mentions `<task-notification>` later on is still the user's. A user who
// types a harness tag at the very start is classified by it; nothing here is a
// security boundary, and the transcript's own `origin` field is the record
// table's to weigh.
//
// The composer's marker. A message sent from the web-chat composer reaches
// Claude as a quoted block headed `Message from the user [web-chat message
// m-3fa9c2d1]`; finding that marker again in the transcript is how its delivery
// is confirmed. lib/channel/envelope.js writes it (messageMarker) and the
// mirror's carriers scan for it (messageMarkers), so the format has one home.
// MESSAGE_MARKER_RE is global and therefore stateful under .test()/.exec():
// scan with messageMarkers, which never touches its lastIndex.
//
// The parked delivery's frame. A Push made while no channel was live is parked
// and reaches Claude as the turn-begin hook's additional context, behind
// PARKED_PREFIX (lib/hooks/turn-begin.js writes it). The mirror's carriers
// (lib/server/mirror/carriers.js) count a marker in a hook's context as a
// parked delivery only when that context carries PARKED_HEAD, so a marker
// another hook happens to echo confirms nothing. lib/server may not import
// lib/hooks, so both live here (ruling U27@parked-prefix (a), moved by U63).
//
// Dependency direction: core; this file imports nothing.

const PROMPT_CLASSES = Object.freeze(['human', 'task-notification', 'channel', 'command', 'shell', 'other']);

// Leading tag → record class, in record-inventory's order. `<channel` has no
// closing bracket because a real wake carries attributes
// (`<channel source="web-chat" kind="batch" …>`).
const LEADS = Object.freeze([
  ['<task-notification>', 'task-notification'],
  ['<command-name>', 'slash-command'],
  ['<command-message>', 'slash-command'],
  ['<local-command-stdout>', 'local-command-output'],
  ['<local-command-stderr>', 'local-command-output'],
  ['<local-command-caveat>', 'local-command-caveat'],
  ['<bash-input>', 'bash-mode'],
  ['<bash-stdout>', 'bash-mode'],
  ['<bash-stderr>', 'bash-mode'],
  ['<channel', 'channel'],
  ['<user-prompt-submit-hook>', 'hook-context'],
  ['[Request interrupted', 'interrupt-marker'],
  ['<system-reminder>', 'system-reminder'],
]);

// The record classes that open a turn of their own kind; every other harness
// text (local command output, a caveat, hook context, an interrupt marker, a
// system reminder) is `other`.
const CLASS_OF_LEAD = Object.freeze({
  'task-notification': 'task-notification',
  channel: 'channel',
  'slash-command': 'command',
  'bash-mode': 'shell',
});

function promptLead(text) {
  if (typeof text !== 'string') return null;
  // The first non-whitespace character: what trimStart() would keep, without
  // copying a long prompt to find it. (\s is exactly trim's set.)
  const at = text.search(/\S/);
  if (at < 0) return null;
  for (const [tag, cls] of LEADS) if (text.startsWith(tag, at)) return cls;
  return null;
}

function classifyPrompt(text) {
  if (typeof text !== 'string') return 'other';
  const lead = promptLead(text);
  if (lead === null) return 'human';
  return CLASS_OF_LEAD[lead] || 'other';
}

// ── the composer's marker ───────────────────────────────────────────────────

const PARKED_HEAD = '[web-chat] Parked delivery';
// "With this turn", not "with this message": the turn may be a background
// task's, not a typed prompt (spec §3.1 step 5).
const PARKED_PREFIX = `${PARKED_HEAD} — while the Channels wake path was not connected, the user pushed the following from the web-chat surface. It is delivered now, with this turn. Fetch any bodies by tool call (get_captures / get_store) as usual.\n\n`;

const MESSAGE_MARKER_RE = /\[web-chat message (m-[0-9a-f]{8})\]/g;
const MESSAGE_ID_RE = /^m-[0-9a-f]{8}$/;

// The marker for one message id ('m-' and 8 lowercase hex). An id the scanner
// could never find again is a programming error, so it throws.
function messageMarker(id) {
  if (typeof id !== 'string' || !MESSAGE_ID_RE.test(id)) {
    throw new TypeError(`messageMarker: not a message id: ${JSON.stringify(id)}`);
  }
  return `[web-chat message ${id}]`;
}

// Every message id marked in `text`, once each, in the order first seen.
function messageMarkers(text) {
  if (typeof text !== 'string') return [];
  const ids = new Set();
  for (const m of text.matchAll(new RegExp(MESSAGE_MARKER_RE.source, 'g'))) ids.add(m[1]);
  return [...ids];
}

module.exports = {
  PROMPT_CLASSES,
  promptLead,
  classifyPrompt,
  MESSAGE_MARKER_RE,
  messageMarker,
  messageMarkers,
  PARKED_HEAD,
  PARKED_PREFIX,
};
