// lib/server/mirror/records.js — the record table: what each Claude Code
// transcript record IS, and which of the mirror's readers consumes it.
//
// A transcript is an internal format, not an API (validation V15): 82 record
// kinds over 2.1.226–2.1.284, several undocumented, re-shaped between point
// releases. So the mirror reads it through ONE allowlist. A kind with a row is
// read by the modules the row names; a kind with no row is unknown, counted by
// the caller in `diagnostics.unknown_kinds` and dropped. Nothing here throws on
// a record, whatever its shape.
//
//   kindOf(rec)        '<type>', 'system/<subtype>', 'attachment/<type>' or
//                      'user/<class>' — the validation's record inventory
//                      (design/chat-mirror-validation/record-inventory.js
//                      kindOf), ported exactly, plus '<no-type>' for a value
//                      that is not a record at all (the prototype would throw).
//   userClass(rec)     the user record's class, from the content's shape:
//                      prompt, prompt+image, tool_result, task-notification,
//                      channel, slash-command, bash-mode, local-command-output,
//                      local-command-caveat, hook-context, interrupt-marker,
//                      system-reminder, compact-summary, meta, no-content. The
//                      leading-tag test is lib/core/prompt-class `promptLead`,
//                      the one tag list (a prompt opening '<channels…' is
//                      'channel': promptLead keeps the prototype's
//                      `startsWith('<channel')` on purpose, U07a).
//   classifyPrompt     re-exported from lib/core/prompt-class (the hooks read
//                      the same answer there; lib/hooks may not import us).
//   versionOf(rec, last)  the record's Claude Code version; a record without
//                      one (the uuid-less metadata records) inherits the last
//                      version seen earlier in the same file (V15), else null.
//   TABLE              frozen: kind → row. A row is DATA naming its consumers:
//                        turn:    a ROUTES entry the normalizer (normalize.js,
//                                 U26) turns into turn-machine changes, or null
//                        meta:    true → the meta fold (meta.js, U27) reads it
//                        carrier: true → the carriers fold (carriers.js, U27)
//                        known:   'account-email' | 'org-id' — a value the
//                                 redactor must learn (§5.5 Known values); the
//                                 meta fold returns it and never keeps it
//                        drop:    a DROP_REASONS entry — the kind becomes no
//                                 item and no meta. A drop row may still carry
//                                 `known` (the NEVER_EMIT kinds whose value the
//                                 redactor needs), and every chain record,
//                                 dropped or not, is still forwarded by the
//                                 normalizer as a `record` change, so the
//                                 chain's leaf and the rewinds source's
//                                 first-turn evidence see it.
//                      Every row has at least one consumer or a drop reason.
//   rowOf(kind)        the row, or null for an unknown kind.
//   consumersOf(kind)  the subset of ['normalize', 'meta', 'carriers'], in that
//                      order, the row names (`known` counts as meta: the meta
//                      fold returns known values); [] for a plain drop or an
//                      unknown kind.
//   ROUTES             frozen list of the normalizer's turn routes.
//   DROP_REASONS       frozen list of the reasons a row may give.
//   TABLE_VERSION      1. Bump it when a row changes what a kind becomes, so a
//                      persisted index built under the old table is rebuilt.
//   TESTED             {min, max}: the Claude Code versions this table was
//                      checked against. Outside it the mirror still reads
//                      (unknown kinds drop); the range is for diagnostics.
//
// The table covers all 82 transcript kinds of the validation's drift summary
// (its 86 minus the four journal.jsonl kinds launched, started, result and
// failed, which never appear in a transcript), plus system/api_error, which the
// mirror allowlists though the corpus never held one, and the two user classes
// the prototype names that the corpus did not hold (hook-context, no-content).
// test/mirror-records.test.js checks it against test/fixtures/mirror/
// record-kinds.json, generated from that summary (spec §2.4).
//
// Duplicate copies are dropped, not redacted (V16): the readers never take
// wireToolInputs, toolUseResult.stdout/stderr/originalFile/file.content,
// attachment.rendered or queue-operation.content (other than for a queued
// message) — lib/core/redact NEVER_EMIT is that list, and its four kinds are
// drop rows here.
//
// Pure: no I/O, no clock. Dependency direction: lib/core only.

const { promptLead, classifyPrompt } = require('../../core/prompt-class');

const TABLE_VERSION = 1;
const TESTED = Object.freeze({ min: '2.1.226', max: '2.1.287' });

const ROUTES = Object.freeze([
  'assistant',            // text / thinking / tool_use blocks, an API error notice
  'tool-result',          // a tool call's result, status, edit and links
  'opener',               // a turn's opening record (prompt, notification, channel, command, shell)
  'local-output',         // a built-in command's output
  'interrupt',            // the interrupt marker
  'compact-summary',      // the compaction summary
  'turn-duration',        // turn close and its duration (and messageCount)
  'compact',              // the compaction boundary
  'away',                 // the while-you-were-away recap
  'local-command',        // a built-in command ran (clear → a session notice)
  'notice',               // a harness notice, an API error, a file or skill notice
  'mode-notice',          // a model or mode change
  'prompt-attachment',    // a file, directory or PDF attached to the prompt
  'artifact',             // a published artifact
  'permission-decision',  // a hook answered a permission (resolves `awaiting`)
  'rewind-anchor',        // last-prompt: the rewind evidence (§15.4 case c)
]);

const DROP_REASONS = Object.freeze([
  'never-emit',        // lib/core/redact NEVER_EMIT.kinds: may hold account data or the whole prompt context
  'code-history',      // file-history-*: per-turn code changes come from the tree (§2.7)
  'harness-reminder',  // text the harness injects for the model, not for the user
  'harness-context',   // the harness's own context bookkeeping (tools, MCP, memory, environment)
  'hook-output',       // a hook's own output record
  'remote-bridge',     // remote-control bridge bookkeeping
  'internal-state',    // Claude Code's private state records
  'session-link',      // links between session files (the conversations index reads sessions, §2.2)
  'harness-caveat',    // the local-command caveat
  'meta-text',         // isMeta user text with no class of its own
  'no-content',        // a user record with no content
]);

const NORMALIZE = (turn, extra) => Object.freeze({ turn, ...extra });
const META = (extra) => Object.freeze({ turn: null, meta: true, ...extra });
const CARRIER = Object.freeze({ turn: null, carrier: true });
const DROP = (reason, extra) => Object.freeze({ turn: null, drop: reason, ...extra });

const TABLE = Object.freeze({
  // ── the conversation ──────────────────────────────────────────────────────
  assistant: NORMALIZE('assistant', { meta: true }),        // meta: model, effort, usage
  'user/tool_result': NORMALIZE('tool-result'),
  'user/prompt': NORMALIZE('opener'),
  'user/prompt+image': NORMALIZE('opener'),
  'user/task-notification': NORMALIZE('opener', { carrier: true }),
  'user/channel': NORMALIZE('opener', { carrier: true }),
  'user/slash-command': NORMALIZE('opener'),
  'user/bash-mode': NORMALIZE('opener'),
  'user/local-command-output': NORMALIZE('local-output'),
  'user/interrupt-marker': NORMALIZE('interrupt'),
  'user/compact-summary': NORMALIZE('compact-summary'),
  'user/local-command-caveat': DROP('harness-caveat'),
  'user/meta': DROP('meta-text'),
  'user/system-reminder': DROP('harness-reminder'),
  'user/hook-context': DROP('hook-output'),
  'user/no-content': DROP('no-content'),

  // ── system records ────────────────────────────────────────────────────────
  'system/turn_duration': NORMALIZE('turn-duration'),
  'system/compact_boundary': NORMALIZE('compact'),
  'system/away_summary': NORMALIZE('away', { meta: true }),
  'system/local_command': NORMALIZE('local-command'),
  'system/informational': NORMALIZE('notice'),
  'system/api_error': NORMALIZE('notice'),
  'system/stop_hook_summary': DROP('hook-output'),
  'system/bridge_status': DROP('remote-bridge'),

  // ── carriers (task notifications, queued messages, delivery markers) ──────
  'queue-operation': CARRIER,
  'attachment/queued_command': CARRIER,
  'attachment/hook_additional_context': CARRIER,
  'attachment/hook_permission_decision': NORMALIZE('permission-decision'),

  // ── the rewind anchor ─────────────────────────────────────────────────────
  'last-prompt': NORMALIZE('rewind-anchor'),

  // ── meta: title, model, modes, cost, skills ──────────────────────────────
  'ai-title': META(),
  'agent-name': META(),
  mode: META(),
  'permission-mode': META(),
  'cost-state': META(),
  'attachment/skill_listing': META(),
  'attachment/model': META({ turn: 'mode-notice' }),
  'attachment/plan_mode': META({ turn: 'mode-notice' }),
  'attachment/plan_mode_exit': META({ turn: 'mode-notice' }),
  'attachment/plan_mode_reentry': META({ turn: 'mode-notice' }),
  'attachment/auto_mode': META({ turn: 'mode-notice' }),
  'attachment/auto_mode_exit': META({ turn: 'mode-notice' }),
  'attachment/ultra_effort_enter': META({ turn: 'mode-notice' }),
  'attachment/ultra_effort_exit': META({ turn: 'mode-notice' }),

  // ── known values (NEVER_EMIT: learned by the redactor, never shown) ──────
  'attachment/credential_org': DROP('never-emit', { known: 'org-id' }),
  'attachment/session_context': DROP('never-emit', { known: 'account-email' }),
  'attachment/prompt_snapshot': DROP('never-emit'),
  'attachment/instructions': DROP('never-emit'),

  // ── notices, prompt attachments, artifacts (names and paths only) ────────
  'attachment/edited_text_file': NORMALIZE('notice'),
  'attachment/invoked_skills': NORMALIZE('notice'),
  'attachment/compact_file_reference': NORMALIZE('notice'),
  'attachment/file': NORMALIZE('prompt-attachment'),
  'attachment/directory': NORMALIZE('prompt-attachment'),
  'attachment/pdf_reference': NORMALIZE('prompt-attachment'),
  'frame-link': NORMALIZE('artifact'),

  // ── dropped ───────────────────────────────────────────────────────────────
  'file-history-snapshot': DROP('code-history'),
  'file-history-delta': DROP('code-history'),
  'attachment/total_tokens_reminder': DROP('harness-reminder'),
  'attachment/bash_output_audience_note': DROP('harness-reminder'),
  'attachment/batching_reminder_sent': DROP('harness-reminder'),
  'attachment/task_reminder': DROP('harness-reminder'),
  'attachment/silent_turn_reminder': DROP('harness-reminder'),
  'attachment/read_truncation_notice': DROP('harness-reminder'),
  'attachment/date': DROP('harness-reminder'),
  'attachment/date_change': DROP('harness-reminder'),
  'attachment/thinking_drop': DROP('harness-reminder'),
  'attachment/thinking_stripped': DROP('harness-reminder'),
  'attachment/deferred_tools_record': DROP('harness-context'),
  'attachment/deferred_tools_delta': DROP('harness-context'),
  'attachment/mcp_instructions_delta': DROP('harness-context'),
  'attachment/agent_listing_delta': DROP('harness-context'),
  'attachment/environment': DROP('harness-context'),
  'attachment/remote_session_change': DROP('harness-context'),
  'attachment/command_permissions': DROP('harness-context'),
  'attachment/nested_memory': DROP('harness-context'),
  'attachment/plan_file_reference': DROP('harness-context'),
  'attachment/structured_output': DROP('harness-context'),
  'attachment/hook_success': DROP('hook-output'),
  'attachment/hook_system_message': DROP('hook-output'),
  'bridge-session': DROP('remote-bridge'),
  'atis-latch': DROP('internal-state'),
  'artifact-autoreact-ledger': DROP('internal-state'),
  'artifact-comment-monitor': DROP('internal-state'),
  'history-suppression': DROP('internal-state'),
  'continued-in': DROP('session-link'),
  'fork-context-ref': DROP('session-link'),
});

function rowOf(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(TABLE, kind)) return null;
  return TABLE[kind];
}

function consumersOf(kind) {
  const row = rowOf(kind);
  if (!row) return [];
  const out = [];
  if (row.turn) out.push('normalize');
  if (row.meta || row.known) out.push('meta');
  if (row.carrier) out.push('carriers');
  return out;
}

// ── kinds (record-inventory.js:46-79, ported) ──────────────────────────────

// The prototype ran its lead test on String(s); a JSON value's String() never
// throws, but a caller's object might, so a failure reads as no tag.
function leadOf(s) {
  let text;
  try { text = typeof s === 'string' ? s : String(s); } catch { return null; }
  return promptLead(text);
}

function userClass(rec) {
  if (!rec || typeof rec !== 'object') return 'no-content';
  const msg = (rec.message && typeof rec.message === 'object') ? rec.message : {};
  const c = msg.content;
  if (rec.isCompactSummary) return 'compact-summary';
  if (typeof c === 'string') return leadOf(c) || (rec.isMeta ? 'meta' : 'prompt');
  if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === 'tool_result')) return 'tool_result';
    const firstText = c.find((b) => b && b.type === 'text');
    const l = firstText ? leadOf(firstText.text || '') : null;
    if (l) return l;
    if (rec.isMeta) return 'meta';
    return c.some((b) => b && b.type === 'image') ? 'prompt+image' : 'prompt';
  }
  return 'no-content';
}

function kindOf(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return '<no-type>';
  const t = typeof rec.type === 'string' ? rec.type : '<no-type>';
  if (t === 'system') return `system/${rec.subtype || '<none>'}`;
  if (t === 'attachment') return `attachment/${(rec.attachment && rec.attachment.type) || '<none>'}`;
  if (t === 'user') return `user/${userClass(rec)}`;
  return t;
}

function versionOf(rec, last = null) {
  const v = rec && typeof rec === 'object' ? rec.version : undefined;
  if (typeof v === 'string' && v) return v;
  return typeof last === 'string' && last ? last : null;
}

module.exports = {
  TABLE_VERSION,
  TESTED,
  ROUTES,
  DROP_REASONS,
  TABLE,
  rowOf,
  consumersOf,
  kindOf,
  userClass,
  versionOf,
  classifyPrompt,
};
