// Chats: the hub's assignments, their roots and the daemon each one asks for
// (contract 06 C-06.14 to C-06.19, C-06.22, C-06.25; A-06.2's
// 06-chat-assignment.json; 11 C-11.4, C-11.6; U720).
//
//   createChats({ lifecycle, hubId, log, deps: { git, runInit, now } })
//     → { apply(assignment), originsOf(chatId), statusOf(chatId), resume(), install(ctx) }
//
// APPLY takes one assignment body (05's chat.assign carries it as
// `assignment`) and answers a Promise of an OUTCOME — codes, ids and counts
// only, never a path, never a daemon's or git's text (C-11.6):
//   { chat_id, rev, state, reason?, detail?, code?, ignored? }
//   (`removed: true` beside state `stopped` when a removal forgot the chat)
// where `rev` is the rev the record holds as applied (0: none), `state` and
// `reason` are 06-chat-status.json's enums, `detail` one fixed sentence, and
// `code` this module's own token for a reason `other` (invalid-assignment,
// record-unreadable, workdir-refused, scope-changed, record-full).
//
//   * ORDER (C-06.15). Assignments run one at a time PER CHAT, in arrival
//     order, on a serial queue; each re-reads the record when its turn comes,
//     so a rev at or below the record's chats[].rev is ignored (the hub
//     resends every chat.assign after hello.ack, C-05.20), and so is a rev
//     below the highest this process has seen for the chat (a refused rev 3
//     is never undone by a late rev 2). An equal rev may come again: one that
//     was refused is tried afresh (accept_new_chats may have changed since).
//   * THE BODY is checked by hand against 06-chat-assignment.json (A-06.2's
//     replacement): every key, pattern and enum, additionalProperties false at
//     every level, the scope's oneOf. A body that fails is refused `other`
//     (code invalid-assignment) and nothing is applied; it never changes what
//     statusOf answers. The origins are taken verbatim (C-06.29a: pass
//     through, never derived).
//   * A NEW CHAT is refused `not-accepting` while accept_new_chats is false.
//     Its root:
//       folder — the offered folder's real path, named by folder_id ONLY (no
//                field accepts a path, C-06.14): an unknown id is
//                `unknown-folder`; a folder with no .web-chat/ directory is
//                `init-needed`, with no write into it (C-06.16). The one
//                question asked of .web-chat/ is whether it is a directory:
//                nothing inside it is read (C-11.4).
//       repo   — <workdir>/repos/<label>, cloned by `git clone [--branch
//                <ref>] -- <url> <root>` through createGitRunner (the daemon's
//                one git runner: its scrubbed GIT_* environment, no terminal
//                prompt, the machine's own credentials). A ref starting with
//                `-` is refused before anything else is done: `clone-failed`
//                for a new chat, `other` (invalid-assignment) for a new rev
//                of a mapped one, whose mapping it leaves as it is. A non-zero
//                exit or a GitRunError is `clone-failed`; git's output never
//                leaves this module and is not logged (its exit code is).
//       space  — <workdir>/spaces/<label>, mkdir 0700.
//     The workdir is checked before each use (C-06.18): outside ~/.web-chat
//     and inside no offered folder, each over the canonical spelling (the
//     realpath of the nearest existing ancestor), else `other`
//     (workdir-refused); it and repos/, spaces/ are made 0700. An owned root
//     already on disk (a chat removed earlier keeps its root, C-06.22) is
//     reused: a space directory as it is, a clone when it holds .git.
//     Then, for a repo or a space, `claude-web-chat init <root> --yes
//     --no-input --no-open --no-tour --no-warm --register-mcp` as a CHILD of
//     the managed bin (./init-child, INIT@child-process; never in-process,
//     never lib/cli), its output discarded; a non-zero exit, or no .web-chat/
//     after it, is `failed`, `init-failed`. --no-warm is C-06.19's: the first
//     daemon on a prepared root is the connector's own spawn. Registration —
//     the MCP server, the hooks, the mod as init switches it on anywhere
//     Claude Code can run it (INIT@mod-as-init) — comes from that init alone
//     (C-06.25): this module writes nothing under a root, no .claude/ and no
//     .mcp.json.
//   * ONE CHAT PER ROOT (C-06.17): a root another chat maps is `root-in-use`,
//     checked before the preparation and again inside the record's lock.
//   * THE MAPPING is 06-connector-state's $defs/chat, written through
//     lib/setup/connector updateRecord (the record's one writer):
//     { chat_id, rev, scope_kind, folder_id?, root, instance, owned_root,
//       desired, manual_attach_at, assigned_at } — instance = instanceId(root),
//     owned_root true for a repo or a space, manual_attach_at null at first and
//     kept on every later rev, assigned_at kept from the first.
//   * DESIRED. running → lifecycle.run(chat); stopped → lifecycle.stop(chat,
//     stop_mode || 'release'); removed → that stop, then the mapping is
//     forgotten (an owned root stays on disk, C-06.22). An existing chat whose
//     scope kind or folder changes is refused `other` (scope-changed): one
//     chat keeps one root. An existing folder chat whose folder is no longer
//     offered is refused `folder-withdrawn` and not run.
//   * THE AGENT. launch 'manual' needs nothing here (`connect attach` at the
//     machine). launch 'connector' while connector mode is not in this build
//     (REQ@connector-mode = a): the daemon still runs, and the status reason is
//     `home-launch-off` when let_home_start_agents is false, else `other` with
//     the attach sentence (ruling U720@connector-launch-reason (a)). statusOf
//     works it out from the record's settings as they stand when it is asked.
//
// ORIGINSOF(chatId) answers the assignment's origins (a frozen copy) for the
// relay (U717), kept in memory only: the hub resends every chat.assign after
// hello.ack, so nothing is persisted; a removal forgets them. STATUSOF(chatId)
// answers the last outcome of an assignment that was not ignored (a refusal
// included; null once a removal forgot the chat), with the session reason
// worked out afresh (U729 composes 06-chat-status from it). RESUME()
// runs every chat the record holds as `running` — after a connector restart
// the hub's resend is an applied rev and is ignored, so the record is what
// brings the holds back. INSTALL(ctx) is the CONNECTOR@install-seam hook: it
// sets ctx.chats (U790 wires the link's chat.assign to apply).

const fs = require('fs');
const path = require('path');
const { userPaths, isInside, fence, isSafeId, WEB_CHAT_DIRNAME } = require('../core/paths');
const { canonicalRoot, sameRoot } = require('../core/portfiles');
const setup = require('../setup/connector');
const { instanceId } = require('../util/registry');
const { createGitRunner, GitRunError } = require('../server/git-run');
const { runInit: defaultRunInit } = require('./init-child');

const DIR_MODE = 0o700;
const CLONE_TIMEOUT_MS = 600_000;
// C-06.16's flags, exactly: init answers no question, opens nothing, starts no
// daemon and registers the MCP server (which --yes --no-input would decline).
const INIT_FLAGS = Object.freeze(['--yes', '--no-input', '--no-open', '--no-tour', '--no-warm', '--register-mcp']);
const STOP_MODES = Object.freeze(['release', 'now']);
const STATES = Object.freeze(['preparing', 'starting', 'running', 'stopping', 'stopped', 'refused', 'failed']);
const REASONS = Object.freeze([
  'unknown-folder', 'folder-withdrawn', 'root-in-use', 'init-needed', 'init-failed', 'clone-failed',
  'daemon-timeout', 'identity-mismatch', 'cap', 'paused', 'not-accepting', 'home-launch-off', 'no-tmux',
  'needs-trust', 'no-claude', 'revoked', 'other',
]);
const OTHER_CODES = Object.freeze(['invalid-assignment', 'record-unreadable', 'workdir-refused', 'scope-changed', 'record-full']);
const RECORD_CHATS_MAX = 1024;

const attachDetail = (label) =>
  `connector mode is not in this build; run \`claude-web-chat connect attach ${label}\` on the machine`;

// ── the body (06-chat-assignment.json, A-06.2; mirrored by hand) ───────────

const LABEL_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;
const FOLDER_ID_RE = /^f_[0-9a-f]{16}$/;
const REPO_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF_RE = /^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,199}$/;
// A ref that reads as a git option: a '-', then the grammar's own characters
// and length, plus the '=' of an option's value (the brief's '-upload-pack=x').
// Let through the hand check only to be refused by the apply step, before
// anything else (C-06.16); any other bad ref fails the hand check.
const DASH_REF_RE = /^-[A-Za-z0-9._/=-]{0,199}$/;
const SURFACE_RE = /^https:\/\/chat-[0-9a-hjkmnp-tv-z]{26}\.[a-z0-9.-]+(:[1-9][0-9]{0,4})?$/;
const ANSWER_RE = /^https:\/\/chat-[0-9a-hjkmnp-tv-z]{26}-a\.[a-z0-9.-]+(:[1-9][0-9]{0,4})?$/;
const SHELL_RE = /^https:\/\/[a-z0-9.-]+(:[1-9][0-9]{0,4})?$/;

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const codePoints = (s) => [...s].length;

// The first way an object breaks its closed key set, as a pointer (never the
// key itself: a key is the hub's text), or null.
function closed(o, at, allowed, required) {
  if (!isPlain(o)) return `${at} must be an object`;
  for (const k of required) if (!has(o, k)) return `${at}/${k} is required`;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return `${at} carries a key the body does not name`;
  return null;
}

const str = (v, re) => typeof v === 'string' && re.test(v);

function scopeProblem(s) {
  if (!isPlain(s)) return '/scope must be an object';
  switch (s.kind) {
    case 'folder':
      return closed(s, '/scope', ['kind', 'folder_id'], ['kind', 'folder_id'])
        || (str(s.folder_id, FOLDER_ID_RE) ? null : '/scope/folder_id does not match its pattern');
    case 'repo':
      return closed(s, '/scope', ['kind', 'url', 'ref'], ['kind', 'url'])
        || (str(s.url, REPO_URL_RE) ? null : '/scope/url does not match its pattern')
        // The schema's ref pattern already excludes a leading '-'; the explicit
        // C-06.16 refusal before git runs is the apply step's, so a ref that
        // reads as a git option (DASH_REF_RE: a leading '-', the rest the
        // grammar's own characters and length, '=' allowed) passes here to be refused
        // there, new chat or existing; any other bad ref is refused here.
        || (!has(s, 'ref') || str(s.ref, REF_RE) || str(s.ref, DASH_REF_RE)
          ? null : '/scope/ref does not match its pattern');
    case 'space':
      return closed(s, '/scope', ['kind'], ['kind']);
    default:
      return '/scope/kind must be one of folder, repo, space';
  }
}

// The first problem with an assignment body, as a pointer and a rule, or null.
function assignmentProblem(a) {
  const top = closed(a, '', ['v', 'chat_id', 'rev', 'issued_at', 'title', 'scope', 'desired', 'stop_mode', 'agent', 'origins'],
    ['v', 'chat_id', 'rev', 'issued_at', 'scope', 'desired', 'agent', 'origins']);
  if (top) return top;
  if (a.v !== 1) return '/v must be 1';
  if (!str(a.chat_id, LABEL_RE)) return '/chat_id does not match its pattern';
  if (!Number.isSafeInteger(a.rev) || a.rev < 1) return '/rev must be an integer of at least 1';
  if (typeof a.issued_at !== 'number' || !Number.isFinite(a.issued_at)) return '/issued_at must be a number';
  if (has(a, 'title') && (typeof a.title !== 'string' || codePoints(a.title) > 120)) return '/title must be a string of at most 120';
  const scope = scopeProblem(a.scope);
  if (scope) return scope;
  if (!['running', 'stopped', 'removed'].includes(a.desired)) return '/desired must be one of running, stopped, removed';
  if (has(a, 'stop_mode') && !STOP_MODES.includes(a.stop_mode)) return '/stop_mode must be one of release, now';
  const agent = closed(a.agent, '/agent', ['want', 'launch', 'requested_by'], ['want', 'launch']);
  if (agent) return agent;
  if (!['none', 'session'].includes(a.agent.want)) return '/agent/want must be one of none, session';
  if (!['manual', 'connector'].includes(a.agent.launch)) return '/agent/launch must be one of manual, connector';
  if (has(a.agent, 'requested_by') && !['user', 'home'].includes(a.agent.requested_by)) return '/agent/requested_by must be one of user, home';
  const origins = closed(a.origins, '/origins', ['surface', 'answer', 'shell'], ['surface', 'answer', 'shell']);
  if (origins) return origins;
  if (!str(a.origins.surface, SURFACE_RE)) return '/origins/surface does not match its pattern';
  if (!str(a.origins.answer, ANSWER_RE)) return '/origins/answer does not match its pattern';
  if (!str(a.origins.shell, SHELL_RE)) return '/origins/shell does not match its pattern';
  return null;
}

// ── spelling and containment ───────────────────────────────────────────────

const realOf = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };

// A root's spelling is lib/core/portfiles' `canonicalRoot` (the one
// `instanceId` hashes): the realpath of its nearest existing ancestor with the
// part not made yet appended, so a workdir not made yet, under a HOME reached
// through a link, still fences. `sameRoot` is portfiles' too.
const within = (parent, child) => !!parent && !!child && isInside(canonicalRoot(parent), canonicalRoot(child));

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
// The one question asked of a root's .web-chat/ (C-11.4): is it a directory.
const hasWebChatDir = (root) => isDir(path.join(root, WEB_CHAT_DIRNAME));

// A directory made 0700 (or one already there, left as it is). A link or a
// file in its place is refused.
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
  } catch (e) {
    if (!e || e.code !== 'EEXIST') return false;
  }
  try { return fs.lstatSync(dir).isDirectory(); } catch { return false; }
}

// ── the module ─────────────────────────────────────────────────────────────

function createChats({ lifecycle, hubId, log = () => {}, deps = {} } = {}) {
  if (!lifecycle || typeof lifecycle.run !== 'function' || typeof lifecycle.stop !== 'function') {
    throw new TypeError('createChats: a lifecycle (run, stop) is required');
  }
  if (typeof hubId !== 'string' || !userPaths().connectorRecord(hubId)) {
    throw new TypeError('createChats: a hub id is required');
  }
  const d = {
    now: Date.now,
    runInit: defaultRunInit,
    record: { readRecord: setup.readRecord, updateRecord: setup.updateRecord },
    ...deps,
  };
  const git = d.git || createGitRunner();
  const say = (line) => { try { log(line); } catch {} };
  const logId = (id) => (isSafeId(id) ? id : '?');

  // chat id → { tail, maxRev, origins, originsRev, agent, outcome }
  const memory = new Map();
  const mem = (id) => {
    let m = memory.get(id);
    if (!m) { m = { tail: Promise.resolve(), maxRev: 0, origins: null, originsRev: 0, agent: null, outcome: null }; memory.set(id, m); }
    return m;
  };

  function readRecord() {
    let read;
    try { read = d.record.readRecord(hubId); } catch { return null; }
    return read && read.ok ? read.value : null;
  }

  // updateRecord, its refusals as a code: ERECORD (a record it will not
  // overwrite) and EBADRECORD (a change the schema refuses).
  function change(fn) {
    try {
      d.record.updateRecord(hubId, fn);
      return null;
    } catch (e) {
      if (e && (e.code === 'ERECORD' || e.code === 'EBADRECORD' || e.code === 'EHUBID')) return 'record-unreadable';
      throw e;
    }
  }

  const outcome = (fields) => {
    const o = { ...fields };
    if (o.reason && !REASONS.includes(o.reason)) o.reason = 'other';
    if (o.state && !STATES.includes(o.state)) o.state = 'failed';
    return o;
  };
  const refused = (chatId, rev, reason, code) => outcome({ chat_id: chatId, rev, state: 'refused', reason, ...(code ? { code } : {}) });
  const failed = (chatId, rev, reason, code) => outcome({ chat_id: chatId, rev, state: 'failed', reason, ...(code ? { code } : {}) });

  // The session reason a status carries for a running chat, from the agent
  // the hub last asked for and the settings as they stand now.
  function sessionReason(agent, label, settings) {
    if (!agent || agent.want !== 'session' || agent.launch !== 'connector') return null;
    if (!settings || settings.let_home_start_agents !== true) return { reason: 'home-launch-off' };
    return { reason: 'other', detail: attachDetail(label) };
  }

  function withSession(o, agent, settings) {
    if (!o || (o.state !== 'running' && o.state !== 'starting')) return o;
    const s = sessionReason(agent, o.chat_id, settings);
    if (!s) return o;
    return { ...o, ...s };
  }

  // ── the workdir and the owned roots ──────────────────────────────────────

  // The workdir as C-06.18 needs it, made 0700 with its `sub` directory; →
  // { dir } (the sub directory) or null.
  function workdirFor(record, sub) {
    const workdir = record.workdir;
    if (typeof workdir !== 'string' || !path.isAbsolute(workdir)) return null;
    if (within(userPaths().root, workdir)) return null;
    for (const f of record.folders || []) if (within(f.path, workdir)) return null;
    try { fs.mkdirSync(workdir, { recursive: true, mode: DIR_MODE }); } catch { return null; }
    if (!isDir(workdir)) return null;
    // Checked again now that it exists, over its realpath.
    if (within(userPaths().root, workdir)) return null;
    for (const f of record.folders || []) if (within(f.path, workdir)) return null;
    const dir = fence(workdir, sub);
    if (!dir || !ensureDir(dir)) return null;
    return { workdir, dir };
  }

  // Clone or make the root. → { root } | an outcome.
  async function prepareOwned(a, record) {
    const kind = a.scope.kind;
    const place = workdirFor(record, kind === 'repo' ? 'repos' : 'spaces');
    if (!place) return refused(a.chat_id, 0, 'other', 'workdir-refused');
    const root = fence(place.dir, a.chat_id);
    if (!root) return refused(a.chat_id, 0, 'other', 'workdir-refused');
    if ((record.chats || []).some((c) => c.chat_id !== a.chat_id && sameRoot(c.root, root))) {
      return refused(a.chat_id, 0, 'root-in-use');
    }
    if (kind === 'space') {
      if (!ensureDir(root)) return failed(a.chat_id, 0, 'other', 'workdir-refused');
    } else if (!isDir(path.join(root, '.git'))) {
      const argv = ['clone', ...(a.scope.ref ? ['--branch', a.scope.ref] : []), '--', a.scope.url, root];
      let code;
      try {
        const r = await git(argv, { cwd: place.dir, timeoutMs: CLONE_TIMEOUT_MS });
        code = r && Number.isInteger(r.code) ? r.code : 1;
      } catch (e) {
        // A GitRunError's code is one of the runner's fixed tokens; anything
        // else is logged as 'error', never its message.
        code = e instanceof GitRunError ? e.code : 'error';
      }
      if (code !== 0 || !isDir(root)) {
        say(`chat ${logId(a.chat_id)} clone failed: ${typeof code === 'number' ? `exit ${code}` : code}`);
        return failed(a.chat_id, 0, 'clone-failed');
      }
    }
    const real = realOf(root);
    if (!real) return failed(a.chat_id, 0, 'other', 'workdir-refused');
    let exit;
    try { exit = await d.runInit(real, [...INIT_FLAGS], { stdio: 'ignore' }); } catch { exit = 1; }
    if (exit !== 0 || !hasWebChatDir(real)) {
      say(`chat ${logId(a.chat_id)} init failed: exit ${Number.isInteger(exit) ? exit : '?'}`);
      return failed(a.chat_id, 0, 'init-failed');
    }
    return { root: real };
  }

  // A folder chat's root. → { root, folder_id } | an outcome.
  function folderRoot(a, record) {
    const folder = (record.folders || []).find((f) => f.id === a.scope.folder_id);
    if (!folder) return refused(a.chat_id, 0, 'unknown-folder');
    if ((record.chats || []).some((c) => c.chat_id !== a.chat_id && sameRoot(c.root, folder.path))) {
      return refused(a.chat_id, 0, 'root-in-use');
    }
    // No write into a user's folder at assignment time (C-06.16).
    if (!hasWebChatDir(folder.path)) return refused(a.chat_id, 0, 'init-needed');
    return { root: folder.path, folder_id: folder.id };
  }

  // ── run and stop ─────────────────────────────────────────────────────────

  async function runChat(entry) {
    let r;
    try { r = await lifecycle.run({ ...entry }); } catch { r = { state: 'failed', reason: 'other' }; }
    const state = r && ['running', 'starting', 'failed'].includes(r.state) ? r.state : 'failed';
    const o = { chat_id: entry.chat_id, rev: entry.rev, state };
    if (state === 'failed') o.reason = r && REASONS.includes(r.reason) ? r.reason : 'other';
    return outcome(o);
  }

  async function stopChat(entry, mode) {
    try { await lifecycle.stop({ ...entry }, mode); } catch { /* the lifecycle's own failure; the hold is gone */ }
  }

  // ── one assignment ───────────────────────────────────────────────────────

  async function applyOne(a) {
    const m = mem(a.chat_id);
    const record = readRecord();
    if (!record) return refused(a.chat_id, 0, 'other', 'record-unreadable');
    const existing = (record.chats || []).find((c) => c.chat_id === a.chat_id) || null;
    const appliedRev = existing ? existing.rev : 0;

    if (a.scope.kind === 'repo' && str(a.scope.ref, DASH_REF_RE)) {
      // C-06.16: a ref starting with '-' is refused before anything else, so
      // git never reads it as an option and no rev of it is applied: a new
      // chat clone-failed (the contract's word), an existing chat's new rev
      // other (invalid-assignment), its mapping untouched.
      return existing
        ? refused(a.chat_id, appliedRev, 'other', 'invalid-assignment')
        : refused(a.chat_id, 0, 'clone-failed');
    }

    if (a.rev <= appliedRev || a.rev < m.maxRev) {
      // Already applied (or older than one seen): ignored. An equal rev is the
      // hub's resend; what it says is kept in memory, and nothing is done.
      if (existing && a.rev === appliedRev) {
        m.origins = Object.freeze({ ...a.origins });
        m.originsRev = a.rev;
        m.agent = { ...a.agent };
      }
      return { chat_id: a.chat_id, rev: appliedRev, ignored: true };
    }
    m.maxRev = Math.max(m.maxRev, a.rev);

    // ── removed ──
    if (a.desired === 'removed') {
      if (existing) {
        await stopChat(existing, a.stop_mode || 'release');
        const why = change((rec) => {
          if (!rec) return null;
          const at = rec.chats.findIndex((c) => c.chat_id === a.chat_id);
          if (at < 0) return null;
          rec.chats.splice(at, 1);
          return rec;
        });
        if (why) return refused(a.chat_id, appliedRev, 'other', why);
      }
      // Forgotten, but for the highest rev seen: a late older rev must not
      // bring the chat back.
      m.origins = null;
      m.originsRev = 0;
      m.agent = null;
      return outcome({ chat_id: a.chat_id, rev: 0, state: 'stopped', removed: true });
    }

    let entry;
    if (existing) {
      // ── a new rev of a chat already mapped: its root does not move ──
      if (existing.scope_kind !== a.scope.kind
        || (a.scope.kind === 'folder' && existing.folder_id !== a.scope.folder_id)) {
        return refused(a.chat_id, appliedRev, 'other', 'scope-changed');
      }
      if (a.desired === 'running' && existing.scope_kind === 'folder') {
        if (!(record.folders || []).some((f) => f.id === existing.folder_id)) {
          return refused(a.chat_id, appliedRev, 'folder-withdrawn');
        }
        if (!hasWebChatDir(existing.root)) return refused(a.chat_id, appliedRev, 'init-needed');
      }
      entry = {
        ...existing,
        rev: a.rev,
        desired: a.desired,
        instance: existing.instance || instanceId(existing.root),
        manual_attach_at: existing.manual_attach_at === undefined ? null : existing.manual_attach_at,
      };
    } else {
      // ── a new chat ──
      if (!record.settings || record.settings.accept_new_chats !== true) return refused(a.chat_id, 0, 'not-accepting');
      if ((record.chats || []).length >= RECORD_CHATS_MAX) return refused(a.chat_id, 0, 'other', 'record-full');
      const prepared = a.scope.kind === 'folder' ? folderRoot(a, record) : await prepareOwned(a, record);
      if (prepared.state) return prepared;
      entry = {
        chat_id: a.chat_id,
        rev: a.rev,
        scope_kind: a.scope.kind,
        ...(prepared.folder_id ? { folder_id: prepared.folder_id } : {}),
        root: prepared.root,
        instance: instanceId(prepared.root),
        owned_root: a.scope.kind !== 'folder',
        desired: a.desired,
        manual_attach_at: null,
        assigned_at: d.now(),
      };
    }

    // ── the mapping, under the record's lock, every check made again ──
    let verdict = null;
    const why = change((rec) => {
      if (!rec) { verdict = refused(a.chat_id, 0, 'other', 'record-unreadable'); return null; }
      const at = rec.chats.findIndex((c) => c.chat_id === a.chat_id);
      const now = at >= 0 ? rec.chats[at] : null;
      if (now && now.rev >= a.rev) { verdict = { chat_id: a.chat_id, rev: now.rev, ignored: true }; return null; }
      if (!now && existing) { verdict = refused(a.chat_id, 0, 'other', 'record-unreadable'); return null; }
      if (!now && !(rec.settings && rec.settings.accept_new_chats === true)) {
        verdict = refused(a.chat_id, 0, 'not-accepting');
        return null;
      }
      if (rec.chats.some((c) => c.chat_id !== a.chat_id && sameRoot(c.root, entry.root))) {
        verdict = refused(a.chat_id, now ? now.rev : 0, 'root-in-use');
        return null;
      }
      if (now) {
        // Kept from the record as it now stands: a `connect attach` may have
        // set manual_attach_at since the read above.
        entry.manual_attach_at = now.manual_attach_at === undefined ? null : now.manual_attach_at;
        if (now.assigned_at !== undefined) entry.assigned_at = now.assigned_at;
        rec.chats[at] = entry;
      } else {
        if (rec.chats.length >= RECORD_CHATS_MAX) { verdict = refused(a.chat_id, 0, 'other', 'record-full'); return null; }
        rec.chats.push(entry);
      }
      return rec;
    });
    if (why) return refused(a.chat_id, appliedRev, 'other', why);
    if (verdict) return verdict;

    m.origins = Object.freeze({ ...a.origins });
    m.originsRev = a.rev;
    m.agent = { ...a.agent };

    if (a.desired === 'stopped') {
      if (existing) await stopChat(entry, a.stop_mode || 'release');
      return outcome({ chat_id: a.chat_id, rev: a.rev, state: existing ? 'stopping' : 'stopped' });
    }
    return runChat(entry);
  }

  function enqueue(chatId, task) {
    const m = mem(chatId);
    const run = m.tail.then(task);
    m.tail = run.then(() => {}, () => {});
    return run;
  }

  function note(o) {
    const parts = [`chat ${logId(o.chat_id)} rev ${Number.isInteger(o.rev) ? o.rev : '?'}`];
    parts.push(o.ignored ? 'ignored' : o.state);
    if (o.reason) parts.push(o.reason);
    if (o.code) parts.push(o.code);
    say(parts.join(' '));
  }

  function apply(assignment) {
    const problem = assignmentProblem(assignment);
    if (problem) {
      const id = isPlain(assignment) && str(assignment.chat_id, LABEL_RE) ? assignment.chat_id : null;
      const o = refused(id, 0, 'other', 'invalid-assignment');
      say(`chat ${logId(id)} assignment refused: ${problem}`);
      return Promise.resolve(o);
    }
    const a = structuredClone(assignment);
    return enqueue(a.chat_id, async () => {
      let o;
      try {
        o = await applyOne(a);
      } catch {
        o = failed(a.chat_id, 0, 'other');
      }
      // Kept without the session reason, which is worked out afresh each
      // time from the settings as they then stand.
      if (!o.ignored) mem(a.chat_id).outcome = o.removed ? null : o;
      if (!o.ignored && !o.removed) {
        const record = readRecord();
        o = withSession(o, mem(a.chat_id).agent, record ? record.settings : null);
      }
      note(o);
      return o;
    });
  }

  // ── after a restart: the record's running chats ──────────────────────────

  async function resume() {
    const record = readRecord();
    if (!record) return [];
    const out = [];
    for (const c of record.chats || []) {
      if (c.desired !== 'running') continue;
      out.push(enqueue(c.chat_id, async () => {
        const now = readRecord();
        const entry = now && (now.chats || []).find((x) => x.chat_id === c.chat_id);
        if (!entry || entry.desired !== 'running') return { chat_id: c.chat_id, rev: entry ? entry.rev : 0, ignored: true };
        let o;
        if (entry.scope_kind === 'folder' && !(now.folders || []).some((f) => f.id === entry.folder_id)) {
          o = refused(entry.chat_id, entry.rev, 'folder-withdrawn');
        } else if (!hasWebChatDir(entry.root)) {
          o = refused(entry.chat_id, entry.rev, 'init-needed');
        } else {
          o = await runChat(entry);
        }
        mem(entry.chat_id).outcome = o;
        note(o);
        return o;
      }));
    }
    return Promise.all(out);
  }

  // ── what other modules read ──────────────────────────────────────────────

  function originsOf(chatId) {
    const m = memory.get(chatId);
    return m && m.origins ? m.origins : null;
  }

  function statusOf(chatId) {
    const m = memory.get(chatId);
    if (!m || !m.outcome) return null;
    const record = readRecord();
    return withSession({ ...m.outcome }, m.agent, record ? record.settings : null);
  }

  const api = { apply, originsOf, statusOf, resume };

  // CONNECTOR@install-seam: the run context holds one chats module. Nothing is
  // registered on the link here; U790 wires chat.assign to apply.
  function install(ctx) {
    if (!ctx || typeof ctx !== 'object') throw new TypeError('install: a context object is required');
    if (ctx.chats && ctx.chats !== api) throw new Error('install: chats are already installed');
    ctx.chats = api;
    return () => { if (ctx.chats === api) delete ctx.chats; };
  }
  api.install = install;

  return api;
}

module.exports = {
  createChats,
  assignmentProblem,
  INIT_FLAGS,
  CLONE_TIMEOUT_MS,
  OTHER_CODES,
  attachDetail,
};
