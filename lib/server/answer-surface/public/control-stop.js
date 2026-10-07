// The control frame's STOP layout (spec §15.5, §15.2, §4.5 'The control frame'),
// loaded by answer.js for a `control` document whose layout is `stop`
// (./control-<layout>.js): one button that interrupts one conversation.
//
//   mount(rt) → { stop() }       rt is answer.js's runtime (U56), never copied
//
// THE DOCUMENT. GET /answer/control/interrupt?conversation_id=<c>&layout=stop
// &size=bar|panel|sheet&mode= (U81). Its nonce, minted for this action on this
// conversation, is the click token; <meta name="wc-control"> holds describe()'s
// {title, summary}, the title being the conversation's name. Both are read
// here and set with textContent only.
//
// THE RULES (§4.5): a stop keeps items 3-7 and 10 — the 300 ms pointer dwell,
// the 600 ms content cooldown, no default focus, isTrusted and
// navigator.userActivation before every POST, and the outbound messages only
// (size, done). It needs no visibility proof and no fit rule (items 1-2: a
// covered Stop can only end a turn, never run anything) and NEVER the popup:
// the user's way out works in one click in every browser. So the guard is
// rt.createGuard with proof and fit off — the same machine an ask's buttons
// use, never a copy.
//
// THE FLOW (§15.2 'What Esc does'):
//   idle          the state view's label: 'Interrupt' (the Esc path) or 'Stop
//                 after this step' (the hook halt); the title names the
//                 conversation and, while Claude waits on a prompt, says that
//                 Stop declines it.
//   a click       POST /answer/api/control/interrupt {conversation_id, mode:
//                 'now'} with X-WC-Answer → 'Interrupting…' (disabled).
//   confirmed     ONLY when the state view's last.outcome is 'interrupted' for
//                 this request (the mirror's confirmation, never the POST's
//                 answer) → 'Interrupted', and ONE wc-answer:done {id,
//                 outcome: 'interrupted'}.
//   3 s silence   'Stop after this step' (mode 'after-step', the hook halt),
//                 after a fresh content cooldown so a double click cannot take
//                 it. A request the server already sent down the hook path
//                 reads 'Stopping after this step…' and offers nothing more.
//   a refusal     its hint for HINT_MS ('rate_limited', 'not-busy', …), then
//                 the label again.
//
// THE OUTCOMES this layout posts, named once: STOP_OUTCOMES. Never a request
// id, never a path: done carries the outcome alone.
//
// THE SIZE. The frame reports the height of its slot: bar 22, panel 28,
// sheet 44 px (§15.5), from the document's `size`.

export const STOP_OUTCOMES = Object.freeze(['interrupted']);
export const CONFIRM_MS = 3000;
export const HINT_MS = 2500;
export const STATE_WAIT_MS = 20000;
export const SIZES = Object.freeze({ bar: 22, panel: 28, sheet: 44 });
export const LABELS = Object.freeze({
  now: 'Interrupt',
  afterStep: 'Stop after this step',
  interrupting: 'Interrupting…',
  halting: 'Stopping after this step…',
  interrupted: 'Interrupted',
  ended: 'Session ended',
});
// answer.js's own words for a control it cannot draw.
export const UNAVAILABLE = 'This control is not available here';
const KNOWN_LABELS = new Set([LABELS.now, LABELS.afterStep]);
const RETRY_MS = [1000, 2000, 5000, 10000];
const HINTS = Object.freeze({
  rate_limited: 'Just stopped — wait a moment',
  'not-busy': 'Claude is not working now',
  'no-path': 'Stop from the terminal (Esc)',
  unknown: 'This session is gone',
  stopped: 'web-chat is stopping',
  expired: 'This Stop expired — reopen the chat',
  offline: 'Could not reach web-chat',
});
const GATE_REFUSALS = new Set(['origin', 'site', 'type', 'nonce', 'remote']);

// describe()'s JSON, as the document carries it; text only.
export function readDescription(rt) {
  let d = null;
  try { d = JSON.parse(rt.meta('wc-control') || 'null'); } catch { d = null; }
  const text = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
  const out = { title: text(d && d.title), summary: text(d && d.summary), lines: [] };
  if (d && Array.isArray(d.lines)) out.lines = d.lines.filter((l) => typeof l === 'string').slice(0, 40).map((l) => text(l));
  return out;
}

export function mount(rt) {
  const { win, doc, main } = rt;
  const size = Object.prototype.hasOwnProperty.call(SIZES, rt.query.size) ? rt.query.size : 'bar';
  doc.documentElement.dataset.size = size;
  const cid = typeof rt.query.conversation_id === 'string' ? rt.query.conversation_id : '';
  // No conversation, or no nonce: nothing this frame could stop.
  if (!cid || !rt.nonce) {
    main.textContent = UNAVAILABLE;
    rt.post.size(SIZES[size], { force: true });
    return { stop() {} };
  }
  const desc = readDescription(rt);

  const box = doc.createElement('div');
  box.className = 'ct-stop';
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'ct-stop-btn';
  const glyph = doc.createElement('span');
  glyph.className = 'ct-stop-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  const label = doc.createElement('span');
  label.className = 'ct-stop-label';
  btn.append(glyph, label);
  box.append(btn);
  main.replaceChildren(box);

  let view = null;            // the state view
  let phase = 'idle';         // idle · sending · interrupting · fallback · halting · interrupted · ended · hint
  let hint = '';
  let requestId = null;       // the accepted request this frame is waiting on
  let confirmTimer = null;
  let hintTimer = null;
  let stopped = false;
  let doneSent = false;

  const clearTimer = (h) => { if (h !== null) win.clearTimeout(h); return null; };

  function paint() {
    if (stopped) return;
    let words;
    switch (phase) {
      case 'sending':
      case 'interrupting': words = LABELS.interrupting; break;
      case 'fallback': words = LABELS.afterStep; break;
      case 'halting': words = LABELS.halting; break;
      case 'interrupted': words = LABELS.interrupted; break;
      case 'ended': words = LABELS.ended; break;
      case 'hint': words = hint; break;
      default: words = view && KNOWN_LABELS.has(view.label) ? view.label : LABELS.now;
    }
    label.textContent = words;
    const live = phase === 'idle' || phase === 'fallback';
    btn.setAttribute('aria-disabled', String(!live));
    box.dataset.phase = phase;
    const who = desc.title ? ` — ${desc.title}` : '';
    let title = `${phase === 'fallback' ? LABELS.afterStep : (live ? words : LABELS.now)}${who}`;
    if (view && view.waiting === true && live) title += '. Claude is waiting on a prompt: Stop declines it, as Esc in the terminal does';
    btn.title = title;
    btn.setAttribute('aria-label', title);
  }

  const guard = rt.createGuard({ box, subjects: () => [], proof: false, fit: false, measureDoc: false, onChange: paint });

  function showHint(code) {
    hint = HINTS[code] || HINTS.offline;
    phase = 'hint';
    paint();
    hintTimer = clearTimer(hintTimer);
    hintTimer = win.setTimeout(() => {
      hintTimer = null;
      if (phase !== 'hint') return;
      phase = 'idle';
      paint();
    }, HINT_MS);
  }

  function confirmed() {
    if (doneSent) return;
    doneSent = true;
    confirmTimer = clearTimer(confirmTimer);
    phase = 'interrupted';
    paint();
    rt.post.done(rt.id, STOP_OUTCOMES[0]);
  }

  // The mirror's confirmation, read off the state view.
  function onView(next) {
    view = next;
    const last = view && view.last;
    if (requestId && last && last.request_id === requestId) {
      if (last.outcome === 'interrupted') { confirmed(); return; }
      if (last.outcome === 'ended') {
        confirmTimer = clearTimer(confirmTimer);
        phase = 'ended';
      }
    }
    paint();
  }

  async function send(mode) {
    phase = 'sending';
    paint();
    let r = null;
    try {
      r = await rt.api(`interrupt?device=${encodeURIComponent(rt.device)}`, { method: 'POST', body: { conversation_id: cid, mode } });
    } catch { r = null; }
    if (stopped) return;
    const body = r && r.body && typeof r.body === 'object' ? r.body : null;
    if (r && r.ok && body && body.ok === true && typeof body.request_id === 'string') {
      requestId = body.request_id;
      if (mode === 'now' && body.via !== 'hook') {
        phase = 'interrupting';
        confirmTimer = clearTimer(confirmTimer);
        confirmTimer = win.setTimeout(() => {
          confirmTimer = null;
          if (stopped || phase !== 'interrupting') return;
          // No confirmation within 3 s: offer the hook halt, behind a fresh
          // cooldown (a second click of the first must not take it).
          phase = 'fallback';
          guard.content();
          paint();
        }, CONFIRM_MS);
      } else {
        phase = 'halting';
      }
      // The view may already say so.
      if (view) onView(view); else paint();
      return;
    }
    const code = body && typeof body.refused === 'string' ? body.refused : null;
    if (r && r.status === 403 && code && GATE_REFUSALS.has(code)) showHint('expired');
    else showHint(code || 'offline');
  }

  function onClick(e) {
    const hit = e.target && e.target.closest ? e.target.closest('button.ct-stop-btn') : null;
    if (!hit || stopped) return;
    if (phase !== 'idle' && phase !== 'fallback') return;
    // Items 3-5 and 7 at the moment of the click; never a popup.
    if (!guard.allows(e, { acting: false })) return;
    send(phase === 'fallback' ? 'after-step' : 'now');
  }
  box.addEventListener('click', onClick);

  // The state view, long-polled until its version changes.
  const statePath = (v) => {
    let p = `state?action=interrupt&conversation_id=${encodeURIComponent(cid)}`;
    if (v !== null && v !== undefined) p += `&v=${encodeURIComponent(v)}&wait=${STATE_WAIT_MS}`;
    return p;
  };
  async function loop() {
    let failures = 0;
    while (!stopped) {
      let r;
      try { r = await rt.api(statePath(view ? view.v : null)); } catch { r = null; }
      if (stopped) return;
      if (r && r.status === 200 && r.body && typeof r.body === 'object') {
        failures = 0;
        const changed = !view || r.body.v !== view.v;
        if (changed) { onView(r.body); continue; }
        // The long-poll ran out (or the server could not hold it): a pause, so
        // a server answering at once is never polled in a tight loop.
        await new Promise((res) => win.setTimeout(res, RETRY_MS[0]));
        continue;
      }
      if (r && r.status === 403) return;          // this page's nonce is gone; the chrome remounts
      await new Promise((res) => win.setTimeout(res, RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]));
      failures += 1;
    }
  }

  paint();
  rt.post.size(SIZES[size], { force: true });
  const running = loop();
  return {
    running,
    get phase() { return phase; },
    stop() {
      stopped = true;
      confirmTimer = clearTimer(confirmTimer);
      hintTimer = clearTimer(hintTimer);
      guard.destroy();
      box.removeEventListener('click', onClick);
    },
  };
}
