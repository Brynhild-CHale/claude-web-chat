// lib/server/mirror/workflows.js — the workflows source: a Workflow run as a
// TaskRow with its phases and agents, rebuilt live from the files Claude Code
// writes during the run (spec §2.5 "Workflows", §2.3, §2.10, §2.12, §5.6, §6.9,
// §7.12; validation V4). A port of design/chat-mirror-validation/rebuild_wf.py.
//
//   createWorkflowsSource({createTailer = require('./tail').createTailer,
//                          settleMs = REPLAY_SETTLE_MS} = {}) → {attach(engine)}
//   attach(engine) → {start, stop, onIngest, onChanges, onConversation,
//                     persistState, restoreState, diagnostics, api: {detail}}
//   phaseTitles(src) → [title]     the script's meta.phases titles, never evaluated
//
// A source per the contract at the head of lib/server/mirror/index.js. U51 adds
// `{name: 'workflows', attach: createWorkflowsSource().attach}` to SOURCES,
// after `agents`; the facade's DISPATCH routes workflow → api.detail (async).
//
// ROWS. kind 'workflow', through engine.model.upsertTask / removeTask only:
//   {id, conversation_id, kind: 'workflow', title, status, stopped_by?,
//    started_at, ended_at?, line, meta: {step?: {index, total}}, steps:
//    [{label, state}], turn_id, tool_use_id, can: {output: false, open: true,
//    stop}}
// Made by the Workflow tool_result (links.task_id and links.run_id; its
// toolUseResult {status: 'async_launched', taskId, taskType: 'local_workflow',
// workflowName, runId, summary, transcriptDir, scriptPath}, V4) or the
// PostToolUse envelope's result.fields. ITS ID is the taskId: the id TaskStop
// takes and the notification's task-id (ruling A1 (a)); the runId is kept in
// this source's state, and api.detail answers either. The title is the
// workflowName. The transcript change carries the links only, so the launch
// record's own line is read once more (its byte range, through the registry's
// fenced transcript path) for workflowName and scriptPath.
//
// PHASES. The script (scriptPath, fenced by sessionDirFile, inside
// <session>/workflows/scripts/) is read once with readWindow and its phase titles
// taken by phaseTitles: find `phases:` then `[`, scan to the balanced `]`
// honouring quotes and escapes, then each `title: '…'` (any quote) in order.
// Nothing is ever evaluated. No script, or no phases: the phases in the order
// the journal first names them.
//
// LIVE STATE from <session>/subagents/workflows/<runId>/journal.jsonl through a
// tailer (JOURNAL_POLL_MS; a version-less format: launched, started{key,
// agentId, label, phase}, result{agentId, key, result}, failed), each agent's
// agent-<agentId>.meta.json (label = description, phase = workflowPhase, for
// journals before about 2.1.265 that lack them), and each running agent's
// agent-<agentId>.jsonl through a light tail (foldAgentRecords, AGENT_POLL_MS,
// within the AGENT_TAILS_MAX budget the agents source shares). Agents are keyed
// by the journal's key: a retry is a new agentId under the same key, attempt + 1
// (37 of 290, V4). steps = the phases, each 'done' | 'running' | 'pending' |
// 'error'; meta.step = {index: the first running phase, else the last started,
// 1-based; total: the phase count}; line = the running agent's last tool. Each
// journal batch is progress evidence (engine.live.noteActivity(cid, at,
// 'workflow')).
//
// ENDS, the first wins: the parent's notification for the workflow (a task item
// whose task_id is the row's id, counted once per id and status) → its status;
// for a TaskStopped run, which gets no notification (14 of 14, V4), the summary
// file with a terminal status and an mtime at least the journal's, looked for
// every JOURNAL_POLL_MS while the run is followed — §2.5 names it
// workflows/<runId>.json and V4's prose wf_<runId>.json, so both names are tried
// through sessionDirFile and the directory is never listed; a stale summary of a
// resumed runId (older than the journal) is ignored; a TaskStop call's own
// result naming the row (tasks.js stoppedTaskId) → killed, 'claude'; the
// registry's 'ended' → stopped, 'session-end'. Finished rows are removed
// FINISHED_KEEP_MS after they end.
//
// A CATCH-UP REPLAY of an old Workflow call starts no tail until the replay has
// gone quiet (the same rule as agents.js) and the summary file has been looked
// for.
//
// api.detail(id), async, id = the row's id or its runId:
//   {workflow: TaskRow, phases: [{title, state}], agents: [{agent_id, key, label,
//    phase, state, attempt, tools, last_tool, model, started_at, ended_at?,
//    result_preview?}]}
// result_preview is at most 100 characters of the journal's result; a finished
// agent's stats are read once, on demand, through foldAgentRecords; a run whose
// journal is no longer followed is read once more on demand. null for an
// unknown id. Never a path.
//
// PERSISTENCE: each row's ids (task id, run id, tool_use id), status, times,
// title, phase titles, the journal's resume point and its agents' keys, ids,
// labels, phases, states and counts — never a result, a line or a path.
//
// Dependency direction: lib/server/mirror; imports fs, path, its siblings tail,
// tasks (stoppedTaskId) and agents (the fold, the shared tail budget and the
// fenced reads), and lib/core paths.

const fs = require('fs');
const path = require('path');
const { createTailer: defaultCreateTailer } = require('./tail');
const { stoppedTaskId } = require('./tasks');
const {
  foldAgentRecords, sharedFor, readSmallJson, readLines,
  AGENT_POLL_MS, JOURNAL_POLL_MS, AGENT_TAILS_MAX, STREAMS_MAX, STREAM_IDLE_MS, STREAM_LIMIT_MAX,
  FINISHED_KEEP_MS, LINE_MAX, REPLAY_AGE_MS, REPLAY_SETTLE_MS,
} = require('./agents');
const { isSafeId } = require('../../core/paths');

const STATE_VERSION = 1;
const TITLE_MAX = 300;
const PHASES_MAX = 64;
const AGENTS_MAX = 512;
const PERSIST_ROWS_MAX = 32;
const CALLS_MAX = 512;
const SCRIPT_MAX_BYTES = 1024 * 1024;
const SUMMARY_MAX_BYTES = 8 * 1024 * 1024;
const LAUNCH_LINE_MAX = 1024 * 1024;
const META_TRIES = 3;

const TERMINAL = new Set(['done', 'failed', 'killed', 'stopped', 'expired']);
const NOTIFY_STATUS = new Set(['done', 'failed', 'killed', 'stopped']);
const SUMMARY_STATUS = Object.freeze({
  completed: 'done', done: 'done', failed: 'failed', killed: 'killed', stopped: 'stopped', cancelled: 'stopped',
});

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v ? v : null);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const safeId = (v) => (typeof v === 'string' && isSafeId(v) ? v : null);

function cut(s, max) {
  if (typeof s !== 'string') return null;
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') : s;
}

// ── the script's phases ──────────────────────────────────────────────────────

const QUOTES = new Set(['"', "'", '`']);
const ESCAPES = Object.freeze({ n: '\n', t: '\t', r: '\r' });

// The string literal opening at s[i] (a quote): [its value, the index after it],
// escapes honoured. An unterminated one runs to the end.
function readString(s, i) {
  const q = s[i];
  let out = '';
  let j = i + 1;
  for (; j < s.length; j++) {
    const ch = s[j];
    if (ch === '\\') {
      j += 1;
      if (j < s.length) out += Object.hasOwn(ESCAPES, s[j]) ? ESCAPES[s[j]] : s[j];
      continue;
    }
    if (ch === q) return [out, j + 1];
    out += ch;
  }
  return [out, j];
}

const TITLE_KEY_RE = /^title\s*:\s*/;
const KEY_TAIL_RE = /^\s*:\s*/;

// Each `title: '…'` (any quote; a quoted 'title' key too) in a slice of
// source, in order. A `title:` inside another string is not a key, since every
// string is read whole.
function titlesIn(s) {
  const out = [];
  let j = 0;
  while (j < s.length && out.length < PHASES_MAX) {
    const ch = s[j];
    if (QUOTES.has(ch)) {
      const [val, next] = readString(s, j);
      j = next;
      if (val === 'title') {
        const m = KEY_TAIL_RE.exec(s.slice(j, j + 64));
        if (m && QUOTES.has(s[j + m[0].length])) {
          const [t, after] = readString(s, j + m[0].length);
          out.push(t);
          j = after;
        }
      }
      continue;
    }
    if (ch === 't' && !/[A-Za-z0-9_$]/.test(s[j - 1] || '')) {
      const m = TITLE_KEY_RE.exec(s.slice(j, j + 64));
      if (m && QUOTES.has(s[j + m[0].length])) {
        const [t, after] = readString(s, j + m[0].length);
        out.push(t);
        j = after;
        continue;
      }
    }
    j += 1;
  }
  return out.map((t) => cut(t.replace(/\s+/g, ' ').trim(), 200)).filter(Boolean);
}

// The phase titles of a workflow script, in declaration order, from its
// `meta = { phases: [...] }`: the first `phases:` followed by `[`, scanned to
// its balanced `]` (quotes and escapes honoured, so a bracket inside a title is
// text), then each title in it. Never evaluated. [] when there is none.
function phaseTitles(src) {
  if (typeof src !== 'string') return [];
  const m = /phases\s*:\s*\[/.exec(src);
  if (!m) return [];
  const i = m.index + m[0].length - 1;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (QUOTES.has(ch)) {
      j = readString(src, j)[1] - 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return titlesIn(src.slice(i, j + 1));
    }
  }
  return [];
}

// A journal result as a preview: the string itself, else its JSON.
function previewOf(v) {
  if (v === undefined || v === null) return null;
  let s;
  if (typeof v === 'string') s = v;
  else {
    try { s = JSON.stringify(v); } catch { s = null; }
  }
  if (typeof s !== 'string') return null;
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat ? cut(flat, LINE_MAX) : null;
}

// ── the source ───────────────────────────────────────────────────────────────

function createWorkflowsSource({ createTailer = defaultCreateTailer, settleMs = REPLAY_SETTLE_MS } = {}) {
  const settle = Number.isSafeInteger(settleMs) && settleMs >= 0 ? settleMs : REPLAY_SETTLE_MS;

  function attach(engine) {
    const shared = sharedFor(engine);
    const recs = new Map(); // task id → rec
    const byRun = new Map(); // runId → rec
    const calls = new Map(); // tool_use id → {tool, task_id}
    const settles = new Map(); // conversation id → the replay's settle timer
    let started = false;
    let tails = 0; // journal and agent tails of this source
    let offFree = null;

    const now = () => { try { return engine.now(); } catch { return Date.now(); } };
    function fail(stage, e) {
      const word = [e && e.code, e && e.name].find((w) => typeof w === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(w)) || 'Error';
      try { engine.log(`mirror workflows: ${stage} failed (${word})`); } catch { /* never breaks */ }
    }
    function later(fn) {
      Promise.resolve().then(fn).catch((e) => fail('scheduled', e));
    }
    function remember(map, key, value, max) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value);
    }
    function sessionDirOf(sid) {
      try { return sid ? engine.conversations.sessionDir(sid) || null : null; } catch { return null; }
    }
    function fenced(dir, p) {
      try { return dir && p ? engine.files.sessionDirFile(dir, p) : null; } catch { return null; }
    }

    // ── a record and its row ──
    function newRec({ id, runId, cid, sid, toolUseId, at }) {
      const rec = {
        id, runId, cid, sid: sid || null, toolUseId: toolUseId || null, title: null, status: 'running',
        stoppedBy: null, startedAt: finite(at) ? at : now(), endedAt: null, turnId: null,
        phases: null, scriptTried: false, launchRead: false, seen: [], agents: new Map(), byAgent: new Map(),
        journal: null, resume: null, journalRead: false, deferred: false, keep: null, poll: null,
        gone: false, ends: new Set(),
      };
      recs.set(id, rec);
      byRun.set(runId, rec);
      return rec;
    }

    function phaseList(rec) {
      return rec.phases && rec.phases.length ? rec.phases : rec.seen;
    }

    // An agent's state as shown: a run that ended leaves no agent running.
    function agentState(rec, a) {
      if (a.state !== 'running' || rec.status === 'running') return a.state;
      return rec.status === 'done' ? 'done' : 'error';
    }

    function phaseStates(rec) {
      const list = phaseList(rec);
      const started = list.map((title) => [...rec.agents.values()].some((a) => a.phase === title));
      const lastStarted = started.lastIndexOf(true);
      return list.map((title, i) => {
        const agents = [...rec.agents.values()].filter((a) => a.phase === title);
        if (!agents.length) return i < lastStarted || (rec.status === 'done' && lastStarted >= 0) ? 'done' : 'pending';
        const states = agents.map((a) => agentState(rec, a));
        if (states.includes('running')) return 'running';
        if (states.includes('error')) return 'error';
        return 'done';
      });
    }

    function rowOf(rec) {
      const running = rec.status === 'running';
      const list = phaseList(rec);
      const states = phaseStates(rec);
      const row = {
        id: rec.id,
        conversation_id: rec.cid,
        kind: 'workflow',
        title: rec.title || 'Workflow',
        status: rec.status,
        started_at: rec.startedAt,
        line: '',
        meta: {},
        steps: list.map((label, i) => ({ label, state: states[i] })),
        turn_id: rec.turnId,
        tool_use_id: rec.toolUseId,
        can: { output: false, open: true, stop: running },
      };
      if (list.length) {
        let index = states.indexOf('running');
        if (index < 0) {
          for (let i = states.length - 1; i >= 0; i--) if (states[i] !== 'pending') { index = i; break; }
        }
        if (index >= 0) row.meta.step = { index: index + 1, total: list.length };
      }
      if (running) {
        let line = null;
        for (const a of rec.agents.values()) {
          if (a.state === 'running' && a.fold && a.fold.last_tool) line = a.fold.last_tool;
        }
        if (line) row.line = line;
      }
      if (rec.stoppedBy) row.stopped_by = rec.stoppedBy;
      if (finite(rec.endedAt)) row.ended_at = rec.endedAt;
      return row;
    }

    function publish(rec) {
      if (rec.gone || recs.get(rec.id) !== rec) return;
      try { engine.model.upsertTask(rowOf(rec)); } catch (e) { fail('upsert', e); }
    }

    function clearTimer(rec, key) {
      if (rec[key] === null) return;
      try { engine.timers.clearTimeout(rec[key]); } catch { /* gone */ }
      rec[key] = null;
    }

    function stopTails(rec, { drain = false } = {}) {
      const t = rec.journal;
      if (t) {
        rec.journal = null;
        tails -= 1;
        if (drain) rec.journalRead = true;
        // Never awaited: a tail's own callback may be the caller.
        Promise.resolve().then(() => (drain ? t.drain() : null)).then(() => t.stop()).catch(() => {});
      }
      for (const a of rec.agents.values()) endAgentTail(a);
    }

    function forget(rec) {
      rec.gone = true;
      stopTails(rec);
      clearTimer(rec, 'keep');
      clearTimer(rec, 'poll');
      if (recs.get(rec.id) === rec) recs.delete(rec.id);
      if (byRun.get(rec.runId) === rec) byRun.delete(rec.runId);
    }

    function removeRow(rec) {
      forget(rec);
      try { engine.model.removeTask(rec.id); } catch (e) { fail('remove', e); }
    }

    function armKeep(rec) {
      clearTimer(rec, 'keep');
      if (!started || rec.status === 'running' || !finite(rec.endedAt)) return;
      const delay = rec.endedAt + FINISHED_KEEP_MS - now();
      if (delay <= 0) { removeRow(rec); return; }
      rec.keep = engine.timers.setTimeout(() => { rec.keep = null; if (!rec.gone) removeRow(rec); }, delay);
    }

    function conversationEnded(cid) {
      try {
        const v = engine.conversations.get(cid);
        return Boolean(v && finite(v.ended_at));
      } catch { return false; }
    }

    function itemTurnOf(toolUseId) {
      try {
        const it = toolUseId ? engine.model.item(toolUseId) : null;
        return it && typeof it.turn_id === 'string' ? it.turn_id : null;
      } catch { return null; }
    }
    function openTurnOf(cid) {
      try {
        const open = engine.model.openTurnOf(cid);
        return typeof open === 'string' ? open : null;
      } catch { return null; }
    }

    function recOf(id) {
      if (typeof id !== 'string' || !id) return null;
      return recs.get(id) || byRun.get(id) || null;
    }

    // ── a launch, from either stream ──
    function noteRun({ id, runId, cid, sid, toolUseId, title, at, replay }) {
      const tid = safeId(id);
      const run = safeId(runId);
      if (!tid || !run || !cid) return null;
      let rec = recs.get(tid) || byRun.get(run) || null;
      if (!rec) {
        rec = newRec({ id: tid, runId: run, cid, sid, toolUseId, at });
        if (replay) rec.deferred = true;
      }
      if (!rec.sid && sid) rec.sid = sid;
      if (toolUseId && !rec.toolUseId) rec.toolUseId = toolUseId;
      if (title && !rec.title) rec.title = cut(title, TITLE_MAX);
      if (finite(at) && at < rec.startedAt) rec.startedAt = at;
      const own = itemTurnOf(rec.toolUseId);
      if (own) rec.turnId = own;
      else if (!rec.turnId) rec.turnId = openTurnOf(rec.cid);
      publish(rec);
      begin(rec);
      return rec;
    }

    // The launch record's own line, read again for what the change does not
    // carry: workflowName and scriptPath (V4).
    function readLaunch(rec, sid, offset) {
      if (rec.launchRead || rec.gone || !isPlain(offset) || !finite(offset.start) || !finite(offset.end)) return;
      const len = offset.end - offset.start;
      if (len <= 0 || len > LAUNCH_LINE_MAX) return;
      rec.launchRead = true;
      let file = null;
      try { file = engine.conversations.transcriptPath(sid); } catch { file = null; }
      const w = file ? engine.files.readWindow(file, { from: offset.start, maxBytes: len }) : null;
      if (!w) return;
      let obj = null;
      try { obj = JSON.parse(w.text.trim()); } catch { obj = null; }
      const tur = isPlain(obj) && isPlain(obj.toolUseResult) ? obj.toolUseResult : null;
      if (!tur) return;
      if (str(tur.runId) && tur.runId !== rec.runId) return;
      if (str(tur.workflowName) && !rec.title) { rec.title = cut(tur.workflowName, TITLE_MAX); publish(rec); }
      if (str(tur.scriptPath)) loadScript(rec, tur.scriptPath);
    }

    function loadScript(rec, scriptPath) {
      if (rec.scriptTried || rec.gone) return;
      rec.scriptTried = true;
      const parent = path.dirname(scriptPath);
      if (path.basename(parent) !== 'scripts' || path.basename(path.dirname(parent)) !== 'workflows') return;
      const f = fenced(sessionDirOf(rec.sid), scriptPath);
      const w = f ? engine.files.readWindow(f, { maxBytes: SCRIPT_MAX_BYTES }) : null;
      if (!w) return;
      const titles = phaseTitles(w.text);
      if (!titles.length) return;
      rec.phases = titles;
      publish(rec);
    }

    // ── following a run ──
    function runDirOf(rec) {
      const dir = sessionDirOf(rec.sid);
      return dir ? { dir, run: path.join(dir, 'subagents', 'workflows', rec.runId) } : null;
    }

    function begin(rec) {
      if (!started || rec.gone || rec.status !== 'running' || rec.deferred) return;
      startJournal(rec);
      armPoll(rec, 0);
      for (const a of rec.agents.values()) beginAgentTail(rec, a);
    }

    function startJournal(rec) {
      if (rec.journal) return;
      const at = runDirOf(rec);
      if (!at) return;
      let t = null;
      try {
        t = createTailer({
          file: path.join(at.run, 'journal.jsonl'),
          resume: rec.resume,
          pollMs: JOURNAL_POLL_MS,
          watchFile: engine.watchFile,
          fence: (p) => engine.files.sessionDirFile(at.dir, p),
          onRecords: (rs) => {
            if (rec.journal !== t) return;
            applyJournal(rec, rs);
            const last = rs[rs.length - 1];
            const resume = last ? t.resumeAt(last) : null;
            if (resume) rec.resume = resume;
            afterJournal(rec);
          },
          onReset: (info) => {
            if (rec.journal !== t) return;
            if (!isPlain(info) || info.anchoredAt === 0 || info.anchored === false) resetAgents(rec);
          },
          onError: (e) => { if (!(e && e.code === 'WC_TAIL_REFUSED')) fail('journal', e); },
          log: () => {},
        });
      } catch (e) {
        fail('tailer', e);
        return;
      }
      rec.journal = t;
      tails += 1;
      Promise.resolve().then(() => t.start()).catch((e) => fail('journal start', e));
    }

    function resetAgents(rec) {
      for (const a of rec.agents.values()) endAgentTail(a);
      rec.agents.clear();
      rec.byAgent.clear();
      rec.seen = [];
    }

    // One journal batch (rebuild_wf.py rebuild()).
    function applyJournal(rec, rs) {
      const at = runDirOf(rec);
      for (const r of rs) {
        const o = r && isPlain(r.obj) ? r.obj : null;
        if (!o) continue;
        const aid = safeId(o.agentId);
        if (o.type === 'started' && aid) {
          const key = str(o.key) || aid;
          let a = rec.agents.get(key);
          if (a && a.agentId !== aid) {
            endAgentTail(a);
            a.attempt += 1;
            a.agentId = aid;
            a.state = 'running';
            a.fold = null;
            a.statsRead = false;
            a.resultPreview = null;
            a.endedAt = null;
            a.startedAt = now();
            a.metaTries = 0;
          } else if (!a) {
            if (rec.agents.size >= AGENTS_MAX) continue;
            a = {
              key, agentId: aid, attempt: 1, label: null, phase: null, state: 'running', startedAt: now(), endedAt: null,
              resultPreview: null, fold: null, tail: null, statsRead: false, metaTries: 0,
            };
            rec.agents.set(key, a);
          }
          if (str(o.label)) a.label = cut(o.label, TITLE_MAX);
          if (str(o.phase)) a.phase = cut(o.phase, 200);
          rec.byAgent.set(aid, key);
          if (at && (!a.label || !a.phase)) readMeta(at, a);
          notePhase(rec, a.phase);
        } else if ((o.type === 'result' || o.type === 'failed') && (aid || str(o.key))) {
          const key = (str(o.key) && rec.agents.has(o.key)) ? o.key : rec.byAgent.get(aid || '');
          const a = key ? rec.agents.get(key) : null;
          if (!a || (aid && a.agentId !== aid)) continue;
          a.state = o.type === 'result' ? 'done' : 'error';
          if (o.type === 'result') a.resultPreview = previewOf(o.result);
          a.endedAt = a.fold && finite(a.fold.last_ts) ? a.fold.last_ts : now();
          endAgentTail(a);
        } else if (o.type === 'launched') {
          rec.launched = true;
        }
      }
    }

    function notePhase(rec, phase) {
      if (phase && !rec.seen.includes(phase) && rec.seen.length < PHASES_MAX) rec.seen.push(phase);
    }

    // A journal before about 2.1.265 has no label or phase: the agent's meta.
    function readMeta(at, a) {
      if (a.metaTries >= META_TRIES) return;
      a.metaTries += 1;
      const meta = readSmallJson(engine, at.dir, path.join(at.run, `agent-${a.agentId}.meta.json`));
      if (!meta) return;
      if (!a.label && str(meta.description)) a.label = cut(meta.description, TITLE_MAX);
      if (!a.phase && str(meta.workflowPhase)) a.phase = cut(meta.workflowPhase, 200);
    }

    function afterJournal(rec) {
      if (rec.gone) return;
      const at = runDirOf(rec);
      for (const a of rec.agents.values()) {
        if (at && (!a.label || !a.phase)) { readMeta(at, a); notePhase(rec, a.phase); }
        beginAgentTail(rec, a);
      }
      publish(rec);
      try { engine.live.noteActivity(rec.cid, now(), 'workflow'); } catch (e) { fail('activity', e); }
    }

    // ── a running agent's light tail ──
    function beginAgentTail(rec, a) {
      if (!started || rec.gone || rec.status !== 'running' || rec.deferred || a.state !== 'running' || a.tail) return;
      const at = runDirOf(rec);
      if (!at) return;
      if (!shared.acquire()) return; // pumpWaiting retries when a slot frees
      const agentId = a.agentId;
      let t = null;
      try {
        t = createTailer({
          file: path.join(at.run, `agent-${agentId}.jsonl`),
          pollMs: AGENT_POLL_MS,
          watchFile: engine.watchFile,
          fence: (p) => engine.files.sessionDirFile(at.dir, p),
          onRecords: (rs) => {
            if (a.tail !== t) return;
            a.fold = foldAgentRecords(a.fold, rs);
            if (finite(a.fold.first_ts) && (a.fold.first_ts < a.startedAt || a.attempt === 1)) a.startedAt = Math.min(a.startedAt, a.fold.first_ts);
            publish(rec);
            try { engine.live.noteActivity(rec.cid, finite(a.fold.last_ts) ? a.fold.last_ts : now(), 'workflow'); } catch (e) { fail('activity', e); }
          },
          onReset: () => { if (a.tail === t) a.fold = null; },
          onError: (e) => { if (!(e && e.code === 'WC_TAIL_REFUSED')) fail('agent tail', e); },
          log: () => {},
        });
      } catch (e) {
        fail('tailer', e);
        shared.release();
        return;
      }
      a.tail = t;
      tails += 1;
      Promise.resolve().then(() => t.start()).catch((e) => fail('agent tail start', e));
    }

    function endAgentTail(a) {
      const t = a.tail;
      if (!t) return;
      a.tail = null;
      tails -= 1;
      Promise.resolve().then(() => t.stop()).catch(() => {});
      shared.release();
    }

    function pumpWaiting() {
      if (!started) return;
      for (const rec of recs.values()) {
        if (rec.status !== 'running' || rec.deferred) continue;
        for (const a of rec.agents.values()) {
          if (shared.used >= AGENT_TAILS_MAX) return;
          beginAgentTail(rec, a);
        }
      }
    }

    // ── the summary file (a TaskStopped run's only end, V4) ──
    function armPoll(rec, delay) {
      if (rec.poll !== null || !started || rec.status !== 'running' || rec.deferred) return;
      rec.poll = engine.timers.setTimeout(() => {
        rec.poll = null;
        checkSummary(rec).then(() => armPoll(rec, JOURNAL_POLL_MS), (e) => fail('summary', e));
      }, delay);
    }

    async function mtimeOf(f) {
      if (!f) return null;
      try {
        const st = await fs.promises.lstat(f);
        return st.isFile() ? st.mtimeMs : null;
      } catch { return null; }
    }

    // Answers whether the summary ended the row.
    async function checkSummary(rec) {
      if (rec.gone || rec.status !== 'running') return false;
      const at = runDirOf(rec);
      if (!at) return false;
      const journalM = await mtimeOf(fenced(at.dir, path.join(at.run, 'journal.jsonl')));
      for (const name of [`${rec.runId}.json`, `wf_${rec.runId}.json`]) {
        const f = fenced(at.dir, path.join(at.dir, 'workflows', name));
        const m = await mtimeOf(f);
        if (m === null || rec.gone || rec.status !== 'running') continue;
        if (journalM !== null && m < journalM) continue; // a resumed run's stale summary
        const v = readSmallJson(engine, at.dir, f, SUMMARY_MAX_BYTES);
        const status = v && typeof v.status === 'string' ? SUMMARY_STATUS[v.status] : undefined;
        if (!status) continue;
        end(rec, status, { at: Math.round(m), by: 'summary' });
        return true;
      }
      return false;
    }

    // ── ends ──
    function end(rec, status, { at, stoppedBy, by } = {}) {
      if (rec.status !== 'running' || !TERMINAL.has(status) || rec.gone) return false;
      rec.status = status;
      rec.endedAt = finite(at) ? Math.max(at, rec.startedAt) : now();
      if (stoppedBy) rec.stoppedBy = stoppedBy;
      rec.endedBy = by || null;
      rec.deferred = false;
      clearTimer(rec, 'poll');
      stopTails(rec, { drain: true });
      publish(rec);
      armKeep(rec);
      return true;
    }

    function endedIn(rec) {
      let at = null;
      try { const v = engine.conversations.get(rec.cid); at = v && finite(v.ended_at) ? v.ended_at : null; } catch { at = null; }
      end(rec, 'stopped', { at: at === null ? now() : at, stoppedBy: 'session-end', by: 'session-end' });
    }

    // ── the transcript's batch ──
    function onChanges(sessionId, changes, { conversation_id: cid } = {}) {
      if (!Array.isArray(changes) || typeof cid !== 'string') return;
      let replayed = false;
      for (const ch of changes) {
        if (!isPlain(ch) || ch.type !== 'item' || !isPlain(ch.item)) continue;
        try {
          if (itemChange(sessionId, cid, ch)) replayed = true;
        } catch (e) { fail('change', e); }
      }
      if (replayed || hasDeferred(cid)) armSettle(cid);
    }

    function itemChange(sid, cid, ch) {
      const it = ch.item;
      if (it.kind === 'task') { taskItem(ch, it); return false; }
      if (it.kind !== 'tool_call' || typeof it.id !== 'string') return false;
      let merged = null;
      try { merged = engine.model.item(it.id); } catch { merged = null; }
      const known = calls.get(it.id);
      const tool = str(it.tool) || (merged && str(merged.tool)) || (known && known.tool) || null;
      if (!tool) return false;
      const input = isPlain(it.input) ? it.input : (merged && isPlain(merged.input) ? merged.input : {});
      remember(calls, it.id, { tool, task_id: str(input.task_id) || str(input.shell_id) }, CALLS_MAX);
      const result = isPlain(it.result) ? it.result : null;
      if (!result) return false;
      if (tool === 'TaskStop') {
        const stopped = stoppedTaskId(calls.get(it.id), result);
        const rec = stopped ? recs.get(stopped) : null;
        if (rec) end(rec, 'killed', { at: finite(ch.ts) ? ch.ts : now(), stoppedBy: 'claude', by: 'taskstop' });
        return false;
      }
      if (tool !== 'Workflow' || result.is_error === true) return false;
      const links = isPlain(it.links) ? it.links : (merged && isPlain(merged.links) ? merged.links : {});
      const replay = finite(ch.ts) && ch.ts < now() - REPLAY_AGE_MS;
      const at = merged && finite(merged.started_at) ? merged.started_at : (finite(ch.ts) ? ch.ts : null);
      const rec = noteRun({
        id: links.task_id, runId: links.run_id, cid, sid, toolUseId: it.id,
        title: str(input.name) || str(input.workflow) || null, at, replay,
      });
      if (!rec) return false;
      if (!rec.launchRead) later(() => readLaunch(rec, sid, ch.offset));
      return rec.deferred;
    }

    function taskItem(ch, it) {
      const id = str(it.task_id);
      const rec = id ? recs.get(id) : null;
      if (!rec) return;
      const status = typeof it.status === 'string' ? it.status : 'unknown';
      if (!NOTIFY_STATUS.has(status)) return;
      const key = `${id}:${status}`;
      if (rec.ends.has(key)) return;
      rec.ends.add(key);
      end(rec, status, { at: finite(ch.ts) ? ch.ts : now(), by: 'notification' });
    }

    // ── the replay's settle ──
    function hasDeferred(cid) {
      for (const rec of recs.values()) if (rec.cid === cid && rec.deferred) return true;
      return false;
    }
    function armSettle(cid) {
      if (!started) return;
      const prev = settles.get(cid);
      if (prev !== undefined) { try { engine.timers.clearTimeout(prev); } catch { /* gone */ } }
      settles.set(cid, engine.timers.setTimeout(() => { settles.delete(cid); settled(cid); }, settle));
    }
    function settled(cid) {
      for (const rec of [...recs.values()]) {
        if (rec.cid !== cid || !rec.deferred) continue;
        if (rec.status !== 'running') { rec.deferred = false; continue; }
        if (conversationEnded(cid)) { rec.deferred = false; endedIn(rec); continue; }
        checkSummary(rec).then(() => {
          rec.deferred = false;
          if (!rec.gone && rec.status === 'running') begin(rec);
        }, (e) => fail('summary', e));
      }
    }

    // ── hooks ──
    function onIngest(env, { conversation_id: cid, session_id: sid } = {}) {
      if (!isPlain(env) || typeof cid !== 'string' || env.event !== 'PostToolUse') return;
      try {
        const tool = isPlain(env.tool) ? env.tool : null;
        if (!tool || tool.name !== 'Workflow' || isPlain(env.agent)) return;
        const fields = isPlain(env.result) && isPlain(env.result.fields) ? env.result.fields : null;
        if (!fields) return;
        noteRun({
          id: fields.taskId, runId: fields.runId, cid, sid, toolUseId: str(tool.use_id),
          title: str(fields.workflowName), at: finite(env.ts) ? env.ts : null,
        });
      } catch (e) { fail('ingest', e); }
    }

    function onConversation(ev) {
      if (!isPlain(ev) || !isPlain(ev.conversation) || typeof ev.conversation.id !== 'string') return;
      const cid = ev.conversation.id;
      try {
        if (ev.change === 'ended') {
          const at = finite(ev.at) ? ev.at : (finite(ev.conversation.ended_at) ? ev.conversation.ended_at : now());
          for (const rec of [...recs.values()]) {
            if (rec.cid === cid && rec.status === 'running') end(rec, 'stopped', { at, stoppedBy: 'session-end', by: 'session-end' });
          }
        } else if (ev.change === 'merged' && typeof ev.merged_into === 'string') {
          for (const rec of [...recs.values()]) {
            if (rec.cid !== cid) continue;
            rec.cid = ev.merged_into;
            publish(rec);
          }
        } else if (ev.change === 'removed') {
          for (const rec of [...recs.values()]) if (rec.cid === cid) forget(rec);
        }
      } catch (e) { fail('conversation', e); }
    }

    // ── the workflow agents the agents source streams ──
    function workflowAgent(agentId) {
      for (const rec of recs.values()) {
        const key = rec.byAgent.get(agentId);
        const a = key ? rec.agents.get(key) : null;
        if (!a) continue;
        const current = a.agentId === agentId;
        const state = current ? agentState(rec, a) : 'error';
        const out = {
          sid: rec.sid, runId: rec.runId, title: a.label || 'Agent',
          status: state === 'running' ? 'running' : state === 'done' ? 'done' : 'failed',
          started_at: a.startedAt, tools: current && a.fold ? a.fold.tools : 0,
          model: current && a.fold ? a.fold.model : null,
        };
        if (state !== 'running' && finite(a.endedAt)) out.ended_at = a.endedAt;
        return out;
      }
      return null;
    }

    // ── the api ──
    // A run whose journal is not followed is read once more, whole.
    function readJournalOnce(rec) {
      if (rec.journal || rec.journalRead) return;
      rec.journalRead = true;
      const at = runDirOf(rec);
      const f = at ? fenced(at.dir, path.join(at.run, 'journal.jsonl')) : null;
      if (!f) return;
      const got = readLines(engine, f, 0);
      if (!got.recs.length) return;
      const prior = new Map([...rec.agents].map(([k, a]) => [k, a]));
      resetAgents(rec);
      applyJournal(rec, got.recs);
      for (const [k, a] of rec.agents) {
        const was = prior.get(k);
        if (was && was.agentId === a.agentId) {
          a.startedAt = was.startedAt;
          if (finite(was.endedAt)) a.endedAt = was.endedAt;
          if (was.fold) a.fold = was.fold;
          if (!a.label && was.label) a.label = was.label;
          if (!a.phase && was.phase) a.phase = was.phase;
        }
        if (at && (!a.label || !a.phase)) { readMeta(at, a); notePhase(rec, a.phase); }
      }
      publish(rec);
    }

    // A finished agent's stats, read once.
    function statsOf(rec, a) {
      if (a.fold || a.tail || a.statsRead) return;
      a.statsRead = true;
      const at = runDirOf(rec);
      const f = at ? fenced(at.dir, path.join(at.run, `agent-${a.agentId}.jsonl`)) : null;
      if (!f) return;
      const got = readLines(engine, f, 0);
      a.fold = foldAgentRecords(null, got.recs);
      if (finite(a.fold.first_ts)) a.startedAt = a.fold.first_ts;
      if (a.state !== 'running' && finite(a.fold.last_ts)) a.endedAt = a.fold.last_ts;
    }

    async function detail(id) {
      const rec = recOf(id);
      if (!rec || rec.gone) return null;
      readJournalOnce(rec);
      const list = phaseList(rec);
      const states = phaseStates(rec);
      const agents = [];
      for (const a of rec.agents.values()) {
        statsOf(rec, a);
        const state = agentState(rec, a);
        const out = {
          agent_id: a.agentId, key: a.key, label: a.label || null, phase: a.phase || null, state, attempt: a.attempt,
          tools: a.fold ? a.fold.tools : 0, last_tool: a.fold ? a.fold.last_tool : null, model: a.fold ? a.fold.model : null,
          started_at: a.startedAt,
        };
        if (state !== 'running' && finite(a.endedAt)) out.ended_at = a.endedAt;
        if (a.resultPreview) out.result_preview = a.resultPreview;
        agents.push(out);
      }
      const row = engine.model.serializeTask(rec.id);
      if (!row) return null;
      return { workflow: row, phases: list.map((title, i) => ({ title, state: states[i] })), agents };
    }

    // ── persistence ──
    function persistState(sessionId) {
      const rows = [];
      for (const rec of recs.values()) {
        if (rec.sid !== sessionId || rec.gone) continue;
        const r = {
          id: rec.id, kind: 'workflow', run_id: rec.runId, cid: rec.cid, title: rec.title, status: rec.status,
          started_at: rec.startedAt, tool_use_id: rec.toolUseId, turn_id: rec.turnId,
          phases: rec.phases ? [...rec.phases] : null, seen: [...rec.seen], journal: rec.resume || null,
          agents: [...rec.agents.values()].slice(0, AGENTS_MAX).map((a) => {
            const o = {
              key: a.key, agent_id: a.agentId, attempt: a.attempt, label: a.label, phase: a.phase, state: a.state,
              started_at: a.startedAt,
            };
            if (finite(a.endedAt)) o.ended_at = a.endedAt;
            if (a.fold) { o.tools = a.fold.tools; if (a.fold.model) o.model = a.fold.model; }
            return o;
          }),
          ended_by: rec.endedBy || null,
        };
        if (finite(rec.endedAt)) r.ended_at = rec.endedAt;
        if (rec.stoppedBy) r.stopped_by = rec.stoppedBy;
        if (rec.ends.size) r.ends = [...rec.ends].slice(-8);
        rows.push(r);
      }
      rows.sort((a, b) => ((a.status === 'running') === (b.status === 'running')
        ? (b.ended_at || b.started_at || 0) - (a.ended_at || a.started_at || 0)
        : (a.status === 'running' ? -1 : 1)));
      return { v: STATE_VERSION, rows: rows.slice(0, PERSIST_ROWS_MAX) };
    }

    function restoreState(sessionId, value) {
      if (!isPlain(value) || value.v !== STATE_VERSION || !Array.isArray(value.rows)) return;
      for (const r of value.rows) {
        try { restoreRow(sessionId, r); } catch (e) { fail('restore', e); }
      }
    }

    function restoreRow(sessionId, r) {
      if (!isPlain(r)) return;
      const id = safeId(r.id);
      const runId = safeId(r.run_id);
      const cid = str(r.cid);
      if (!id || !runId || !cid || recs.has(id) || byRun.has(runId)) return;
      const rec = newRec({ id, runId, cid, sid: sessionId, toolUseId: str(r.tool_use_id), at: finite(r.started_at) ? r.started_at : null });
      rec.title = str(r.title) ? cut(r.title, TITLE_MAX) : null;
      rec.status = TERMINAL.has(r.status) || r.status === 'running' ? r.status : 'running';
      rec.endedAt = finite(r.ended_at) ? r.ended_at : null;
      rec.stoppedBy = r.stopped_by === 'claude' || r.stopped_by === 'session-end' ? r.stopped_by : null;
      rec.endedBy = str(r.ended_by);
      rec.turnId = str(r.turn_id);
      if (Array.isArray(r.phases)) rec.phases = r.phases.filter((t) => typeof t === 'string').slice(0, PHASES_MAX);
      if (Array.isArray(r.seen)) rec.seen = r.seen.filter((t) => typeof t === 'string').slice(0, PHASES_MAX);
      rec.scriptTried = Boolean(rec.phases && rec.phases.length);
      rec.launchRead = true;
      if (isPlain(r.journal)) rec.resume = r.journal;
      if (Array.isArray(r.ends)) for (const k of r.ends) if (typeof k === 'string') rec.ends.add(k);
      for (const o of Array.isArray(r.agents) ? r.agents.slice(0, AGENTS_MAX) : []) {
        if (!isPlain(o) || !safeId(o.agent_id) || !str(o.key)) continue;
        const a = {
          key: o.key, agentId: o.agent_id, attempt: Number.isSafeInteger(o.attempt) && o.attempt > 0 ? o.attempt : 1,
          label: str(o.label), phase: str(o.phase), state: ['running', 'done', 'error'].includes(o.state) ? o.state : 'running',
          startedAt: finite(o.started_at) ? o.started_at : rec.startedAt, endedAt: finite(o.ended_at) ? o.ended_at : null,
          resultPreview: null, fold: null, tail: null, statsRead: false, metaTries: 0,
        };
        if (Number.isSafeInteger(o.tools)) a.fold = { tools: o.tools, last_tool: null, model: str(o.model), first_ts: null, last_ts: null, prompt_preview: null };
        rec.agents.set(a.key, a);
        rec.byAgent.set(a.agentId, a.key);
      }
      publish(rec);
      if (!started) return;
      if (rec.status === 'running') {
        if (conversationEnded(cid)) endedIn(rec);
        else begin(rec);
      } else armKeep(rec);
    }

    // ── lifecycle ──
    async function start() {
      if (started) return;
      started = true;
      shared.setWorkflowAgents(workflowAgent);
      offFree = shared.onFree(pumpWaiting);
      for (const rec of [...recs.values()]) {
        if (rec.gone) continue;
        if (rec.status === 'running') {
          if (rec.deferred) armSettle(rec.cid);
          else begin(rec);
        } else armKeep(rec);
      }
    }

    async function stop() {
      if (!started) return;
      started = false;
      if (offFree) { offFree(); offFree = null; }
      const stops = [];
      for (const rec of recs.values()) {
        if (rec.journal) { stops.push(rec.journal); rec.journal = null; tails -= 1; }
        for (const a of rec.agents.values()) {
          if (a.tail) { stops.push(a.tail); a.tail = null; tails -= 1; shared.release(); }
        }
        clearTimer(rec, 'keep');
        clearTimer(rec, 'poll');
      }
      for (const h of settles.values()) { try { engine.timers.clearTimeout(h); } catch { /* gone */ } }
      settles.clear();
      await Promise.all(stops.map((t) => Promise.resolve().then(() => t.stop()).catch(() => {})));
    }

    function diagnostics() {
      let running = 0;
      for (const rec of recs.values()) if (rec.status === 'running') running += 1;
      return { workflows: { running, tails } };
    }

    return {
      start,
      stop,
      onIngest,
      onChanges,
      onConversation,
      persistState,
      restoreState,
      diagnostics,
      api: { detail },
    };
  }

  return { attach };
}

module.exports = {
  createWorkflowsSource,
  phaseTitles,
  AGENT_POLL_MS,
  JOURNAL_POLL_MS,
  AGENT_TAILS_MAX,
  STREAMS_MAX,
  STREAM_IDLE_MS,
  STREAM_LIMIT_MAX,
  FINISHED_KEEP_MS,
  LINE_MAX,
  STATE_VERSION,
};
