// The browser half of the machine-wide sessions view: GET /api/machine/sessions
// (lib/server/routes/machine.js) and the Sessions panel that draws it
// (public/app/sessions.js). The classifier itself — presence rows, sessions(),
// enrichSessions() — is pinned in test/sessions.test.js; this file pins what the
// route adds on top and what the page does with it:
//   * one row per project, in all three shapes (Claude only, surface only, both),
//     with the page's own project marked current and never listed as stopped;
//   * a stopped surface carries the command that would start it — the page
//     never starts one — and $HOME reads as `~`;
//   * the panel opens from ⋯, ⌘K and S, renders every state as TEXT, opens a
//     running surface in a new tab, offers a copy button for a stopped one,
//     refreshes while open and stops once dismissed.
//
// Every server test runs under a throwaway HOME (withServer / withTempHome).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const { withServer, withTempHome } = require('../test-support/helpers');
const registry = require('../lib/util/registry');
const { openCommand, shellQuote, displayRoot } = require('../lib/server/routes/machine');

const REPO = path.resolve(__dirname, '..');

function dirIn(t, parent, name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(parent, `wc-ms-${name}-`)));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// A live pid that is not this process, to hang a second presence row off.
function bystander(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  return child;
}

// ───────────────────────────────────────────────────────── the route ────

test('GET /api/machine/sessions: Claude-only, surface-only and both, current marked, home as ~', async (t) => {
  const home = fs.realpathSync(withTempHome(t));
  const { api, port, root } = await withServer(t);
  const here = path.resolve(root);

  // This project: its daemon (the server under test) plus one Claude session.
  registry.registerInstance({ root: here, port, pid: process.pid, title: 'here' });
  const other = bystander(t);
  registry.registerMcp({ root: here, pid: other.pid, ppid: process.pid, channel: true });
  // A Claude session with no surface — inside HOME, so it displays as ~/….
  const claudeOnly = dirIn(t, home, 'claude-only');
  registry.registerMcp({ root: claudeOnly, pid: process.pid, ppid: process.ppid });
  // A daemon with no Claude — registered on a port nothing answers.
  const surfaceOnly = dirIn(t, os.tmpdir(), 'surface-only');
  registry.registerInstance({ root: surfaceOnly, port: 1, pid: process.pid, title: 'surface-only' });

  const r = await api.get('/api/machine/sessions');
  assert.equal(r.status, 200);
  const body = r.json;
  assert.equal(body.ok, true);
  assert.equal(body.current, here);
  assert.equal(typeof body.now, 'number');
  const by = Object.fromEntries(body.sessions.map((s) => [s.root, s]));
  assert.equal(body.sessions.length, 3);

  const mine = by[here];
  assert.equal(mine.current, true);
  assert.equal(mine.surface.reachable, true, 'the daemon answering is probed like any other');
  assert.equal(mine.surface.port, port);
  assert.equal(mine.surface.viewers, 0);
  assert.equal(mine.claude.sessions, 1);
  assert.equal(mine.claude.channel, true);
  assert.equal(mine.open_cmd, null, 'a running surface needs no start command');

  const c = by[claudeOnly];
  assert.equal(c.current, false);
  assert.equal(c.surface, null);
  assert.equal(c.claude.sessions, 1);
  assert.equal(c.open_cmd, openCommand(claudeOnly));
  assert.match(c.open_cmd, /claude-web-chat open$/);
  assert.equal(c.display_root, `~${path.sep}${path.basename(claudeOnly)}`);

  const s = by[surfaceOnly];
  assert.equal(s.claude, null);
  assert.equal(s.surface.reachable, false, 'unreachable is reported, never dropped');
  assert.equal(s.open_cmd, null);
  assert.equal(s.display_root, surfaceOnly, 'outside HOME the root is shown whole');

  // The lock shows through as a turn badge's input.
  await api.post('/api/turn-begin', { message: 'go' });
  const again = (await api.get('/api/machine/sessions')).json;
  assert.equal(again.sessions.find((x) => x.current).surface.turn, 'mid-turn');
});

test('GET /api/machine/sessions: the answering daemon lists itself as running even when unregistered', async (t) => {
  const { api, port, root } = await withServer(t);
  // Nothing registered at all: a lost registry write must not show the page the
  // user is looking at as a stopped surface with a start command.
  const body = (await api.get('/api/machine/sessions')).json;
  assert.equal(body.sessions.length, 1);
  const [row] = body.sessions;
  assert.equal(row.root, path.resolve(root));
  assert.equal(row.current, true);
  assert.equal(row.surface.running, true);
  assert.equal(row.surface.port, port);
  assert.equal(row.surface.reachable, true);
  assert.equal(row.claude, null);
  assert.equal(row.open_cmd, null);
});

test('openCommand / displayRoot: quote what needs quoting; ~ only for a path inside HOME', (t) => {
  assert.equal(shellQuote('/Users/me/Dev/app'), '/Users/me/Dev/app');
  assert.equal(shellQuote("/tmp/it's here"), `'/tmp/it'\\''s here'`);
  assert.equal(shellQuote('/tmp/$HOME x'), `'/tmp/$HOME x'`);
  assert.equal(openCommand('/tmp/a b'), `cd '/tmp/a b' && claude-web-chat open`);

  const home = dirIn(t, os.tmpdir(), 'home');
  assert.equal(displayRoot(path.join(home, 'proj'), home), `~${path.sep}proj`);
  assert.equal(displayRoot(home, home), '~');
  assert.equal(displayRoot(`${home}-sibling/proj`, home), `${home}-sibling/proj`, 'a prefix is not a parent');
  assert.equal(displayRoot('/elsewhere', null), '/elsewhere');
});

// ───────────────────────────────────────────────────────── the panel ────

const NOW = 1_000_000_000;
const ROWS = () => ({
  ok: true,
  now: NOW,
  current: '/home/me/here',
  sessions: [
    { root: '/home/me/here', display_root: '~/here', title: 'here', current: true, open_cmd: null,
      surface: { running: true, port: 5173, url: 'http://localhost:5173', pid: 1, reachable: true, viewers: 2, turn: 'mid-turn', active_label: 'n1.4' },
      claude: { sessions: 2, channel: true, pids: [3, 4], started_at: NOW - 60_000, last_tool_at: NOW - 180_000 } },
    { root: '/home/me/solo', display_root: '~/solo', title: '<img src=x onerror=alert(1)>', current: false,
      open_cmd: "cd /home/me/solo && claude-web-chat open", surface: null,
      claude: { sessions: 1, channel: false, pids: [5], started_at: NOW, last_tool_at: null } },
    { root: '/srv/other', display_root: '/srv/other', title: 'other', current: false, open_cmd: null,
      surface: { running: true, port: 5174, url: 'http://localhost:5174', pid: 6, reachable: true, viewers: 0, turn: 'wake' },
      claude: null },
    { root: '/srv/gone', display_root: '/srv/gone', title: 'gone', current: false, open_cmd: null,
      surface: { running: true, port: 5175, url: 'http://localhost:5175', pid: 7, reachable: false },
      claude: null },
  ],
});

let W = null, restore = () => {}, sessionsBody = ROWS(), sessionsStatus = 200, sessionsCalls = 0;
const opened = [], copied = [], longTimers = [];

async function boot() {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} };
  window.open = (...a) => { opened.push(a); return null; };
  window.alert = () => { throw new Error('window.alert was called'); };
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url) => {
    const u = String(url);
    if (u === '/api/machine/sessions') { sessionsCalls++; return json(sessionsBody, sessionsStatus); }
    if (u === '/api/graph') return json({ nodes: [{ id: 'n1', label: 'n1.0', parent_id: null, created_at: 1 }], active: 'n1' });
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.0.0', updateAvailable: false });
    if (u.startsWith('/api/theme')) return json({ name: 'web-chat' });
    return json({ ok: true });
  };
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (s) => { copied.push(s); } }, configurable: true });

  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'WheelEvent', 'FocusEvent', 'navigator', 'getComputedStyle', 'localStorage', 'sessionStorage', 'WebSocket', 'fetch',
    'HTMLElement', 'Node', 'Element'];
  const aliasGlobal = (k, v) => {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch { try { global[k] = v; } catch {} }
  };
  for (const k of keys) { try { saved[k] = global[k]; } catch {} aliasGlobal(k, window[k]); }
  const savedSetInterval = global.setInterval;
  const savedSetTimeout = global.setTimeout;
  global.setInterval = () => 0;
  // Long timers (the panel's 5s refresh, notes that fade) are captured instead
  // of armed, so the test fires the refresh on demand and nothing outlives it.
  global.setTimeout = (fn, ms, ...rest) => {
    if (ms >= 5000) { longTimers.push({ fn, ms }); return 0; }
    return savedSetTimeout(fn, ms, ...rest);
  };
  global.requestAnimationFrame = (fn) => savedSetTimeout(() => fn(Date.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  window.__wcMount = require(path.join(REPO, 'public/mount-runtime.js'));

  await import(pathToFileURL(path.join(REPO, 'public/app/main.js')).href);
  restore = () => {
    for (const k of keys) { try { global[k] = saved[k]; } catch {} }
    global.setInterval = savedSetInterval;
    global.setTimeout = savedSetTimeout;
    window.close();
  };
  W = window;
}

const tick = () => new Promise((r) => setTimeout(r, 25));
const $ = (id) => W.document.getElementById(id);
const panelOpen = () => !$('sessions-panel').classList.contains('hidden');
const rows = () => [...$('sessions-list').querySelectorAll('.ss-row')];
const rowFor = (root) => rows().find((r) => r.dataset.root === root);
const key = (k, opts = {}) => W.document.body.dispatchEvent(new W.KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
const escape = () => key('Escape');

test('panel: boot the shell once', async () => { await boot(); await tick(); });

test('panel: S toggles it, and it renders every state as text', async () => {
  const before = sessionsCalls;
  key('s');
  await tick();
  assert.ok(panelOpen(), 'S opens the Sessions panel');
  assert.equal(sessionsCalls, before + 1, 'opening fetches immediately');
  assert.equal(rows().length, 4);

  const here = rowFor('/home/me/here');
  assert.ok(here.classList.contains('current'), 'the current project is highlighted');
  assert.match(here.textContent, /this page/);
  assert.match(here.textContent, /~\/here/);
  assert.match(here.textContent, /running :5173 · 2 viewers · at n1\.4/);
  assert.match(here.textContent, /Claude connected ×2/);
  assert.match(here.textContent, /channel on/);
  assert.match(here.textContent, /mid-turn/);
  assert.match(here.textContent, /last tool 3m ago/);

  const solo = rowFor('/home/me/solo');
  assert.equal(solo.querySelector('img'), null, 'a title is text, never markup');
  assert.match(solo.textContent, /<img src=x/);
  assert.match(solo.textContent, /surface stopped/);
  assert.match(solo.textContent, /channel off/);
  assert.doesNotMatch(solo.textContent, /last tool/, 'no tool call yet, no "last tool"');

  assert.match(rowFor('/srv/other').textContent, /wake turn/);
  assert.match(rowFor('/srv/other').textContent, /no Claude session/);
  assert.match(rowFor('/srv/gone').textContent, /not answering/);
  assert.match($('sessions-meta').textContent, /4 projects · 2 with Claude/);

  key('S');
  assert.ok(!panelOpen(), 'S again closes it');
});

test('panel: ⋯ → Sessions and ⌘K "Sessions…" both open it; Escape dismisses', async () => {
  $('more-menu').classList.remove('hidden');
  $('more-menu').querySelector('[data-act="sessions"]').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.ok(panelOpen(), 'the More menu item opens it');
  assert.ok($('more-menu').classList.contains('hidden'), 'and the menu closes behind it');
  escape();
  assert.ok(!panelOpen(), 'Escape closes it (the shell dismiss layer owns it)');

  key('k', { metaKey: true });
  await tick();
  const inp = $('cmd-input');
  inp.value = 'sessions';
  inp.dispatchEvent(new W.Event('input', { bubbles: true }));
  await tick();
  const item = [...$('cmd-list').querySelectorAll('.palette-item')].find((r) => /Sessions…/.test(r.textContent));
  assert.ok(item, 'the palette lists "Sessions…"');
  item.dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true }));
  await tick();
  assert.ok(panelOpen(), 'running it opens the panel');
  escape();
});

test('panel: a running surface opens in a new tab; the current one does not; a stopped one offers its command', async () => {
  key('s');
  await tick();
  opened.length = 0;
  rowFor('/srv/other').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(opened, [['http://localhost:5174', '_blank', 'noopener']]);

  rowFor('/home/me/here').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  assert.equal(opened.length, 1, 'clicking this page\'s own row opens nothing');
  assert.ok(!panelOpen(), '…it just closes the panel');

  key('s');
  await tick();
  const solo = rowFor('/home/me/solo');
  assert.ok(!solo.classList.contains('link'), 'a stopped surface is not a link');
  solo.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  assert.equal(opened.length, 1, 'and never starts or opens anything');
  assert.equal(solo.querySelector('.rn-cmd').textContent, 'cd /home/me/solo && claude-web-chat open');
  solo.querySelector('.rn-copy').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.deepEqual(copied, ['cd /home/me/solo && claude-web-chat open']);
  escape();
});

test('panel: refreshes while open, stops once dismissed; empty and error states', async () => {
  longTimers.length = 0;
  key('s');
  await tick();
  const refresh = longTimers.find((x) => x.ms === 5000);
  assert.ok(refresh, 'a 5s refresh is scheduled while open');

  sessionsBody = { ok: true, now: NOW, current: '/x', sessions: [] };
  const before = sessionsCalls;
  longTimers.length = 0;
  await refresh.fn();
  await tick();
  assert.equal(sessionsCalls, before + 1, 'the tick re-fetches');
  assert.match($('sessions-list').textContent, /No web-chat surfaces or Claude sessions/);
  assert.ok(longTimers.find((x) => x.ms === 5000), 'and schedules the next one');

  sessionsStatus = 500;
  const next = longTimers.find((x) => x.ms === 5000);
  longTimers.length = 0;
  await next.fn();
  await tick();
  assert.match($('sessions-list').textContent, /Couldn't read sessions — HTTP 500/);

  escape();
  const after = longTimers.find((x) => x.ms === 5000);
  longTimers.length = 0;
  const calls = sessionsCalls;
  await after.fn();
  await tick();
  assert.equal(sessionsCalls, calls, 'a dismissed panel stops polling');
  assert.equal(longTimers.length, 0, 'and schedules nothing more');
  sessionsStatus = 200;
  sessionsBody = ROWS();
});

test('panel: viewed remotely, the portal\'s refusal hint is shown instead of a bare status', async () => {
  const { classify, refusalBody } = require('../lib/core/remote-policy');
  sessionsStatus = 403;
  sessionsBody = refusalBody(classify('GET', '/api/machine/sessions'));
  key('s');
  await tick();
  assert.match($('sessions-list').textContent, /Couldn't read sessions — .*run on the host: claude-web-chat ls/);
  assert.doesNotMatch($('sessions-list').textContent, /HTTP 403/);
  escape();
  sessionsStatus = 200;
  sessionsBody = ROWS();
});

test('panel: teardown', () => { restore(); });
