// The replay document (lib/server/replay/document.js), its player
// (lib/server/replay/player.js) and the two routes that serve it.
//
// What must hold:
//   - escaping: a prompt, a reply, a pane's html or a theme's css can carry
//     `</script>`, `</style>`, `<!--` or U+2028 and the document still parses to
//     exactly its own two scripts, with the payload decoding back byte-exact;
//   - privacy: the payload carries only the caption text it shows, never a
//     node's trigger, and — unless include_prompts — no prompt text at all
//     (checked by grepping the document's bytes);
//   - containment: /replay is served under PREVIEW_CSP (errors too) and the
//     document names no network API of its own;
//   - the controller is deterministic: seek(ms) draws the same thing whatever
//     came before, windows its frames to prev/current/next, and resolves only
//     after the frames it shows are ready.

const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const { withServer } = require('../test-support/helpers');
const { PREVIEW_CSP } = require('../lib/core/cors');
const { previewTemplate, renderPreviewHtml } = require('../lib/server/preview');
const {
  assembleReplay, normalizeReplayOpts, playerSource,
} = require('../lib/server/replay/document');
const player = require('../lib/server/replay/player');

const NASTY = 'a </script><script>alert(1)</script> b </style> c <!-- d \u2028 e \u2029 f & <b>';

function step(i, extra = {}) {
  return {
    id: `n${i}`, label: `n1.${i}`, author: 'claude', kind: 'turn',
    prompt: `prompt ${i}`, summary: `sum ${i}`, reply: null,
    folded_count: 0, created_at: 1000 * i, dt_from_prev: i ? 1000 : null,
    theme: 0,
    node: { id: `n${i}`, mounts: [{ id: 'p', html: `<p>step ${i}</p>`, params: {} }], store: { i } },
    ...extra,
  };
}

// Parse the document without running it; hand back its scripts + payload.
function parse(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const scripts = [...doc.querySelectorAll('script')];
  const data = doc.getElementById('wc-replay-data');
  return { dom, doc, scripts, payload: JSON.parse(data.textContent) };
}

// ── the pure assembler ──────────────────────────────────────────────────────

test('replay doc: nasty prompts, replies, pane html and theme css cannot break out', () => {
  const steps = [
    step(0, { prompt: NASTY, reply: NASTY, node: { id: 'n0', mounts: [{ id: 'p', html: NASTY, params: { title: NASTY } }], store: { s: NASTY } } }),
    step(1),
  ];
  const themes = [{ tokens: { '--wc-bg': '#123456' }, css: `body{} ${NASTY}` }];
  const html = assembleReplay({ steps, themes, opts: normalizeReplayOpts({ include_prompts: true }), meta: {} });

  const { scripts, payload, doc } = parse(html);
  assert.equal(scripts.length, 2, 'exactly the payload + the player — nothing injected');
  assert.equal(doc.querySelectorAll('style').length, 1);
  assert.equal(payload.steps[0].caption.prompt, NASTY, 'the prompt decodes back byte-exact');
  assert.equal(payload.steps[0].caption.reply, NASTY);
  assert.ok(!/\u2028|\u2029/.test(html), 'no raw line separators anywhere in the source');

  // The frame a step becomes is the preview document itself — the same bytes
  // /preview/node would serve for that node under that theme.
  const [a, b, c] = payload.frame;
  const frame = a + payload.themes[0] + b + payload.steps[0].node + c;
  assert.equal(frame, renderPreviewHtml(steps[0].node, themes[0]));
  const f = parse(frame.replace('<head>', '<head><script id="wc-replay-data" type="application/json">{}</script>'));
  assert.equal(f.scripts.length, 4, 'the filled frame holds its own three scripts — Escape relay, runtime, node (+ the probe) — the pane html stayed data');
  assert.equal(f.doc.querySelectorAll('style').length, 1, 'the theme css did not close the style element');
});

test('replay doc: without include_prompts NO prompt text is anywhere in the bytes; with it, the caption shows it', () => {
  const steps = [step(0, { prompt: 'SECRET-PROMPT and more', summary: 'SECRET-PROMPT', reply: 'the reply' })];
  const node = { ...steps[0].node, trigger: { message: 'SECRET-PROMPT and more', summary: 'SECRET-PROMPT' } };
  steps[0].node = node;
  const build = (q) => assembleReplay({ steps, themes: [{}], opts: normalizeReplayOpts(q) });

  // Off — the default, and what every retired caption mode now means.
  for (const q of [{}, { captions: 'on' }, { captions: 'prompt' }, { captions: 'summary' }, { include_prompts: '0' }]) {
    const html = build(q);
    assert.ok(!html.includes('SECRET-PROMPT'), `${JSON.stringify(q)}: no prompt, and no 100-char prefix of one, anywhere in the file`);
    assert.ok(!html.includes('"trigger"'));
    const { payload } = parse(html);
    assert.deepEqual(payload.steps[0].caption, { reply: 'the reply' }, 'the caption is Claude\'s reply alone');
    assert.equal(payload.opts.include_prompts, false);
  }

  const none = build({ captions: 'none', include_prompts: '1' });
  assert.ok(!none.includes('SECRET-PROMPT'), 'captions:none ships the prompt nowhere — even with include_prompts');
  assert.ok(!none.includes('the reply'));
  assert.match(none, /class="rp-nocap"/);

  const full = parse(build({ include_prompts: '1' })).payload.steps[0].caption;
  assert.deepEqual(full, { prompt: 'SECRET-PROMPT and more', reply: 'the reply' });
  // a node with no prompt (a preserve) still captions from its trigger summary when prompts are on
  const pre = [step(0, { prompt: '', summary: 'auto-preserved', reply: null })];
  assert.deepEqual(parse(assembleReplay({ steps: pre, themes: [{}], opts: normalizeReplayOpts({ include_prompts: true }) })).payload.steps[0].caption, { prompt: 'auto-preserved' });
  assert.deepEqual(parse(assembleReplay({ steps: pre, themes: [{}], opts: normalizeReplayOpts({}) })).payload.steps[0].caption, {});
});

test('replay doc: names no network API, and the player splices safely', () => {
  const html = assembleReplay({ steps: [step(0)], themes: [{}], opts: normalizeReplayOpts({}) });
  for (const bad of [/ws:\/\//, /wss:\/\//, /new WebSocket/, /\bfetch\(/, /XMLHttpRequest/, /EventSource/, /sendBeacon/]) {
    assert.doesNotMatch(html, bad, `the replay document must not reference ${bad}`);
  }
  assert.equal(/<\/?script/i.test(playerSource()), false, 'no script tag literal in the player source');
  assert.equal(/<\/?style/i.test(playerSource()), false, 'no style tag literal in the player source');
});

test('replay doc: options normalize to safe values', () => {
  const d = normalizeReplayOpts({});
  assert.deepEqual(
    [d.hold_ms, d.pacing, d.transition, d.captions, d.include_prompts, d.size, d.chrome, d.speed, d.autoplay, d.at],
    [2500, 'hold', 'cut', 'on', false, { w: 1280, h: 800 }, true, 1, false, null],
  );
  const o = normalizeReplayOpts({
    hold_ms: '99', pacing: 'realtime', transition: 'fade', captions: 'none', include_prompts: '1',
    size: '9999x10', chrome: '0', speed: '9', autoplay: '1', at: '3',
  });
  assert.equal(o.hold_ms, 500, 'hold clamps to 0.5 s');
  assert.equal(o.pacing, 'realtime');
  assert.equal(o.transition, 'fade');
  assert.equal(o.captions, 'none');
  assert.equal(o.include_prompts, true);
  assert.deepEqual(o.size, { w: 3840, h: 240 });
  assert.equal(o.chrome, false);
  assert.equal(o.speed, 4);
  assert.equal(o.autoplay, true);
  assert.equal(o.at, 3);
  assert.equal(normalizeReplayOpts({ captions: '<x>', transition: 'wipe', pacing: 'x' }).captions, 'on');
  assert.equal(normalizeReplayOpts({ captions: 'prompt' }).include_prompts, false, 'the retired mode does not turn prompts on');
});

// ── the controller (pure, stubbed frames) ───────────────────────────────────

function stubEnv() {
  let now = 0;
  const q = [];
  return {
    env: {
      now: () => now,
      raf: (fn) => { q.push(fn); return q.length; },
      caf: () => {},
      // unref'd: a seek whose stub frame is never loaded holds its 8 s
      // frame-timeout open, and that must not hold the test process.
      setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); h.unref(); return h; },
      clearTimeout: (id) => clearTimeout(id),
    },
    advance(ms) { now += ms; const run = q.splice(0); run.forEach((fn) => fn(now)); },
    flushRaf() { let n = 0; while (q.length && n++ < 50) q.splice(0).forEach((fn) => fn(now)); },
  };
}

function stubFactory() {
  const made = [];
  const live = new Map();
  const make = (s, i) => {
    let resolve;
    const h = {
      i, ready: new Promise((r) => { resolve = r; }), load: () => resolve(),
      shown: null, destroyed: false,
      show(op, layer) { h.shown = { op, layer }; },
      destroy() { h.destroyed = true; live.delete(i); },
    };
    made.push(h);
    live.set(i, h);
    return h;
  };
  return { make, made, live };
}

const steps5 = [0, 1, 2, 3, 4].map((i) => ({ label: `n1.${i}`, dt_from_prev: i ? 1500 * i : null }));

test('controller: timeline — hold, realtime pacing clamped 1–6 s, fades', () => {
  const hold = player.timeline(steps5, { hold_ms: 2000 });
  assert.deepEqual(hold.spans.map((s) => s.start), [0, 2000, 4000, 6000, 8000]);
  assert.equal(hold.total, 10000);

  // realtime: a step is held for the gap to the NEXT one, clamped; the last gets the hold.
  const rt = player.timeline([{ dt_from_prev: null }, { dt_from_prev: 200 }, { dt_from_prev: 60000 }, { dt_from_prev: 2500 }],
    { hold_ms: 3000, pacing: 'realtime' });
  assert.deepEqual(rt.spans.map((s) => s.dur), [1000, 6000, 2500, 3000]);

  const fade = player.timeline(steps5, { hold_ms: 2000, transition: 'fade' });
  assert.equal(fade.spans[0].fade, 0, 'the first step has nothing to fade over');
  assert.equal(fade.spans[1].fade, player.FADE_MS);
  assert.equal(player.timeline(steps5, { hold_ms: 500, transition: 'fade' }).spans[1].fade, 200, 'a fade takes at most 40% of a short hold');
});

test('controller: seek windows frames to prev/current/next and waits for the ones it shows', async () => {
  const { env, flushRaf } = stubEnv();
  const f = stubFactory();
  const ctl = player.createController({ steps: steps5, opts: { hold_ms: 1000 }, makeFrame: f.make, env });

  let done = false;
  const p = ctl.seek(2500).then((r) => { done = true; return r; });
  assert.deepEqual([...f.live.keys()].sort(), [1, 2, 3], 'only the window around step 2 exists');
  assert.equal(f.live.get(2).shown.layer, 2);
  assert.equal(f.live.get(2).shown.op, 1);
  assert.equal(f.live.get(1).shown.layer, 0, 'a cut shows nothing under the current step');

  // Long past two animation frames and the settle — still waiting on the frame.
  for (let k = 0; k < 3; k++) { flushRaf(); await new Promise((r) => setTimeout(r, 40)); }
  flushRaf();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(done, false, 'seek does not resolve before its frame is ready');
  f.live.get(2).load();
  await new Promise((r) => setImmediate(r));
  flushRaf();                                  // two animation frames…
  await new Promise((r) => setImmediate(r));
  flushRaf();
  const r = await p;                           // …then the settle
  assert.equal(done, true);
  assert.deepEqual(r, { t: 2500, index: 2 });

  // Jump far: the old window is destroyed, the new one built — only 3 live.
  ctl.seek(4999);
  assert.deepEqual([...f.live.keys()].sort(), [3, 4]);
  assert.ok(f.made.filter((h) => h.i === 1)[0].destroyed, 'frames outside the window are torn down');
});

test('controller: seek is deterministic — the same ms draws the same state from anywhere', () => {
  const draw = (path) => {
    const { env } = stubEnv();
    const f = stubFactory();
    const ctl = player.createController({ steps: steps5, opts: { hold_ms: 1000, transition: 'fade' }, makeFrame: f.make, env });
    for (const ms of path) ctl.seek(ms);
    const shown = [...f.live.entries()].sort((a, b) => a[0] - b[0]).map(([i, h]) => [i, h.shown]);
    return { state: ctl.state(), shown };
  };
  const direct = draw([1200]);
  assert.deepEqual(draw([4000, 0, 3100, 1200]), direct);
  // Mid-fade: step 1 at half opacity over step 0.
  assert.equal(direct.state.index, 1);
  assert.equal(direct.state.alpha, 0.5);
  assert.deepEqual(direct.shown.find(([i]) => i === 0)[1], { op: 1, layer: 1 });
  assert.deepEqual(direct.shown.find(([i]) => i === 1)[1], { op: 0.5, layer: 2 });
});

test('controller: play advances by the clock × speed and stops at the end; stepBy lands past the fade', async () => {
  const { env, advance } = stubEnv();
  const f = stubFactory();
  const ctl = player.createController({ steps: steps5, opts: { hold_ms: 1000, transition: 'fade', speed: 2 }, makeFrame: f.make, env });
  ctl.play();
  advance(600);
  assert.equal(ctl.state().t, 1200, 'speed 2 → 600 ms of clock is 1200 ms of replay');
  assert.equal(ctl.state().playing, true);
  advance(10000);
  assert.equal(ctl.state().t, 5000);
  assert.equal(ctl.state().playing, false, 'play stops at the end');
  ctl.play();
  assert.equal(ctl.state().t, 0, 'play from the end starts over');
  ctl.pause();

  ctl.stepBy(2);
  assert.equal(ctl.state().index, 2);
  assert.equal(ctl.state().alpha, 1, 'a step lands fully faded in, not on its bare start');
  ctl.stepBy(-1);
  assert.equal(ctl.state().index, 1);
  ctl.stepBy(-10);
  assert.equal(ctl.state().index, 0, 'clamped at the first step');
});

// ── the whole document in a DOM, with a stubbed frame factory ───────────────

test('replay doc boots in a DOM: __wcReplay drives seek, captions and the scrubber', async () => {
  const steps = [0, 1, 2].map((i) => step(i, { reply: i === 1 ? 'reply one' : null, folded_count: i === 2 ? 3 : 0 }));
  const html = assembleReplay({ steps, themes: [{}], opts: normalizeReplayOpts({ hold_ms: 1000, include_prompts: '1' }) });
  const made = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.__wcReplayFrameFactory = (s, i) => {
        const h = { i, ready: Promise.resolve(), show() {}, destroy() { h.gone = true; } };
        made.push(h);
        return h;
      };
    },
  });
  const w = dom.window;
  const api = w.__wcReplay;
  assert.ok(api, 'window.__wcReplay is installed');
  assert.equal(api.steps.length, 3);
  assert.equal(api.duration(), 3000);
  assert.equal(w.document.querySelectorAll('.rp-tick').length, 3, 'one scrubber tick per step');
  assert.equal(w.document.querySelectorAll('.rp-tick')[1].title, 'n1.1', 'ticks carry the step label on hover');

  const r = await api.seek(1500);
  assert.deepEqual(r, { t: 1500, index: 1 });
  const $ = (id) => w.document.getElementById(id);
  assert.equal($('rp-cap-label').textContent, 'n1.1');
  assert.equal($('rp-cap-text').textContent, 'prompt 1');
  assert.equal($('rp-cap-text').hidden, false);
  assert.equal($('rp-cap-time').textContent, new Date(1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), "the node's time");
  assert.equal($('rp-cap-reply').textContent, 'reply one');
  assert.equal($('rp-cap-reply').hidden, false);
  assert.equal($('rp-count').textContent, '2 / 3');

  await api.seek(2999);
  assert.equal($('rp-cap-folded').textContent, '+3 folded');
  assert.equal($('rp-cap-reply').hidden, true, 'a step with no reply shows no reply line');
  assert.ok(made.length <= 4 && made.filter((h) => !h.gone).length <= 3, 'frames stay windowed');
  dom.window.close();
});

test('replay doc without prompts: the caption is the label, the time and Claude\'s reply — no prompt line', async () => {
  const steps = [0, 1].map((i) => step(i, { reply: i === 1 ? 'reply one' : null }));
  const html = assembleReplay({ steps, themes: [{}], opts: normalizeReplayOpts({ hold_ms: 1000 }) });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(win) { win.__wcReplayFrameFactory = () => ({ ready: Promise.resolve(), show() {}, destroy() {} }); },
  });
  const w = dom.window;
  const $ = (id) => w.document.getElementById(id);
  await w.__wcReplay.seek(1500);
  assert.equal($('rp-cap-label').textContent, 'n1.1');
  assert.notEqual($('rp-cap-time').textContent, '', 'the time is shown');
  assert.equal($('rp-cap-text').textContent, '');
  assert.equal($('rp-cap-text').hidden, true, 'no prompt line at all');
  assert.equal($('rp-cap-reply').textContent, 'reply one');
  assert.equal($('rp-cap-reply').hidden, false);
  dom.window.close();
});

// ── the routes ──────────────────────────────────────────────────────────────

async function seed(api) {
  await api.post('/api/render', { id: 'm1', html: '<p>one</p>' });
  await api.post('/api/commit', { message: 'first </script> prompt' });
  await api.post('/api/render', { id: 'm1', html: '<p>two</p>' });
  await api.post('/api/commit', { message: 'second prompt' });
}

test('GET /replay serves the document under PREVIEW_CSP — its errors too', async (t) => {
  const { api, port } = await withServer(t);
  await seed(api);
  const res = await fetch(`http://localhost:${port}/replay?include_prompts=1&chrome=0`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-security-policy'), PREVIEW_CSP);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  const { payload, doc } = parse(html);
  assert.equal(payload.steps.length, 2);
  assert.equal(payload.opts.chrome, false);
  assert.match(doc.body.className, /rp-bare/);
  assert.equal(payload.steps[0].caption.prompt, 'first </script> prompt');
  assert.deepEqual(payload.frame, [...previewTemplate()]);

  const bad = await fetch(`http://localhost:${port}/replay?to=nope`);
  assert.equal(bad.status, 404);
  assert.equal(bad.headers.get('content-security-policy'), PREVIEW_CSP, 'the policy is not a function of which branch ran');
  const notAnc = await fetch(`http://localhost:${port}/replay?from=n1&to=n0`);
  assert.equal(notAnc.status, 400);
});

test('GET /api/replay/html is the same document as an attachment', async (t) => {
  const { api, port } = await withServer(t);
  await seed(api);
  const res = await fetch(`http://localhost:${port}/api/replay/html?from=n0&to=n1`);
  assert.equal(res.status, 200);
  const cd = res.headers.get('content-disposition');
  assert.match(cd, /^attachment; filename="replay-[\w-]+_[\w-]+\.html"$/);
  assert.equal(res.headers.get('content-security-policy'), PREVIEW_CSP);
  const { payload } = parse(await res.text());
  assert.deepEqual(payload.steps.map((s) => s.id), ['n0', 'n1']);

  const missing = await fetch(`http://localhost:${port}/api/replay/html?to=nope`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'not-found');
});

test('/replay and /api/replay/html carry no prompt text unless include_prompts=1 — grepped in the bytes', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'm1', html: '<p>one</p>' });
  await api.post('/api/commit', { message: 'PRIVATE-ALPHA ' + 'x'.repeat(150) });
  await api.post('/api/render', { id: 'm1', html: '<p>two</p>' });
  await api.post('/api/commit', { message: 'PRIVATE-BETA' });
  for (const route of ['/replay', '/api/replay/html']) {
    for (const q of ['', '?captions=prompt', '?captions=summary', '?include_prompts=0']) {
      const body = await (await fetch(`http://localhost:${port}${route}${q}`)).text();
      assert.ok(!/PRIVATE-(ALPHA|BETA)/.test(body), `${route}${q}: no prompt text in the bytes`);
    }
    const on = await (await fetch(`http://localhost:${port}${route}?include_prompts=1`)).text();
    assert.match(on, /PRIVATE-ALPHA/, `${route}: include_prompts=1 puts them in`);
    assert.match(on, /PRIVATE-BETA/);
  }
});

// ── markdown in the frames ──────────────────────────────────────────────────
// A replay frame is the ONE preview document (lib/server/preview), so a node's
// page sequence — prose between and around its panes — plays exactly as the
// glance preview draws it: in page order, rendered by lib/core/markdown on the
// host, escaped, and edited from one step to the next.

// Fill step `i`'s frame the way the player does, and run it.
function runFrame(payload, i) {
  const [a, b, c] = payload.frame;
  const s = payload.steps[i];
  const dom = new JSDOM(a + payload.themes[s.theme] + b + s.node + c, { runScripts: 'dangerously' });
  const main = dom.window.document.getElementById('main');
  // markdown blocks, and the panes of each grid run (.page-run) in turn
  const items = [...main.children].flatMap((el) => (el.classList.contains('md-block')
    ? [{ md: el.getAttribute('data-md-id'), html: el.innerHTML }]
    : [...el.querySelectorAll('.mount-host')].map((h) => ({ pane: h.id }))));
  dom.window.close();
  return items;
}

test('replay frames show markdown: in page order, escaped, and as it was at each step', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'p', html: '<p>pane</p>' });
  await api.post('/api/markdown', { id: 'intro', text: '## First <b>take</b>', after: 'start' });
  await api.post('/api/commit', { message: 'one' });
  await api.post('/api/markdown', { id: 'intro', text: '## Second take' });
  await api.post('/api/markdown', { id: 'outro', text: 'the *end*' });
  await api.post('/api/commit', { message: 'two' });

  const { payload } = parse(await (await fetch(`http://localhost:${port}/replay?from=n0&to=n1`)).text());
  assert.equal(payload.steps.length, 2);
  assert.deepEqual(runFrame(payload, 0), [
    { md: 'intro', html: '<h2 data-slug="first-b-take-b">First &lt;b&gt;take&lt;/b&gt;</h2>' },
    { pane: 'p' },
  ], 'step 1: the prose sits above the pane, its markup escaped');
  assert.deepEqual(runFrame(payload, 1), [
    { md: 'intro', html: '<h2 data-slug="second-take">Second take</h2>' },
    { pane: 'p' },
    { md: 'outro', html: '<p>the <em>end</em></p>' },
  ], 'step 2: the edit and the new prose play forward');
  assert.ok(!JSON.stringify(payload.steps).includes('"markdown"'), 'frames carry the rendered page, not the raw markdown twice');
});

test('replay frame = the node preview: the same bytes for a node with markdown', () => {
  const s = step(0);
  const { id, mounts, store } = s.node; // (in the frame's own key order)
  s.node = { id, mounts, markdown: [{ id: 'h', text: '# Hi' }], order: ['p', 'h'], store };
  const html = assembleReplay({ steps: [s], themes: [{}], opts: normalizeReplayOpts({}) });
  const { payload } = parse(html);
  const [a, b, c] = payload.frame;
  assert.equal(a + payload.themes[0] + b + payload.steps[0].node + c, renderPreviewHtml(s.node, {}));
  assert.deepEqual(JSON.parse(payload.steps[0].node).page, [{ pane: 'p' }, { md: 'h', html: '<h1 data-slug="hi">Hi</h1>' }]);
});
