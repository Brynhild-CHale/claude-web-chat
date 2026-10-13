// What a task or queue row's buttons DO (design spec §7.6, §6.9, §8.6): the one
// follower and the one confirm, shared by the trays (chat-trays.js), the detail
// views (U47) and the phone's Tasks pages (tranche 5). Nothing here keeps mirror
// state: a row's model is chat-present.js's RowModel, handed in by the caller.
//
//   followTaskOutput(id, {tail, from, max, intervalMs, alive}, onText) → stop
//   followAgentItems(id, {after, intervalMs, alive}, onItems)         → stop
//   confirmAction(button, {density, confirm, run, revertMs})          → revert
//   runAction(row, action, {rowEl, density, button})
//   registerStopper({mount, unmount}) → unregister
//   canRun(actionId, row)    whether runAction can perform it (chat-rows.js
//                            draws a button for nothing else): Output, Open,
//                            Kill, Cancel, Remove, Hold, Stage, and a queued
//                            message's Edit and Send now
//   stopFollowers(root?)     ends every follower whose row is inside root (all
//                            of them with no root)
//   queueRows()              Map item id → the queue tray's RowModel: what the
//                            rail's message rows offer (THE RAIL, below)
//
// THE FOLLOWER is a bounded setTimeout chain, never a setInterval: it ends by
// itself (spec §10.1). followTaskOutput reads GET /api/mirror/tasks/:id/output,
// first with `tail` (or `from`), then from the last answer's `to`, every
// FOLLOW_MS; it ends once the task has ended and the window reached eof, when
// alive() answers false, after FAIL_LIMIT failed reads in a row (onText({error:
// true})), or on stop(). It keeps no buffer: each answer's text goes to onText,
// `append` saying whether it continues the last one, and the caller trims to
// its own tail. followAgentItems reads GET /api/mirror/agents/:id?after=<seq>
// and hands on the items after `after`, advancing to the highest seq handed;
// it ends once the agent's row is no longer running and a read brought nothing
// new, or as above.
//
// THE CONFIRM. Kill, Cancel and Remove ask Claude to stop the task with TaskStop
// (Q7): POST /api/queue/task-stop {task_id}. At the compact density the confirm
// is inline in the row: RowModel's confirm.text with confirm.yes and confirm.no
// ("Kill npm run dev? Claude stops it with TaskStop." Kill / Keep); Keep or
// Escape reverts. At the touch density it is two taps (§8.6): the first turns the
// button into confirm.touch and disables its siblings, the second runs, and
// TOUCH_REVERT_MS or any other tap reverts. After the request the row reads
// "stopping…" until its stop_requested_at arrives (chat-present then words it),
// and a refusal's hint shows inline.
//
// THE STOPPER (ruling E1 a; the mod's immediate stop, §15.7, registers one in
// tranche 6). registerStopper({mount(slotEl, row, {density}) → boolean,
// unmount(slotEl)}) → unregister puts a stopper's own control into the row's
// stop, inside runAction, so the trays and the detail views' Cancel inherit it.
// One at a time: a second registration replaces the first, whose unregister()
// then does nothing; one missing either function is a TypeError, never stored.
// With a stopper, Kill, Cancel or Remove opens no inline confirm and posts
// nothing: it makes the CONFIRM SLOT, a div.cs-row-confirm (role group) where
// the inline confirm goes, the row's actions hidden (compact) or, with the
// class cs-row-confirm-touch, the row's other buttons disabled (touch), and
// calls mount(slot, row, {density}). A mount answering true OWNS the stop: its
// control frame (§15.5) lives in the slot and stops the task itself; nothing
// here posts or marks the row stopping. The slot reverts on Escape inside it,
// on another stop action of the row, when a redraw drops it or the row leaves
// (then the row is asked to redraw once more, to settle its actions):
// unmount(slot) once, the slot removed, the actions back. A mount
// answering anything but true, or throwing, gets no unmount; its slot goes and
// the inline confirm runs as above (a touch button that fallback armed takes
// its second tap there, unasked). With no stopper, the route is the only path.
//
// A QUEUED MESSAGE (tranche 4, §7.6) goes through queue.js, the one send path.
// Edit opens an inline editor in the row's .cs-row-body: a textarea holding the
// message's text (queueSnapshot(), read from GET /api/queue), Save and Cancel.
// Enter saves (Shift+Enter breaks the line); Escape or Cancel reverts with no
// request. Save is editMessage(id, {text}); a refusal's hint shows in
// .cs-row-note and the editor stays open. Send now is sendNow(id); what its
// answer says (a refusal, or that it waits behind a parked message) shows in
// .cs-row-note too.
//
// THE RAIL (§8.7, U70b). The queue rail's typed-message rows carry Edit and
// Send now too, on the desktop and in the phone's Tasks → Queue page: queue.js
// draws the buttons and this module does what they do, through the same
// canRun and runAction. queue.js cannot import this module (this one imports
// it), so at import this module hands it, through queue.js's setRowActions,
// {rows: queueRows, canRun, run: runAction}; queueRows() → Map item id → the
// queue tray's RowModel, from chat-present.js's categories(), so the rail
// offers exactly what the tray does. The rail's row is not chat-rows.js's
// element, but it carries the same documented parts below.
//
// THE ROW is chat-rows.js's element; this module touches it through its
// documented parts only: `.cs-row-actions` (the buttons), `.cs-row-body` (the
// expanded Output, built here), `.cs-row-note` (a refusal's hint) and the
// `data-stopping` flag, after which it asks the row to redraw itself with the
// 'wc:row-refresh' event (chat-rows.js answers it with its last model).
import { bus } from './bus.js';
import { mirror, serverNow } from './chat-state.js';
import { isRunning, categories } from './chat-present.js';
import {
  removeItem, setStaged, editMessage, sendNow, queueSnapshot, hydrateQueue, setRowActions,
} from './queue.js';

export const FOLLOW_MS = 1500;
export const FAIL_LIMIT = 3;
export const TOUCH_REVERT_MS = 3000;
export const OUTPUT_TAIL = 16384;     // the tray's tail: the GET's `tail`, and what the row keeps
export const STOP_ACTIONS = Object.freeze(['kill', 'cancel', 'remove']);

const ROW_REFRESH = 'wc:row-refresh';
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

// ── the follower ─────────────────────────────────────────────────────────────

// One bounded chain: `step()` reads once and answers whether to go on; the
// chain ends itself on a false, on alive() going false, or on stop().
function chain({ intervalMs, alive }, step) {
  let stopped = false;
  let timer = null;
  const ms = finite(intervalMs) && intervalMs >= 0 ? intervalMs : FOLLOW_MS;
  const stop = () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  async function run() {
    timer = null;
    if (stopped) return;
    if (typeof alive === 'function' && !alive()) { stop(); return; }
    let more = false;
    try { more = await step(() => stopped); } catch { more = false; }
    if (stopped) return;
    if (!more) { stop(); return; }
    timer = setTimeout(run, ms);
  }
  run();
  return stop;
}

async function readJson(url) {
  try {
    const res = await fetch(url);
    if (!res || !res.ok) return null;
    const body = await res.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

export function followTaskOutput(id, { tail, from, max, intervalMs = FOLLOW_MS, alive } = {}, onText) {
  const emit = typeof onText === 'function' ? onText : () => {};
  let next = null;      // the last answer's `to`
  let fails = 0;
  const url = () => {
    const q = new URLSearchParams();
    if (next !== null) q.set('from', String(next));
    else if (finite(tail)) q.set('tail', String(tail));
    else if (finite(from)) q.set('from', String(from));
    if (finite(max)) q.set('max', String(max));
    const qs = q.toString();
    return `/api/mirror/tasks/${encodeURIComponent(id)}/output${qs ? `?${qs}` : ''}`;
  };
  return chain({ intervalMs, alive }, async (stopped) => {
    const body = await readJson(url());
    if (stopped()) return false;
    if (!body) {
      fails += 1;
      if (fails < FAIL_LIMIT) return true;
      emit({ error: true });
      return false;
    }
    fails = 0;
    const append = next !== null && body.from === next;
    if (finite(body.to)) next = body.to;
    const out = {
      text: typeof body.text === 'string' ? body.text : '',
      from: finite(body.from) ? body.from : null,
      to: finite(body.to) ? body.to : null,
      size: finite(body.size) ? body.size : null,
      eof: body.eof === true,
      ended: body.ended === true,
      footer: typeof body.footer === 'string' ? body.footer : '',
      append,
    };
    if (finite(body.exit_code)) out.exit_code = body.exit_code;
    emit(out);
    return !(out.ended && out.eof);
  });
}

export function followAgentItems(id, { after, intervalMs = FOLLOW_MS, alive } = {}, onItems) {
  const emit = typeof onItems === 'function' ? onItems : () => {};
  let seq = finite(after) ? after : null;
  let fails = 0;
  return chain({ intervalMs, alive }, async (stopped) => {
    const q = seq === null ? '' : `?after=${encodeURIComponent(String(seq))}`;
    const body = await readJson(`/api/mirror/agents/${encodeURIComponent(id)}${q}`);
    if (stopped()) return false;
    if (!body) {
      fails += 1;
      if (fails < FAIL_LIMIT) return true;
      emit({ error: true });
      return false;
    }
    fails = 0;
    const items = (Array.isArray(body.items) ? body.items : [])
      .filter((it) => it && typeof it === 'object' && finite(it.seq) && (seq === null || it.seq > seq));
    for (const it of items) if (seq === null || it.seq > seq) seq = it.seq;
    const agent = body.agent && typeof body.agent === 'object' ? body.agent : null;
    emit({ agent, items });
    // The route's row first; the store's when the answer carries none.
    const row = agent || (mirror.tasks instanceof Map ? mirror.tasks.get(id) : null);
    return isRunning(row) || items.length > 0;
  });
}

// Every follower a row started, so a tray closing (or the trays stopping) ends
// them at once rather than at their next alive() check.
const following = new Map();   // row element → stop

export function stopFollowers(root) {
  for (const [el, stop] of [...following]) {
    if (root && !(root === el || (typeof root.contains === 'function' && root.contains(el)))) continue;
    following.delete(el);
    stop();
  }
}

// ── the confirm ──────────────────────────────────────────────────────────────

const armed = new WeakMap();   // a touch button waiting for its second tap → its revert

function rowOf(button) {
  return (button && typeof button.closest === 'function' && button.closest('[role="listitem"]')) || null;
}

// Where a row's confirm goes: under the row's main line when it has one
// (chat-rows.js), else after the buttons. The inline confirm and the stopper's
// slot both sit there.
function confirmPlace(button) {
  const row = rowOf(button);
  const actions = (button.closest && button.closest('.cs-row-actions')) || button.parentElement;
  const anchor = (row && row.querySelector('.cs-row-main')) || actions;
  return { actions, anchor };
}

function compactConfirm(button, confirm, run) {
  const { actions, anchor } = confirmPlace(button);
  if (!anchor || !anchor.parentNode) return () => {};
  const box = document.createElement('div');
  box.className = 'cs-row-confirm';
  box.setAttribute('role', 'group');
  const text = document.createElement('span');
  text.className = 'cs-confirm-text';
  text.textContent = confirm.text || '';
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'cs-confirm-yes';
  yes.textContent = confirm.yes || button.textContent;
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'cs-confirm-no';
  no.textContent = confirm.no || 'Keep';
  box.append(text, yes, no);
  let done = false;
  const revert = ({ focus = true } = {}) => {
    if (done) return;
    done = true;
    box.remove();
    if (actions) actions.hidden = false;
    if (focus && button.isConnected) {
      try { button.focus({ preventScroll: true }); } catch { /* not focusable here */ }
    }
  };
  yes.addEventListener('click', (e) => {
    e.stopPropagation();
    revert({ focus: false });
    run();
  });
  no.addEventListener('click', (e) => {
    e.stopPropagation();
    revert();
  });
  // Escape steps back out of the confirm, not out of the tray: the shell's
  // Escape listens on the document, past this one.
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    revert();
  });
  if (actions) actions.hidden = true;
  anchor.after(box);
  try { no.focus({ preventScroll: true }); } catch { /* not focusable here */ }
  return revert;
}

function touchConfirm(button, confirm, run, revertMs) {
  const prior = armed.get(button);
  if (prior) {
    // The second tap: act.
    prior({ restore: true });
    run();
    return () => {};
  }
  const label = button.textContent;
  const group = (button.closest && button.closest('.cs-row-actions')) || button.parentElement;
  const siblings = group ? [...group.querySelectorAll('button')].filter((b) => b !== button && !b.disabled) : [];
  let timer = null;
  const onTap = (e) => {
    const t = e.target;
    if (t && (t === button || (typeof button.contains === 'function' && button.contains(t)))) return;
    revert();
  };
  function revert() {
    if (armed.get(button) !== revert) return;
    armed.delete(button);
    if (timer !== null) clearTimeout(timer);
    timer = null;
    document.removeEventListener('pointerdown', onTap, true);
    document.removeEventListener('click', onTap, true);
    button.textContent = label;
    delete button.dataset.confirming;
    for (const b of siblings) b.disabled = false;
  }
  armed.set(button, revert);
  button.textContent = confirm.touch || `Confirm ${label.toLowerCase()}`;
  button.dataset.confirming = 'true';
  for (const b of siblings) b.disabled = true;
  document.addEventListener('pointerdown', onTap, true);
  document.addEventListener('click', onTap, true);
  timer = setTimeout(revert, finite(revertMs) ? revertMs : TOUCH_REVERT_MS);
  return revert;
}

// The one confirm, for a destructive action: `confirm` is RowModel's
// {text, yes, no, touch}; `run` is what a yes does. Answers a revert function.
export function confirmAction(button, { density = 'compact', confirm, run, revertMs } = {}) {
  if (!button || typeof run !== 'function') return () => {};
  const copy = confirm && typeof confirm === 'object' ? confirm : {};
  if (density === 'touch') return touchConfirm(button, copy, run, revertMs);
  return compactConfirm(button, copy, run);
}

// ── the stopper ──────────────────────────────────────────────────────────────

let stopper = null;            // {s}: the one registered stopper, boxed so a replaced unregister misses
const slots = new WeakMap();   // a row element → its mounted slot's revert

// The row a slot belongs to: the caller's rowEl, else the element the slot sits in.
function slotKey(rowEl, button) {
  if (rowEl) return rowEl;
  const { anchor } = confirmPlace(button);
  return (anchor && anchor.parentNode) || null;
}

export function registerStopper(s) {
  if (!s || typeof s.mount !== 'function' || typeof s.unmount !== 'function') {
    throw new TypeError('registerStopper takes {mount(slotEl, row, {density}) → boolean, unmount(slotEl)}');
  }
  const entry = { s };
  stopper = entry;
  return () => { if (stopper === entry) stopper = null; };
}

// Offers the stop to the registered stopper. Answers true when its mount took
// the slot; false (slot gone, nothing changed) when it declined or threw.
function stopperSlot(entry, row, host, button, density) {
  const { actions, anchor } = confirmPlace(button);
  if (!anchor || !anchor.parentNode) return false;
  const key = slotKey(host, button);
  const touch = density === 'touch';
  const slot = document.createElement('div');
  slot.className = touch ? 'cs-row-confirm cs-row-confirm-touch' : 'cs-row-confirm';
  slot.setAttribute('role', 'group');
  const siblings = touch && actions
    ? [...actions.querySelectorAll('button')].filter((b) => b !== button && !b.disabled) : [];
  const give = () => {
    if (actions && !touch) actions.hidden = false;
    for (const b of siblings) b.disabled = false;
  };
  if (actions && !touch) actions.hidden = true;
  for (const b of siblings) b.disabled = true;
  anchor.after(slot);
  let owned = false;
  try {
    owned = entry.s.mount(slot, row, { density: touch ? 'touch' : 'compact' }) === true;
  } catch {
    owned = false;
  }
  if (!owned) {
    slot.remove();
    give();
    return false;
  }
  const root = slot.getRootNode();
  let done = false;
  let watch = null;
  function revert({ focus = true, dropped = false } = {}) {
    if (done) return;
    done = true;
    if (watch) watch.disconnect();
    if (slots.get(key) === revert) slots.delete(key);
    try { entry.s.unmount(slot); } catch { /* the stopper's own teardown */ }
    slot.remove();
    give();
    // Dropped by a redraw: let the row settle its own actions again.
    if (dropped && key.isConnected) refresh(key);
    if (focus && button.isConnected) {
      try { button.focus({ preventScroll: true }); } catch { /* not focusable here */ }
    }
  }
  // A redraw that drops the slot, or the row leaving, reverts it: the slot is
  // no longer where it was mounted.
  const MO = typeof window !== 'undefined' ? window.MutationObserver : null;
  if (typeof MO === 'function') {
    watch = new MO(() => { if (slot.getRootNode() !== root) revert({ focus: false, dropped: true }); });
    watch.observe(root, { childList: true, subtree: true });
  }
  slot.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    revert();
  });
  slots.set(key, revert);
  return true;
}

// ── the actions ──────────────────────────────────────────────────────────────

const isTaskRow = (row) => !!row && row.cat !== 'queue';
const isMessageRow = (row) => !!row && row.cat === 'queue' && row.kind === 'message';

// Whether runAction can perform this action id on this row.
export function canRun(actionId, row) {
  switch (actionId) {
    case 'output': return isTaskRow(row);
    case 'open': return isTaskRow(row);
    case 'kill': case 'cancel': return isTaskRow(row);
    case 'remove': return !!row;
    case 'hold': case 'stage': return !!row && row.cat === 'queue';
    case 'edit': case 'send-now': return isMessageRow(row);
    default: return false;
  }
}

// A stop action of a task row: Kill, Cancel or Remove, which ask for TaskStop.
export const isStopAction = (row, action) => isTaskRow(row) && !!action && STOP_ACTIONS.includes(action.id);

const refresh = (rowEl) => {
  if (rowEl && typeof rowEl.dispatchEvent === 'function') rowEl.dispatchEvent(new CustomEvent(ROW_REFRESH));
};

function note(rowEl, text) {
  const el = rowEl && rowEl.querySelector('.cs-row-note');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

async function requestStop(row, rowEl) {
  note(rowEl, '');
  if (rowEl) rowEl.dataset.stopping = 'true';
  refresh(rowEl);
  let res = null;
  let body = null;
  try {
    res = await fetch('/api/queue/task-stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id: row.id }),
    });
    try { body = await res.json(); } catch { body = null; }
  } catch { res = null; }
  if (res && res.ok && !(body && body.ok === false)) return true;
  if (rowEl) delete rowEl.dataset.stopping;
  refresh(rowEl);
  const hint = body && (typeof body.hint === 'string' ? body.hint : typeof body.error === 'string' ? body.error : '');
  note(rowEl, hint || 'The stop request did not reach the daemon — stop it in the terminal.');
  return false;
}

// A queue row's note: a refusal in the row's rust ink, or (tone 'info') what
// an answer says, quieter. The stop path keeps note() above.
function queueNote(rowEl, text, tone = 'error') {
  const el = rowEl && rowEl.querySelector('.cs-row-note');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
  if (tone === 'info') el.dataset.tone = 'info';
  else delete el.dataset.tone;
}

const WAITS_HINT = 'Waits: a message is already parked for your next prompt';
const refusalHint = (r) => (r && (r.hint || r.refused)) || 'The daemon refused it.';

// Edit: the inline editor in the row's body. Answers whether it opened.
function openEditor(row, rowEl, density) {
  const body = rowEl && rowEl.querySelector('.cs-row-body');
  if (!body) return false;
  const open = body.querySelector('.cs-edit-text');
  if (open && !body.hidden) {
    try { open.focus({ preventScroll: true }); } catch { /* not focusable here */ }
    return true;
  }
  const item = queueSnapshot().items.find((it) => it.id === row.id);
  if (!item || typeof item.text !== 'string') {
    queueNote(rowEl, 'The message text has not arrived yet — try again in a moment.', 'info');
    hydrateQueue();
    return false;
  }
  queueNote(rowEl, '');
  const box = document.createElement('div');
  box.className = 'cs-edit';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Edit the message');
  const area = document.createElement('textarea');
  area.className = 'cs-edit-text';
  area.rows = 3;
  area.value = item.text;
  area.setAttribute('aria-label', 'Message text');
  const bar = document.createElement('div');
  bar.className = 'cs-edit-bar';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'cs-edit-save';
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'cs-edit-cancel';
  cancel.textContent = 'Cancel';
  bar.append(save, cancel);
  box.append(area, bar);
  let busy = false;
  const close = () => {
    body.hidden = true;
    body.replaceChildren();
    const btn = rowEl.querySelector('.cs-row-actions [data-action="edit"]');
    if (btn && btn.isConnected) {
      try { btn.focus({ preventScroll: true }); } catch { /* not focusable here */ }
    }
  };
  const commit = async () => {
    if (busy) return;
    busy = true;
    save.disabled = true;
    const r = await editMessage(row.id, { text: area.value });
    busy = false;
    save.disabled = false;
    if (r && r.ok === true) { queueNote(rowEl, ''); close(); return; }
    queueNote(rowEl, refusalHint(r));
  };
  save.addEventListener('click', (e) => { e.stopPropagation(); commit(); });
  cancel.addEventListener('click', (e) => { e.stopPropagation(); queueNote(rowEl, ''); close(); });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Out of the editor, not out of the tray: the shell's Escape is past this.
      e.stopPropagation();
      e.preventDefault();
      queueNote(rowEl, '');
      close();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target === area) {
      e.preventDefault();
      commit();
    }
  });
  body.replaceChildren(box);
  body.hidden = false;
  try { area.focus({ preventScroll: true }); } catch { /* not focusable here */ }
  return true;
}

// Send now: release the message at once (§6.4); the answer's word in the note.
async function sendMessageNow(row, rowEl) {
  queueNote(rowEl, '');
  const r = await sendNow(row.id);
  if (!r || r.ok !== true) { queueNote(rowEl, refusalHint(r)); return; }
  if (r.waiting === 'parked_message') queueNote(rowEl, WAITS_HINT, 'info');
  else if (r.mode === 'parked') queueNote(rowEl, 'With your next message', 'info');
  else if (r.mode === 'wake' || r.mode === 'transported') queueNote(rowEl, 'Sent', 'info');
}

// The row's expanded Output: a bounded tail followed live, the footer under it,
// and "Open full output" for the detail view.
function toggleOutput(row, rowEl, button) {
  const body = rowEl && rowEl.querySelector('.cs-row-body');
  if (!body) return;
  if (!body.hidden) {
    const stop = following.get(rowEl);
    following.delete(rowEl);
    if (stop) stop();
    body.hidden = true;
    body.replaceChildren();
    if (button) button.setAttribute('aria-expanded', 'false');
    return;
  }
  const tail = document.createElement('pre');
  tail.className = 'cs-row-tail';
  const footer = document.createElement('div');
  footer.className = 'cs-row-footer';
  footer.hidden = true;
  const full = document.createElement('button');
  full.type = 'button';
  full.className = 'cs-row-full';
  full.textContent = 'Open full output';
  full.addEventListener('click', (e) => {
    e.stopPropagation();
    bus.emit('chat:open', { view: 'task', id: row.id });
  });
  body.replaceChildren(tail, footer, full);
  body.hidden = false;
  if (button) button.setAttribute('aria-expanded', 'true');
  let text = '';
  const alive = () => rowEl.isConnected && !body.hidden && !rowEl.closest('.hidden');
  const stop = followTaskOutput(row.id, { tail: OUTPUT_TAIL, alive }, (o) => {
    if (o.error) {
      footer.textContent = 'output unavailable — the daemon did not answer';
      footer.hidden = false;
      return;
    }
    text = o.append ? text + o.text : o.text;
    if (text.length > OUTPUT_TAIL) text = text.slice(text.length - OUTPUT_TAIL);
    if (tail.textContent !== text) tail.textContent = text;
    footer.textContent = o.footer;
    footer.hidden = !o.footer;
  });
  following.set(rowEl, () => { stop(); });
}

// `action` is one of the row's RowModel actions, or its id.
export function runAction(row, action, { rowEl = null, density = 'compact', button = null } = {}) {
  if (!row) return false;
  const id = typeof action === 'string' ? action : action && action.id;
  const a = (Array.isArray(row.actions) ? row.actions : []).find((x) => x && x.id === id);
  if (!a || !canRun(id, row)) return false;
  const btn = button || (rowEl ? rowEl.querySelector(`.cs-row-actions [data-action="${id}"]`) : null);
  if (id === 'output') {
    toggleOutput(row, rowEl, btn);
    return true;
  }
  if (id === 'open') {
    bus.emit('chat:open', { view: 'task', id: row.id });
    return true;
  }
  if (isStopAction(row, a)) {
    if (!btn) return false;
    // A stop action on a row whose stopper slot is open steps back out of it.
    const open = slots.get(slotKey(rowEl, btn));
    if (open) { open(); return true; }
    // A touch button armed by a declined stopper's fallback takes its second tap.
    if (stopper && !armed.has(btn) && stopperSlot(stopper, row, rowEl, btn, density)) return true;
    confirmAction(btn, { density, confirm: a.confirm, run: () => { requestStop(row, rowEl); } });
    return true;
  }
  // The queue: Remove takes the item out (no revert: the rail's ⟲ keeps that);
  // Hold and Stage go through the rail's own setStaged; a message's Edit and
  // Send now through queue.js's editMessage and sendNow.
  if (id === 'edit') return openEditor(row, rowEl, density);
  if (id === 'send-now') { sendMessageNow(row, rowEl); return true; }
  if (id === 'remove') { removeItem(row.id); return true; }
  if (id === 'hold') { setStaged(row.id, false); return true; }
  if (id === 'stage') { setStaged(row.id, true); return true; }
  return false;
}

// ── the rail ─────────────────────────────────────────────────────────────────

// The queue tray's rows, by item id: what the rail's message rows offer.
export function queueRows() {
  const entry = categories(mirror, queueSnapshot(), { now: serverNow() }).find((c) => c.cat === 'queue');
  return new Map(entry ? entry.rows.map((r) => [r.id, r]) : []);
}

setRowActions({ rows: queueRows, canRun, run: runAction });
