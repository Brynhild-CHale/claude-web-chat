// lib/server/mirror/tasks.js — the tasks source: background shells and monitors
// as TaskRows, their live line, their bounded output, and the generic
// stop-request mark (spec §2.5 "Shells and monitors", §2.6, §2.10, §2.12, §5.5,
// §5.6, §6.9).
//
//   createTasksSource({pollMs = POLL_MS}) → {attach(engine)}
//   attach(engine) → {start, stop, onIngest, onChanges, onConversation,
//                     persistState, restoreState, diagnostics,
//                     api: {output, markStopRequested}}
//
// A source per the contract at the head of lib/server/mirror/index.js. U51 adds
// `{name: 'tasks', attach: createTasksSource().attach}` to SOURCES; the facade's
// DISPATCH routes taskOutput → api.output (async) and markStopRequested →
// api.markStopRequested (sync).
//
// ROWS. kind 'shell' | 'monitor', written only through engine.model.upsertTask
// and removeTask (the model redacts the title and the line on the way in, and
// never makes a finished row running again). A row's id is Claude Code's own
// task id — the one TaskStop takes and a notification's <task-id> names (a
// shell's backgroundTaskId, a monitor's task id). The row is §2.10's TaskRow:
//   {id, conversation_id, kind, title, status, stopped_by?, stop_requested_at?,
//    started_at, ended_at?, exit_code?, line, meta: {port?, events?,
//    last_event_at?, no_output_yet?}, owner?: {agent_id, title}, turn_id,
//    tool_use_id, can: {output, open, stop}}
// It never carries the output path, the command, or a field named like a
// credential (the read boundary's json-key rule would mask it whole). The fenced
// path, the command (the redaction context), the session and the counted item
// ids live in this source's own state, and in its persisted slice.
//
// STARTS, from either stream, merged on the id (whichever lands first makes the
// row, the other fills it in):
//   * onChanges — the transcripts source's raw batch: a Bash tool_call made
//     with run_in_background, or whose result carries links.task_id (an
//     auto-backgrounded call, Ctrl+B; that id wins), with a start sentence in
//     its preview (bgStartOf: BG_START_RE's two wordings, or Claude Code
//     2.1.296's AUTO_BG_RE "… was moved to the background (ID: <id>). Output is
//     being written to: <path>.output. …", which also starts a row unlinked
//     when the preview OPENS with it) — a foreground call quoting a sentence
//     starts nothing; a Monitor whose result says MONITOR_START_RE (or carries
//     links.task_id);
//   * onIngest — a PostToolUse whose result.fields carries backgroundTaskId
//     (a Monitor's: taskId), about half a second before the transcript (V1); a
//     call made inside an agent carries owner {agent_id, title}.
// THE OUTPUT PATH is only ever read out of text: the start sentence's path, else
// result.fields.outputFile, else a notification's <output-file> tag (an idle
// delivery's opener). It is opened only through engine.files.taskOutputFile,
// never derived, and tasks/ is never listed (§2.5, V5). A refused path leaves
// can.output false and the file unopened. Since a hook can name a file before
// Claude Code has made it, a refused candidate is asked about again (never
// opened) at the next start signal, at the no-output check and at a Stop,
// FENCE_RETRIES times at most.
//
// WHILE RUNNING, one engine.watchFile per running row with a fenced path
// (TASKS_WATCH_MAX at most; the rest wait their turn). On each call: the size;
// on a change the last LINE_WINDOW bytes through readWindow, cleaned by
// redactor.window with the command as context, give the line (the last
// non-empty line that is not the footer) and meta.port (PORT_RE, the last match
// of the cleaned window); the growth is progress evidence
// (live.noteActivity(cid, mtimeMs, 'task_output')); and the last FOOTER_BYTES
// bytes, matched by FOOTER_RE, end the row: [exited with code 0] → done,
// another code → failed, [killed] → killed. 0 bytes NO_OUTPUT_MS after
// started_at sets meta.no_output_yet; growth clears it.
//
// ENDS, the first wins: the footer; a task item ({kind: 'task'}, carriers.js)
// naming the row → its status and exit code; a TaskStop call's result
// (STOPPED_RE, only on a TaskStop; its input's task_id must agree) → killed, stopped_by 'claude'; the registry's 'ended' → stopped,
// stopped_by 'session-end' (a SessionEnd for /clear or resume ends nothing:
// background tasks outlive /clear, V5). A monitor's event (a running task
// item with <event>) adds one to meta.events and sets last_event_at and the
// line; its expired notice ends it 'expired', its end notification 'done'. A
// task item is counted ONCE, by its item id: a catch-up hands the same items
// again. stopped_by is set only from a signal that names it; a bare [killed]
// leaves it unset. A live monitor stays 'running' whatever its age.
// A SUBAGENT'S TASKS END WITH IT: Claude Code terminates the background tasks a
// subagent (an Agent-tool agent or a workflow agent) started when it gives its
// final response, and no notification follows. So a SubagentStop envelope for
// agent X — any agent id, an internal agent with no type included — ends every
// running row whose owner.agent_id is X: one footer read when its path is known
// (the footer's status wins), else 'stopped' with stopped_by 'agent-end'. A
// monitor has no footer and ends the same way. The main session's rows (no
// owner) are never touched: they outlive turns, /clear and resume (V5). An
// agent's end can also be KNOWN without its SubagentStop (a restart, a lost
// hook): the agents source's row for it is finished, or the workflows source's
// lookup (agents.js sharedFor(engine).workflowAgent) says that agent is no
// longer running. While a running row has an owner, every AGENT_SWEEP_MS the
// source asks; a known end ends the row as above, at the known time. A RESTORED
// running row whose owner no source knows and that has fired no hook since,
// AGENT_UNKNOWN_GRACE_MS after its restore, gets the same footer read and then
// ends 'stopped' (agent-end) — or, when it started more than FINISHED_KEEP_MS
// ago, is removed: an agent alive across a restart is known to its source, or
// fires a hook, and an agent no one knows has long ended. Stop's
// background_tasks reconciles the conversation: a running row missing from the
// list gets one footer read now, a listed shell or monitor id with no row makes
// one (no path: can.output false). Finished rows are removed FINISHED_KEEP_MS
// after ended_at.
//
// A start a catch-up replays is checked once (one footer read) before any
// watch: a file that already ends is ended at its mtime, and removed at once
// when that is more than FINISHED_KEEP_MS ago; in an ended conversation a
// missing file removes the row, and a file with no footer ends it 'stopped'.
//
// api.output(id, {from, max, tail}) → {task_id, text, from, to, size, eof,
// ended, footer, exit_code?} | null: one bounded readWindow, cleaned by
// redactor.window with the command as context; `to` is the window's `next`, so
// a pager passing it back as `from` loses no line (U21). Never the path. The
// facade's redactOut runs after it.
//
// api.markStopRequested(taskId), synchronous and generic over the model's rows
// (a shell, a monitor, and U42's agents and workflows alike): a running row gets
// stop_requested_at = engine.now() and comes back serialized; an unknown or
// finished one answers null. The 60-second "stop not confirmed" is the chrome's.
//
// LIFECYCLE. A hook can arrive before start(): rows are kept and watched once
// started. stop() stops every watch and clears every timer this source set, and
// keeps the rows (the transcripts source, which stops after this one, asks for
// the persisted slice at its own stop); start() re-arms them. A conversation
// 'removed' (pruned, or web-chat switched off) forgets its rows.
//
// It never stops or signals a process (§2.1).
//
// Dependency direction: lib/server/mirror; imports fs and its sibling
// carriers.js (parseNotifications); its sibling agents.js (sharedFor, the
// per-mirror lookup of a workflow agent) is required lazily, at attach, since
// agents.js requires this file for stoppedTaskId.

const fs = require('fs');
const { parseNotifications } = require('./carriers');

// ── constants ────────────────────────────────────────────────────────────────

const POLL_MS = 2000;
const NO_OUTPUT_MS = 5000;
const FINISHED_KEEP_MS = 30 * 60 * 1000;
const OUTPUT_MAX = 262144;
const LINE_WINDOW = 4096;
const FOOTER_BYTES = 64;
const TASKS_WATCH_MAX = 64;
const STATE_VERSION = 1;
// The persisted slice's bounds: rows per session, counted item ids per row.
const PERSIST_ROWS_MAX = 64;
const COUNTED_MAX = 256;
// Tool calls remembered between a tool_use and its result.
const CALLS_MAX = 512;
// How often a refused output path is asked about again.
const FENCE_RETRIES = 5;
const LINE_MAX = 300;
const TITLE_MAX = 300;
// How often running rows of a subagent ask whether it is known to have ended,
// how long a restored row of an agent nobody knows waits for a sign of life,
// and how many agent ids this source remembers (ended, and seen alive).
const AGENT_SWEEP_MS = 5000;
const AGENT_UNKNOWN_GRACE_MS = 15000;
const AGENTS_MAX = 512;

// `Command running in background with ID: <id>. Output is being written to:
// <path>.` (V5); Ctrl+B's `Command was manually backgrounded by user with ID:
// <id>. …` takes the same sentence's tail.
const BG_START_RE = /(?:Command running in background|Command was manually backgrounded by user) with ID: ([A-Za-z0-9_-]{1,64})\.(?:\s+Output is being written to: (\S(?:[^\n]*?\S)?\.output)\.?)?/;
// Claude Code 2.1.296's auto-background: `Command did not complete within its
// 120s timeout and was moved to the background (ID: <id>). Output is being
// written to: <path>.output. If it exits while you are still working …`.
const AUTO_BG_RE = /was moved to the background \(ID: ([A-Za-z0-9_-]{1,64})\)\.(?:\s+Output is being written to: (\S(?:[^\n]*?\S)?\.output)\.?)?/;
// The same sentence opening a result: what lets a call with no links start a row.
const AUTO_BG_LEAD_RE = /^\s*Command did not complete within its [^\n]{1,40}? timeout and was moved to the background \(ID: /;
// `Monitor started (task <id>, expires in …)` (V6).
const MONITOR_START_RE = /Monitor started \(task ([A-Za-z0-9_-]{1,64})[,)]/;
// A TaskStop's result: `Successfully stopped task: <id> (<command>)` (V6).
const STOPPED_RE = /Successfully stopped task: ([A-Za-z0-9_-]{1,64})\b/;
// The output file's footer (V5), at its very end.
const FOOTER_RE = /\[(?:exited with code (-?\d{1,4})|killed)\]\s*$/;
// The port hint (the Final's `:5173`).
const PORT_RE = /(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/;

// A line that is the footer and nothing else.
const FOOTER_LINE_RE = /^\[(?:exited with code -?\d{1,4}|killed)\]$/;

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Stop's background_tasks `type`s that are not this source's (U42's rows).
const NOT_MINE_TYPE_RE = /agent|workflow/i;
// The notification statuses Stop's list may carry, onto the TaskRow's.
const LIST_STATUS = Object.freeze({ completed: 'done', done: 'done', failed: 'failed', killed: 'killed', stopped: 'stopped' });
const TERMINAL = new Set(['done', 'failed', 'killed', 'stopped', 'expired']);
// Who a row says stopped it: TaskStop, the conversation's end, its agent's end.
const STOPPED_BY = new Set(['claude', 'session-end', 'agent-end']);
// Terminal escapes and other control characters a line never shows.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v ? v : null);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const taskId = (v) => (typeof v === 'string' && TASK_ID_RE.test(v) ? v : null);

function firstLine(s) {
  if (typeof s !== 'string') return null;
  const line = s.split('\n').map((l) => l.trim()).find(Boolean);
  return line ? line.slice(0, TITLE_MAX) : null;
}

// The footer at the end of a raw window, or null: {text, status, exit_code?}.
function footerOf(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const m = FOOTER_RE.exec(raw.slice(-FOOTER_BYTES));
  if (!m) return null;
  if (m[1] === undefined) return { text: '[killed]', status: 'killed' };
  const code = Number(m[1]);
  return { text: `[exited with code ${m[1]}]`, status: code === 0 ? 'done' : 'failed', exit_code: code };
}

// The last non-empty line of a cleaned window that is not the footer.
function lastLineOf(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].replace(ANSI_RE, '').replace(CONTROL_RE, '').trim();
    if (!l) continue;
    if (FOOTER_LINE_RE.test(l)) continue;
    return l.slice(0, LINE_MAX);
  }
  return null;
}

// A start sentence in a result's text, either wording: {id, path, auto} | null.
// `auto` is 2.1.296's "moved to the background", `lead` that it opens the text.
function bgStartOf(text) {
  if (typeof text !== 'string' || !text) return null;
  let m = BG_START_RE.exec(text);
  if (m) return { id: m[1], path: m[2] || null, auto: false, lead: false };
  m = AUTO_BG_RE.exec(text);
  if (m) return { id: m[1], path: m[2] || null, auto: true, lead: AUTO_BG_LEAD_RE.test(text) };
  return null;
}

// The last port a cleaned window names.
function portOf(text) {
  if (typeof text !== 'string') return null;
  const re = new RegExp(PORT_RE.source, 'g');
  let port = null;
  for (const m of text.matchAll(re)) {
    const n = Number(m[2]);
    if (n > 0 && n <= 65535) port = n;
  }
  return port;
}

// THE TASKSTOP RULE, the one predicate every source applies (U41b; U42's
// agents and workflows call it too): the task a `Successfully stopped task: <id>`
// result stopped, or null. Only a TaskStop call's own result counts — a grep, a
// Read or any other tool whose output quotes the sentence stops nothing — never
// an error result, and when the call's input names a task_id, only that one.
// `call` is {tool, task_id} (the tool_use the result follows), `result` the
// tool_call item's result ({preview, is_error, …}).
function stoppedTaskId(call, result) {
  if (!isPlain(call) || call.tool !== 'TaskStop') return null;
  if (!isPlain(result) || result.is_error === true) return null;
  const m = STOPPED_RE.exec(typeof result.preview === 'string' ? result.preview : '');
  if (!m) return null;
  const named = str(call.task_id);
  if (named && named !== m[1]) return null;
  return m[1];
}

// ── the source ───────────────────────────────────────────────────────────────

function createTasksSource({ pollMs = POLL_MS } = {}) {
  const poll = Number.isSafeInteger(pollMs) && pollMs > 0 ? pollMs : POLL_MS;

  function attach(engine) {
    const recs = new Map(); // task id → this source's record of one row
    const calls = new Map(); // tool_use id → {tool, input}: the tool_use a result follows
    const waiting = []; // running rows waiting for a watch slot (ids, in order)
    let watching = 0;
    let started = false;
    let refusedCount = 0;
    const endedAgents = new Map(); // agent id → when its SubagentStop came
    const seenAgents = new Set(); // agent ids that fired a hook since attach
    let sweepTimer = null;
    let shared = null;

    const now = () => { try { return engine.now(); } catch { return Date.now(); } };
    function fail(stage, e) {
      const word = [e && e.code, e && e.name].find((w) => typeof w === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(w)) || 'Error';
      try { engine.log(`mirror tasks: ${stage} failed (${word})`); } catch { /* never breaks */ }
    }

    // ── a record and its row ──
    function newRec(id, kind, cid, sid, at) {
      const rec = {
        id, kind, cid, sid: sid || null, title: null, status: 'running', stopped_by: null,
        started_at: finite(at) ? at : now(), ended_at: null, exit_code: null,
        line: '', meta: {}, owner: null, turn_id: null, tool_use_id: null,
        path: null, candidate: null, retries: 0, command: null,
        counted: new Set(), size: -1, watch: null, chain: Promise.resolve(),
        noOut: null, keep: null, gone: false, restoredAt: null, agentEnding: false,
      };
      recs.set(id, rec);
      return rec;
    }

    // Another source's row under this id (U42's agent or workflow): never ours.
    function foreign(id) {
      if (recs.has(id)) return false;
      const row = engine.model.task(id);
      return Boolean(row && row.kind !== 'shell' && row.kind !== 'monitor');
    }

    function rowOf(rec) {
      const running = rec.status === 'running';
      const row = {
        id: rec.id,
        conversation_id: rec.cid,
        kind: rec.kind,
        title: rec.title || (rec.kind === 'monitor' ? 'Monitor' : 'Background shell'),
        status: rec.status,
        started_at: rec.started_at,
        line: rec.line || '',
        meta: { ...rec.meta },
        turn_id: rec.turn_id,
        tool_use_id: rec.tool_use_id,
        can: { output: Boolean(rec.path), open: rec.kind === 'monitor', stop: running },
      };
      if (rec.stopped_by) row.stopped_by = rec.stopped_by;
      if (finite(rec.ended_at)) row.ended_at = rec.ended_at;
      if (finite(rec.exit_code)) row.exit_code = rec.exit_code;
      if (rec.owner) row.owner = { ...rec.owner };
      return row;
    }

    function publish(rec) {
      if (rec.gone || !recs.has(rec.id)) return;
      try { engine.model.upsertTask(rowOf(rec)); } catch (e) { fail('upsert', e); }
    }

    function forget(rec) {
      rec.gone = true;
      unwatch(rec);
      clearTimer(rec, 'noOut');
      clearTimer(rec, 'keep');
      recs.delete(rec.id);
      const at = waiting.indexOf(rec.id);
      if (at >= 0) waiting.splice(at, 1);
    }

    function removeRow(rec) {
      forget(rec);
      try { engine.model.removeTask(rec.id); } catch (e) { fail('remove', e); }
    }

    function clearTimer(rec, key) {
      if (rec[key] === null) return;
      try { engine.timers.clearTimeout(rec[key]); } catch { /* gone */ }
      rec[key] = null;
    }

    function conversationEnded(cid) {
      try {
        const v = engine.conversations.get(cid);
        return Boolean(v && finite(v.ended_at));
      } catch { return false; }
    }

    // ── the output path ──
    function adoptPath(rec, raw) {
      if (rec.path || typeof raw !== 'string' || !raw) return;
      let p = null;
      try { p = engine.files.taskOutputFile(raw); } catch { p = null; }
      if (p) {
        rec.path = p;
        rec.candidate = null;
        return;
      }
      if (rec.candidate !== raw) { rec.candidate = raw; rec.retries = 0; refusedCount += 1; }
    }
    // A refused candidate is asked about again (lstat only, never opened).
    // Answers whether the fence took it this time.
    function retryFence(rec) {
      if (rec.path || !rec.candidate || rec.retries >= FENCE_RETRIES) return false;
      rec.retries += 1;
      const raw = rec.candidate;
      rec.candidate = null;
      adoptPath(rec, raw);
      if (!rec.path) rec.candidate = raw;
      return Boolean(rec.path);
    }

    // ── a start, from either stream ──
    function noteStart(s) {
      const id = taskId(s.id);
      if (!id || !s.cid || foreign(id)) return null;
      let rec = recs.get(id);
      const fresh = !rec;
      if (fresh) rec = newRec(id, s.kind, s.cid, s.sid, s.at);
      if (!rec.sid && s.sid) rec.sid = s.sid;
      if (s.kind === 'monitor') rec.kind = 'monitor';
      if (s.title && (!rec.title || s.titleFromDescription)) rec.title = s.title.slice(0, TITLE_MAX);
      if (s.command && !rec.command) rec.command = s.command;
      if (s.tool_use_id && !rec.tool_use_id) rec.tool_use_id = s.tool_use_id;
      if (s.owner && !rec.owner) rec.owner = s.owner;
      if (finite(s.at) && s.at < rec.started_at) rec.started_at = s.at;
      const own = itemTurnOf(rec.tool_use_id);
      if (own) rec.turn_id = own;
      else if (!rec.turn_id) rec.turn_id = openTurnOf(rec.cid);
      const hadPath = Boolean(rec.path);
      if (s.path) adoptPath(rec, s.path);
      else retryFence(rec);
      publish(rec);
      // A start heard after its agent's end (a late hook): it ended with it.
      if (rec.status === 'running' && rec.owner && endedAgents.has(rec.owner.agent_id)) {
        endWithAgent(rec, endedAgents.get(rec.owner.agent_id));
        return rec;
      }
      if (rec.owner) armSweep();
      if (rec.status === 'running' && rec.path && !hadPath) begin(rec);
      else if (fresh && rec.status === 'running' && !rec.path && conversationEnded(rec.cid)) removeRow(rec);
      else if (rec.status === 'running' && !rec.path && rec.candidate && started) armNoOutput(rec);
      return rec;
    }

    // The turn of the call that started the task (onChanges runs after the
    // turn machine applied the batch), else the conversation's open turn.
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

    // ── watching ──
    // One check first (a catch-up's start may already be over), then a watch.
    function begin(rec) {
      if (!started || rec.gone || rec.status !== 'running' || !rec.path) return;
      armNoOutput(rec);
      enqueueCheck(rec).then(() => {
        if (!started || rec.gone || rec.status !== 'running' || !rec.path || rec.watch) return;
        if (conversationEnded(rec.cid)) { endIn(rec); return; }
        if (watching >= TASKS_WATCH_MAX) {
          if (!waiting.includes(rec.id)) waiting.push(rec.id);
          return;
        }
        watch(rec);
      }, (e) => fail('begin', e));
    }

    function watch(rec) {
      let w = null;
      try { w = engine.watchFile(rec.path, () => enqueueCheck(rec), { pollMs: poll }); } catch (e) { fail('watch', e); }
      if (!w) return;
      rec.watch = w;
      watching += 1;
      Promise.resolve(w.trigger('start')).catch(() => {});
    }

    function unwatch(rec) {
      const w = rec.watch;
      if (!w) return;
      rec.watch = null;
      watching -= 1;
      // Never awaited: the watch may be waiting on the very call making this one.
      Promise.resolve().then(() => w.stop()).catch(() => {});
      while (started && waiting.length && watching < TASKS_WATCH_MAX) {
        const next = recs.get(waiting.shift());
        if (next && !next.gone && next.status === 'running' && next.path && !next.watch) watch(next);
      }
    }

    function enqueueCheck(rec) {
      const p = rec.chain.then(() => check(rec)).catch((e) => fail('check', e));
      rec.chain = p;
      return p;
    }

    // One look at the file: its size and, on a change, its tail and footer.
    async function check(rec) {
      if (rec.gone || !rec.path) return;
      const p = engine.files.taskOutputFile(rec.path);
      let st = null;
      if (p) { try { st = await fs.promises.lstat(p); } catch { st = null; } }
      if (rec.gone) return;
      if (!p || !st || !st.isFile()) { lost(rec); return; }
      const size = st.size;
      if (size === rec.size) return;
      const prev = rec.size;
      rec.size = size;
      if (size === 0) return;
      const w = engine.files.readWindow(p, { fromEnd: true, maxBytes: LINE_WINDOW });
      if (!w || rec.gone) return;
      const clean = engine.redactor.window(w.text, { startsMidFile: w.startsMidFile, complete: w.complete, context: contextOf(rec) });
      const line = lastLineOf(clean);
      if (line) rec.line = line;
      const port = portOf(clean);
      if (port) rec.meta.port = port;
      if (rec.meta.no_output_yet) rec.meta.no_output_yet = false;
      if (size > prev) {
        try { engine.live.noteActivity(rec.cid, Math.round(st.mtimeMs), 'task_output'); } catch (e) { fail('activity', e); }
      }
      const footer = footerOf(w.text);
      if (footer && rec.status === 'running') {
        end(rec, footer.status, { exit_code: footer.exit_code, ended_at: Math.round(st.mtimeMs) });
        return;
      }
      publish(rec);
    }

    // The fenced file went away, or the fence refuses it now.
    function lost(rec) {
      unwatch(rec);
      rec.path = null;
      if (rec.status === 'running' && conversationEnded(rec.cid)) { removeRow(rec); return; }
      publish(rec);
    }

    function contextOf(rec) {
      return rec.command ? { command: rec.command } : {};
    }

    // NO_OUTPUT_MS after the start: a file still empty is said so. A row whose
    // path the fence refused so far asks about it again then instead.
    function armNoOutput(rec) {
      if (rec.noOut !== null || rec.meta.no_output_yet !== undefined || rec.status !== 'running') return;
      const delay = Math.max(0, rec.started_at + NO_OUTPUT_MS - now());
      rec.noOut = engine.timers.setTimeout(() => {
        rec.noOut = null;
        if (rec.gone || rec.status !== 'running') return;
        if (!rec.path) {
          if (retryFence(rec)) { publish(rec); begin(rec); }
          return;
        }
        enqueueCheck(rec).then(() => {
          if (rec.gone || rec.status !== 'running' || rec.size !== 0) return;
          rec.meta.no_output_yet = true;
          publish(rec);
        }, () => {});
      }, delay);
    }

    // ── ends ──
    function end(rec, status, { exit_code, ended_at, stopped_by, line } = {}) {
      if (rec.status !== 'running' || !TERMINAL.has(status)) return false;
      rec.status = status;
      rec.ended_at = finite(ended_at) ? ended_at : now();
      if (finite(exit_code)) rec.exit_code = exit_code;
      if (stopped_by) rec.stopped_by = stopped_by;
      if (typeof line === 'string' && line) rec.line = line.slice(0, LINE_MAX);
      unwatch(rec);
      clearTimer(rec, 'noOut');
      publish(rec);
      armKeep(rec);
      return true;
    }

    // A running row of an ended conversation, once its file had its say.
    function endIn(rec) {
      let at = null;
      try { const v = engine.conversations.get(rec.cid); at = v && finite(v.ended_at) ? v.ended_at : null; } catch { at = null; }
      end(rec, 'stopped', { stopped_by: 'session-end', ended_at: at === null ? now() : Math.max(at, rec.started_at) });
    }

    function armKeep(rec) {
      clearTimer(rec, 'keep');
      if (!started || rec.status === 'running' || !finite(rec.ended_at)) return;
      const delay = rec.ended_at + FINISHED_KEEP_MS - now();
      if (delay <= 0) { removeRow(rec); return; }
      rec.keep = engine.timers.setTimeout(() => { rec.keep = null; if (!rec.gone) removeRow(rec); }, delay);
    }

    // ── a subagent's end ──
    function bounded(coll, key, value) {
      if (coll.has(key)) coll.delete(key);
      if (coll instanceof Map) coll.set(key, value); else coll.add(key);
      while (coll.size > AGENTS_MAX) coll.delete(coll.keys().next().value);
    }

    const ownedRunning = (rec) => !rec.gone && rec.status === 'running' && Boolean(rec.owner);

    // SubagentStop: every running row the agent started has ended with it.
    function agentEnded(agentId, at) {
      bounded(endedAgents, agentId, at);
      seenAgents.delete(agentId);
      for (const rec of [...recs.values()]) {
        if (ownedRunning(rec) && rec.owner.agent_id === agentId) endWithAgent(rec, at);
      }
    }

    // One footer read when the path is known (its status wins), else — or when
    // the file says nothing — 'stopped' by 'agent-end'. `removeIfOld` (a
    // restored row of an agent nobody knows) removes a row started more than
    // FINISHED_KEEP_MS ago instead of ending it.
    function endWithAgent(rec, at, { removeIfOld = false } = {}) {
      if (rec.gone || rec.status !== 'running' || rec.agentEnding) return;
      rec.agentEnding = true;
      const when = Math.max(finite(at) ? at : now(), rec.started_at);
      const settle = () => {
        rec.agentEnding = false;
        if (rec.gone || rec.status !== 'running') return;
        if (removeIfOld && rec.started_at + FINISHED_KEEP_MS <= now()) { removeRow(rec); return; }
        end(rec, 'stopped', { stopped_by: 'agent-end', ended_at: when });
      };
      retryFence(rec);
      if (!rec.path) { settle(); return; }
      finalRead(rec).then((got) => {
        if (got && !rec.gone && rec.status === 'running') {
          rec.agentEnding = false;
          end(rec, got.status, { exit_code: got.exit_code, ended_at: got.at });
          return;
        }
        settle();
      }, (e) => { fail('final read', e); settle(); });
    }

    // The file's tail read once, whatever its size was: the line, and the footer
    // ({status, exit_code?, at: its mtime}) or null. Serialized with the watch's
    // checks.
    function finalRead(rec) {
      const p = rec.chain.then(async () => {
        if (rec.gone || !rec.path) return null;
        const f = engine.files.taskOutputFile(rec.path);
        let st = null;
        if (f) { try { st = await fs.promises.lstat(f); } catch { st = null; } }
        if (rec.gone || !f || !st || !st.isFile() || st.size === 0) return null;
        const w = engine.files.readWindow(f, { fromEnd: true, maxBytes: LINE_WINDOW });
        if (!w || rec.gone) return null;
        rec.size = st.size;
        const clean = engine.redactor.window(w.text, { startsMidFile: w.startsMidFile, complete: w.complete, context: contextOf(rec) });
        const line = lastLineOf(clean);
        if (line) rec.line = line;
        const footer = footerOf(w.text);
        return footer ? { status: footer.status, exit_code: footer.exit_code, at: Math.round(st.mtimeMs) } : null;
      });
      rec.chain = p.then(() => {}, () => {});
      return p;
    }

    // What the other sources know of an agent: {ended: true, at?} | {ended:
    // false} | null (nobody knows it).
    function sharedLookup() {
      if (shared) return shared;
      try { shared = require('./agents').sharedFor(engine); } catch (e) { fail('shared', e); shared = null; }
      return shared;
    }
    function knownEnd(agentId) {
      if (endedAgents.has(agentId)) return { ended: true, at: endedAgents.get(agentId) };
      let row = null;
      try { row = engine.model.task(agentId); } catch { row = null; }
      if (row && row.kind === 'agent') {
        if (row.status === 'running') return { ended: false };
        if (TERMINAL.has(row.status)) return { ended: true, at: finite(row.ended_at) ? row.ended_at : null };
      }
      const s = sharedLookup();
      const wf = s ? s.workflowAgent(agentId) : null;
      if (wf) return wf.status === 'running' ? { ended: false } : { ended: true, at: finite(wf.ended_at) ? wf.ended_at : null };
      return null;
    }

    function armSweep() {
      if (!started || sweepTimer !== null) return;
      let any = false;
      for (const rec of recs.values()) if (ownedRunning(rec)) { any = true; break; }
      if (!any) return;
      sweepTimer = engine.timers.setTimeout(() => {
        sweepTimer = null;
        try { sweep(); } catch (e) { fail('sweep', e); }
        armSweep();
      }, AGENT_SWEEP_MS);
    }

    function sweep() {
      const t = now();
      for (const rec of [...recs.values()]) {
        if (!ownedRunning(rec) || rec.agentEnding) continue;
        const agentId = rec.owner.agent_id;
        const known = knownEnd(agentId);
        if (known && known.ended) { endWithAgent(rec, finite(known.at) ? known.at : t); continue; }
        if (known || rec.restoredAt === null || seenAgents.has(agentId)) continue;
        if (t - rec.restoredAt >= AGENT_UNKNOWN_GRACE_MS) endWithAgent(rec, t, { removeIfOld: true });
      }
    }

    // ── the transcript's batch ──
    function onChanges(sessionId, changes, { conversation_id: cid } = {}) {
      if (!Array.isArray(changes) || typeof cid !== 'string') return;
      for (const ch of changes) {
        if (!isPlain(ch)) continue;
        try {
          if (ch.type === 'item' && isPlain(ch.item)) itemChange(sessionId, cid, ch);
          else if (ch.type === 'opener' && ch.kind === 'task-notification') openerChange(ch);
        } catch (e) { fail('change', e); }
      }
    }

    function remember(id, info) {
      if (calls.has(id)) calls.delete(id);
      calls.set(id, info);
      while (calls.size > CALLS_MAX) calls.delete(calls.keys().next().value);
    }

    function itemChange(sid, cid, ch) {
      const it = ch.item;
      if (it.kind === 'task') { taskItem(cid, ch, it); return; }
      if (it.kind !== 'tool_call' || typeof it.id !== 'string') return;
      if (typeof it.tool === 'string') {
        const input = isPlain(it.input) ? it.input : {};
        remember(it.id, { tool: it.tool, description: str(input.description), command: str(input.command), background: input.run_in_background === true, task_id: str(input.task_id), at: finite(ch.ts) ? ch.ts : null });
      }
      if (!isPlain(it.result)) return;
      const preview = typeof it.result.preview === 'string' ? it.result.preview : '';
      if (it.result.is_error === true) return;
      const call = calls.get(it.id) || fromModel(it.id);
      if (!call) return;
      // Only a TaskStop's own result stops a row (§2.5): a grep or cat whose
      // output quotes the sentence is not a stop. When the call names its
      // task_id, the sentence must name the same one.
      if (call.tool === 'TaskStop') {
        const stopped = stoppedTaskId(call, it.result);
        const rec = stopped ? recs.get(stopped) : null;
        if (rec) end(rec, 'killed', { stopped_by: 'claude', ended_at: finite(ch.ts) ? ch.ts : now() });
        return;
      }
      const links = isPlain(it.links) ? it.links : {};
      const command = (isPlain(ch.context) && str(ch.context.command)) || call.command;
      const base = {
        cid, sid, tool_use_id: it.id, command,
        title: call.description || firstLine(call.command), titleFromDescription: Boolean(call.description),
        at: call.at !== null && call.at !== undefined ? call.at : (finite(ch.ts) ? ch.ts : null),
      };
      if (call.tool === 'Bash') {
        // Only a call that went to the background starts a row: run_in_background,
        // or a result that names its task (links.task_id). A foreground call
        // whose output merely quotes the sentence (a grep over transcripts) is
        // not a start. links.task_id is the id; a sentence naming another is
        // ignored, path and all.
        // 2.1.296's auto-background sentence opening the result is a start
        // even with no links (a transcript that records no toolUseResult).
        const linked = taskId(links.task_id);
        let m = bgStartOf(preview);
        if (!call.background && !linked && !(m && m.auto && m.lead)) return;
        if (m && linked && m.id !== linked) m = null;
        const id = linked || (m && m.id);
        if (id) noteStart({ ...base, id, kind: 'shell', path: m && m.path ? m.path : null });
      } else if (call.tool === 'Monitor') {
        const m = MONITOR_START_RE.exec(preview);
        const id = (m && m[1]) || taskId(links.task_id);
        if (id) noteStart({ ...base, id, kind: 'monitor', path: null });
      }
    }

    function fromModel(id) {
      try {
        const it = engine.model.item(id);
        if (!it || typeof it.tool !== 'string') return null;
        const input = isPlain(it.input) ? it.input : {};
        return { tool: it.tool, description: str(input.description), command: str(input.command), background: input.run_in_background === true, task_id: str(input.task_id), at: finite(it.started_at) ? it.started_at : null };
      } catch { return null; }
    }

    // A notification's task item, counted once by its item id.
    function taskItem(cid, ch, it) {
      const rec = recs.get(typeof it.task_id === 'string' ? it.task_id : '');
      if (!rec || typeof it.id !== 'string' || rec.counted.has(it.id)) return;
      rec.counted.add(it.id);
      while (rec.counted.size > COUNTED_MAX) rec.counted.delete(rec.counted.values().next().value);
      const at = finite(ch.ts) ? ch.ts : now();
      const status = typeof it.status === 'string' ? it.status : 'unknown';
      const event = typeof it.event === 'string' ? it.event : null;
      if (event !== null && (rec.kind === 'monitor' || it.task_kind === 'monitor')) {
        if (status === 'running') {
          rec.meta.events = (finite(rec.meta.events) ? rec.meta.events : 0) + 1;
          rec.meta.last_event_at = at;
          const line = lastLineOf(event);
          if (line) rec.line = line;
          if (rec.status === 'running') publish(rec);
          return;
        }
        if (TERMINAL.has(status)) end(rec, status, { ended_at: at, exit_code: it.exit_code, line: lastLineOf(event) });
        return;
      }
      if (TERMINAL.has(status)) end(rec, status, { ended_at: at, exit_code: it.exit_code });
    }

    // An idle delivery's opener: its <output-file> names a row's path.
    function openerChange(ch) {
      for (const n of parseNotifications(ch.text)) {
        const rec = recs.get(n.tags['task-id'] || '');
        const raw = n.tags['output-file'];
        if (!rec || rec.path || !raw) continue;
        adoptPath(rec, raw);
        if (rec.path) {
          publish(rec);
          if (rec.status === 'running') begin(rec);
        }
      }
    }

    // ── hooks ──
    function onIngest(env, { conversation_id: cid, session_id: sid } = {}) {
      if (!isPlain(env) || typeof cid !== 'string') return;
      try {
        const agentId = isPlain(env.agent) ? taskId(env.agent.id) : null;
        if (agentId && env.event === 'SubagentStop') { agentEnded(agentId, finite(env.ts) ? env.ts : now()); return; }
        if (agentId) bounded(seenAgents, agentId);
        if (env.event === 'PostToolUse') postToolUse(env, cid, sid);
        else if (env.event === 'Stop' && isPlain(env.stop) && Array.isArray(env.stop.background_tasks)) reconcile(env, cid, sid);
      } catch (e) { fail('ingest', e); }
    }

    function postToolUse(env, cid, sid) {
      const result = isPlain(env.result) ? env.result : null;
      const fields = result && isPlain(result.fields) ? result.fields : null;
      const tool = isPlain(env.tool) ? env.tool : {};
      if (!fields) return;
      const monitor = tool.name === 'Monitor';
      const id = taskId(fields.backgroundTaskId) || (monitor ? taskId(fields.taskId) : null);
      if (!id) return;
      const input = isPlain(tool.input) ? tool.input : {};
      let owner = null;
      if (isPlain(env.agent) && taskId(env.agent.id)) {
        const agentRow = engine.model.task(env.agent.id);
        const title = (agentRow && str(agentRow.title)) || str(env.agent.type) || 'Agent';
        owner = { agent_id: env.agent.id, title: title.slice(0, TITLE_MAX) };
      }
      const description = str(input.description);
      noteStart({
        id, cid, sid, kind: monitor ? 'monitor' : 'shell',
        title: description || firstLine(str(input.command)), titleFromDescription: Boolean(description),
        command: str(input.command), tool_use_id: str(tool.use_id), owner,
        path: str(fields.outputFile), at: finite(env.ts) ? env.ts : null,
      });
    }

    function reconcile(env, cid, sid) {
      const listed = new Set();
      for (const entry of env.stop.background_tasks.slice(0, 50)) {
        if (!isPlain(entry)) continue;
        const id = taskId(entry.id);
        if (!id) continue;
        listed.add(id);
        const type = typeof entry.type === 'string' ? entry.type : '';
        if (NOT_MINE_TYPE_RE.test(type) || foreign(id)) continue;
        let rec = recs.get(id);
        if (!rec) {
          const description = str(entry.description);
          rec = noteStart({
            id, cid, sid, kind: /monitor/i.test(type) ? 'monitor' : 'shell',
            title: description || firstLine(str(entry.command)), titleFromDescription: Boolean(description),
            command: str(entry.command), at: finite(env.ts) ? env.ts : null,
          });
        }
        const status = typeof entry.status === 'string' ? LIST_STATUS[entry.status] : undefined;
        if (rec && status) end(rec, status, { ended_at: finite(env.ts) ? env.ts : now() });
      }
      for (const rec of [...recs.values()]) {
        if (rec.cid !== cid || rec.status !== 'running' || listed.has(rec.id)) continue;
        if (retryFence(rec)) { publish(rec); begin(rec); continue; }
        if (rec.path) {
          enqueueCheck(rec).then(() => {
            if (!rec.gone && rec.status === 'running' && !rec.watch && started) begin(rec);
          }, () => {});
        }
      }
    }

    function onConversation(ev) {
      if (!isPlain(ev) || !isPlain(ev.conversation) || typeof ev.conversation.id !== 'string') return;
      const cid = ev.conversation.id;
      try {
        if (ev.change === 'ended') {
          const at = finite(ev.at) ? ev.at : (finite(ev.conversation.ended_at) ? ev.conversation.ended_at : now());
          for (const rec of [...recs.values()]) {
            if (rec.cid === cid && rec.status === 'running') end(rec, 'stopped', { stopped_by: 'session-end', ended_at: Math.max(at, rec.started_at) });
          }
        } else if (ev.change === 'merged' && typeof ev.merged_into === 'string') {
          // The model dropped the younger conversation's rows; they live on in the elder.
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

    // ── persistence (§2.11, this source's slice) ──
    function persistState(sessionId) {
      const rows = [];
      for (const rec of recs.values()) {
        if (rec.sid !== sessionId || rec.gone) continue;
        const r = {
          id: rec.id, cid: rec.cid, kind: rec.kind, title: rec.title, status: rec.status, started_at: rec.started_at,
          line: rec.line || '', meta: { ...rec.meta }, turn_id: rec.turn_id, tool_use_id: rec.tool_use_id,
          counted: [...rec.counted].slice(-COUNTED_MAX),
        };
        if (finite(rec.ended_at)) r.ended_at = rec.ended_at;
        if (finite(rec.exit_code)) r.exit_code = rec.exit_code;
        if (rec.stopped_by) r.stopped_by = rec.stopped_by;
        if (rec.owner) r.owner = { ...rec.owner };
        if (rec.path) r.file = rec.path;
        if (rec.command) r.command = rec.command;
        rows.push(r);
      }
      // Running rows first, then the most recently finished.
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
      const id = taskId(r.id);
      const cid = str(r.cid);
      if (!id || !cid || foreign(id)) return;
      const kind = r.kind === 'monitor' ? 'monitor' : 'shell';
      let rec = recs.get(id);
      const counted = Array.isArray(r.counted) ? r.counted.filter((x) => typeof x === 'string').slice(-COUNTED_MAX) : [];
      if (rec) { for (const x of counted) rec.counted.add(x); return; }
      const status = TERMINAL.has(r.status) || r.status === 'running' ? r.status : 'running';
      rec = newRec(id, kind, cid, sessionId, finite(r.started_at) ? r.started_at : null);
      rec.title = str(r.title);
      rec.status = status;
      rec.ended_at = finite(r.ended_at) ? r.ended_at : null;
      rec.exit_code = finite(r.exit_code) ? r.exit_code : null;
      rec.stopped_by = STOPPED_BY.has(r.stopped_by) ? r.stopped_by : null;
      rec.line = typeof r.line === 'string' ? r.line.slice(0, LINE_MAX) : '';
      if (isPlain(r.meta)) {
        if (finite(r.meta.port)) rec.meta.port = r.meta.port;
        if (finite(r.meta.events)) rec.meta.events = r.meta.events;
        if (finite(r.meta.last_event_at)) rec.meta.last_event_at = r.meta.last_event_at;
      }
      rec.turn_id = str(r.turn_id);
      rec.tool_use_id = str(r.tool_use_id);
      if (isPlain(r.owner) && taskId(r.owner.agent_id)) rec.owner = { agent_id: r.owner.agent_id, title: str(r.owner.title) || 'Agent' };
      rec.command = str(r.command);
      for (const x of counted) rec.counted.add(x);
      // The fence again: what it refuses now leaves can.output false.
      if (str(r.file)) {
        let p = null;
        try { p = engine.files.taskOutputFile(r.file); } catch { p = null; }
        rec.path = p;
      }
      if (rec.status === 'running' && rec.owner) rec.restoredAt = now();
      publish(rec);
      if (!started) return;
      if (rec.status === 'running') {
        if (rec.path) begin(rec);
        else if (conversationEnded(cid)) { removeRow(rec); return; }
        if (rec.owner) armSweep();
      } else armKeep(rec);
    }

    // ── the api ──
    async function output(id, q) {
      const rec = recs.get(typeof id === 'string' ? id : '');
      if (!rec || !rec.path) return null;
      const o = isPlain(q) ? q : {};
      const max = Number.isSafeInteger(o.max) && o.max > 0 ? Math.min(o.max, OUTPUT_MAX) : OUTPUT_MAX;
      const from = Number.isSafeInteger(o.from) && o.from >= 0 ? o.from : 0;
      const tail = Number.isSafeInteger(o.tail) && o.tail > 0 ? o.tail : null;
      const p = engine.files.taskOutputFile(rec.path);
      const w = p ? engine.files.readWindow(p, tail ? { fromEnd: true, maxBytes: Math.min(tail, max) } : { from, maxBytes: max }) : null;
      const ended = rec.status !== 'running';
      if (!w) {
        const out = { task_id: rec.id, text: '', from, to: from, size: 0, eof: true, ended, footer: null };
        if (finite(rec.exit_code)) out.exit_code = rec.exit_code;
        return out;
      }
      const text = engine.redactor.window(w.text, { startsMidFile: w.startsMidFile, complete: w.complete, context: contextOf(rec) });
      const footer = w.complete ? footerOf(w.text) : null;
      const out = {
        task_id: rec.id, text: typeof text === 'string' ? text : '', from: w.from, to: w.next, size: w.size,
        eof: w.complete, ended, footer: footer ? footer.text : null,
      };
      if (finite(rec.exit_code)) out.exit_code = rec.exit_code;
      else if (footer && finite(footer.exit_code)) out.exit_code = footer.exit_code;
      return out;
    }

    function markStopRequested(id) {
      if (typeof id !== 'string' || !id) return null;
      const row = engine.model.task(id);
      if (!row || row.status !== 'running') return null;
      const next = engine.model.upsertTask({ id, conversation_id: row.conversation_id, stop_requested_at: now() });
      return next ? engine.model.serializeTask(id) : null;
    }

    // ── lifecycle ──
    async function start() {
      if (started) return;
      started = true;
      for (const rec of [...recs.values()]) {
        if (rec.gone) continue;
        if (rec.status === 'running') {
          if (rec.path) begin(rec);
          else if (conversationEnded(rec.cid)) removeRow(rec);
        } else armKeep(rec);
      }
      armSweep();
    }

    async function stop() {
      if (!started) return;
      started = false;
      waiting.length = 0;
      if (sweepTimer !== null) { try { engine.timers.clearTimeout(sweepTimer); } catch { /* gone */ } sweepTimer = null; }
      const stops = [];
      for (const rec of recs.values()) {
        if (rec.watch) { stops.push(rec.watch); rec.watch = null; }
        clearTimer(rec, 'noOut');
        clearTimer(rec, 'keep');
      }
      watching = 0;
      await Promise.all(stops.map((w) => Promise.resolve().then(() => w.stop()).catch(() => {})));
    }

    function diagnostics() {
      let running = 0;
      for (const rec of recs.values()) if (rec.status === 'running') running += 1;
      return { tasks: { running, watching, refused: refusedCount } };
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
      api: { output, markStopRequested },
    };
  }

  return { attach };
}

module.exports = {
  createTasksSource,
  stoppedTaskId,
  bgStartOf,
  POLL_MS,
  NO_OUTPUT_MS,
  FINISHED_KEEP_MS,
  OUTPUT_MAX,
  LINE_WINDOW,
  FOOTER_BYTES,
  TASKS_WATCH_MAX,
  STATE_VERSION,
  AGENT_SWEEP_MS,
  AGENT_UNKNOWN_GRACE_MS,
  BG_START_RE,
  AUTO_BG_RE,
  MONITOR_START_RE,
  STOPPED_RE,
  FOOTER_RE,
  PORT_RE,
};
