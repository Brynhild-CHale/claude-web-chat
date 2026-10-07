// lib/hooks/ask-output.js — what the ask hook prints for a decision made in
// the web-chat page (spec §4.2). Pure: no I/O, no clock, no environment.
//
//   buildAskOutput(kind, local, decision) → the one-line JSON string Claude
//                                           Code reads on the hook's stdout,
//                                           or null: print nothing
//
// kind      'permission' | 'question' | 'plan' (the hook's own reading of
//           tool_name: AskUserQuestion, ExitPlanMode, anything else)
// local     the hook's LOCAL COPY, kept in memory for the echo and never
//           taken from the daemon: { questions: tool_input.questions as Claude
//           Code handed them (unredacted, uncut), plan: the plan text the hook
//           read (the plan file, else tool_input.plan), planFilePath:
//           tool_input.planFilePath }
// decision  the asks domain's HOOK FORM, as the decision poll returned it
//
// The table (§4.2, verbatim; V9 found exactly these outputs honoured):
//
//   permission allow     allow
//   permission deny      deny, DENY_MESSAGE (+ " They wrote: <message>")
//   question   answer    allow + updatedInput {questions: <local copy>, answers}
//   question   decline   deny, DECLINE_MESSAGE (+ " They wrote: <message>",
//                        notes-A D7)
//   plan       approve   allow + updatedInput {plan, planFilePath}; mode
//                        acceptEdits adds updatedPermissions [setMode
//                        acceptEdits, destination session]
//   plan       reject    deny, REJECT_FEEDBACK + <message>, or without one
//                        REJECT_NO_FEEDBACK (the wording V9 saw followed; an
//                        instruction-like message was refused by the model as
//                        untrusted tool output)
//   any        terminal  null: the terminal prompt stays and is answered there
//
// `allow` alone is ignored for questions and plans (V9), so both always echo
// their input. A QUESTION'S ANSWERS ARE BUILT FROM PICKS BY INDEX (ruling A3
// (a)): the page answered against the displayed, possibly masked texts, the
// domain stored which question and option indexes were picked, and the
// answers are keyed by the LOCAL copy's question text and filled with the
// LOCAL copy's labels — never a displayed text, so a secret the redactor
// masked reaches Claude Code as the user saw it unmasked in the terminal, and
// two texts that mask alike cannot be confused. A pick the local copy cannot
// map (an index it lacks, a second option on a single-select question, a
// question left unanswered) gives null: the terminal prompt stands, and Claude
// never gets a wrong answer.
//
// What is NEVER output: bypassPermissions, addRules, interrupt: true (kept out
// of 0.8.5's UI, §4.2), or any updatedPermissions but the one setMode
// acceptEdits session entry. Messages are cleaned with lib/core/text.js
// stripControls (the one control-character guard; newlines kept) and capped
// at MESSAGE_MAX characters.
//
// The PermissionRequest output's event name is spelled here and nowhere else
// under lib/ (the tripwire row, U66b).
//
// Dependency direction: lib/hooks → lib/core (text).

const { stripControls } = require('../core/text');

const MESSAGE_MAX = 2000;

// Where the user decided. The rules files quote it (§6.8), and
// test/rules-text-truth.test.js holds the two together.
const PAGE_PHRASE = 'in the web-chat page';

const DENY_MESSAGE = `The user denied this tool call ${PAGE_PHRASE}.`;
const DECLINE_MESSAGE = `The user declined to answer ${PAGE_PHRASE}.`;
const WROTE = ' They wrote: ';
const REJECT_FEEDBACK = `The user rejected this plan ${PAGE_PHRASE} and wrote this feedback: `;
const REJECT_NO_FEEDBACK = `The user rejected this plan ${PAGE_PHRASE} without feedback. Keep planning and ask what to change.`;
// Multi-select labels, joined as Claude Code's own dialog joins them (V9).
const LABEL_JOIN = ', ';

const PLAN_MODES = new Set(['default', 'acceptEdits']);

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// A message, cleaned and capped in characters (code points: never half a
// pair); '' when there is none.
function cleanMessage(v) {
  if (typeof v !== 'string') return '';
  const s = stripControls(v, { keepNewlines: true }).trim();
  const chars = Array.from(s);
  return chars.length > MESSAGE_MAX ? chars.slice(0, MESSAGE_MAX).join('') : s;
}

function output(decision) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}

function deny(base, message) {
  return output({ behavior: 'deny', message: message ? `${base}${WROTE}${message}` : base });
}

// The answers object for the picks, or null when any pick does not map onto
// the local copy.
function answersOf(questions, picks) {
  if (!Array.isArray(questions) || questions.length === 0) return null;
  if (!Array.isArray(picks) || picks.length !== questions.length) return null;
  const answers = {};
  const seen = new Set();
  for (const pick of picks) {
    if (!isPlain(pick)) return null;
    const q = pick.q;
    if (!Number.isSafeInteger(q) || q < 0 || q >= questions.length || seen.has(q)) return null;
    seen.add(q);
    const question = questions[q];
    if (!isPlain(question) || typeof question.question !== 'string') return null;
    // Two questions of one text would be one key: neither answer is safe.
    if (Object.hasOwn(answers, question.question)) return null;
    const hasOptions = Object.hasOwn(pick, 'options');
    if (hasOptions === Object.hasOwn(pick, 'other')) return null;
    let value;
    if (hasOptions) {
      const idx = pick.options;
      const options = question.options;
      if (!Array.isArray(idx) || idx.length === 0 || !Array.isArray(options)) return null;
      if (idx.length > 1 && question.multiSelect !== true) return null;
      const labels = [];
      const picked = new Set();
      for (const i of [...idx].sort((a, b) => a - b)) {
        if (!Number.isSafeInteger(i) || i < 0 || i >= options.length || picked.has(i)) return null;
        picked.add(i);
        const option = options[i];
        if (!isPlain(option) || typeof option.label !== 'string') return null;
        labels.push(option.label);
      }
      value = labels.join(LABEL_JOIN);
    } else {
      value = cleanMessage(pick.other);
      if (!value) return null;
    }
    answers[question.question] = value;
  }
  return answers;
}

function buildAskOutput(kind, local, decision) {
  if (!isPlain(decision) || typeof decision.behavior !== 'string') return null;
  const l = isPlain(local) ? local : {};
  const b = decision.behavior;
  if (b === 'terminal') return null;
  const message = cleanMessage(decision.message);

  if (kind === 'permission') {
    if (b === 'allow') return output({ behavior: 'allow' });
    if (b === 'deny') return deny(DENY_MESSAGE, message);
    return null;
  }

  if (kind === 'question') {
    if (b === 'decline') return deny(DECLINE_MESSAGE, message);
    if (b !== 'answer') return null;
    const answers = answersOf(l.questions, decision.picks);
    if (!answers) return null;
    return output({ behavior: 'allow', updatedInput: { questions: l.questions, answers } });
  }

  if (kind === 'plan') {
    if (b === 'reject') return output({ behavior: 'deny', message: message ? `${REJECT_FEEDBACK}${message}` : REJECT_NO_FEEDBACK });
    if (b !== 'approve' || !PLAN_MODES.has(decision.mode) || typeof l.plan !== 'string') return null;
    const updatedInput = { plan: l.plan };
    if (typeof l.planFilePath === 'string') updatedInput.planFilePath = l.planFilePath;
    const out = { behavior: 'allow', updatedInput };
    if (decision.mode === 'acceptEdits') {
      out.updatedPermissions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
    }
    return output(out);
  }

  return null;
}

module.exports = {
  buildAskOutput,
  MESSAGE_MAX,
  PAGE_PHRASE,
  DENY_MESSAGE,
  DECLINE_MESSAGE,
  WROTE,
  REJECT_FEEDBACK,
  REJECT_NO_FEEDBACK,
  LABEL_JOIN,
};
