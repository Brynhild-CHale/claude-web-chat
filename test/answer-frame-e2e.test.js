// The answer frame against clickjacking, in a REAL Chrome (spec §4.5's
// end-to-end cases): a harness page on a loopback port — the "chrome", which
// the answer surface allows as its frame ancestor (mainPort) — frames the real
// answer page from the real answer surface (U55), and dresses the frame the
// way a hostile pane could. In each of these Allow must stay disabled, and a
// trusted click (CDP Input.dispatchMouseEvent: the browser's own input) must
// decide nothing:
//   the frame at opacity .5 · an element over the buttons · an element over
//   only the subject · an ancestor clip-path hiding the subject · an ancestor
//   mask hiding it · an iframe smaller than its content
// and one more that proves the frame's palette is its own: a theme whose ink
// equals its background (a pane can write the project's theme) leaves the
// subject readable. Then, fully visible and after the dwell, a trusted click
// on Allow resolves the (fake) ask.
//
// It also runs the masked questions end to end (ruling A3 (a) with the
// maintainer's note) in the real browser: the real page, the real surface,
// the real asks domain with the real redactor and the ask hook as a
// subprocess — each mask marked, a trusted click answers, and the hook prints
// the exact unredacted texts, including texts that mask alike.
//
// No Claude and no terminal: only a Chrome. OPT-IN: it SKIPS unless
// WEB_CHAT_E2E_CHROME=1 (and a Chrome is found, or WEB_CHAT_CHROME names one):
//   WEB_CHAT_E2E_CHROME=1 node --test --test-timeout=60000 \
//     --import ./test-support/sandbox.js test/answer-frame-e2e.test.js
//
// The harness reads the frame's DOM through an isolated world of the frame's
// own context (Page.createIsolatedWorld): it sees the DOM, never the page's
// JS, and nothing it does is an input event. 127.0.0.1 on two ports is one
// site, so the frame is in the page's process (no out-of-process target).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');

const { e2eGate, tmpRoot, waitUntil } = require('../test-support/helpers');
const { launchChrome, closeAllBrowsers, liveBrowsers } = require('../lib/replay/chrome');
const { createAnswerSurface } = require('../lib/server/answer-surface');
const { createAsks } = require('../lib/server/domain/asks');
const { mountAskRoutes } = require('../lib/server/routes/asks');
const { createHookTap } = require('../lib/server/hook-tap');
const { createBus } = require('../lib/core/bus');
const { createRedactor } = require('../lib/core/redact');
const { projectPaths } = require('../lib/core/paths');
const { writePortfileAt } = require('../lib/core/portfiles');
const { fakeSecrets } = require('../test-support/fake-secrets');

const e2e = e2eGate(['chrome']);
const REPO = path.resolve(__dirname, '..');
const HOOK_BIN = path.join(REPO, 'bin', 'claude-web-chat-hook.js');
const ASK = 'ask_e2e000000001';
const W = 900;
const H = 700;

test.after(async () => {
  const up = liveBrowsers();
  await closeAllBrowsers();
  assert.equal(up, 0, `${up} browser(s) were still up when the file finished`);
});

// ── the fake asks domain: one pending permission ────────────────────────────
function fakeAsks() {
  const out = {
    decides: [],
    view: {
      id: ASK, kind: 'permission', tool_name: 'Bash', agent: null, state: 'pending', outcome: null, version: 1,
      subject: 'Bash(npm test)', masked: false, complete: true,
      detail: { permission: { fields: [{ name: 'command', value: 'npm test' }] } }, can_answer: true, why_not: null,
    },
    pending: () => (out.view.state === 'pending' ? [{ id: ASK }] : []),
    displayView: (id) => (id === ASK ? { ...out.view } : null),
    waitView(id, version, wait) {
      if (id !== ASK) return Promise.resolve(null);
      if (version !== out.view.version || !wait) return Promise.resolve({ ...out.view });
      return new Promise((r) => setTimeout(() => r({ ...out.view }), Math.min(wait, 1000)));
    },
    decide(id, decision, meta) {
      out.decides.push({ id, decision, meta });
      out.view = { ...out.view, state: 'decided', outcome: 'allowed', version: out.view.version + 1, can_answer: false, why_not: 'resolved' };
      return { ok: true, state: 'decided', outcome: 'allowed', version: out.view.version };
    },
    noteRefusal() {},
  };
  return out;
}

// ── the harness: the "chrome" page that frames the answer page ──────────────
// /?src=<frame url>&frame=<css for the iframe>&wrap=<css for its parent>&over=<css for an overlay>
function harness(t) {
  const page = (q) => {
    const src = String(q.get('src') || '');
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const over = q.get('over') ? `<div id="over" style="position:absolute;${esc(q.get('over'))}"></div>` : '';
    return `<!doctype html><html><body style="margin:0;background:#fff">
<div id="wrap" style="position:absolute;left:20px;top:20px;${esc(q.get('wrap') || '')}">
<iframe id="f" src="${esc(src)}" referrerpolicy="no-referrer" style="display:block;border:0;width:420px;height:320px;${esc(q.get('frame') || '')}"></iframe>
</div>${over}</body></html>`;
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://harness.invalid');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page(u.searchParams));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
      resolve(server.address().port);
    });
  });
}

// ── CDP ─────────────────────────────────────────────────────────────────────
async function openTab(cdp, { width = W, height = H } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  return sessionId;
}
async function navigate(cdp, sid, url) {
  const loaded = cdp.once('Page.loadEventFired', { sessionId: sid });
  const nav = await cdp.send('Page.navigate', { url }, sid);
  if (nav.errorText) throw new Error(`could not load ${url}: ${nav.errorText}`);
  await loaded;
}
async function evaluate(cdp, sid, expression, contextId) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) }, sid);
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.text}`);
  return r.result ? r.result.value : undefined;
}
// An isolated world in the answer frame: its DOM, none of its script.
async function frameWorld(cdp, sid, origin) {
  let frameId = null;
  await waitUntil(async () => {
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, sid);
    const kid = (frameTree.childFrames || []).find((f) => f.frame.url.startsWith(origin));
    frameId = kid ? kid.frame.id : null;
    return frameId !== null;
  }, { what: 'the answer frame', timeout: 10000 });
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'wc-e2e' }, sid);
  return executionContextId;
}
// The centre of `sel` inside the frame, in the top page's coordinates.
async function pointOf(cdp, sid, ctx, sel) {
  const inner = await evaluate(cdp, sid, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
    const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`, ctx);
  if (!inner) return null;
  const outer = await evaluate(cdp, sid, '(() => { const r = document.getElementById("f").getBoundingClientRect(); return { x: r.left, y: r.top }; })()');
  return { x: outer.x + inner.x, y: outer.y + inner.y };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function mouseTo(cdp, sid, p) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }, sid);
}
// A trusted click, as the browser's own input: press and release.
async function trustedClick(cdp, sid, p) {
  await mouseTo(cdp, sid, p);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }, sid);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }, sid);
}
const harnessUrl = (port, src, opts = {}) => {
  const u = new URL(`http://127.0.0.1:${port}/`);
  u.searchParams.set('src', src);
  for (const k of ['frame', 'wrap', 'over']) if (opts[k]) u.searchParams.set(k, opts[k]);
  return u.href;
};

// ── the clickjacking cases ──────────────────────────────────────────────────

const COVERED_CASES = [
  ['the frame at opacity .5', { frame: 'opacity:.5' }],
  ['an element over the buttons', { over: 'left:20px;top:150px;width:420px;height:190px;background:#fff' }],
  ['an element over only the subject', { over: 'left:20px;top:20px;width:420px;height:110px;background:#fff' }],
  ['an ancestor clip-path hiding the subject', { wrap: 'clip-path:inset(110px 0 0 0)' }],
  ['an ancestor mask hiding the subject', { wrap: '-webkit-mask-image:linear-gradient(to bottom,transparent 110px,#000 110px);mask-image:linear-gradient(to bottom,transparent 110px,#000 110px)' }],
  ['an iframe smaller than its content', { frame: 'height:60px' }],
];

test('real Chrome: Allow stays disabled however a pane dresses the frame; fully visible, a trusted click after the dwell allows', { skip: e2e.skip, timeout: 180000 }, async (t) => {
  const root = tmpRoot('wc-answer-e2e-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A theme a pane could have written: ink = background. The frame ignores it.
  const pp = projectPaths(root);
  fs.mkdirSync(path.dirname(pp.theme), { recursive: true });
  fs.writeFileSync(pp.theme, JSON.stringify({ name: 'decoy', tokens: { '--wc-fg': '#ffffff', '--wc-panel-bg': '#ffffff', '--wc-bg': '#ffffff' } }));

  const port = await harness(t);
  const asks = fakeAsks();
  const surface = createAnswerSurface({ asks, mainPort: () => port, audience: { levelOf: () => 'local' }, root });
  t.after(() => surface.close());
  const { origin } = await surface.ensure();
  const src = `${origin}/answer/ask/${ASK}?layout=card&mode=light&device=desktop`;

  const browser = launchChrome({ chromePath: e2e.chrome, tmpDir: root });
  t.after(() => browser.close());
  const { cdp } = browser;
  const sid = await openTab(cdp);

  for (const [name, dress] of COVERED_CASES) {
    await navigate(cdp, sid, harnessUrl(port, src, dress));
    const ctx = await frameWorld(cdp, sid, origin);
    await waitUntil(() => evaluate(cdp, sid, '!!document.querySelector(".aw-allow")', ctx), { what: `${name}: the frame drawn`, timeout: 10000 });
    const p = await pointOf(cdp, sid, ctx, '.aw-allow');
    await mouseTo(cdp, sid, p);
    await sleep(1500);   // past the proof's 500 ms, the dwell and the cooldown
    assert.equal(await evaluate(cdp, sid, 'document.querySelector(".aw-allow").getAttribute("aria-disabled")', ctx), 'true', `${name}: Allow disabled`);
    await trustedClick(cdp, sid, p);
    await sleep(300);
    assert.equal(asks.decides.length, 0, `${name}: a trusted click decided nothing`);
    t.diagnostic(`${name}: disabled (${await evaluate(cdp, sid, 'document.querySelector(".aw").dataset.guard', ctx)})`);
  }

  // Fully visible, after the dwell: Allow resolves the ask.
  await navigate(cdp, sid, harnessUrl(port, src));
  const ctx = await frameWorld(cdp, sid, origin);
  await waitUntil(() => evaluate(cdp, sid, '!!document.querySelector(".aw-allow")', ctx), { what: 'the frame drawn', timeout: 10000 });
  // The decoy theme changed nothing: the subject's ink is not its background.
  const ink = await evaluate(cdp, sid, `(() => { const c = document.querySelector('pre.aw-code');
    const s = getComputedStyle(c); return { fg: s.color, bg: s.backgroundColor }; })()`, ctx);
  assert.notEqual(ink.fg, ink.bg, 'the subject is readable whatever the project theme says');
  const p = await pointOf(cdp, sid, ctx, '.aw-allow');
  await mouseTo(cdp, sid, p);
  await waitUntil(() => evaluate(cdp, sid, 'document.querySelector(".aw-allow").getAttribute("aria-disabled") === "false"', ctx),
    { what: 'Allow enabled once fully visible', timeout: 5000 });
  await sleep(700);
  await trustedClick(cdp, sid, p);
  await waitUntil(() => asks.decides.length === 1, { what: 'the decide', timeout: 5000 });
  assert.deepEqual(asks.decides[0].decision, { behavior: 'allow' });
  assert.equal(asks.decides[0].meta.version, 1);
  assert.equal(asks.decides[0].meta.device, 'desktop');
});

// ── masked questions end to end, in the browser ─────────────────────────────

const FAKES = fakeSecrets({ seed: 561 });
const secretOf = (id) => FAKES.find((f) => f.id === id).secrets[0];
const SK = secretOf('sk-anthropic-api');
const SK_B = secretOf('sk-openai-legacy');
const SK_C = secretOf('sk-openai-project');
const SK_D = secretOf('sk-openrouter');
const SID = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

async function rig(t, port) {
  const root = tmpRoot('wc-answer-e2e-q-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let surface = null;
  const asks = createAsks({
    bus: createBus(), hooks: createHookTap(), mirror: { subscribe: () => () => {}, conversationOfPid: () => 'conv_1' },
    getViewers: () => ({ local: 1 }), answerSurface: () => surface, redactor: createRedactor(), audit: () => {},
  });
  surface = createAnswerSurface({ asks, mainPort: () => port, audience: { levelOf: () => 'local' }, root });
  const browserish = (req) => !!(req.headers.origin || req.headers['sec-fetch-mode'] || req.headers['sec-fetch-site']);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  mountAskRoutes(app, { asks, audience: { levelOf: () => 'local', isHost: (req) => !browserish(req) }, answerSurface: () => surface });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const { origin } = await surface.ensure();
  t.after(async () => {
    asks.stop();
    await surface.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  writePortfileAt(path.join(root, '.web-chat'), { pid: process.pid, port: server.address().port });
  return { asks, origin, root };
}

function hookAsk(t, r, questions) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-answer-e2e-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_ENTRYPOINT: 'cli' };
  delete env.WEB_CHAT_HOOK_LOG;
  const child = spawn(process.execPath, [HOOK_BIN, 'ask'], { cwd: r.root, env });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stdin.on('error', () => {});
  const killer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const done = new Promise((resolve) => child.on('close', (status) => { clearTimeout(killer); resolve({ status, stdout }); }));
  child.stdin.end(JSON.stringify({
    session_id: SID, transcript_path: `/Users/someone/.claude/projects/-p/${SID}.jsonl`, cwd: r.root,
    hook_event_name: 'PermissionRequest', prompt_id: 'c0ffee00-prompt', permission_mode: 'default',
    tool_name: 'AskUserQuestion', tool_input: { questions },
  }));
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  return done;
}

// Load the hook's ask in the harness, click the picks (option indexes per
// question) and Send, all as the browser's own input.
async function answerInChrome(cdp, sid, port, r, picks) {
  let id = null;
  await waitUntil(() => {
    const a = r.asks.pending().find((x) => x.hook_attached);
    if (a) id = a.id;
    return id !== null;
  }, { what: 'the hook\'s ask', timeout: 10000 });
  const src = `${r.origin}/answer/ask/${id}?layout=card&mode=light&device=desktop`;
  // Room for the whole card: a request that does not fit keeps Send disabled.
  await navigate(cdp, sid, harnessUrl(port, src, { frame: 'height:900px;width:560px' }));
  const ctx = await frameWorld(cdp, sid, r.origin);
  await waitUntil(() => evaluate(cdp, sid, '!!document.querySelector(".aw-send")', ctx), { what: 'the question drawn', timeout: 10000 });
  const page = await evaluate(cdp, sid, `(() => ({
    text: document.body.textContent,
    marks: [...document.querySelectorAll('fieldset.aw-q')].map((q) => ({
      qtext: !!q.querySelector('.aw-qtext mark.aw-mask'),
      label: [...q.querySelectorAll('.aw-olabel')].map((e) => !!e.querySelector('mark.aw-mask')),
      desc: [...q.querySelectorAll('.aw-odesc')].map((e) => !!e.querySelector('mark.aw-mask')),
      labels: [...q.querySelectorAll('.aw-olabel')].map((e) => e.textContent),
      qtextText: q.querySelector('.aw-qtext').textContent,
    })),
  }))()`, ctx);
  for (let qi = 0; qi < picks.length; qi++) {
    for (const oi of picks[qi]) {
      const sel = `fieldset.aw-q:nth-of-type(${qi + 1}) [data-o="${oi}"]`;
      await trustedClick(cdp, sid, await pointOf(cdp, sid, ctx, sel));
    }
  }
  const send = await pointOf(cdp, sid, ctx, '.aw-send');
  await mouseTo(cdp, sid, send);
  await waitUntil(() => evaluate(cdp, sid, 'document.querySelector(".aw-send").getAttribute("aria-disabled") === "false"', ctx),
    { what: 'Send enabled', timeout: 5000 });
  await sleep(700);
  await trustedClick(cdp, sid, send);
  return page;
}

const answersOf = (stdout) => JSON.parse(stdout).hookSpecificOutput.decision.updatedInput;

test('real Chrome: masked questions — each mask marked, a trusted click answers, the hook prints the unredacted texts; texts that mask alike told apart', { skip: e2e.skip, timeout: 240000 }, async (t) => {
  const port = await harness(t);
  const r = await rig(t, port);
  const browser = launchChrome({ chromePath: e2e.chrome, tmpDir: r.root });
  t.after(() => browser.close());
  const { cdp } = browser;
  const sid = await openTab(cdp, { width: 1000, height: 1000 });

  // The question text, a label and a description hold secrets.
  const questions = [
    { header: 'Key', question: `Rotate ${SK} now?`, multiSelect: false,
      options: [{ label: `Yes, rotate ${SK_B}`, description: `old key ${SK_C}` }, { label: 'No', description: 'leave it' }] },
    { header: 'When', question: 'When?', multiSelect: false, options: [{ label: 'Now' }, { label: 'Later' }] },
  ];
  let done = hookAsk(t, r, questions);
  const page = await answerInChrome(cdp, sid, port, r, [[0], [1]]);
  for (const s of [SK, SK_B, SK_C]) assert.ok(!page.text.includes(s), 'no secret reaches the frame');
  assert.equal(page.marks[0].qtext, true, 'the question text marked');
  assert.equal(page.marks[0].label[0], true, 'the label marked');
  assert.equal(page.marks[0].desc[0], true, 'the description marked');
  assert.equal(page.marks[0].label[1], false, 'an unmasked label is not');
  let out = await done;
  assert.equal(out.status, 0);
  assert.deepEqual(answersOf(out.stdout), { questions, answers: { [`Rotate ${SK} now?`]: `Yes, rotate ${SK_B}`, 'When?': 'Later' } });

  // Two labels that mask alike.
  const alike = [{ header: 'K', question: 'Which key?', multiSelect: false, options: [{ label: `key ${SK_B}` }, { label: `key ${SK_D}` }] }];
  done = hookAsk(t, r, alike);
  const shown = await answerInChrome(cdp, sid, port, r, [[1]]);
  assert.equal(shown.marks[0].labels[0], shown.marks[0].labels[1], 'they look the same in the frame');
  out = await done;
  assert.deepEqual(answersOf(out.stdout).answers, { 'Which key?': `key ${SK_D}` });

  // Two questions that mask alike.
  const twins = [
    { header: 'A', question: `Keep ${SK_B}?`, multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] },
    { header: 'B', question: `Keep ${SK_D}?`, multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] },
  ];
  done = hookAsk(t, r, twins);
  const tw = await answerInChrome(cdp, sid, port, r, [[1], [0]]);
  assert.equal(tw.marks[0].qtextText, tw.marks[1].qtextText);
  out = await done;
  assert.deepEqual(answersOf(out.stdout).answers, { [`Keep ${SK_B}?`]: 'no', [`Keep ${SK_D}?`]: 'yes' });

  // A multiSelect label that holds ', '.
  const multi = [{ header: 'M', question: 'Which?', multiSelect: true, options: [{ label: 'red, green' }, { label: 'blue' }, { label: 'red' }] }];
  done = hookAsk(t, r, multi);
  await answerInChrome(cdp, sid, port, r, [[0, 1]]);
  out = await done;
  assert.deepEqual(answersOf(out.stdout).answers, { 'Which?': 'red, green, blue' });
});
