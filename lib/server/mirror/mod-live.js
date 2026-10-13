// lib/server/mirror/mod-live.js — the live feed from the mod (spec §15.7, the
// mod's tier 2; C-MOD-3 of design/chat-mirror-control.md).
//
// A source under the facade's contract (lib/server/mirror/index.js, THE SOURCE
// CONTRACT). It turns the mod's events — the synthetic ModEvent envelopes the
// bridge publishes on the hook tap (lib/server/domain/bridge.js; the wire is
// lib/core/mod-protocol) — into the mirror's live layer:
//
//   * tool cards within a fraction of a second (the transcript lags a Bash
//     tool_use by about 3.1 s): `tool.call` makes a running tool_call item,
//     `tool.done` (which U88 synthesizes from the tool.call middleware's settled
//     next(), hinge H2) ends it;
//   * reply text as it streams (§13's deferred "live reply text", which the mod
//     un-defers): `turn.step` deltas, coalesced to at most one write per
//     `coalesceMs` per conversation (≈ 10 Hz), as a PROVISIONAL reply that the
//     transcript's replaces (§2.4 rule 3);
//   * rows the moment they are written: `session.append` rows run through the
//     transcript normalizer, so they make the very items the transcript will;
//   * the turn's lifecycle as progress evidence (§2.6) and its origin.
//
// EVERY ITEM IS KEYED AS THE TRANSCRIPT WILL KEY IT (notes-B decision 7): a
// tool call is its tool_use id, a reply `r_<message.id>`, a thinking block
// `th_<message.id>` (normalize.js). Every write here is `source: 'hook'` — a
// provisional value the model merges so that "a hook never overrides what the
// transcript said; it only fills gaps" (model.js mergeItem) and whose seq is
// replaced by the transcript's when that lands (seqFor). So the tailer's later
// copy of the same record upserts the same id and leaves ONE item with the
// transcript's fields: §15.7's "the tailer drops its later copy", with no edit
// to the transcripts source. This source never writes `seq` or `offset`, and it
// never calls engine.applyChanges (that would move the chain's leaf and the
// opener binding).
//
// THE EVENTS (env.mod.kind; anything but a synthetic ModEvent is not read,
// except Stop/StopFailure, after which the Stop's provisional reply may retire
// this source's own):
//
//   tool.call       → upsertItem({id: tool.use_id, kind: 'tool_call', status:
//                     'running', started_at, tool, tool_kind, label, call,
//                     input}) into the open turn. An item that already exists
//                     (the PreToolUse hook's, the transcript's) is only FILLED:
//                     the fields it lacks, never its status — so a late
//                     tool.call never moves a finished call back to running.
//   tool.done       → status done (error when !ok or is_error), ended_at,
//                     duration_ms, links.task_id, on an existing item only; on
//                     one already finished, only the fields it lacks.
//   turn.step       → per (mod turn, step index) the deltas accumulate into one
//                     reply item: `r_<message_id>` once the step names its
//                     message (the transcript's reply for that message then
//                     lands on this very item and its text wins), else
//                     `rm_<turn id>_<index>`. A step that learns its message id
//                     after an `rm_` write moves to the `r_` id.
//   turn.complete   → a last flush; when the turn holds no reply item at all,
//                     its text (cut at TEXT_MAX) becomes the provisional reply
//                     `rm_<turn id>_end`.
//   session.append  → the row as a transcript-shaped record {type, uuid,
//                     message} through normalize() with this source's own
//                     per-session state; of its changes only items of kind
//                     reply, thinking and tool_call are written (openers,
//                     turn_duration, interrupt, compact and permission changes
//                     never: the turn machine and the transcripts source own the
//                     turns). An existing tool call is filled, never overwritten,
//                     except that a result ends one still running.
//   prompt.submit   → patchTurn(the turn it opened, {mod_origin: origin.kind}):
//                     a header field outside the lifecycle and derived sets.
//   turn.start, turn.step, turn.complete → engine.live.noteActivity(cid, ts,
//                     'mod') on arrival.
//   session.start, session.compact, session.measure, permission.* → nothing
//                     here (U93's and U92's, from the tap).
//
// An event of a subagent (mod.agent_id) is not the main loop's: ignored, as the
// turn machine ignores a subagent's tool hooks (rule 6).
//
// WHICH TURN. This source opens, closes, binds and supersedes nothing. A mod
// turn (turn.start's turn_id) is bound, at its first write, to the
// conversation's open turn — the turn of the same session that started no more
// than START_SKEW_MS after the event (a later one is a later prompt's) — and
// keeps that binding through any alias (model.resolveTurn). An event with no
// turn to go to WAITS up to `bufferMs` for one to open (a hook's or the
// transcript's opener: onTurnOpened), and is then dropped and counted. It waits
// in its lane — a session's item events in arrival order, its prompt.submit
// apart — so an event that has a turn is never held, or expired, by one that
// has none. Nothing is ever written to a superseded turn.
//
// THE PROVISIONAL `rm_` REPLIES go as soon as the transcript has spoken: when
// the Stop's provisional reply `rh_<turn>` appears, every one of the turn's; and
// when the turn holds N transcript replies (or rows' replies), its first N, in
// order — the n-th text step of a turn is the n-th reply the transcript writes
// for it, so a reply landing for step 1 never takes the step 2 still streaming.
// An `r_<message_id>` needs nothing: the transcript lands on it. One that is
// still provisional when the Stop's `rh_` appears with the same text (the last
// message, which the mod may still be streaming when the Stop arrives) is
// removed, so the turn never shows its last reply twice; the transcript's write
// makes it again and removes the `rh_` (turn-machine.js rule 3).
//
// REDACTION happens at the model's upsert (the inbound redaction point), as for
// every source. The raw text this source holds is the in-flight message only:
// each step's text so far (≤ TEXT_MAX), dropped when its step closes (a later
// step, turn.complete, the transcript or a row landing on it, the turn's close,
// stop()), and the rows and events waiting for a turn (≤ bufferMs). It is held
// WHOLE rather than cleared at each write because a secret cut at a write
// boundary must reach the redactor whole: appended to text already masked, its
// remainder would be stored unmasked. Nothing is persisted (persistState → null:
// the transcript is the durable record), and no api is offered.
//
// createModLiveSource({coalesceMs, bufferMs, timers?, now?}) → {attach}.
// `timers` and `now` default to the engine's (engine.timers, engine.now); a test
// hands its own clock.
//
// Dependency direction: lib/server/mirror; imports lib/core and its siblings.

const { MOD_EVENT, EVENT_KINDS, TEXT_MAX } = require('../../core/mod-protocol');
const { initialState, normalize } = require('./normalize');

const COALESCE_MS = 100;
const BUFFER_MS = 2000;
// An event joins an open turn that started no later than this after it; a turn
// that started later belongs to a later prompt.
const START_SKEW_MS = 1000;
// prompt.submit patches the turn its prompt opened: one that started this close
// to it (a mid-turn submit queues and opens no turn of its own).
const PROMPT_SKEW_MS = 5000;
// Bounds on what is remembered.
const PENDING_MAX = 256; // events waiting for a turn, per conversation
const MOD_TURNS_MAX = 16; // mod turns per session
const STEPS_MAX = 64; // steps (message keys) per mod turn
const IDS_MAX = 2048; // reply ids remembered as streamed or written from a row

const MOD_KINDS = new Set(EVENT_KINDS);
const LIFECYCLE = new Set(['turn.start', 'turn.step', 'turn.complete']);
const ROW_ITEM_KINDS = new Set(['reply', 'thinking', 'tool_call']);
const TERMINAL_TOOL = new Set(['done', 'error', 'denied', 'interrupted']);
const MCP_SERVER_RE = /^mcp__(.+?)__/;

function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
const str = (v) => (typeof v === 'string' && v ? v : null);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Cut to `max` characters without leaving half a surrogate pair behind.
function cutText(s, max) {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

// Bounded insertion-ordered set.
function remember(set, v) {
  set.delete(v);
  set.add(v);
  while (set.size > IDS_MAX) set.delete(set.values().next().value);
}

function createModLiveSource({ coalesceMs = COALESCE_MS, bufferMs = BUFFER_MS, timers: timersOpt = null, now: nowOpt = null } = {}) {
  if (!(finite(coalesceMs) && coalesceMs > 0)) throw new TypeError('createModLiveSource: coalesceMs must be a positive number of ms');
  if (!(finite(bufferMs) && bufferMs > 0)) throw new TypeError('createModLiveSource: bufferMs must be a positive number of ms');
  if (timersOpt && (typeof timersOpt.setTimeout !== 'function' || typeof timersOpt.clearTimeout !== 'function')) {
    throw new TypeError('createModLiveSource: timers must provide setTimeout and clearTimeout');
  }
  if (nowOpt !== null && typeof nowOpt !== 'function') throw new TypeError('createModLiveSource: now must be a clock function');

  function attach(engine) {
    const model = engine.model;
    const timers = timersOpt || engine.timers;
    const now = nowOpt || engine.now;
    const say = typeof engine.log === 'function' ? engine.log : () => {};

    let started = false;
    const sessions = new Map(); // sid → {sid, cid, cur, turns: Map(modTurnId → MT), norm}
    const pending = new Map(); // cid → [{env, sid, at, changes?}] — waiting for a turn
    const flushTimers = new Map(); // cid → the coalescing window's handle
    const expiryTimers = new Map(); // cid → the pending queue's expiry handle
    const keyOfId = new Map(); // item id → the step key that writes it
    const streamed = new Set(); // r_ ids written from turn.step (a message id was known)
    const rowReplies = new Set(); // reply ids written from session.append rows
    let mtSerial = 0;
    const counters = {
      events: 0, written: 0, merged: 0, dropped_no_turn: 0, dropped_no_item: 0, dropped_late: 0,
      removed_provisional: 0, ignored_agent: 0, errors: 0,
    };

    function fail(where, e) {
      counters.errors += 1;
      const word = e && (e.code || (e.constructor && e.constructor.name));
      try { say(`mirror mod-live: ${where} failed${typeof word === 'string' ? ` (${word.slice(0, 48)})` : ''}`); } catch { /* never */ }
    }

    // ── state ──
    function sessionOf(sid, cid) {
      let s = sessions.get(sid);
      if (!s) {
        s = { sid, cid, cur: null, turns: new Map(), norm: null };
        sessions.set(sid, s);
      }
      s.cid = cid;
      return s;
    }

    function modTurn(s, turnId) {
      let mt = s.turns.get(turnId);
      if (mt) return mt;
      mt = { id: turnId, serial: ++mtSerial, tid: null, keys: new Map(), rms: [], completed: false };
      s.turns.set(turnId, mt);
      while (s.turns.size > MOD_TURNS_MAX) {
        const [oldId, old] = s.turns.entries().next().value;
        s.turns.delete(oldId);
        forgetTurn(old);
      }
      return mt;
    }

    function forgetTurn(mt) {
      for (const k of mt.keys.values()) {
        retire(k);
        if (k.id && keyOfId.get(k.id) === k) keyOfId.delete(k.id);
      }
      for (const r of mt.rms) if (keyOfId.get(r.id) === r.key) keyOfId.delete(r.id);
    }

    function retire(k) {
      if (!k) return;
      k.closed = true;
      k.dirty = false;
      k.text = '';
    }

    // ── turns ──
    function headerOf(id) {
      if (!id) return null;
      let rid = id;
      try { const r = model.resolveTurn(id); if (typeof r === 'string' && r) rid = r; } catch { /* the id as is */ }
      return model.turn(rid) || null;
    }

    function bound(mt) {
      if (!mt || !mt.tid) return null;
      const t = headerOf(mt.tid);
      if (!t) { mt.tid = null; return null; }
      mt.tid = t.id;
      return t;
    }

    // Where an event of session `s` (of mod turn `mt`, when it names one) goes:
    // {tid}, {wait} (no turn yet: buffer it) or {drop} (its turn is superseded,
    // or every open turn is a later prompt's).
    function placeFor(s, mt, ts, { prompt = false } = {}) {
      const b = bound(mt);
      if (b) return b.superseded ? { drop: true } : { tid: b.id };
      const open = model.openTurnOf(s.cid);
      const t = open ? model.turn(open) : null;
      if (!t || t.status !== 'open' || t.superseded) return { wait: true };
      if (str(t.session_id) && t.session_id !== s.sid) return { wait: true };
      if (finite(ts) && finite(t.started_at)) {
        if (prompt && Math.abs(t.started_at - ts) > PROMPT_SKEW_MS) return { wait: true };
        if (!prompt && t.started_at > ts + START_SKEW_MS) return { drop: true };
      }
      if (mt) mt.tid = t.id;
      return { tid: t.id };
    }

    function upsert(raw, opts) {
      const it = model.upsertItem(raw, opts);
      if (it) counters.written += 1;
      return it;
    }

    // ── replies: the step keys ──
    function scrub(s) {
      try { const v = model.scrubText(s); return typeof v === 'string' ? v : ''; } catch { return ''; }
    }
    function sameText(a, b) {
      const x = typeof a === 'string' ? a.trim() : '';
      const y = typeof b === 'string' ? b.trim() : '';
      return Boolean(x && y && (x === y || x.startsWith(y) || y.startsWith(x)));
    }

    // Transcript replies in the turn (rows' replies count as the transcript's),
    // not counting the ones a streamed message id already matches.
    function spokenReplies(tid) {
      const list = model.itemsOf(tid);
      if (!list) return Infinity; // evicted: a closed, old turn
      let n = 0;
      for (const it of list) {
        if (it.kind !== 'reply' || it.id === `rh_${tid}` || streamed.has(it.id)) continue;
        if (it.source === 'transcript' || rowReplies.has(it.id)) n += 1;
      }
      return n;
    }

    function turnsBoundTo(tid) {
      const out = [];
      for (const s of sessions.values()) {
        for (const mt of s.turns.values()) { const b = bound(mt); if (b && b.id === tid) out.push(mt); }
      }
      return out.sort((a, b) => a.serial - b.serial);
    }

    function rmIdFor(tid, suffix, key) {
      const base = `rm_${tid}_${suffix}`;
      const held = keyOfId.get(base);
      return held && held !== key ? `${base}_${++mtSerial}` : base;
    }

    function removeProvisional(id) {
      try {
        if (model.removeItem(id)) counters.removed_provisional += 1;
      } catch (e) { fail('remove', e); }
    }

    function dropRm(mt, entry) {
      if (!entry.alive) return;
      entry.alive = false;
      removeProvisional(entry.id);
      if (keyOfId.get(entry.id) === entry.key) keyOfId.delete(entry.id);
    }

    function writeKey(mt, k) {
      if (!k.dirty || k.closed) return;
      k.dirty = false;
      // A blank step (a message_start chunk, a tool-only model request) is no
      // reply: the key stays open but unwritten — no item, no rm_ entry, no
      // streamed id — so it is never counted against the transcript's replies.
      if (!k.text.trim()) return;
      const t = bound(mt);
      if (!t || t.superseded) { retire(k); return; }
      const tid = t.id;
      // A step that learned its message id leaves its rm_ item for the r_ one.
      if (k.mid && k.id && k.id !== `r_${k.mid}`) {
        const entry = mt.rms.find((r) => r.id === k.id);
        if (entry) dropRm(mt, entry);
        k.id = null;
      }
      const id = k.id || (k.mid ? `r_${k.mid}` : rmIdFor(tid, k.index, k));
      if (rowReplies.has(id)) { retire(k); return; } // the row's complete text is there
      const existing = model.item(id);
      if (existing && (existing.source === 'transcript' || existing.kind !== 'reply')) { retire(k); return; }
      if (!existing) {
        if (!k.mid && spokenReplies(tid) > countRms(tid)) { retire(k); return; } // already spoken for
        const rh = model.item(`rh_${tid}`);
        if (rh && (!k.mid || sameText(scrub(k.text), rh.text))) { retire(k); return; }
      }
      const raw = { id, turn_id: existing ? existing.turn_id : tid, kind: 'reply', source: 'hook', text: k.text };
      if (finite(k.ts)) raw.ts = k.ts;
      if (k.mid) raw.message_id = k.mid;
      const it = upsert(raw);
      if (!it) { retire(k); return; }
      if (existing) counters.merged += 1;
      if (!k.id) {
        k.id = id;
        keyOfId.set(id, k);
        if (k.mid) remember(streamed, id);
        else mt.rms.push({ id, alive: true, key: k });
      }
    }

    function countRms(tid) {
      let n = 0;
      for (const mt of turnsBoundTo(tid)) n += mt.rms.length;
      return n;
    }

    function closeKey(mt, k) {
      if (k.dirty && !k.closed) writeKey(mt, k);
      retire(k);
    }

    // Retire this source's provisional replies the transcript (or the Stop) has
    // spoken for.
    function sweepTurn(tid) {
      const mts = turnsBoundTo(tid);
      if (!mts.length) return;
      const rh = model.item(`rh_${tid}`);
      const n = rh ? Infinity : spokenReplies(tid);
      const entries = mts.flatMap((mt) => mt.rms.map((entry) => [mt, entry]));
      for (let i = 0; i < entries.length && i < n; i++) {
        const [mt, entry] = entries[i];
        if (entry.alive) { retire(entry.key); dropRm(mt, entry); }
      }
      if (!rh) return;
      // The last streamed reply still provisional, when it is the Stop's message.
      const list = model.itemsOf(tid) || [];
      for (let j = list.length - 1; j >= 0; j--) {
        const it = list[j];
        if (it.kind !== 'reply' || it.id === `rh_${tid}`) continue;
        if (it.source === 'hook' && streamed.has(it.id) && sameText(it.text, rh.text)) {
          retire(keyOfId.get(it.id));
          keyOfId.delete(it.id);
          removeProvisional(it.id);
        }
        break;
      }
    }

    function sweepConversation(cid) {
      const tids = new Set();
      for (const s of sessions.values()) {
        if (s.cid !== cid) continue;
        for (const mt of s.turns.values()) { const b = bound(mt); if (b) tids.add(b.id); }
      }
      for (const tid of tids) sweepTurn(tid);
    }

    // ── the coalescing window (one per conversation) ──
    function hasDirty(cid) {
      for (const s of sessions.values()) {
        if (s.cid !== cid) continue;
        for (const mt of s.turns.values()) for (const k of mt.keys.values()) if (k.dirty) return true;
      }
      return false;
    }
    function flushConversation(cid) {
      for (const s of sessions.values()) {
        if (s.cid !== cid) continue;
        for (const mt of s.turns.values()) for (const k of mt.keys.values()) if (k.dirty) writeKey(mt, k);
      }
    }
    function openWindow(cid) {
      const h = timers.setTimeout(() => {
        flushTimers.delete(cid);
        if (!started) return;
        try {
          if (hasDirty(cid)) { flushConversation(cid); openWindow(cid); }
        } catch (e) { fail('flush', e); }
      }, coalesceMs);
      if (h !== null && h !== undefined) flushTimers.set(cid, h);
    }
    // A delta arrived: written now when no window is open (then the window
    // opens), else at the window's end.
    function arm(cid) {
      if (flushTimers.has(cid)) return;
      flushConversation(cid);
      openWindow(cid);
    }

    // ── the events ──
    function onStep(s, env, m) {
      const mt = modTurn(s, m.turn_id);
      if (!s.cur) s.cur = m.turn_id;
      const k0 = mt.keys.get(m.index);
      if (k0 && k0.closed) { counters.dropped_late += 1; return true; }
      const p = placeFor(s, mt, env.ts);
      if (p.wait) return false;
      if (p.drop) { counters.dropped_no_turn += 1; return true; }
      let k = k0;
      if (!k) {
        // A later step: the earlier ones of this turn are whole.
        for (const other of mt.keys.values()) if (other.index < m.index && !other.closed) closeKey(mt, other);
        k = { index: m.index, id: null, mid: null, text: '', ts: env.ts, dirty: false, closed: false };
        mt.keys.set(m.index, k);
        while (mt.keys.size > STEPS_MAX) {
          const [oldIndex, old] = mt.keys.entries().next().value;
          closeKey(mt, old);
          mt.keys.delete(oldIndex);
        }
      }
      if (str(m.message_id) && !k.mid) k.mid = m.message_id;
      k.text = cutText(k.text + (typeof m.delta === 'string' ? m.delta : ''), TEXT_MAX);
      k.dirty = true;
      arm(s.cid);
      return true;
    }

    function onComplete(s, env, m) {
      const mt = modTurn(s, m.turn_id);
      const p = placeFor(s, mt, env.ts);
      if (p.wait) return false;
      for (const k of mt.keys.values()) closeKey(mt, k);
      mt.completed = true;
      if (s.cur === m.turn_id) s.cur = null;
      if (p.drop) { counters.dropped_no_turn += 1; return true; }
      const text = typeof m.text === 'string' ? cutText(m.text, TEXT_MAX) : '';
      if (text.trim()) {
        const list = model.itemsOf(p.tid);
        if (list && !list.some((it) => it.kind === 'reply')) {
          const key = { index: 'end', id: null, mid: null, text: '', ts: env.ts, dirty: false, closed: true };
          const id = rmIdFor(p.tid, 'end', key);
          const raw = { id, turn_id: p.tid, kind: 'reply', source: 'hook', text };
          if (finite(env.ts)) raw.ts = env.ts;
          if (upsert(raw)) {
            key.id = id;
            keyOfId.set(id, key);
            mt.rms.push({ id, alive: true, key });
          }
        }
      }
      sweepTurn(p.tid);
      return true;
    }

    function toolFields(tool) {
      const out = {};
      if (str(tool.name)) {
        out.tool = tool.name;
        const mm = MCP_SERVER_RE.exec(tool.name);
        if (mm) out.server = mm[1];
      }
      if (typeof tool.kind === 'string') out.tool_kind = tool.kind;
      if (typeof tool.label === 'string') out.label = tool.label;
      if (typeof tool.call === 'string') out.call = tool.call;
      if (tool.input !== undefined && tool.input !== null) out.input = tool.input;
      return out;
    }

    function useIdOf(env, m) {
      const tool = isPlain(env.tool) ? env.tool : null;
      return (tool && str(tool.use_id)) || str(m.tool_use_id);
    }

    // The fields `existing` lacks, of `fields`.
    function gaps(existing, fields) {
      const out = {};
      for (const k of Object.keys(fields)) if (existing[k] === undefined) out[k] = fields[k];
      return out;
    }

    function onToolCall(s, env, m) {
      const useId = useIdOf(env, m);
      if (!useId) return true;
      const fields = { ...toolFields(isPlain(env.tool) ? env.tool : { name: m.tool }), started_at: env.ts, ts: env.ts };
      const existing = model.item(useId);
      if (existing) {
        if (existing.kind !== 'tool_call') return true;
        const fill = gaps(existing, fields);
        if (!Object.keys(fill).length) return true;
        if (upsert({ id: useId, turn_id: existing.turn_id, kind: 'tool_call', source: 'hook', ...fill })) counters.merged += 1;
        return true;
      }
      const p = placeFor(s, s.cur ? modTurn(s, s.cur) : null, env.ts);
      if (p.wait) return false;
      if (p.drop) { counters.dropped_no_turn += 1; return true; }
      upsert({ id: useId, turn_id: p.tid, kind: 'tool_call', source: 'hook', ...fields, status: 'running' });
      return true;
    }

    function onToolDone(s, env, m) {
      const useId = useIdOf(env, m);
      if (!useId) return true;
      const existing = model.item(useId);
      if (!existing) {
        const p = placeFor(s, s.cur ? modTurn(s, s.cur) : null, env.ts);
        if (p.wait) return false;
        counters.dropped_no_item += 1;
        return true;
      }
      if (existing.kind !== 'tool_call') return true;
      const fields = { ended_at: env.ts };
      if (finite(m.duration_ms) && m.duration_ms >= 0) fields.duration_ms = m.duration_ms;
      else if (finite(existing.started_at) && finite(env.ts) && env.ts >= existing.started_at) fields.duration_ms = env.ts - existing.started_at;
      const w = TERMINAL_TOOL.has(existing.status)
        ? gaps(existing, fields)
        : { status: m.ok === true && m.is_error !== true ? 'done' : 'error', ...fields };
      if (str(m.background_task_id)) w.links = { task_id: m.background_task_id };
      if (!Object.keys(w).length) return true;
      if (upsert({ id: useId, turn_id: existing.turn_id, kind: 'tool_call', source: 'hook', ...w })) counters.merged += 1;
      return true;
    }

    // A row's items, normalized once (the entry keeps them while it waits).
    function rowChanges(s, entry) {
      if (entry.changes) return entry.changes;
      const m = entry.env.mod;
      const msg = isPlain(m.message) ? m.message : null;
      const out = [];
      if (msg && str(m.uuid)) {
        const rec = { type: msg.role === 'assistant' ? 'assistant' : 'user', uuid: m.uuid, message: msg };
        const r = normalize([{ obj: rec, start: 0, end: 0 }], s.norm || initialState());
        s.norm = r.state;
        for (const ch of r.changes) {
          if (!ch || ch.type !== 'item' || !isPlain(ch.item) || !ROW_ITEM_KINDS.has(ch.item.kind)) continue;
          out.push({ item: ch.item, context: isPlain(ch.context) ? ch.context : null });
        }
      }
      entry.changes = out;
      return out;
    }

    function writeRowItem(s, env, tid, { item, context }) {
      const raw = { ...item };
      delete raw.seq;
      delete raw.offset;
      delete raw.rev;
      if (!finite(raw.ts)) raw.ts = env.ts;
      const existing = str(raw.id) ? model.item(raw.id) : null;
      let w = raw;
      if (raw.kind === 'tool_call') {
        if (!finite(raw.started_at)) delete raw.started_at;
        if (raw.ended_at === null || raw.ended_at === undefined) delete raw.ended_at;
        // The mod's rows keep a tool_result's id and is_error only: no preview.
        if (isPlain(raw.result) && !raw.result.preview) delete raw.result;
        const ends = TERMINAL_TOOL.has(raw.status) && raw.tool === undefined;
        if (ends && raw.ended_at === undefined) raw.ended_at = env.ts;
        if (ends && raw.duration_ms === undefined && existing && finite(existing.started_at) && finite(env.ts) && env.ts >= existing.started_at) {
          raw.duration_ms = env.ts - existing.started_at;
        }
        if (raw.tool === undefined && !existing) { counters.dropped_no_item += 1; return; } // a result of a call never seen
        if (raw.tool !== undefined && raw.started_at === undefined) raw.started_at = env.ts;
        if (existing) {
          // Filled, never overwritten: but a result ends a call still running.
          const keep = { id: raw.id, kind: 'tool_call', ...gaps(existing, raw) };
          if (ends && !TERMINAL_TOOL.has(existing.status)) {
            for (const k of ['status', 'ended_at', 'duration_ms']) if (raw[k] !== undefined) keep[k] = raw[k];
          }
          if (isPlain(raw.links)) keep.links = raw.links;
          w = keep;
        }
      }
      w.turn_id = existing ? existing.turn_id : tid;
      w.source = 'hook';
      if (upsert(w, context ? { context } : undefined) && existing) counters.merged += 1;
      if (raw.kind === 'reply') {
        remember(rowReplies, raw.id);
        const k = keyOfId.get(raw.id);
        if (k) retire(k); // the row is the message whole
        if (str(raw.message_id)) {
          for (const mt of s.turns.values()) for (const kk of mt.keys.values()) if (kk.mid === raw.message_id) retire(kk);
        }
      }
    }

    function onAppend(s, entry) {
      const env = entry.env;
      const changes = rowChanges(s, entry);
      if (!changes.length) return true; // a prompt row or an empty one: no turn needed
      const p = placeFor(s, s.cur ? modTurn(s, s.cur) : null, env.ts);
      if (p.wait) return false;
      if (p.drop) { counters.dropped_no_turn += 1; return true; }
      for (const c of changes) writeRowItem(s, env, p.tid, c);
      sweepTurn(p.tid);
      return true;
    }

    function onPrompt(s, env, m) {
      const kind = isPlain(m.origin) ? str(m.origin.kind) : null;
      if (!kind) return true;
      const p = placeFor(s, null, env.ts, { prompt: true });
      if (p.wait) return false;
      if (p.drop) { counters.dropped_no_turn += 1; return true; }
      if (model.patchTurn(p.tid, { mod_origin: kind })) counters.written += 1;
      return true;
    }

    // One event: true when it is done with (written, merged or dropped), false
    // when it waits for a turn.
    function handle(entry, cid) {
      const s = sessionOf(entry.sid, cid);
      const env = entry.env;
      const m = env.mod;
      switch (m.kind) {
        case 'turn.start': s.cur = m.turn_id; modTurn(s, m.turn_id); return true;
        case 'turn.step': return onStep(s, env, m);
        case 'turn.complete': return onComplete(s, env, m);
        case 'tool.call': return onToolCall(s, env, m);
        case 'tool.done': return onToolDone(s, env, m);
        case 'session.append': return onAppend(s, entry);
        case 'prompt.submit': return onPrompt(s, env, m);
        default: return true;
      }
    }

    function process1(entry, cid) {
      try { return handle(entry, cid); } catch (e) { fail(entry.env.mod.kind, e); return true; }
    }

    // ── the queue of events waiting for a turn ──
    function enqueue(cid, entry) {
      let q = pending.get(cid);
      if (!q) { q = []; pending.set(cid, q); }
      q.push(entry);
      while (q.length > PENDING_MAX) { q.shift(); counters.dropped_no_turn += 1; }
      if (started) armExpiry(cid);
    }

    function armExpiry(cid) {
      if (expiryTimers.has(cid)) return;
      const q = pending.get(cid);
      if (!q || !q.length) return;
      const wait = Math.max(1, q[0].at + bufferMs - now());
      const h = timers.setTimeout(() => {
        expiryTimers.delete(cid);
        if (started) drain(cid);
      }, wait);
      if (h !== null && h !== undefined) expiryTimers.set(cid, h);
    }

    // The lane an event waits in. A session's item events keep their arrival
    // order (tool.call before its tool.done, a step's deltas in turn); a
    // prompt.submit waits apart, since it has no ordering tie to items — a
    // mid-turn submit that opens no turn must not hold back the cards of the
    // turn that is open. An event is held only by an earlier one of its lane.
    function laneOf(entry) {
      return `${entry.sid}\u0000${entry.env.mod.kind === 'prompt.submit' ? 'prompt' : 'items'}`;
    }

    function drain(cid) {
      const q = pending.get(cid);
      if (!q) return;
      try {
        const held = new Set(); // lanes with an earlier event still waiting
        for (let i = 0; i < q.length;) {
          const e = q[i];
          const lane = laneOf(e);
          if (held.has(lane)) { i += 1; continue; }
          if (process1(e, cid)) { q.splice(i, 1); continue; }
          // Expired only while its own place still says wait.
          if (now() - e.at >= bufferMs) { q.splice(i, 1); counters.dropped_no_turn += 1; continue; }
          held.add(lane);
          i += 1;
        }
      } catch (e) { fail('drain', e); }
      if (!q.length) {
        pending.delete(cid);
        const h = expiryTimers.get(cid);
        if (h !== undefined) { expiryTimers.delete(cid); timers.clearTimeout(h); }
      } else {
        armExpiry(cid);
      }
    }

    // ── the contract ──
    function onMod(env, ctx) {
      const m = env.mod;
      if (!isPlain(m) || typeof m.kind !== 'string' || !MOD_KINDS.has(m.kind)) return;
      const cid = isPlain(ctx) ? str(ctx.conversation_id) : null;
      const sid = isPlain(ctx) ? str(ctx.session_id) : null;
      if (!cid || !sid) return;
      counters.events += 1;
      if (str(m.agent_id)) { counters.ignored_agent += 1; return; }
      if (LIFECYCLE.has(m.kind)) {
        try { engine.live.noteActivity(cid, env.ts, 'mod'); } catch (e) { fail('activity', e); }
      }
      const entry = { env, sid, at: now() };
      const q = pending.get(cid);
      if (!started || (q && q.length)) {
        enqueue(cid, entry);
        if (started) drain(cid);
        return;
      }
      if (!process1(entry, cid)) enqueue(cid, entry);
    }

    function onIngest(env, ctx) {
      if (!isPlain(env)) return;
      if (env.synthetic === true && env.event === MOD_EVENT) { onMod(env, ctx); return; }
      if (!started) return;
      if ((env.event === 'Stop' || env.event === 'StopFailure') && isPlain(ctx) && str(ctx.conversation_id)) {
        sweepConversation(ctx.conversation_id);
      }
    }

    function onChanges(sessionId, changes) {
      if (!started || !Array.isArray(changes) || !sessions.size) return;
      const tids = new Set();
      for (const ch of changes) {
        if (!ch || ch.type !== 'item' || !isPlain(ch.item) || !str(ch.item.id)) continue;
        const id = ch.item.id;
        const k = keyOfId.get(id);
        if (k && streamed.has(id)) retire(k); // the transcript landed on a streamed reply
        if (ch.item.kind !== 'reply') continue;
        const it = model.item(id);
        if (it) tids.add(it.turn_id);
      }
      for (const tid of tids) sweepTurn(tid);
    }

    function onTurnOpened(turn) {
      if (!started || !isPlain(turn) || !str(turn.conversation_id)) return;
      if (pending.has(turn.conversation_id)) drain(turn.conversation_id);
    }

    function onTurnClosed(turn) {
      if (!started || !isPlain(turn) || !str(turn.id)) return;
      const mts = turnsBoundTo(turn.id);
      if (!mts.length) return;
      for (const mt of mts) for (const k of mt.keys.values()) closeKey(mt, k);
      sweepTurn(turn.id);
    }

    function onConversation(ev) {
      if (!isPlain(ev) || !isPlain(ev.conversation) || !str(ev.conversation.id)) return;
      if (ev.change !== 'removed' && ev.change !== 'merged') return;
      const cid = ev.conversation.id;
      for (const [sid, s] of [...sessions]) {
        if (s.cid !== cid) continue;
        for (const mt of s.turns.values()) forgetTurn(mt);
        sessions.delete(sid);
      }
      pending.delete(cid);
      for (const map of [flushTimers, expiryTimers]) {
        const h = map.get(cid);
        if (h !== undefined) { map.delete(cid); timers.clearTimeout(h); }
      }
    }

    function clearAll() {
      for (const map of [flushTimers, expiryTimers]) {
        for (const h of map.values()) { try { timers.clearTimeout(h); } catch { /* gone */ } }
        map.clear();
      }
      for (const s of sessions.values()) for (const mt of s.turns.values()) forgetTurn(mt);
      sessions.clear();
      pending.clear();
      keyOfId.clear();
      streamed.clear();
      rowReplies.clear();
    }

    async function start() {
      started = true;
      // What arrived before start(): each conversation's queue, oldest first.
      for (const cid of [...pending.keys()]) drain(cid);
    }

    async function stop() {
      started = false;
      clearAll();
    }

    function diagnostics() {
      let waiting = 0;
      for (const q of pending.values()) waiting += q.length;
      let accumulating = 0;
      for (const s of sessions.values()) {
        for (const mt of s.turns.values()) for (const k of mt.keys.values()) if (k.text) accumulating += 1;
      }
      return {
        mod_live: {
          ...counters, waiting, accumulating, sessions: sessions.size, timers: flushTimers.size + expiryTimers.size,
        },
      };
    }

    return {
      start, stop, onIngest, onChanges, onTurnOpened, onTurnClosed, onConversation, diagnostics,
      persistState: () => null,
    };
  }

  return { attach };
}

module.exports = { createModLiveSource, COALESCE_MS, BUFFER_MS, START_SKEW_MS, PROMPT_SKEW_MS };
