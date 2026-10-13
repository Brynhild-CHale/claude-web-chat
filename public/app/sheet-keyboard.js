// The phone sheet over the on-screen keyboard (design spec §8.5).
//
//   initSheetKeyboard({vv} = {})   start; idempotent. vv is the visual viewport
//                                  (window.visualViewport by default; null for
//                                  a browser without one, where nothing happens)
//   stopSheetKeyboard()            stop: every listener, the frame, keyboard mode
//
// iOS Safari, and Chrome on Android since 108, shrink only the VISUAL viewport
// when the keyboard rises, so a sheet placed in the layout viewport (U68's pull
// rides the bottom bar) ends up under the keyboard. KEYBOARD MODE pins the pull
// to the visual viewport instead, so the composer sits on the keyboard:
//
//   on    while an editable inside #chat-sheet has focus AND the keyboard hides
//         more than KB_MIN px (sheet-model.js keyboardInset/keyboardUp). Entering
//         remembers the sheet's stop and adds .kb to #chat-pull; every frame
//         while on writes --kb-top and --kb-h (sheet-model.js kbFrame) on
//         #chat-pull — never on #stage, where a custom property restyles every
//         pane. app.css (U71's section) turns .kb into position: fixed at those
//         numbers and hides the tab and the badge; sheet-drag.js refuses a drag
//         while .kb is there (U68).
//   off   once the keyboard has gone (the inset is back to KB_MIN or less,
//         checked on the frames after a focusout, as the keyboard animates away),
//         or at once when focus has moved to an editable outside the sheet. The
//         remembered stop comes back through setStop, and window.scrollTo(0, 0)
//         runs when the browser left the page panned. A 'sheet' event with open
//         false (a close, or the flip to wide) leaves at once, with no scroll.
//
// Editable is the one list app.css's 16 px rule names: input (not checkbox,
// radio, range, button, submit or file), textarea, select, or [contenteditable]
// other than 'false' — the composer, the moved rail's note field and the inline
// message editor included. Focus outside the sheet (a pane's input, the
// topbar) never enters keyboard mode.
//
// THE VIEWPORT META IS NOT CHANGED: interactive-widget=resizes-content would
// change every pane input on phones, and Safari ignores it. No media query, no
// window resize listener (U68 re-measures the stops on that).
//
// LISTENERS (the teardown contract): one resize and one scroll listener on the
// visual viewport, focusin and focusout on #chat-sheet and the view's 'sheet'
// bus listener — added once, when chat-sheet.js mounts the 'keyboard' sheet
// view, and removed by stopSheetKeyboard (or the sheet's own stop); never per
// focus. Everything they do is coalesced to at most ONE pending animation frame.
import { keyboardInset, keyboardUp, kbFrame } from './sheet-model.js';
import { registerSheetView } from './chat-sheet.js';

export const KEYBOARD_VIEW = 'keyboard';

const NOT_TEXT = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'file']);

// One element: does focusing it raise a keyboard? (app.css's 16 px list.)
function editable(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NOT_TEXT.has(String(el.getAttribute('type') || 'text').trim().toLowerCase());
  const ce = el.getAttribute('contenteditable');
  return ce !== null && ce.trim().toLowerCase() !== 'false';
}

let unregister = null;
let started = false;

// The view chat-sheet.js mounts once the sheet is up. All its state lives in
// this closure, so a second mount could never share (and hide) the first's.
function keyboardView(vv) {
  return (api) => {
    const { pull, sheet } = api;
    let kb = false;
    let prev = null;      // the stop to bring back: { name, h }
    let frame = null;

    const focusedIn = () => {
      const a = document.activeElement;
      return !!a && sheet.contains(a) && editable(a);
    };
    const focusedOut = () => {
      const a = document.activeElement;
      return !!a && !sheet.contains(a) && editable(a);
    };
    const inset = () => keyboardInset({ innerHeight: window.innerHeight, vvHeight: vv.height, vvOffsetTop: vv.offsetTop });

    function write() {
      const f = kbFrame({ vvHeight: vv.height, vvOffsetTop: vv.offsetTop });
      pull.style.setProperty('--kb-top', `${f.top}px`);
      pull.style.setProperty('--kb-h', `${f.height}px`);
    }

    function enter() {
      const s = api.state();
      prev = { name: s.stop, h: s.h };
      kb = true;
      pull.classList.add('kb');
    }

    function leave({ restore, scroll }) {
      kb = false;
      pull.classList.remove('kb');
      pull.style.removeProperty('--kb-top');
      pull.style.removeProperty('--kb-h');
      const was = prev;
      prev = null;
      if (restore && was) {
        const s = api.state();
        if (s.open) {
          const { full, half } = s.stops;
          let px = null;
          if (was.name === 'full') px = full;
          else if (was.name === 'half') px = half === null ? full : half;
          else if (was.name === 'between') px = Math.min(was.h, full);
          if (px !== null && px > 0) api.setStop(px);
        }
      }
      if (scroll) {
        const panned = (Number(window.scrollY) || 0) !== 0 || (Number(vv.offsetTop) || 0) !== 0;
        if (panned) { try { window.scrollTo(0, 0); } catch { /* no scrolling here */ } }
      }
    }

    function run() {
      frame = null;
      const up = keyboardUp(inset());
      if (!kb) {
        if (up && focusedIn() && api.state().open) { enter(); write(); }
        return;
      }
      if (!up || focusedOut()) { leave({ restore: true, scroll: true }); return; }
      write();
    }

    function schedule() {
      if (frame !== null) return;
      const raf = globalThis.requestAnimationFrame;
      if (typeof raf !== 'function') { run(); return; }
      frame = raf(run);
    }

    // The visual viewport moves on every pan and pinch: only a frame that can
    // change something is asked for.
    const onViewport = () => { if (kb || focusedIn()) schedule(); };
    const onFocus = () => schedule();
    const onSheet = (d) => { if (kb && d && d.open === false) leave({ restore: false, scroll: false }); };

    vv.addEventListener('resize', onViewport);
    vv.addEventListener('scroll', onViewport);
    sheet.addEventListener('focusin', onFocus);
    sheet.addEventListener('focusout', onFocus);
    api.on('sheet', onSheet);   // goes with the view

    return () => {
      vv.removeEventListener('resize', onViewport);
      vv.removeEventListener('scroll', onViewport);
      sheet.removeEventListener('focusin', onFocus);
      sheet.removeEventListener('focusout', onFocus);
      if (frame !== null) {
        const caf = globalThis.cancelAnimationFrame;
        if (typeof caf === 'function') caf(frame);
        frame = null;
      }
      if (kb) leave({ restore: false, scroll: false });
    };
  };
}

export function initSheetKeyboard({ vv } = {}) {
  if (started) return;
  started = true;
  const v = vv === undefined ? (typeof window !== 'undefined' ? window.visualViewport : null) : vv;
  if (!v || typeof v.addEventListener !== 'function' || typeof document === 'undefined') return;
  unregister = registerSheetView(KEYBOARD_VIEW, keyboardView(v));
}

export function stopSheetKeyboard() {
  started = false;
  const off = unregister;
  unregister = null;
  if (off) off();
}
