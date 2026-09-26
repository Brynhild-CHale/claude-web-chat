// The page's REMOTE affordances (p6d), driven through the real front-end module
// graph in jsdom — the harness of test/service-trust-dismiss.test.js, booted
// with a daemon whose /api/health says `remote:true` (what it answers when the
// request came through the tunnel portal, which adds X-WC-Remote: 1).
//
// Remotely a viewer cannot install, approve or remove packs, nor approve a
// service (the portal refuses those routes, and service trust is terminal-only
// anywhere). So the page must not offer a control that can only 403: the
// Manage tab says where to do it and disables the pack write buttons, and the
// service-trust card says the command runs on the HOST, not the device in hand.
// Reading stays: the installed and quarantined lists still render.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');
const HEALTH = { ok: true, role: 'instance', remote: true };

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
    if (u === '/api/health') return json(HEALTH);
    if (u === '/api/packs') return json({
      packs: [{ name: 'demo-pack', tier: 'project', source: { via: 'tarball', sha: 'abcdef1234' }, components: ['demo'] }],
      quarantined: [{ name: 'waiting-pack', components: [], errors: [] }],
      pending: [],
    });
    if (u === '/api/services/pending') return json({ pending: [] });
    return json({ ok: true });
  };

  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'WheelEvent', 'FocusEvent', 'navigator', 'getComputedStyle', 'localStorage', 'sessionStorage', 'WebSocket', 'fetch',
    'HTMLElement', 'Node', 'Element'];
  // Node 21+ defines some of these (navigator) as GETTERS with no setter, so a
  // plain assignment is a silent no-op and the modules keep seeing Node's own.
  const aliasGlobal = (k, v) => {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch { try { global[k] = v; } catch {} }
  };
  for (const k of keys) { try { saved[k] = global[k]; } catch {} aliasGlobal(k, window[k]); }
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

// One shell for the file, booted in a hook so any single case can run alone
// (--test-name-pattern); each case below sets up what it reads.
before(async () => {
  await boot();
  await tick();
  WS.onmessage({ data: JSON.stringify({
    type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'test', mounts: [],
  }) });
  await tick();
});

test('the service-trust card says the command runs on the host machine', async () => {
  WS.onmessage({ data: JSON.stringify({
    type: 'service:trust', key: 'k-git', name: 'git-dashboard', hash: 'h', params: {},
    command: 'claude-web-chat trust git-dashboard',
  }) });
  await tick();
  const card = W.document.querySelector('#service-trust .svc-trust-card');
  assert.ok(card, 'the card rendered');
  assert.match(card.textContent, /viewing this surface remotely/);
  assert.match(card.textContent, /machine running web-chat/);
  assert.match(card.textContent, /claude-web-chat trust git-dashboard/, 'the command is still the command');
});

test('the Manage tab points pack changes at the host and disables the write buttons', async () => {
  const drawer = await import(pathToFileURL(path.join(REPO, 'public/app/drawer.js')).href);
  await drawer.openDrawerManage();
  await tick();
  const panel = W.document.getElementById('drawer-manage');
  assert.match(panel.textContent, /Manage packs on the host/);
  assert.match(panel.textContent, /claude-web-chat pack get/);
  assert.equal(panel.querySelector('#pk-url'), null, 'no install form to fill in and watch fail');
  assert.match(panel.textContent, /demo-pack/, 'the installed list still renders');
  assert.match(panel.textContent, /waiting-pack/, 'and the quarantined one');

  const byText = (t) => [...panel.querySelectorAll('button')].find((b) => b.textContent === t);
  for (const t of ['Remove', 'Install it', 'Discard']) {
    const b = byText(t);
    assert.ok(b, `${t} is shown`);
    assert.equal(b.disabled, true, `${t} is disabled remotely`);
    assert.match(b.title, /on the host/);
  }
  assert.equal(byText('Files…').disabled, false, 'reading a quarantined pack\u2019s files is still allowed');
});

after(() => { restore(); });
