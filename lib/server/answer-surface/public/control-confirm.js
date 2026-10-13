// The control frame's CONFIRM layout (spec §15.5, §4.5 'The control frame'),
// loaded by answer.js for a `control` document whose layout is `confirm`
// (./control-<layout>.js): a summary, ONE action button and Keep — for a
// restore, an undo, a fork, and in tranche 6 the mod's controls.
//
//   mount(rt) → { stop() }       rt is answer.js's runtime (U56), never copied
//
// THE DOCUMENT. GET /answer/control/<action>?<target params>&layout=confirm
// &size=&mode= (U81). <meta name="wc-control"> holds the row's describe(),
// {title, summary, lines?}, computed from server state only: the title names
// the action button, the summary and the lines are the subject. All of it is
// set with textContent.
//
// THE POST. POST /answer/api/control/<action>?device= with X-WC-Answer and,
// as its body, the document's own target params: every query key but the
// answer surface's (layout, mode, size, device, v, wait, action). So a row's
// `fields` are exactly the query keys its document is minted with — the one
// contract between U85 and the rows (U83, U84, U89, U93) and their callers
// (U86): the frame never maps one name onto another.
//
// THE RULES (§4.5): EVERY one, as U56's runtime applies them to the ask's card
// (rt.createGuard, never a copy): the visibility proof in Chromium over ONE
// container holding the summary and the buttons (500 ms of ratio 1 and
// isVisible), the fit rule with Review ›, the 300 ms dwell, the 600 ms
// cooldown, no default focus, isTrusted and userActivation before the POST.
// Without IntersectionObserver v2 (Firefox, Safari) the action button is
// `Review & confirm ↗`, opening this document's confirm layout in a popup
// (rt.popup) — a top-level window no pane can overlay, where the proof and the
// document-fit rule do not apply (it scrolls), as the ask's page layout.
//
// THE RESULT stays inside the frame (notes-B Q8 (a)): restore and undo show
// their counts and any residual paths ('Undo puts everything back'); a fork
// shows `claude --resume <id>` with Copy (navigator.clipboard.writeText where
// the iframe allows clipboard-write, else the text selected for ⌘C); any other
// action's ok answer (the mod's rows, tranche 6: task-stop, resume) is 'done',
// showing the answer's own `said` line (server text, at most SAID_MAX
// characters, set with textContent) or 'Done' (ruling F6, Q-B3 (a)). Then ONE
// wc-answer:done {id, outcome, result?} with an outcome of CONFIRM_OUTCOMES
// and, for a restore or an undo, its counts — never a restore id, never a
// command, never a path. A popup's result comes back to the frame that opened
// it by postMessage from that window, on this origin only (both sides check
// the source window and the origin), so the frame shows it and posts done.
//
// Keep acts on nothing and posts nothing: the frame says nothing changed; the
// chrome's own dialog closes by its own controls.

import { COVERED } from './answer-gate.js';
import { readDescription } from './control-stop.js';

export const CONFIRM_OUTCOMES = Object.freeze(['restored', 'failed', 'undone', 'forked', 'refused', 'done']);
export const SAID_MAX = 120;
export const POPUP_LABEL = 'Review & confirm ↗';
export const RESULT_MESSAGE = 'wc-control:result';
const SURFACE_KEYS = new Set(['layout', 'mode', 'size', 'device', 'v', 'wait', 'action']);
const FIELD_RE = /^[a-z][a-z0-9_]{0,31}$/;
const COMMAND_RE = /^claude --resume [A-Za-z0-9-]{1,64}$/;
const COUNT_KEYS = Object.freeze([['rewritten', 'rewritten'], ['recreated', 're-created'], ['deleted', 'deleted'], ['not_covered', 'not covered']]);
const RESIDUAL_MAX = 20;
const EXPIRED = 'This confirm has expired: open it again from the chat';
const GATE_REFUSALS = new Set(['origin', 'site', 'type', 'nonce', 'remote']);

// The POST body: the document's target params (never the surface's own keys).
export function bodyOf(query) {
  const out = {};
  for (const [k, v] of Object.entries(query || {})) {
    if (SURFACE_KEYS.has(k) || !FIELD_RE.test(k) || typeof v !== 'string') continue;
    out[k] = v;
  }
  return out;
}

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const saidOf = (v) => (typeof v === 'string' && v ? v.slice(0, SAID_MAX) : '');

// What an action's answer means, and what the frame shows for it. Pure.
export function readAnswer(action, status, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const counts = {};
  if (b.counts && typeof b.counts === 'object') {
    for (const [k] of COUNT_KEYS) { const n = count(b.counts[k]); if (n !== null) counts[k] = n; }
  }
  const residual = Array.isArray(b.residual)
    ? b.residual.filter((r) => r && typeof r.path === 'string').slice(0, RESIDUAL_MAX)
      .map((r) => ({ path: r.path.slice(0, 300), reason: typeof r.reason === 'string' ? r.reason.slice(0, 60) : '' }))
    : [];
  const show = { counts, residual, headMoved: b.headMoved === true, command: null, hint: '', said: '' };
  let outcome;
  if (status >= 200 && status < 300 && b.ok === true) {
    if (action === 'fork') {
      outcome = 'forked';
      if (typeof b.command === 'string' && COMMAND_RE.test(b.command)) show.command = b.command;
    } else if (action === 'undo') {
      outcome = 'undone';
    } else if (action === 'restore') {
      outcome = 'restored';
    } else {
      outcome = 'done';
      show.said = saidOf(b.said);
    }
  } else if (residual.length || Object.keys(counts).length) {
    outcome = 'failed';
  } else {
    outcome = 'refused';
    const code = typeof b.refused === 'string' ? b.refused : '';
    if (status === 403 && GATE_REFUSALS.has(code)) show.hint = EXPIRED;
    else show.hint = typeof b.hint === 'string' && b.hint ? b.hint.slice(0, 300) : 'Refused — nothing was changed';
  }
  // done's result: counts only (never an id, a command or a path).
  const result = {};
  for (const [k] of COUNT_KEYS) if (counts[k] !== undefined) result[k] = counts[k];
  if (outcome === 'failed' || residual.length) result.residual = residual.length;
  return { outcome, show, result: Object.keys(result).length ? result : undefined };
}

export function mount(rt) {
  const { win, doc, main } = rt;
  // A top-level window (the popup) cannot be overlaid; framed, every rule
  // applies. rt.framed is answer.js's own test: a parent that is not itself.
  const framed = rt.framed === true;
  const top = !framed;
  const needsProof = framed;
  const popupOnly = needsProof && !rt.proof;
  const desc = readDescription(rt);
  const action = rt.rest;
  if (rt.query.size) doc.documentElement.dataset.size = String(rt.query.size).replace(/[^a-z-]/g, '').slice(0, 16);

  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const root = el('div', 'ct');
  root.dataset.layout = 'confirm';
  const box = el('div', 'ct-box');
  const title = el('p', 'ct-title', desc.title || 'Confirm');
  const summary = el('p', 'ct-summary', desc.summary);
  summary.hidden = !desc.summary;
  const lines = el('ul', 'ct-lines');
  for (const l of desc.lines) lines.append(el('li', 'ct-line', l));
  lines.hidden = !desc.lines.length;
  const guardLine = el('p', 'ct-guard');
  guardLine.hidden = true;
  guardLine.setAttribute('role', 'status');
  const problem = el('p', 'ct-problem');
  problem.hidden = true;
  problem.setAttribute('role', 'status');
  const actions = el('div', 'ct-actions');
  const act = el('button', 'ct-btn ct-act', popupOnly ? POPUP_LABEL : (desc.title || 'Confirm'));
  act.type = 'button';
  if (popupOnly) act.title = 'Confirm in a window of its own';
  const review = el('button', 'ct-btn ct-review', 'Review ›');
  review.type = 'button';
  review.title = 'Show all of it in a window of its own';
  const keep = el('button', 'ct-btn ct-keep', 'Keep');
  keep.type = 'button';
  keep.title = 'Change nothing';
  actions.append(act, review, keep);
  box.append(title, summary, lines, guardLine, problem, actions);
  const result = el('div', 'ct-result');
  result.hidden = true;
  result.setAttribute('role', 'status');
  root.append(box, result);
  main.replaceChildren(root);

  let phase = 'ready';       // ready · busy · popup · kept · done
  let stopped = false;
  let popupWin = null;

  function sendSize() {
    const r = main.getBoundingClientRect();
    rt.post.size(r && r.height ? r.height : main.scrollHeight);
  }

  function paint(st) {
    if (stopped) return;
    root.dataset.fit = st.fit ? '1' : '0';
    root.dataset.guard = st.reason || 'ok';
    root.dataset.phase = phase;
    const live = phase === 'ready' || phase === 'popup';
    const on = popupOnly ? live : (live && st.enabled && st.fit);
    act.setAttribute('aria-disabled', String(!on));
    // Review › only when the summary does not fit the frame (item 2).
    review.hidden = !framed || popupOnly || st.fit || !live;
    keep.setAttribute('aria-disabled', String(!live));
    const covered = st.reason === 'covered';
    guardLine.textContent = covered ? COVERED : '';
    guardLine.hidden = !covered;
    sendSize();
  }

  const guard = rt.createGuard({
    box,
    subjects: () => [title, summary, lines],
    proof: needsProof && rt.proof,
    fit: true,
    measureDoc: framed,
    complete: () => true,
    onChange: paint,
  });

  function say(words) {
    problem.textContent = words;
    problem.hidden = !words;
    paint(guard.state());
  }

  // ── the result, inside the frame ──────────────────────────────────────────
  function copyCommand(code, note, e) {
    if (!e || e.isTrusted !== true) return;
    const text = code.textContent;
    const select = () => {
      try {
        const range = doc.createRange();
        range.selectNodeContents(code);
        const sel = win.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch { /* nothing to select with */ }
      note.textContent = 'Selected — press ⌘C (Ctrl+C) to copy';
    };
    const clip = win.navigator && win.navigator.clipboard;
    let allowed = true;
    try {
      const policy = doc.permissionsPolicy || doc.featurePolicy;
      if (policy && typeof policy.allowsFeature === 'function') allowed = policy.allowsFeature('clipboard-write');
    } catch { allowed = true; }
    if (!clip || typeof clip.writeText !== 'function' || !allowed) { select(); return; }
    Promise.resolve().then(() => clip.writeText(text)).then(() => { note.textContent = 'Copied'; }, select);
  }

  function showResult(outcome, show) {
    result.replaceChildren();
    const line = (cls, text) => { const p = el('p', cls, text); result.append(p); return p; };
    const counted = COUNT_KEYS.filter(([k]) => show.counts[k] !== undefined).map(([k, words]) => `${show.counts[k]} ${words}`);
    if (outcome === 'forked') {
      line('ct-outcome', 'Forked');
      if (show.command) {
        line('ct-text', 'Paste this into a terminal to open the fork:');
        const row = el('div', 'ct-command');
        const code = el('code', 'ct-code', show.command);
        const copy = el('button', 'ct-btn ct-copy', 'Copy');
        copy.type = 'button';
        const note = el('span', 'ct-note');
        note.setAttribute('role', 'status');
        copy.addEventListener('click', (e) => copyCommand(code, note, e));
        row.append(code, copy, note);
        result.append(row);
      } else {
        line('ct-text', 'The fork did not answer its command: fork in the terminal.');
      }
    } else if (outcome === 'done') {
      line('ct-outcome', show.said || 'Done');
    } else if (outcome === 'restored' || outcome === 'undone' || outcome === 'failed') {
      const head = { restored: 'Restored', undone: 'Undone', failed: 'Not everything was put back' }[outcome];
      line('ct-outcome', counted.length ? `${head}: ${counted.join(' · ')}` : head);
      if (show.headMoved) line('ct-text', 'HEAD has moved since that turn');
      if (show.residual.length) {
        line('ct-text', 'Left as they are:');
        const ul = el('ul', 'ct-residual');
        for (const r of show.residual) ul.append(el('li', 'ct-line', r.reason ? `${r.path} (${r.reason})` : r.path));
        result.append(ul);
        line('ct-text', 'Undo puts everything back');
      }
    } else {
      line('ct-outcome', 'Not done');
      line('ct-text', show.hint || 'Refused — nothing was changed');
    }
    box.hidden = true;
    result.hidden = false;
    sendSize();
  }

  function finish(outcome, show, res) {
    if (phase === 'done') return;
    phase = 'done';
    showResult(outcome, show);
    rt.post.done(rt.id, outcome, res);
    // A popup hands its result back to the frame that opened it.
    if (top && win.opener && win.opener !== win) {
      try { win.opener.postMessage({ type: RESULT_MESSAGE, outcome, show, result: res }, win.location.origin); } catch { /* the opener is gone */ }
    }
  }

  async function confirm() {
    phase = 'busy';
    say('');
    let r = null;
    try {
      r = await rt.api(`${encodeURIComponent(action)}?device=${encodeURIComponent(rt.device)}`, { method: 'POST', body: bodyOf(rt.query) });
    } catch { r = null; }
    if (stopped) return;
    if (!r || (r.status !== 200 && !r.body)) {
      phase = 'ready';
      say('Could not reach web-chat — try again');
      return;
    }
    const read = readAnswer(action, r.status, r.body);
    finish(read.outcome, read.show, read.result);
  }

  function openPopup() {
    popupWin = rt.popup('confirm');
    phase = 'popup';
    say('Continue in the window that opened');
  }

  // A popup's result, from the window this frame opened, on this origin only.
  function onMessage(e) {
    if (!popupWin || e.source !== popupWin || e.origin !== win.location.origin) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.type !== RESULT_MESSAGE || !CONFIRM_OUTCOMES.includes(d.outcome)) return;
    const s = d.show && typeof d.show === 'object' ? d.show : {};
    const show = { counts: {}, residual: [], headMoved: false, command: null, hint: '', said: '' };
    for (const [k] of COUNT_KEYS) { const n = count(s.counts && s.counts[k]); if (n !== null) show.counts[k] = n; }
    show.residual = Array.isArray(s.residual) ? s.residual.filter((x) => x && typeof x.path === 'string').slice(0, RESIDUAL_MAX)
      .map((x) => ({ path: x.path.slice(0, 300), reason: typeof x.reason === 'string' ? x.reason.slice(0, 60) : '' })) : [];
    show.headMoved = s.headMoved === true;
    show.command = typeof s.command === 'string' && COMMAND_RE.test(s.command) ? s.command : null;
    show.hint = typeof s.hint === 'string' ? s.hint.slice(0, 300) : '';
    show.said = d.outcome === 'done' ? saidOf(s.said) : '';
    const res = {};
    for (const [k] of COUNT_KEYS) if (show.counts[k] !== undefined) res[k] = show.counts[k];
    if (d.outcome === 'failed' || show.residual.length) res.residual = show.residual.length;
    finish(d.outcome, show, Object.keys(res).length ? res : undefined);
  }
  win.addEventListener('message', onMessage);

  function onClick(e) {
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!b || stopped || !box.contains(b)) return;
    if (b === keep) {
      if (e.isTrusted !== true || (phase !== 'ready' && phase !== 'popup')) return;
      phase = 'kept';
      actions.hidden = true;
      say('Kept — nothing was changed');
      return;
    }
    if (b === review || (b === act && popupOnly)) {
      if (e.isTrusted !== true || (phase !== 'ready' && phase !== 'popup')) return;
      openPopup();
      return;
    }
    if (b !== act || phase !== 'ready') return;
    // Items 1-5 and 7, at the moment of the click.
    if (!guard.allows(e, { acting: true })) return;
    confirm();
  }
  box.addEventListener('click', onClick);

  paint(guard.state());
  return {
    get phase() { return phase; },
    stop() {
      stopped = true;
      guard.destroy();
      box.removeEventListener('click', onClick);
      win.removeEventListener('message', onMessage);
    },
  };
}
