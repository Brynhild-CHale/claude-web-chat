// The answer frame's guards (spec §4.5 items 1-5), as a pure state machine:
// no DOM, no timers, no globals. answer.js feeds it what the browser reports
// (IntersectionObserver v2 entries, the fit measurements, pointer and focus
// arrivals, content changes) and asks it, at the moment of a click, whether
// that click may answer. U85's control layouts reuse the same machine through
// answer.js's createGuard, never a copy.
//
//   createGate({ now, proof = true, fit = true })
//     proof   the visibility proof applies (Chromium's IntersectionObserver v2;
//             the stop layout and a top-level page window do without it)
//     fit     the fit rule applies (item 2; the stop layout and the scrolling
//             page layout do without it)
//   → { observe(entry), reset(), setFit(ok), pointerEnter(), pointerLeave(),
//       content(), focusArrived(how), blurred(), state(), wakeIn(),
//       allows({acting, keyboard}) }
//
// THE RULES, each pinned by test/answer-gate.test.js:
//   1. Visibility: answering enables only after `intersectionRatio === 1 &&
//      isVisible` has held for VISIBLE_MS on ONE container holding the subject
//      and the buttons; any other entry disables at once.
//   2. Fit: the document fits its viewport, no subject element is clipped or
//      ellipsized, and the request is `complete`. Without fit, ACTING answers
//      (allow, answer, approve) stay disabled and the layout offers Review ›.
//   3. Pointer dwell: a pointer click counts only DWELL_MS after the pointer
//      entered the frame.
//   4. Content cooldown: for COOLDOWN_MS after a new ask or version, a
//      visibilitychange back to visible and the window regaining focus, every
//      click is ignored.
//   5. No default focus: a keyboard activation (Enter, Space) counts only when
//      focus arrived by Tab or by the pointer inside the frame.

export const VISIBLE_MS = 500;
export const DWELL_MS = 300;
export const COOLDOWN_MS = 600;

// Why answering is off, in the words the frame shows.
export const COVERED = 'Covered or faded: make this prompt fully visible to answer, or answer in the terminal';

// The fit rule (item 2) over measurements answer.js takes:
//   doc       { scrollWidth, scrollHeight, innerWidth, innerHeight } | null
//   subjects  [{ scrollWidth, clientWidth, scrollHeight, clientHeight }]
//   complete  the display view's flag: no projection cap cut a field
export function fits({ doc = null, subjects = [], complete = false } = {}) {
  if (complete !== true) return false;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  if (doc && (n(doc.scrollWidth) > n(doc.innerWidth) || n(doc.scrollHeight) > n(doc.innerHeight))) return false;
  for (const s of subjects || []) {
    if (!s) continue;
    if (n(s.scrollWidth) > n(s.clientWidth) || n(s.scrollHeight) > n(s.clientHeight)) return false;
  }
  return true;
}

export function createGate({ now = () => Date.now(), proof = true, fit = true } = {}) {
  if (typeof now !== 'function') throw new TypeError('createGate: now must be a function');
  let visibleSince = null;     // when ratio 1 + isVisible began; null while not proven
  let seen = false;            // any entry yet (before the first, the frame is settling)
  let covered = false;         // the last entry disabled answering
  let fitOk = !fit;            // unknown until measured, so off where the rule applies
  let pointerAt = null;        // when the pointer entered the frame
  let cooldownUntil = 0;
  let keyFocus = false;        // focus arrived by Tab or by the pointer

  function visible(t = now()) {
    if (!proof) return true;
    return visibleSince !== null && t - visibleSince >= VISIBLE_MS;
  }

  const gate = {
    // One IntersectionObserver entry for the container.
    observe(entry) {
      seen = true;
      const ok = !!entry && entry.intersectionRatio === 1 && entry.isVisible === true;
      if (ok) {
        if (visibleSince === null) visibleSince = now();
        covered = false;
      } else {
        visibleSince = null;
        covered = true;
      }
      return gate.state();
    },
    // A new container to prove: nothing is proven yet, nothing covers it yet.
    reset() { visibleSince = null; seen = false; covered = false; return gate.state(); },
    setFit(ok) { fitOk = !fit || ok === true; return gate.state(); },
    pointerEnter() { if (pointerAt === null) pointerAt = now(); },
    pointerLeave() { pointerAt = null; },
    // A new ask or version, a visibilitychange to visible, the window's focus.
    content() { cooldownUntil = now() + COOLDOWN_MS; },
    focusArrived(how) { keyFocus = how === 'tab' || how === 'pointer'; },
    blurred() { keyFocus = false; },

    // { visible, fit, enabled, acting, reason }: `enabled` is any answering
    // control, `acting` the ones the fit rule also gates. `reason` says why
    // not: 'covered' (an entry disabled it), 'settling' (not proven long
    // enough yet), 'fit' (only the acting ones are off), or null.
    state() {
      const t = now();
      const vis = visible(t);
      let reason = null;
      if (!vis) reason = covered ? 'covered' : 'settling';
      else if (!fitOk) reason = 'fit';
      return { visible: vis, fit: fitOk, enabled: vis, acting: vis && fitOk, reason, seen: !proof || seen };
    },
    // Milliseconds until the state changes by itself (the visibility proof
    // completing, or the cooldown ending), or null: the frame redraws then.
    wakeIn() {
      const t = now();
      let next = null;
      if (proof && visibleSince !== null && t - visibleSince < VISIBLE_MS) next = VISIBLE_MS - (t - visibleSince);
      if (cooldownUntil > t) next = next === null ? cooldownUntil - t : Math.min(next, cooldownUntil - t);
      return next;
    },
    // May this click answer? `acting` for allow/answer/approve; `keyboard` for
    // an activation with no pointer (a click event whose detail is 0).
    allows({ acting = true, keyboard = false } = {}) {
      const t = now();
      if (!visible(t)) return false;
      if (acting && !fitOk) return false;
      if (t < cooldownUntil) return false;
      if (keyboard) return keyFocus;
      return pointerAt !== null && t - pointerAt >= DWELL_MS;
    },
  };
  return gate;
}
