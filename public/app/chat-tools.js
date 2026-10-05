// The tool cards of the chat stream (design spec §7.10 "Tool cards", §7.11, §2.4,
// §2.10): one card per tool_call item, inside its turn's group.
//
//   initChatTools()          registers the cards through chat-stream.js
//                            setToolRenderer (U37); idempotent. → the restore
//   stopChatTools()          puts the stream's generic card back
//   renderToolCard(item, {turn, prev})   one card (the renderer itself)
//   fmtDur(ms)               '1.2s', '42s', '1:12'
//   diffStats(patch)         {add, del, created} of a unified-diff text
//
// A CARD is a header — the label, then the status glyph and the meta ('Read ·
// app.css' · '✓ 120 lines', 'Bash · npm test' · '✗ exit 2') — and a body that
// is built the first time the card is expanded. Dispatch is on the item's
// `tool_kind` (lib/core/tool-input.js toolKind writes it: Bash, Read, Edit,
// Write, Grep, Glob, Web, Search, Agent, Skill, Todo, Monitor, Stop, Question,
// Plan, MCP, an unknown tool's own name such as Workflow, and Tool); an MCP call
// on web-chat's own server is its own kind. No tool name is read here: the one
// table of tool names is lib/core/tool-input.js.
//
// LAZY AND ONCE. A body that needs more than the store holds fetches ONE field
// of the item (GET /api/mirror/items/:id?field=result|input, U29's route) on the
// card's first expand, never before, and caches it per item id in this module,
// so collapsing, expanding again and every keyed re-render of the turn (the
// stream hands the old card back as `prev`, and the card is reused) request
// nothing more. Only Read's 'Show more' asks again, for the next page, on its
// own click, up to BODY_CAP. A failed fetch is one line with Retry; nothing here
// throws into the stream. A running call has no result yet: its body shows what
// the store holds and fetches once the call has ended.
//
// TEXT. Every string from the mirror goes in by textContent; markdown (an
// agent's result, a plan) through renderMarkdown(text, {flavor: 'chat'}) and a
// patch through renderDiff, the one engine, which escapes everything (U35).
//
// LEVEL. A body is content: below `read` a card is its header alone, from the
// store, and nothing is fetched (the store holds no content there either).
//
// LIVE. An agent, a workflow, a monitor and a background shell read their task
// row (chat-state's mirror.tasks) for the meta ('running 1:12 · 6 tools', 'N
// events', the phase bar). The stream redraws a card only when its item
// changes, so those cards repaint their header on every `mirror` event and, while
// one runs, on one 1 s ticker that stops when none does.
//
// OPEN. 'Open task', 'Open agent', 'Open workflow' and 'Open monitor' emit bus
// `chat:open` {view: 'task', id}; the views that answer it are tranche 3's
// (U47). 'Show on page' on a web-chat call that put up a pane calls mounts.js
// revealPane(id).
import { bus } from './bus.js';
import { mirror, atLeast, serverNow } from './chat-state.js';
import { fmtClock } from './chat-present.js';
import { setToolRenderer } from './chat-stream.js';
import { renderMarkdown, renderDiff } from './markdown.js';
import { revealPane } from './mounts.js';

export const PAGE = 65536;          // one fetched page of a field (characters or bytes)
export const BODY_CAP = 262144;     // the most a body shows: §2.4's full-read cap
export const TAIL_LINES = 80;       // a shell's output tail
export const CACHE_MAX = 400;       // bodies kept for cards no longer in the DOM
const FIELD_MAX = 262144;           // the route's largest page (§2.10)
const TICK_MS = 1000;

const GLYPH = Object.freeze({ running: '◌', done: '✓', error: '✗', denied: '⊘', interrupted: '✕' });
const STATUS_WORD = Object.freeze({ denied: 'denied', interrupted: 'interrupted' });
const SEP = ' · ';

// web-chat's own tools that put an item on the page (its MCP server, not Claude
// Code's tool table).
const REVEALS = new Set(['render', 'use_component', 'write_markdown']);

// ── small helpers ────────────────────────────────────────────────────────────

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
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v ? v : '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const canRead = () => atLeast(mirror.access.level, 'read');
// 'running 1:12' on the server's clock, or 'running' with no start recorded.
const runningFor = (started) => (Number.isFinite(started) ? `running ${fmtClock(serverNow() - started)}` : 'running');

// A span: '1.2s' under ten seconds, '42s' under a minute, then '1:12'.
export function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 10000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return fmtClock(ms);
}

// A unified diff's added and removed lines; `created` when every hunk starts
// from nothing (a Write that made the file).
export function diffStats(patch) {
  const out = { add: 0, del: 0, created: false };
  if (typeof patch !== 'string' || !patch) return out;
  let hunks = 0;
  let fromNothing = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      hunks++;
      if (/^@@ -0,0 /.test(line)) fromNothing++;
    } else if (line.startsWith('+')) out.add++;
    else if (line.startsWith('-')) out.del++;
  }
  out.created = hunks > 0 && hunks === fromNothing;
  return out;
}

function lines(s) {
  const t = String(s || '').replace(/\n+$/, '');
  return t ? t.split('\n') : [];
}

function utf8Length(s) {
  try { return new TextEncoder().encode(s).length; } catch { return s.length; }
}

// Does the store's preview hold the whole result?
function previewComplete(item) {
  const r = item.result;
  if (!r || typeof r.preview !== 'string' || item.truncated || r.full === false) return false;
  return !Number.isFinite(r.bytes) || utf8Length(r.preview) >= r.bytes;
}

const preview = (item) => (item.result && typeof item.result.preview === 'string' ? item.result.preview : '');
const inputOf = (item) => (isObj(item.input) ? item.input : {});

// The task row a call started or names (an agent, a workflow, a monitor, a
// background shell), else null.
function taskFor(item) {
  const l = isObj(item.links) ? item.links : {};
  const ids = new Set([l.task_id, l.agent_id, l.run_id].filter(Boolean));
  for (const t of mirror.tasks.values()) {
    if (t.tool_use_id === item.id || ids.has(t.id)) return t;
  }
  return null;
}

// ── the kinds ────────────────────────────────────────────────────────────────

function mcpTool(item) {
  const server = str(item.server);
  const tool = str(item.tool);
  const head = `mcp__${server}__`;
  return server && tool.startsWith(head) ? tool.slice(head.length) : '';
}

function kindOf(item) {
  if (item.server === 'web-chat') return 'webchat';
  return str(item.tool_kind) || 'Tool';
}

const isBackground = (item) => item.tool_kind === 'Bash' && inputOf(item).run_in_background === true;

// The id the 'Open …' button names, by kind.
function openTarget(item, kind) {
  const l = isObj(item.links) ? item.links : {};
  const row = taskFor(item);
  if (kind === 'Agent') return { label: 'Open agent', id: l.agent_id || (row && row.id) || '' };
  if (kind === 'Workflow') return { label: 'Open workflow', id: l.run_id || (row && row.id) || '' };
  if (kind === 'Monitor') return { label: 'Open monitor', id: l.task_id || (row && row.id) || '' };
  if (kind === 'Bash') return { label: 'Open task', id: l.task_id || (row && row.id) || '' };
  return null;
}

// The pane or markdown item a web-chat call put up: its input's id, else the id
// its result answered.
function mountIdOf(item) {
  if (!REVEALS.has(mcpTool(item))) return '';
  const id = inputOf(item).id;
  if (typeof id === 'string' && id && id.length <= 128) return id;
  try {
    const r = JSON.parse(preview(item));
    if (isObj(r) && typeof r.id === 'string' && r.id && r.id.length <= 128) return r.id;
  } catch { /* not JSON */ }
  return '';
}

function label(item, kind) {
  let text = str(item.label) || str(item.call) || str(item.tool) || kind;
  if (kind === 'Write' && diffStats(item.edit && item.edit.patch).created) text = text.replace(/^Write\b/, 'Write (new)');
  if (kind === 'Bash' && isBackground(item)) text += `${SEP}background`;
  if (kind === 'Stop') {
    const i = inputOf(item);
    const id = str(i.task_id) || str(i.shell_id);
    const row = id ? mirror.tasks.get(id) : null;
    if (row && row.title) text = `Stop${SEP}${row.title}`;
  }
  return text;
}

// The meta after the glyph: [{text, cls?}] parts.
function meta(item, kind) {
  const status = item.status || 'running';
  if (STATUS_WORD[status]) return [{ text: STATUS_WORD[status] }];
  const r = isObj(item.result) ? item.result : {};
  const dur = fmtDur(item.duration_ms);
  const row = taskFor(item);
  switch (kind) {
    case 'Read': {
      if (status !== 'done') return [{ text: status === 'running' ? 'running' : 'error' }];
      const text = preview(item);
      if (!text && !Number.isFinite(r.bytes)) return [];
      if (previewComplete(item)) {
        const all = lines(text);
        const numbered = all.filter((l) => /^\s*\d+[→\t]/.test(l)).length;
        return [{ text: plural(numbered || all.length, 'line') }];
      }
      return Number.isFinite(r.bytes) ? [{ text: fmtBytes(r.bytes) }] : [];
    }
    case 'Edit':
    case 'Write': {
      if (status === 'running') return [{ text: 'running' }];
      if (status === 'error') return [{ text: 'error' }];
      const s = diffStats(item.edit && item.edit.patch);
      const out = [{ text: `+${s.add}`, cls: 'tc-add' }];
      if (!s.created) out.push({ text: `−${s.del}`, cls: 'tc-del' });
      return out;
    }
    case 'Bash': {
      if (isBackground(item)) {
        if (row) return [{ text: row.status === 'running' ? runningFor(row.started_at || item.started_at)
          : Number.isInteger(row.exit_code) ? `${row.status} · exit ${row.exit_code}` : row.status }];
        return [{ text: status === 'running' ? 'starting' : 'started' }];
      }
      if (status === 'running') return [{ text: 'running' }];
      if (status === 'error') {
        const m = /^\s*Exit code (\d+)/i.exec(preview(item));
        return [{ text: m ? `exit ${m[1]}` : 'error' }];
      }
      return dur ? [{ text: dur }] : [];
    }
    case 'Grep':
    case 'Glob': {
      if (status !== 'done') return [{ text: status === 'running' ? 'running' : 'error' }];
      const text = preview(item);
      const m = /^Found (\d+) (files?|matches|match|lines?)/i.exec(text);
      if (m) return [{ text: `${m[1]} ${m[2]}` }];
      if (/^No (files|matches) found/i.test(text)) return [{ text: kind === 'Glob' ? '0 files' : 'no matches' }];
      if (kind === 'Glob' && previewComplete(item)) return [{ text: plural(lines(text).length, 'file') }];
      return dur ? [{ text: dur }] : [];
    }
    case 'Agent': {
      const tools = row && Number.isFinite(row.meta && row.meta.tools) ? plural(row.meta.tools, 'tool') : '';
      const running = row ? row.status === 'running' : status === 'running';
      const started = (row && row.started_at) || item.started_at;
      let time;
      if (running) time = runningFor(started);
      else if (row && Number.isFinite(row.ended_at) && Number.isFinite(row.started_at)) time = fmtClock(row.ended_at - row.started_at);
      else time = status === 'error' ? 'error' : dur;
      return [{ text: [time, tools].filter(Boolean).join(SEP) }];
    }
    case 'Workflow': {
      const step = row && row.meta && row.meta.step;
      if (step && Number.isFinite(step.index) && Number.isFinite(step.total)) {
        return [{ text: `phase ${Math.min(step.index + 1, step.total)} / ${step.total}` }];
      }
      return [{ text: status === 'running' ? 'running' : status === 'error' ? 'error' : dur }];
    }
    case 'Monitor': {
      if (row && Number.isFinite(row.meta && row.meta.events)) return [{ text: plural(row.meta.events, 'event') }];
      return [{ text: status === 'running' ? 'running' : status === 'error' ? 'error' : '' }];
    }
    case 'Question':
      return [{ text: status === 'running' ? 'waiting for an answer' : status === 'error' ? 'error' : 'answered' }];
    case 'Plan':
      return [{ text: status === 'running' ? 'pending' : status === 'done' ? 'approved' : 'rejected' }];
    case 'Todo':
      return status === 'error' ? [{ text: 'error' }] : [];
    default:
      if (status === 'running') return [{ text: 'running' }];
      if (status === 'error') return [{ text: 'error' }];
      return dur ? [{ text: dur }] : [];
  }
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb >= 10 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`;
  const mb = kb / 1024;
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

// What a body fetches on first expand, or null when the store holds it all.
function fieldOf(item, kind) {
  if (kind === 'Plan') return 'input';
  if (kind === 'Todo') return todosOf(item) ? null : 'input';
  if (kind === 'Edit' || kind === 'Write') return null;
  if (kind === 'Bash' && isBackground(item)) return null;
  if (item.status === 'running') return null;   // no result yet
  return 'result';
}

// Where the first fetch starts, and how much: a shell's TAIL, else the head.
function firstPage(item, kind) {
  if (kind === 'Bash') {
    const r = isObj(item.result) ? item.result : {};
    // A persisted output is paged in bytes of its file; the model's own text in
    // characters, and whole (it is at most the full-read cap).
    if (r.full === false && Number.isFinite(r.bytes) && r.bytes > PAGE) return { from: r.bytes - PAGE, max: PAGE };
    return { from: 0, max: FIELD_MAX };
  }
  return { from: 0, max: PAGE };
}

const isLive = (item, kind) => kind === 'Agent' || kind === 'Workflow' || kind === 'Monitor'
  || (kind === 'Bash' && isBackground(item));

// ── the body cache ───────────────────────────────────────────────────────────

// item id → { field, status: 'loading'|'ok'|'error', text, from, to, total, eof,
// more: 'loading'|'error'|null, card }. Kept across re-renders; an entry is
// dropped only once the cache passes CACHE_MAX, oldest first, and never while
// its card is in the DOM.
const cache = new Map();

function remember(id, entry) {
  cache.delete(id);
  cache.set(id, entry);
  if (cache.size <= CACHE_MAX) return;
  for (const [k, e] of cache) {
    if (cache.size <= CACHE_MAX) break;
    if (k === id || (e.card && e.card.isConnected)) continue;
    cache.delete(k);
  }
}

function itemUrl(id, field, from, max) {
  return `/api/mirror/items/${encodeURIComponent(id)}?field=${field}&from=${from}&max=${max}`;
}

async function getField(id, field, from, max) {
  const res = await fetch(itemUrl(id, field, from, max), { headers: { Accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || !isObj(body) || body.ok === false || typeof body.text !== 'string') {
    const e = new Error(`HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const n = (v, d) => (Number.isSafeInteger(v) && v >= 0 ? v : d);
  const to = n(body.to, from + body.text.length);
  return { text: body.text, from: n(body.from, from), to, total: n(body.total, null), eof: body.eof === true };
}

// The first fetch of an item's body: once, then from the cache. A failed one
// is fetched again only by its Retry (`force`).
function load(card, { force = false } = {}) {
  const st = states.get(card);
  if (!st || !canRead()) return;
  const { item, kind } = st;
  const field = fieldOf(item, kind);
  if (!field) return;
  const held = cache.get(item.id);
  if (held && held.field === field && (!force || held.status !== 'error')) {
    held.card = card;
    return;
  }
  const page = firstPage(item, kind);
  const entry = { field, status: 'loading', text: '', from: page.from, to: page.from, total: null, eof: false, more: null, card };
  remember(item.id, entry);
  getField(item.id, field, page.from, page.max).then((r) => {
    Object.assign(entry, { status: 'ok', text: r.text, from: r.from, to: r.to, total: r.total, eof: r.eof });
  }, (e) => {
    entry.status = 'error';
    entry.error = e && e.status ? `HTTP ${e.status}` : 'network';
  }).then(() => paintBody(entry.card));
}

// Read's 'Show more': the next page, appended, up to BODY_CAP.
function more(card) {
  const st = states.get(card);
  if (!st) return;
  const entry = cache.get(st.item.id);
  if (!entry || entry.status !== 'ok' || entry.eof || entry.more === 'loading') return;
  if (entry.text.length >= BODY_CAP) return;
  entry.more = 'loading';
  paintBody(card);
  const max = Math.min(PAGE, BODY_CAP - entry.text.length);
  getField(st.item.id, entry.field, entry.to, max).then((r) => {
    entry.text += r.text;
    entry.to = r.to;
    entry.total = r.total;
    entry.eof = r.eof || !r.text;
    entry.more = null;
  }, () => {
    entry.more = 'error';
  }).then(() => paintBody(entry.card));
}

// ── the card ─────────────────────────────────────────────────────────────────

const states = new WeakMap();   // card → { item, kind, built }
const live = new Set();         // cards whose header follows a task row
let ticker = null;

function paintHead(card) {
  const st = states.get(card);
  const { item, kind } = st;
  const head = card.firstElementChild;
  const status = item.status || 'running';
  const parts = [el('span', 'tc-label', label(item, kind))];
  if (kind === 'Workflow') {
    const row = taskFor(item);
    const steps = row && Array.isArray(row.steps) ? row.steps : [];
    if (steps.length) {
      const bar = el('span', 'tc-phases');
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', steps.map((s) => `${s.label || 'phase'}: ${s.state}`).join(', '));
      for (const s of steps) {
        const seg = el('span', 'tc-phase');
        seg.dataset.state = s.state || 'pending';
        seg.title = s.label || '';
        bar.append(seg);
      }
      parts.push(bar);
    }
  }
  const tail = el('span', 'tc-status');
  const glyph = el('span', 'tc-glyph', GLYPH[status] || '•');
  glyph.setAttribute('aria-label', status);
  tail.append(glyph);
  for (const m of meta(item, kind)) {
    if (!m.text) continue;
    tail.append(' ', el('span', `tc-meta${m.cls ? ` ${m.cls}` : ''}`, m.text));
  }
  parts.push(tail);
  head.replaceChildren(...parts);
  card.dataset.status = status;
}

function pre(cls, text) {
  return el('pre', `tc-pre ${cls}`, text);
}

function note(text) {
  return el('div', 'tc-note', text);
}

function md(text) {
  const box = el('div', 'tc-md');
  box.innerHTML = renderMarkdown(String(text || ''), { flavor: 'chat' });   // the engine escapes everything
  return box;
}

function inputPreview(item) {
  const i = inputOf(item);
  if (!Object.keys(i).length) return null;
  let text;
  try { text = JSON.stringify(i, null, 2); } catch { return null; }
  return pre('tc-input', text);
}

function openButton(item, kind) {
  const t = openTarget(item, kind);
  if (!t || !t.id) return null;
  const b = button('tc-open', t.label);
  b.addEventListener('click', () => { bus.emit('chat:open', { view: 'task', id: t.id }); });
  return b;
}

// The result as the body shows it: what was fetched, else the store's preview
// (while the fetch runs, or after it failed), with a line saying which.
function resultNodes(card, entry, { cls = 'tc-out', render, pager = false } = {}) {
  const { item } = states.get(card);
  const out = [];
  const fetched = entry && entry.status === 'ok';
  const text = fetched ? entry.text : preview(item);
  if (text) out.push(render ? render(text) : pre(cls, text));
  if (fetched && !entry.eof) out.push(pager ? pagerNode(card, entry) : note('The rest is in the terminal.'));
  return out;
}

// Read's pager: 'Show more' while the body is under BODY_CAP.
function pagerNode(card, entry) {
  if (entry.more === 'error') return errorLine(card, () => { entry.more = null; more(card); });
  if (entry.text.length >= BODY_CAP) return note('The rest is in the terminal.');
  const b = button('tc-more', entry.more === 'loading' ? 'Loading…' : 'Show more');
  b.disabled = entry.more === 'loading';
  b.addEventListener('click', () => more(card));
  return b;
}

function errorLine(card, retry) {
  const row = el('div', 'tc-error');
  row.setAttribute('role', 'status');
  row.append(el('span', 'tc-error-text', "Couldn't load this call's output."));
  const b = button('tc-retry', 'Retry');
  b.addEventListener('click', retry);
  row.append(b);
  return row;
}

function todosOf(item) {
  const t = inputOf(item).todos;
  return Array.isArray(t) ? t : null;
}

function todoList(todos) {
  const ul = el('ul', 'tc-todo');
  const MARK = { completed: '☑', in_progress: '◐', pending: '☐' };
  for (const t of todos) {
    if (!isObj(t)) continue;
    const li = el('li', 'tc-todo-item');
    li.dataset.state = MARK[t.status] ? t.status : 'pending';
    const g = el('span', 'tc-todo-glyph', MARK[t.status] || MARK.pending);
    g.setAttribute('aria-label', String(t.status || 'pending').replace('_', ' '));
    li.append(g, el('span', 'tc-todo-text', str(t.content) || str(t.activeForm)));
    ul.append(li);
  }
  return ul;
}

function questionNodes(item) {
  const qs = Array.isArray(inputOf(item).questions) ? inputOf(item).questions : [];
  const out = [];
  for (const q of qs) {
    if (!isObj(q)) continue;
    const box = el('div', 'tc-q');
    if (str(q.header)) box.append(el('div', 'tc-q-head', q.header));
    box.append(el('div', 'tc-q-text', str(q.question)));
    const opts = Array.isArray(q.options) ? q.options.filter(isObj) : [];
    if (opts.length) {
      const ul = el('ul', 'tc-q-opts');
      for (const o of opts) ul.append(el('li', null, str(o.label)));
      box.append(ul);
    }
    out.push(box);
  }
  return out;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// The body's nodes for the card's kind, from the store and the cache.
function bodyNodes(card) {
  const { item, kind } = states.get(card);
  const entry = cache.get(item.id) || null;
  const out = [];
  const add = (n) => { if (n) out.push(n); };
  switch (kind) {
    case 'Read':
      out.push(...resultNodes(card, entry, { pager: true }));
      break;
    case 'Edit':
    case 'Write': {
      const patch = item.edit && typeof item.edit.patch === 'string' ? item.edit.patch : '';
      if (patch) {
        const box = el('pre', 'md-diff tc-diff');
        box.innerHTML = renderDiff(patch);   // the engine escapes every line
        out.push(box);
        if (item.truncated) add(note('The diff was cut here; the whole change is in the terminal.'));
      } else if (preview(item)) {
        out.push(pre('tc-out', preview(item)));
      } else {
        add(note(item.status === 'running' ? 'Running.' : 'No change was recorded.'));
      }
      break;
    }
    case 'Bash': {
      const i = inputOf(item);
      add(pre('tc-cmd', `$ ${str(i.command) || str(item.call)}`));
      if (isBackground(item)) {
        if (preview(item)) add(pre('tc-out', preview(item)));
        add(openButton(item, kind));
        break;
      }
      const fetched = entry && entry.status === 'ok';
      const text = fetched ? entry.text : preview(item);
      const all = lines(text);
      const cut = all.length > TAIL_LINES || (fetched && entry.from > 0);
      if (all.length) add(pre('tc-out', all.slice(-TAIL_LINES).join('\n')));
      if (cut) add(note(fetched && entry.from > 0 ? `The output's last lines; the rest is in the terminal.`
        : `The last ${TAIL_LINES} lines of ${all.length}.`));
      if (fetched && !entry.eof && entry.from === 0) add(note('The rest is in the terminal.'));
      break;
    }
    case 'Agent': {
      const i = inputOf(item);
      const prompt = str(i.prompt) || str(i.description);
      if (prompt) add(el('div', 'tc-prompt', prompt));
      out.push(...resultNodes(card, entry, { render: md }));
      add(openButton(item, kind));
      break;
    }
    case 'Workflow':
    case 'Monitor':
      add(inputPreview(item));
      out.push(...resultNodes(card, entry));
      add(openButton(item, kind));
      break;
    case 'Todo': {
      let todos = todosOf(item);
      if (!todos && entry && entry.status === 'ok') {
        const parsed = parseJson(entry.text);
        todos = isObj(parsed) && Array.isArray(parsed.todos) ? parsed.todos : null;
      }
      if (todos) add(todoList(todos));
      else if (!entry || entry.status === 'ok') add(note('No list was recorded.'));
      break;
    }
    case 'Question':
      out.push(...questionNodes(item));
      if (entry && entry.status === 'ok' ? entry.text : preview(item)) {
        add(el('div', 'tc-q-head', 'Answer'));
        out.push(...resultNodes(card, entry));
      }
      break;
    case 'Plan': {
      if (entry && entry.status === 'ok') {
        const parsed = parseJson(entry.text);
        const plan = isObj(parsed) && typeof parsed.plan === 'string' ? parsed.plan : '';
        add(plan ? md(plan) : note('The plan is in the terminal.'));
      } else if (!entry) {
        add(note('The plan is in the terminal.'));
      }
      break;
    }
    case 'webchat': {
      add(inputPreview(item));
      const id = mountIdOf(item);
      if (id) {
        const b = button('tc-reveal', 'Show on page');
        b.title = `Show ${id} on the page`;
        b.addEventListener('click', () => {
          let ok = false;
          try { ok = revealPane(id) === true; } catch (e) { console.error('[web-chat] Show on page failed', e); }
          b.textContent = ok ? 'Show on page' : 'Not on the page now';
        });
        add(b);
      }
      out.push(...resultNodes(card, entry));
      break;
    }
    default:   // Grep, Glob, Web, Search, Skill, Stop, MCP, an unknown tool, Tool
      add(inputPreview(item));
      out.push(...resultNodes(card, entry));
  }
  if (entry && entry.status === 'loading') add(note('Loading…'));
  if (entry && entry.status === 'error') add(errorLine(card, () => { load(card, { force: true }); paintBody(card); }));
  if (!out.length) add(note('Nothing to show.'));
  return out;
}

function paintBody(card) {
  if (!card) return;
  const st = states.get(card);
  if (!st || !st.built) return;
  const body = card.lastElementChild;
  try {
    body.replaceChildren(...bodyNodes(card));
  } catch (e) {
    console.error('[web-chat] a tool card body failed to render', e);
    body.replaceChildren(note('This call could not be shown.'));
  }
}

function expand(card) {
  const st = states.get(card);
  if (!st || !canRead()) return;
  if (!st.built) st.built = true;
  load(card);
  paintBody(card);
}

function freshCard(readable) {
  const card = el(readable ? 'details' : 'div', readable ? 'tc' : 'tc tc-flat');
  const head = el(readable ? 'summary' : 'div', 'tc-head');
  card.append(head);
  if (readable) {
    card.append(el('div', 'tc-body'));
    card.addEventListener('toggle', () => { if (card.open) expand(card); });
  }
  return card;
}

// One card. `prev` (the stream's old card for this item) is reused, so its open
// state and its body survive the item's changes.
export function renderToolCard(item, { prev = null } = {}) {
  const readable = canRead();
  const kind = kindOf(item);
  let card = prev && states.has(prev) && (prev.tagName === 'DETAILS') === readable ? prev : null;
  if (!card) card = freshCard(readable);
  const st = states.get(card) || { built: false };
  st.item = item;
  st.kind = kind;
  states.set(card, st);
  card.dataset.kind = kind;
  paintHead(card);
  const held = cache.get(item.id);
  if (held) held.card = card;
  if (readable && (card.open || st.built)) {
    if (card.open) load(card);
    paintBody(card);
  }
  if (isLive(item, kind)) live.add(card);
  else live.delete(card);
  tick();
  return card;
}

// ── live headers ─────────────────────────────────────────────────────────────

function running(card) {
  const { item } = states.get(card);
  const row = taskFor(item);
  return row ? row.status === 'running' : item.status === 'running';
}

function refreshLive() {
  for (const card of [...live]) {
    if (!card.isConnected) { live.delete(card); continue; }
    try { paintHead(card); } catch (e) { console.error('[web-chat] a tool card header failed', e); }
  }
}

// One ticker while a live card runs; none otherwise.
function tick() {
  let any = false;
  for (const card of live) if (card.isConnected && running(card)) { any = true; break; }
  if (any && ticker === null && typeof globalThis.setInterval === 'function') {
    ticker = globalThis.setInterval(() => { refreshLive(); tick(); }, TICK_MS);
  } else if (!any && ticker !== null) {
    globalThis.clearInterval(ticker);
    ticker = null;
  }
}

// ── seams ────────────────────────────────────────────────────────────────────

let restore = null;
let offMirror = null;

export function initChatTools() {
  if (restore) return restore;
  const off = setToolRenderer((item, opts) => renderToolCard(item, opts || {}));
  offMirror = bus.on('mirror', () => { refreshLive(); tick(); });
  restore = () => {
    off();
    if (offMirror) offMirror();
    offMirror = null;
    restore = null;
  };
  return restore;
}

export function stopChatTools() {
  if (restore) restore();
  if (ticker !== null) {
    globalThis.clearInterval(ticker);
    ticker = null;
  }
}
