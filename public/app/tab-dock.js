// Docking the phone's grip tab (design spec §8.9, §8.3, ruling N2): a sideways
// drag of the CLOSED tab moves it with the finger and settles it left, centre
// or right by thirds of the pull's width; the dock is remembered per viewer.
//
//   initTabDock()   idempotent: read the stored dock, set it on #chat-pull, and
//                   register the drag's dock handler
//   stopTabDock()   unregister it and drop any pending frame; data-dock stays
//
// What this module writes, and nothing else:
//   * data-dock ('left' | 'center' | 'right') on #chat-pull. CSS (U72's
//     section of app.css) places the tab and the badge from it, and
//     chat-sheet.js's draw reads it for badgeLook (the merged count and the
//     tab's ", N running"), so a change is followed by refreshPull().
//   * During a drag, the .docking class (no transitions: the tab follows the
//     finger) and --tab-dx (px) on #chat-pull — never on #stage, where a custom
//     property restyles every pane on every frame.
//   * wc:chat-tab in local storage, through storage.js, only when the dock
//     changed. An invalid stored value reads as right (normalizeDock).
//
// It edits neither sheet-drag.js nor chat-sheet.js: the drag decides when a
// gesture is a dock (horizontal, the sheet closed, not in keyboard mode) and
// calls the handler; the thirds are sheet-model.js's dockFor. Docking is
// pointer-only (notes-A D9): the tab's ArrowUp and ArrowDown step the stops.
//
// Teardown: one handler registration, removed by stopTabDock(); at most one
// pending animation frame. No listener, timer or observer of its own.
import { normalizeDock, dockFor } from './sheet-model.js';
import { setDockHandler } from './sheet-drag.js';
import { refreshPull } from './chat-sheet.js';
import { getLocal, setLocal } from './storage.js';

const KEY = 'wc:chat-tab';

let off = null;     // the dock handler's unregister, while running
let frame = null;   // the one pending move frame
let g = null;       // the drag in progress: {pull, from, centre, width, dx}

const pullEl = () => document.getElementById('chat-pull');

function raf(fn) {
  const r = globalThis.requestAnimationFrame;
  if (typeof r === 'function') return r(fn);
  fn();
  return null;
}
function dropFrame() {
  const c = globalThis.cancelAnimationFrame;
  if (frame !== null && typeof c === 'function') c(frame);
  frame = null;
}

// The drag is over (or abandoned): the tab and the badge animate to their dock.
function settle(d) {
  dropFrame();
  d.pull.style.removeProperty('--tab-dx');
  d.pull.classList.remove('docking');
}

const handler = {
  begin({ x, width }) {
    const pull = pullEl();
    if (!pull) return;
    const p = pull.getBoundingClientRect();
    const tab = pull.querySelector('#chat-tab');
    const t = tab ? tab.getBoundingClientRect() : null;
    // The tab's centre relative to the pull at the grab; without a laid-out tab
    // (none rendered yet), the pointer's start, which is on it.
    const centre = t && t.width > 0 ? t.left + t.width / 2 - p.left : (Number(x) || 0) - p.left;
    g = { pull, from: normalizeDock(pull.dataset.dock), centre, width: p.width > 0 ? p.width : width, dx: 0 };
    pull.classList.add('docking');
  },
  move({ dx }) {
    if (!g) return;
    g.dx = Number(dx) || 0;
    if (frame !== null) return;
    frame = raf(() => {
      frame = null;
      if (g) g.pull.style.setProperty('--tab-dx', `${g.dx}px`);
    });
  },
  end({ dx, cancelled }) {
    const d = g;
    g = null;
    if (!d) return;
    const to = cancelled ? d.from : dockFor(d.centre + (Number(dx) || 0), d.width);
    if (d.pull.dataset.dock !== to) d.pull.dataset.dock = to;
    settle(d);
    if (to === d.from) return;
    setLocal(KEY, to);
    refreshPull();
  },
};

export function initTabDock() {
  if (off) return;
  const pull = pullEl();
  if (pull) pull.dataset.dock = normalizeDock(getLocal(KEY));
  off = setDockHandler(handler);
  refreshPull();
}

export function stopTabDock() {
  if (off) { off(); off = null; }
  if (g) { settle(g); g = null; }
  dropFrame();
}
