// Agent subagents and workflow runs, as Claude Code writes them, for the chat
// mirror's tests (U42's agents and workflows sources; U47's agent and workflow
// views and U51's integration read the same shapes). Built on
// test-support/claude-records.js (the records) and test-support/claude-home.js
// (the fake Claude Code tier): generated, seeded, never copied from a real
// session. The shapes follow validation V4 and V7.
//
// THE LAYOUT (V4, V7), under <projectDir>/<session id>/:
//   subagents/agent-<agentId>.jsonl            an Agent's own transcript
//   subagents/agent-<agentId>.meta.json        {agentType, description, toolUseId, …}
//   subagents/workflows/<runId>/journal.jsonl  launched / started / result / failed
//   subagents/workflows/<runId>/agent-<agentId>.jsonl and .meta.json
//   workflows/scripts/<name>-<runId>.js        the script (meta.phases)
//   workflows/<runId>.json, workflows/wf_<runId>.json   the summary (written at
//                                              the end; both names, §2.5 and V4)
//
// THE API.
//
//   const fx = agentFixtures(ch, sessionId);        ch = claudeHome(t, …)
//   fx.sessionDir                                    <projectDir>/<sid>, made
//
//   An agent's own file:
//   fx.agentRecords({agentId, seed, start, step})    createRecords for an agent
//                                                    file (agentId on each record,
//                                                    isSidechain, the parent's sid)
//   fx.agentFile(agentId, {runId})                   its path (not written)
//   fx.writeAgent(agentId, records, {runId})         → path (records, or raw lines)
//   fx.appendAgent(agentId, records, {runId})        → path
//   fx.writeAgentMeta(agentId, {agentType, description, toolUseId, runId,
//                     workflowPhase, model})          → path (agent-<id>.meta.json)
//   fx.workflowAgentPrompt(r, prompt, {relay = true}) the relay record, then the
//                                                    framed prompt (rule 6)
//
//   The parent's records (each takes the parent's createRecords `r`):
//   fx.agentCall(r, {toolUseId, description, subagentType, prompt,
//                    runInBackground})               → the tool_use id
//   fx.asyncLaunched(r, toolUseId, {agentId, description, outputFile})
//                                                    the async_launched result (V7)
//   fx.agentFinished(r, toolUseId, {agentId, text, isError})
//                                                    a foreground call's final result
//   fx.agentNotification(r, {agentId, toolUseId, status, description, result})
//                                                    the <task-notification> turn
//   fx.agentNotificationText({…same})                the block, for other carriers
//   fx.taskStop(r, {taskId, toolUseId, named})       a TaskStop call and its result
//                                                    (`named` = the task_id in the
//                                                    call's input, default taskId)
//   fx.workflowCall(r, {toolUseId, taskId, runId, workflowName, scriptPath,
//                       name})                       → the tool_use id; the
//                                                    Workflow call and its
//                                                    async_launched result (V4)
//
//   A workflow's files:
//   fx.scriptPath(runId, {name})                     its path (not written)
//   fx.writeScript(runId, {name, phases, src})       → path; `phases` (titles) are
//                                                    written as meta.phases, or
//                                                    `src` as given
//   fx.journal(runId) → {file, launched(), started({key, agentId, label, phase}),
//                        result({key, agentId, result}), failed({key, agentId}),
//                        line(obj)}                  each appends one line
//   fx.writeSummary(runId, {status, name: 'plain'|'wf', mtime, extra}) → path
//   fx.summaryPath(runId, {name})
//
// Everything lands inside the claude-home tier, so claude-home's cleanup takes
// it away when the test ends.

const fs = require('fs');
const path = require('path');
const { home: SANDBOX } = require('./sandbox');
const { claudeHome } = require('./claude-home');
const { withTempHome, waitUntil } = require('./helpers');
const { createRecords, taskNotificationText } = require('./claude-records');
const { createRedactor } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { createHookTap } = require('../lib/server/hook-tap');

const JSONL = (records) => {
  if (typeof records === 'string') return records;
  return records.flat(Infinity).map((r) => `${typeof r === 'string' ? r : JSON.stringify(r)}\n`).join('');
};

function agentFixtures(ch, sessionId) {
  if (!ch || typeof ch.sessionDir !== 'function') throw new TypeError('agentFixtures(ch, sessionId): ch is a claudeHome fixture');
  const sessionDir = ch.sessionDir(sessionId);

  function put(file, text, { append = false } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (append) fs.appendFileSync(file, text);
    else fs.writeFileSync(file, text);
    return file;
  }

  const runDir = (runId) => path.join(sessionDir, 'subagents', 'workflows', runId);
  const agentDir = (runId) => (runId ? runDir(runId) : path.join(sessionDir, 'subagents'));
  const agentFile = (agentId, { runId } = {}) => path.join(agentDir(runId), `agent-${agentId}.jsonl`);

  // ── an agent's own file ──
  function agentRecords({ agentId, seed = 7, start = Date.now(), step = 10, cwd = ch.cwd } = {}) {
    return createRecords({ seed, sessionId, agentId, cwd, start, step });
  }

  function writeAgentMeta(agentId, { agentType = 'general-purpose', description = 'Do the thing', toolUseId, runId, workflowPhase, model } = {}) {
    const meta = runId
      ? { agentType: 'workflow-subagent', description, workflowPhase, spawnDepth: 1, requestShape: 'foreground', requestNonInteractive: true }
      : { agentType, description, toolUseId, spawnDepth: 1, requestShape: 'background', requestNonInteractive: false };
    if (model) meta.model = model;
    return put(path.join(agentDir(runId), `agent-${agentId}.meta.json`), JSON.stringify(meta));
  }

  function workflowAgentPrompt(r, prompt, { relay = true } = {}) {
    if (relay) r.user('[Workflow harness — user request]\nRun the release check, please.');
    return r.user(`[Workflow harness — computed task] Answer with the task's result.\n\nThe computed task text follows:\n${String(prompt).split('\n').map((l) => `  ${l}`).join('\n')}`);
  }

  // ── the parent's records ──
  function agentCall(r, { toolUseId, description = 'Explore the queue rail', subagentType = 'general-purpose', prompt = 'Look at the rail.', runInBackground } = {}) {
    const input = { description, subagent_type: subagentType, prompt };
    if (runInBackground !== undefined) input.run_in_background = runInBackground;
    const recs = r.assistant([{ type: 'tool_use', name: 'Agent', input, id: toolUseId }]);
    return recs[recs.length - 1].message.content[0].id;
  }

  function asyncLaunched(r, toolUseId, { agentId, description = 'Explore the queue rail', outputFile } = {}) {
    const text = `Async agent launched successfully.\nagentId: ${agentId} (internal ID - do not mention to user. Use SendMessage with to: '${agentId}' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.`;
    return r.toolResult(toolUseId, text, {
      agentId,
      toolUseResult: {
        isAsync: true, status: 'async_launched', description, resolvedModel: 'claude-sonnet-5', prompt: 'Look at the rail.',
        outputFile: outputFile || path.join(ch.tmpDir, `claude-${ch.uid}`, ch.slug, sessionId, 'tasks', `${agentId}.output`),
        canReadOutputFile: true,
      },
    });
  }

  function agentFinished(r, toolUseId, { agentId, text = 'Found three call sites.', isError = false } = {}) {
    return r.toolResult(toolUseId, text, {
      isError, agentId,
      toolUseResult: { status: 'completed', agentType: 'general-purpose', totalDurationMs: 8300, totalToolUseCount: 2 },
    });
  }

  function agentNotificationText({ agentId, toolUseId, status = 'completed', description = 'Explore the queue rail', result = 'Found three call sites.' } = {}) {
    const word = status === 'completed' ? 'finished' : status;
    return taskNotificationText({ taskId: agentId, toolUseId, status, summary: `Agent "${description}" ${word}`, result });
  }

  function agentNotification(r, opts = {}) {
    const { agentId, toolUseId, status = 'completed', description = 'Explore the queue rail', result = 'Found three call sites.' } = opts;
    const word = status === 'completed' ? 'finished' : status;
    return r.taskNotification({ taskId: agentId, toolUseId, status, summary: `Agent "${description}" ${word}`, result });
  }

  function taskStop(r, { taskId, toolUseId, named = taskId } = {}) {
    const input = named === null ? {} : { task_id: named };
    const recs = r.assistant([{ type: 'tool_use', name: 'TaskStop', input, id: toolUseId }]);
    const id = recs[recs.length - 1].message.content[0].id;
    r.toolResult(id, `Successfully stopped task: ${taskId} (agent)`);
    return id;
  }

  function workflowCall(r, { toolUseId, taskId, runId, workflowName = 'release-check', scriptPath, name } = {}) {
    const recs = r.assistant([{ type: 'tool_use', name: 'Workflow', input: { name: name || workflowName }, id: toolUseId }]);
    const id = recs[recs.length - 1].message.content[0].id;
    r.toolResult(id, `Workflow "${workflowName}" launched in the background (task ${taskId}).`, {
      toolUseResult: {
        status: 'async_launched', taskId, taskType: 'local_workflow', workflowName, runId,
        summary: `Dynamic workflow "${workflowName}" launched`,
        transcriptDir: runDir(runId), scriptPath: scriptPath || scriptPathOf(runId, { name: workflowName }),
      },
    });
    return id;
  }

  // ── a workflow's files ──
  function scriptPathOf(runId, { name = 'release-check' } = {}) {
    return path.join(sessionDir, 'workflows', 'scripts', `${name}-${runId}.js`);
  }

  function writeScript(runId, { name = 'release-check', phases = ['Build', 'Test', 'Ship'], src } = {}) {
    const body = typeof src === 'string' ? src : [
      'export const meta = {',
      `  name: ${JSON.stringify(name)},`,
      '  phases: [',
      ...phases.map((t) => `    { title: ${JSON.stringify(t)}, detail: 'x' },`),
      '  ],',
      '};',
      'export default async function run(ctx) { return ctx; }',
      '',
    ].join('\n');
    return put(scriptPathOf(runId, { name }), body);
  }

  function journal(runId) {
    const file = path.join(runDir(runId), 'journal.jsonl');
    const line = (obj) => put(file, `${JSON.stringify(obj)}\n`, { append: true });
    return {
      file,
      line,
      launched: () => line({ type: 'launched' }),
      started: ({ key, agentId, label, phase }) => {
        const o = { type: 'started', key, agentId };
        if (label !== undefined) o.label = label;
        if (phase !== undefined) o.phase = phase;
        return line(o);
      },
      result: ({ key, agentId, result = 'ok' }) => line({ type: 'result', key, agentId, result }),
      failed: ({ key, agentId }) => line({ type: 'failed', key, agentId }),
    };
  }

  function summaryPath(runId, { name = 'plain' } = {}) {
    return path.join(sessionDir, 'workflows', name === 'wf' ? `wf_${runId}.json` : `${runId}.json`);
  }

  function writeSummary(runId, { status = 'killed', name = 'plain', mtime, extra = {} } = {}) {
    const file = put(summaryPath(runId, { name }), JSON.stringify({ runId, status, summary: 'done', workflowProgress: [], ...extra }));
    if (mtime !== undefined) {
      const t = new Date(mtime);
      fs.utimesSync(file, t, t);
    }
    return file;
  }

  return {
    sessionDir,
    runDir,
    agentFile,
    agentRecords,
    writeAgent: (agentId, records, { runId } = {}) => put(agentFile(agentId, { runId }), JSONL(records)),
    appendAgent: (agentId, records, { runId } = {}) => put(agentFile(agentId, { runId }), JSONL(records), { append: true }),
    writeAgentMeta,
    workflowAgentPrompt,
    agentCall,
    asyncLaunched,
    agentFinished,
    agentNotification,
    agentNotificationText,
    taskStop,
    workflowCall,
    scriptPath: scriptPathOf,
    writeScript,
    journal,
    summaryPath,
    writeSummary,
  };
}


// ── the mirror harness ───────────────────────────────────────────────────────
//
// What test/mirror-agents.test.js and test/mirror-workflows.test.js share: a
// REAL createMirror with `live`, the real transcripts source (an in-memory fake
// of its store) and U42's two sources, registered the way U51 will register
// them, with spies on the tailers they make.
//
//   const h = agentMirror(t, {store, root, ch, clock, settleMs});
//   h.mirror, h.ch, h.fx (agentFixtures for S1), h.frames, h.probe.engine
//   h.publish(event, extra, sid) / h.sessionStart(source)
//   h.records({seed, start, step}) → createRecords for the main transcript of S1
//   h.rows() / h.row(id) / h.waitRow(id, pred, what)
//   h.agent(id, q) / h.workflow(id)   the facade's answers (kept in h.answers)
//   h.tailers: [{file, kind: 'agents'|'workflows', stopped, inCallbackCalls, stats}]
//   h.activity: [[cid, at, kind]]     the two sources' engine.live.noteActivity
//   h.leaks() → the needles (the projects dir, the session dir, '.jsonl',
//               'subagents', the tmp dir) that any row, answer or frame names
//   fakeStore(), fakeClock(start), S1, S2, PID

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const PID = 4242;


function project(t) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-agents-'));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The transcripts source's store contract, in memory; `saved` outlives mirrors.
function fakeStore() {
  const saved = new Map();
  const pending = new Map();
  async function flush(sid) {
    for (const [k, fn] of [...pending]) {
      if (sid && k !== sid) continue;
      pending.delete(k);
      const snap = fn();
      if (snap) saved.set(k, JSON.parse(JSON.stringify(snap)));
    }
  }
  const create = () => ({
    async load(sid) {
      const ix = saved.get(sid);
      return ix ? { ok: true, index: JSON.parse(JSON.stringify(ix)) } : { ok: false, reason: 'absent' };
    },
    schedule(sid, fn) { pending.set(sid, fn); },
    flush,
    drop(sid) { pending.delete(sid); },
    async readRange(file, { from, to }) {
      const s = fs.readFileSync(file).subarray(from, to).toString('utf8');
      const cut = s.lastIndexOf('\n');
      return cut < 0 ? '' : s.slice(0, cut + 1);
    },
    async stop() { await flush(); },
  });
  return { create, saved };
}

// A clock and timers for the two sources: a timeout of a minute or more waits
// until advance() passes it; a shorter one runs on Node's timers.
function fakeClock(start = Date.now()) {
  let t = start;
  let seq = 0;
  const held = new Map();
  const real = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const h = { id: ++seq };
      if (ms >= 60000) held.set(h, { at: t + ms, fn });
      else real.set(h, setTimeout(() => { real.delete(h); fn(); }, ms));
      return h;
    },
    clearTimeout(h) {
      held.delete(h);
      if (real.has(h)) { clearTimeout(real.get(h)); real.delete(h); }
    },
    setInterval() { throw new Error('the agents sources set no interval'); },
    clearInterval() {},
    clear(h) { timers.clearTimeout(h); },
  };
  return {
    now: () => t,
    timers,
    held: () => held.size,
    pending: () => held.size + real.size,
    advance(ms) {
      t += ms;
      for (;;) {
        const due = [...held].filter(([, v]) => v.at <= t).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        held.delete(due[0]);
        due[1].fn();
      }
    },
  };
}

function agentMirror(t, { store = fakeStore(), root = null, ch = null, clock = null, settleMs = 150 } = {}) {
  let mirror = null;
  t.after(async () => { if (mirror) await mirror.stop(); });
  if (!root) {
    withTempHome(t);
    root = project(t);
    ch = claudeHome(t, { root, isolate: true });
  }
  const { createMirror, SOURCES } = require('../lib/server/mirror');
  const { createTailer } = require('../lib/server/mirror/tail');
  const { createTranscriptsSource } = require('../lib/server/mirror/transcripts');
  const { createAgentsSource } = require('../lib/server/mirror/agents');
  const { createWorkflowsSource } = require('../lib/server/mirror/workflows');
  const tailers = [];
  const activity = [];
  // A tailer that records what it follows, and whether stop() or drain() was
  // ever called from inside its own callbacks.
  const spyTailer = (kind) => (opts) => {
    const entry = { file: String(opts.file), kind, stopped: false, inCallbackCalls: 0 };
    let inside = 0;
    const wrapCb = (fn) => (typeof fn === 'function' ? (...a) => {
      inside += 1;
      try { return fn(...a); } finally { inside -= 1; }
    } : fn);
    const real = createTailer({ ...opts, onRecords: wrapCb(opts.onRecords), onReset: wrapCb(opts.onReset) });
    entry.stats = real.stats;
    tailers.push(entry);
    return {
      ...real,
      start: () => real.start(),
      resumeAt: (r) => real.resumeAt(r),
      stats: real.stats,
      stop: () => { if (inside) entry.inCallbackCalls += 1; entry.stopped = true; return real.stop(); },
      drain: () => { if (inside) entry.inCallbackCalls += 1; return real.drain(); },
    };
  };
  const wrapEngine = (engine) => {
    let e = {
      ...engine,
      live: Object.freeze({
        liveOf: engine.live.liveOf,
        noteActivity: (cid, at, kind) => { activity.push([cid, at, kind]); return engine.live.noteActivity(cid, at, kind); },
      }),
    };
    if (clock) e = { ...e, now: clock.now, timers: clock.timers };
    return Object.freeze(e);
  };
  const agents = createAgentsSource({ createTailer: spyTailer('agents'), settleMs });
  const workflows = createWorkflowsSource({ createTailer: spyTailer('workflows'), settleMs });
  const transcripts = createTranscriptsSource({ createStore: store.create, createTailer, pollMs: 30 });
  const probe = { engine: null };
  const hooks = createHookTap();
  const mirrorBus = createBus({ maxEvents: 4000 });
  const frames = [];
  mirrorBus.setBroadcaster((frame) => frames.push(frame));
  mirror = createMirror({
    root, hooks, mainBus: createBus(), mirrorBus, redactor: createRedactor(), log: () => {},
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    isPidAlive: () => true,
    sources: [...SOURCES.filter((s) => s.name === 'live'),
      { name: 'transcripts', attach: transcripts.attach },
      { name: 'agents', attach: (engine) => agents.attach(wrapEngine(engine)) },
      { name: 'workflows', attach: (engine) => workflows.attach(wrapEngine(engine)) },
      { name: 'probe', attach: (engine) => { probe.engine = engine; return { start: async () => {}, stop: async () => {} }; } }],
  });
  let ts = clock ? clock.now() : Date.now();
  const h = { root, ch, store, hooks, mirror, frames, probe, tailers, activity, clock, answers: [] };
  h.fx = agentFixtures(ch, S1);
  h.env = (event, extra = {}, sid = S1) => ({
    v: 1, event, ts: ++ts, session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...extra,
  });
  h.publish = (event, extra, sid) => hooks.publish(h.env(event, extra, sid));
  h.sessionStart = (source = 'startup') => h.publish('SessionStart', { session: { source }, claude_pid: PID });
  h.records = ({ seed = 1, start = clock ? clock.now() : Date.now(), step = 10 } = {}) => createRecords({ seed, sessionId: S1, cwd: ch.cwd, start, step });
  h.rows = () => mirror.tasks().tasks;
  h.row = (id) => h.rows().find((x) => x.id === id) || null;
  h.waitRow = (id, pred, what) => waitUntil(() => { const r = h.row(id); return r && pred(r) ? r : null; }, { timeout: 8000, what: what || `row ${id}` });
  h.agent = async (id, q) => { const v = await mirror.agent(id, q); h.answers.push(v); return v; };
  h.workflow = async (id) => { const v = await mirror.workflow(id); h.answers.push(v); return v; };
  // What leaves the sources must never name a file.
  h.leaks = () => {
    const out = JSON.stringify([mirror.tasks(), h.answers, h.frames]);
    return [ch.projectsDir, h.fx.sessionDir, '.jsonl', 'subagents', ch.tmpDir].filter((needle) => out.includes(needle));
  };
  return h;
}

module.exports = { agentFixtures, agentMirror, fakeStore, fakeClock, S1, S2, PID };
