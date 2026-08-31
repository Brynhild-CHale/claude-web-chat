// The update-available advisory (public/app/version.js), driven as real DOM in
// jsdom. version.js is a leaf — `$` from state.js and the storage guard are its
// only imports — so this boots the module alone rather than the whole shell.
//
// The defect pinned here: the × handler recovered the version it was dismissing
// by running /web-chat (\S+) is available/ over the banner's own message text,
// re-deriving from the DOM a fact the check had already been handed. It read
// like a formatting detail and was not: reword the sentence, or borrow the bar
// for one of the other messages it carries, and the dismissal silently records
// nothing while the bar hides anyway — so the same version speaks up again on
// the next check, in the same session the user just closed it for.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

let W = null, info = null, restore = () => {};

async function boot() {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8')
    .replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = async () => ({ ok: true, status: 200, json: async () => info });

  const saved = {};
  const keys = ['window', 'document', 'location', 'MouseEvent', 'navigator', 'localStorage', 'sessionStorage', 'fetch'];
  const aliasGlobal = (k, v) => {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch { try { global[k] = v; } catch {} }
  };
  for (const k of keys) { try { saved[k] = global[k]; } catch {} aliasGlobal(k, window[k]); }
  const savedSetInterval = global.setInterval;
  global.setInterval = () => 0;
  restore = () => {
    for (const k of keys) { try { global[k] = saved[k]; } catch {} }
    global.setInterval = savedSetInterval;
    window.close();
  };
  W = window;
  return import(pathToFileURL(path.join(REPO, 'public/app/version.js')).href);
}

const tick = () => new Promise((r) => setTimeout(r, 10));
const $ = (id) => W.document.getElementById(id);
const hidden = () => $('update-banner').classList.contains('hidden');

test('dismissing the bar remembers the version it was announcing', async () => {
  info = { ok: true, current: '0.7.0', latest: '0.8.0', updateAvailable: true, releaseUrl: 'https://example.invalid/r' };
  const { initVersion, checkVersion } = await boot();
  initVersion();
  await tick();
  assert.equal(hidden(), false, 'precondition: the bar is up for 0.8.0');

  // Reword the message the way a copy edit would. The handler used to recover
  // the version by regexing this string; nothing else ever knew it.
  $('update-banner').querySelector('.ub-msg').textContent = 'A newer web-chat (0.8.0) is out — run claude-web-chat update';
  $('btn-update-dismiss').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(hidden(), true, 'the bar closes');

  await checkVersion();
  await tick();
  assert.equal(hidden(), true,
    'and STAYS closed for this session — the regex found nothing in the reworded sentence, so the '
    + 'dismissal recorded nothing and the very next check put the bar straight back up');

  // A LATER release still speaks up: the dismissal is per-version, not a mute.
  info = { ...info, latest: '0.9.0' };
  await checkVersion();
  await tick();
  assert.equal(hidden(), false, '0.9.0 is not the version that was dismissed');
});

test('dismissing a borrowed bar does not mute a version nobody was shown', async () => {
  const { checkForUpdatesNow, checkVersion } = await import(pathToFileURL(path.join(REPO, 'public/app/version.js')).href);
  info = { ok: true, current: '0.7.0', latest: '0.7.0', updateAvailable: false };
  await checkForUpdatesNow();          // borrows the bar for "you're up to date"
  await tick();
  assert.equal(hidden(), false, 'precondition: the bar is showing the up-to-date message');
  $('btn-update-dismiss').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();

  info = { ok: true, current: '0.7.0', latest: '0.7.0', updateAvailable: true };
  await checkVersion();
  await tick();
  assert.equal(hidden(), false,
    'a release announcement is not swallowed by the × that closed an unrelated message');
});

// checkForUpdatesNow borrowed the bar through flash(), whose 6s expiry timer
// touches `document`. Let it fire while the window is still valid, then tear down.
test.after(async () => { await new Promise((r) => setTimeout(r, 6200)); restore(); });
