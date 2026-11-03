// lib/server/mirror/retention.js — what the chat mirror keeps, and for how long
// (annotation engine PLAN.md 1D.2; readiness R4 §3 seam (f), §5 bug 3).
//
// THE ONE TABLE. Every cap, keep time and deletion trigger the chat mirror and
// the asks domain (lib/server/domain/asks.js) prune by is a row here; the file
// that enforces it takes its value from this table and keeps its own named
// export with the same value (codediff LIMITS.PRUNE_EXPIRE, conversations
// GONE_TRIGGER, asks RESOLVED_KEEP_MS, …). No count cap deletes the
// conversation record (DECISIONS.md L.3 N1): a conversation, a session and an
// index turn are deleted only by Claude Code's own cleanup of the transcript
// (`claude-code-cleanup`) and by the disk budget (`disk-budget-bytes`, null —
// no limit — unless a size is set), the two deleters:
//
//   RETENTION   frozen array of frozen rows
//               { id, what, value, unit, where, user_text }
//                 id         the rule's name — what an `unavailable` answer's
//                            `rule` names (codediff turnDiff; a removed diff
//                            answers `unavailable`, never `expired`, since
//                            DECISIONS.md L.4 O6)
//                 what       what the row bounds, for a maintainer
//                 value      the number (or git expiry spelling, or trigger
//                            name) enforced; null for a limit not set
//                 unit       what `value` counts
//                 where      the file that enforces it, relative to
//                            lib/server/mirror ('codediff.js',
//                            '../domain/asks.js')
//                 user_text  one plain sentence a user can read; docs/guide.md
//                            lists every row's user_text verbatim (a test holds
//                            them equal), and an `unavailable` answer carries
//                            its rule's user_text as its note
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

const row = (r) => Object.freeze(r);

const RETENTION = Object.freeze([
  row({
    id: 'claude-code-cleanup',
    what: 'a session whose transcript Claude Code\'s own cleanup deleted: its turn index, and the code diffs no graph node links (the one deleter, conversations.js deleteGone)',
    value: 'transcript-gone',
    unit: 'trigger',
    where: 'conversations.js',
    user_text: 'When Claude Code\'s own cleanup deletes a session\'s transcript, web-chat deletes that session\'s turn index and the code diffs no graph node links.',
  }),
  row({
    id: 'disk-budget-bytes',
    what: 'the mirror\'s own files on disk, .web-chat/mirror/ (null: no limit, the default; a size the host sets in .web-chat/mirror.json with `claude-web-chat mirror budget` replaces it, at least 64 MiB). Over a set size, in order until under: the index files of conversations no live process writes and none has parsed, orphans first, and the node-diff caches; the oldest snapshots (git prune stepped 7 days, 3 days, 1 day, 6 hours, never under 1 hour); diff records oldest first, a node-linked turn\'s last; still over, no more diffs are recorded',
    value: null,
    unit: 'bytes',
    where: 'codediff.js',
    user_text: 'The mirror\'s own files are kept without a size limit unless you set one with claude-web-chat mirror budget, and then the files it can rebuild go first and a diff linked to a graph node goes last.',
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
    id: 'codediff-turns-max',
    what: 'turns whose snapshots the codediff source follows in memory',
    value: 1000,
    unit: 'turns held in memory',
    where: 'codediff.js',
    user_text: 'The server follows the snapshots of at most 1000 turns in memory at once.',
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
  row({
    id: 'parsed-conversations-max',
    what: 'conversations whose turns are parsed and held in memory at once; the others stay listed and are parsed again on first use; nothing is deleted (from results/gate-t3-exit.md, the tranche-3 exit\'s F7 s8 at 503b8f2f: 172,212 B RSS per parsed conversation at two children per k, least squares over k 250–999, r² 0.977, heap 99 KB — 0.413× of U452\'s 416,958 B (PQ-3E-2\'s rule); r1 read 168,579 B (398) beside; floor(PARSED_RAM_BYTES 64 MiB / 172,212 B) = 389, never below 20)',
    value: 389,
    unit: 'conversations held in memory',
    where: 'index.js',
    user_text: 'The server holds the turns of at most 389 conversations in memory at once and parses any other conversation again when you open it.',
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
