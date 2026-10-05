// One turn of the chat stream, as an element (design spec §7.10, §2.4, §2.8, §15.4).
//
//   renderTurn(entry, turn, ctx)   (re)builds entry.el for one Turn of chat-state's
//                                  mirror.stream (the frozen header plus its items)
//   registerTurnAction({id, label, applies(turn), run(turn, el)}) → unregister
//                                  a later unit's footer button (tranche 4: Restore
//                                  files, Fork from here) without editing this file
//   turnActionsVersion()           bumps on every (un)registration: the stream's key
//   ATTACHMENT_SHOW_MAX            the attachment route's limit (ruling U28b@attachment-limit)
//
// A turn reads, top to bottom:
//
//   [↶ Rewound in the terminal at 14:02 · Set surface back to n1.12]   §15.4, only
//                                  in the first superseded turn (its rw_<id> notice)
//   [prompt bubble, right-aligned]  or the system row its author says
//   [intro prose]                   the first reply, when it precedes every tool call
//   [▸ N tool calls · Read, Edit, Bash · 42s]   ONE <details>: every tool card and
//                                  every intermediate narration, in order; never
//                                  opened here (a running turn included)
//   [final prose]                   the last reply after the last tool call
//   [footer]                        node chip · time · duration · N tools · files ±
//
// KEYED. The stream keeps one entry per turn and calls renderTurn again only when
// the Turn object (chat-state rebuilds it only when that turn changed) or the
// turn's context key changed. Each item's element is cached on the entry by the
// item OBJECT (chat-state freezes items and keeps an unchanged one's identity), so
// a re-render moves the very same elements back in: an open group, an expanded
// thought, a card's expanded body and whatever it fetched all survive. A changed
// tool call's card is rebuilt by the renderer, which is handed the old element
// (`prev`) to carry its state over.
//
// TEXT. A prompt is textContent (pre-wrap). Assistant text goes through
// renderMarkdown(text, {flavor: 'chat'}), whose output is its own div.md-chat,
// into a plain element — never inside a page `.md-block`, whose page.css rules
// would win a tie (U35). Nothing else here is HTML.
//
// NOTHING IS FETCHED here: the turn arrives from chat-state.js. An image
// attachment is an <img loading=lazy> the browser loads from the attachment
// route, and only while it is within the route's limit.
import { bus } from './bus.js';
import { atLeast } from './chat-state.js';
import { fmtShort } from './chat-present.js';
import { hasDetail } from './chat-panel.js';
import { labelFor, nodeTime } from './labels.js';
import { previewNode } from './topbar.js';
import { requestSetActive } from './graph-view.js';
import { renderMarkdown } from './markdown.js';

// The attachment route serves an attachment only up to this many bytes (6 MiB −
// 48 KiB), and one record holds all of a prompt's attachments, so an item whose
// attachments together pass it is over the limit too (ruling 2026-10-05). U40
// pins this equal to the server's.
export const ATTACHMENT_SHOW_MAX = 6242304;

const MAX_NAMES = 4;
const SEP = ' · ';

// ── turn actions ─────────────────────────────────────────────────────────────

const actions = [];          // [{id, label, applies, run}], registration order
let actionsRev = 0;
const watchers = new Set();  // the stream, redrawing the footers on a change

function actionsChanged() {
  actionsRev++;
  for (const fn of [...watchers]) {
    try { fn(actionsRev); } catch (e) { console.error('[web-chat] a turn-actions watcher failed', e); }
  }
}

// The stream's hook: called after every (un)registration. → off
export function onTurnActionsChanged(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

export function registerTurnAction({ id, label, applies, run } = {}) {
  if (typeof id !== 'string' || !id) throw new TypeError('registerTurnAction: id must be a non-empty string');
  if (typeof run !== 'function') throw new TypeError('registerTurnAction: run must be a function');
  const entry = { id, label: String(label || id), applies: typeof applies === 'function' ? applies : () => true, run };
  actions.push(entry);
  actionsChanged();
  return () => {
    const i = actions.indexOf(entry);
    if (i < 0) return;
    actions.splice(i, 1);
    actionsChanged();
  };
}

export function turnActionsVersion() {
  return actionsRev;
}

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
function sep() {
  const s = el('span', 'ct-sep', '·');
  s.setAttribute('aria-hidden', 'true');
  return s;
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A clock time as the chrome shows one: labels.js nodeTime, the one formatter.
export function clockTime(ms) {
  return Number.isFinite(ms) ? nodeTime({ created_at: ms }) : '';
}
const seconds = (ms) => `${Math.max(1, Math.round(ms / 1000))} s`;

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

const nodeLabel = (node) => (node && (node.label || labelFor(node.id))) || '';

// Prose: the chat flavour, its own div.md-chat inside a plain element, with each
// code block given a Copy (the click is the stream's, by delegation).
function prose(text, cls) {
  const box = el('div', cls);
  box.innerHTML = renderMarkdown(String(text || ''), { flavor: 'chat' });   // the engine escapes everything
  for (const pre of [...box.querySelectorAll('pre')]) {
    const wrap = el('div', 'ct-code');
    pre.replaceWith(wrap);
    const copy = button('ct-copy', 'Copy');
    copy.setAttribute('aria-label', 'Copy this code');
    wrap.append(pre, copy);
  }
  return box;
}

// ── the summary of the group ─────────────────────────────────────────────────

// The tools a turn called, by kind (tool_kind: `Read`, `Edit`, `MCP`, …; the
// tool's own name when the engine sent none), unique in first-use order, at
// most four then `…`.
export function toolNames(calls) {
  const names = [];
  let more = false;
  for (const it of calls) {
    const name = it.tool_kind || it.tool;
    if (!name || names.includes(name)) continue;
    if (names.length >= MAX_NAMES) { more = true; break; }
    names.push(name);
  }
  return more ? `${names.join(', ')}, …` : names.join(', ');
}

// The calls' wall time: first start to last end, else their durations summed.
function callsSpan(calls) {
  let from = Infinity;
  let to = -Infinity;
  let sum = 0;
  for (const it of calls) {
    if (Number.isFinite(it.started_at)) from = Math.min(from, it.started_at);
    const end = Number.isFinite(it.ended_at) ? it.ended_at
      : Number.isFinite(it.started_at) && Number.isFinite(it.duration_ms) ? it.started_at + it.duration_ms : NaN;
    if (Number.isFinite(end)) to = Math.max(to, end);
    if (Number.isFinite(it.duration_ms)) sum += it.duration_ms;
  }
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) return to - from;
  return sum > 0 ? sum : NaN;
}

export function groupSummary(turn, calls) {
  const running = turn.status === 'open' ? [...calls].reverse().find((c) => c.status === 'running') : null;
  const head = plural(calls.length, 'tool call');
  if (running) return { text: `${head} · running ${running.label || running.tool_kind || running.tool || 'a tool'}`, running: true };
  const parts = [head];
  const names = toolNames(calls);
  if (names) parts.push(names);
  const span = turn.status === 'open' ? NaN : callsSpan(calls);
  if (Number.isFinite(span) && span >= 1000) parts.push(fmtShort(span));
  return { text: parts.join(SEP), running: turn.status === 'open' };
}

// ── the default tool card ────────────────────────────────────────────────────

const GLYPH = { running: '◌', done: '✓', error: '✗', denied: '⊘', interrupted: '✕' };

// The generic card the stream draws until tool cards are registered (U38's
// setToolRenderer): status glyph, label, meta.
export function defaultToolCard(item) {
  const card = el('div', 'ct-tool');
  const status = item.status || 'running';
  card.dataset.status = status;
  const glyph = el('span', 'ct-tool-glyph', GLYPH[status] || '•');
  glyph.setAttribute('aria-label', status);
  const label = el('span', 'ct-tool-label', item.label || item.call || item.tool || 'Tool');
  card.append(glyph, label);
  let meta = '';
  if (status === 'running') meta = 'running';
  else if (Number.isFinite(item.duration_ms)) meta = fmtShort(item.duration_ms) || `${Math.round(item.duration_ms)}ms`;
  else if (status !== 'done') meta = status;
  if (meta) card.append(el('span', 'ct-tool-meta', meta));
  return card;
}

function toolCard(item, prev, ctx, turn) {
  let card = null;
  if (typeof ctx.toolRenderer === 'function') {
    try {
      card = ctx.toolRenderer(item, { turn, prev: prev || null });
    } catch (e) {
      console.error('[web-chat] a tool card failed to render', e);
      card = null;
    }
  }
  if (!card || typeof card.nodeType !== 'number') card = defaultToolCard(item);
  // Show plan (U36) finds a card by the item it draws.
  card.dataset.itemId = item.id;
  return card;
}

// ── attachments ──────────────────────────────────────────────────────────────

const attachmentUrl = (itemId, n) => `/api/mirror/items/${encodeURIComponent(itemId)}/attachments/${encodeURIComponent(n)}`;
const isPdf = (a) => a.kind === 'document' && (!a.media_type || /pdf/i.test(a.media_type));

// Over the route's limit: its own bytes, or the record's (every attachment of
// the item together).
export function overLimit(att, all) {
  if (Number.isFinite(att.bytes) && att.bytes > ATTACHMENT_SHOW_MAX) return true;
  let sum = 0;
  for (const a of all) if (Number.isFinite(a.bytes)) sum += a.bytes;
  return sum > ATTACHMENT_SHOW_MAX;
}

// The chip an attachment that is not shown becomes: its file location and its
// size, or, with no location recorded, its kind, size and why.
function bigChip(att) {
  const chip = el('span', 'ct-att ct-att-big');
  const size = fmtBytes(att.bytes);
  if (att.name) {
    chip.append(el('span', 'ct-att-name', att.name));
    if (size) chip.append(el('span', 'ct-att-size', size));
  } else {
    chip.append(el('span', 'ct-att-name', att.kind || 'attachment'));
    if (size) chip.append(el('span', 'ct-att-size', size));
    chip.append(el('span', 'ct-att-why', 'too large to show here'));
  }
  chip.title = att.name || att.kind || 'attachment';
  return chip;
}

function attachment(item, att, all) {
  const url = attachmentUrl(item.id, att.n);
  if ((att.kind === 'image' || isPdf(att)) && overLimit(att, all)) return bigChip(att);
  if (att.kind === 'image') {
    const a = el('a', 'ct-att-thumb');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = att.name || 'image';
    const img = el('img', 'ct-att-img');
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.alt = att.name || 'image';
    img.addEventListener('error', () => { if (a.isConnected || a.parentNode) a.replaceWith(bigChip(att)); }, { once: true });
    img.src = url;
    a.append(img);
    return a;
  }
  const chip = el('span', 'ct-att');
  chip.append(el('span', 'ct-att-name', att.name || att.kind || 'attachment'));
  const size = fmtBytes(att.bytes);
  if (size) chip.append(el('span', 'ct-att-size', size));
  if (isPdf(att)) {
    const open = el('a', 'ct-att-open', 'Open');
    open.href = url;
    open.target = '_blank';
    open.rel = 'noopener';
    chip.append(open);
  }
  // Files and pasted blocks are chips alone: no View in 0.8.5 (U37@stream-seams).
  return chip;
}

function attachments(item) {
  const all = Array.isArray(item.attachments) ? item.attachments : [];
  if (!all.length) return null;
  const row = el('div', 'ct-atts');
  for (const a of all) row.append(attachment(item, a, all));
  return row;
}

// ── rows ─────────────────────────────────────────────────────────────────────

function sysRow(text, cls = '') {
  return el('div', `ct-sys${cls ? ` ${cls}` : ''}`, text);
}

const STATUS_WORD = { done: 'finished', failed: 'failed', killed: 'killed', stopped: 'stopped', expired: 'expired',
  running: 'event', unknown: 'finished' };

// `⚙ npm test finished · exit 0`, from a task item: the notification quotes
// what it was about (`Background command "npm test" completed (exit code 0)`).
export function taskLine(task) {
  if (!task) return '⚙ background task finished';
  const s = String(task.summary || '');
  const quoted = /"([^"]{1,200})"/.exec(s);
  const what = quoted ? quoted[1] : (s.replace(/\s*\((?:exit|code)[^)]*\)\s*$/i, '').trim() || task.task_kind || 'background task');
  let line = `⚙ ${what} ${STATUS_WORD[task.status] || 'finished'}`;
  if (Number.isInteger(task.exit_code)) line += ` · exit ${task.exit_code}`;
  return line;
}

// How many signals a channel wake carried: the <channel> tag's count, else the
// envelope's own header line (lib/channel/envelope.js).
export function signalCount(text) {
  const s = String(text || '');
  let m = /\bcount="(\d+)"/.exec(s);
  if (m) return Number(m[1]);
  m = /(\d+) queued signals were pushed/.exec(s);
  if (m) return Number(m[1]);
  if (/A queued signal was pushed/.test(s)) return 1;
  return null;
}

function interruptedText(turn) {
  return turn.ended_by === 'web' || turn.ended_by === 'hook' ? '■ stopped from this page' : '✕ interrupted in the terminal';
}

function compactRow(it) {
  const row = sysRow(Number.isFinite(it.duration_ms)
    ? `— conversation compacted (${seconds(it.duration_ms)}) —`
    : '— conversation compacted —', 'ct-sys-rule');
  // Token names are U16's provisional ones (tokens, pre_tokens, post_tokens).
  const pre = Number.isFinite(it.pre_tokens) ? it.pre_tokens : it.tokens;
  if (Number.isFinite(pre) && Number.isFinite(it.post_tokens)) row.title = `${pre} → ${it.post_tokens} tokens`;
  else if (Number.isFinite(pre)) row.title = `${pre} tokens before`;
  return row;
}

// A notice's row, or null for the ones drawn elsewhere (the rewind).
function noticeRow(it, turn) {
  switch (it.notice) {
    case 'rewound': return null;
    case 'interrupted': return sysRow(interruptedText(turn), 'ct-sys-stop');
    case 'session': return sysRow('— session cleared —', 'ct-sys-rule');
    case 'model': return sysRow(`model → ${String(it.text || '').replace(/^Model:\s*/i, '') || 'changed'}`);
    case 'api-error': return sysRow('⚠ API error — see the terminal', 'ct-sys-error');
    default: return it.text ? sysRow(it.text, 'ct-sys-note') : null;
  }
}

function thoughtRow(it, ctx) {
  const label = Number.isFinite(it.duration_ms) ? `Thought for ${seconds(it.duration_ms)}` : 'Thought';
  if (!it.text || !atLeast(ctx.level, 'read')) return el('div', 'ct-think', label);
  const d = el('details', 'ct-think');
  d.append(el('summary', 'ct-think-sum', label), el('div', 'ct-think-text', it.text));
  return d;
}

function awayCallout(it) {
  const box = el('div', 'ct-away');
  box.append(el('div', 'ct-away-title', 'While you were away'), el('div', 'ct-away-text', it.text || ''));
  return box;
}

function localRow(it) {
  const box = el('div', 'ct-local');
  box.append(el('div', 'ct-local-cmd', `› ${it.local || it.input || 'local command'}`));
  if (it.output) box.append(el('pre', 'ct-local-out', it.output));
  return box;
}

function artifactRow(it) {
  const row = el('div', 'ct-sys ct-sys-note');
  row.append(document.createTextNode('◇ '));
  if (it.url && /^https?:\/\//i.test(it.url)) {
    const a = el('a', 'ct-artifact', it.title || it.url);
    a.href = it.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    row.append(a);
  } else {
    row.append(document.createTextNode(it.title || 'artifact'));
  }
  return row;
}

function queuedBubble(it) {
  const wrap = el('div', 'ct-prompt ct-queued');
  const b = el('div', 'ct-bubble', it.text || '');
  if (it.status) b.append(el('span', 'ct-tag', it.status));
  wrap.append(b);
  return wrap;
}

// ── the opener ───────────────────────────────────────────────────────────────

function promptBubble(turn, item, { tag = null } = {}) {
  const wrap = el('div', 'ct-prompt');
  wrap.dataset.author = turn.author || 'user';
  const bubble = el('div', 'ct-bubble', item && typeof item.text === 'string' ? item.text
    : (turn.prompt && turn.prompt.preview) || '');
  if (tag) bubble.append(el('span', 'ct-tag', tag));
  wrap.append(bubble);
  const atts = item ? attachments(item) : null;
  if (atts) wrap.append(atts);
  return wrap;
}

// What opens the turn: a bubble for the user's own words, a system row for the
// other authors.
function opener(turn, promptItem, taskItem) {
  const text = promptItem && typeof promptItem.text === 'string' ? promptItem.text : (turn.prompt && turn.prompt.preview) || '';
  switch (turn.author) {
    case 'web': return [promptBubble(turn, promptItem, { tag: promptItem && promptItem.device ? `web · ${promptItem.device}` : 'web' })];
    case 'channel': {
      const n = signalCount(text);
      return [sysRow(n === null ? '⇢ Push from the surface' : `⇢ Push from the surface · ${plural(n, 'signal')}`, 'ct-sys-push')];
    }
    case 'parked': return [sysRow('⇢ Delivered with your message', 'ct-sys-push'), promptBubble(turn, promptItem)];
    case 'task-notification': return [sysRow(taskLine(taskItem), 'ct-sys-task')];
    case 'system': return [];
    default: return [promptBubble(turn, promptItem)];
  }
}

// ── the footer ───────────────────────────────────────────────────────────────

function footer(turn, ctx, turnEl) {
  const foot = el('footer', 'ct-foot');
  const parts = [];
  if (turn.folded_into && turn.folded_into.id) {
    const f = el('span', 'ct-folded', 'no surface change · rode into ');
    const chip = button('ct-node', nodeLabel(turn.folded_into));
    chip.title = 'Preview this node';
    chip.addEventListener('click', () => { previewNode(turn.folded_into.id); });
    f.append(chip);
    parts.push(f);
  } else if (turn.node && turn.node.id) {
    const chip = button('ct-node', nodeLabel(turn.node));
    chip.title = 'Preview this node';
    chip.addEventListener('click', () => { previewNode(turn.node.id); });
    parts.push(chip);
  }
  const time = clockTime(turn.started_at);
  if (time) parts.push(el('span', 'ct-time', time));
  if (turn.status !== 'open' && Number.isFinite(turn.duration_ms)) parts.push(el('span', 'ct-dur', fmtShort(turn.duration_ms)));
  const tools = turn.counts && turn.counts.tools;
  if (tools) parts.push(el('span', 'ct-ntools', plural(tools, 'tool')));
  const code = turn.code;
  if (code && code.status === 'ready' && Number.isFinite(code.files)) {
    const files = el('span', 'ct-files', `${plural(code.files, 'file')} +${code.additions || 0} −${code.deletions || 0}`);
    parts.push(files);
    if (ctx.diffDetail) {
      const view = button('ct-view-changes', 'View changes');
      view.addEventListener('click', () => {
        const folded = !turn.node || turn.node.role === 'folded' || !!turn.folded_into;
        bus.emit('chat:open', folded ? { view: 'diff', id: turn.id } : { view: 'diff', node_id: turn.node.id });
      });
      parts.push(view);
    }
  }
  parts.forEach((p, i) => { if (i) foot.append(sep()); foot.append(p); });
  for (const a of actions) {
    let ok = false;
    try { ok = !!a.applies(turn); } catch (e) { console.error(`[web-chat] turn action '${a.id}' failed`, e); }
    if (!ok) continue;
    const b = button('ct-action', a.label);
    b.dataset.action = a.id;
    b.addEventListener('click', () => {
      try { a.run(turn, turnEl); } catch (e) { console.error(`[web-chat] turn action '${a.id}' failed`, e); }
    });
    foot.append(b);
  }
  return foot;
}

// ── the rewind ───────────────────────────────────────────────────────────────

function rewindNotice(it, ctx) {
  const box = el('div', 'ct-rewind');
  box.setAttribute('role', 'note');
  const at = clockTime(it.at);
  box.append(el('span', 'ct-rewind-text', it.reason === 'reset'
    ? `Conversation reset${at ? ` at ${at}` : ''}`
    : `↶ Rewound in the terminal${at ? ` at ${at}` : ''}`));
  const back = it.returned_to && ctx.turnById ? ctx.turnById(it.returned_to) : null;
  const node = back && back.node && back.node.id ? back.node : null;
  if (node) {
    // Never applied without this click: it is the graph screen's own set-active
    // (POST /api/graph/active, the preserve included).
    const b = button('ct-setback', `Set surface back to ${nodeLabel(node)}`);
    b.addEventListener('click', () => { requestSetActive(node.id); });
    box.append(b);
  }
  return box;
}

// The node id the rewind notice of this turn would offer to go back to (part of
// the turn's context key: it can arrive after the turn itself).
export function setBackNodeOf(turn, turnById) {
  const it = (turn.items || []).find((x) => x.kind === 'notice' && x.notice === 'rewound');
  if (!it || !it.returned_to || !turnById) return '';
  const back = turnById(it.returned_to);
  return back && back.node && back.node.id ? `${back.node.id}:${back.node.label || ''}` : '';
}

// ── the turn ─────────────────────────────────────────────────────────────────

// One element per (id, what it was built from, how): reused while all three
// hold, so its own state (an open thought, a card's body, an image that loaded
// or failed) survives a re-render of the turn.
function cached(entry, id, dep, key, make) {
  const hit = entry.cache.get(id);
  if (hit && hit.dep === dep && hit.key === key) {
    entry.next.set(id, hit);
    return hit.el;
  }
  const node = make(hit ? hit.el : null);
  entry.next.set(id, { dep, key, el: node });
  return node;
}

// (Re)build entry.el for `turn`. ctx: {level, viewedId, toolRenderer,
// turnById(id), diffDetail}. The entry keeps its element, its <details> group
// and its item elements across calls.
export function renderTurn(entry, turn, ctx) {
  if (!entry.el) {
    entry.el = el('article', 'ct-turn');
    entry.cache = new Map();
  }
  const root = entry.el;
  root.dataset.turnId = turn.id;
  root.dataset.status = turn.status || 'open';
  root.classList.toggle('ct-superseded', turn.superseded === true);
  root.classList.toggle('ct-viewed', !!(ctx.viewedId && turn.node && turn.node.id === ctx.viewedId));
  entry.next = new Map();

  const items = Array.isArray(turn.items) ? turn.items : [];
  const firstPrompt = items.find((x) => x.kind === 'prompt') || null;
  const firstTask = items.find((x) => x.kind === 'task') || null;
  const calls = items.filter((x) => x.kind === 'tool_call');
  const firstTool = items.findIndex((x) => x.kind === 'tool_call');
  let lastTool = -1;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'tool_call') { lastTool = i; break; }
  const firstReply = items.findIndex((x) => x.kind === 'reply');
  const introAt = firstTool >= 0 && firstReply >= 0 && firstReply < firstTool ? firstReply : -1;
  let finalAt = -1;
  if (firstTool >= 0) {
    for (let i = items.length - 1; i > lastTool; i--) if (items[i].kind === 'reply') { finalAt = i; break; }
  }

  const out = [];
  const rewound = items.find((x) => x.kind === 'notice' && x.notice === 'rewound');
  if (rewound) out.push(rewindNotice(rewound, ctx));
  // Item ids start with a letter or digit, so ':opener' is never one.
  const openKey = JSON.stringify([turn.author, turn.prompt && turn.prompt.preview]);
  const openDep = turn.author === 'task-notification' ? firstTask : firstPrompt;
  const opened = cached(entry, ':opener', openDep, openKey, () => {
    const box = el('div', 'ct-open');
    box.append(...opener(turn, firstPrompt, firstTask));
    return box;
  });
  if (opened.childNodes.length) out.push(opened);

  // The group: kept across renders (its `open` is the user's), refilled in order.
  let group = null;
  let body = null;
  if (calls.length) {
    if (!entry.group) {
      entry.group = el('details', 'ct-group');
      const sum = el('summary', 'ct-gsum');
      entry.group.append(sum, el('div', 'ct-gbody'));
    }
    group = entry.group;
    body = group.lastElementChild;
    const s = groupSummary(turn, calls);
    const sum = group.firstElementChild;
    const parts = [el('span', 'ct-caret', '▸ ')];
    if (s.running) {
      const dot = el('span', 'ct-gdot');
      dot.setAttribute('data-cs-state', 'working');
      dot.setAttribute('aria-hidden', 'true');
      parts.push(dot);
    }
    parts.push(el('span', 'ct-gtext', s.text));
    sum.replaceChildren(...parts);
  } else {
    entry.group = null;
  }
  const inner = [];
  let interruptedShown = false;

  items.forEach((it, i) => {
    if (it === firstPrompt && turn.author !== 'system') {
      return;   // drawn by the opener
    }
    if (it === firstTask && turn.author === 'task-notification') return;
    const inGroup = group && i >= firstTool && (i <= lastTool || (finalAt >= 0 ? i < finalAt : false))
      && (it.kind === 'tool_call' || it.kind === 'reply' || it.kind === 'thinking');
    if (group && i === firstTool) out.push(group);
    let node = null;
    switch (it.kind) {
      case 'tool_call':
        node = cached(entry, it.id, it, `tool:${ctx.rendererRev || 0}`, (prev) => toolCard(it, prev, ctx, turn));
        break;
      case 'reply': {
        const cls = i === introAt ? 'ct-prose ct-intro' : i === finalAt ? 'ct-prose ct-final'
          : inGroup ? 'ct-prose ct-narration' : 'ct-prose';
        node = cached(entry, it.id, it, cls, () => prose(it.text, cls));
        break;
      }
      case 'thinking':
        node = cached(entry, it.id, it, `think:${atLeast(ctx.level, 'read')}`, () => thoughtRow(it, ctx));
        break;
      case 'prompt':
        // A command turn's own prompt (author system), or a later prompt.
        node = turn.author === 'system'
          ? (it.text ? sysRow(`› ${it.text}`, 'ct-sys-cmd') : null)
          : cached(entry, it.id, it, 'prompt', () => promptBubble(turn, it));
        break;
      case 'notice':
        if (it.notice === 'interrupted') interruptedShown = true;
        node = noticeRow(it, turn);
        break;
      case 'compact': node = compactRow(it); break;
      case 'away': node = awayCallout(it); break;
      case 'task': node = sysRow(taskLine(it), 'ct-sys-task'); break;
      case 'queued': node = queuedBubble(it); break;
      case 'local': node = localRow(it); break;
      case 'artifact': node = artifactRow(it); break;
      default: node = null;
    }
    if (!node) return;
    if (inGroup) inner.push(node);
    else out.push(node);
  });
  if (body) body.replaceChildren(...inner);
  if (turn.status === 'interrupted' && !interruptedShown) out.push(sysRow(interruptedText(turn), 'ct-sys-stop'));
  out.push(footer(turn, ctx, root));
  root.replaceChildren(...out);
  entry.cache = entry.next;
  entry.next = null;
  entry.turn = turn;
  return root;
}
