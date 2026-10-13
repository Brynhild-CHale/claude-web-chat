// Control on the mod, in the chrome (design spec §15.7 'Control on the mod',
// §6.9 'Ruled (Q7, Q-H)', §7.6, §15.6 'In place'; rulings Q-C, Q-E, B1 (a),
// B-confirm (4), F6, C-defaults (a)).
//
//   initModControls({ timers })   registers the stopper and the turn action;
//                                 idempotent. U94a calls it from main.js after
//                                 initTurnActions and initSessionControl.
//                                 (`timers` is accepted like the other inits'
//                                 test seam; nothing here sets a timer.)
//   stopModControls()             unregisters both, closes the dialog and
//                                 unmounts every frame, unlistens
//   modStopper                    the stopper itself ({mount, unmount}), for tests
//
// THE STOPPER (chat-actions.js registerStopper, U46b). Kill, Cancel and Remove
// on a task row whose conversation has a web-chat mod attached (its
// process.mod, with capabilities.mod) and a viewer who may act
// (session-control's mayAct — chat-state's level ladder, never a copy — plus,
// remotely, a known answer origin) mount ONE control frame in the row's
// confirm slot: {action: 'task-stop', params: {task_id}, layout: 'confirm'},
// at size 'sheet' at the touch density (the phone sheet's Tasks pages and a
// touch tray; answer.css gives 'sheet' its 44px buttons) and at no size —
// the compact default — otherwise. Its confirm stops the task through the
// mod at once (lib/server/control/mod.js); the row then confirms from the
// transcript as before. mount answers true only when that frame is mounted,
// and then OWNS the stop: nothing falls back. With no mod it answers false and
// the inline confirm and POST /api/queue/task-stop run exactly as before — the
// one pane-callable route, which never reaches the mod (§6.9, Q-C).
// unmount(slot) unmounts that slot's frame; it is synchronous and idempotent.
//
// THE TURN ACTION 'fork-in-place' ('Fork here and switch the terminal';
// experimental, Q-E). On a turn whose conversation has a mod attached, while
// capabilities.rewind_in_place (the daemon runs with WEB_CHAT_REWIND_IN_PLACE=1
// and a mod is attached), not superseded, carrying a session id, for a viewer
// who may act. Its run opens a body-appended `div.popover.ta-dialog` with NO id
// (U86's #turn-action ids stay U86's; its .ta-* classes are reused, no CSS of
// its own): a .ta-head (a .ta-title and a .ta-close), a .ta-body sentence, and
// a .ta-confirm holding ONE control frame {action: 'resume', params: {turn_id},
// layout: 'confirm'} — the confirm Q-E asks for. shell.js owns its dismissal (a
// .popover: Escape, an outside press, another panel, the window blurring); a
// MutationObserver on its class hears it go hidden, unmounts the frame and
// removes it. No Escape or outside-click listener of its own. The answer
// (switched, and whether the prompt was refilled) shows inside the frame only.
//
// chat-turns.js keys no redraw on capabilities, access or a conversation's
// process, so when what the action reads changes it is registered again (U86's
// rule: the footers redraw on a registration).
//
// NEVER: a fetch to an acting route (every action is a frame's: §15.5, C46);
// an import of this module by queue.js (chat-actions.js hands queue.js its row
// actions through setRowActions); a model or effort control.
import { bus } from './bus.js';
import { mirror } from './chat-state.js';
import { registerStopper } from './chat-actions.js';
import { registerTurnAction } from './chat-turns.js';
import { answerFrameOrigin, PORT_EVENT } from './asks.js';
import { mountControlFrame, mayAct } from './session-control.js';

export const ACTION_ID = 'fork-in-place';
export const ACTION_LABEL = 'Fork here and switch the terminal';
export const DIALOG_TITLE = 'Switch this terminal to the fork';
export const DIALOG_TEXT = 'Experimental. The current conversation is kept; the terminal switches to a fork made from before this turn.';

let inited = null;
let offs = [];
let unStopper = null;
let unAction = null;
let actionKey = null;
let couldAct = false;
let dlg = null;                 // { el, confirm, handle, observer, retry }
const handles = new Map();      // a stopper slot → its frame's handle

// ── who may act, and on what ────────────────────────────────────────────────

function viewerMayAct() {
  if (!mayAct()) return false;
  const a = mirror.access || {};
  return a.remote === true ? !!answerFrameOrigin() : true;
}
const caps = () => mirror.capabilities || {};

function hasMod(conversationId) {
  if (typeof conversationId !== 'string' || !conversationId) return false;
  const c = mirror.conversations.get(conversationId);
  return !!c && !!c.process && c.process.mod === true;
}

// The conversation a task row belongs to: the store's row, else the model's.
function conversationOfRow(row) {
  const t = row && typeof row.id === 'string' ? mirror.tasks.get(row.id) : null;
  if (t && typeof t.conversation_id === 'string') return t.conversation_id;
  return row && typeof row.conversation_id === 'string' ? row.conversation_id : null;
}

// ── the stopper ─────────────────────────────────────────────────────────────

function stopperMount(slot, row, { density } = {}) {
  if (!slot || !row || typeof row.id !== 'string') return false;
  if (caps().mod !== true || !hasMod(conversationOfRow(row)) || !viewerMayAct()) return false;
  const spec = { action: 'task-stop', params: { task_id: row.id }, layout: 'confirm' };
  if (density === 'touch') spec.size = 'sheet';
  const h = mountControlFrame(slot, spec);
  if (!h) return false;
  handles.set(slot, h);
  return true;
}

function stopperUnmount(slot) {
  const h = handles.get(slot);
  if (!h) return;
  handles.delete(slot);
  try { h.unmount(); } catch { /* already gone */ }
}

export const modStopper = Object.freeze({ mount: stopperMount, unmount: stopperUnmount });

// ── the in-place resume's dialog ────────────────────────────────────────────

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

function teardown(d) {
  if (dlg === d) dlg = null;
  d.retry = null;
  if (d.handle) { d.handle.unmount(); d.handle = null; }
  d.observer.disconnect();
  d.el.remove();
}

function closeDialog() {
  if (!dlg) return;
  const d = dlg;
  d.el.classList.add('hidden');
  teardown(d);
}

function applies(turn) {
  return !!turn && caps().rewind_in_place === true && turn.superseded !== true
    && typeof turn.session_id === 'string' && turn.session_id !== ''
    && hasMod(turn.conversation_id) && viewerMayAct();
}

function openDialog(turn) {
  closeDialog();
  const box = el('div', 'popover ta-dialog');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', DIALOG_TITLE);
  box.tabIndex = -1;
  const head = el('div', 'ta-head');
  const close = el('button', 'ta-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  head.append(el('h4', 'ta-title', DIALOG_TITLE), close);
  const body = el('div', 'ta-body');
  body.append(el('p', 'ta-line', DIALOG_TEXT));
  const confirm = el('div', 'ta-confirm');
  box.append(head, body, confirm);
  document.body.append(box);
  const d = { el: box, confirm, handle: null, observer: null, retry: null };
  dlg = d;
  // shell.js hides it (Escape, an outside press, another panel): its frame goes.
  d.observer = new MutationObserver(() => { if (box.classList.contains('hidden')) teardown(d); });
  d.observer.observe(box, { attributes: true, attributeFilter: ['class'] });
  close.addEventListener('click', () => { box.classList.add('hidden'); });
  // One panel at a time: the dismiss layer closes every other.
  window.dispatchEvent(new CustomEvent('wc:close-popovers', { detail: { keep: box } }));
  try { box.focus({ preventScroll: true }); } catch { /* not focusable here */ }

  const spec = { action: 'resume', params: { turn_id: turn.id }, layout: 'confirm' };
  const tryMount = () => {
    if (dlg !== d) return true;
    const wait = [...confirm.childNodes];
    confirm.replaceChildren();        // emptied BEFORE the frame goes in
    const h = mountControlFrame(confirm, spec);
    if (!h) { confirm.replaceChildren(...wait); return false; }
    d.handle = h;
    d.retry = null;
    return true;
  };
  if (tryMount()) return;
  if (!viewerMayAct()) { confirm.replaceChildren(el('p', 'ta-reason', 'This page may not take that action.')); return; }
  // No answer origin yet: asks.js is refreshing the port; PORT_EVENT mounts it.
  confirm.replaceChildren(el('p', 'ta-wait', 'Getting the confirm ready…'));
  d.retry = tryMount;
}

// ── registration ────────────────────────────────────────────────────────────

function registerAction() {
  return registerTurnAction({
    id: ACTION_ID,
    label: ACTION_LABEL,
    applies,
    run: (turn) => { if (applies(turn)) openDialog(turn); },
  });
}

// What applies() reads, as one key: a change registers the action again.
function keyOf(may) {
  const withMod = [];
  for (const c of mirror.conversations.values()) if (c && c.process && c.process.mod === true) withMod.push(c.id);
  withMod.sort();
  return `${caps().rewind_in_place === true ? 1 : 0}|${may ? 1 : 0}|${withMod.join(',')}`;
}

function sync() {
  if (!inited) return;
  const may = viewerMayAct();
  const k = keyOf(may);
  if (k !== actionKey) {
    actionKey = k;
    if (unAction) { try { unAction(); } catch { /* gone */ } }
    unAction = registerAction();
  }
  const could = couldAct;
  couldAct = may;
  if (could && !may) closeDialog();
}

function onPort() {
  if (dlg && dlg.retry) dlg.retry();
  sync();
}

export function initModControls({ timers } = {}) {
  void timers;
  if (inited) return inited;
  inited = { stop: stopModControls };
  actionKey = null;
  couldAct = false;
  unStopper = registerStopper(modStopper);
  offs = [bus.on('mirror', sync), bus.on(PORT_EVENT, onPort)];
  sync();
  return inited;
}

export function stopModControls() {
  for (const off of offs.splice(0)) { try { off(); } catch { /* gone */ } }
  if (unStopper) { try { unStopper(); } catch { /* gone */ } unStopper = null; }
  if (unAction) { try { unAction(); } catch { /* gone */ } unAction = null; }
  for (const slot of [...handles.keys()]) stopperUnmount(slot);
  closeDialog();
  actionKey = null;
  couldAct = false;
  inited = null;
}
