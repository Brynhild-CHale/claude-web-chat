// lib/server/control/revert.js — code revert behind the control layer (spec
// §15.3 "Gates and actions" and "Claude is told", §15.5; design/chat-mirror-
// control.md C-REV-2, and C-REV-3's notice half; rulings B4 (b), B5 (a)).
//
//   installRevert(control, {restore, mirror, graph, root, paths, bus, redactor,
//                           runClaudeAsync, findClaude, now, log})
//     → revert = {preview(q), features(), refresh(), restores(), start(), stop()}
//   and control.provide('revert', revert).
//
// It stands on U79's restore engine (lib/server/control/restore.js, built by
// the wiring over THE SAME shadow store the codediff source snapshots with —
// never a second store, never a git call of its own) and on the diff records
// the mirror keeps per turn (§2.7, through the facade's diff()). It adds the
// gates, the preview_id, the two control rows ('restore', 'undo'), the
// restores record and the notice Claude is owed.
//
// ── features() ─────────────────────────────────────────────────────────────
//   → {ok: true} | {ok: false, reason}, SYNCHRONOUS (the control domain's
//   features() reads it into capabilities.code_revert): the answer of the last
//   refresh(), refreshed in the background once it is older than
//   FEATURES_TTL_MS. Before the first refresh: 'checking'. The reasons, in
//   order: 'diffs-off' — the mirror's diff api is unavailable
//   (WEB_CHAT_MIRROR_DIFFS=0 keeps no per-turn record, so no turn has a tree
//   to go back to: revert is unavailable, not broken; ruling
//   U43@diffs-off-capability); then restore.features()'s 'git-missing' |
//   'not-a-git-repo' | 'init-failed' | 'git-too-old' (no --attr-source, git
//   older than 2.40) | 'shadow-store-full'. A project that is not a git
//   repository is deferred (§13). The background refresh (and start()'s) is
//   PASSIVE: it never makes the shadow store (codediff makes it at the first
//   fresh turn, never at boot), so until .web-chat/mirror/git exists the
//   answer is 'no-snapshots' — no turn has a tree to go back to yet.
//   refresh({passive}) → Promise<that answer>, freshly probed (single-flight
//   per kind); preview() and the actions' check() probe in full.
//   `bus` (the main bus, for the control event) and `redactor` (ctx.redactor;
//   lib/core/redact's redactValue when absent) are beyond the brief's list.
//
// ── preview({turn | node, point = 'before'|'after'}) ────────────────────────
//   THE TARGET (ruling B4 (b), §15.3 as amended):
//     a turn  → its OWN diff record, which must be ready: before {tree, head}
//               (after {tree, head} for point=after). A 'folded' turn with its
//               own ready record takes its own tree, never its node's first
//               turn's. A record pending, unavailable or absent → refused
//               'no-record' ('the turn changed no files, or its record is not
//               ready').
//     a node  → mirror.diff({node}).turns' first READY record's before {tree,
//               head} (point=after: the LAST ready record's after, the
//               node's combined after); none → 'no-record'; an unknown ref →
//               'unknown'.
//   Then restore.preview(tree, {targetHead}) → the lists, and the gates (the
//   very function the actions' check() runs) → `blocked`. The answer:
//     {ok: true, preview_id, target: {turn_id, node_id, label, point,
//      conversation_id, at}, written, deleted, notCovered, headMoved,
//      counts: {rewritten (M, T), recreated (A), deleted, not_covered},
//      blocked: null | {reason, hint}, notes: [string]}
//   A path's status is the one it has as the TARGET sees it: A the file
//   existed then and is re-created, M/T rewritten; `deleted` were created
//   since. Unredacted here: lib/server/routes/code.js redacts the body as the
//   diffs are. Refusals {ok: false, refused, hint} — 'no-record', 'unknown',
//   'tree-missing' (trees are kept 7 days), 'rate_limited', restore's own;
//   {ok: false, unavailable: true, reason} when features() is not ok.
//   THE PREVIEW STORE: 'pv_' + base-36 time + 4 hex → {target, tree, head,
//   current_tree, lists, at}, in memory, PREVIEW_TTL_MS, at most PREVIEW_MAX
//   (the oldest dropped), consumed by a restore that ran.
//   RATE SHAPE (notes-B decision 6): one preview at a time per project; the
//   same target within SAME_TARGET_MS gets the same answer (the same
//   preview_id); another target within it, or while one runs → rate_limited.
//
// ── THE ROWS (U81's action table; layouts ['confirm']; limit project 5 s
//    each, so the toast's Undo is never refused by its own Restore) ─────────
//   'restore'  fields ['preview_id']   params {preview_id} (alias `preview`)
//              key: the preview id. An unknown or expired id is the check's
//              refusal 'stale-preview' (409), not a bad target: the engine
//              answers every params() throw 400 'bad-target', so a throw is
//              kept for a malformed id.
//              describe → {title: 'Restore files', summary: 'Restore N files
//              to before turn <label>: R rewritten · D deleted · C
//              re-created[ · HEAD has moved since then]', lines: the first 12
//              paths with their action, then 'edits made since that turn,
//              yours included, are reverted too'} — from the stored preview
//              only, its paths redacted.
//              run → restore.apply(tree, {expect: current_tree, targetHead})
//   'undo'     fields ['restore_id']   params {restore_id: 'latest' | rs_…}
//              (alias `restore`): 'latest' resolves AT MINT to the newest
//              undoable entry of the restores record (one no later undo has
//              undone), so the nonce and wc-control bind that concrete id
//              (notes-B Q8 (a)); nothing to undo → bad target.
//              describe → 'Undo the restore of N files (before turn <label>,
//              <age> ago)'.
//              run → restore.undo(id, {expect: that entry's after_tree}):
//              files changed since the restore → 'stale', never a silent
//              revert of newer edits (notes-B decision 5).
//   Every ONE NAME: a row's field, the key its params() reads and the param
//   its confirm frame is mounted with are the same name (control-confirm.js's
//   bodyOf posts the document's own query keys).
//
// ── THE GATES, in order (§15.3), one function for check() and `blocked` ────
//   'locked'        the graph's turn lock is held (any lock, as /api/commit)
//   'busy'          a conversation of this project is working, waiting on
//                   you, asking or compacting (ACTIVE_STATES, mirror.snapshot)
//   'nested-busy'   `claude agents --json` (runClaudeAsync, 3 s) lists a
//                   session whose cwd is inside the root with a status other
//                   than 'idle' — the hint names its path RELATIVE to the root
//                   only, never another project's cwd or name (B5 (a))
//   'agents-unknown' that answer does not parse, a listed session's status is
//                   unreadable, or the run fails or passes 3 s
//   `claude` not found skips the third gate with a note (§15.3).
//
// ── AFTER EACH RESTORE OR UNDO THAT RAN ─────────────────────────────────────
//   * ONE control event {kind: 'control', op: 'restore'|'undo', id:
//     restore_id, outcome: 'ok'|'residual'} on the main bus — content-free;
//   * ONE entry in the RESTORES RECORD, projectPaths(root).controlRestores
//     (writeJsonAtomic; read with readJson, a corrupt or invalid file renamed
//     aside and started empty): {v: 1, restores: [{restore_id, kind, undo_of?,
//     at, target, target_tree, safety_tree, after_tree, written, deleted,
//     notCovered, residual, headMoved, conversation_id, session_ids, notice:
//     'pending'|'claimed'|'replaced'|'none'}]}, newest first, the last
//     RECORD_KEEP (= SAFETY_KEEP: the safety refs and the record keep the same
//     restores) — ids, trees and the (redacted) lists, never contents;
//   * the audit line is invoke()'s (U81);
//   * THE NOTICE (§15.3 'Claude is told', C47): control.notices.put for the
//     target's conversation only (notes-B Q14 (a)) — '**Files restored from
//     the web-chat page** to before turn <label> (<time>).' with the paths
//     rewritten, deleted and re-created (each list at most NOTICE_LIST_MAX,
//     then 'and N more', the whole within U81's NOTICE_MAX) and 'Read a file
//     again before you edit it.' — never contents. U81 keeps one pending
//     notice per conversation, so an undo REPLACES a pending restore's.
//     Nothing is put when nothing was restored. notices.onChange keeps the
//     record's notice state; start() re-puts every pending notice.
//   The frame's answer: {ok, restore_id, counts, headMoved, residual: [{path,
//   reason}] (redacted), notes}; a residual is ok: false, refused 'residual',
//   and the frame offers the Undo.
//
// NOT here: a snapshot of its own or any git call (restore.js and codediff's
// store own those, through lib/server/git-run); checkout, reset, stash or
// commit; any chrome (U86); the notices claim (U81 serves it, U63 calls it);
// any ctx key or wiring (U66a); an acting route on the main origin (C46).
//
// Dependency direction: lib/server; imports lib/core, ../domain and siblings.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { projectPaths, isInside, realpath, redactHostPaths } = require('../../core/paths');
const { writeJsonAtomic, readJson, renameAside } = require('../../core/fsjson');
const { redactValue } = require('../../core/redact');
const { runClaudeAsync: defaultRunClaudeAsync, findClaude: defaultFindClaude } = require('../../core/claude-cli');
const { resolveNodeRef } = require('../domain/refs');
const { lockHeld } = require('../domain/turns');
const { ACTIVE_STATES } = require('../mirror/live');
const { SAFETY_KEEP } = require('./restore');
const { BadTarget, NOTICE_MAX } = require('./index');

const LIMIT_MS = 5000;
const PREVIEW_TTL_MS = 10 * 60_000;
const PREVIEW_MAX = 32;
const SAME_TARGET_MS = 1000;
const AGENTS_TIMEOUT_MS = 3000;
const FEATURES_TTL_MS = 30_000;
const RECORD_KEEP = SAFETY_KEEP;
const NOTICE_LIST_MAX = 40;
// The notice's header. The rules files quote it (§6.8), and
// test/rules-text-truth.test.js holds the two together.
const NOTICE_HEADER = 'Files restored from the web-chat page';
const DESCRIBE_LINES = 12;
// The id the features probe asks the diff api about: no record has it.
const PROBE_TURN = 'wc-revert-probe';

const TREE_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const PREVIEW_ID_RE = /^pv_[0-9a-z]{1,12}[0-9a-f]{4}$/;
const RESTORE_ID_RE = /^rs_[0-9a-z]{1,12}[0-9a-f]{4}$/;
const POINTS = Object.freeze(['before', 'after']);

// What each state is called in the 'busy' hint.
const STATE_WORDS = Object.freeze({
  working: 'working', waiting: 'waiting on you', question: 'asking you a question', compacting: 'compacting',
});

const HINTS = Object.freeze({
  'no-record': 'the turn changed no files, or its record is not ready',
  unknown: 'no such turn or node',
  'tree-missing': 'the snapshot was pruned (trees are kept 7 days)',
  rate_limited: 'a preview is already being made — wait a moment and try again',
  'stale-preview': 'this preview has expired: open Restore files again',
  'unknown-restore': 'that restore is no longer kept (the last 20 are), or it was already undone',
  stale: 'files changed since: open Restore files again to see what it would do now',
  residual: 'some files could not be restored: Undo puts everything back',
  locked: 'a turn is in progress (the graph is locked): wait for it to end, or run `claude-web-chat unlock` if it is stale',
  'agents-unknown': 'could not read `claude agents --json`: retry, or stop the session in the terminal',
  failed: 'the restore failed before it changed anything',
  'snapshot-failed': 'the working tree could not be snapshot',
  'safety-failed': 'the safety snapshot could not be kept, so nothing was changed',
  'diffs-off': 'per-turn code diffs are off (WEB_CHAT_MIRROR_DIFFS=0), so no turn has files to go back to',
  'not-a-git-repo': 'restoring files needs the project to be a git repository',
  'git-missing': 'git was not found',
  'git-too-old': 'restoring files needs git 2.40 or newer',
  'shadow-store-full': 'the snapshot store is full',
  'init-failed': 'the snapshot store could not be set up',
  'no-snapshots': 'no turn has been snapshot in this project yet',
});

// restore's refusals that mean revert cannot serve at all (503 on the route).
const UNAVAILABLE = new Set(['diffs-off', 'not-a-git-repo', 'git-missing', 'git-too-old', 'shadow-store-full', 'init-failed']);

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hintOf = (code) => HINTS[code] || 'refused';

// A time as a label: the daemon's local 'YYYY-MM-DD HH:MM'.
function timeLabel(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// '3 s', '4 min', '2 h', '5 d'.
function ageLabel(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

function countsOf({ written = [], deleted = [], notCovered = [] } = {}) {
  let rewritten = 0;
  let recreated = 0;
  for (const w of written) { if (w.status === 'A') recreated += 1; else rewritten += 1; }
  return { rewritten, recreated, deleted: deleted.length, not_covered: notCovered.length };
}

// ── `claude agents --json`, read defensively (ruling B5 (a)) ─────────────────
// An array, or {agents|sessions: [...]}; each entry's `cwd` and `status`.
// → {ok: true, sessions: [{cwd, status}]} | {ok: false}
function parseAgents(stdout) {
  let v;
  try { v = JSON.parse(String(stdout || '').trim()); } catch { return { ok: false }; }
  let list = null;
  if (Array.isArray(v)) list = v;
  else if (isPlain(v) && Array.isArray(v.agents)) list = v.agents;
  else if (isPlain(v) && Array.isArray(v.sessions)) list = v.sessions;
  if (!list) return { ok: false };
  const sessions = [];
  for (const e of list) {
    if (!isPlain(e)) continue;
    sessions.push({ cwd: typeof e.cwd === 'string' && e.cwd ? e.cwd : null, status: typeof e.status === 'string' ? e.status : null });
  }
  return { ok: true, sessions };
}

// One list of paths for the notice: at most `cap`, then 'and N more'.
function listLine(label, paths, cap) {
  if (!paths.length) return null;
  const shown = paths.slice(0, cap);
  const more = paths.length - shown.length;
  return `${label}: ${shown.join(', ')}${more > 0 ? `${shown.length ? ', ' : ''}and ${more} more` : ''}`;
}

// The notice's text, its lists shortened until the whole fits NOTICE_MAX.
function noticeText({ head, rewritten, deleted, recreated }) {
  const tail = 'Read a file again before you edit it.';
  let cap = NOTICE_LIST_MAX;
  for (;;) {
    const lines = [head,
      listLine('Rewritten', rewritten, cap), listLine('Deleted', deleted, cap), listLine('Re-created', recreated, cap),
      tail].filter(Boolean);
    const text = lines.join('\n');
    if (text.length <= NOTICE_MAX || cap === 0) return text;
    cap = Math.max(0, cap - Math.max(1, Math.ceil(cap / 8)));
  }
}

function installRevert(control, {
  restore,
  mirror = null,
  graph = null,
  root,
  paths = null,
  bus = null,
  redactor = null,
  runClaudeAsync = defaultRunClaudeAsync,
  findClaude = defaultFindClaude,
  now = Date.now,
  log = () => {},
} = {}) {
  if (!control || typeof control.action !== 'function' || typeof control.provide !== 'function') {
    throw new TypeError('installRevert needs the control domain');
  }
  if (typeof root !== 'string' || !root) throw new TypeError('installRevert needs root');
  if (!restore || typeof restore.preview !== 'function' || typeof restore.apply !== 'function') {
    throw new TypeError('installRevert needs the restore engine (lib/server/control/restore createRestore)');
  }
  const p = paths || projectPaths(root);
  const say = (m) => { try { log(m); } catch { /* a logger never breaks a restore */ } };
  // Redacted as the diffs are (§5.5): secrets masked, then the root and home.
  const redact = (v) => redactHostPaths(redactor && typeof redactor.value === 'function' ? redactor.value(v) : redactValue(v), { root });

  let stopped = false;
  let lastT = 0;

  // ── features ──────────────────────────────────────────────────────────────
  let feats = null; // {at, value}
  let lastFull = null; // the last full probe's answer

  function diffApiMissing() {
    return !mirror || typeof mirror.diff !== 'function';
  }

  // A PASSIVE probe (features(), start()) never makes the shadow store: the
  // codediff source makes it at the first fresh turn, never at boot, so a
  // daemon whose turns never open spawns no git (codediff.js's LAZY rule).
  // Until the store is on disk the answer is 'no-snapshots' — no turn has a
  // tree to go back to yet. An explicit preview or action probes in full.
  async function probe({ passive }) {
    if (diffApiMissing()) return { ok: false, reason: 'diffs-off' };
    let d = null;
    try { d = await mirror.diff({ turn: PROBE_TURN }); } catch { d = null; }
    if (isPlain(d) && d.unavailable === true) return { ok: false, reason: 'diffs-off' };
    if (passive && !fs.existsSync(path.join(p.mirrorGit, 'objects'))) {
      // A full probe's own answer stands (not-a-git-repo makes no store either).
      return lastFull && !lastFull.ok ? { ...lastFull } : { ok: false, reason: 'no-snapshots' };
    }
    let f = null;
    try { f = await restore.features(); } catch { f = null; }
    const out = isPlain(f) && f.ok === true ? { ok: true }
      : { ok: false, reason: isPlain(f) && typeof f.reason === 'string' ? f.reason : 'unavailable' };
    if (!passive) lastFull = out;
    return out;
  }

  // refresh({passive}) → Promise<features' answer>, single-flight per kind.
  const probing = { passive: null, full: null };
  function refresh({ passive = false } = {}) {
    const k = passive ? 'passive' : 'full';
    if (!probing[k]) {
      probing[k] = probe({ passive }).then((value) => {
        feats = { at: now(), value };
        return value;
      }, () => {
        feats = { at: now(), value: { ok: false, reason: 'unavailable' } };
        return feats.value;
      }).finally(() => { probing[k] = null; });
    }
    return probing[k];
  }

  function features() {
    if (stopped) return { ok: false, reason: 'stopped' };
    if (diffApiMissing()) return { ok: false, reason: 'diffs-off' };
    if (!feats || now() - feats.at > FEATURES_TTL_MS) refresh({ passive: true }).catch(() => {});
    if (!feats) return { ok: false, reason: 'checking' };
    return { ...feats.value };
  }

  // ── the restores record ───────────────────────────────────────────────────
  let record = null; // [entry], newest first

  function loadRecord() {
    if (record) return record;
    const r = readJson(p.controlRestores, { validate: (v) => isPlain(v) && v.v === 1 && Array.isArray(v.restores) });
    if (r.ok) {
      record = r.value.restores.filter((e) => isPlain(e) && typeof e.restore_id === 'string' && RESTORE_ID_RE.test(e.restore_id)).slice(0, RECORD_KEEP);
    } else {
      if (r.corrupt || r.invalid) {
        try { renameAside(p.controlRestores, { keep: 3, now }); } catch (e) { say(`revert: could not move the restores record aside (${e && e.code || 'error'})`); }
        say('revert: the restores record could not be read; starting it empty');
      }
      record = [];
    }
    return record;
  }

  function saveRecord() {
    try {
      writeJsonAtomic(p.controlRestores, { v: 1, restores: loadRecord().slice(0, RECORD_KEEP) });
    } catch (e) { say(`revert: the restores record could not be written (${e && e.code || 'error'})`); }
  }

  function addEntry(entry) {
    const list = loadRecord();
    list.unshift(entry);
    if (list.length > RECORD_KEEP) list.length = RECORD_KEEP;
    saveRecord();
  }

  const entryOf = (id) => loadRecord().find((e) => e.restore_id === id) || null;
  const undone = (id) => loadRecord().some((e) => e.kind === 'undo' && e.undo_of === id);

  // The newest entry no later undo has undone (an undo is itself undoable).
  function newestUndoable() {
    for (const e of loadRecord()) if (!undone(e.restore_id) && TREE_RE.test(String(e.after_tree))) return e.restore_id;
    return null;
  }

  function restores() {
    return loadRecord().map((e) => structuredClone(e));
  }

  // ── ids ───────────────────────────────────────────────────────────────────
  function newId(prefix) {
    let t = Math.max(0, Math.floor(now()));
    if (t <= lastT) t = lastT + 1;
    lastT = t;
    return `${prefix}${t.toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  }

  // ── the conversation and its sessions ─────────────────────────────────────
  function conversations() {
    if (!mirror || typeof mirror.snapshot !== 'function') return [];
    let snap = null;
    try { snap = mirror.snapshot({ level: 'local' }); } catch (e) { say(`revert: snapshot failed (${e && e.code || 'error'})`); return []; }
    return snap && Array.isArray(snap.conversations) ? snap.conversations.filter(isPlain) : [];
  }

  function sessionsOf(conv) {
    const out = new Set();
    if (conv && typeof conv.current_session_id === 'string') out.add(conv.current_session_id);
    if (conv && Array.isArray(conv.sessions)) {
      for (const s of conv.sessions) if (isPlain(s) && typeof s.session_id === 'string') out.add(s.session_id);
    }
    return [...out];
  }

  // A conversation for a session id: mirror.conversationOf when the facade has
  // it (U66a), else the snapshot's conversation holding that session, else
  // mirror.conversationOfPid on that conversation's process.
  function conversationOfSession(sid) {
    if (typeof sid !== 'string' || !sid || !mirror) return null;
    try {
      if (typeof mirror.conversationOf === 'function') {
        const c = mirror.conversationOf(sid);
        if (typeof c === 'string' && c) return c;
      }
    } catch { /* fall through */ }
    const conv = conversations().find((c) => sessionsOf(c).includes(sid));
    if (!conv) return null;
    const pid = isPlain(conv.process) ? conv.process.pid : null;
    if (Number.isSafeInteger(pid) && pid > 0 && typeof mirror.conversationOfPid === 'function') {
      try {
        const c = mirror.conversationOfPid(pid);
        if (typeof c === 'string' && c) return c;
      } catch { /* fall through */ }
    }
    return typeof conv.id === 'string' ? conv.id : null;
  }

  // ── the gates ─────────────────────────────────────────────────────────────
  async function nestedGate() {
    let bin = null;
    try { bin = findClaude() || null; } catch { bin = null; }
    if (!bin) return { note: 'claude was not found, so sessions in subdirectories were not checked' };
    let r = null;
    try { r = await runClaudeAsync(['agents', '--json'], { cwd: root, bin, timeoutMs: AGENTS_TIMEOUT_MS }); } catch { r = null; }
    if (isPlain(r) && r.ok !== true && r.notFound === true) {
      return { note: 'claude was not found, so sessions in subdirectories were not checked' };
    }
    if (!isPlain(r) || r.ok !== true) return { blocked: { reason: 'agents-unknown', hint: hintOf('agents-unknown') } };
    const parsed = parseAgents(r.stdout);
    if (!parsed.ok) return { blocked: { reason: 'agents-unknown', hint: hintOf('agents-unknown') } };
    const rootReal = realpath(root) || path.resolve(root);
    for (const s of parsed.sessions) {
      if (!s.cwd || !path.isAbsolute(s.cwd) || !isInside(root, s.cwd)) continue;
      if (s.status === 'idle') continue;
      if (s.status === null) return { blocked: { reason: 'agents-unknown', hint: hintOf('agents-unknown') } };
      const rel = path.relative(rootReal, realpath(s.cwd) || path.resolve(s.cwd)) || '.';
      return {
        blocked: {
          reason: 'nested-busy',
          hint: `a Claude Code session in ${rel === '.' ? 'the project root' : rel} is not idle: wait for it, or stop it in the terminal`,
        },
      };
    }
    return {};
  }

  // → {blocked: null | {reason, hint}, notes: [string]}
  async function gate() {
    if (graph && lockHeld(graph)) return { blocked: { reason: 'locked', hint: hintOf('locked') }, notes: [] };
    const busy = conversations().map((c) => (isPlain(c.live) ? c.live.state : null)).filter((s) => ACTIVE_STATES.includes(s));
    if (busy.length) {
      const words = [...new Set(busy)].map((s) => STATE_WORDS[s] || s).join(', ');
      return { blocked: { reason: 'busy', hint: `Claude is ${words}: wait for the turn to end` }, notes: [] };
    }
    const n = await nestedGate();
    return { blocked: n.blocked || null, notes: n.note ? [n.note] : [] };
  }

  // ── the target ────────────────────────────────────────────────────────────
  async function turnHeader(turnId) {
    if (!mirror || typeof mirror.turn !== 'function') return null;
    let r = null;
    try { r = await mirror.turn(turnId); } catch { r = null; }
    return isPlain(r) && isPlain(r.turn) ? r.turn : null;
  }

  function nodeLabel(node) {
    if (!isPlain(node) || typeof node.id !== 'string' || !node.id) return null;
    if (graph) {
      try {
        const r = resolveNodeRef(graph, node.id, { allowLive: false });
        if (r && r.ok && typeof r.label === 'string') return r.label;
      } catch { /* the node's own label, below */ }
    }
    return typeof node.label === 'string' && node.label ? node.label : null;
  }

  const ready = (rec) => isPlain(rec) && rec.status === 'ready' && isPlain(rec.before) && isPlain(rec.after)
    && TREE_RE.test(String(rec.before.tree)) && TREE_RE.test(String(rec.after.tree));
  const headOf = (side) => (typeof side.head === 'string' || side.head === null ? side.head : undefined);

  // → {ok: true, target, tree, head} | refusal
  async function resolveTarget({ turn, node, point }) {
    if (typeof turn === 'string') {
      let rec = null;
      try { rec = await mirror.diff({ turn }); } catch { rec = null; }
      if (isPlain(rec) && rec.unavailable === true) return { ok: false, unavailable: true, reason: 'diffs-off' };
      if (!ready(rec)) return { ok: false, refused: 'no-record', hint: hintOf('no-record') };
      const header = await turnHeader(turn);
      const side = rec[point];
      const label = nodeLabel(header && header.node) || timeLabel(header && header.started_at) || timeLabel(rec.before.at) || 'an earlier turn';
      const cid = typeof rec.conversation_id === 'string' && rec.conversation_id ? rec.conversation_id
        : header && typeof header.conversation_id === 'string' ? header.conversation_id
          : conversationOfSession(header && header.session_id);
      return {
        ok: true,
        tree: side.tree,
        head: headOf(side),
        at: Number.isFinite(side.at) ? side.at : null,
        target: {
          turn_id: typeof rec.turn_id === 'string' ? rec.turn_id : turn,
          node_id: header && isPlain(header.node) && typeof header.node.id === 'string' ? header.node.id : null,
          label, point, conversation_id: cid || null, at: Number.isFinite(side.at) ? side.at : null,
        },
      };
    }
    let d = null;
    try { d = await mirror.diff({ node }); } catch { d = null; }
    if (isPlain(d) && d.unavailable === true) return { ok: false, unavailable: true, reason: 'diffs-off' };
    if (!isPlain(d) || !isPlain(d.node)) return { ok: false, refused: 'unknown', hint: hintOf('unknown') };
    const recs = Array.isArray(d.turns) ? d.turns.filter(ready) : [];
    if (!recs.length) return { ok: false, refused: 'no-record', hint: hintOf('no-record') };
    const rec = point === 'after' ? recs[recs.length - 1] : recs[0];
    const side = rec[point];
    const first = recs[0];
    const cid = typeof first.conversation_id === 'string' && first.conversation_id ? first.conversation_id : null;
    return {
      ok: true,
      tree: side.tree,
      head: headOf(side),
      at: Number.isFinite(side.at) ? side.at : null,
      target: {
        turn_id: typeof rec.turn_id === 'string' ? rec.turn_id : null,
        node_id: typeof d.node.id === 'string' ? d.node.id : null,
        label: nodeLabel(d.node) || timeLabel(side.at) || 'an earlier turn',
        point, conversation_id: cid, at: Number.isFinite(side.at) ? side.at : null,
      },
    };
  }

  // ── the preview store ─────────────────────────────────────────────────────
  const previews = new Map(); // id → stored preview, oldest first

  function prunePreviews() {
    const t = now();
    for (const [id, pv] of previews) if (t - pv.at > PREVIEW_TTL_MS) previews.delete(id);
    while (previews.size > PREVIEW_MAX) previews.delete(previews.keys().next().value);
  }
  function previewOf(id) {
    prunePreviews();
    return previews.get(id) || null;
  }

  // ── preview ───────────────────────────────────────────────────────────────
  let last = null; // {key, at, promise, done}

  async function makePreview({ turn, node, point }) {
    const f = await refresh();
    if (!f.ok) return { ok: false, unavailable: true, reason: f.reason };
    const t = await resolveTarget({ turn, node, point });
    if (!t.ok) return t;
    let lists = null;
    try { lists = await restore.preview(t.tree, { targetHead: t.head }); } catch { lists = null; }
    if (!isPlain(lists)) return { ok: false, refused: 'failed', hint: hintOf('failed') };
    if (lists.ok !== true) {
      const code = typeof lists.refused === 'string' ? lists.refused : 'failed';
      if (UNAVAILABLE.has(code)) {
        return { ok: false, unavailable: true, reason: code };
      }
      return { ok: false, refused: code, hint: hintOf(code) };
    }
    const g = await gate();
    const written = Array.isArray(lists.written) ? lists.written : [];
    const deleted = Array.isArray(lists.deleted) ? lists.deleted : [];
    const notCovered = Array.isArray(lists.notCovered) ? lists.notCovered : [];
    const id = newId('pv_');
    previews.set(id, {
      target: t.target, tree: t.tree, head: t.head, current_tree: lists.current_tree,
      lists: { written, deleted, notCovered, headMoved: lists.headMoved === true }, at: now(),
    });
    prunePreviews();
    return {
      ok: true,
      preview_id: id,
      target: { ...t.target },
      written,
      deleted,
      notCovered,
      headMoved: lists.headMoved === true,
      counts: countsOf({ written, deleted, notCovered }),
      blocked: g.blocked,
      notes: g.notes,
    };
  }

  // preview(q) → the answer above. Single-flight, with the rate shape.
  function preview(q = {}) {
    if (stopped) return Promise.resolve({ ok: false, unavailable: true, reason: 'stopped' });
    const s = isPlain(q) ? q : {};
    const point = s.point === undefined ? 'before' : s.point;
    const hasTurn = typeof s.turn === 'string' && s.turn !== '';
    const hasNode = typeof s.node === 'string' && s.node !== '';
    if (hasTurn === hasNode || !POINTS.includes(point)) {
      return Promise.resolve({ ok: false, refused: 'bad-target', hint: 'exactly one of turn and node, and point before or after' });
    }
    const key = `${hasTurn ? `t:${s.turn}` : `n:${s.node}`}:${point}`;
    const t = now();
    if (last && (!last.done || t - last.at < SAME_TARGET_MS)) {
      if (last.key === key) return last.promise;
      return Promise.resolve({ ok: false, refused: 'rate_limited', hint: hintOf('rate_limited') });
    }
    const mine = { key, at: t, done: false, promise: null };
    mine.promise = makePreview({ turn: hasTurn ? s.turn : undefined, node: hasNode ? s.node : undefined, point })
      .catch((e) => {
        say(`revert: preview failed (${e && e.code || 'error'})`);
        return { ok: false, refused: 'failed', hint: hintOf('failed') };
      })
      .finally(() => { mine.done = true; mine.at = now(); });
    last = mine;
    return mine.promise;
  }

  // ── after a restore or an undo ────────────────────────────────────────────
  function emit(op, id, outcome) {
    if (!bus || typeof bus.emit !== 'function') return;
    try { bus.emit({ event: { kind: 'control', op, id, outcome } }); } catch (e) { say(`revert: control event failed (${e && e.code || 'error'})`); }
  }

  function textFor(entry) {
    const t = entry.target || {};
    const label = typeof t.label === 'string' && t.label ? t.label : 'an earlier turn';
    const where = `${t.point === 'after' ? 'after' : 'before'} turn ${label}`;
    // The time of the state the files went back to (the target's snapshot).
    const when = timeLabel(t.at) || timeLabel(entry.at) || 'an earlier time';
    const head = entry.kind === 'undo'
      ? `**${NOTICE_HEADER}**: the restore to ${where} was undone (${when}).`
      : `**${NOTICE_HEADER}** to ${where} (${when}).`;
    const res = new Set((entry.residual || []).map((r) => r.path));
    const written = (entry.written || []).filter((w) => !res.has(w.path));
    return noticeText({
      head,
      rewritten: written.filter((w) => w.status !== 'A').map((w) => w.path),
      deleted: (entry.deleted || []).filter((x) => !res.has(x)),
      recreated: written.filter((w) => w.status === 'A').map((w) => w.path),
    });
  }

  function changedAny(entry) {
    const res = new Set((entry.residual || []).map((r) => r.path));
    return (entry.written || []).some((w) => !res.has(w.path)) || (entry.deleted || []).some((x) => !res.has(x));
  }

  function putNotice(entry) {
    if (!control.notices || typeof control.notices.put !== 'function') return false;
    try {
      control.notices.put({ conversation_id: entry.conversation_id || null, session_ids: entry.session_ids || [], text: textFor(entry), source: entry.restore_id });
      return true;
    } catch (e) {
      say(`revert: notice failed (${e && e.message})`);
      return false;
    }
  }

  // U81's one-pending-notice key: the conversation, else the sorted sessions.
  const noticeKey = (n) => (n.conversation_id ? `c:${n.conversation_id}` : `s:${[...(n.session_ids || [])].sort().join(',')}`);

  // The record follows the notices: a claim of ours → claimed; a put of
  // another restore's for the same conversation → the pending one replaced.
  function onNotice({ op, notice } = {}) {
    if (!isPlain(notice)) return;
    let changed = false;
    for (const e of loadRecord()) {
      if (op === 'claim' && e.restore_id === notice.source && e.notice === 'pending') { e.notice = 'claimed'; changed = true; }
      if ((op === 'put' || op === 'replace') && e.notice === 'pending' && e.restore_id !== notice.source
        && noticeKey(e) === noticeKey(notice)) { e.notice = 'replaced'; changed = true; }
    }
    if (changed) saveRecord();
  }
  const offNotices = control.notices && typeof control.notices.onChange === 'function' ? control.notices.onChange(onNotice) : null;

  // Record what ran, emit, tell Claude; → the frame's answer.
  function afterRun(kind, r, { target, targetTree, undoOf = null, notes = [] }) {
    const residual = Array.isArray(r.residual) ? r.residual.map((x) => ({ path: x.path, reason: x.reason })) : [];
    const lists = redact({
      written: Array.isArray(r.written) ? r.written : [],
      deleted: Array.isArray(r.deleted) ? r.deleted : [],
      notCovered: Array.isArray(r.notCovered) ? r.notCovered : [],
      residual,
    });
    const cid = target.conversation_id || null;
    const conv = cid ? conversations().find((c) => c.id === cid) : null;
    const entry = {
      restore_id: r.restore_id,
      kind,
      ...(undoOf ? { undo_of: undoOf } : {}),
      at: now(),
      target: { ...target },
      target_tree: targetTree,
      safety_tree: r.safety_tree || null,
      after_tree: r.after_tree || null,
      written: lists.written,
      deleted: lists.deleted,
      notCovered: lists.notCovered,
      residual: lists.residual,
      headMoved: r.headMoved === true,
      conversation_id: cid,
      session_ids: sessionsOf(conv),
      notice: 'none',
    };
    addEntry(entry);
    emit(kind, r.restore_id, r.ok === true ? 'ok' : 'residual');
    if (changedAny(entry) && putNotice(entry) && entry.notice === 'none') {
      entry.notice = 'pending';
      saveRecord();
    }
    const answer = {
      ok: r.ok === true,
      restore_id: r.restore_id,
      ...(undoOf ? { undo_of: undoOf } : {}),
      counts: countsOf(entry),
      headMoved: entry.headMoved,
      residual: entry.residual,
      notes,
    };
    if (!answer.ok) return { ...answer, refused: 'residual', hint: hintOf('residual') };
    return answer;
  }

  function passRefusal(r) {
    const code = isPlain(r) && typeof r.refused === 'string' ? r.refused : 'failed';
    return { ok: false, refused: code, hint: hintOf(code) };
  }

  // What check() resolved, for run() on the same target object (invoke hands
  // both the one target): the gate's notes.
  const checkedNotes = new WeakMap();

  async function gateCheck(target) {
    const f = await refresh();
    if (!f.ok) return { refused: f.reason, hint: hintOf(f.reason) };
    const g = await gate();
    if (g.blocked) return { refused: g.blocked.reason, hint: g.blocked.hint };
    checkedNotes.set(target, g.notes);
    return null;
  }

  // ── the 'restore' row ─────────────────────────────────────────────────────
  function oneOfAlias(source, name, alias) {
    const s = isPlain(source) ? source : {};
    const a = s[name];
    const b = s[alias];
    if (a !== undefined && b !== undefined && a !== b) throw new BadTarget(`${name} and ${alias} differ`);
    return a !== undefined ? a : b;
  }

  function restoreParams(source) {
    const id = oneOfAlias(source, 'preview_id', 'preview');
    if (typeof id !== 'string' || !PREVIEW_ID_RE.test(id)) throw new BadTarget('preview_id: a preview id');
    return { preview_id: id };
  }

  async function restoreDescribe(target) {
    const pv = previewOf(target.preview_id);
    if (!pv) return { title: 'Restore files', summary: hintOf('stale-preview') };
    const { written, deleted, headMoved } = pv.lists;
    const c = countsOf(pv.lists);
    const n = written.length + deleted.length;
    const where = `${pv.target.point === 'after' ? 'after' : 'before'} turn ${pv.target.label}`;
    const lines = redact([
      ...written.map((w) => `${w.status === 'A' ? 're-create' : 'rewrite'} ${w.path}`),
      ...deleted.map((x) => `delete ${x}`),
    ]);
    const shown = lines.slice(0, DESCRIBE_LINES);
    if (lines.length > shown.length) shown.push(`and ${lines.length - shown.length} more`);
    shown.push(`edits made since that turn, yours included, are reverted too`);
    return {
      title: 'Restore files',
      summary: `Restore ${n} file${n === 1 ? '' : 's'} to ${where}: ${c.rewritten} rewritten · ${c.deleted} deleted · ${c.recreated} re-created${headMoved ? ' · HEAD has moved since then' : ''}`,
      lines: shown,
    };
  }

  async function restoreCheck(target) {
    if (!previewOf(target.preview_id)) return { refused: 'stale-preview', hint: hintOf('stale-preview') };
    return gateCheck(target);
  }

  async function restoreRun(target) {
    const notes = checkedNotes.get(target) || [];
    checkedNotes.delete(target);
    const pv = previewOf(target.preview_id);
    if (!pv) return { ok: false, refused: 'stale-preview', hint: hintOf('stale-preview') };
    let r = null;
    try { r = await restore.apply(pv.tree, { expect: pv.current_tree, targetHead: pv.head }); } catch { r = null; }
    if (!isPlain(r) || typeof r.restore_id !== 'string') return passRefusal(r);
    previews.delete(target.preview_id); // consumed: the working tree is no longer the one it was bound to
    return afterRun('restore', r, { target: pv.target, targetTree: pv.tree, notes });
  }

  // ── the 'undo' row ────────────────────────────────────────────────────────
  function undoParams(source) {
    const id = oneOfAlias(source, 'restore_id', 'restore');
    if (id === 'latest') {
      const latest = newestUndoable();
      if (!latest) throw new BadTarget('nothing to undo');
      return { restore_id: latest };
    }
    if (typeof id !== 'string' || !RESTORE_ID_RE.test(id)) throw new BadTarget('restore_id: latest or a restore id');
    return { restore_id: id };
  }

  async function undoDescribe(target) {
    const e = entryOf(target.restore_id);
    if (!e) return { title: 'Undo restore', summary: hintOf('unknown-restore') };
    const n = (e.written || []).length + (e.deleted || []).length;
    const t = e.target || {};
    const where = `${t.point === 'after' ? 'after' : 'before'} turn ${t.label || 'an earlier turn'}`;
    const what = e.kind === 'undo' ? `the undo of a restore (${n} file${n === 1 ? '' : 's'}, ${where}` : `the restore of ${n} file${n === 1 ? '' : 's'} (${where}`;
    return { title: 'Undo restore', summary: `Undo ${what}, ${ageLabel(now() - e.at)} ago)` };
  }

  async function undoCheck(target) {
    const e = entryOf(target.restore_id);
    if (!e || undone(e.restore_id) || !TREE_RE.test(String(e.after_tree))) return { refused: 'unknown', hint: hintOf('unknown-restore') };
    return gateCheck(target);
  }

  async function undoRun(target) {
    const notes = checkedNotes.get(target) || [];
    checkedNotes.delete(target);
    const e = entryOf(target.restore_id);
    if (!e || !TREE_RE.test(String(e.after_tree))) return { ok: false, refused: 'unknown', hint: hintOf('unknown-restore') };
    let r = null;
    try { r = await restore.undo(e.restore_id, { expect: e.after_tree }); } catch { r = null; }
    if (!isPlain(r) || typeof r.restore_id !== 'string') {
      if (isPlain(r) && r.refused === 'unknown') return { ok: false, refused: 'unknown', hint: hintOf('unknown-restore') };
      return passRefusal(r);
    }
    return afterRun('undo', r, { target: { ...(e.target || {}) }, targetTree: e.safety_tree || null, undoOf: e.restore_id, notes });
  }

  const offRestore = control.action('restore', {
    fields: ['preview_id'],
    layouts: ['confirm'],
    limit: { scope: 'project', ms: LIMIT_MS },
    params: restoreParams,
    key: (target) => target.preview_id,
    describe: restoreDescribe,
    check: restoreCheck,
    run: restoreRun,
    features,
  });
  const offUndo = control.action('undo', {
    fields: ['restore_id'],
    layouts: ['confirm'],
    limit: { scope: 'project', ms: LIMIT_MS },
    params: undoParams,
    key: (target) => target.restore_id,
    describe: undoDescribe,
    check: undoCheck,
    run: undoRun,
    features,
  });

  // ── lifecycle ─────────────────────────────────────────────────────────────
  async function start() {
    if (stopped) return;
    // Every pending notice again, oldest first (a restart lost U81's memory).
    const pending = loadRecord().filter((e) => e.notice === 'pending').reverse();
    for (const e of pending) putNotice(e);
    await refresh({ passive: true });
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    try { offRestore(); } catch { /* gone */ }
    try { offUndo(); } catch { /* gone */ }
    if (offNotices) { try { offNotices(); } catch { /* gone */ } }
    previews.clear();
    for (const k of ['passive', 'full']) if (probing[k]) { try { await probing[k]; } catch { /* settled */ } }
  }

  const revert = Object.freeze({ preview, features, refresh, restores, start, stop });
  control.provide('revert', revert);
  return revert;
}

module.exports = {
  installRevert,
  parseAgents,
  noticeText,
  NOTICE_HEADER,
  HINTS,
  LIMIT_MS,
  PREVIEW_TTL_MS,
  PREVIEW_MAX,
  SAME_TARGET_MS,
  AGENTS_TIMEOUT_MS,
  FEATURES_TTL_MS,
  RECORD_KEEP,
  NOTICE_LIST_MAX,
};
