// The phone pull's gestures (design spec §8.4, §8.9): the grip tab dragged up
// and down between the sheet's stops, and — when a dock handler is registered
// and the sheet is closed — sideways to dock the tab.
//
//   attachSheetDrag(handle, hooks) → detach()
//     hooks = { stops()    the sheet's stops, measured at drag start ({full, half})
//               height()   the RENDERED height, so a grab during a settle starts there
//               enabled()  false while dragging is off (the keyboard's .kb, U71)
//               closed()   whether the sheet is closed (a sideways drag docks only then)
//               onMove(h)  a vertical drag's height, at most once per animation frame
//               onSettle(px, {from})   where a release (or an arrow key) settles }
//   setDockHandler({ begin({x, width}), move({dx}), end({dx, x, width, cancelled}) })
//     → unregister. One handler at a time: a second registration replaces the
//     first, whose unregister then does nothing (U72's tab-dock.js).
//
// Every rule with a number in it is sheet-model.js's (classify, dragHeight,
// snapTarget, nearest, stepStop): this module only follows the pointer.
//
//   * Pointer events on the handle only (the tab alone has touch-action: none).
//     The first pointerId is tracked; a second pointer is ignored until the
//     first ends. setPointerCapture / releasePointerCapture are guarded (jsdom,
//     and an old engine, lack them).
//   * A TAP IS NOT HANDLED HERE. The tab's own click (and Enter or Space)
//     toggles the sheet. What this module does is swallow, in the capture
//     phase, exactly the one click that follows a drag (or a cancelled
//     gesture), so a drag never toggles; the next pointerdown disarms it, so a
//     drag whose click never came cannot eat a later tap.
//   * pointercancel and lostpointercapture settle to the nearest stop — never a
//     tap. Nor is a release past the slop on either axis (isTap): a sideways
//     swipe with no dock to take it moves nothing and toggles nothing.
//   * ArrowUp and ArrowDown on the handle step the stops (stepStop).
//   * NOTHING STAYS ON THE DOCUMENT BETWEEN GESTURES. The move, up and cancel
//     listeners are added on pointerdown and removed when the gesture settles,
//     so a long session never grows handlers (the Safari report's lesson);
//     detach() removes the three that live on the handle (pointerdown, keydown
//     and the click swallower). One animation frame at most is pending, and it
//     is cancelled when the gesture ends. No interval, no timeout, no observer.
import { classify, dragHeight, snapTarget, nearest, stepStop, isTap } from './sheet-model.js';

let dock = null;

export function setDockHandler(h) {
  if (!h || typeof h !== 'object' || ['begin', 'move', 'end'].some((k) => typeof h[k] !== 'function')) {
    throw new TypeError('setDockHandler: expects {begin, move, end} functions');
  }
  dock = h;
  return () => { if (dock === h) dock = null; };
}

// The registered dock handler, or null (a test reads it; the drag asks it at
// classification time).
export const dockHandler = () => dock;

function capture(el, id, on) {
  const fn = on ? el.setPointerCapture : el.releasePointerCapture;
  if (typeof fn !== 'function') return;
  try { fn.call(el, id); } catch { /* the pointer is gone, or capture is refused */ }
}

function call(name, fn, ...args) {
  try { return fn(...args); } catch (e) {
    console.error(`[web-chat] the sheet drag's ${name} failed`, e);
    return undefined;
  }
}

export function attachSheetDrag(handle, hooks) {
  if (!handle || typeof handle.addEventListener !== 'function') throw new TypeError('attachSheetDrag: expects an element');
  const need = ['stops', 'height', 'enabled', 'closed', 'onMove', 'onSettle'];
  if (!hooks || need.some((k) => typeof hooks[k] !== 'function')) {
    throw new TypeError(`attachSheetDrag: hooks must have ${need.join(', ')}`);
  }
  const doc = handle.ownerDocument;
  const win = doc.defaultView || globalThis;
  let g = null;           // the gesture in progress
  let swallow = false;    // the next click on the handle follows a drag: eat it

  const raf = (fn) => {
    const r = globalThis.requestAnimationFrame || win.requestAnimationFrame;
    if (typeof r === 'function') return r(fn);
    fn();
    return null;
  };
  const caf = (h) => {
    const c = globalThis.cancelAnimationFrame || win.cancelAnimationFrame;
    if (h !== null && typeof c === 'function') c(h);
  };

  function listen(on) {
    const m = on ? 'addEventListener' : 'removeEventListener';
    doc[m]('pointermove', onMove);
    doc[m]('pointerup', onUp);
    doc[m]('pointercancel', onCancel);
    handle[m]('lostpointercapture', onLost);
  }

  function onDown(e) {
    swallow = false;
    if (g) return;                                   // a second pointer: ignored
    if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) return;
    if (!call('enabled', hooks.enabled)) return;
    const stops = call('stops', hooks.stops) || { full: 0, half: null };
    const h0 = Number(call('height', hooks.height)) || 0;
    g = {
      id: e.pointerId, x0: e.clientX || 0, y0: e.clientY || 0, stops, start: h0, from: nearest(h0, stops),
      h: h0, axis: null, dock: null, frame: null, dx: 0, dy: 0, x: e.clientX || 0,
    };
    capture(handle, e.pointerId, true);
    listen(true);
  }

  function onMove(e) {
    if (!g || e.pointerId !== g.id) return;
    const dx = (e.clientX || 0) - g.x0;
    const dy = (e.clientY || 0) - g.y0;
    g.dx = dx;
    g.dy = dy;
    g.x = e.clientX || 0;
    if (!g.axis) {
      const closed = !!call('closed', hooks.closed);
      g.axis = classify({ dx, dy, dockable: !!dock, closed });
      if (g.axis === 'x') {
        g.dock = dock;
        call('dock begin', () => g.dock.begin({ x: g.x0, width: win.innerWidth }));
      }
    }
    if (g.axis === 'y') {
      g.h = dragHeight({ start: g.start, dy, stops: g.stops });
      if (g.frame === null) {
        const gesture = g;
        gesture.frame = raf(() => {
          gesture.frame = null;
          if (g === gesture) call('onMove', hooks.onMove, gesture.h);
        });
      }
    } else if (g.axis === 'x' && g.dock) {
      call('dock move', () => g.dock.move({ dx }));
    }
  }

  // The gesture ends: the listeners go, then it settles.
  function finish(cancelled) {
    const gesture = g;
    g = null;
    listen(false);
    caf(gesture.frame);
    gesture.frame = null;
    capture(handle, gesture.id, false);
    if (gesture.axis === 'y') {
      swallow = true;
      const to = cancelled ? nearest(gesture.h, gesture.stops)
        : snapTarget({ from: gesture.from, h: gesture.h, stops: gesture.stops });
      call('onSettle', hooks.onSettle, to, { from: gesture.from });
    } else if (gesture.axis === 'x') {
      swallow = true;
      if (gesture.dock) {
        call('dock end', () => gesture.dock.end({ dx: gesture.dx, x: gesture.x, width: win.innerWidth, cancelled }));
      }
    } else if (cancelled) {
      // Never a tap: the click a browser may still send is eaten, and the sheet
      // goes back to the stop it was nearest.
      swallow = true;
      call('onSettle', hooks.onSettle, nearest(gesture.h, gesture.stops), { from: gesture.from });
    } else if (!isTap(gesture.dx, gesture.dy)) {
      // Past the slop with no axis (a sideways swipe with nowhere to dock): it
      // moved nothing, and it is no tap either.
      swallow = true;
    }
  }

  function onUp(e) { if (g && e.pointerId === g.id) finish(false); }
  function onCancel(e) { if (g && e.pointerId === g.id) finish(true); }
  function onLost(e) { if (g && e.pointerId === g.id) finish(true); }

  function onClick(e) {
    if (!swallow) return;
    swallow = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onKey(e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!call('enabled', hooks.enabled)) return;
    e.preventDefault();
    const stops = call('stops', hooks.stops) || { full: 0, half: null };
    const h0 = Number(call('height', hooks.height)) || 0;
    const to = stepStop(h0, e.key === 'ArrowUp' ? 1 : -1, stops);
    call('onSettle', hooks.onSettle, to, { from: nearest(h0, stops) });
  }

  // The swallower first, in the capture phase, so it runs before any click
  // listener the handle's owner adds after attaching.
  handle.addEventListener('click', onClick, true);
  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('keydown', onKey);

  return function detach() {
    if (g) {
      const gesture = g;
      g = null;
      listen(false);
      caf(gesture.frame);
      capture(handle, gesture.id, false);
    }
    swallow = false;
    handle.removeEventListener('click', onClick, true);
    handle.removeEventListener('pointerdown', onDown);
    handle.removeEventListener('keydown', onKey);
  };
}
