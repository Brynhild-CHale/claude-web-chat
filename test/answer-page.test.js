// The answer page (lib/server/answer-surface/public/*: index.html, answer.js,
// answer-view.js), spec §4.4 and §4.5, in jsdom.
//
//   * answer-view: everything is text (a subject holding markup renders as
//     text); each kind's controls per layout; each why_not's words with no
//     answering button; masked text marked visibly wherever it is shown
//     (ruling A3 (a)); the popup's buttons where there is no visibility proof.
//   * the runtime (stubbed fetch): without IntersectionObserver v2 the
//     answering buttons are `Review & answer ↗`, opening the page layout in a
//     popup; with a stubbed v2, a click that is not trusted, or made without
//     user activation, or too soon, posts nothing, and a permitted one posts
//     exactly {decision, version, device} with X-WC-Answer and JSON — a
//     question's decision as picks BY INDEX, never a displayed text.
//   * the messages: size clamped 22-480, only wc-answer:mode accepted in,
//     and only from the parent.
//   * masked questions end to end (ruling A3 (a) and the maintainer's note):
//     the real page against the real answer surface (U55), the real asks
//     domain with the real redactor (U53) and the ask hook as a subprocess
//     (U54) — the page shows each mask marked, a trusted click answers, and
//     the hook prints the exact unredacted texts; a pick the hook cannot map
//     prints nothing; texts that mask alike are told apart by index.
//
// jsdom's events are never trusted (isTrusted is unforgeable), so the runtime
// cases that need a trusted click wrap the page's own listeners (trustClicks,
// below): the page's code is unchanged and still reads event.isTrusted.
// The same clicks in a real browser are test/answer-frame-e2e.test.js's.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const express = require('express');
const { JSDOM } = require('jsdom');

const { MASK, createRedactor } = require('../lib/core/redact');
const { createAsks } = require('../lib/server/domain/asks');
const { mountAskRoutes } = require('../lib/server/routes/asks');
const { createAnswerSurface } = require('../lib/server/answer-surface');
const { createHookTap } = require('../lib/server/hook-tap');
const { createBus } = require('../lib/core/bus');
const { writePortfileAt } = require('../lib/core/portfiles');
const { fakeSecrets } = require('../test-support/fake-secrets');
const { tmpRoot, waitUntil } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const PUB = path.join(REPO, 'lib/server/answer-surface/public');
const HOOK_BIN = path.join(REPO, 'bin', 'claude-web-chat-hook.js');
const ORIGIN = 'http://127.0.0.1:47123';
const ID = 'ask_0123456789ab';
const NONCE = 'nonce-for-this-load';

let A, V;
test.before(async () => {
  A = await import(pathToFileURL(path.join(PUB, 'answer.js')).href);
  V = await import(pathToFileURL(path.join(PUB, 'answer-view.js')).href);
});

// ── fixtures ────────────────────────────────────────────────────────────────

function view(over = {}) {
  return {
    id: ID, kind: 'permission', tool_name: 'Bash', agent: null, state: 'pending', outcome: null, version: 3,
    subject: 'Bash(npm test)', masked: false, complete: true,
    detail: { permission: { fields: [{ name: 'command', value: 'npm test' }, { name: 'description', value: 'Run the tests' }] } },
    can_answer: true, why_not: null,
    ...over,
  };
}
const QUESTIONS = [
  { question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] },
  { question: 'Which toppings?', header: 'Toppings', multiSelect: true, options: [{ label: 'Cheese' }, { label: 'Olives, black' }, { label: 'Basil' }] },
];
const questionView = (qs = QUESTIONS, over = {}) => view({
  kind: 'question', tool_name: 'AskUserQuestion', subject: qs[0].question, detail: { question: { questions: qs } }, ...over,
});
const planView = (over = {}) => view({
  kind: 'plan', tool_name: 'ExitPlanMode', subject: 'Plan', detail: { plan: { html: '<h1>The plan</h1><p>Step <code>one</code></p>', file: '/home/u/.claude/plans/p.md' } }, ...over,
});

// A bare document for the view's own cases.
function blankDoc() {
  return new JSDOM('<!doctype html><body></body>', { url: `${ORIGIN}/answer/ask/${ID}` }).window.document;
}
const labels = (drawn) => drawn.controls.map((c) => c.el.textContent);
const decideLabels = (drawn) => drawn.controls.filter((c) => c.act === 'decide').map((c) => c.el.textContent);

// The real index.html, as the surface serves it (one pass), minus its script:
// the test boots the runtime itself, into this window.
function pageHtml({ nonce = NONCE, mode = 'light', kind = 'ask', meta = '' } = {}) {
  const values = { NONCE: nonce, MODE: mode, KIND: kind, META: meta };
  return fs.readFileSync(path.join(PUB, 'index.html'), 'utf8')
    .replace(/\{\{(NONCE|MODE|KIND|META)\}\}/g, (_, k) => values[k])
    .replace(/<script[^>]*><\/script>/g, '');
}

// Every listener the page adds sees a click as trusted while `trust.on`.
function trustClicks(W) {
  const trust = { on: false };
  const proto = W.EventTarget.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  const wrapped = new WeakMap();
  proto.addEventListener = function addEventListener(type, fn, opts) {
    if (type !== 'click' || typeof fn !== 'function') return add.call(this, type, fn, opts);
    const w = function trusted(e) {
      if (!trust.on) return fn.call(this, e);
      const p = new Proxy(e, {
        get(t, k) {
          if (k === 'isTrusted') return true;
          const v = Reflect.get(t, k, t);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      return fn.call(this, p);
    };
    wrapped.set(fn, w);
    return add.call(this, type, w, opts);
  };
  proto.removeEventListener = function removeEventListener(type, fn, opts) {
    return remove.call(this, type, (fn && wrapped.get(fn)) || fn, opts);
  };
  return trust;
}

// A stubbed IntersectionObserver v2: the test reports the entries.
function stubVisibility(W) {
  const observers = [];
  W.IntersectionObserverEntry = class IntersectionObserverEntry { get isVisible() { return true; } };
  W.IntersectionObserver = class IntersectionObserver {
    constructor(cb, opts) { this.cb = cb; this.opts = opts; this.target = null; observers.push(this); }
    observe(t) { this.target = t; }
    disconnect() { this.target = null; }
  };
  return {
    observers,
    report(entry = { intersectionRatio: 1, isVisible: true }) {
      for (const o of observers) if (o.target) o.cb([{ target: o.target, ...entry }]);
    },
  };
}

// A page in jsdom: the real document, the runtime booted into it.
async function openPage(t, { layout = 'card', kind = 'ask', id = ID, query = '', fetch, proof = false, activation = true,
  url, html } = {}) {
  const href = url || `${ORIGIN}/answer/${kind}/${id}?layout=${layout}&mode=light&device=desktop${query}`;
  const dom = new JSDOM(html || pageHtml({ kind }), { url: href, pretendToBeVisual: true });
  const W = dom.window;
  const trust = trustClicks(W);
  const vis = proof ? stubVisibility(W) : null;
  Object.defineProperty(W.navigator, 'userActivation', { value: { isActive: activation, hasBeenActive: activation }, configurable: true });
  const parent = new JSDOM('', { url: 'http://127.0.0.1:5173/' }).window;
  const posts = [];
  parent.postMessage = (msg, target) => { posts.push({ msg, target }); };
  Object.defineProperty(W, 'parent', { value: parent, configurable: true });
  const opened = [];
  W.open = (...args) => { opened.push(args); return null; };
  const calls = [];
  W.fetch = async (u, init = {}) => {
    calls.push({ url: String(u), init, body: init.body ? JSON.parse(init.body) : null });
    return fetch(String(u), init);
  };
  const clock = { t: 10_000 };
  const handle = await A.boot(W, { now: () => clock.t });
  t.after(() => { try { handle.stop(); } catch {} W.close(); parent.close(); });
  return { W, doc: W.document, handle, trust, vis, posts, opened, calls, clock, parent };
}

// A JSON answer, as fetch gives it; HANG never answers (a long-poll waiting).
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const HANG = () => new Promise(() => {});
function viewFetch(v, { decide = () => json({ ok: true, state: 'decided', outcome: 'allowed', version: v.version + 1 }) } = {}) {
  return (u, init) => {
    if (init && init.method === 'POST') return decide(u, init);
    if (/\?v=/.test(u)) return HANG();
    return json(v);
  };
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const $ = (doc, sel) => doc.querySelector(sel);
const $$ = (doc, sel) => [...doc.querySelectorAll(sel)];
function pointerIn(p, el) {
  el.dispatchEvent(new p.W.Event('pointerover', { bubbles: true }));
}
// Clicked as a mouse would (detail 1), trusted while it runs.
function click(p, el, { trusted = true } = {}) {
  p.trust.on = trusted;
  try { el.dispatchEvent(new p.W.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); } finally { p.trust.on = false; }
}
// Visible for 500 ms, the pointer in for 300 ms, the cooldown over.
function makeReady(p, el) {
  p.vis.report();
  pointerIn(p, el);
  p.clock.t += 1000;
}
const decides = (p) => p.calls.filter((c) => c.init && c.init.method === 'POST');

/* ══ answer-view ═════════════════════════════════════════════════════════════ */

test('view: a subject holding markup renders as text, in every layout', () => {
  const evil = '<img src=x onerror=alert(1)>';
  for (const layout of ['bar', 'card', 'sheet', 'page']) {
    const doc = blankDoc();
    const v = view({ subject: `Bash(${evil})`, detail: { permission: { fields: [{ name: 'command', value: evil }] } } });
    const drawn = V.renderAsk(doc, v, { layout });
    doc.body.append(drawn.root);
    assert.equal(doc.querySelector('img'), null, `${layout}: no element was made from the subject`);
    assert.ok(doc.body.textContent.includes(evil), `${layout}: the markup is shown as its text`);
  }
});

test('view: a permission — card: its fields in code boxes, Allow once, Deny with a note, Answer in terminal, Review ›', () => {
  const doc = blankDoc();
  const drawn = V.renderAsk(doc, view(), { layout: 'card' });
  doc.body.append(drawn.root);
  assert.deepEqual($$(doc, '.aw-fname').map((e) => e.textContent), ['command', 'description']);
  assert.deepEqual($$(doc, 'pre.aw-code').map((e) => e.textContent), ['npm test', 'Run the tests']);
  assert.equal(drawn.subjects.length, 2, 'the fit rule measures the code boxes');
  assert.ok(drawn.box.contains($(doc, '.aw-allow')) && drawn.box.contains($(doc, 'pre.aw-code')), 'one container holds the subject and the buttons');
  assert.deepEqual(labels(drawn), ['Allow once', 'Deny', 'Answer in terminal', 'Review ›']);
  const allow = drawn.controls.find((c) => c.el.textContent === 'Allow once');
  assert.equal(allow.acting, true);
  assert.deepEqual(drawn.decisionOf(allow.el), { behavior: 'allow' });
  const deny = drawn.controls.find((c) => c.el.textContent === 'Deny');
  assert.equal(deny.acting, false);
  assert.deepEqual(drawn.decisionOf(deny.el), { behavior: 'deny' });
  $(doc, '.aw-note').value = '  not now  ';
  assert.deepEqual(drawn.decisionOf(deny.el), { behavior: 'deny', message: 'not now' });
  assert.deepEqual(drawn.decisionOf(drawn.controls.find((c) => c.el.textContent === 'Answer in terminal').el), { behavior: 'terminal' });
  assert.equal(drawn.controls.find((c) => c.el.textContent === 'Review ›').act, 'review');
  assert.equal(doc.activeElement, doc.body, 'no default focus (item 5)');
});

test('view: a permission — bar: the subject, Allow and Deny, and Review › (shown when it does not fit); sheet and page', () => {
  let doc = blankDoc();
  let drawn = V.renderAsk(doc, view(), { layout: 'bar' });
  assert.equal(drawn.root.querySelector('.aw-subject').textContent, 'Bash(npm test)');
  assert.deepEqual(labels(drawn), ['Allow', 'Deny', 'Review ›']);
  assert.equal(drawn.controls[2].act, 'chat', 'the bar\'s Review › opens the chat');
  assert.deepEqual(drawn.subjects, [drawn.root.querySelector('.aw-subject')]);

  doc = blankDoc();
  drawn = V.renderAsk(doc, view(), { layout: 'sheet' });
  assert.equal(drawn.root.dataset.layout, 'sheet');
  assert.deepEqual(labels(drawn), ['Allow once', 'Deny', 'Answer in terminal', 'Review ›']);

  doc = blankDoc();
  drawn = V.renderAsk(doc, view(), { layout: 'page' });
  assert.match(drawn.root.querySelector('.aw-title').textContent, /^Claude is waiting · Permission · Bash$/);
  assert.deepEqual(labels(drawn), ['Allow once', 'Deny', 'Answer in terminal'], 'the popup has no Review ›: it is the review');
});

test('view: a question — option buttons, multiSelect checkboxes and Other…; the decision is picks BY INDEX', () => {
  const doc = blankDoc();
  const drawn = V.renderAsk(doc, questionView(), { layout: 'card' });
  doc.body.append(drawn.root);
  const W = doc.defaultView;
  const qs = $$(doc, 'fieldset.aw-q');
  assert.equal(qs.length, 2);
  assert.deepEqual([...qs[0].querySelectorAll('button.aw-option:not(.aw-other)')].map((b) => b.querySelector('.aw-olabel').textContent), ['Red', 'Blue']);
  assert.equal(qs[0].querySelectorAll('input[type=checkbox]').length, 0, 'single select: buttons');
  assert.equal(qs[1].querySelectorAll('input[type=checkbox]').length, 3, 'multiSelect: checkboxes');
  assert.ok(qs[0].querySelector('.aw-other') && qs[1].querySelector('.aw-other'), 'Other… on each');
  assert.equal(qs[0].querySelector('legend').textContent, 'Colour');
  const send = drawn.controls.find((c) => c.el.textContent === 'Send answers');
  assert.ok(send && send.acting);
  assert.deepEqual(decideLabels(drawn), ['Send answers', 'Answer in terminal']);

  assert.equal(drawn.decisionOf(send.el), null, 'nothing picked: no decision');
  assert.ok(!$(doc, '.aw-problem').hidden, 'and the view says what is missing');
  qs[0].querySelectorAll('button.aw-option')[1].click();        // Blue
  const boxes = qs[1].querySelectorAll('input[type=checkbox]');
  for (const i of [2, 0]) { boxes[i].checked = true; boxes[i].dispatchEvent(new W.Event('change')); }
  assert.deepEqual(drawn.decisionOf(send.el), { behavior: 'answer', picks: [{ q: 0, options: [1] }, { q: 1, options: [0, 2] }] });
  assert.equal(qs[0].querySelectorAll('button.aw-option')[1].getAttribute('aria-pressed'), 'true');

  // Other… with words wins for its question; its text is the user's own.
  qs[0].querySelector('.aw-other').click();
  const other = qs[0].querySelector('.aw-other-text');
  assert.equal(other.hidden, false);
  other.value = 'Green';
  assert.deepEqual(drawn.decisionOf(send.el).picks[0], { q: 0, other: 'Green' });
  assert.ok(!JSON.stringify(drawn.decisionOf(send.el)).includes('Olives'), 'never a displayed text');
});

test('view: a plan — the rendered markdown, its three actions, and Keep planning… with feedback', () => {
  const doc = blankDoc();
  const drawn = V.renderAsk(doc, planView(), { layout: 'card' });
  doc.body.append(drawn.root);
  assert.equal($(doc, '.aw-plan h1').textContent, 'The plan', 'the engine\'s HTML');
  assert.equal($(doc, '.aw-planfile').textContent, 'p.md');
  assert.deepEqual(decideLabels(drawn).sort(), ['Answer in terminal', 'Approve · ask before edits', 'Approve · auto-accept edits', 'Send feedback']);
  const by = (label) => drawn.controls.find((c) => c.el.textContent === label);
  assert.deepEqual(drawn.decisionOf(by('Approve · ask before edits').el), { behavior: 'approve', mode: 'default' });
  assert.deepEqual(drawn.decisionOf(by('Approve · auto-accept edits').el), { behavior: 'approve', mode: 'acceptEdits' });
  assert.equal(by('Approve · ask before edits').acting, true);
  const keep = $(doc, '.aw-keepplanning');
  assert.equal(keep.textContent, 'Keep planning…');
  assert.equal($(doc, '.aw-keep').hidden, true);
  keep.click();
  assert.equal($(doc, '.aw-keep').hidden, false);
  assert.deepEqual(drawn.decisionOf(by('Send feedback').el), { behavior: 'reject' });
  $(doc, '.aw-feedback').value = 'Split step two';
  assert.deepEqual(drawn.decisionOf(by('Send feedback').el), { behavior: 'reject', message: 'Split step two' });
});

test('view: a question or a plan in the bar is only Answer ›, which opens the chat (deviation 14)', () => {
  for (const v of [questionView(), planView()]) {
    const drawn = V.renderAsk(blankDoc(), v, { layout: 'bar' });
    assert.deepEqual(labels(drawn), ['Answer ›']);
    assert.equal(drawn.controls[0].act, 'chat');
  }
});

test('view: each why_not shows its words and no answering button, in the card and the bar', () => {
  const cases = [
    [{ why_not: 'resolved', state: 'resolved', outcome: 'terminal', can_answer: false }, 'Answered in the terminal'],
    [{ why_not: 'resolved', state: 'decided', outcome: 'allowed', can_answer: false }, 'Allowed'],
    [{ why_not: 'no-hook', can_answer: false }, 'Answer in the terminal'],
    [{ why_not: 'remote-off', can_answer: false }, 'Answer in the terminal'],
    [{ why_not: 'too-long', can_answer: false, complete: false }, 'Too long to show here — answer in the terminal'],
  ];
  for (const [over, words] of cases) {
    for (const make of [view, (o) => questionView(QUESTIONS, o), planView]) {
      for (const layout of ['card', 'bar', 'sheet']) {
        const drawn = V.renderAsk(blankDoc(), make(over), { layout });
        assert.equal(drawn.root.querySelector('.aw-status').textContent, words, `${over.why_not} (${layout})`);
        assert.deepEqual(decideLabels(drawn), [], `${over.why_not}: no answering button (${layout})`);
      }
    }
  }
});

test('view: masked text is marked visibly where it is shown — the question, a label, a description, the subject', () => {
  const m = MASK('api-key');
  const qs = [{ question: `Rotate ${m} now?`, header: 'Key', multiSelect: false,
    options: [{ label: `Yes, rotate ${m}`, description: `old key ${m}` }, { label: 'No', description: 'leave it' }] }];
  for (const layout of ['card', 'sheet', 'page']) {
    const doc = blankDoc();
    const drawn = V.renderAsk(doc, questionView(qs, { masked: true }), { layout });
    doc.body.append(drawn.root);
    for (const sel of ['.aw-qtext', '.aw-option .aw-olabel', '.aw-option .aw-odesc']) {
      const el = $(doc, sel);
      assert.ok(el.querySelector('mark.aw-mask'), `${layout}: ${sel} marks its mask`);
      assert.equal(el.querySelector('mark.aw-mask').textContent, m);
      assert.ok(el.classList.contains('aw-has-mask'));
    }
    assert.equal($$(doc, '.aw-option')[1].querySelector('mark'), null, 'an unmasked option has no mark');
    assert.equal($(doc, '.aw-masked').textContent, V.MASKED_LINE);
  }
  const bar = V.renderAsk(blankDoc(), view({ subject: `Bash(curl -H ${m})`, masked: true }), { layout: 'bar' });
  assert.ok(bar.root.querySelector('.aw-subject mark.aw-mask'), 'the bar\'s subject too');
  const card = V.renderAsk(blankDoc(), view({ masked: true, detail: { permission: { fields: [{ name: 'command', value: `curl -H ${m}` }] } } }), { layout: 'card' });
  assert.ok(card.root.querySelector('pre.aw-code mark.aw-mask'), 'a code box too');
});

test('view: with the popup option, every answering control is one `Review & answer ↗`', () => {
  for (const v of [view(), questionView(), planView()]) {
    const drawn = V.renderAsk(blankDoc(), v, { layout: 'card', popup: true });
    assert.deepEqual(labels(drawn), ['Review & answer ↗']);
    assert.equal(drawn.controls[0].act, 'popup');
  }
  const bar = V.renderAsk(blankDoc(), view(), { layout: 'bar', popup: true });
  assert.deepEqual(labels(bar), ['Review & answer ↗']);
});

/* ══ the runtime ═════════════════════════════════════════════════════════════ */

test('runtime: it reads the kind, the id, the layout, the mode and the nonce from its own document', async (t) => {
  const p = await openPage(t, { layout: 'sheet', fetch: viewFetch(view()) });
  assert.equal(p.handle.rt.kind, 'ask');
  assert.equal(p.handle.rt.id, ID);
  assert.equal(p.handle.rt.layout, 'sheet');
  assert.equal(p.handle.rt.nonce, NONCE);
  assert.equal(p.doc.documentElement.dataset.mode, 'light');
  assert.equal(p.doc.documentElement.dataset.layout, 'sheet');
  await settle();
  const first = p.calls[0];
  assert.equal(first.url, `/answer/api/asks/${ID}`);
  assert.equal(first.init.headers['X-WC-Answer'], NONCE);
  assert.equal(p.calls[1].url, `/answer/api/asks/${ID}?v=3&wait=20000`, 'then the long-poll on its version');
  // The document links only its own origin's files: palette, stylesheet, script.
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.deepEqual([...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]), ['/answer/palette.css', '/answer/answer.css', '/answer/answer.js']);
  assert.doesNotMatch(html, /<style|style=|<script>(?!<)/, 'no inline style or script');
  assert.ok(html.indexOf('/answer/palette.css') < html.indexOf('/answer/answer.css'), 'the palette, then the layouts');
  assert.match(html, /\{\{META\}\}/);
  assert.match(html, /<html[^>]*data-mode="\{\{MODE\}\}"/);
});

test('runtime, no IntersectionObserver v2: the answering buttons read `Review & answer ↗` and open the page layout in a popup', async (t) => {
  const p = await openPage(t, { layout: 'card', fetch: viewFetch(view()) });
  await settle();
  assert.equal(p.handle.rt.proof, false, 'jsdom has no v2');
  const buttons = $$(p.doc, 'button[data-act]');
  assert.deepEqual(buttons.map((b) => b.textContent), ['Review & answer ↗']);
  click(p, buttons[0], { trusted: false });
  assert.deepEqual(p.opened, [], 'an untrusted click opens nothing');
  click(p, buttons[0]);
  assert.deepEqual(p.opened, [[`/answer/ask/${ID}?layout=page&mode=light&device=desktop`, '_blank', 'popup,width=460,height=600']]);
  assert.equal(decides(p).length, 0, 'and posts nothing');
});

test('runtime: the page layout in a top-level window answers without the proof, and with every other guard', async (t) => {
  const p = await openPage(t, { layout: 'page', fetch: viewFetch(view()) });
  await settle();
  // jsdom's window is its own top: a popup no pane can overlay.
  Object.defineProperty(p.W, 'parent', { value: p.W, configurable: true });
  const allow = $(p.doc, '.aw-allow');
  assert.ok(allow, 'real buttons in the popup');
  click(p, allow);
  assert.equal(decides(p).length, 0, 'the pointer never entered: no dwell');
  pointerIn(p, allow);
  p.clock.t += 1000;
  click(p, allow);
  await settle();
  assert.equal(decides(p).length, 1);
});

test('runtime: an untrusted click, a click with no user activation, or one too soon posts nothing; a permitted one posts exactly {decision, version, device}', async (t) => {
  const p = await openPage(t, { layout: 'card', proof: true, fetch: viewFetch(view()) });
  await settle();
  const allow = $(p.doc, '.aw-allow');
  assert.equal(allow.getAttribute('aria-disabled'), 'true', 'disabled until proven');
  click(p, allow);
  assert.equal(decides(p).length, 0, 'not proven visible yet');
  p.vis.report();
  pointerIn(p, allow);
  p.clock.t += 400;
  click(p, allow);
  assert.equal(decides(p).length, 0, 'visible for 400 ms only');
  p.clock.t += 600;
  click(p, allow, { trusted: false });
  assert.equal(decides(p).length, 0, 'isTrusted false');
  Object.defineProperty(p.W.navigator, 'userActivation', { value: { isActive: false }, configurable: true });
  click(p, allow);
  assert.equal(decides(p).length, 0, 'no user activation');
  Object.defineProperty(p.W.navigator, 'userActivation', { value: { isActive: true }, configurable: true });
  // A keyboard activation (detail 0) with no Tab or pointer focus first.
  p.trust.on = true;
  allow.dispatchEvent(new p.W.MouseEvent('click', { bubbles: true, detail: 0 }));
  p.trust.on = false;
  assert.equal(decides(p).length, 0, 'Enter with no focus arrived by Tab or the pointer');
  p.vis.report({ intersectionRatio: 1, isVisible: false });
  click(p, allow);
  assert.equal(decides(p).length, 0, 'covered');
  assert.match($(p.doc, '.aw-guard').textContent, /^Covered or faded/);
  p.vis.report();
  p.clock.t += 500;
  click(p, allow);
  await settle();
  const [d] = decides(p);
  assert.ok(d, 'the permitted click posted');
  assert.equal(d.url, `/answer/api/asks/${ID}/decide`);
  assert.equal(d.init.headers['X-WC-Answer'], NONCE);
  assert.equal(d.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(d.body, { decision: { behavior: 'allow' }, version: 3, device: 'desktop' });
  assert.deepEqual(p.posts.at(-1).msg, { type: 'wc-answer:done', id: ID, outcome: 'allowed' });
  assert.equal($(p.doc, '.aw-status').textContent, 'Allowed');
});

test('runtime: a new version restarts the cooldown and the proof', async (t) => {
  let current = view();
  let release = null;
  const fetch = (u, init) => {
    if (init && init.method === 'POST') return json({ ok: true, outcome: 'allowed' });
    if (/\?v=3/.test(u)) return new Promise((r) => { release = () => r(json(current)); });
    if (/\?v=/.test(u)) return HANG();
    return json(current);
  };
  const p = await openPage(t, { layout: 'card', proof: true, fetch });
  await settle();
  makeReady(p, $(p.doc, '.aw-allow'));
  current = view({ version: 4, subject: 'Bash(npm run build)', detail: { permission: { fields: [{ name: 'command', value: 'npm run build' }] } } });
  release();
  await settle();
  assert.equal($(p.doc, 'pre.aw-code').textContent, 'npm run build', 'redrawn');
  click(p, $(p.doc, '.aw-allow'));
  assert.equal(decides(p).length, 0, 'the new request is not answered by a click meant for the old one');
  // Past the cooldown, but the new container has not been proven visible yet:
  // the old container's proof does not carry over.
  p.clock.t += 700;
  click(p, $(p.doc, '.aw-allow'));
  assert.equal(decides(p).length, 0, 'the proof starts again for the new container');
  p.vis.report();
  p.clock.t += 600;
  click(p, $(p.doc, '.aw-allow'));
  await settle();
  assert.equal(decides(p)[0].body.version, 4);
});

test('runtime: a question\'s decision is picks by index — two labels that look alike are told apart, and no text is sent', async (t) => {
  const same = MASK('api-key');
  const qs = [{ question: 'Which key?', header: 'K', multiSelect: false, options: [{ label: `key ${same}` }, { label: `key ${same}` }] }];
  const p = await openPage(t, { layout: 'card', proof: true, fetch: viewFetch(questionView(qs, { masked: true })) });
  await settle();
  const opts = $$(p.doc, 'button.aw-option:not(.aw-other)');
  assert.equal(opts[0].textContent, opts[1].textContent, 'the two look the same');
  opts[1].click();
  const send = $(p.doc, '.aw-send');
  makeReady(p, send);
  click(p, send);
  await settle();
  const [d] = decides(p);
  assert.deepEqual(d.body.decision, { behavior: 'answer', picks: [{ q: 0, options: [1] }] });
  assert.ok(!JSON.stringify(d.body).includes('key'), 'no displayed text in the body');
});

test('runtime: a refusal and a lost race are said in the frame; a 409 shows what the ask is now', async (t) => {
  let current = view();
  const fetch = (u, init) => {
    if (init && init.method === 'POST') return json({ ok: false, state: 'resolved', outcome: 'terminal' }, 409);
    if (/\?v=/.test(u)) return HANG();
    return json(current);
  };
  const p = await openPage(t, { layout: 'card', proof: true, fetch });
  await settle();
  makeReady(p, $(p.doc, '.aw-allow'));
  current = view({ state: 'resolved', outcome: 'terminal', why_not: 'resolved', can_answer: false, version: 4 });
  click(p, $(p.doc, '.aw-allow'));
  await settle();
  assert.equal($(p.doc, '.aw-status').textContent, 'Answered in the terminal');
  assert.equal($$(p.doc, 'button[data-act="decide"]').length, 0);
  assert.equal(p.posts.filter((x) => x.msg.type === 'wc-answer:done').length, 0, 'no done for an answer that lost');
});

test('runtime: after the frame\'s own `Answer in terminal` it says "Answer it in the terminal"; only a terminal that resolved it reads "Answered in the terminal"', async (t) => {
  // The view's words, by state: the user's own choice (decided) and the
  // terminal's answer (resolved) share the outcome 'terminal'.
  for (const layout of ['card', 'bar', 'sheet']) {
    const mine = V.renderAsk(blankDoc(), view({ why_not: 'resolved', state: 'decided', outcome: 'terminal', can_answer: false }), { layout });
    assert.equal(mine.root.querySelector('.aw-status').textContent, 'Answer it in the terminal', `decided (${layout})`);
    const theirs = V.renderAsk(blankDoc(), view({ why_not: 'resolved', state: 'resolved', outcome: 'terminal', can_answer: false }), { layout });
    assert.equal(theirs.root.querySelector('.aw-status').textContent, 'Answered in the terminal', `resolved (${layout})`);
  }
  // The frame's own click, end to end through the runtime.
  const decided = view({ state: 'decided', outcome: 'terminal', why_not: 'resolved', can_answer: false, version: 4 });
  let release = null;
  const fetch = (u, init) => {
    if (init && init.method === 'POST') return json({ ok: true, state: 'decided', outcome: 'terminal', version: 4 });
    if (/\?v=3/.test(u)) return new Promise((r) => { release = () => r(json(decided)); });
    if (/\?v=/.test(u)) return HANG();
    return json(view());
  };
  const p = await openPage(t, { layout: 'card', proof: true, fetch });
  await settle();
  const terminal = $(p.doc, '.aw-terminal');
  makeReady(p, terminal);
  click(p, terminal);
  await settle();
  assert.deepEqual(decides(p)[0].body.decision, { behavior: 'terminal' });
  assert.equal($(p.doc, '.aw-status').textContent, 'Answer it in the terminal', 'right after the decide');
  assert.deepEqual(p.posts.at(-1).msg, { type: 'wc-answer:done', id: ID, outcome: 'terminal' });
  release();
  await settle();
  assert.equal($(p.doc, '.aw-status').textContent, 'Answer it in the terminal', 'and after the long-poll redraws the decided ask');
});

/* ══ the messages ════════════════════════════════════════════════════════════ */

test('messages: the first post is a size; size is clamped to 22-480 and sent only when it changes', async (t) => {
  const p = await openPage(t, { layout: 'card', fetch: viewFetch(view()) });
  assert.equal(p.posts[0].msg.type, 'wc-answer:size', 'a size first, for the chrome\'s 3 s load check');
  assert.equal(p.posts[0].target, '*');
  const m = A.createMessenger(p.W);
  p.posts.length = 0;
  m.size(1000);
  m.size(5);
  m.size(5);
  m.size(300.2);
  assert.deepEqual(p.posts.map((x) => x.msg), [
    { type: 'wc-answer:size', height: 480 },
    { type: 'wc-answer:size', height: 22 },
    { type: 'wc-answer:size', height: 301 },
  ]);
  assert.deepEqual(A.cleanResult({ restored: 3, ok: true, cmd: 'claude --resume x', nested: { a: 1 } }), { restored: 3, ok: true },
    'done\'s result is content-free: numbers and booleans');
  m.done(ID, 'restored', { files: 2, path: '/etc/passwd' });
  assert.deepEqual(p.posts.at(-1).msg, { type: 'wc-answer:done', id: ID, outcome: 'restored', result: { files: 2 } });
  m.openChat(ID);
  assert.deepEqual(p.posts.at(-1).msg, { type: 'wc-answer:open-chat', id: ID });
  m.stop();
});

test('messages: only wc-answer:mode is accepted, only from the parent, and it flips data-mode', async (t) => {
  const p = await openPage(t, { layout: 'card', proof: true, fetch: viewFetch(view()) });
  await settle();
  const de = p.doc.documentElement;
  const send = (data, source = p.parent) => p.W.dispatchEvent(new p.W.MessageEvent('message', { data, source }));
  send({ type: 'wc-answer:mode', mode: 'dark' });
  assert.equal(de.dataset.mode, 'dark');
  send({ type: 'wc-answer:mode', mode: 'dark' }, null);
  send({ type: 'wc-answer:mode', mode: 'light' }, p.W);
  assert.equal(de.dataset.mode, 'dark', 'not from another window');
  send({ type: 'wc-answer:mode', mode: 'neon' });
  assert.equal(de.dataset.mode, 'dark', 'not an unknown mode');
  makeReady(p, $(p.doc, '.aw-allow'));
  for (const data of [{ type: 'wc-answer:decide', decision: { behavior: 'allow' } }, { type: 'click' }, 'allow', { type: 'wc-answer:size', height: 1 }]) send(data);
  await settle();
  assert.equal(decides(p).length, 0, 'nothing else a parent sends does anything');
  send({ type: 'wc-answer:mode', mode: 'light' });
  assert.equal(de.dataset.mode, 'light');
});

test('runtime: another kind\'s layout is a module of its own, loaded by name — a layout with no module falls back to saying the control is not available', async (t) => {
  // 'nolayout' passes the name check but has no control-nolayout.js, so the
  // import fails and answer.js's catch answers (control-stop.js says the same
  // words on its own, so the stop layout no longer reaches this path).
  const p = await openPage(t, { kind: 'control', id: 'interrupt', layout: 'nolayout', fetch: () => json({}) });
  assert.equal(p.handle.rt.kind, 'control');
  assert.ok(p.handle.error, 'the import failed and the catch answered');
  assert.equal(p.doc.getElementById('wc-answer').textContent, 'This control is not available here');
});

/* ══ masked questions end to end: the page, the surface, the domain, the hook ══ */

const FAKES = fakeSecrets({ seed: 560 });
const secretOf = (id) => FAKES.find((f) => f.id === id).secrets[0];
const SK = secretOf('sk-anthropic-api');
const SK_B = secretOf('sk-openai-legacy');
const SK_C = secretOf('sk-openai-project');
const SK_D = secretOf('sk-openrouter');
const SID = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function hostAudience() {
  const browser = (req) => !!(req.headers.origin || req.headers['sec-fetch-mode'] || req.headers['sec-fetch-site']);
  return { levelOf: () => 'local', isHost: (req) => !browser(req), requireMirror: () => (req, res, next) => next() };
}

// U53's real domain and routes (for the hook), U55's real surface (for the
// page), the real redactor and a local viewer.
async function rig(t) {
  const root = tmpRoot('wc-answerpage-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let surface = null;
  const asks = createAsks({
    bus: createBus(), hooks: createHookTap(), mirror: { subscribe: () => () => {}, conversationOfPid: () => 'conv_1' },
    getViewers: () => ({ local: 1 }), answerSurface: () => surface, redactor: createRedactor(), audit: () => {},
  });
  surface = createAnswerSurface({ asks, mainPort: () => 5999, audience: { levelOf: () => 'local' }, root });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  mountAskRoutes(app, { asks, audience: hostAudience(), answerSurface: () => surface });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const { origin } = await surface.ensure();
  t.after(async () => {
    asks.stop();
    await surface.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  writePortfileAt(path.join(root, '.web-chat'), { pid: process.pid, port: server.address().port });
  return { asks, surface, origin, root };
}

function hookEnv(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-answerpage-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_ENTRYPOINT: 'cli' };
  delete env.WEB_CHAT_HOOK_LOG;
  return env;
}

function spawnHook(t, root, questions) {
  const input = {
    session_id: SID, transcript_path: `/Users/someone/.claude/projects/-p/${SID}.jsonl`, cwd: root,
    hook_event_name: 'PermissionRequest', prompt_id: 'c0ffee00-prompt', permission_mode: 'default',
    tool_name: 'AskUserQuestion', tool_input: { questions },
  };
  const child = spawn(process.execPath, [HOOK_BIN, 'ask'], { cwd: root, env: hookEnv(t) });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stdin.on('error', () => {});
  const killer = setTimeout(() => child.kill('SIGKILL'), 20000);
  const done = new Promise((resolve) => child.on('close', (status) => { clearTimeout(killer); resolve({ status, stdout }); }));
  child.stdin.end(JSON.stringify(input));
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  return { child, done };
}

// The real page for the hook's ask, in jsdom, talking to the real surface as
// its browser would: same origin (Origin and Sec-Fetch-Site set as a browser
// sets them on its own page's fetch).
async function realPage(t, r, id) {
  const url = `${r.origin}/answer/ask/${id}?layout=card&mode=light&device=desktop`;
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const html = (await res.text()).replace(/<script[^>]*><\/script>/g, '');
  const fetchReal = (u, init = {}) => fetch(new URL(u, r.origin), {
    ...init, headers: { ...(init.headers || {}), Origin: r.origin, 'Sec-Fetch-Site': 'same-origin' },
  });
  const p = await openPage(t, { url, html, proof: true, fetch: fetchReal });
  await waitUntil(() => p.doc.querySelector('fieldset.aw-q'), { what: 'the question drawn', timeout: 5000 });
  return p;
}

async function hookAsk(t, r, questions) {
  const run = spawnHook(t, r.root, questions);
  let id = null;
  await waitUntil(() => {
    const a = r.asks.pending().find((x) => x.hook_attached);
    if (a) id = a.id;
    return id !== null;
  }, { what: 'the hook\'s ask, pending', timeout: 10000 });
  return { run, id };
}

// Pick in the page (option indexes per question, or {other}) and Send.
async function answerInPage(p, picks) {
  const qs = $$(p.doc, 'fieldset.aw-q');
  picks.forEach((pick, qi) => {
    if (pick.other !== undefined) {
      qs[qi].querySelector('.aw-other').click();
      qs[qi].querySelector('.aw-other-text').value = pick.other;
      return;
    }
    const boxes = qs[qi].querySelectorAll('input[type=checkbox]');
    if (boxes.length) {
      for (const i of pick) { boxes[i].checked = true; boxes[i].dispatchEvent(new p.W.Event('change')); }
    } else {
      qs[qi].querySelectorAll('button.aw-option:not(.aw-other)')[pick[0]].click();
    }
  });
  const send = $(p.doc, '.aw-send');
  makeReady(p, send);
  click(p, send);
  await waitUntil(() => decides(p).length === 1, { what: 'the decide', timeout: 5000 });
}

const answersOf = (stdout) => JSON.parse(stdout).hookSpecificOutput.decision.updatedInput;

test('masked questions end to end: the page shows each mask marked, a trusted click answers, the hook prints the unredacted texts', async (t) => {
  const r = await rig(t);
  const questions = [
    { header: 'Key', question: `Rotate ${SK} now?`, multiSelect: false,
      options: [{ label: `Yes, rotate ${SK_B}`, description: `old key ${SK_C}` }, { label: 'No', description: 'leave it' }] },
    { header: 'When', question: 'When?', multiSelect: false, options: [{ label: 'Now' }, { label: 'Later' }] },
  ];
  const { run, id } = await hookAsk(t, r, questions);
  const p = await realPage(t, r, id);
  const text = p.doc.body.textContent;
  for (const s of [SK, SK_B, SK_C]) assert.ok(!text.includes(s), 'no secret reaches the page');
  const q0 = $$(p.doc, 'fieldset.aw-q')[0];
  for (const sel of ['.aw-qtext', '.aw-olabel', '.aw-odesc']) {
    assert.ok(q0.querySelector(`${sel} mark.aw-mask`), `${sel}: masked and visibly marked`);
  }
  assert.ok($(p.doc, '.aw-masked'), 'and the masked line');
  await answerInPage(p, [[0], { other: 'tomorrow' }]);
  assert.deepEqual(decides(p)[0].body.decision, { behavior: 'answer', picks: [{ q: 0, options: [0] }, { q: 1, other: 'tomorrow' }] });
  const out = await run.done;
  assert.equal(out.status, 0);
  const input = answersOf(out.stdout);
  assert.deepEqual(input.questions, questions, 'the exact unredacted questions, labels and descriptions');
  assert.deepEqual(input.answers, { [`Rotate ${SK} now?`]: `Yes, rotate ${SK_B}`, 'When?': 'tomorrow' });
  await waitUntil(() => $(p.doc, '.aw-status'), { what: 'the frame to say it answered', timeout: 5000 });
});

test('masked questions end to end: a pick the hook cannot map leaves no output — the terminal prompt stands', async (t) => {
  // Two questions of one unredacted text are one answers key: the domain takes
  // the picks, the hook refuses to guess.
  const r = await rig(t);
  const twins = [
    { header: 'A', question: `Keep ${SK_B}?`, multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] },
    { header: 'B', question: `Keep ${SK_B}?`, multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] },
  ];
  const { run, id } = await hookAsk(t, r, twins);
  const p = await realPage(t, r, id);
  await answerInPage(p, [[0], [1]]);
  const out = await run.done;
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '', 'nothing printed');
});

test('texts that mask alike, from the page: two labels, two questions, a multiSelect label holding ", "', async (t) => {
  const r = await rig(t);
  const labelsAlike = [{ header: 'K', question: 'Which key?', multiSelect: false, options: [{ label: `key ${SK_B}` }, { label: `key ${SK_D}` }] }];
  for (const i of [1, 0]) {
    const { run, id } = await hookAsk(t, r, labelsAlike);
    const p = await realPage(t, r, id);
    const shown = $$(p.doc, 'button.aw-option:not(.aw-other)').map((b) => b.textContent);
    assert.equal(shown[0], shown[1], 'the two labels look the same in the frame');
    await answerInPage(p, [[i]]);
    assert.deepEqual(answersOf((await run.done).stdout).answers, { 'Which key?': labelsAlike[0].options[i].label });
  }

  const twins = [
    { header: 'A', question: `Keep ${SK_B}?`, multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] },
    { header: 'B', question: `Keep ${SK_D}?`, multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] },
  ];
  {
    const { run, id } = await hookAsk(t, r, twins);
    const p = await realPage(t, r, id);
    const texts = $$(p.doc, '.aw-qtext').map((e) => e.textContent);
    assert.equal(texts[0], texts[1], 'the two questions look the same');
    await answerInPage(p, [[1], [0]]);
    assert.deepEqual(answersOf((await run.done).stdout), { questions: twins, answers: { [`Keep ${SK_B}?`]: 'no', [`Keep ${SK_D}?`]: 'yes' } });
  }

  const multi = [{ header: 'M', question: 'Which?', multiSelect: true, options: [{ label: 'red, green' }, { label: 'blue' }, { label: 'red' }] }];
  {
    const { run, id } = await hookAsk(t, r, multi);
    const p = await realPage(t, r, id);
    await answerInPage(p, [[0, 1]]);
    assert.deepEqual(answersOf((await run.done).stdout).answers, { 'Which?': 'red, green, blue' });
  }
});
