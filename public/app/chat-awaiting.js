// The chat panel's awaiting card (design spec §7.9): what blocks the terminal
// right now, for the followed conversation — a permission, a question or a
// plan. SHOWING it is this module's; ANSWERING it is the answer frames' (§4.5).
//
//   renderAwaiting(card, { variant })   fills the panel's #chat-awaiting (built by
//                                       chat-panel.js) and says whether it shows
//   focusAwaiting(card)                 scrolls it into view and focuses it
//   pendingAsk(conversationId?)         the ask the card is about, or null
//   resetAwaiting(card)                 lets an answer frame go, empties the card
//   showPlan()                          the plan's tool card in the stream, scrolled to
//
// TWO CARDS, ONE PLACE. When an answer frame is registered (chat-slots
// registerApprovals), the ask says it is answerable and the level is `full` or
// `local`, `approvals().mountCard(body, ask)` — `mountSheet` on the phone's
// sheet variant, for its 44px controls — owns the WHOLE body, its own copy of
// the request included, and the chrome shows only the title, `AWAITING YOU ·
// PERMISSION`: a trusted click lands beside text a pane cannot rewrite. A frame
// that declines to mount (it answers false) is not asked again for that ask.
// Otherwise the read-only card: a permission's tool call in a code box (the
// redacted subject the daemon sent, `live.waiting.summary`), with the masked
// line when the ask says `masked` — the ask's FLAG, never the mask's text,
// which is lib/core/redact.js's alone; a question's text and, at `read` and
// above, its options from the matching AskUserQuestion tool call in the followed
// stream (the ask itself is pane-readable and carries no questions, notes-B Q7);
// a plan's line, its markdown when the stream's item carries it (it rarely does:
// the projection keeps the plan's path, ruling U36@ask-card-sources), and Show
// plan, which scrolls to the plan's tool card in the stream (notes-B Q6). Each
// says "Answer in the terminal".
//
// The card hides the moment the ask resolves — the terminal answering first is
// normal (V9) — and is rebuilt only when what it shows changes, so a ticker's
// redraw never churns it and an answer frame is never remounted under a click.
//
// It reads chat-state.js only, and fetches nothing: the store is the one copy.
import { bus } from './bus.js';
import { mirror, followed, awaitingOf, atLeast } from './chat-state.js';
import { approvals } from './chat-slots.js';
import { renderMarkdown } from './markdown.js';

const KIND_WORD = { permission: 'PERMISSION', question: 'QUESTION', plan: 'PLAN' };
// The card's ink: a question in the question ink, every other wait in NEEDS YOU's
// (app.css's [data-cs-state] inks, §7.4).
const KIND_INK = { question: 'question' };
const TOOL_OF = { question: 'AskUserQuestion', plan: 'ExitPlanMode' };
const KIND_OF_TOOL = { question: 'Question', plan: 'Plan' };

const MASKED_LINE = 'contains masked values — see the terminal for the full command';
const PLAN_LINE = 'Claude wrote a plan and is waiting for approval';
const PLAN_ELSEWHERE = 'the plan is in the terminal';
const ANSWER_LINE = 'Answer in the terminal';

// What the card holds: { key, mode: 'frame'|'read', impl, askId, body }.
let held = null;
let refused = null;          // the frame key an answer frame declined: never asked again

const text = (v) => (typeof v === 'string' ? v : '');

function el(tag, cls, content) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (content !== undefined) e.textContent = content;
  return e;
}

// The pending ask of a conversation (the followed one's by default).
export function pendingAsk(conversationId = followed()) {
  if (!conversationId) return null;
  return awaitingOf(conversationId).find((a) => a.state === 'pending') || null;
}

function waitOf(cid) {
  const c = mirror.conversations.get(cid);
  return (c && c.live && c.live.waiting) || null;
}

// The tool call the ask stands for, in the followed stream (level `read` and
// above, where the stream exists): by its tool_use id, or by the ask the item
// says it awaits; failing both, the newest call of the ask's tool that is still
// awaiting an answer.
function streamItem(ask, wait) {
  if (!atLeast(mirror.access.level, 'read')) return null;
  const st = mirror.stream;
  if (!st || st.conversationId !== ask.conversation_id || !Array.isArray(st.turns)) return null;
  const ids = new Set([ask.tool_use_id, wait && wait.tool_use_id].filter(Boolean));
  const tool = TOOL_OF[ask.kind];
  let fallback = null;
  for (const turn of st.turns) {
    for (const it of turn.items || []) {
      if (it.kind !== 'tool_call') continue;
      if (ids.has(it.id) || (it.awaiting && it.awaiting.ask_id === ask.id)) return it;
      const sameTool = tool && (it.tool === tool || it.tool_kind === KIND_OF_TOOL[ask.kind]);
      if (sameTool && it.awaiting && it.awaiting.status === 'pending') fallback = it;
    }
  }
  return fallback;
}

// AskUserQuestion's input: [{ question, header, options: [{ label, description }] }].
function questionsOf(item) {
  const qs = item && item.input && Array.isArray(item.input.questions) ? item.input.questions : [];
  return qs.filter((q) => q && typeof q === 'object').map((q) => ({
    question: text(q.question) || text(q.header),
    options: (Array.isArray(q.options) ? q.options : [])
      .map((o) => (typeof o === 'string' ? { label: o } : o && typeof o === 'object' ? { label: text(o.label), description: text(o.description) } : null))
      .filter((o) => o && o.label),
  }));
}

function planOf(item) {
  return item && item.input && typeof item.input.plan === 'string' ? item.input.plan : '';
}

function titleOf(kind) {
  return KIND_WORD[kind] ? `AWAITING YOU · ${KIND_WORD[kind]}` : 'AWAITING YOU';
}

// What the read-only card shows, as data (its key is what decides a rebuild).
function readModel(ask) {
  const cid = ask.conversation_id;
  const wait = waitOf(cid);
  const content = atLeast(mirror.access.level, 'read');
  const summary = text(ask.summary) || text(wait && wait.summary);
  const m = { kind: ask.kind, content };
  if (ask.kind === 'permission') {
    m.subject = summary || text(ask.tool_name) || text(wait && wait.tool);
    m.masked = ask.masked === true;
  } else if (ask.kind === 'question') {
    const item = streamItem(ask, wait);
    m.questions = content ? questionsOf(item) : [];
    m.text = summary || (m.questions[0] && m.questions[0].question) || '';
  } else if (ask.kind === 'plan') {
    const item = streamItem(ask, wait);
    m.plan = content ? planOf(item) : '';
    m.item = item ? item.id : null;
  } else {
    m.text = summary;
  }
  return m;
}

const frameKey = (ask, variant) => `frame|${ask.id}|${ask.version ?? ''}|${variant}`;

function letGo(card) {
  if (held && held.mode === 'frame' && held.impl) {
    try { held.impl.unmount(held.body); } catch (e) { console.error('[web-chat] the answer frame failed to unmount', e); }
  }
  held = null;
  card.replaceChildren();
}

export function resetAwaiting(card) {
  if (card) letGo(card);
  refused = null;
}

function shell(card, ask) {
  const title = el('div', 'cp-aw-title', titleOf(ask.kind));
  const body = el('div', 'cp-aw-body');
  card.replaceChildren(title, body);
  card.setAttribute('aria-label', title.textContent);
  card.setAttribute('data-cs-state', KIND_INK[ask.kind] || 'waiting');
  return body;
}

function mountFrame(card, ask, impl, variant, key) {
  letGo(card);
  const body = shell(card, ask);
  let ok = false;
  try {
    ok = variant === 'sheet' ? impl.mountSheet(body, ask) === true : impl.mountCard(body, ask) === true;
  } catch (e) {
    console.error('[web-chat] the answer frame failed to mount', e);
  }
  if (!ok) {
    try { impl.unmount(body); } catch { /* it never mounted */ }
    refused = key;
    return false;
  }
  held = { key, mode: 'frame', impl, askId: ask.id, body };
  return true;
}

function fillRead(body, m) {
  if (m.kind === 'permission') {
    if (m.subject) {
      const pre = el('pre', 'cp-aw-code');
      pre.append(el('code', null, m.subject));
      body.append(pre);
    }
    if (m.masked) body.append(el('p', 'cp-aw-masked', MASKED_LINE));
  } else if (m.kind === 'question') {
    if (m.text) body.append(el('p', 'cp-aw-text', m.text));
    const many = m.questions.length > 1;
    for (const q of m.questions) {
      if (many && q.question) body.append(el('p', 'cp-aw-qtext', q.question));
      if (!q.options.length) continue;
      const ul = el('ul', 'cp-aw-options');
      for (const o of q.options) {
        const li = el('li', null, o.label);
        if (o.description) li.append(' ', el('span', 'cp-aw-optdesc', `— ${o.description}`));
        ul.append(li);
      }
      body.append(ul);
    }
  } else if (m.kind === 'plan') {
    body.append(el('p', 'cp-aw-text', PLAN_LINE));
    if (m.plan) {
      const box = el('div', 'cp-aw-plan');
      box.innerHTML = renderMarkdown(m.plan, { flavor: 'chat' });   // the engine escapes everything
      body.append(box);
    } else {
      body.append(el('p', 'cp-aw-note', PLAN_ELSEWHERE));
    }
    if (m.content) {
      const show = el('button', 'cp-aw-showplan', 'Show plan');
      show.type = 'button';
      show.addEventListener('click', () => { showPlan(); });
      body.append(show);
    }
  } else if (m.text) {
    body.append(el('p', 'cp-aw-text', m.text));
  }
  body.append(el('p', 'cp-aw-hint', ANSWER_LINE));
}

// Show plan: the plan's tool card in the stream (the stream marks each card with
// data-item-id, U37/U38), its turn group opened, the card itself expanded
// (chat-tools.js expandCard, asked over the bus: `chat:expand-tool`), scrolled
// to and focused.
export function showPlan() {
  const ask = pendingAsk();
  if (!ask || ask.kind !== 'plan') return false;
  const item = streamItem(ask, waitOf(ask.conversation_id));
  const stream = document.getElementById('chat-stream');
  if (!item || !stream) return false;
  const target = [...stream.querySelectorAll('[data-item-id]')].find((n) => n.dataset.itemId === item.id);
  if (!target) return false;
  for (let p = target.parentElement; p && p !== stream; p = p.parentElement) {
    if (p.tagName === 'DETAILS') p.open = true;
  }
  bus.emit('chat:expand-tool', { id: item.id });
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  try { target.focus({ preventScroll: true }); } catch { /* not focusable here */ }
  return true;
}

// Fill the card for the followed conversation's pending ask; hide it when there
// is none. Returns whether it shows.
export function renderAwaiting(card, { variant = 'desktop' } = {}) {
  if (!card) return false;
  const ask = pendingAsk();
  if (!ask) {
    if (held || card.childNodes.length) letGo(card);
    refused = null;
    card.hidden = true;
    return false;
  }
  card.hidden = false;
  const impl = approvals();
  const answerable = !!impl && ask.answerable === true && ask.state === 'pending' && atLeast(mirror.access.level, 'full');
  if (answerable) {
    const key = frameKey(ask, variant);
    if (held && held.mode === 'frame' && held.key === key && held.impl === impl) return true;
    if (refused !== key && mountFrame(card, ask, impl, variant, key)) return true;
  }
  const m = readModel(ask);
  const key = `read|${ask.id}|${JSON.stringify(m)}`;
  if (held && held.mode === 'read' && held.key === key) return true;
  letGo(card);
  const body = shell(card, ask);
  fillRead(body, m);
  held = { key, mode: 'read', impl: null, askId: ask.id, body };
  return true;
}

// chat:open {view: 'awaiting'}: the card into view, and focus on it.
export function focusAwaiting(card) {
  if (!card || card.hidden || !card.isConnected) return false;
  if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' });
  try { card.focus({ preventScroll: true }); } catch { return false; }
  return document.activeElement === card;
}
