// Synthetic transcripts of rewinds (spec §15.4), and the hook envelopes that go
// with them, for the chat mirror's tests: the rewinds source's own
// (test/mirror-rewinds.test.js), U40's end-to-end check and U37's stream tests.
//
// Built on test-support/claude-records.js (U25): seeded and deterministic, every
// value fake. Each builder returns a FIXTURE:
//
//   {
//     name,                 'branch' | 'reset' | 'compaction' | 'resume' | 'anchor' | 'leaf-named'
//     sessionId,            the session the records belong to
//     r,                    the claude-records builder (r.records is the file)
//     records,              r.records
//     hooks,                [{event, ts, ...fields}] in time order: the hook
//                           envelopes' own fields; `envelope(hook, base)` makes
//                           the v1 envelope a hook tap publishes
//     turns,                the turn ids (the promptIds), in file order
//     lastOf,               {turn id: the uuid of its last chain record} — the
//                           leafUuid a rewind to the NEXT turn's prompt names
//     expect: {
//       reason,             'branch' | 'reset' | 'anchor' | null (no rewind)
//       superseded,         the turn ids the rewind abandons
//       live,               the turn ids it does not
//       open,               the turn id left open, or null
//     },
//   }
//
// THE CLOCK. Records start at `start` (default 2026-10-04T12:00:00Z) and step
// `step` ms (default 10). The first hook is a SessionStart 1 s BEFORE the first
// record, so it never falls between two turn_durations; a builder adds its
// later hooks at the record clock. Pass `hooks: false` for a fixture with no
// hook at all (the session is then found by its transcript alone).
//
// THE BUILDERS (every option has a default):
//
//   branch({seed, sessionId, start, step})                       — §15.4 (a)
//     three closed turns, then a prompt whose parentUuid is the first turn's
//     last record (r.branchFrom): the turn machine supersedes turns 2–3 under a
//     'branch' notice; turn 4 stays live.
//
//   reset({drop, firstTurnRecords, ...})                          — §15.4 (b)
//     the first turn carries the first-turn append (FIRST_TURN_KINDS, all six);
//     three closed turns with messageCount 4, 8, 12; then, with no SessionStart
//     between, a fourth prompt whose turn re-sends `firstTurnRecords` first-turn
//     attachments (default 6, cycling the kinds) and closes with messageCount
//     12 − `drop` (default 8, i.e. 4). Turns 1–3 are abandoned under one 'reset'
//     notice when drop ≥ RESET_MIN_COUNT_DROP and firstTurnRecords ≥
//     RESET_MIN_FIRST_TURN_RECORDS (lib/server/mirror/rewinds.js); `expect` is
//     computed from those constants.
//
//   compaction({...})                                              — §15.4 (b′)
//     as reset, but a compact_boundary (and its summary) comes before the fourth
//     prompt, and the attachments are re-sent with a lower messageCount: NOT a
//     reset. No SessionStart is sent for the compaction (pass
//     `compactStart: true` to add the 'compact' one Claude Code sends), so the
//     compaction alone keeps it from reading as one.
//
//   resume({countAfter, ...})                                      — §15.4 (b″)
//     three closed turns, then a SessionStart with session.source 'resume' and,
//     appended to the same file, the first-turn append and a fourth turn. Its
//     messageCount defaults to LOWER than before (`countAfter` 5): the worst
//     case, since whether a resume lowers it at all is gate V37, which the
//     maintainer has not run — the SessionStart is what keeps it from reading
//     as a reset. NOT a reset.
//
//   anchor({form, next, branch, open, ...})                        — §15.4 (c)
//     three turns, then a last-prompt record:
//       form 'rewound'  {rewound: true, leafUuid: turn 1's last record}
//       form 'earlier'  {leafUuid: turn 1's last record} (no rewound field)
//       form 'null'     {leafUuid: null} (a rewind to the first prompt)
//     `next` (default true) adds the prompt that rewound (a fourth turn) after
//     the evidence, continuing the chain from its leaf; `branch: true` makes
//     that prompt's parent the anchor instead (an anchor that is also a branch:
//     ONE notice, whichever reason came first). `open: true` leaves the third
//     turn open (no turn_duration) and adds no fourth: with form 'rewound' or
//     'earlier' the leaf is turn 2's last record, so the only turn after the
//     anchor is the open one and nothing may be superseded; with form 'null'
//     turns 1–2 are abandoned and the open turn 3 is not. Otherwise expect
//     'anchor' (or 'branch' with `branch: true`), turns 2–3 abandoned (1–3 for
//     'null').
//
//   leafNamed({mid, ...})                                          — §15.4 (c′)
//     three closed turns, then a last-prompt naming the chain's leaf (the
//     normalizer emits no evidence), or with `mid: true` a record of the
//     newest turn (evidence that finds no turn after it): no rewind.
//
//   envelope(hook, {sessionId, transcriptPath, cwd})   the v1 envelope (§1.3)
//   FIRST_TURN_APPEND                                  the six kinds, in order

const { createRecords } = require('./claude-records');
const {
  FIRST_TURN_KINDS, RESET_MIN_COUNT_DROP, RESET_MIN_FIRST_TURN_RECORDS,
} = require('../lib/server/mirror/rewinds');

const DEFAULT_START = Date.UTC(2026, 9, 4, 12, 0, 0);
const DEFAULT_SESSION = '7e3a1c55-0b1d-4c2e-9f60-5a1b2c3d4e5f';
const FIRST_TURN_APPEND = FIRST_TURN_KINDS;

// One first-turn attachment of `kind` (a kind of FIRST_TURN_KINDS).
function appendOne(r, kind) {
  const type = kind.slice('attachment/'.length);
  switch (type) {
    case 'skill_listing': return r.skillListing({ isInitial: true });
    case 'model': return r.attachment('model', { model: 'claude-opus-5-5' });
    case 'environment': return r.attachment('environment', { platform: 'darwin', shell: 'zsh', cwd: '/tmp/project' });
    case 'deferred_tools_delta': return r.attachment('deferred_tools_delta', { added: ['WebFetch', 'WebSearch'], removed: [] });
    case 'agent_listing_delta': return r.attachment('agent_listing_delta', { added: ['general-purpose'], removed: [] });
    case 'mcp_instructions_delta': return r.attachment('mcp_instructions_delta', { added: ['web-chat'], removed: [] });
    default: return r.attachment(type, {});
  }
}

// `n` first-turn attachments, cycling the kinds from the first.
function firstTurnAppend(r, n = FIRST_TURN_KINDS.length) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(appendOne(r, FIRST_TURN_KINDS[i % FIRST_TURN_KINDS.length]));
  return out;
}

// A turn: its prompt, any attachments, a reply and (unless open) its
// turn_duration. Returns {id, prompt, last} — `last` the turn's last chain uuid.
function turn(r, id, { count, attachments = 0, open = false, promptExtra } = {}) {
  const prompt = r.prompt(`prompt ${id}`, { promptId: id, extra: promptExtra });
  if (attachments) firstTurnAppend(r, attachments);
  r.assistant([`reply to ${id}`]);
  if (!open) r.turnDuration({ durationMs: 40, messageCount: count });
  return { id, prompt, last: r.leaf };
}

const clockOf = (r) => {
  for (let i = r.records.length - 1; i >= 0; i--) {
    const t = Date.parse(r.records[i].timestamp);
    if (Number.isFinite(t)) return t;
  }
  return null;
};

function base({ seed = 78, sessionId = DEFAULT_SESSION, start = DEFAULT_START, step = 10, cwd = '/tmp/project', hooks = true } = {}) {
  const r = createRecords({ seed, sessionId, cwd, start, step });
  const list = hooks ? [{ event: 'SessionStart', ts: start - 1000, session: { source: 'startup' } }] : [];
  return { r, hooks: list };
}

// Three closed turns, the first with the first-turn append: counts 4, 8, 12.
function threeTurns(r, { openThird = false } = {}) {
  const t1 = turn(r, 'rw-1', { count: 4, attachments: FIRST_TURN_KINDS.length });
  const t2 = turn(r, 'rw-2', { count: 8 });
  const t3 = turn(r, 'rw-3', { count: 12, open: openThird });
  return [t1, t2, t3];
}

// The last chain record of each turn: the records from its prompt up to the
// next turn's prompt (or the end of the file).
function lastsOf(r, turns) {
  const out = {};
  let cur = null;
  for (const rec of r.records) {
    if (typeof rec.promptId === 'string' && turns.includes(rec.promptId)) cur = rec.promptId;
    if (cur && typeof rec.uuid === 'string') out[cur] = rec.uuid;
  }
  return out;
}

function fixture(name, b, turns, expect) {
  return {
    name, sessionId: b.r.sessionId, r: b.r, records: b.r.records, hooks: b.hooks, turns, lastOf: lastsOf(b.r, turns), expect,
  };
}

function branch(opts = {}) {
  const b = base(opts);
  const [t1, t2, t3] = threeTurns(b.r);
  b.r.branchFrom(t1.last);
  const t4 = turn(b.r, 'rw-4', { count: 6 });
  return fixture('branch', b, [t1.id, t2.id, t3.id, t4.id],
    { reason: 'branch', superseded: [t2.id, t3.id], live: [t1.id, t4.id], open: null });
}

function reset({ drop = 8, firstTurnRecords = FIRST_TURN_KINDS.length, ...opts } = {}) {
  const b = base(opts);
  const [t1, t2, t3] = threeTurns(b.r);
  const t4 = turn(b.r, 'rw-4', { count: 12 - drop, attachments: firstTurnRecords });
  const ids = [t1.id, t2.id, t3.id, t4.id];
  const fires = drop >= RESET_MIN_COUNT_DROP && firstTurnRecords >= RESET_MIN_FIRST_TURN_RECORDS;
  return fixture('reset', b, ids, fires
    ? { reason: 'reset', superseded: [t1.id, t2.id, t3.id], live: [t4.id], open: null }
    : { reason: null, superseded: [], live: ids, open: null });
}

function compaction({ compactStart = false, ...opts } = {}) {
  const b = base(opts);
  const [t1, t2, t3] = threeTurns(b.r);
  b.r.tick(1000);
  if (compactStart && b.hooks.length) b.hooks.push({ event: 'SessionStart', ts: clockOf(b.r) + 1, session: { source: 'compact' } });
  b.r.compactBoundary({ trigger: 'auto', preTokens: 150000, postTokens: 12000 });
  b.r.compactSummary();
  firstTurnAppend(b.r);
  const t4 = turn(b.r, 'rw-4', { count: 3 });
  const ids = [t1.id, t2.id, t3.id, t4.id];
  return fixture('compaction', b, ids, { reason: null, superseded: [], live: ids, open: null });
}

function resume({ countAfter = 5, ...opts } = {}) {
  const b = base(opts);
  const [t1, t2, t3] = threeTurns(b.r);
  b.r.tick(60000);
  if (b.hooks.length) b.hooks.push({ event: 'SessionStart', ts: clockOf(b.r) + 30000, session: { source: 'resume' } });
  const t4 = turn(b.r, 'rw-4', { count: countAfter, attachments: FIRST_TURN_KINDS.length });
  const ids = [t1.id, t2.id, t3.id, t4.id];
  return fixture('resume', b, ids, { reason: null, superseded: [], live: ids, open: null });
}

function anchor({ form = 'rewound', next = true, branch: asBranch = false, open = false, ...opts } = {}) {
  if (!['rewound', 'earlier', 'null'].includes(form)) throw new Error(`anchor: form is rewound, earlier or null (got ${form})`);
  const b = base(opts);
  const [t1, t2, t3] = threeTurns(b.r, { openThird: open });
  const leaf = form === 'null' ? null : open ? t2.last : t1.last;
  b.r.lastPrompt({ leafUuid: leaf, ...(form === 'rewound' ? { rewound: true } : {}) });
  const ids = [t1.id, t2.id, t3.id];
  let t4 = null;
  if (next && !open) {
    if (asBranch && leaf) b.r.branchFrom(leaf);
    t4 = turn(b.r, 'rw-4', { count: 2, promptExtra: asBranch && !leaf ? { parentUuid: null } : undefined });
    ids.push(t4.id);
  }
  if (open && leaf) return fixture('anchor', b, ids, { reason: null, superseded: [], live: ids, open: t3.id });
  if (open) return fixture('anchor', b, ids, { reason: 'anchor', superseded: [t1.id, t2.id], live: [t3.id], open: t3.id });
  const abandoned = form === 'null' ? [t1.id, t2.id, t3.id] : [t2.id, t3.id];
  return fixture('anchor', b, ids, {
    reason: asBranch && t4 ? 'branch' : 'anchor', superseded: abandoned,
    live: ids.filter((id) => !abandoned.includes(id)), open: null,
  });
}

function leafNamed({ mid = false, ...opts } = {}) {
  const b = base(opts);
  const [t1, t2, t3] = threeTurns(b.r);
  b.r.lastPrompt(mid ? { leafUuid: t3.prompt.uuid } : {});
  const ids = [t1.id, t2.id, t3.id];
  return fixture('leaf-named', b, ids, { reason: null, superseded: [], live: ids, open: null });
}

// The v1 envelope a hook tap publishes for one of a fixture's hooks.
function envelope(hook, { sessionId, transcriptPath, cwd }) {
  return {
    v: 1, event: hook.event, ts: hook.ts, session_id: sessionId, transcript_path: transcriptPath, cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: null, compact: null, stop: null, prompt: null, ask: null,
    ...Object.fromEntries(Object.entries(hook).filter(([k]) => k !== 'event' && k !== 'ts')),
  };
}

module.exports = {
  branch,
  reset,
  compaction,
  resume,
  anchor,
  leafNamed,
  envelope,
  firstTurnAppend,
  FIRST_TURN_APPEND,
  DEFAULT_SESSION,
};
