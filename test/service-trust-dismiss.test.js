// The service-trust notice, driven through the REAL front-end module graph in
// jsdom (one boot per test FILE — see test/client-boot.test.js for the harness).
//
// The defect: the card said "<name> is waiting for approval" and had no way to
// close it. It is informational and non-blocking by design, but an advisory you
// cannot put down is nagging.
//
// The constraint that shapes the fix: DISMISSING MUST NOT MEAN DENYING. Consent
// is a filesystem decision made by `claude-web-chat trust <name>` in a terminal,
// precisely because a component's own pane script runs in this page (see
// public/app/service-trust.js). So the × hides the card for this browser session
// and touches nothing on the server — and a request for a DIFFERENT component
// still speaks up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

const calls = [];
let W = null, WS = null, restore = () => {};

async function boot() {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8')
    .replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;

  const wsInstances = [];
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; wsInstances.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send() {}
    close() {}
  };
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    const u = String(url);
    if (u === '/api/graph') return json({ nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }], active: 'n1' });
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.3.0', updateAvailable: false });
    if (u.startsWith('/api/theme')) return json({ name: 'web-chat' });
    return json({ ok: true });
  };

  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'WheelEvent', 'FocusEvent', 'getComputedStyle', 'localStorage', 'sessionStorage', 'WebSocket', 'fetch',
    'HTMLElement', 'Node', 'Element'];
  for (const k of keys) { try { saved[k] = global[k]; global[k] = window[k]; } catch {} }
  const savedSetInterval = global.setInterval;
  global.setInterval = () => 0;
  global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  window.__wcMount = require(path.join(REPO, 'public/mount-runtime.js'));

  await import(pathToFileURL(path.join(REPO, 'public/app/main.js')).href);

  restore = () => {
    for (const k of keys) { try { global[k] = saved[k]; } catch {} }
    global.setInterval = savedSetInterval;
    window.close();
  };
  W = window;
  WS = wsInstances[0];
}

const tick = () => new Promise((r) => setTimeout(r, 25));
const host = () => W.document.getElementById('service-trust');
const cards = () => [...(host() ? host().querySelectorAll('.svc-trust-card') : [])];
const announce = (hash, name) => WS.onmessage({ data: JSON.stringify({
  type: 'service:trust', hash, name, command: `claude-web-chat trust ${name}`,
}) });

test('boot', async () => {
  await boot();
  await tick();
  WS.onmessage({ data: JSON.stringify({
    type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'test', mounts: [],
  }) });
  await tick();
});

test('a waiting service raises a card, and the card offers a dismiss control', async () => {
  announce('h-git', 'git-dashboard');
  await tick();
  assert.equal(cards().length, 1, 'the notice appeared');
  assert.ok(!host().classList.contains('hidden'), 'and its host is visible');
  const x = cards()[0].querySelector('[data-dismiss]');
  assert.ok(x, 'the card has a dismiss control');
  assert.match(x.getAttribute('title') || '', /not deny/i,
    'the control says what it is NOT — hiding a consent prompt must never read as refusing it');
  assert.match(cards()[0].textContent, /--deny/,
    'and the card still names the only thing that actually refuses the request');
});

test('dismissing hides the card without denying anything', async () => {
  calls.length = 0;
  cards()[0].querySelector('[data-dismiss]').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(cards().length, 0, 'the card is gone');
  assert.ok(host().classList.contains('hidden'), 'and the host with it');
  assert.deepEqual(calls, [], 'dismissing talks to the server not at all — the request stays pending');
  const stored = JSON.parse(W.sessionStorage.getItem('wc:svc-trust-dismissed') || '[]');
  assert.deepEqual(stored, ['h-git'], 'the dismissal is remembered per REQUEST, for this session only');
});

test('re-announcing the SAME request stays dismissed', async () => {
  announce('h-git', 'git-dashboard');
  await tick();
  assert.equal(cards().length, 0,
    'the server re-announces on every viewer connect; that must not defeat the dismissal');
});

test('a NEW request for a different component still speaks up', async () => {
  announce('h-file', 'file-editor');
  await tick();
  assert.equal(cards().length, 1, 'a different pending service is a different decision');
  assert.match(cards()[0].textContent, /file-editor/);
  assert.equal(cards()[0].getAttribute('data-hash'), 'h-file');
});

test('a blocked sessionStorage cannot kill the notice (private window)', async () => {
  // version.js is the precedent: a private window makes the ACCESSOR itself throw,
  // which would otherwise abort module bootstrap and leave a dead page.
  const real = Object.getOwnPropertyDescriptor(W, 'sessionStorage');
  Object.defineProperty(W, 'sessionStorage', {
    configurable: true,
    get() { throw new Error('SecurityError: access denied'); },
  });
  global.sessionStorage = undefined;
  try {
    announce('h-boom', 'noisy');
    await tick();
    // All three pending requests render: with storage unreadable there is no
    // dismissal record to honour, so the earlier h-git dismissal quietly lapses.
    // Failing OPEN is the right direction for a consent prompt.
    assert.equal(cards().length, 3, 'the notice still renders when storage is unreadable');
    cards().find((c) => c.getAttribute('data-hash') === 'h-boom')
      .querySelector('[data-dismiss]').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
    await tick();
    assert.equal(cards().length, 3,
      'and an unwritable dismissal simply does not stick — it never throws');
  } finally {
    if (real) Object.defineProperty(W, 'sessionStorage', real);
    global.sessionStorage = W.sessionStorage;
  }
});

test('teardown', () => { restore(); });
