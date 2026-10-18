// lib/server/mirror/retention.js — what the chat mirror keeps, and for how long
// (annotation engine PLAN.md 1D.2; readiness R4 §3 seam (f), §5 bug 3).
//
// THE ONE TABLE. Every cap and keep time the chat mirror and the asks domain
// (lib/server/domain/asks.js) prune by is a row here; the file that enforces it
// takes its value from this table and keeps its own named export with the same
// value (codediff LIMITS.RECORD_MAX_DAYS, asks RESOLVED_KEEP_MS, …):
//
//   RETENTION   frozen array of frozen rows
//               { id, what, value, unit, where, user_text }
//                 id         the rule's name — what an `expired` answer's
//                            `rule` names (codediff turnDiff)
//                 what       what the row bounds, for a maintainer
//                 value      the number (or git expiry spelling) enforced
//                 unit       what `value` counts
//                 where      the file that enforces it, relative to
//                            lib/server/mirror ('codediff.js',
//                            '../domain/asks.js')
//                 user_text  one plain sentence a user can read; docs/guide.md
//                            lists every row's user_text verbatim (a test holds
//                            them equal), and an `expired` answer carries its
//                            rule's user_text as its note
//   retention(id) → the row, or null for an unknown id
//   valueOf(id)   → the row's value; throws on an unknown id
//
// A value changed here changes what the mirror keeps: say so in the CHANGELOG
// and keep the user_text's number equal to the value.
//
// Dependency direction: lib/server/mirror; requires nothing (read by its
// mirror siblings and by lib/server/domain/asks.js).

'use strict';

const MINUTE_MS = 60 * 1000;
const GiB = 1024 * 1024 * 1024;

const row = (r) => Object.freeze(r);

const RETENTION = Object.freeze([
  row({
    id: 'record-max-days',
    what: 'a turn\'s code diff record, by its file\'s age',
    value: 30,
    unit: 'days',
    where: 'codediff.js',
    user_text: 'A turn\'s code diff is kept for 30 days.',
  }),
  row({
    id: 'prune-expire',
    what: 'snapshot objects no ref reaches, in the shadow store (git prune --expire)',
    value: '7.days.ago',
    unit: 'git expire',
    where: 'codediff.js',
    user_text: 'The file snapshots behind a diff are kept for 7 days.',
  }),
  row({
    id: 'shadow-max-bytes',
    what: 'the shadow store\'s object directory',
    value: GiB,
    unit: 'bytes',
    where: 'codediff.js',
    user_text: 'The snapshot store is capped at 1 GiB, and no more diffs are recorded once it is full.',
  }),
  row({
    id: 'codediff-turns-max',
    what: 'turns whose snapshots the codediff source follows in memory',
    value: 1000,
    unit: 'turns held in memory',
    where: 'codediff.js',
    user_text: 'The server follows the snapshots of at most 1000 turns in memory at once.',
  }),
  row({
    id: 'conversations-max',
    what: 'conversations the registry keeps; an older one\'s turn index and code diffs are deleted',
    value: 200,
    unit: 'conversations',
    where: 'conversations.js',
    user_text: 'At most 200 conversations are kept, and an older conversation\'s turns and code diffs are deleted with it.',
  }),
  row({
    id: 'sessions-max',
    what: 'sessions per conversation (a /clear adds one); the oldest go first',
    value: 100,
    unit: 'sessions per conversation',
    where: 'conversations.js',
    user_text: 'A conversation keeps its newest 100 sessions.',
  }),
  row({
    id: 'index-turns-max',
    what: 'turns per session index, newest kept',
    value: 5000,
    unit: 'turns per session index',
    where: 'index-store.js',
    user_text: 'A session keeps its newest 5000 turns.',
  }),
  row({
    id: 'tasks-finished-keep',
    what: 'a finished background shell or monitor row',
    value: 30 * MINUTE_MS,
    unit: 'ms',
    where: 'tasks.js',
    user_text: 'A finished background shell or monitor stays listed for 30 minutes.',
  }),
  row({
    id: 'agents-finished-keep',
    what: 'a finished agent row',
    value: 30 * MINUTE_MS,
    unit: 'ms',
    where: 'agents.js',
    user_text: 'A finished agent stays listed for 30 minutes.',
  }),
  row({
    id: 'asks-resolved-keep',
    what: 'a resolved permission, question, plan or MCP form (elicitation) ask, kept so a late second answer is refused',
    value: 10 * MINUTE_MS,
    unit: 'ms',
    where: '../domain/asks.js',
    user_text: 'A permission, question, plan or MCP form prompt stays on record for 10 minutes after it is answered or closed, so a late second answer to it is refused.',
  }),
  row({
    id: 'tasks-persist-rows',
    what: 'background shell and monitor rows kept across a restart, running first, then the most recently finished',
    value: 64,
    unit: 'rows per session',
    where: 'tasks.js',
    user_text: 'Across a server restart, a session keeps at most 64 background shell and monitor rows, running ones first and then the most recently finished.',
  }),
  row({
    id: 'agents-persist-rows',
    what: 'agent rows kept across a restart, running first, then the most recently finished',
    value: 64,
    unit: 'rows per session',
    where: 'agents.js',
    user_text: 'Across a server restart, a session keeps at most 64 agent rows, running ones first and then the most recently finished.',
  }),
  row({
    id: 'workflows-persist-rows',
    what: 'workflow rows kept across a restart, running first, then the most recently finished',
    value: 32,
    unit: 'rows per session',
    where: 'workflows.js',
    user_text: 'Across a server restart, a session keeps at most 32 workflow rows, running ones first and then the most recently finished.',
  }),
]);

const BY_ID = new Map(RETENTION.map((r) => [r.id, r]));

function retention(id) {
  return BY_ID.get(id) || null;
}

function valueOf(id) {
  const r = BY_ID.get(id);
  if (!r) throw new Error(`retention: no row '${String(id)}'`);
  return r.value;
}

module.exports = { RETENTION, retention, valueOf };
