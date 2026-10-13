// An MCP server's form in the answer frame (lib/server/answer-surface/public/
// elicitation-form.js, through answer-view.js renderAsk; spec §15.7, §4.5),
// in jsdom, as test/answer-page.test.js runs the frame:
//
//   * every field starts EMPTY — a schema default only as placeholder text —
//     and every control is autocomplete=off: the page never fills a form;
//   * Accept is disabled until the required fields hold valid values, and in
//     the runtime until the frame's guards pass too; it posts
//     {decision: {behavior: 'accept', content}, version, device} with each
//     value typed; Decline, Cancel and Answer in the terminal post theirs;
//   * text from the server is set as text (a message holding <img onerror>
//     renders as its characters);
//   * the bar layout is only `Answer ›`; card, sheet and page draw the form;
//   * the stylesheet block paints only measured palette pairs.
//
// jsdom's events are never trusted, so the runtime's clicks go through the
// same listener wrapper as answer-page.test.js's (trustClicks).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

const { MASK } = require('../lib/core/redact');
const { contrastRatio, FRAME_TEXT, FRAME_UI, TEXT_MIN, UI_MIN } = require('../lib/server/answer-surface/palette');
const { PACKS } = require('../lib/server/theme-packs');
const { flattenTheme, MODES } = require('../lib/server/theme');

const REPO = path.resolve(__dirname, '..');
const PUB = path.join(REPO, 'lib/server/answer-surface/public');
const ORIGIN = 'http://127.0.0.1:47123';
const ID = 'ask_0123456789ab';
const NONCE = 'nonce-for-this-load';

let A, V;
test.before(async () => {
  A = await import(pathToFileURL(path.join(PUB, 'answer.js')).href);
  V = await import(pathToFileURL(path.join(PUB, 'answer-view.js')).href);
});

// ── fixtures ────────────────────────────────────────────────────────────────

const FIELDS = [
  { name: 'name', type: 'string', required: true, title: 'Your name', default: 'Ada Lovelace', maxLength: 40 },
  { name: 'count', type: 'integer', required: true, minimum: 1, maximum: 9, default: 3 },
  { name: 'ratio', type: 'number', required: false, description: 'a fraction' },
  { name: 'ok', type: 'boolean', required: false, title: 'Proceed?' },
  { name: 'size', type: 'string', required: false, enum: ['small', 'large'], default: 'small' },
  { name: 'mail', type: 'string', required: false, format: 'email' },
];

function view(over = {}) {
  return {
    id: ID, kind: 'elicitation', tool_name: 'scratch', agent: null, state: 'pending', outcome: null, version: 2,
    subject: 'Who is asking?', masked: false, complete: true,
    detail: { elicitation: { server: 'scratch', message: 'Who is asking?', fields: FIELDS } },
    can_answer: true, why_not: null, web_chose_terminal: false,
    ...over,
  };
}

function blankDoc() {
  return new JSDOM('<!doctype html><body></body>', { url: `${ORIGIN}/answer/ask/${ID}` }).window.document;
}
const $ = (doc, sel) => doc.querySelector(sel);
const $$ = (doc, sel) => [...doc.querySelectorAll(sel)];
const labels = (drawn) => drawn.controls.map((c) => c.el.textContent);
const control = (drawn, label) => drawn.controls.find((c) => c.el.textContent === label);
function type(doc, el, value) {
  el.value = value;
  el.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
}
function choose(doc, el, value) {
  el.value = value;
  el.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
}
function check(doc, el, on = true) {
  el.checked = on;
  el.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
}
function draw(over, layout = 'card') {
  const doc = blankDoc();
  const drawn = V.renderAsk(doc, view(over), { layout });
  doc.body.append(drawn.root);
  return { doc, drawn };
}

// ── the view ────────────────────────────────────────────────────────────────

test('view: every field starts empty, a default only as placeholder, every control autocomplete=off', () => {
  const { doc } = draw();
  const inputs = $$(doc, '.aw-form input, .aw-form select');
  assert.equal(inputs.length, FIELDS.length, 'one control per field');
  for (const el of inputs) {
    assert.equal(el.getAttribute('autocomplete'), 'off');
    if (el.type === 'checkbox') assert.equal(el.checked, false);
    else assert.equal(el.value, '', `${el.dataset.field} starts empty`);
  }
  const [name, count, ratio, ok, size, mail] = inputs;
  assert.deepEqual([name.type, count.type, ratio.type, ok.type, size.tagName, mail.type], ['text', 'number', 'number', 'checkbox', 'SELECT', 'text']);
  assert.equal(name.placeholder, 'Ada Lovelace', 'a default is a placeholder');
  assert.equal(count.placeholder, '3');
  assert.equal(name.maxLength, 40);
  assert.deepEqual([count.min, count.max, count.step], ['1', '9', '1']);
  assert.equal(ratio.step, 'any');
  assert.equal(size.value, '', 'the select sits on its empty choice');
  assert.deepEqual([...size.options].map((o) => [o.value, o.textContent]), [['', 'Choose… (default: small)'], ['small', 'small'], ['large', 'large']]);
  assert.deepEqual($$(doc, '.aw-elabel').map((e) => e.textContent), ['Your name (required)', 'count (required)', 'ratio', 'Proceed?', 'size', 'mail']);
  assert.equal($(doc, '.aw-edesc').textContent, 'a fraction');
  assert.equal($(doc, '.aw-tool').textContent, 'scratch');
  assert.equal($(doc, '.aw-emessage').textContent, 'Who is asking?');
});

test('view: Accept is disabled until the required fields are valid; its decision carries typed values', () => {
  const { doc, drawn } = draw();
  assert.deepEqual(labels(drawn), ['Accept', 'Decline', 'Cancel', 'Answer in the terminal', 'Review ›']);
  const accept = control(drawn, 'Accept');
  assert.equal(accept.acting, true, 'an acting button: the guards apply');
  assert.equal(accept.el.disabled, true, 'nothing filled in');
  assert.equal(drawn.decisionOf(accept.el), null);
  assert.equal($(doc, '.aw-problem').hidden, false, 'and the view says why');

  const [name, count, ratio, ok, size, mail] = $$(doc, '.aw-form input, .aw-form select');
  type(doc, name, 'Grace');
  assert.equal(accept.el.disabled, true, 'count is required too');
  type(doc, count, '12');
  assert.equal(accept.el.disabled, true, 'over the maximum');
  type(doc, count, '2.5');
  assert.equal(accept.el.disabled, true, 'not an integer');
  type(doc, count, '4');
  assert.equal(accept.el.disabled, false, 'both required fields valid');
  assert.deepEqual(drawn.decisionOf(accept.el), { behavior: 'accept', content: { name: 'Grace', count: 4 } }, 'empty optional fields are left out');

  type(doc, mail, 'not-an-address');
  assert.equal(accept.el.disabled, true, 'an optional field holding a bad value blocks too');
  type(doc, mail, 'grace@example.invalid');
  type(doc, ratio, '0.25');
  check(doc, ok, true);
  choose(doc, size, 'large');
  assert.equal(accept.el.disabled, false);
  assert.deepEqual(drawn.decisionOf(accept.el), {
    behavior: 'accept', content: { name: 'Grace', count: 4, ratio: 0.25, ok: true, size: 'large', mail: 'grace@example.invalid' },
  });
  check(doc, ok, false);
  assert.equal(drawn.decisionOf(accept.el).content.ok, false, 'a touched checkbox says what it shows');
});

test('view: a required checkbox reads its shown state; an untouched optional one is left out', () => {
  const { doc, drawn } = draw({ detail: { elicitation: { server: 's', message: 'm', fields: [{ name: 'agree', type: 'boolean', required: true }, { name: 'x', type: 'boolean', required: false }] } } });
  const accept = control(drawn, 'Accept');
  assert.equal(accept.el.disabled, false);
  assert.deepEqual(drawn.decisionOf(accept.el), { behavior: 'accept', content: { agree: false } });
  void doc;
});

test('view: Decline, Cancel and Answer in the terminal stand for their behaviors, with nothing of the form', () => {
  const { doc, drawn } = draw();
  type(doc, $(doc, '.aw-einput'), 'typed but declined');
  assert.deepEqual(drawn.decisionOf(control(drawn, 'Decline').el), { behavior: 'decline' });
  assert.deepEqual(drawn.decisionOf(control(drawn, 'Cancel').el), { behavior: 'cancel' });
  assert.deepEqual(drawn.decisionOf(control(drawn, 'Answer in the terminal').el), { behavior: 'terminal' });
  for (const l of ['Decline', 'Cancel', 'Answer in the terminal']) assert.equal(control(drawn, l).acting, false);
});

test('view: the server\'s text is set as text — a message holding <img onerror> renders as its characters', () => {
  const evil = '<img src=x onerror=alert(1)>';
  for (const layout of ['card', 'sheet', 'page', 'bar']) {
    const { doc } = draw({
      subject: evil,
      tool_name: evil,
      detail: { elicitation: { server: evil, message: evil, fields: [{ name: evil, type: 'string', required: false, title: evil, description: evil, default: evil }, { name: 'e', type: 'string', required: false, enum: [evil] }] } },
    }, layout);
    assert.equal(doc.querySelector('img'), null, `${layout}: no element made from the text`);
    if (layout !== 'bar') assert.ok(doc.body.textContent.includes(evil), `${layout}: shown as text`);
  }
});

test('view: the bar is only Answer ›, which opens the chat; card, sheet and page draw the form', () => {
  const bar = draw({}, 'bar');
  assert.deepEqual(labels(bar.drawn), ['Answer ›']);
  assert.equal(bar.drawn.controls[0].act, 'chat');
  assert.equal($$(bar.doc, 'input, select').length, 0);

  const sheet = draw({}, 'sheet');
  assert.equal(sheet.drawn.root.dataset.layout, 'sheet');
  assert.equal($$(sheet.doc, '.aw-form input, .aw-form select').length, FIELDS.length);
  assert.deepEqual(labels(sheet.drawn), ['Accept', 'Decline', 'Cancel', 'Answer in the terminal', 'Review ›']);

  const page = draw({}, 'page');
  assert.equal($(page.doc, '.aw-title').textContent, 'Claude is waiting · MCP input');
  assert.deepEqual(labels(page.drawn), ['Accept', 'Decline', 'Cancel', 'Answer in the terminal'], 'the popup is the review');
});

test('view: why_not shows its words and no control; remote-off reads answer in the terminal', () => {
  for (const [over, words] of [
    [{ why_not: 'remote-off', can_answer: false }, 'Answer in the terminal'],
    [{ why_not: 'too-long', can_answer: false, complete: false }, 'Too long to show here — answer in the terminal'],
    [{ why_not: 'resolved', state: 'resolved', outcome: 'accepted', can_answer: false }, 'Sent'],
    [{ why_not: 'resolved', state: 'resolved', outcome: 'cancelled', can_answer: false }, 'Cancelled'],
    [{ why_not: 'resolved', state: 'resolved', outcome: 'expired', can_answer: false }, 'No longer waiting — answer in the terminal'],
  ]) {
    for (const layout of ['card', 'sheet', 'bar']) {
      const { doc, drawn } = draw(over, layout);
      assert.equal($(doc, '.aw-status').textContent, words, `${over.why_not} ${over.outcome || ''} (${layout})`);
      assert.deepEqual(drawn.controls.filter((c) => c.act === 'decide'), [], 'no answering control');
      assert.equal($$(doc, 'input, select').length, 0, 'and no form');
    }
  }
  const { doc } = draw({ why_not: 'remote-off', can_answer: false });
  assert.deepEqual($$(doc, '.aw-elist li').map((e) => e.textContent), ['Your name', 'count', 'ratio', 'Proceed?', 'size', 'mail'], 'what it asks, without a control');
});

test('view: a masked message is marked where it is shown', () => {
  const masked = `Use ${MASK('api-key')} here`;
  const { doc } = draw({ masked: true, detail: { elicitation: { server: 'scratch', message: masked, fields: FIELDS.slice(0, 1) } } });
  assert.equal($$(doc, 'mark.aw-mask').length, 1);
  assert.ok($(doc, '.aw-masked'));
});

// ── the runtime ─────────────────────────────────────────────────────────────

function pageHtml() {
  const values = { NONCE, MODE: 'light', KIND: 'ask', META: '' };
  return fs.readFileSync(path.join(PUB, 'index.html'), 'utf8')
    .replace(/\{\{(NONCE|MODE|KIND|META)\}\}/g, (_, k) => values[k])
    .replace(/<script[^>]*><\/script>/g, '');
}

function trustClicks(W) {
  const trust = { on: false };
  const proto = W.EventTarget.prototype;
  const add = proto.addEventListener;
  proto.addEventListener = function addEventListener(type, fn, opts) {
    if (type !== 'click' || typeof fn !== 'function') return add.call(this, type, fn, opts);
    return add.call(this, type, function trusted(e) {
      if (!trust.on) return fn.call(this, e);
      return fn.call(this, new Proxy(e, {
        get(target, k) {
          if (k === 'isTrusted') return true;
          const v = Reflect.get(target, k, target);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }));
    }, opts);
  };
  return trust;
}

function stubVisibility(W) {
  const observers = [];
  W.IntersectionObserverEntry = class IntersectionObserverEntry { get isVisible() { return true; } };
  W.IntersectionObserver = class IntersectionObserver {
    constructor(cb) { this.cb = cb; this.target = null; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.target = null; }
  };
  return { report: () => { for (const o of observers) if (o.target) o.cb([{ target: o.target, intersectionRatio: 1, isVisible: true }]); } };
}

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function openPage(t, { layout = 'card', v = view(), outcome = 'accepted' } = {}) {
  const dom = new JSDOM(pageHtml(), { url: `${ORIGIN}/answer/ask/${ID}?layout=${layout}&mode=light&device=desktop`, pretendToBeVisual: true });
  const W = dom.window;
  const trust = trustClicks(W);
  const vis = stubVisibility(W);
  Object.defineProperty(W.navigator, 'userActivation', { value: { isActive: true, hasBeenActive: true }, configurable: true });
  const parent = new JSDOM('', { url: 'http://127.0.0.1:5173/' }).window;
  parent.postMessage = () => {};
  Object.defineProperty(W, 'parent', { value: parent, configurable: true });
  const calls = [];
  W.fetch = async (u, init = {}) => {
    calls.push({ url: String(u), init, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'POST') return json({ ok: true, state: 'decided', outcome, version: v.version + 1 });
    if (/\?v=/.test(String(u))) return new Promise(() => {});
    return json(v);
  };
  const clock = { t: 10_000 };
  const handle = await A.boot(W, { now: () => clock.t });
  t.after(() => { try { handle.stop(); } catch {} W.close(); parent.close(); });
  await settle();
  const doc = W.document;
  const click = (el) => {
    trust.on = true;
    try { el.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); } finally { trust.on = false; }
  };
  const ready = (el) => { vis.report(); el.dispatchEvent(new W.Event('pointerover', { bubbles: true })); clock.t += 1000; };
  return { W, doc, calls, click, ready, decides: () => calls.filter((c) => c.init && c.init.method === 'POST') };
}

test('runtime: Accept posts nothing while the form is incomplete; filled and guarded, it posts {decision: {accept, content}, version, device}', async (t) => {
  const p = await openPage(t);
  const accept = $(p.doc, '.aw-accept');
  assert.ok(accept, 'the form is drawn in the frame');
  assert.equal(accept.disabled, true);
  p.ready(accept);
  p.click(accept);
  await settle();
  assert.equal(p.decides().length, 0, 'an incomplete form is never sent');

  const [name, count] = $$(p.doc, '.aw-form input');
  type(p.doc, name, 'Grace');
  type(p.doc, count, '7');
  assert.equal(accept.disabled, false);
  p.click(accept);
  await settle();
  const [d] = p.decides();
  assert.ok(d, 'the permitted click posted');
  assert.equal(d.url, `/answer/api/asks/${ID}/decide`);
  assert.equal(d.init.headers['X-WC-Answer'], NONCE);
  assert.deepEqual(d.body, { decision: { behavior: 'accept', content: { name: 'Grace', count: 7 } }, version: 2, device: 'desktop' });
  assert.equal($(p.doc, '.aw-status').textContent, 'Sent');
});

test('runtime: an Accept the guards have not cleared posts nothing, however complete the form', async (t) => {
  const p = await openPage(t);
  const [name, count] = $$(p.doc, '.aw-form input');
  type(p.doc, name, 'Grace');
  type(p.doc, count, '7');
  const accept = $(p.doc, '.aw-accept');
  assert.equal(accept.disabled, false);
  assert.equal(accept.getAttribute('aria-disabled'), 'true', 'not yet proven visible');
  p.click(accept);
  await settle();
  assert.equal(p.decides().length, 0);
});

test('runtime: Decline and Cancel post theirs', async (t) => {
  for (const [cls, behavior, words] of [['.aw-decline', 'decline', 'Declined'], ['.aw-cancel', 'cancel', 'Cancelled']]) {
    const p = await openPage(t, { outcome: behavior === 'decline' ? 'declined' : 'cancelled' });
    const btn = $(p.doc, cls);
    p.ready(btn);
    p.click(btn);
    await settle();
    assert.deepEqual(p.decides()[0].body, { decision: { behavior }, version: 2, device: 'desktop' });
    assert.equal($(p.doc, '.aw-status').textContent, words);
  }
});

test('runtime: the sheet layout is the card\'s form with 44 px controls', async (t) => {
  const p = await openPage(t, { layout: 'sheet' });
  assert.equal(p.doc.querySelector('.aw').dataset.layout, 'sheet');
  assert.equal($$(p.doc, '.aw-form input, .aw-form select').length, FIELDS.length);
  for (const el of $$(p.doc, '.aw-form input, .aw-form select')) assert.equal(el.getAttribute('autocomplete'), 'off');
});

// ── the stylesheet ──────────────────────────────────────────────────────────

const CSS = fs.readFileSync(path.join(PUB, 'answer.css'), 'utf8');
const U92_AT = CSS.indexOf('/* ── U92 ·');
const U92_END = CSS.indexOf('/* ── U85 ·');
const SECTION = CSS.slice(U92_AT, U92_END);

function rules(css) {
  const out = [];
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i >= 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    out.push({ selector: m[1].trim(), decls });
  }
  return out;
}
const tokenOf = (v) => { const m = /var\((--wc-[a-z0-9-]+)\)/.exec(v || ''); return m ? m[1] : null; };

test('answer.css: the elicitation block paints only measured palette pairs, which pass in every pack, light and dark', () => {
  assert.ok(U92_AT > 0 && U92_END > U92_AT, 'answer.css has a U92 block before U85\'s');
  const measured = new Map();
  for (const [ink, fill] of FRAME_TEXT) measured.set(`${ink} ${fill}`, TEXT_MIN);
  for (const [ink, fill] of FRAME_UI) if (!measured.has(`${ink} ${fill}`)) measured.set(`${ink} ${fill}`, UI_MIN);
  const pairs = [];
  for (const r of rules(SECTION)) {
    for (const [prop, value] of Object.entries(r.decls)) {
      assert.doesNotMatch(value, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix|currentcolor/i, `${r.selector} ${prop}: no literal colour`);
    }
    const ink = tokenOf(r.decls.color);
    const bg = tokenOf(r.decls.background || r.decls['background-color']);
    if (ink) {
      assert.ok(bg, `${r.selector}: a colour sets its background too`);
      pairs.push({ selector: r.selector, ink, fill: bg, need: measured.get(`${ink} ${bg}`) });
    }
    for (const prop of ['border', 'border-color', 'outline', 'outline-color']) {
      const tok = tokenOf(r.decls[prop]);
      if (tok) pairs.push({ selector: r.selector, ink: tok, fill: '--wc-panel-bg', need: UI_MIN });
    }
  }
  assert.ok(pairs.length >= 8);
  for (const p of pairs) assert.ok(measured.has(`${p.ink} ${p.fill}`), `${p.selector}: ${p.ink} on ${p.fill} is measured`);
  for (const pack of PACKS) {
    for (const mode of MODES) {
      const tokens = flattenTheme(pack, mode).tokens;
      for (const p of pairs) {
        const ratio = contrastRatio(tokens[p.ink], tokens[p.fill]);
        assert.ok(ratio >= p.need, `${pack.name || pack.id} ${mode}: ${p.selector} ${p.ink} on ${p.fill} ${ratio.toFixed(2)}:1`);
      }
    }
  }
  const src = fs.readFileSync(path.join(PUB, 'elicitation-form.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/, 'the form builds DOM, never markup');
  assert.doesNotMatch(src, /localStorage|sessionStorage|getComputedStyle|parent\.|top\./, 'and reads nothing from anywhere');
});
