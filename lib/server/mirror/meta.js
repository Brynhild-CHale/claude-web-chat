// lib/server/mirror/meta.js — the meta fold: a conversation's title, model,
// modes, token count, cost, away summary and skills, folded from its transcript
// records and the hook envelopes (spec §2.5 "Meta, skills and cost", §2.10's
// Conversation shape).
//
//   initialMeta()                              → state
//   foldMeta(state, recs, {sessionName})       → {state, patch|null, title|null, known: [{value, label}]}
//   foldEnvelope(state, env)                   → {state, patch|null}
//
// `recs` are the tailer's records (`{obj, start, end, …}`, lib/server/mirror/
// tail.js); a record with no `obj` is skipped. Each is routed by U25's record
// table (records.js): a row with `meta: true` is read here, a row with `known`
// hands back its value, everything else is skipped — except the conversation's
// first `user/prompt` / `user/prompt+image`, which the title's last fallback
// reads (an opener row: the table routes it to the normalizer, and no row can
// say "only the first one").
//
// THE STATE is plain JSON: the transcripts source (U28a) persists it into the
// session's index file (§2.11) and hands it back after a restart. So it holds no
// Map, no Set, no function, and NO KNOWN VALUE: the organisation id
// (credential_org) and the account email (session_context, context.userEmail —
// the only field registered as the account email, ruling U27@account-email) are
// returned in `known` and never kept. The caller registers each with
// `redactor.addKnown(value, label)` BEFORE it applies the same batch, and keeps
// the newest org id in process for the skills catalog (§6.2). A fold never
// mutates the state it is given; it returns a new one.
//
//   title       the last `ai-title`, else the last `agent-name`, else the
//               sessions file's name (`sessionName`, the registry's view, passed
//               in on every fold), else the first prompt's first 60 characters.
//               The state keeps the title it last derived, so a change of
//               `sessionName` alone is a change.
//   model       the latest assistant `message.model` (a `<synthetic>` one — an
//               error notice Claude Code writes itself — is no model), or an
//               `attachment/model`'s `identity.modelId`; a SessionStart
//               envelope's `session.model` (foldEnvelope).
//   permission_mode, mode, effort
//               last value wins: `permission-mode` and `mode` (the uuid-less
//               records, V1), the assistant record's `effort`; any envelope's
//               `permission_mode` (foldEnvelope, a subagent's fire excluded).
//               The plan / auto / ultra-effort attachments are meta rows for
//               their mode NOTICES, which are the normalizer's; their payloads
//               name no mode value this fold could keep.
//   tokens      summed from `message.usage` once per `message.id`. Claude Code
//               writes one record per content block and copies `usage` onto each
//               (a subagent file's per-block usage grows as the message streams,
//               V1), so a message counts with the LATEST usage seen for its id:
//               a later block replaces its earlier contribution. The state keeps
//               the last COUNTED_MAX message ids and their contributions.
//   cost        `cost-state` is written only at exit (V1), so `usd` is null
//               while the session lives and `source` is null with it; a
//               `cost-state` record sets `usd` (totalCostUSD) and source
//               'cost-state'.
//   away        the latest `system/away_summary`, `{text, at}`.
//   skills      `attachment/skill_listing`, folded per conversation (V8): an
//               initial listing (`isInitial: true`) puts its names first, in its
//               order; a delta appends the names it adds; NOTHING IS EVER
//               REMOVED — a later initial with fewer names keeps the rest.
//               Descriptions are parsed from the listing's `content` (one
//               `- <name>: <description>` line per skill). In the state as
//               `skills: {names, descriptions}`; the index keeps exactly that.
//
// `patch` is model.upsertConversation's shape — {title, model, permission_mode,
// mode, effort, cost: {usd, source, tokens}, away} — or null when the fold
// changed none of it. A field with no value yet is left out (upsertConversation
// keeps a field the patch omits), so a fold never blanks what another writer
// set. `title` is the title when this fold changed it, else null.
//
// U10's hand-off 3 is applied in the transcripts source (U28a), not here: it
// calls `engine.conversations.noteTitle(cid, title)` with this fold's `title`
// output, so a title survives a restart, and `engine.live.noteActivity` on
// appends. This module calls nothing.
//
// Pure: no I/O, no clock, no timers. Dependency direction: lib/core and the
// mirror's own records.js.

const { kindOf, rowOf } = require('./records');
const { stableKey } = require('../../core/stable-json');

const STATE_VERSION = 1;
const TITLE_PROMPT_CHARS = 60;
const TITLE_MAX = 300;          // model.js CONVERSATION_CAPS.title
const AWAY_MAX = 2048;          // model.js CONVERSATION_CAPS['away.text']
const WORD_MAX = 100;           // a model id, a mode, an effort
const COUNTED_MAX = 512;        // message ids whose usage is remembered
const SKILLS_MAX = 1000;
const SKILL_NAME_MAX = 200;
const SKILL_DESCRIPTION_MAX = 1024;

const KNOWN_LABELS = Object.freeze(['org-id', 'account-email']);

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : null);
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

// At most `max` characters (code points: never half a surrogate pair).
function cut(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

function word(v) {
  const s = str(v);
  if (!s) return null;
  const t = s.trim();
  return t ? cut(t, WORD_MAX) : null;
}

function tsOf(rec) {
  const t = Date.parse(rec && rec.timestamp);
  return Number.isFinite(t) ? t : null;
}

function initialMeta() {
  return {
    v: STATE_VERSION,
    title: null,
    ai_title: null,
    agent_name: null,
    first_prompt: null,
    model: null,
    permission_mode: null,
    mode: null,
    effort: null,
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
    counted: [],              // [[message_id, {input, output, cache_read, cache_creation}], …] oldest first
    cost: { usd: null, source: null },
    away: null,
    skills: { names: [], descriptions: {} },
  };
}

// A persisted state comes back through JSON; anything malformed is replaced by
// its initial value rather than trusted.
function adopt(state) {
  const base = initialMeta();
  if (!isPlain(state) || state.v !== STATE_VERSION) return base;
  const out = { ...base };
  for (const k of ['title', 'ai_title', 'agent_name', 'first_prompt', 'model', 'permission_mode', 'mode', 'effort']) {
    out[k] = str(state[k]);
  }
  const tk = isPlain(state.tokens) ? state.tokens : {};
  out.tokens = { input: count(tk.input), output: count(tk.output), cache_read: count(tk.cache_read),
    cache_creation: count(tk.cache_creation) };
  out.counted = Array.isArray(state.counted)
    ? state.counted.filter((e) => Array.isArray(e) && typeof e[0] === 'string' && isPlain(e[1]))
      .map(([id, u]) => [id, usageOf(u, true)])
    : [];
  const c = isPlain(state.cost) ? state.cost : {};
  out.cost = Number.isFinite(c.usd) ? { usd: c.usd, source: 'cost-state' } : { usd: null, source: null };
  const a = isPlain(state.away) ? state.away : null;
  out.away = a && typeof a.text === 'string' ? { text: a.text, at: Number.isFinite(a.at) ? a.at : null } : null;
  const sk = isPlain(state.skills) ? state.skills : {};
  const names = Array.isArray(sk.names) ? sk.names.filter((n) => typeof n === 'string') : [];
  const desc = isPlain(sk.descriptions) ? sk.descriptions : {};
  out.skills = {
    names: [...names],
    descriptions: Object.fromEntries(names.filter((n) => Object.hasOwn(desc, n) && typeof desc[n] === 'string')
      .map((n) => [n, desc[n]])),
  };
  return out;
}

// ── tokens ──────────────────────────────────────────────────────────────────

// `usage` → our four counters. `ours` reads a state entry back (our names).
function usageOf(u, ours = false) {
  if (!isPlain(u)) return { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  return ours
    ? { input: count(u.input), output: count(u.output), cache_read: count(u.cache_read), cache_creation: count(u.cache_creation) }
    : {
      input: count(u.input_tokens),
      output: count(u.output_tokens),
      cache_read: count(u.cache_read_input_tokens),
      cache_creation: count(u.cache_creation_input_tokens),
    };
}

const TOKEN_KEYS = ['input', 'output', 'cache_read', 'cache_creation'];

function countUsage(s, messageId, usage) {
  const next = usageOf(usage);
  const at = s.counted.findIndex((e) => e[0] === messageId);
  const prev = at >= 0 ? s.counted[at][1] : null;
  if (prev && TOKEN_KEYS.every((k) => prev[k] === next[k])) return;
  for (const k of TOKEN_KEYS) s.tokens[k] = Math.max(0, s.tokens[k] + next[k] - (prev ? prev[k] : 0));
  if (at >= 0) s.counted.splice(at, 1);
  s.counted.push([messageId, next]);
  if (s.counted.length > COUNTED_MAX) s.counted.splice(0, s.counted.length - COUNTED_MAX);
}

// ── skills ──────────────────────────────────────────────────────────────────

// `- <name>: <description>` per line. A namespaced name (`plugin:skill`) holds a
// colon, so the name runs to the first ': ' (colon then space).
const SKILL_LINE_RE = /^- (\S+?): (.*)$/;

function parseDescriptions(content) {
  const out = new Map();
  if (typeof content !== 'string') return out;
  for (const line of content.split('\n')) {
    const m = SKILL_LINE_RE.exec(line);
    if (!m) continue;
    const name = cut(m[1], SKILL_NAME_MAX);
    const d = m[2].trim();
    if (d && !out.has(name)) out.set(name, cut(d, SKILL_DESCRIPTION_MAX));
  }
  return out;
}

function foldSkills(s, a) {
  const parsed = parseDescriptions(a.content);
  let listed = Array.isArray(a.names) ? a.names.filter((n) => typeof n === 'string' && n) : [...parsed.keys()];
  listed = [...new Set(listed.map((n) => cut(n, SKILL_NAME_MAX)))];
  const had = s.skills.names;
  const names = a.isInitial === true
    ? [...listed, ...had.filter((n) => !listed.includes(n))]       // the initial's order first; none removed
    : [...had, ...listed.filter((n) => !had.includes(n))];         // a delta adds
  const desc = new Map(Object.entries(s.skills.descriptions));
  for (const n of listed) if (parsed.has(n)) desc.set(n, parsed.get(n));
  const kept = names.slice(0, SKILLS_MAX);
  s.skills = {
    names: kept,
    descriptions: Object.fromEntries(kept.filter((n) => desc.has(n)).map((n) => [n, desc.get(n)])),
  };
}

// ── the title ───────────────────────────────────────────────────────────────

function promptText(rec) {
  const c = isPlain(rec.message) ? rec.message.content : undefined;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const b = c.find((x) => isPlain(x) && x.type === 'text' && typeof x.text === 'string');
    return b ? b.text : '';
  }
  return '';
}

function titleLine(s) {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return t || null;
}

function deriveTitle(s, sessionName) {
  const t = s.ai_title || s.agent_name || titleLine(sessionName) || s.first_prompt || null;
  return t ? cut(t, TITLE_MAX) : null;
}

// ── the patch ───────────────────────────────────────────────────────────────

function patchOf(s) {
  const p = {};
  if (s.title) p.title = s.title;
  if (s.model) p.model = s.model;
  if (s.permission_mode) p.permission_mode = s.permission_mode;
  if (s.mode) p.mode = s.mode;
  if (s.effort) p.effort = s.effort;
  p.cost = { usd: s.cost.usd, source: s.cost.source, tokens: { ...s.tokens } };
  if (s.away) p.away = { ...s.away };
  return p;
}

// A working copy the fold may mutate: every nested value the fold writes is
// copied, so the caller's state is never touched.
function working(state) {
  const s = adopt(state);
  return {
    ...s,
    tokens: { ...s.tokens },
    counted: s.counted.map(([id, u]) => [id, { ...u }]),
    cost: { ...s.cost },
    away: s.away ? { ...s.away } : null,
    skills: { names: [...s.skills.names], descriptions: { ...s.skills.descriptions } },
  };
}

function finish(before, s) {
  const changed = stableKey(patchOf(before)) !== stableKey(patchOf(s));
  return changed ? patchOf(s) : null;
}

// ── the folds ───────────────────────────────────────────────────────────────

function foldMeta(state, recs, { sessionName } = {}) {
  const before = adopt(state);
  const s = working(state);
  const known = [];
  const seenKnown = new Set();
  const learn = (value, label) => {
    if (typeof value !== 'string' || !value || !KNOWN_LABELS.includes(label)) return;
    const k = `${label}\u0000${value}`;
    if (seenKnown.has(k)) return;
    seenKnown.add(k);
    known.push({ value, label });
  };

  for (const r of Array.isArray(recs) ? recs : []) {
    const rec = r && isPlain(r.obj) ? r.obj : null;
    if (!rec) continue;
    const kind = kindOf(rec);
    const row = rowOf(kind);
    if (!row) continue;
    const a = isPlain(rec.attachment) ? rec.attachment : {};

    if (row.known === 'org-id') learn(str(a.organizationUuid), 'org-id');
    if (row.known === 'account-email') learn(isPlain(a.context) ? str(a.context.userEmail) : null, 'account-email');

    if ((kind === 'user/prompt' || kind === 'user/prompt+image') && !s.first_prompt && !rec.isMeta) {
      const line = titleLine(promptText(rec));
      if (line) s.first_prompt = cut(line, TITLE_PROMPT_CHARS);
      continue;
    }
    if (!row.meta) continue;

    switch (kind) {
      case 'ai-title': { const t = titleLine(rec.aiTitle); if (t) s.ai_title = cut(t, TITLE_MAX); break; }
      case 'agent-name': { const t = titleLine(rec.agentName); if (t) s.agent_name = cut(t, TITLE_MAX); break; }
      case 'mode': { const m = word(rec.mode); if (m) s.mode = m; break; }
      case 'permission-mode': { const m = word(rec.permissionMode); if (m) s.permission_mode = m; break; }
      case 'cost-state':
        if (Number.isFinite(rec.totalCostUSD) && rec.totalCostUSD >= 0) s.cost = { usd: rec.totalCostUSD, source: 'cost-state' };
        break;
      case 'system/away_summary': {
        const t = str(rec.content);
        if (t && t.trim()) s.away = { text: cut(t.trim(), AWAY_MAX), at: tsOf(rec) };
        break;
      }
      case 'attachment/skill_listing': foldSkills(s, a); break;
      case 'attachment/model': {
        const m = word(isPlain(a.identity) ? a.identity.modelId : null);
        if (m) s.model = m;
        break;
      }
      case 'assistant': {
        const msg = isPlain(rec.message) ? rec.message : {};
        const m = word(msg.model);
        if (m && !m.startsWith('<')) s.model = m;
        const e = word(rec.effort);
        if (e) s.effort = e;
        if (typeof msg.id === 'string' && msg.id && isPlain(msg.usage)) countUsage(s, msg.id, msg.usage);
        break;
      }
      default: break;   // the mode-notice attachments: their notices are the normalizer's
    }
  }

  const title = deriveTitle(s, sessionName);
  s.title = title;
  return { state: s, patch: finish(before, s), title: title && title !== before.title ? title : null, known };
}

// A hook envelope (envelope v1, lib/hooks/envelope.js): a SessionStart's
// `session.model`, and any main-thread envelope's `permission_mode`.
function foldEnvelope(state, env) {
  const before = adopt(state);
  const s = working(state);
  if (isPlain(env) && !env.agent) {
    const pm = word(env.permission_mode);
    if (pm) s.permission_mode = pm;
    if (env.event === 'SessionStart' && isPlain(env.session)) {
      const m = word(env.session.model);
      if (m) s.model = m;
    }
  }
  return { state: s, patch: finish(before, s) };
}

module.exports = {
  initialMeta,
  foldMeta,
  foldEnvelope,
  parseDescriptions,
  STATE_VERSION,
  TITLE_PROMPT_CHARS,
  COUNTED_MAX,
  SKILLS_MAX,
};
