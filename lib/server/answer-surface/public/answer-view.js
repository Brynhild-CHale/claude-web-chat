// The answer frame's view (spec §4.4, §4.5's layouts): one ask's display view,
// drawn into the frame's document. It builds DOM and nothing else — no fetch,
// no timers, no guards; answer.js owns those and asks this module, at a click,
// which decision a control stands for.
//
//   renderAsk(doc, view, { layout, popup }) →
//     { root, box, subjects, controls, decisionOf(btn), problem(text), mask }
//
//   root       the element answer.js puts in <body>
//   box        the ONE container holding the subject and the buttons, which the
//              visibility proof observes (§4.5 item 1: never the buttons alone)
//   subjects   the elements the fit rule measures (the subject, the code boxes)
//   controls   every answering control: [{ el, act, acting }] where act is
//              'decide' (a POST), 'chat' (ask the chrome to open the chat),
//              'review' (the card, or the page popup) or 'popup'
//   decisionOf(btn) → the §4.2 decision a 'decide' control stands for, or null
//              (a question with an unanswered part: the view says so itself)
//
// EVERYTHING IS SET WITH textContent. The one innerHTML is a plan's HTML, the
// core markdown engine's output on the daemon (escaped there), under the
// frame's `script-src 'self'`. A subject holding `<img src=x onerror=…>` is
// four words of text.
//
// MASKED TEXT IS MARKED WHERE IT IS SHOWN (ruling A3 (a) with the maintainer's
// note): every mark the redactor left (a `‹…›` span) is wrapped in a visible
// <mark class="aw-mask">, in every layout, so a masked option is never taken
// for its real text. A question is answered by INDEX (the picks), never by the
// displayed text, so two texts that mask alike cannot be confused.

const OUTCOME_WORDS = Object.freeze({
  allowed: 'Allowed',
  denied: 'Denied',
  answered: 'Answered',
  declined: 'Declined',
  approved: 'Plan approved',
  rejected: 'Sent back to planning',
  terminal: 'Answered in the terminal',
  expired: 'No longer waiting — answer in the terminal',
  superseded: 'Replaced by a newer prompt',
});
export const WHY_NOT_WORDS = Object.freeze({
  'no-hook': 'Answer in the terminal',
  'remote-off': 'Answer in the terminal',
  'too-long': 'Too long to show here — answer in the terminal',
});
export const MASKED_LINE = 'Contains masked values — the terminal shows them in full';
export const POPUP_LABEL = 'Review & answer ↗';
const KIND_WORD = { permission: 'Permission', question: 'Question', plan: 'Plan' };

// The words for a view that cannot be answered here, or null.
export function whyNotWords(view) {
  if (!view || typeof view !== 'object') return 'This prompt is no longer waiting';
  if (view.why_not === 'resolved' || (view.state && view.state !== 'pending')) {
    return OUTCOME_WORDS[view.outcome] || 'This prompt is no longer waiting';
  }
  if (view.why_not) return WHY_NOT_WORDS[view.why_not] || 'Answer in the terminal';
  if (view.can_answer !== true) return 'Answer in the terminal';
  return null;
}
export const outcomeWords = (outcome) => OUTCOME_WORDS[outcome] || null;

const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

function make(doc) {
  return (tag, cls, content) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (content !== undefined && content !== null) e.textContent = content;
    return e;
  };
}

// Wrap every redaction mark under `node` in a visible <mark>. A mark is a
// `‹`…`›` span on one line (the redactor's masks, withheld and partial-line
// marks; its spelling is lib/core/redact.js's alone). Returns how many.
const MARK = /‹[^‹›\n]{1,96}›/g;
export function markMasks(doc, node) {
  let count = 0;
  const texts = [];
  const walker = doc.createTreeWalker(node, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentNode && n.parentNode.nodeName === 'MARK') continue;
    MARK.lastIndex = 0;
    if (MARK.test(n.nodeValue)) texts.push(n);
  }
  for (const n of texts) {
    const s = n.nodeValue;
    const frag = doc.createDocumentFragment();
    let at = 0;
    MARK.lastIndex = 0;
    for (let m = MARK.exec(s); m; m = MARK.exec(s)) {
      if (m.index > at) frag.append(doc.createTextNode(s.slice(at, m.index)));
      const mk = doc.createElement('mark');
      mk.className = 'aw-mask';
      mk.title = 'Masked here; the terminal shows the real text';
      mk.textContent = m[0];
      frag.append(mk);
      at = m.index + m[0].length;
      count += 1;
    }
    if (at < s.length) frag.append(doc.createTextNode(s.slice(at)));
    const holder = n.parentNode;
    holder.replaceChild(frag, n);
    if (holder.classList) holder.classList.add('aw-has-mask');
  }
  return count;
}

export function renderAsk(doc, view, { layout = 'card', popup = false } = {}) {
  const el = make(doc);
  const root = el('div', 'aw');
  root.dataset.layout = layout;
  root.dataset.kind = view && view.kind ? view.kind : 'unknown';
  const box = el('div', 'aw-box');
  root.append(box);
  const controls = [];
  const subjects = [];
  const decisions = new Map();     // button → () => decision | null
  const problem = el('p', 'aw-problem');
  problem.hidden = true;
  problem.setAttribute('role', 'status');

  const button = (cls, label, { act, acting = false, decide = null, title = null } = {}) => {
    const b = el('button', `aw-btn ${cls}`, label);
    b.type = 'button';
    if (title) b.title = title;
    if (act) {
      b.dataset.act = act;
      controls.push({ el: b, act, acting });
      if (decide) decisions.set(b, decide);
    }
    return b;
  };
  const actions = (...nodes) => {
    const row = el('div', 'aw-actions');
    row.append(...nodes.filter(Boolean));
    return row;
  };
  const popupButton = () => button('aw-popup', POPUP_LABEL, { act: 'popup', title: 'Answer in a window of its own' });

  const blocked = whyNotWords(view);
  const kind = view && view.kind;
  const bar = layout === 'bar';
  // A frame without IntersectionObserver v2 answers through the popup (item 6):
  // its answering buttons are one `Review & answer ↗`.
  const viaPopup = popup === true;

  if (bar) {
    const subject = el('span', 'aw-subject', text(view && view.subject) || text(view && view.tool_name));
    if (blocked) {
      box.append(el('span', 'aw-status', blocked));
    } else if (kind === 'permission') {
      subjects.push(subject);
      box.append(subject);
      if (viaPopup) {
        box.append(popupButton());
      } else {
        box.append(
          button('aw-allow', 'Allow', { act: 'decide', acting: true, decide: () => ({ behavior: 'allow' }) }),
          button('aw-deny', 'Deny', { act: 'decide', decide: () => ({ behavior: 'deny' }) }),
        );
        // Shown instead of Allow and Deny when the subject does not fit (item 2).
        const review = button('aw-review', 'Review ›', { act: 'chat', title: 'Read the whole request in the chat' });
        box.append(review);
      }
    } else {
      // A question or a plan is answered in the chat's card (deviation 14).
      box.append(button('aw-answer', 'Answer ›', { act: 'chat', title: 'Answer in the chat' }));
    }
    markMasks(doc, root);
    return finish();
  }

  // ── card, sheet, page ──
  if (layout === 'page') {
    box.append(el('h1', 'aw-title', `Claude is waiting · ${KIND_WORD[kind] || 'Prompt'}${view && view.tool_name && kind === 'permission' ? ` · ${view.tool_name}` : ''}`));
  }
  if (view && view.agent && view.agent.type) {
    box.append(el('p', 'aw-agent', `Asked by the ${text(view.agent.type)} agent`));
  }

  if (kind === 'permission') {
    const p = (view.detail && view.detail.permission) || {};
    const fields = Array.isArray(p.fields) ? p.fields : [];
    box.append(el('p', 'aw-tool', text(view.tool_name)));
    if (!fields.length) {
      const pre = el('pre', 'aw-code');
      pre.append(el('code', null, text(view.subject)));
      subjects.push(pre);
      box.append(pre);
    }
    for (const f of fields) {
      const row = el('div', 'aw-field');
      row.append(el('div', 'aw-fname', text(f && f.name)));
      const pre = el('pre', 'aw-code');
      pre.append(el('code', null, text(f && f.value)));
      subjects.push(pre);
      row.append(pre);
      box.append(row);
    }
  } else if (kind === 'question') {
    drawQuestions();
  } else if (kind === 'plan') {
    drawPlan();
  } else {
    box.append(el('p', 'aw-text', text(view && view.subject)));
  }
  if (view && view.masked) box.append(el('p', 'aw-masked', MASKED_LINE));

  if (blocked) {
    box.append(el('p', 'aw-status', blocked));
  } else if (viaPopup) {
    box.append(actions(popupButton()));
  } else if (kind === 'permission') {
    const note = el('input', 'aw-note');
    note.type = 'text';
    note.maxLength = 2000;
    note.placeholder = 'Note for Claude with Deny (optional)';
    note.setAttribute('aria-label', 'Note for Claude with Deny (optional)');
    box.append(
      actions(
        button('aw-allow', 'Allow once', { act: 'decide', acting: true, decide: () => ({ behavior: 'allow' }) }),
        button('aw-deny', 'Deny', {
          act: 'decide',
          decide: () => {
            const m = note.value.trim();
            return m ? { behavior: 'deny', message: m } : { behavior: 'deny' };
          },
        }),
        terminalButton(),
        reviewButton(),
      ),
      note,
    );
  } else if (kind === 'question' || kind === 'plan') {
    // the controls were drawn with the content
  } else {
    box.append(actions(terminalButton()));
  }
  box.append(problem);
  markMasks(doc, root);
  return finish();

  // ── parts ──
  function terminalButton() {
    return button('aw-terminal', 'Answer in terminal', { act: 'decide', decide: () => ({ behavior: 'terminal' }) });
  }
  // Offered when the request does not fit the frame (item 2): the page popup,
  // where it scrolls in a window no pane can overlay.
  function reviewButton() {
    if (layout === 'page') return null;
    return button('aw-review', 'Review ›', { act: 'review', title: 'Read the whole request in a window of its own' });
  }

  function drawQuestions() {
    const qs = (view.detail && view.detail.question && Array.isArray(view.detail.question.questions))
      ? view.detail.question.questions : [];
    const picks = qs.map(() => ({ options: new Set(), other: false }));
    const others = [];
    qs.forEach((q, qi) => {
      const fs = el('fieldset', 'aw-q');
      if (q.header) fs.append(el('legend', 'aw-qhead', text(q.header)));
      const qtext = el('p', 'aw-qtext', text(q.question));
      subjects.push(qtext);
      fs.append(qtext);
      const list = el('div', 'aw-options');
      const multi = q.multiSelect === true;
      const opts = Array.isArray(q.options) ? q.options : [];
      const optEls = [];
      const otherInput = el('input', 'aw-other-text');
      otherInput.type = 'text';
      otherInput.maxLength = 500;
      otherInput.placeholder = 'Your answer';
      otherInput.setAttribute('aria-label', `Your own answer to question ${qi + 1}`);
      otherInput.hidden = true;
      others.push(otherInput);
      const syncSingle = () => {
        for (const [i, b] of optEls.entries()) b.setAttribute('aria-pressed', String(picks[qi].options.has(i)));
        otherBtn.setAttribute('aria-pressed', String(picks[qi].other));
        otherInput.hidden = !picks[qi].other;
      };
      opts.forEach((o, oi) => {
        const label = text(o && o.label);
        const desc = text(o && o.description);
        if (multi) {
          const lab = el('label', 'aw-option aw-check');
          const box2 = el('input');
          box2.type = 'checkbox';
          box2.className = 'aw-checkbox';
          box2.dataset.q = String(qi);
          box2.dataset.o = String(oi);
          box2.addEventListener('change', () => {
            if (box2.checked) picks[qi].options.add(oi); else picks[qi].options.delete(oi);
          });
          const words = el('span', 'aw-olabel', label);
          lab.append(box2, words);
          if (desc) lab.append(el('span', 'aw-odesc', desc));
          list.append(lab);
          optEls.push(box2);
        } else {
          const b = el('button', 'aw-option', null);
          b.type = 'button';
          b.dataset.q = String(qi);
          b.dataset.o = String(oi);
          b.setAttribute('aria-pressed', 'false');
          b.append(el('span', 'aw-olabel', label));
          if (desc) b.append(el('span', 'aw-odesc', desc));
          b.addEventListener('click', () => {
            picks[qi].options = new Set([oi]);
            picks[qi].other = false;
            syncSingle();
          });
          list.append(b);
          optEls.push(b);
        }
      });
      const otherBtn = el('button', 'aw-option aw-other', 'Other…');
      otherBtn.type = 'button';
      otherBtn.dataset.q = String(qi);
      otherBtn.setAttribute('aria-pressed', 'false');
      otherBtn.addEventListener('click', () => {
        if (multi) {
          picks[qi].other = !picks[qi].other;
          otherBtn.setAttribute('aria-pressed', String(picks[qi].other));
          otherInput.hidden = !picks[qi].other;
        } else {
          picks[qi].options = new Set();
          picks[qi].other = true;
          syncSingle();
        }
        if (!otherInput.hidden && typeof otherInput.focus === 'function') otherInput.focus();
      });
      list.append(otherBtn);
      fs.append(list, otherInput);
      box.append(fs);
    });
    if (blocked || viaPopup) return;
    const send = button('aw-send', qs.length > 1 ? 'Send answers' : 'Send answer', {
      act: 'decide',
      acting: true,
      decide: () => {
        const out = [];
        for (let qi = 0; qi < qs.length; qi++) {
          const p = picks[qi];
          // Other wins when it is chosen and written: Claude Code takes one
          // answer per question, and the free text is the user's own.
          const other = others[qi].value.trim();
          if (p.other && other) { out.push({ q: qi, other }); continue; }
          if (p.options.size) { out.push({ q: qi, options: [...p.options].sort((a, b) => a - b) }); continue; }
          setProblem(qs.length > 1 ? `Answer question ${qi + 1} first` : 'Pick an answer first');
          return null;
        }
        setProblem('');
        return { behavior: 'answer', picks: out };
      },
    });
    box.append(actions(send, terminalButton(), reviewButton()));
  }

  function drawPlan() {
    const plan = (view.detail && view.detail.plan) || {};
    if (plan.file) box.append(el('p', 'aw-planfile', text(plan.file).split('/').pop()));
    const md = el('div', 'aw-plan');
    md.innerHTML = typeof plan.html === 'string' ? plan.html : '';   // the core engine's escaped output (§4.4)
    subjects.push(md);
    box.append(md);
    if (blocked || viaPopup) return;
    const feedback = el('textarea', 'aw-feedback');
    feedback.maxLength = 2000;
    feedback.rows = 3;
    feedback.placeholder = 'What should Claude change?';
    feedback.setAttribute('aria-label', 'Feedback for Claude');
    const sendBack = button('aw-reject', 'Send feedback', {
      act: 'decide',
      decide: () => {
        const m = feedback.value.trim();
        return m ? { behavior: 'reject', message: m } : { behavior: 'reject' };
      },
    });
    const keep = el('div', 'aw-keep');
    keep.hidden = true;
    keep.append(feedback, actions(sendBack));
    const keepBtn = el('button', 'aw-btn aw-keepplanning', 'Keep planning…');
    keepBtn.type = 'button';
    keepBtn.setAttribute('aria-expanded', 'false');
    keepBtn.addEventListener('click', () => {
      keep.hidden = !keep.hidden;
      keepBtn.setAttribute('aria-expanded', String(!keep.hidden));
      if (!keep.hidden && typeof feedback.focus === 'function') feedback.focus();
    });
    box.append(
      actions(
        button('aw-approve', 'Approve · ask before edits', { act: 'decide', acting: true,
          decide: () => ({ behavior: 'approve', mode: 'default' }) }),
        button('aw-approve-edits', 'Approve · auto-accept edits', { act: 'decide', acting: true,
          decide: () => ({ behavior: 'approve', mode: 'acceptEdits' }) }),
        keepBtn,
        terminalButton(),
        reviewButton(),
      ),
      keep,
    );
  }

  function setProblem(words) {
    problem.textContent = words || '';
    problem.hidden = !words;
  }

  function finish() {
    return {
      root,
      box,
      subjects,
      controls,
      decisionOf: (btn) => {
        const fn = decisions.get(btn);
        return fn ? fn() : null;
      },
      problem: setProblem,
    };
  }
}
