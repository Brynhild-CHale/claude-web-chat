// lib/server/control/fork.js — "Fork from here" (spec §15.6, first paragraph;
// design/chat-mirror-control.md C-CONV-2, its fork-only row; Q-E: copying the
// command is the default, and without a mod the only way).
//
//   installFork(control, {mirror, graph, root, runClaudeAsync, findClaude, bus,
//                         now, log}) → {features(), unregister(), forkTurn(turn_id)}
//   forkArgv({label, sessionId, parentUuid}) → argv          pure; throws
//
// It adds ONE row, 'fork', to the control domain's action table (U81,
// lib/server/control/index.js) — never by editing that table:
//
//   fields ['turn_id']            the POST body, exactly
//   params {turn} | {turn_id}     the document's query names the turn `turn`
//                                 (U86 mounts {action: 'fork', params: {turn}});
//                                 the body names it `turn_id` → {turn_id}
//   key                           the turn id (binds the frame's nonce)
//   layouts ['confirm'], limit {scope: 'project', ms: 5000} (§15.5)
//   describe → {title: 'Fork from here', summary: 'Fork this conversation from
//              before turn <label>. The original is kept; no files are
//              restored; no cost.'}, <label> the turn's node label
//              (lib/server/domain/refs, as the chrome's labelFor) or its time
//   check   → the anchor, mirror.forkAnchor(turn) (§2.12, the transcripts
//              source): 'unknown', 'superseded' and 'first' refuse with a hint,
//              an unavailable source 'no-transcripts'; then findClaude() null
//              → 'claude-missing'. A refusal spawns nothing.
//   run     → runClaudeAsync(forkArgv(...), {cwd: root, timeoutMs: 30000}):
//
//     claude -p '/rename fork of <label>' --resume <sid>
//            --resume-session-at <parent uuid> --fork-session
//            --output-format json            (stdin /dev/null, env scrubbed)
//
//     a fixed argv whose only variable parts are two ids (UUID grammar) and
//     web-chat's own label (`fork of n1.12`), never user text; /rename, never
//     /cost (/cost copies the source's cost-state and writes usage analytics).
//     The JSON stdout's session_id (UUID grammar, not the source's) →
//     {ok: true, session_id, command: 'claude --resume <id>'}; anything else →
//     {ok: false, refused: 'fork-failed', hint}. stderr is never returned, logged
//     or audited (it may echo text).
//
// The answer reaches the user inside the confirm frame (U85: the command with
// Copy), never through the chrome. Every run that spawned emits ONE control
// event {kind: 'control', op: 'fork', id, conversation_id, session_id (the
// source's), outcome: 'forked' | 'failed'} through `bus` — content-free, never
// the command — and the control domain's invoke() writes the one audit line
// (its target is {turn_id}: ids only).
//
// features() → {ok: true} | {ok: false, reason: 'no-transcripts' |
// 'claude-missing'} — synchronous (the control domain's features() reads it),
// findClaude memoised for 60 s.
//
// forkTurn(turn_id) → Promise<{ok: true, session_id, label} | {ok: false,
// refused, hint}> is the row's own path — check() then run()'s body, the same
// argv, timeout, env scrub, parse and control event — for the in-place resume
// (tranche 6, U89, lib/server/control/mod.js; ruling F6, Q-B4 (a)), which forks
// and then switches the terminal behind ONE confirm. It answers the new
// session id to the daemon only; the chrome never receives it (B-confirm (4)).
//
// Not here: the in-place resume and its 'resume' row (tranche 6, U89, behind
// WEB_CHAT_REWIND_IN_PLACE), any code restore (§15.3), any route on the main
// origin, any chrome.

const crypto = require('crypto');
const { isSafeId } = require('../../core/paths');
const { runClaudeAsync: defaultRunClaudeAsync, findClaude: defaultFindClaude } = require('../../core/claude-cli');
const { resolveNodeRef } = require('../domain/refs');
const { BadTarget } = require('./index');

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// web-chat's own label, never user text: 'fork of ' and 1–48 characters of
// letters, digits, '.', ':', ' ' and '-' (a node label, a time).
const LABEL_RE = /^fork of [A-Za-z0-9.: -]{1,48}$/;
const LABEL_TAIL_RE = /^[A-Za-z0-9.: -]{1,48}$/;
const FORK_TIMEOUT_MS = 30_000;
const FORK_LIMIT_MS = 5000;
const FIND_MEMO_MS = 60_000;

const HINTS = Object.freeze({
  unknown: 'the turn is not in this conversation\'s transcript',
  superseded: 'that turn was rewound away; fork from a turn that is still in the conversation',
  first: 'nothing comes before the first turn: start a new session instead',
  'no-transcripts': 'this conversation\'s transcript cannot be read here',
  'claude-missing': 'Claude Code\'s `claude` was not found (not on PATH, in ~/.local/bin or in ~/.claude/local): install Claude Code, or fork in the terminal',
  'fork-failed': 'the fork did not answer a session; try again, or fork in the terminal',
});

// forkAnchor's own refusals (§2.12); anything else it answers reads as unknown.
const ANCHOR_REFUSALS = Object.freeze(['unknown', 'superseded', 'first']);

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function forkArgv({ label, sessionId, parentUuid } = {}) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) throw new TypeError('forkArgv: sessionId is not a UUID');
  if (typeof parentUuid !== 'string' || !UUID_RE.test(parentUuid)) throw new TypeError('forkArgv: parentUuid is not a UUID');
  if (typeof label !== 'string' || !LABEL_RE.test(label)) throw new TypeError('forkArgv: label is not web-chat\'s own');
  return [
    '-p', `/rename ${label}`,
    '--resume', sessionId,
    '--resume-session-at', parentUuid,
    '--fork-session',
    '--output-format', 'json',
  ];
}

// A time as a label: the daemon's local 'YYYY-MM-DD HH:MM'.
function timeLabel(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// The new session id out of `--output-format json`'s stdout, or null.
function sessionOf(stdout, sourceSession) {
  let v = null;
  try { v = JSON.parse(String(stdout || '').trim()); } catch { return null; }
  const sid = isPlain(v) ? v.session_id : null;
  if (typeof sid !== 'string' || !UUID_RE.test(sid)) return null;
  // A "fork" that answers its own source made nothing new.
  if (sid.toLowerCase() === String(sourceSession).toLowerCase()) return null;
  return sid;
}

function installFork(control, {
  mirror = null,
  graph = null,
  root,
  runClaudeAsync = defaultRunClaudeAsync,
  findClaude = defaultFindClaude,
  bus = null,
  now = Date.now,
  log = () => {},
} = {}) {
  if (!control || typeof control.action !== 'function') throw new TypeError('installFork needs the control domain');
  if (typeof root !== 'string' || !root) throw new TypeError('installFork needs root');
  const say = (m) => { try { log(m); } catch { /* a logger never breaks a fork */ } };
  // What check() resolved, for run() on the same target object (invoke hands
  // both the one target): the anchor and the claude to run.
  const checked = new WeakMap();
  let memo = null; // {at, bin}

  function claudeBin({ fresh = false } = {}) {
    const t = now();
    if (!fresh && memo && t - memo.at < FIND_MEMO_MS) return memo.bin;
    let bin = null;
    try { bin = findClaude() || null; } catch { bin = null; }
    memo = { at: t, bin };
    return bin;
  }

  function transcriptsReadable() {
    if (!mirror || typeof mirror.forkAnchor !== 'function') return false;
    if (typeof mirror.stats === 'function') {
      let s = null;
      try { s = mirror.stats(); } catch { return false; }
      if (isPlain(s)) {
        if (s.stopped === true || s.enabled === false) return false;
        if (Array.isArray(s.sources) && !s.sources.some((x) => isPlain(x) && x.name === 'transcripts')) return false;
      }
    }
    return true;
  }

  // The turn's header (conversation and node), or null.
  async function headerOf(turnId) {
    if (!mirror || typeof mirror.turn !== 'function') return null;
    let r = null;
    try { r = await mirror.turn(turnId); } catch { r = null; }
    return isPlain(r) && isPlain(r.turn) ? r.turn : null;
  }

  // The turn's node label (lib/server/domain/refs, as the chrome's labelFor
  // reads it), else its time, else a plain phrase — always within LABEL_RE.
  function labelOf(header) {
    const node = header && isPlain(header.node) ? header.node : null;
    if (node && typeof node.id === 'string' && node.id) {
      let label = null;
      if (graph) {
        try {
          const r = resolveNodeRef(graph, node.id, { allowLive: false });
          if (r && r.ok && typeof r.label === 'string') label = r.label;
        } catch { label = null; }
      }
      if (!label && typeof node.label === 'string') label = node.label;
      if (label && LABEL_TAIL_RE.test(label)) return label;
    }
    const at = timeLabel(header && header.started_at);
    if (at) return at;
    return 'an earlier turn';
  }

  function emit(event) {
    if (!bus || typeof bus.emit !== 'function') return;
    try { bus.emit({ event }); } catch (e) { say(`control: fork event failed (${e && e.code || 'error'})`); }
  }

  function params(source) {
    const s = isPlain(source) ? source : {};
    const a = s.turn_id;
    const b = s.turn;
    if (a !== undefined && b !== undefined && a !== b) throw new BadTarget('turn and turn_id differ');
    const id = a !== undefined ? a : b;
    if (!isSafeId(id)) throw new BadTarget('turn: a turn id');
    return { turn_id: id };
  }

  async function describe(target) {
    const header = await headerOf(target.turn_id);
    return {
      title: 'Fork from here',
      summary: `Fork this conversation from before turn ${labelOf(header)}. The original is kept; no files are restored; no cost.`,
    };
  }

  const refuse = (code) => ({ refused: code, hint: HINTS[code] });

  async function check(target) {
    if (!transcriptsReadable()) return refuse('no-transcripts');
    let anchor = null;
    try { anchor = await mirror.forkAnchor(target.turn_id); } catch { anchor = null; }
    if (!isPlain(anchor)) return refuse('unknown');
    if (anchor.unavailable === true) return refuse('no-transcripts');
    if (anchor.refused !== undefined) return refuse(ANCHOR_REFUSALS.includes(anchor.refused) ? anchor.refused : 'unknown');
    if (!UUID_RE.test(String(anchor.session_id)) || !UUID_RE.test(String(anchor.parent_uuid))) return refuse('unknown');
    const bin = claudeBin({ fresh: true });
    if (!bin) return refuse('claude-missing');
    checked.set(target, { anchor: { session_id: anchor.session_id, parent_uuid: anchor.parent_uuid }, bin });
    return null;
  }

  // run()'s body: the fork itself, for a target check() resolved.
  // → {ok: true, session_id, label} | {ok: false, refused, hint}
  async function forkChecked(target) {
    let c = checked.get(target);
    checked.delete(target);
    if (!c) {
      // Called without its check (a direct run): resolve again.
      const r = await check(target);
      if (r) return { ok: false, ...r };
      c = checked.get(target);
      checked.delete(target);
    }
    const header = await headerOf(target.turn_id);
    const label = `fork of ${labelOf(header)}`;
    const argv = forkArgv({ label, sessionId: c.anchor.session_id, parentUuid: c.anchor.parent_uuid });
    const t = now();
    const id = `fk_${Math.max(0, Math.floor(t)).toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    const conversationId = header && typeof header.conversation_id === 'string' ? header.conversation_id : null;
    let r = null;
    try { r = await runClaudeAsync(argv, { cwd: root, bin: c.bin, timeoutMs: FORK_TIMEOUT_MS }); } catch { r = null; }
    const sid = isPlain(r) && r.ok === true ? sessionOf(r.stdout, c.anchor.session_id) : null;
    emit({ kind: 'control', op: 'fork', id, conversation_id: conversationId, session_id: c.anchor.session_id, outcome: sid ? 'forked' : 'failed' });
    if (!sid) {
      // Never stderr: it may echo text. Only what kind of failure it was.
      const why = !isPlain(r) ? 'error' : r.ok ? 'no-session' : r.timedOut ? 'timeout' : r.notFound ? 'not-found' : 'exit';
      say(`control: fork failed (${why})`);
      return { ok: false, ...refuse('fork-failed') };
    }
    return { ok: true, session_id: sid, label };
  }

  async function run(target) {
    const r = await forkChecked(target);
    if (!r.ok) return r;
    return { ok: true, session_id: r.session_id, command: `claude --resume ${r.session_id}` };
  }

  // The one fork path, by turn id (ruling F6, Q-B4 (a)).
  async function forkTurn(turnId) {
    let target;
    try { target = params({ turn_id: turnId }); } catch { return { ok: false, refused: 'bad-target', hint: 'the request names no valid turn' }; }
    return forkChecked(target);
  }

  function features() {
    if (!transcriptsReadable()) return { ok: false, reason: 'no-transcripts' };
    if (!claudeBin()) return { ok: false, reason: 'claude-missing' };
    return { ok: true };
  }

  const unregister = control.action('fork', {
    fields: ['turn_id'],
    layouts: ['confirm'],
    limit: { scope: 'project', ms: FORK_LIMIT_MS },
    params,
    key: (target) => target.turn_id,
    describe,
    check,
    run,
    features,
  });

  return { features, unregister, forkTurn };
}

module.exports = { installFork, forkArgv, UUID_RE, LABEL_RE, FORK_TIMEOUT_MS, FORK_LIMIT_MS, HINTS };
