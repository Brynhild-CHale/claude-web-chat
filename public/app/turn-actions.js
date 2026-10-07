// Turn actions: Restore files and Fork from here (design spec §15.3 "The UI",
// §15.6, §15.5, §7.10 "Turn actions").
//
//   initTurnActions({ timers, fetch })  registers the three actions; idempotent.
//                                       U66a calls it from main.js after
//                                       initChatStream and initGraphTurns.
//                                       `timers` ({setTimeout, clearTimeout}) and
//                                       `fetch` are test seams.
//   stopTurnActions()                   unregisters the three, closes the dialog
//                                       and the toast, unmounts their frames,
//                                       clears the toast's timer, unlistens
//   TOAST_MS                            how long the result toast stays (30 s)
//
// WHAT IT REGISTERS, each shown only when it can act (ruling U66a-U86@
// capability-reasons (a): an unavailable Restore or Fork is simply not shown;
// the reasons are the guide's):
//   * the turn action 'restore-files' ('Restore files'): the turn's code status
//     is ready, capabilities.code_revert, and the viewer may act;
//   * the turn action 'fork' ('Fork from here'): capabilities.fork, the turn not
//     superseded and carrying a session id, and the viewer may act (the first
//     turn is the server's to refuse, with its hint);
//   * the inspector action 'restore-files' ('Restore files'): the node's
//     `mirror.turns` is non-empty (the key is there only at read and above),
//     capabilities.code_revert, and the viewer may act.
// The viewer may act when local, or remote at level `full` with the answer
// origin known (class P2, §15.5): session-control.js mayAct() plus, remotely,
// asks.js answerFrameOrigin(). Neither chat-turns.js nor graph-view.js keys a
// redraw on capabilities or access, so when that answer changes the three are
// registered again — the footers redraw on the registration.
//
// THE DIALOG, #turn-action: a `.popover` built here on first use (index.html has
// no cell for it), role dialog labelled by #ta-title, with #ta-body and
// #ta-confirm (all four reserved, lib/server/domain/mounts.js). shell.js owns
// its dismissal — Escape, an outside press, focus leaving, the window blurring,
// another panel opening all add `.hidden` — so this module listens for no key
// and no outside click: a MutationObserver on its class hears it go hidden, and
// unmounts its frame. Its own ✕ hides it the same way.
//   Restore: GET /api/code/preview?turn=<id>&point=before (or node=<id>) through
//   the chrome's fetch; #ta-body lists, by textContent only, what is rewritten,
//   re-created and deleted, and what is not covered and why; the HEAD-moved
//   notice; "Edits made since that turn, yours included, are reverted too"; on a
//   previewed older node, "This changes files on disk now, not the node you are
//   viewing". A `blocked` answer shows its reason and mounts no frame (disabled
//   while busy, §15.3) — "Check again" reads the preview again; 503, 404, 429
//   and any other refusal show their reason and mount nothing. Otherwise
//   #ta-confirm holds ONE control frame, {action: 'restore', params:
//   {preview_id}}.
//   Fork: #ta-body explains it, and #ta-confirm holds {action: 'fork', params:
//   {turn_id}}; the frame shows the command and its own Copy (notes-B Q8 (a)).
//
// ON DONE, branching only on U85's confirm outcomes ('restored', 'failed',
// 'undone', 'forked', 'refused'; B-confirm (4): done carries counts only):
//   restore 'restored'  close the dialog, open THE RESULT TOAST: a small
//                       `.popover.ta-toast` (no id) at the chat's corner, holding
//                       an Undo frame {action: 'undo', params: {restore_id:
//                       'latest'}, size compact} — the server binds 'latest' to
//                       a concrete restore when it mints the document. It goes
//                       after TOAST_MS unless hovered or focused (leaving starts
//                       the count again), on its ✕, or as any panel goes.
//   restore 'failed'    (residuals) the dialog stays on the frame's result, and
//                       the toast's Undo is offered the same way — inside the
//                       dialog, under #ta-confirm, while it stays open (shell.js
//                       keeps one panel at a time, so a toast beside it would go
//                       at the first press in the dialog); when the dialog
//                       closes (its ✕, Escape, a dismissal) the Undo moves to
//                       the toast.
//   fork 'forked'       the dialog stays open on the frame's command until the
//                       user closes it.
//   'refused', 'undone' the frame shows its own result; the chrome does nothing.
//                       An expired preview is one of these (restore's check()
//                       refuses 'stale-preview', 409, "open Restore files
//                       again"): a new open always reads a fresh preview.
//
// NEVER: a POST to an acting route (every action is the frame's: §15.5, C46,
// ruling U81-U85-U86@click-token (a)); a clipboard write; an Escape or
// outside-click listener; innerHTML with a path; a stand-in for the mod's
// in-place resume.
import { bus } from './bus.js';
import { view } from './state.js';
import { mirror } from './chat-state.js';
import { registerTurnAction } from './chat-turns.js';
import { registerInspectorAction } from './graph-view.js';
import { answerFrameOrigin, PORT_EVENT } from './asks.js';
import { mountControlFrame, mayAct } from './session-control.js';

export const TOAST_MS = 30000;
export const PREVIEW_PATH = '/api/code/preview';

// Why a path is left alone (lib/server/control/restore.js "NOT COVERED").
export const NOT_COVERED_WORDS = Object.freeze({
  ignored: 'ignored by the project’s rules',
  'over-cap': 'over the size cap',
  sensitive: 'withheld as sensitive, so never snapshot',
  outside: 'outside the project',
  'nested-repo': 'inside a nested repository or worktree',
});

// The preview route's 503 reasons (lib/server/control/revert.js HINTS, the
// features reasons, and the route's own two).
export const UNAVAILABLE_WORDS = Object.freeze({
  'diffs-off': 'Per-turn code diffs are off, so no turn has files to go back to.',
  'not-a-git-repo': 'Restoring files needs the project to be a git repository.',
  'git-missing': 'git was not found.',
  'git-too-old': 'Restoring files needs git 2.40 or newer.',
  'shadow-store-full': 'The snapshot store is full.',
  'init-failed': 'The snapshot store could not be set up.',
  'no-snapshots': 'No turn has been snapshot in this project yet.',
  checking: 'Still checking whether files can be restored here: try again in a moment.',
  stopped: 'Restoring files has stopped.',
  'not-installed': 'Restoring files is not set up on this daemon.',
  'no-control': 'Restoring files is not set up on this daemon.',
});

const NO_RECORD = 'This turn changed no files.';
const TRY_AGAIN = 'A preview is already being made: try again in a moment.';
const REVERTED_TOO = 'Edits made since that turn, yours included, are reverted too.';
const ON_DISK_NOW = 'This changes files on disk now, not the node you are viewing.';
const HEAD_MOVED = 'HEAD has moved since that turn. Files go back; commits and branches do not.';
const RESTORE_FAILED = 'Some files could not be restored.';
const NO_UNDO = 'Undo is not available from this page right now.';
const UNDO_SPEC = Object.freeze({ action: 'undo', params: Object.freeze({ restore_id: 'latest' }), layout: 'confirm', size: 'compact' });

let timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h),
};
let fetchFn = (url, init) => globalThis.fetch(url, init);

let inited = null;
let offs = [];          // bus listeners
let turnUnregs = [];    // the two turn actions
let nodeUnregs = [];    // the inspector action
let turnKey = null;     // what the turn actions were registered for
let nodeKey = null;     // what the inspector action was registered for
let couldAct = false;
let dlg = null;         // the dialog: { el, title, body, confirm, undoSlot, observer, handle, undo, undoOwed, token, retry }
let toast = null;       // the toast: { el, slot, handle, timer, held, observer }

// ── who may act ─────────────────────────────────────────────────────────────

function viewerMayAct() {
  if (!mayAct()) return false;
  const a = mirror.access || {};
  return a.remote === true ? !!answerFrameOrigin() : true;
}
const caps = () => mirror.capabilities || {};

function restoreApplies(turn) {
  return !!turn && !!turn.code && turn.code.status === 'ready' && caps().code_revert === true && viewerMayAct();
}
function forkApplies(turn) {
  return !!turn && caps().fork === true && turn.superseded !== true
    && typeof turn.session_id === 'string' && turn.session_id !== '' && viewerMayAct();
}
function nodeApplies(node) {
  const m = node && node.mirror;
  return !!m && Array.isArray(m.turns) && m.turns.length > 0 && caps().code_revert === true && viewerMayAct();
}

// ── small DOM helpers ───────────────────────────────────────────────────────

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
function button(cls, text, label) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  return b;
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── the dialog ──────────────────────────────────────────────────────────────

function buildDialog() {
  const box = el('div', 'popover ta-dialog hidden');
  box.id = 'turn-action';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-labelledby', 'ta-title');
  box.tabIndex = -1;
  const head = el('div', 'ta-head');
  const title = el('h4', 'ta-title');
  title.id = 'ta-title';
  const close = button('ta-close', '✕', 'Close');
  close.addEventListener('click', () => closeDialog());   // hands an Undo off
  head.append(title, close);
  const body = el('div', 'ta-body');
  body.id = 'ta-body';
  const confirm = el('div', 'ta-confirm');
  confirm.id = 'ta-confirm';
  const undoSlot = el('div', 'ta-undo-slot');
  box.append(head, body, confirm, undoSlot);
  document.body.append(box);
  const d = { el: box, title, body, confirm, undoSlot, observer: null, handle: null, undo: null, undoOwed: false, token: 0, retry: null };
  // shell.js hides it (Escape, an outside press, another panel): its frames go,
  // and an Undo it was holding moves to the toast.
  d.observer = new MutationObserver(() => { if (box.classList.contains('hidden')) dialogHidden(d, { handOff: true }); });
  d.observer.observe(box, { attributes: true, attributeFilter: ['class'] });
  return d;
}

// handOff: the dialog closed (✕, Escape, a dismissal), so an Undo it held is
// offered again in the toast. Re-opening it, stopping, or the viewer losing the
// right to act hand nothing off.
function dialogHidden(d, { handOff = false } = {}) {
  d.token++;              // an answer still in flight is dropped
  d.retry = null;
  if (d.handle) { d.handle.unmount(); d.handle = null; }
  const owed = d.undoOwed;
  d.undoOwed = false;
  if (d.undo) { d.undo.unmount(); d.undo = null; }
  d.undoSlot.replaceChildren();
  if (owed && handOff && inited) openToast(RESTORE_FAILED);
}

function closeDialog({ handOff = true } = {}) {
  if (!dlg) return;
  dlg.el.classList.add('hidden');
  dialogHidden(dlg, { handOff });
}

// Open (or re-open) the dialog with a title and nothing in it: → its token.
function openDialog(title) {
  if (!dlg) dlg = buildDialog();
  dialogHidden(dlg);
  dlg.title.textContent = title;
  dlg.body.replaceChildren();
  dlg.confirm.replaceChildren();
  dlg.el.classList.remove('hidden');
  // One panel at a time: the dismiss layer closes every other (the toast too).
  window.dispatchEvent(new CustomEvent('wc:close-popovers', { detail: { keep: dlg.el } }));
  try { dlg.el.focus({ preventScroll: true }); } catch { /* not focusable here */ }
  return dlg.token;
}
const live = (token) => !!dlg && dlg.token === token && !dlg.el.classList.contains('hidden');

// Mount a confirm frame in #ta-confirm. No answer origin yet: asks.js is
// refreshing the port, and PORT_EVENT mounts it.
function mountConfirm(token, spec) {
  if (!live(token)) return;
  // The slot is emptied BEFORE the frame goes in: moving a mounted iframe
  // would reload it.
  const tryMount = () => {
    if (!live(token)) return true;
    const wait = [...dlg.confirm.childNodes];
    dlg.confirm.replaceChildren();
    const h = mountControlFrame(dlg.confirm, { ...spec, layout: 'confirm' });
    if (!h) { dlg.confirm.replaceChildren(...wait); return false; }
    dlg.handle = h;
    dlg.retry = null;
    return true;
  };
  if (tryMount()) return;
  if (!viewerMayAct()) { dlg.confirm.replaceChildren(el('p', 'ta-reason', 'This page may not take that action.')); return; }
  dlg.confirm.replaceChildren(el('p', 'ta-wait', 'Getting the confirm ready…'));
  dlg.retry = tryMount;
}

// ── Restore files ───────────────────────────────────────────────────────────

function list(label, rows) {
  const sec = el('section', 'ta-list');
  sec.append(el('h5', 'ta-list-head', `${label} (${rows.length})`));
  const ul = el('ul', 'ta-paths');
  for (const r of rows) {
    const li = el('li', 'ta-path');
    li.append(el('span', 'ta-path-name', r.path));
    if (r.why) li.append(el('span', 'ta-path-why', r.why));
    ul.append(li);
  }
  sec.append(ul);
  return sec;
}

const pathOf = (v) => (typeof v === 'string' ? v : v && typeof v.path === 'string' ? v.path : '');

function previewing() {
  return !!(view.previewing && view.viewedId && view.viewedId !== view.activeId);
}

function drawPreview(token, p, reopen) {
  const body = dlg.body;
  body.replaceChildren();
  const written = Array.isArray(p.written) ? p.written : [];
  const rewritten = written.filter((w) => w && w.status !== 'A').map((w) => ({ path: pathOf(w) }));
  const recreated = written.filter((w) => w && w.status === 'A').map((w) => ({ path: pathOf(w) }));
  const deleted = (Array.isArray(p.deleted) ? p.deleted : []).map((d) => ({ path: pathOf(d) }));
  const notCovered = (Array.isArray(p.notCovered) ? p.notCovered : []).map((n) => ({
    path: pathOf(n), why: NOT_COVERED_WORDS[n && n.reason] || String((n && n.reason) || 'not covered'),
  }));
  const target = p.target && typeof p.target === 'object' ? p.target : {};
  if (typeof target.label === 'string' && target.label) body.append(el('p', 'ta-target', `To before ${target.label}`));
  body.append(el('p', 'ta-counts', [
    `${rewritten.length} rewritten`, `${recreated.length} re-created`, `${deleted.length} deleted`,
    `${notCovered.length} not covered`].join(' · ')));
  if (rewritten.length) body.append(list('Rewritten', rewritten));
  if (recreated.length) body.append(list('Re-created', recreated));
  if (deleted.length) body.append(list('Deleted', deleted));
  if (notCovered.length) body.append(list('Not covered', notCovered));
  if (p.headMoved === true) body.append(el('p', 'ta-note ta-head-moved', HEAD_MOVED));
  body.append(el('p', 'ta-note ta-reverted', REVERTED_TOO));
  if (previewing()) body.append(el('p', 'ta-note ta-on-disk', ON_DISK_NOW));
  for (const n of Array.isArray(p.notes) ? p.notes : []) {
    if (typeof n === 'string' && n) body.append(el('p', 'ta-aside', n));
  }

  const confirm = dlg.confirm;
  if (p.blocked && typeof p.blocked === 'object') {
    const why = el('p', 'ta-reason ta-blocked', `Not now: ${p.blocked.hint || p.blocked.reason || 'refused'}`);
    const again = button('ta-again', 'Check again');
    again.addEventListener('click', reopen);
    confirm.replaceChildren(why, again);
    return;
  }
  if (!rewritten.length && !recreated.length && !deleted.length) {
    confirm.replaceChildren(el('p', 'ta-reason', 'Nothing to restore: the files already match.'));
    return;
  }
  if (typeof p.preview_id !== 'string' || !p.preview_id) {
    confirm.replaceChildren(el('p', 'ta-reason', 'The preview could not be read.'));
    return;
  }
  mountConfirm(token, {
    action: 'restore',
    params: { preview_id: p.preview_id },
    onDone: (outcome) => onRestoreDone(outcome),
  });
}

function refusalText(status, b) {
  if (status === 503 || (b && b.unavailable === true)) {
    const r = b && typeof b.reason === 'string' ? b.reason : '';
    return UNAVAILABLE_WORDS[r] || `Restoring files is not available here${r ? ` (${r})` : ''}.`;
  }
  if (b && b.refused === 'no-record') return NO_RECORD;
  if (status === 429 || (b && b.refused === 'rate_limited')) return TRY_AGAIN;
  if (b && typeof b.hint === 'string' && b.hint) return b.hint.charAt(0).toUpperCase() + b.hint.slice(1);
  if (b && typeof b.error === 'string' && b.error) return b.error;
  return 'The preview could not be read.';
}

async function openRestore(ref) {
  const isNode = ref.kind === 'node';
  const token = openDialog(isNode ? 'Restore files to before this node' : 'Restore files to before this turn');
  dlg.body.replaceChildren(el('p', 'ta-wait', 'Reading what would change…'));
  const url = `${PREVIEW_PATH}?${isNode ? 'node' : 'turn'}=${encodeURIComponent(ref.id)}&point=before`;
  let status = 0;
  let b = null;
  try {
    const r = await fetchFn(url, { headers: { accept: 'application/json' } });
    status = r.status;
    try { b = await r.json(); } catch { b = null; }
  } catch { status = 0; }
  if (!live(token)) return;
  if (status === 200 && b && b.ok === true) {
    drawPreview(token, b, () => { openRestore(ref); });
    return;
  }
  dlg.body.replaceChildren(el('p', 'ta-reason', status === 0 ? 'The preview could not be read.' : refusalText(status, b)));
}

function onRestoreDone(outcome) {
  if (outcome === 'restored') {
    closeDialog({ handOff: false });
    openToast('Files restored.');
  } else if (outcome === 'failed') {
    offerUndoInDialog();
  }
  // 'refused' and anything else: the frame shows its own result.
}

// 'failed': the dialog stays on the frame's result, so the Undo goes in it,
// under #ta-confirm — the one panel that stays. Closing the dialog hands it to
// the toast (dialogHidden).
function offerUndoInDialog() {
  if (!dlg || dlg.el.classList.contains('hidden')) return;
  dlg.undoOwed = true;
  if (dlg.undo) return;
  dlg.undoSlot.replaceChildren();
  dlg.undo = mountControlFrame(dlg.undoSlot, { ...UNDO_SPEC, onDone: () => {} });
  if (!dlg.undo) dlg.undoSlot.append(el('p', 'ta-reason', NO_UNDO));
}

// ── Fork from here ──────────────────────────────────────────────────────────

function openFork(turn) {
  const token = openDialog('Fork from here');
  const label = turn.node && turn.node.label ? ` ${turn.node.label}` : '';
  dlg.body.replaceChildren(
    el('p', 'ta-line', `Starts a new conversation from before this turn${label}.`),
    el('p', 'ta-line', 'The original conversation is kept, and no files change.'),
    el('p', 'ta-line', 'Confirm, then paste the command it gives you into a terminal.'),
  );
  // 'forked': the dialog stays on the frame's command until the user closes it.
  mountConfirm(token, { action: 'fork', params: { turn_id: turn.id }, onDone: () => {} });
}

// ── the result toast ────────────────────────────────────────────────────────

function toastHidden(t) {
  if (t.timer !== null) { timers.clearTimeout(t.timer); t.timer = null; }
  if (t.handle) { t.handle.unmount(); t.handle = null; }
  t.observer.disconnect();
  t.el.remove();
  if (toast === t) toast = null;
}

function closeToast() {
  if (!toast) return;
  const t = toast;
  t.el.classList.add('hidden');
  toastHidden(t);
}

function armToast(t) {
  if (t.timer !== null) timers.clearTimeout(t.timer);
  t.timer = timers.setTimeout(() => {
    t.timer = null;
    if (toast !== t) return;
    if (t.held.size || t.el.contains(document.activeElement)) return;   // leaving starts it again
    closeToast();
  }, TOAST_MS);
}

function openToast(text) {
  closeToast();
  const box = el('div', 'popover ta-toast');
  box.setAttribute('role', 'status');
  const head = el('div', 'ta-toast-head');
  head.append(el('span', 'ta-toast-text', text));
  const close = button('ta-close', '✕', 'Close');
  head.append(close);
  const slot = el('div', 'ta-toast-slot');
  box.append(head, slot);
  document.body.append(box);
  const t = { el: box, slot, handle: null, timer: null, held: new Set(), observer: null };
  close.addEventListener('click', () => { if (toast === t) closeToast(); });
  const hold = (why) => { t.held.add(why); if (t.timer !== null) { timers.clearTimeout(t.timer); t.timer = null; } };
  const release = (why) => { t.held.delete(why); if (!t.held.size && toast === t) armToast(t); };
  box.addEventListener('mouseenter', () => hold('hover'));
  box.addEventListener('mouseleave', () => release('hover'));
  box.addEventListener('focusin', () => hold('focus'));
  box.addEventListener('focusout', (e) => { if (!box.contains(e.relatedTarget)) release('focus'); });
  t.observer = new MutationObserver(() => { if (box.classList.contains('hidden')) toastHidden(t); });
  t.observer.observe(box, { attributes: true, attributeFilter: ['class'] });
  toast = t;
  // 'undone' and 'refused': the frame says so itself.
  t.handle = mountControlFrame(slot, { ...UNDO_SPEC, onDone: () => {} });
  // (control-confirm.js puts `size` on its <html data-size> for answer.css.)
  if (!t.handle) slot.append(el('p', 'ta-reason', NO_UNDO));
  armToast(t);
}

// ── registration ────────────────────────────────────────────────────────────

function registerTurns() {
  return [
    registerTurnAction({
      id: 'restore-files', label: 'Restore files', applies: restoreApplies,
      run: (turn) => { if (restoreApplies(turn)) openRestore({ kind: 'turn', id: turn.id }); },
    }),
    registerTurnAction({
      id: 'fork', label: 'Fork from here', applies: forkApplies,
      run: (turn) => { if (forkApplies(turn)) openFork(turn); },
    }),
  ];
}

function registerNode() {
  return [
    registerInspectorAction({
      id: 'restore-files', label: 'Restore files', title: 'Restore files to before this node', applies: nodeApplies,
      // The U80 race: a newer selection still loading hands run a null node —
      // never act on a stale selection.
      run: (id, node) => {
        if (!node || typeof node !== 'object' || !nodeApplies(node)) return;
        const ref = typeof node.id === 'string' && node.id ? node.id : id;
        if (typeof ref !== 'string' || !ref) return;
        openRestore({ kind: 'node', id: ref });
      },
    }),
  ];
}

function drop(list) {
  for (const off of list.splice(0)) { try { off(); } catch { /* gone */ } }
}
function unregister() {
  drop(turnUnregs);
  drop(nodeUnregs);
  turnKey = null;
  nodeKey = null;
}

// Capabilities, access or the answer origin changed: an action whose own inputs
// changed is registered again — the footers redraw on it. The inspector's is
// re-registered only for its own (code_revert, may act): its unregister takes
// the painted button away and nothing paints it back until the next selection.
// A viewer who may no longer act loses the open dialog and toast.
function sync() {
  if (!inited) return;
  const cr = caps().code_revert === true ? 1 : 0;
  const may = viewerMayAct();
  const tk = `${cr}|${caps().fork === true ? 1 : 0}|${may ? 1 : 0}`;
  const nk = `${cr}|${may ? 1 : 0}`;
  if (tk !== turnKey) { turnKey = tk; drop(turnUnregs); turnUnregs = registerTurns(); }
  if (nk !== nodeKey) { nodeKey = nk; drop(nodeUnregs); nodeUnregs = registerNode(); }
  const could = couldAct;
  couldAct = may;
  if (could && !may) { closeDialog({ handOff: false }); closeToast(); }
}

function onPort() {
  if (dlg && dlg.retry && !dlg.el.classList.contains('hidden')) dlg.retry();
  sync();
}

export function initTurnActions({ timers: t, fetch: f } = {}) {
  if (t && typeof t.setTimeout === 'function' && typeof t.clearTimeout === 'function') timers = t;
  if (typeof f === 'function') fetchFn = f;
  if (inited) return inited;
  inited = { stop: stopTurnActions };
  turnKey = null;
  nodeKey = null;
  couldAct = false;
  offs = [bus.on('mirror', sync), bus.on(PORT_EVENT, onPort)];
  sync();
  return inited;
}

export function stopTurnActions() {
  for (const off of offs.splice(0)) { try { off(); } catch { /* gone */ } }
  unregister();
  closeToast();
  if (dlg) {
    closeDialog({ handOff: false });
    dlg.observer.disconnect();
    dlg.el.remove();
    dlg = null;
  }
  couldAct = false;
  inited = null;
}
