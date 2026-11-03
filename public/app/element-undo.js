// The engine's undo in the chrome (annotation engine 4A.3, U518; DECISIONS
// N.1 AD6, AI13 U518@undo-item-and-chord).
//
// ONE chrome action, `elements.undo`, in the hotkey registry (hotkeys.js) and
// one ⌘K row (shell.js registerPaletteSource) — never a toolbar button and
// never a legend row (the GUI is the maintainer's; F11 k1's legend lines stay).
//
//   * Mod+Z is its fixed default (a chrome default no record can unbind: the
//     record grammar, lib/core/toolbar-record validChord, refuses every Mod+
//     chord); a user record may ADD a [Shift+]<Key> binding to it.
//   * whenField false: the key never fires while a text field has focus, in
//     the chrome or inside a pane, so a field keeps its own undo.
//   * enabled() is toolbarState().canWrite (full access): below full the press
//     is the page's.
//   * run goes through element-types.js trayAction: while a committed node is
//     previewed it shows READONLY_HINT and sends nothing.
//
// What it posts: POST /api/elements/undo {item?, device} — `item` the pane or
// markdown item under the last pointer position, else the one holding focus
// (the closest .mount-host's mount id, a pane wrapper's data-pane-id, or a
// [data-md-id]), else none (the daemon then takes the caller's newest live
// version anywhere on the page and names its item). The answer's note goes
// through the topbar's one notice: "Undid <type> on <item>", or the hint.
//
//   initElementUndo()   registers the action, the palette row and the pointer
//                       watch (idempotent)
//   undoLast()          the action's run → the request's answer, or the guard's
//                       refusal ({ok: false, refused: 'read-only', hint})

import { registerAction, keyFor } from './hotkeys.js';
import { registerPaletteSource } from './shell.js';
import { trayAction } from './element-types.js';
import { toolbarState } from './toolbar-state.js';
import { request } from './http.js';
import { showReaimNote } from './topbar.js';

export const UNDO_ACTION = 'elements.undo';
export const UNDO_LABEL = 'Undo the last annotation on this pane';
export const UNDO_CHORD = 'Mod+Z';
export const UNDO_PATH = '/api/elements/undo';
const FAILED_HINT = 'The annotation was not undone: try again.';

let running = false;
let lastPointer = null;   // the element the last pointer event reached (a pane's events reach its host)

const typeWords = (type) => String(type || 'annotation').replace(/-/g, ' ');

// The page item `el` sits in: a pane (its host or its wrapper) or a markdown item.
function itemOf(el) {
  if (!el || typeof el.closest !== 'function') return null;
  const md = el.closest('[data-md-id]');
  if (md) return md.getAttribute('data-md-id') || null;
  const host = el.closest('.mount-host');
  if (host && host.dataset.mountId) return host.dataset.mountId;
  const pane = el.closest('.pane[data-pane-id]');
  return pane ? pane.dataset.paneId || null : null;
}

// The item the undo is about: under the pointer, else holding focus, else none.
export function currentItem() {
  const under = lastPointer && lastPointer.isConnected ? itemOf(lastPointer) : null;
  if (under) return under;
  return itemOf(document.activeElement);
}

const enabled = () => toolbarState().canWrite === true;

export function undoLast() {
  return trayAction(async () => {
    const item = currentItem();
    const r = await request('POST', UNDO_PATH, { body: item ? { item } : {}, device: true });
    if (!r.ok) {
      const hint = r.hint || FAILED_HINT;
      showReaimNote(hint);
      return { ok: false, status: r.status, hint };
    }
    const b = r.body && typeof r.body === 'object' ? r.body : {};
    const u = b.undone && typeof b.undone === 'object' ? b.undone : {};
    const note = `Undid ${typeWords(u.type)} on ${u.item || 'the page'}`;
    showReaimNote(typeof b.hint === 'string' && b.hint ? `${note} — ${b.hint}` : note);
    return { ok: true, ...b };
  });
}

function track(e) { lastPointer = e && e.target ? e.target : null; }

export function initElementUndo() {
  if (running) return;
  running = true;
  for (const type of ['pointerdown', 'pointermove']) {
    document.addEventListener(type, track, { capture: true, passive: true });
  }
  registerAction({
    id: UNDO_ACTION,
    label: UNDO_LABEL,
    defaultChord: UNDO_CHORD,
    context: 'page',
    whenField: false,
    rebindable: true,
    legend: null,
    enabled,
    run: () => { undoLast(); },
  });
  registerPaletteSource(UNDO_ACTION, {
    rows: () => (enabled()
      ? [{ kind: 'command', label: UNDO_LABEL, hint: keyFor(UNDO_ACTION), run: () => { undoLast(); } }]
      : []),
  });
}
