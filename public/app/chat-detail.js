// The chat's detail views (design spec §7.12): the views pushed OVER the stream
// for one piece of background work or one set of code changes.
//
//   initChatDetail({followMs}) registers two kinds with chat-panel.js
//                              registerDetail — 'task' and 'diff' — and starts
//                              listening; idempotent. `followMs` (default
//                              FOLLOW_MS) paces every follower and the workflow
//                              refetch.
//   stopChatDetail()           unregisters both, and stops every follower, timer
//                              and listener of every view still open
//
// 'turn' is NOT registered: nothing emits chat:open {view: 'turn'} in 0.8.5, and
// the inspector-to-chat link it would serve is deferred (§2.8, §13).
//
// HOW A VIEW OPENS. chat:open {view, id, node_id} reaches the panel (U36), which
// calls the registered render(bodyEl, {id, node_id}, {close, setTitle}). Each
// view sets its title through setTitle and answers a cleanup the panel runs
// when the view is popped ('‹ Chat', Escape, chat:open {view: 'chat'}).
//
//   'task' {id}   the id is whatever a tool card or a tray row named: a task row's
//                 id (Claude Code's task id, an agent's agentId, a workflow's
//                 taskId), a row's tool_use_id, or a workflow's runId. The row is
//                 read from the one store (chat-state.js mirror.tasks); with none,
//                 GET /api/mirror/agents/:id and then /api/mirror/workflows/:id
//                 are asked, and nothing answering is "no longer tracked".
//                 Its kind then picks the view: a shell's output, an agent's own
//                 transcript, a workflow's agents, a monitor's events.
//   'diff' {node_id} → GET /api/mirror/diff?node=<node_id>  a node's changes
//          {id}      → GET /api/mirror/diff?turn=<id>       one turn's own
//
// FOLLOWERS are chat-actions.js's (followTaskOutput, followAgentItems): bounded
// setTimeout chains, never an interval. A view's followers run only while the
// view is the one on screen and a chat view is open (chat-slots posture
// 'full'): they stop when the view is popped, covered by another, or the chat
// closes, and resume from where they were when it shows again. The workflow
// view re-reads its route when the store's row for it changes rev, at most once
// per `followMs`. ONE setInterval (TICK_MS) repaints the running clocks while a
// view with something running is on screen, and no longer.
//
// A ROW THAT DISAPPEARS from the store while its view is open keeps the view's
// last content under "No longer running" (§8.6), and its followers stop.
//
// BELOW `read` every view says the conversation is not shared with this viewer
// and fetches nothing (the routes refuse it anyway, §5.4). A view open when the
// level falls drops what it showed for that line, and its followers, timers and
// own buttons end; one showing that line opens afresh when the level rises.
//
// TEXT. Every string from the mirror goes in by textContent; prose through
// renderMarkdown(text, {flavor: 'chat'}) — its own div.md-chat inside a plain
// element, never inside a page .md-block (U35) — and a patch through renderDiff,
// the one engine, which escapes every line. Tool calls are chat-tools.js's own
// cards (renderToolCard). Every class is spelled out here (app.css's dead-class
// ratchet reads the literals); this module adds no id.
import { bus } from './bus.js';
import { mirror, atLeast, serverNow, normalizeItem, normalizeTask } from './chat-state.js';
import { categories, isRunning, fmtClock } from './chat-present.js';
import { registerDetail, openDetail } from './chat-panel.js';
import { renderToolCard } from './chat-tools.js';
import { followTaskOutput, followAgentItems, runAction, FOLLOW_MS } from './chat-actions.js';
import { posture } from './chat-slots.js';
import { labelFor } from './labels.js';
import { renderMarkdown, renderDiff } from './markdown.js';

export const TAIL_BYTES = 65536;   // a shell's or a monitor's tail: the GET's `tail`, and what the view keeps
export const STUCK_PX = 48;        // within this of the bottom, new output scrolls into view (§7.10)
export const TICK_MS = 1000;       // the running clocks
export const KINDS = Object.freeze(['task', 'diff']);

export const UNTRACKED = 'This task is no longer tracked.';
export const GONE = 'No longer running';
export const NOT_SHARED = 'The conversation is not shared with this viewer.';

const KIND_WORD = { shell: 'Shell', agent: 'Agent', workflow: 'Workflow', monitor: 'Monitor' };
const CAT_OF = { shell: 'shells', agent: 'agents', workflow: 'workflows', monitor: 'monitors' };
const SEP = ' · ';

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const canRead = () => atLeast(mirror.access.level, 'read');
const fmtInt = (n) => (finite(n) ? Math.round(n).toLocaleString('en-US') : '0');

let followMs = FOLLOW_MS;
let offs = [];               // the registrations and bus listeners
const views = new Set();     // every view open now

// ── small DOM helpers ────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
function button(cls, text) {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}
function note(text, cls = 'dv-note') {
  return el('p', cls, text);
}
// Chat prose: the engine's div.md-chat inside a plain element.
function prose(text, cls = 'dv-prose') {
  const box = el('div', cls);
  box.innerHTML = renderMarkdown(String(text || ''), { flavor: 'chat' });   // the engine escapes everything
  return box;
}
function diffBox(patch) {
  const box = el('pre', 'md-diff dv-diff');
  box.innerHTML = renderDiff(String(patch || ''));   // the engine escapes every line
  return box;
}

async function getJson(url) {
  try {
    const res = await fetch(url);
    if (!res) return { ok: false, status: 0, body: null };
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: !!res.ok && isObj(body) && body.ok !== false, status: res.status, body: isObj(body) ? body : null };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

// The scroll container is stuck to its bottom when it shows it (within STUCK_PX);
// one with no layout yet counts as stuck.
function isStuck(s) {
  return !(s.scrollHeight > 0) || s.scrollHeight - s.scrollTop - s.clientHeight <= STUCK_PX;
}

// ── one view ─────────────────────────────────────────────────────────────────

// What every view shares: whether it is on screen, its followers (paused when it
// is not, resumed when it is again), its timers, its clock, and its cleanup.
function createView(body, ctx) {
  const dview = body.parentElement;
  const v = {
    body,
    ctx,
    closed: false,
    followers: [],         // { start() → stop, stop, done }
    timers: new Set(),
    clock: null,           // () → whether it still needs the ticker; repaints on each tick
    onMirror: null,
    observer: null,
    unshared: false,       // showing NOT_SHARED: nothing here fetches again
  };
  // Whether the view may still fetch: open, and not demoted below read.
  v.live = () => !v.closed && !v.unshared && canRead();
  v.visible = () => v.live() && body.isConnected && !(dview && dview.hidden) && posture() === 'full';
  // Every fetch a view makes goes through here: none once it may not.
  v.get = (url) => (v.live() ? getJson(url) : Promise.resolve({ ok: false, status: 0, body: null }));
  // One follower: `start` answers its stop function, and calls done() once it
  // has nothing more to follow.
  v.follow = (start) => {
    const f = { start, stop: null, done: false };
    v.followers.push(f);
    if (v.visible()) f.stop = f.start(() => { f.done = true; });
    return f;
  };
  v.pause = () => {
    for (const f of v.followers) if (f.stop) { f.stop(); f.stop = null; }
    for (const t of v.timers) clearTimeout(t);
    v.timers.clear();
  };
  v.endFollowers = () => {
    for (const f of v.followers) f.done = true;
    v.pause();
  };
  v.sync = () => {
    if (v.closed) return;
    if (!v.visible()) { v.pause(); syncTicker(); return; }
    for (const f of v.followers) if (!f.done && !f.stop) f.stop = f.start(() => { f.done = true; });
    syncTicker();
  };
  v.later = (fn, ms) => {
    const t = setTimeout(() => { v.timers.delete(t); if (!v.closed) fn(); }, ms);
    v.timers.add(t);
    return t;
  };
  // Below read: the one line, and nothing left running.
  v.unshare = () => {
    v.unshared = true;
    v.endFollowers();
    v.clock = null;
    v.paint = null;
    v.onRow = null;
    body.replaceChildren(note(NOT_SHARED, 'dv-note dv-unshared'));
    syncTicker();
  };
  v.close = () => {
    if (v.closed) return;
    v.closed = true;
    v.pause();
    if (v.observer) v.observer.disconnect();
    views.delete(v);
    syncTicker();
  };
  // A view covered by another (or shown again when that one pops) toggles its
  // `hidden`: the panel's own signal, watched rather than polled.
  if (dview && typeof MutationObserver === 'function') {
    v.observer = new MutationObserver(() => v.sync());
    v.observer.observe(dview, { attributes: true, attributeFilter: ['hidden'] });
  }
  views.add(v);
  return v;
}

// ── the ticker: one interval while a running clock is on screen ──────────────

let ticker = null;

function wantsTick() {
  for (const v of views) if (v.clock && v.visible() && v.clock(false)) return true;
  return false;
}

function syncTicker() {
  const want = wantsTick();
  if (want && ticker === null) {
    ticker = setInterval(() => {
      if (typeof document === 'undefined') { syncTicker(); return; }
      for (const v of [...views]) if (v.clock && v.visible()) v.clock(true);
      syncTicker();
    }, TICK_MS);
    if (ticker && typeof ticker === 'object' && typeof ticker.unref === 'function') ticker.unref();
  } else if (!want && ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

// ── reading the store ────────────────────────────────────────────────────────

// The task row an id names: by its own id, else the row whose tool_use_id it is.
export function findRow(id) {
  const tasks = mirror.tasks instanceof Map ? mirror.tasks : new Map();
  if (tasks.has(id)) return tasks.get(id);
  for (const t of tasks.values()) if (t.tool_use_id === id) return t;
  return null;
}

// The row's RowModel (chat-present.js), as the tray draws it, or null.
function rowModelOf(row) {
  if (!row) return null;
  const cat = CAT_OF[row.kind];
  const entry = categories(mirror, null, { now: serverNow() }).find((e) => e.cat === cat);
  return (entry && entry.rows.find((r) => r.id === row.id)) || null;
}

// The tool_call item in the followed conversation's stream that started this
// row: an Agent call by links.agent_id, a Monitor by links.task_id, either by
// the row's tool_use_id.
function streamCallFor(row, link) {
  const turns = mirror.stream && Array.isArray(mirror.stream.turns) ? mirror.stream.turns : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const items = Array.isArray(turns[i].items) ? turns[i].items : [];
    for (const it of items) {
      if (!it || it.kind !== 'tool_call') continue;
      if (it.links && it.links[link] === row.id) return it;
      if (row.tool_use_id && it.id === row.tool_use_id) return it;
    }
  }
  return null;
}

const inputOf = (item) => (item && isObj(item.input) ? item.input : {});

// How long ago, on the server's clock; a running row's clock runs to now.
function elapsed(row, now) {
  if (!row || !finite(row.started_at)) return '';
  const end = finite(row.ended_at) && !isRunning(row) ? row.ended_at : now;
  return fmtClock(end - row.started_at);
}

// ── the header every task view opens with ────────────────────────────────────

// div.dv-head: the title, the status line, and (an agent's) Cancel and the
// refusal's note. It is also the "row" chat-actions.js's stop path reaches: its
// `.cs-row-note` takes a refusal's hint, its data-stopping says the request
// went out, and 'wc:row-refresh' asks it to repaint.
function header(v, { mono = false } = {}) {
  const head = el('div', 'dv-head');
  const title = el('div', mono ? 'dv-title dv-mono' : 'dv-title');
  const line = el('div', 'dv-line');
  const actions = el('div', 'dv-actions');
  actions.hidden = true;
  const hint = el('div', 'cs-row-note');
  hint.setAttribute('role', 'status');
  hint.hidden = true;
  head.append(title, line, actions, hint);
  head.addEventListener('wc:row-refresh', () => { if (v.paint) v.paint(); });
  return { head, title, line, actions };
}

// Paint the status line from parts: [{text, cls}].
function paintLine(line, parts) {
  const key = JSON.stringify(parts);
  if (line.dataset.key === key) return;
  line.dataset.key = key;
  const nodes = [];
  for (const p of parts) {
    if (!p || !p.text) continue;
    if (nodes.length) nodes.push(el('span', 'dv-sep', SEP));
    nodes.push(el('span', p.cls || 'dv-part', p.text));
  }
  line.replaceChildren(...nodes);
}

// The "No longer running" banner, once the row has left the store.
function goneBanner(v) {
  if (v.body.querySelector('.dv-gone')) return;
  const b = el('div', 'dv-gone', GONE);
  b.setAttribute('role', 'status');
  v.body.prepend(b);
}

// Watch the store: a row that leaves it ends the view's followers and puts the
// banner up; any other change repaints.
function watchRow(v, rowId, { inStore }) {
  let seen = inStore;
  v.row = () => (mirror.tasks instanceof Map ? mirror.tasks.get(rowId) : null) || null;
  v.gone = false;
  v.onMirror = () => {
    const row = v.row();
    if (row) {
      seen = true;
      v.last = row;   // what the view keeps showing if the row goes
    }
    if (!row && seen && !v.gone) {
      v.gone = true;
      v.endFollowers();
      goneBanner(v);
    }
    if (v.paint) v.paint();
    if (v.onRow) v.onRow(row);
    syncTicker();
  };
}

// ── 'task' ───────────────────────────────────────────────────────────────────

function renderTask(body, params, ctx) {
  const id = typeof params.id === 'string' ? params.id : '';
  const v = createView(body, ctx);
  ctx.setTitle('Task');
  if (!canRead()) {
    v.unshare();
    return () => v.close();
  }
  const row = id ? findRow(id) : null;
  if (row) {
    openTaskKind(v, row, { inStore: true });
    return () => v.close();
  }
  if (!id) {
    body.replaceChildren(note(UNTRACKED, 'dv-note dv-untracked'));
    return () => v.close();
  }
  // No row: ask the routes that answer for work the store does not hold.
  body.replaceChildren(note('Loading…', 'dv-note dv-loading'));
  (async () => {
    const agent = await v.get(`/api/mirror/agents/${encodeURIComponent(id)}`);
    if (!v.live()) return;
    if (agent.ok && agent.body && isObj(agent.body.agent)) {
      const r = normalizeTask(agent.body.agent);
      if (r) { openTaskKind(v, r, { inStore: false, first: agent.body }); return; }
    }
    const wf = await v.get(`/api/mirror/workflows/${encodeURIComponent(id)}`);
    if (!v.live()) return;
    if (wf.ok && wf.body && isObj(wf.body.workflow)) {
      const r = normalizeTask(wf.body.workflow);
      if (r) { openTaskKind(v, r, { inStore: false, first: wf.body, routeId: id }); return; }
    }
    body.replaceChildren(note(UNTRACKED, 'dv-note dv-untracked'));
  })();
  return () => v.close();
}

function openTaskKind(v, row, opts) {
  v.ctx.setTitle(`${KIND_WORD[row.kind] || 'Task'}${SEP}${row.title || KIND_WORD[row.kind] || 'task'}`);
  v.body.replaceChildren();
  watchRow(v, row.id, opts);
  v.last = row;
  const current = () => v.row() || v.last;
  if (row.kind === 'agent') agentView(v, current, opts);
  else if (row.kind === 'workflow') workflowView(v, current, opts);
  else outputView(v, current, row.kind);
  if (v.paint) v.paint();
  v.sync();
}

// ── shell and monitor: a followed tail ───────────────────────────────────────

function outputView(v, current, kind) {
  const shell = kind === 'shell';
  const h = header(v, { mono: shell });
  const cmd = el('pre', 'dv-cmd');
  cmd.hidden = true;
  const out = el('pre', shell ? 'dv-out' : 'dv-out dv-events');
  const footer = el('div', 'dv-footer');
  footer.hidden = true;
  const problem = note('', 'dv-note dv-problem');
  problem.hidden = true;
  v.body.append(h.head, cmd, out, footer, problem);
  let text = '';
  let lastTo = null;

  v.paint = () => {
    const row = current();
    h.title.textContent = row.title || KIND_WORD[kind];
    const now = serverNow();
    const model = v.gone ? null : rowModelOf(row);
    const stopping = h.head.dataset.stopping === 'true';
    const parts = [];
    if (isRunning(row) && !finite(row.stop_requested_at) && !stopping && shell) {
      parts.push({ text: `running ${elapsed(row, now)}`, cls: 'dv-status' });
      if (row.meta && finite(row.meta.port)) parts.push({ text: `:${row.meta.port}`, cls: 'dv-part' });
    } else if (stopping && isRunning(row)) {
      parts.push({ text: 'stopping…', cls: 'dv-status' });
    } else {
      parts.push({ text: model ? model.meta : row.status, cls: 'dv-status' });
    }
    paintLine(h.line, parts);
    // A monitor's command: the Monitor call that started it, when the stream holds it.
    if (!shell) {
      const call = streamCallFor(row, 'task_id');
      const c = str(inputOf(call).command);
      cmd.textContent = c ? `$ ${c}` : '';
      cmd.hidden = !c;
    }
  };
  v.clock = (tick) => {
    const run = isRunning(current()) && !v.gone;
    if (tick && run) v.paint();
    return run;
  };

  const id = current().id;
  v.follow((done) => followTaskOutput(id, {
    ...(lastTo === null ? { tail: TAIL_BYTES } : { from: lastTo }),
    intervalMs: followMs,
    alive: () => v.visible() && !v.gone,
  }, (o) => {
    if (o.error) {
      problem.textContent = 'Output unavailable — the daemon did not answer.';
      problem.hidden = false;
      done();
      return;
    }
    problem.hidden = true;
    const stuck = isStuck(v.body);
    text = lastTo !== null && o.from === lastTo ? text + o.text : o.text;
    if (text.length > TAIL_BYTES) text = text.slice(text.length - TAIL_BYTES);
    if (finite(o.to)) lastTo = o.to;
    if (out.textContent !== text) out.textContent = text;
    footer.textContent = o.footer || '';
    footer.hidden = !o.footer;
    if (stuck) v.body.scrollTop = v.body.scrollHeight;
    if (o.ended && o.eof) done();
  }));
}

// ── agent: its own transcript, followed live ─────────────────────────────────

function agentView(v, current, opts) {
  const h = header(v);
  const prompt = el('details', 'dv-prompt');
  prompt.hidden = true;
  const earlier = button('dv-earlier', 'Load earlier');
  earlier.hidden = true;
  const list = el('div', 'dv-items');
  const result = el('div', 'dv-result');
  result.hidden = true;
  const problem = note('', 'dv-note dv-problem');
  problem.hidden = true;
  v.body.append(h.head, prompt, earlier, list, result, problem);

  const agentId = current().id;
  const shown = new Map();     // item id → { item, el }
  let promptId = null;
  let nextBefore = null;
  let routeAgent = null;       // the route's raw row: type and model live in its meta (U42)
  let maxSeq = null;
  let finished = false;

  const meta = () => {
    const m = routeAgent && isObj(routeAgent.meta) ? routeAgent.meta : {};
    let type = str(m.agent_type);
    let model = str(m.model);
    if (!type || !model) {
      const call = streamCallFor(current(), 'agent_id');
      const input = inputOf(call);
      if (!type) type = str(input.subagent_type);
      if (!model) model = str(input.model);
    }
    return { type, model };
  };

  v.paint = () => {
    const row = current();
    h.title.textContent = row.title || 'Agent';
    const now = serverNow();
    const model = v.gone ? null : rowModelOf(row);
    const asked = h.head.dataset.stopping === 'true';   // this view's own request, before the store says so
    const stopping = asked || (isRunning(row) && finite(row.stop_requested_at));
    const parts = [];
    let status;
    if (asked && isRunning(row) && !finite(row.stop_requested_at)) status = 'stopping…';
    else if (stopping && isRunning(row)) status = model && model.meta ? model.meta : 'stopping…';
    else if (isRunning(row)) status = 'running';
    else status = model && model.meta ? model.meta : row.status;
    parts.push({ text: status, cls: 'dv-status' });
    parts.push({ text: elapsed(row, now), cls: 'dv-elapsed' });
    if (row.meta && finite(row.meta.tools)) parts.push({ text: plural(row.meta.tools, 'tool'), cls: 'dv-tools' });
    const { type, model: mdl } = meta();
    if (type) parts.push({ text: type, cls: 'dv-type' });
    if (mdl) parts.push({ text: mdl, cls: 'dv-model' });
    paintLine(h.line, parts);
    // Cancel, when the row's RowModel offers it (task_stop and `full`), as in the tray (§6.9).
    const cancel = model && !stopping ? (model.actions || []).find((a) => a.id === 'cancel') : null;
    const held = h.actions.querySelector('.dv-cancel');
    if (cancel && !held) {
      const b = button('dv-cancel', cancel.label);
      b.dataset.action = 'cancel';
      b.dataset.destructive = 'true';
      b.addEventListener('click', () => {
        const m = rowModelOf(current());
        if (!m) return;
        const sheet = v.body.closest && v.body.closest('.chat-panel[data-variant="sheet"]');
        runAction(m, 'cancel', { rowEl: h.head, density: sheet ? 'touch' : 'compact', button: b });
      });
      h.actions.replaceChildren(b);
    } else if (!cancel && held) {
      h.actions.replaceChildren();
      const open = h.head.querySelector('.cs-row-confirm');
      if (open) open.remove();
    }
    // An open confirm (chat-actions.js) hides the buttons itself until it is answered.
    if (!h.head.querySelector('.cs-row-confirm')) h.actions.hidden = !cancel;
    if (!isRunning(row) && !finished && !v.gone) finish();
  };
  v.clock = (tick) => {
    const run = isRunning(current()) && !v.gone;
    if (tick && run) v.paint();
    return run;
  };

  function draw(item) {
    if (item.kind === 'tool_call') {
      const held = shown.get(item.id);
      return renderToolCard(item, { prev: held ? held.el : null });
    }
    if (item.kind === 'reply' || item.kind === 'prompt') return prose(item.text);
    if (item.kind === 'thinking') {
      const label = finite(item.duration_ms) ? `Thought for ${Math.max(1, Math.round(item.duration_ms / 1000))} s` : 'Thought';
      const d = el('details', 'dv-think');
      d.append(el('summary', 'dv-think-sum', label), el('div', 'dv-think-text', item.text || ''));
      return d;
    }
    const text = item.text || item.summary || item.event || item.notice || '';
    return text ? el('div', 'dv-sys', text) : null;
  }

  // Items from the route: normalised by the store's one reader of the wire, a
  // 'text' item read as a reply, and kept in seq order.
  function readItems(raw) {
    const out = [];
    for (const r of Array.isArray(raw) ? raw : []) {
      if (!isObj(r)) continue;
      const src = r.kind === 'text' ? { ...r, kind: 'reply' } : r;
      const it = normalizeItem(src, { caps: 'full', turn_id: str(r.turn_id) || agentId });
      if (it && finite(it.seq)) out.push(it);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  function place(item) {
    if (item.kind === 'prompt' && (promptId === null || promptId === item.id)) {
      promptId = item.id;
      const sum = el('summary', 'dv-prompt-sum', 'Prompt');
      prompt.replaceChildren(sum, prose(item.text, 'dv-prose dv-prompt-text'));
      prompt.hidden = false;
      shown.set(item.id, { item, el: prompt });
      return;
    }
    const held = shown.get(item.id);
    if (held && held.item === item) return;
    const node = draw(item);
    if (node) node.dataset.seq = String(item.seq);
    if (held) {
      if (node && held.el && node !== held.el) held.el.replaceWith(node);
      shown.set(item.id, { item, el: node || held.el });
      return;
    }
    if (!node) { shown.set(item.id, { item, el: null }); return; }
    // In seq order: before the first shown item with a higher seq.
    const after = [...list.children].find((c) => Number(c.dataset.seq) > item.seq);
    if (after) list.insertBefore(node, after);
    else list.append(node);
    shown.set(item.id, { item, el: node });
  }

  function merge(items) {
    const stuck = isStuck(v.body);
    for (const it of items) {
      place(it);
      if (maxSeq === null || it.seq > maxSeq) maxSeq = it.seq;
    }
    if (stuck) v.body.scrollTop = v.body.scrollHeight;
  }

  function takePage(page) {
    if (isObj(page.agent)) {
      routeAgent = page.agent;
      const r = normalizeTask(page.agent);
      if (r) v.last = r;
    }
    nextBefore = finite(page.next_before) ? page.next_before : null;
    earlier.hidden = nextBefore === null;
    merge(readItems(page.items));
  }

  // Once the agent is done: its result as chat markdown (the Agent call's result
  // in the stream).
  // Done only once the result is drawn: until the stream carries it, each later
  // 'mirror' event looks again.
  function finish() {
    const call = streamCallFor(current(), 'agent_id');
    const text = call && call.result && str(call.result.preview);
    if (text) {
      finished = true;
      result.replaceChildren(el('div', 'dv-result-head', 'Result'), prose(text, 'dv-prose dv-result-text'));
      result.hidden = false;
    }
  }

  earlier.addEventListener('click', async () => {
    if (nextBefore === null || earlier.disabled || !v.live()) return;
    earlier.disabled = true;
    earlier.textContent = 'Loading…';
    const r = await v.get(`/api/mirror/agents/${encodeURIComponent(agentId)}?before=${encodeURIComponent(String(nextBefore))}`);
    if (!v.live()) return;
    earlier.disabled = false;
    earlier.textContent = 'Load earlier';
    if (!r.ok || !r.body) {
      problem.textContent = 'The earlier items could not be loaded.';
      problem.hidden = false;
      return;
    }
    problem.hidden = true;
    const top = v.body.scrollHeight - v.body.scrollTop;
    const items = readItems(r.body.items);
    for (const it of items) place(it);
    nextBefore = finite(r.body.next_before) ? r.body.next_before : null;
    earlier.hidden = nextBefore === null;
    // Prepended: keep what was on screen where it was.
    if (v.body.scrollHeight > 0) v.body.scrollTop = v.body.scrollHeight - top;
  });

  // While the agent runs, followAgentItems appends what it writes.
  function startFollow() {
    v.follow((done) => followAgentItems(agentId, {
      after: maxSeq === null ? undefined : maxSeq,
      intervalMs: followMs,
      alive: () => v.visible() && !v.gone,
    }, (o) => {
      if (o.error) {
        problem.textContent = 'The agent\'s transcript stopped answering.';
        problem.hidden = false;
        done();
        return;
      }
      problem.hidden = true;
      if (isObj(o.agent)) {
        routeAgent = o.agent;
        const r = normalizeTask(o.agent);
        if (r) v.last = r;
      }
      merge(readItems(o.items));
      const row = current();
      if (!isRunning(row) && !(o.items && o.items.length)) done();
      v.paint();
    }));
  }

  if (opts.first) {
    takePage(opts.first);
    if (isRunning(current())) startFollow();
  } else {
    list.replaceChildren(note('Loading…', 'dv-note dv-loading'));
    (async () => {
      const r = await v.get(`/api/mirror/agents/${encodeURIComponent(agentId)}`);
      if (!v.live()) return;
      list.replaceChildren();
      if (!r.ok || !r.body) {
        problem.textContent = 'The agent\'s transcript could not be loaded.';
        problem.hidden = false;
      } else {
        takePage(r.body);
      }
      v.paint();
      if (isRunning(current()) && !v.gone) startFollow();
    })();
  }
}

// ── workflow: its phases and agents ──────────────────────────────────────────

function workflowView(v, current, opts) {
  const h = header(v);
  const bar = el('div', 'dv-phases');
  bar.setAttribute('role', 'list');
  const phaseLine = el('div', 'dv-phase-line');
  const table = el('table', 'dv-agents');
  const thead = el('thead');
  const hr = el('tr');
  for (const t of ['Agent', 'Phase', 'State', 'Last tool', 'Elapsed']) hr.append(el('th', null, t));
  thead.append(hr);
  const tbody = el('tbody');
  table.append(thead, tbody);
  table.hidden = true;
  const empty = note('No agents yet.', 'dv-note dv-noagents');
  empty.hidden = true;
  const problem = note('', 'dv-note dv-problem');
  problem.hidden = true;
  v.body.append(h.head, bar, phaseLine, table, empty, problem);

  const routeId = opts.routeId || current().id;
  let detail = opts.first || null;
  let lastRev = finite(current().rev) ? current().rev : null;
  let lastFetch = 0;
  let pending = false;
  let inFlight = false;

  function paintPhases() {
    const row = current();
    const steps = Array.isArray(row.steps) && row.steps.length ? row.steps.map((s) => ({ title: s.label, state: s.state }))
      : detail && Array.isArray(detail.phases) ? detail.phases.filter(isObj) : [];
    const key = JSON.stringify(steps);
    if (bar.dataset.key === key) return;
    bar.dataset.key = key;
    bar.replaceChildren(...steps.map((s) => {
      const seg = el('span', 'dv-phase');
      seg.setAttribute('role', 'listitem');
      seg.dataset.state = str(s.state) || 'pending';
      seg.title = `${str(s.title) || 'phase'}: ${seg.dataset.state}`;
      seg.setAttribute('aria-label', seg.title);
      return seg;
    }));
    bar.hidden = !steps.length;
    const at = steps.find((s) => s.state === 'running') || steps.find((s) => s.state === 'error');
    phaseLine.textContent = at ? `${str(at.title) || 'phase'} · ${at.state}` : '';
    phaseLine.hidden = !phaseLine.textContent;
  }

  function paintAgents() {
    const agents = detail && Array.isArray(detail.agents) ? detail.agents.filter((a) => isObj(a) && typeof a.agent_id === 'string') : [];
    const now = serverNow();
    const rows = agents.map((a) => {
      const tr = el('tr', 'dv-agent');
      tr.dataset.agentId = a.agent_id;
      tr.dataset.state = str(a.state);
      const name = button('dv-agent-open', str(a.label) || str(a.key) || a.agent_id);
      name.title = 'Open this agent';
      name.addEventListener('click', (e) => {
        e.stopPropagation();
        openDetail({ kind: 'task', params: { id: a.agent_id } });
      });
      const first = el('td', 'dv-agent-name');
      first.append(name);
      const span = finite(a.started_at) ? fmtClock((finite(a.ended_at) ? a.ended_at : now) - a.started_at) : '';
      tr.append(first, el('td', null, str(a.phase)), el('td', 'dv-agent-state', str(a.state)),
        el('td', 'dv-agent-tool', str(a.last_tool)), el('td', 'dv-agent-time', span));
      tr.addEventListener('click', () => openDetail({ kind: 'task', params: { id: a.agent_id } }));
      return tr;
    });
    tbody.replaceChildren(...rows);
    table.hidden = !rows.length;
    empty.hidden = !!rows.length || !detail;
  }

  v.paint = () => {
    const row = current();
    h.title.textContent = row.title || 'Workflow';
    const model = v.gone ? null : rowModelOf(row);
    const parts = [{ text: isRunning(row) ? 'running' : (model && model.meta) || row.status, cls: 'dv-status' }];
    if (isRunning(row) && model && model.meta) parts.push({ text: model.meta, cls: 'dv-part' });
    parts.push({ text: elapsed(row, serverNow()), cls: 'dv-elapsed' });
    paintLine(h.line, parts);
    paintPhases();
  };
  v.clock = (tick) => {
    const run = isRunning(current()) && !v.gone;
    if (tick && run) { v.paint(); paintAgents(); }
    return run;
  };

  async function refetch() {
    if (inFlight || !v.live()) return;
    inFlight = true;
    pending = false;
    lastFetch = Date.now();
    const r = await v.get(`/api/mirror/workflows/${encodeURIComponent(routeId)}`);
    inFlight = false;
    if (!v.live()) return;
    if (r.ok && r.body) {
      detail = r.body;
      problem.hidden = true;
    } else if (!detail) {
      problem.textContent = 'The workflow could not be loaded.';
      problem.hidden = false;
    }
    paintAgents();
    v.paint();
    if (pending) schedule();
  }

  // At most one read per followMs: a change inside the window waits for its
  // end (one timer, the view's only one), and one off screen until it shows.
  function schedule() {
    pending = true;
    if (!v.live() || v.gone || !v.visible() || inFlight || v.timers.size) return;
    const wait = lastFetch + followMs - Date.now();
    if (wait <= 0) refetch();
    else v.later(() => { if (pending) schedule(); }, wait);
  }

  v.onRow = (row) => {
    if (!row || !finite(row.rev) || row.rev === lastRev) return;
    lastRev = row.rev;
    schedule();
  };
  // Shown again with a change that waited: read it now.
  const sync = v.sync;
  v.sync = () => {
    sync();
    if (pending) schedule();
  };

  if (detail) {
    lastFetch = Date.now();
    paintAgents();
  } else {
    refetch();
  }
}

// ── 'diff' ───────────────────────────────────────────────────────────────────

const STATUS_LETTER = new Set(['A', 'M', 'D', 'T']);

// The patch split at each 'diff --git ' header, each section given to the file
// it is about. Paths in the record are relative to the project root and the
// headers to the repository's top level, so a header names a file when it ends
// with ' b/<path>' (or '/<path>', for a project below the top level).
export function splitPatch(patch, files) {
  const sections = [];
  let cur = null;
  for (const line of String(patch || '').split(/(?<=\n)/)) {
    if (line.startsWith('diff --git ')) {
      cur = { head: line.replace(/\n$/, ''), text: line };
      sections.push(cur);
    } else if (cur) cur.text += line;
  }
  const out = new Map();
  const free = new Set(sections);
  for (const exact of [true, false]) {
    for (const f of files) {
      if (out.has(f) || !f || typeof f.path !== 'string' || !f.path) continue;
      for (const s of free) {
        const hit = exact ? s.head.endsWith(` b/${f.path}`) || s.head.endsWith(` a/${f.path}`)
          : s.head.endsWith(`/${f.path}`);
        if (!hit) continue;
        out.set(f, s.text);
        free.delete(s);
        break;
      }
    }
  }
  return out;
}

function fileSummary(f) {
  const sum = el('summary', 'dv-file-head');
  const letter = STATUS_LETTER.has(f.status) ? f.status : '?';
  const st = el('span', 'dv-fstatus', letter);
  st.dataset.status = letter;
  sum.append(st, el('span', 'dv-fpath', f.path || ''));
  if (!f.binary && (finite(f.additions) || finite(f.deletions))) {
    sum.append(el('span', 'dv-add', `+${fmtInt(f.additions)}`), el('span', 'dv-del', `−${fmtInt(f.deletions)}`));
  }
  return sum;
}

// One <details> per file; its body the file's own section of the patch, or the
// state that says why there is none (§7.12, §2.7).
function fileDetails(f, section, record) {
  const d = el('details', 'dv-file');
  d.dataset.path = f.path || '';
  d.append(fileSummary(f));
  const body = el('div', 'dv-file-body');
  if (f.withheld) {
    d.dataset.state = 'withheld';
    body.append(note('contents hidden', 'dv-note dv-state'));
  } else if (f.binary) {
    d.dataset.state = 'binary';
    body.append(note('binary file', 'dv-note dv-state'));
  } else if (f.truncated && section) {
    d.dataset.state = 'truncated';
    const line = el('p', 'dv-note dv-state');
    const show = button('dv-show', 'show');
    line.append(`too large — ${fmtInt((f.additions || 0) + (f.deletions || 0))} lines (`, show, ')');
    const box = diffBox(section);
    box.hidden = true;
    show.addEventListener('click', () => {
      box.hidden = !box.hidden;
      show.textContent = box.hidden ? 'show' : 'hide';
    });
    body.append(line, box);
  } else if (section) {
    body.append(diffBox(section));
  } else {
    d.dataset.state = 'missing';
    body.append(note(record.patch_truncated ? 'not in the diff: it was truncated before this file' : 'no change to show',
      'dv-note dv-state'));
  }
  d.append(body);
  return d;
}

const totalsText = (t) => (t && finite(t.files)
  ? `${plural(t.files, 'file')} +${fmtInt(t.additions)} −${fmtInt(t.deletions)}` : '');

function totalsOf(record) {
  if (isObj(record.totals) && finite(record.totals.files)) return record.totals;
  const files = Array.isArray(record.files) ? record.files : [];
  return { files: files.length, additions: files.reduce((n, f) => n + (finite(f.additions) ? f.additions : 0), 0),
    deletions: files.reduce((n, f) => n + (finite(f.deletions) ? f.deletions : 0), 0) };
}

// A record (a turn's, or a node's combined): its status, its files, its patch.
function recordNodes(record) {
  if (record.status === 'unavailable') {
    return [note(`No code diff: ${str(record.reason) || 'unavailable'}`, 'dv-note dv-unavailable')];
  }
  if (record.status === 'pending') return [note('The changes are still being recorded.', 'dv-note dv-pending')];
  const files = Array.isArray(record.files) ? record.files.filter(isObj) : [];
  if (!files.length) return [note('No files changed.', 'dv-note dv-nochange')];
  const sections = splitPatch(record.patch, files);
  const out = [el('div', 'dv-totals', totalsText(totalsOf(record)))];
  const list = el('div', 'dv-files');
  let missing = 0;
  for (const f of files) {
    const section = sections.get(f) || '';
    if (!section && !f.withheld && !f.binary) missing += 1;
    list.append(fileDetails(f, section, record));
  }
  out.push(list);
  if (record.patch_truncated && missing) {
    out.push(note(`diff truncated — ${plural(missing, 'more file')}`, 'dv-note dv-truncated'));
  }
  return out;
}

// What the stream knows of a turn: its prompt's first words.
function turnName(turnId) {
  const turns = mirror.stream && Array.isArray(mirror.stream.turns) ? mirror.stream.turns : [];
  const t = turns.find((x) => x && x.id === turnId);
  const p = t && t.prompt && str(t.prompt.preview);
  return p ? (p.length > 80 ? `${p.slice(0, 79)}…` : p) : 'A turn';
}

// A node whose combined diff is gone: each turn's files, with a link to its own.
function turnsNodes(turns) {
  const out = [note('the combined diff is no longer available', 'dv-note dv-nocombined')];
  for (const rec of turns.filter(isObj)) {
    const box = el('section', 'dv-turn');
    box.dataset.turnId = str(rec.turn_id);
    const head = el('div', 'dv-turn-head');
    head.append(el('span', 'dv-turn-name', turnName(rec.turn_id)));
    if (rec.status === 'ready') head.append(el('span', 'dv-turn-totals', totalsText(totalsOf(rec))));
    box.append(head);
    if (rec.status === 'unavailable') box.append(note(`No code diff: ${str(rec.reason) || 'unavailable'}`, 'dv-note dv-unavailable'));
    const ul = el('ul', 'dv-turn-files');
    for (const f of Array.isArray(rec.files) ? rec.files.filter(isObj) : []) {
      const li = el('li', 'dv-turn-file');
      const letter = STATUS_LETTER.has(f.status) ? f.status : '?';
      li.append(el('span', 'dv-fstatus', letter), el('span', 'dv-fpath', f.path || ''));
      if (!f.binary && (finite(f.additions) || finite(f.deletions))) li.append(el('span', 'dv-add', `+${fmtInt(f.additions)}`), el('span', 'dv-del', `−${fmtInt(f.deletions)}`));
      ul.append(li);
    }
    if (ul.children.length) box.append(ul);
    if (rec.turn_id) {
      const open = button('dv-turn-open', 'View this turn\'s changes');
      open.addEventListener('click', () => bus.emit('chat:open', { view: 'diff', id: rec.turn_id }));
      box.append(open);
    }
    out.push(box);
  }
  if (!turns.length) out.push(note('No code changes were recorded for this node.', 'dv-note dv-nochange'));
  return out;
}

function renderDiffView(body, params, ctx) {
  const v = createView(body, ctx);
  const nodeId = typeof params.node_id === 'string' && params.node_id ? params.node_id : null;
  const turnId = !nodeId && typeof params.id === 'string' && params.id ? params.id : null;
  ctx.setTitle(nodeId ? `Changes${SEP}${labelFor(nodeId)}` : `Changes${SEP}this turn`);
  if (!canRead()) {
    v.unshare();
    return () => v.close();
  }
  if (!nodeId && !turnId) {
    body.replaceChildren(note('Nothing to show.', 'dv-note'));
    return () => v.close();
  }
  const url = nodeId ? `/api/mirror/diff?node=${encodeURIComponent(nodeId)}` : `/api/mirror/diff?turn=${encodeURIComponent(turnId)}`;
  const load = async () => {
    if (!v.live()) return;
    body.replaceChildren(note('Loading…', 'dv-note dv-loading'));
    const r = await v.get(url);
    if (!v.live()) return;
    if (!r.ok || !r.body) {
      const line = note(r.status === 404 ? 'No changes were recorded here.' : 'The changes could not be loaded. ', 'dv-note dv-problem');
      if (r.status !== 404) {
        const retry = button('dv-retry', 'Retry');
        retry.addEventListener('click', load);
        line.append(retry);
      }
      body.replaceChildren(line);
      return;
    }
    const b = r.body;
    const wrap = el('div', 'dv-diffview');
    if (nodeId) {
      const label = (isObj(b.node) && str(b.node.label)) || labelFor(nodeId);
      const combined = isObj(b.combined) ? b.combined : null;
      const turns = Array.isArray(b.turns) ? b.turns : [];
      const t = combined ? totalsText(totalsOf(combined)) : '';
      ctx.setTitle(`Changes${SEP}${label}${t ? `${SEP}${t}` : ''}`);
      wrap.append(...(combined ? recordNodes({ status: 'ready', ...combined }) : turnsNodes(turns)));
    } else {
      wrap.append(...recordNodes(b));
    }
    body.replaceChildren(wrap);
  };
  load();
  return () => v.close();
}

// ── the module's surface ─────────────────────────────────────────────────────

// The access level first: a view the level fell under is demoted to the one
// line, and one showing that line opens afresh once the level allows it.
function onMirror() {
  const read = canRead();
  for (const v of [...views]) {
    if (v.closed) continue;
    try {
      if (!read) { if (!v.unshared) v.unshare(); continue; }
      if (v.unshared) {
        if (v.ctx.reopen) { v.close(); v.ctx.reopen(); }
        continue;
      }
      if (v.onMirror) v.onMirror();
    } catch (e) { console.error('[web-chat] a detail view failed to update', e); }
  }
}

function onPosture() {
  for (const v of [...views]) v.sync();
  syncTicker();
}

// Each render is guarded: a view that throws shows one line, never a blank page.
// Its ctx carries `reopen`, which renders it afresh into the same body (the
// level rising over a view that said "not shared"); the cleanup the panel holds
// ends whichever render is current.
function guarded(render) {
  return (body, params, ctx) => {
    let cleanup;
    let ended = false;
    const open = () => {
      try {
        cleanup = render(body, params || {}, { ...ctx, reopen: () => { if (!ended) open(); } });
      } catch (e) {
        console.error('[web-chat] a detail view failed', e);
        body.replaceChildren(note('This view could not be shown.', 'dv-note dv-problem'));
        cleanup = undefined;
      }
    };
    open();
    return () => {
      ended = true;
      if (typeof cleanup === 'function') cleanup();
    };
  };
}

export function initChatDetail({ followMs: ms } = {}) {
  if (finite(ms) && ms >= 0) followMs = ms;
  if (typeof document === 'undefined') return false;
  if (offs.length) return true;
  offs = [
    registerDetail('task', guarded(renderTask)),
    registerDetail('diff', guarded(renderDiffView)),
    bus.on('mirror', onMirror),
    bus.on('chat:posture', onPosture),
  ];
  return true;
}

export function stopChatDetail() {
  for (const off of offs.splice(0)) off();
  for (const v of [...views]) v.close();
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
  followMs = FOLLOW_MS;
}

// How many views are open (and following), for a test's teardown check.
export function openViews() {
  return views.size;
}
