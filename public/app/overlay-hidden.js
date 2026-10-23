// Hidden versus gone (annotation engine 2A.2): the overlay's ONE hidden-state
// probe, and the triggers that make a pane's anchored elements re-resolve when
// something other than a re-render changed what the pane shows.
//
// THE PROBE. The resolver answers only exact / re-resolved / orphaned
// (lib/core/anchors.js): it cannot know that a pane is not drawn NOW. An
// element in a minimized pane, under the phone sheet, in a pane still mounting
// or waiting on its service's approval is HIDDEN — never drawn, never reported
// orphaned — while an element that was removed always reads orphaned. The
// rules are F4's measured prototype (its hidden-gone module under
// design/annotation-engine-redesign/tests/F4/lib), in its v2 order, first
// match wins:
//
//   1. the 'live' scope while previewing          → hidden 'preview'
//      (the live DOM is folded aside; nothing about it is knowable)
//   2. no live pane record for the anchor's mount  → orphaned (gone)
//   3. the element resolves (exact / re-resolved):
//        the pane minimized                         → hidden 'minimized'
//        narrow, the phone sheet at its full stop   → hidden 'sheet'
//        else                                       → as answered
//   4. it does not resolve:
//        minimized with an empty host               → hidden 'minimized'
//        the pane's component in pendingServices()  → hidden 'service-pending'
//        the pane not complete, or completed less
//        than MOUNT_GRACE_MS ago (mountState)       → hidden 'mounting'
//        else                                       → orphaned
//
// The 'preview' scope resolves against the previewed node's own DOM (the pane
// records are the preview's then) by the same rules less rule 1 (F-DOCS (a)).
// A markdown item's source anchor has no pane: rules 1 and 3's sheet clause
// apply, and an unresolved one is orphaned. Rule 3 runs BEFORE rule 4 reads the
// host, so a minimized pane that keeps its DOM (today's minimize does) is
// resolved first: an element removed from it reads orphaned, minimized or not.
//
// THE TRIGGERS (P-8's second trigger, U224's hand-off). A pane re-resolves on
// its settle (public/mount-runtime.js settle, which moves the root's
// generation and so drops the resolver's cached index). Besides a mount, a
// re-render and a mode change, a pane is settled here:
//   - a store write: a pane's own facade write (opts.mount, public/app/
//     mounts.js) settles that pane; any other write (a daemon 'store:patch'
//     frame, a reconcile, a write through window.store) settles every watched
//     pane that is visible, i.e. drawn into the document (a minimized pane
//     keeps its DOM and the sheet unmounts nothing, so both count) — why
//     'store';
//   - a hidden state changing: a pane minimized or restored, the phone sheet
//     reaching or leaving its full stop (or the screen turning narrow), a
//     pane's service entering or leaving the pending list, a pane's mount
//     grace running out — why 'hidden-state', so the probe reads again.
// Each is coalesced: at most one settle per mount per frame, on the frame after
// the change. Only a mount the overlay watches is ever settled. A pane taken
// off the surface has no root left to settle: the overlay is asked for one
// pass over that mount instead (resolveMount), which answers it gone.
//
// The store's own API hands a subscriber the patch alone, never its opts, so
// the write is heard by wrapping the chrome store's `set` once (transparent:
// the original runs first, its answer returned) — see installRetriggers.
//
// This module sends nothing and reports nothing (U314's, through the
// overlay's onAnswers); it changes no resolver answer, only names which
// unresolved or undrawn answers are hidden.
import { view, $ } from './state.js';
import { bus } from './bus.js';
import { store } from './store.js';
import { panes, mountState } from './mounts.js';
import { isNarrow } from './viewport.js';
import { sheetState } from './chat-sheet.js';
import { pendingServices, onPendingChange, initServicePending } from './service-pending.js';
import anchors from './anchors.js';

// F4's settleMs: how long after its mount settle a pane's missing element is
// still taken for one the pane has yet to draw.
export const MOUNT_GRACE_MS = 500;

export const HIDDEN_REASONS = Object.freeze({
  PREVIEW: 'preview',
  MINIMIZED: 'minimized',
  SHEET: 'sheet',
  SERVICE_PENDING: 'service-pending',
  MOUNTING: 'mounting',
});

// The settle reasons this module passes (mount-runtime's `why`).
export const RESETTLE_WHY = Object.freeze({ STORE: 'store', HIDDEN: 'hidden-state' });

// The resolver's own vocabulary (lib/core/anchor-states, carried by anchors.js).
function stateOf(name) {
  if (!anchors.STATES || anchors.STATES.indexOf(name) < 0) throw new Error(`overlay-hidden: the state vocabulary has no ${name}`);
  return name;
}
const EXACT = stateOf('exact');
const RE_RESOLVED = stateOf('re-resolved');

const resolves = (answer) => !!answer && (answer.state === EXACT || answer.state === RE_RESOLVED);
const isSource = (row) => !!(row && row.anchor && row.anchor.kind === 'source');
const minimizedOf = (rec) => !!(rec && rec.pane_state && rec.pane_state.minimized);
const emptyHost = (rec) => !rec.root || rec.root.childElementCount === 0;

// The phone sheet covers every pane: a narrow screen with the sheet at its
// full stop.
function sheetCovers() {
  if (!isNarrow()) return false;
  try { return sheetState().stop === 'full'; } catch { return false; }
}

// The chrome's own inputs; a test may hand createHiddenProbe others.
const LIVE_INPUTS = Object.freeze({
  previewing: () => !!view.previewing,
  pane: (id) => panes.get(id),
  mountState: (id) => mountState(id),
  pending: () => pendingServices(),
  covered: () => sheetCovers(),
  now: () => Date.now(),
  onMounting: null,
});

// The rules above, over one answer. q = the overlay's {row, answer, mount,
// scope}; d = the inputs. → a HIDDEN_REASONS value, or null (as answered).
export function hiddenReason(q, d = LIVE_INPUTS) {
  const { row, answer, mount, scope } = q || {};
  if (scope === 'live' && d.previewing()) return HIDDEN_REASONS.PREVIEW;
  if (isSource(row)) return resolves(answer) && d.covered() ? HIDDEN_REASONS.SHEET : null;
  const rec = mount == null ? null : d.pane(String(mount));
  if (!rec) return null;
  const minimized = minimizedOf(rec);
  if (resolves(answer)) {
    if (minimized) return HIDDEN_REASONS.MINIMIZED;
    if (d.covered()) return HIDDEN_REASONS.SHEET;
    return null;
  }
  if (minimized && emptyHost(rec)) return HIDDEN_REASONS.MINIMIZED;
  const component = rec.spec && rec.spec.component;
  if (component && d.pending().has(component)) return HIDDEN_REASONS.SERVICE_PENDING;
  const ms = d.mountState(String(mount));
  if (!ms || !ms.complete) return HIDDEN_REASONS.MOUNTING;
  if (d.now() - ms.at < MOUNT_GRACE_MS) {
    if (typeof d.onMounting === 'function') d.onMounting(String(mount), ms.at);
    return HIDDEN_REASONS.MOUNTING;
  }
  return null;
}

// A probe over some inputs (the missing ones are the chrome's).
export function createHiddenProbe(inputs = {}) {
  const d = { ...LIVE_INPUTS, ...inputs };
  return (q) => hiddenReason(q, d);
}

// ── the triggers ────────────────────────────────────────────────────────────
const rt = {
  installed: false,
  watched: () => [],
  resolveMount: null,         // the overlay's pass over one mount (a gone pane)
  raf: (fn) => requestAnimationFrame(fn),
  queued: new Map(),          // mount → why, for the next frame
  scheduled: false,
  covered: false,
  graceTimers: new Map(),     // mount → {at, handle}
};

function isWatched(id) {
  try { return rt.watched().includes(id); } catch { return false; }
}

function queue(id, why) {
  if (id == null || !isWatched(id)) return;
  if (!rt.queued.has(id)) rt.queued.set(id, why);
  if (rt.scheduled) return;
  rt.scheduled = true;
  rt.raf(flush);
}
function flush() {
  rt.scheduled = false;
  const list = [...rt.queued];
  rt.queued.clear();
  const M = window.__wcMount;
  if (!M || typeof M.settle !== 'function') return;
  for (const [id, why] of list) {
    const rec = panes.get(id);
    if (!rec || !rec.root || (rec.host && rec.host.isConnected === false)) continue;
    M.settle(rec.root, id, why);   // read off the global at the call: a harness may wrap it
  }
}

// A write to the chrome's store: its pane's alone when the pane's facade made
// it, else every watched pane that is visible — drawn into the document (flush
// skips one with no root or a host gone from it). A minimized pane keeps its
// DOM and the phone sheet covers the panes without unmounting them, so both
// count: a store write that removes an anchored element from either must read
// orphaned at once (rule 3 resolves before it hides), not when it is next shown.
function storeWritten(opts) {
  const mount = opts && opts.mount != null ? String(opts.mount) : null;
  if (mount != null) { queue(mount, RESETTLE_WHY.STORE); return; }
  for (const id of rt.watched()) queue(id, RESETTLE_WHY.STORE);
}
function wrapStore() {
  if (store.set && store.set.__wcHiddenState) return;
  const raw = store.set;
  const set = function set(patch, opts) {
    const out = raw.call(this, patch, opts);
    try { storeWritten(opts); } catch (e) { console.error('[web-chat] overlay-hidden: the store trigger failed', e); }
    return out;
  };
  set.__wcHiddenState = true;
  store.set = set;
}

function allWatched(why) {
  for (const id of rt.watched()) queue(id, why);
}
function coveredMaybeChanged() {
  const now = sheetCovers();
  if (now === rt.covered) return;
  rt.covered = now;
  allWatched(RESETTLE_WHY.HIDDEN);
}

// The panes' wrappers, watched in the well (#main):
//   - a pane minimized or restored: its wrapper's class flips (every path — the
//     header's button, another viewer's pane:state, a reconcile — goes through
//     mounts.js applyPaneState, which toggles it) → that pane is settled;
//   - a pane taken off the surface (a clear, a reset without it): its wrapper
//     leaves the DOM and no pane record names its id any more. It has no root
//     left to settle, so the overlay is asked for a pass over that mount
//     (resolveMount), which answers its anchors orphaned (mount-absent): gone.
//     A wrapper that leaves while a record keeps its id is a re-mount or a
//     move between runs; the new instance's own settle covers it.
const paneIdOf = (el) => (el && el.classList && el.classList.contains('pane') && el.dataset && el.dataset.paneId) || null;
function watchWell() {
  const main = $('main');
  if (!main || typeof MutationObserver !== 'function') return;
  const mo = new MutationObserver((records) => {
    const gone = new Set();
    for (const r of records) {
      if (r.type === 'attributes') {
        const id = paneIdOf(r.target);
        if (!id) continue;
        const was = /(^|\s)minimized(\s|$)/.test(r.oldValue || '');
        if (was !== r.target.classList.contains('minimized')) queue(id, RESETTLE_WHY.HIDDEN);
        continue;
      }
      for (const n of r.removedNodes || []) {
        if (!n || n.nodeType !== 1) continue;
        const id = paneIdOf(n);
        if (id) gone.add(id);
        if (typeof n.querySelectorAll === 'function') {
          for (const w of n.querySelectorAll('.pane')) { const wid = paneIdOf(w); if (wid) gone.add(wid); }
        }
      }
    }
    for (const id of gone) {
      if (panes.has(id) || !isWatched(id) || typeof rt.resolveMount !== 'function') continue;
      try { rt.resolveMount(id); } catch (e) { console.error('[web-chat] overlay-hidden: a gone pane\'s pass failed', e); }
    }
  });
  mo.observe(main, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
}

// A pane still within its mount grace was read hidden: when the grace runs out
// it is settled once more, so a late-drawn element resolves and a missing one
// reads orphaned.
function graceEnds(mount, at) {
  const t = rt.graceTimers.get(mount);
  if (t && t.at === at) return;
  if (t) clearTimeout(t.handle);
  const wait = Math.max(0, at + MOUNT_GRACE_MS - Date.now()) + 1;
  const handle = setTimeout(() => {
    rt.graceTimers.delete(mount);
    const ms = mountState(mount);
    if (ms.complete && ms.at === at) queue(mount, RESETTLE_WHY.HIDDEN);
  }, wait);
  rt.graceTimers.set(mount, { at, handle });
}

// The chrome's probe: LIVE_INPUTS, with the grace's re-settle.
export const hiddenProbe = createHiddenProbe({ onMounting: graceEnds });

// Called once from initOverlay. `watched()` names the mounts the overlay
// watches (only those are ever settled); `raf` is the frame the coalesced
// settles run on; `resolveMount(id)` asks the overlay for one pass over a
// mount (a pane gone from the surface). A second call only updates those.
export function installRetriggers({ watched, raf, resolveMount } = {}) {
  if (typeof watched === 'function') rt.watched = watched;
  if (typeof raf === 'function') rt.raf = raf;
  if (typeof resolveMount === 'function') rt.resolveMount = resolveMount;
  if (rt.installed) return;
  rt.installed = true;
  initServicePending();
  wrapStore();
  watchWell();
  rt.covered = sheetCovers();
  bus.on('sheet', coveredMaybeChanged);
  bus.on('viewport:narrow', coveredMaybeChanged);
  onPendingChange(({ added, removed }) => {
    const moved = new Set([...added, ...removed]);
    for (const id of rt.watched()) {
      const rec = panes.get(id);
      const c = rec && rec.spec && rec.spec.component;
      if (c && moved.has(c)) queue(id, RESETTLE_WHY.HIDDEN);
    }
  });
}
