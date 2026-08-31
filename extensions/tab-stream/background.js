// web-chat tab stream — background service worker.
//
// On a user gesture (popup button or context menu) it grabs the active tab's
// rendered DOM and POSTs it to the web-chat *hub* — a fixed-port router — which
// forwards it to the web-chat instance the user picked. The server runs a
// profile to distill it and folds it into that conversation. The extension is
// intentionally dumb: all distillation/storage lives server-side (so profiles
// can be iterated in the repo, and the same backend serves the hosted product).

// The endpoint, the forced profile and the last instance are preferences: harmless
// to replicate, and nicer synced across the user's browsers. The TOKEN is not a
// preference. It is the shared secret a web-chat daemon on THIS machine checks
// (the only authentication the capture path has), and chrome.storage.sync uploads
// what it holds to the user's Google account and pushes it to every profile signed
// into it — the exact opposite of a per-machine secret, and what Chrome's own
// storage docs warn against. So: preferences in sync, token in local, and a token
// an older build put in sync is moved across the first time this reads it.
const DEFAULTS = { endpoint: 'http://localhost:5170', profile: '', lastInstance: '' };
const LOCAL_DEFAULTS = { token: '' };

async function getConfig() {
  const [synced, local] = await Promise.all([
    // `token: ''` is asked for so a legacy value comes back at all — get() only
    // returns the keys it was given.
    chrome.storage.sync.get({ ...DEFAULTS, token: '' }),
    chrome.storage.local.get(LOCAL_DEFAULTS),
  ]);
  const legacy = synced.token || '';
  delete synced.token;
  const cfg = { ...DEFAULTS, ...LOCAL_DEFAULTS, ...synced, ...local };
  if (legacy) {
    // Adopt it only if this machine has none of its own, but stop syncing it
    // either way — leaving it there keeps replicating the secret.
    if (!cfg.token) {
      cfg.token = legacy;
      await chrome.storage.local.set({ token: legacy });
    }
    await chrome.storage.sync.remove('token');
  }
  return cfg;
}

function hubBase(cfg) {
  return cfg.endpoint.replace(/\/+$/, '');
}

// The one place a "the hub isn't there" failure is turned into words. Every hub
// call funnels through hubFetch, so a dead hub can never surface as the browser's
// bare "Failed to fetch" again — the user gets the endpoint we tried AND the
// command that fixes it. `code` rides along so the popup can render the command
// as something copyable rather than as prose.
const HUB_UNREACHABLE = 'hub-unreachable';

function unreachableError(cfg) {
  const base = hubBase(cfg);
  const e = new Error(
    `Can't reach the web-chat hub at ${base}.\n` +
    `Start web-chat in your project:  claude-web-chat open\n` +
    `Already running? Check the hub:  claude-web-chat hub status`,
  );
  e.code = HUB_UNREACHABLE;
  e.command = 'claude-web-chat open';
  e.endpoint = base;
  return e;
}

// Single transport for every hub call: applies the token header, converts a
// transport failure into unreachableError, and turns a non-2xx into an Error
// carrying whatever the hub said (plus `instances` when it replied 409/404 with
// the list, which the popup re-renders).
async function hubFetch(pathAndQuery, { method = 'GET', body, cfg } = {}) {
  const conf = cfg || (await getConfig());
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (conf.token) headers['X-WC-Token'] = conf.token;
  let res;
  try {
    res = await fetch(hubBase(conf) + pathAndQuery, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    // fetch only rejects on a transport failure — DNS, refused connection,
    // nothing listening. That is exactly "the hub isn't running".
    throw unreachableError(conf);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.ok === false)) {
    const e = new Error((json && json.error) || `hub ${res.status}: ${res.statusText}`);
    e.status = res.status;
    if (json && json.instances) e.instances = json.instances;
    throw e;
  }
  return json || {};
}

// Ask the hub which web-chat instances are currently running, for the picker.
async function listInstances() {
  const { instances = [] } = await hubFetch('/api/instances');
  return instances;
}

// Ask the chosen instance whether a URL has a matching profile (drives the
// "Capture with <profile>" button). URL-only, read-only; never alters the page.
// A transport/HTTP error returns { matched:false, error } — distinguishable from a
// genuine no-match so the popup can surface "hub may need a restart" instead of
// silently hiding the button (which masked a stale hub returning 404 on the
// profile-match route added in protocol v2).
async function matchProfile(url, instanceId) {
  const cfg = await getConfig();
  const instance = instanceId || cfg.lastInstance || '';
  const q = '/api/profile-match?url=' + encodeURIComponent(url || '') +
    (instance ? '&instance=' + encodeURIComponent(instance) : '');
  try {
    return await hubFetch(q, { cfg });
  } catch (e) {
    return { matched: false, error: String((e && e.message) || e), code: e && e.code };
  }
}

// Runs in the page context (via scripting.executeScript) — returns the rendered
// DOM as it currently stands, so JS-rendered content is included.
function grabPage() {
  return {
    url: location.href,
    title: document.title,
    html: document.documentElement.outerHTML,
  };
}

// The active tab, rejected with a reason if it can't be captured at all.
async function capturableTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('no active tab');
  if (/^(chrome|edge|brave|about|chrome-extension|moz-extension|view-source):/i.test(tab.url || '')) {
    throw new Error('cannot capture browser/internal pages');
  }
  return tab;
}

// POST a capture body to the hub and remember which instance took it. Shared by
// the whole-page and selection paths, which differ only in their payload.
async function postCapture(body, instanceId) {
  const cfg = await getConfig();
  const instance = instanceId || cfg.lastInstance;
  if (instance) body.instance = instance;
  const json = await hubFetch('/api/capture', { method: 'POST', body, cfg });
  // Remember the instance actually used for next time / the context menu.
  if (json.instance && json.instance.id) {
    chrome.storage.sync.set({ lastInstance: json.instance.id });
  }
  return json;
}

async function captureActiveTab(instanceId, useProfile) {
  const tab = await capturableTab();

  // Slice 0: the profile button selects the profile (distillation + pane) but does
  // NOT yet inject interaction — that lands in Slice 1, gated on the eval/CSP spike.

  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: grabPage,
  });
  if (!result || typeof result.html !== 'string') throw new Error('failed to read page DOM');

  const cfg = await getConfig();
  const body = { url: result.url, title: result.title, html: result.html };
  // Explicit profile button wins; else the options-page force-profile (if any).
  // The raw "Capture & send" button passes no useProfile → stays raw/passive.
  if (useProfile) body.profile = useProfile;
  else if (cfg.profile) body.profile = cfg.profile;
  // Which instance to route to. Explicit arg (from the popup picker) wins; else
  // postCapture falls back to the last one used. With neither, the hub uses a
  // lone instance or replies 409 listing the choices.
  return postCapture(body, instanceId);
}

// Runs in the page context — serialize the current selection as an HTML FRAGMENT
// (Range.cloneContents → container.innerHTML), so the server sees the same markup
// the user highlighted and can distill it to Markdown. Falls back to the
// plain-text selection when the range carries no element markup. Stays thin: no
// conversion here — all HTML→Markdown work is server-side.
function grabSelection() {
  const sel = window.getSelection && window.getSelection();
  const text = sel ? sel.toString() : '';
  let html = '';
  if (sel && sel.rangeCount) {
    const container = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) {
      container.appendChild(sel.getRangeAt(i).cloneContents());
    }
    html = container.innerHTML;
  }
  if (!html || !html.trim()) html = text; // empty fragment → plain-text fallback
  return { url: location.href, title: document.title, html: html };
}

// Cheap probe of whether the active tab has a text selection right now — drives
// the popup's "Capture selection" affordance (revealed only when one exists).
async function selectionInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return { hasSelection: false };
  if (/^(chrome|edge|brave|about|chrome-extension|moz-extension|view-source):/i.test(tab.url || '')) {
    return { hasSelection: false };
  }
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window.getSelection ? window.getSelection().toString() : '').trim().length,
    });
    const chars = result || 0;
    return { hasSelection: chars > 0, chars };
  } catch {
    return { hasSelection: false };
  }
}

// Capture just the highlighted selection as a `kind:'selection'` capture. Same
// hub transport and error handling as captureActiveTab — only the payload (a
// selection fragment, not the whole DOM) and the `kind` flag differ.
async function captureSelection(instanceId) {
  const tab = await capturableTab();

  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: grabSelection,
  });
  if (!result || typeof result.html !== 'string' || !result.html.trim()) {
    throw new Error('no text selected');
  }

  return postCapture(
    { url: result.url, title: result.title, html: result.html, kind: 'selection' },
    instanceId,
  );
}

// One shape for every failure crossing the popup bridge. `code`/`command`/
// `endpoint` are what let the popup render an actionable panel instead of
// echoing a raw string; `instances` is the hub's 409 list.
function errorResponse(e) {
  return {
    ok: false,
    error: String((e && e.message) || e),
    code: e && e.code,
    command: e && e.command,
    endpoint: e && e.endpoint,
    instances: e && e.instances,
  };
}

// Popup → background bridge.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'capture') {
    captureActiveTab(msg.instance, msg.useProfile).then(
      (result) => sendResponse({ ok: true, result }),
      (e) => sendResponse(errorResponse(e)),
    );
    return true; // keep the channel open for the async response
  }
  if (msg && msg.type === 'list-instances') {
    listInstances().then(
      (instances) => sendResponse({ ok: true, instances }),
      (e) => sendResponse(errorResponse(e)),
    );
    return true;
  }
  if (msg && msg.type === 'profile-match') {
    matchProfile(msg.url, msg.instance).then(
      (match) => sendResponse({ ok: true, match }),
      (e) => sendResponse(errorResponse(e)),
    );
    return true;
  }
  if (msg && msg.type === 'selection-info') {
    selectionInfo().then(
      (info) => sendResponse({ ok: true, info }),
      (e) => sendResponse(errorResponse(e)),
    );
    return true;
  }
  if (msg && msg.type === 'capture-selection') {
    captureSelection(msg.instance).then(
      (result) => sendResponse({ ok: true, result }),
      (e) => sendResponse(errorResponse(e)),
    );
    return true;
  }
});

// ---------------------------------------------------------------- feedback
// The context menu has no popup to write status into, so a failure there used to
// end its life in `console.error` on a service-worker console nobody has open —
// the click simply did nothing, forever. Everything below exists so that path
// says something. Three channels, cheapest-first, none of which needs a new
// permission (no "notifications" install warning):
//
//   1. the toolbar badge + its tooltip — always works, even on a page we can't
//      script (a PDF viewer, a blocked origin);
//   2. an in-page toast, injected best-effort into the tab that was clicked;
//   3. `lastResult` in storage.local, which the popup shows the next time it is
//      opened — the durable record, so feedback survives a missed toast.

const BADGE_MS = 5000;
const RESULT_TTL_MS = 60000; // how long the popup still considers lastResult news

// Runs in the PAGE realm via scripting.executeScript — self-contained by
// necessity (no closure over anything here). Text goes in via textContent: the
// message can carry a server-supplied error string and this page is not ours.
function showToast(message, ok) {
  const ID = '__wc_tab_stream_toast__';
  const prev = document.getElementById(ID);
  if (prev) prev.remove();
  const el = document.createElement('div');
  el.id = ID;
  el.textContent = message;
  el.style.cssText = [
    'position:fixed', 'z-index:2147483647', 'top:16px', 'right:16px',
    'max-width:360px', 'padding:10px 14px', 'border-radius:8px',
    'font:13px/1.45 system-ui,-apple-system,sans-serif', 'white-space:pre-wrap',
    'box-shadow:0 4px 16px rgba(0,0,0,.24)', 'color:#fff',
    'background:' + (ok ? '#1a7f37' : '#cf222e'),
  ].join(';');
  document.documentElement.appendChild(el);
  setTimeout(() => { el.remove(); }, ok ? 3500 : 9000);
}

let badgeTimer = null;
function flashBadge(ok, title) {
  try {
    chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
    chrome.action.setBadgeBackgroundColor({ color: ok ? '#1a7f37' : '#cf222e' });
    chrome.action.setTitle({ title });
  } catch {}
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    try {
      chrome.action.setBadgeText({ text: '' });
      chrome.action.setTitle({ title: 'Send tab to web-chat' });
    } catch {}
  }, BADGE_MS);
}

async function report(tabId, ok, message, extra) {
  flashBadge(ok, message);
  try {
    await chrome.storage.local.set({
      lastResult: { ok, message, at: Date.now(), ...(extra || {}) },
    });
  } catch {}
  if (tabId == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: showToast,
      args: [message, ok],
    });
  } catch {
    // Injection can legitimately fail (no activeTab grant, a chrome:// tab, a
    // PDF viewer). The badge and storage record already carried the news.
  }
}

// Run a capture started from the context menu and REPORT the outcome either way.
async function runFromMenu(promise, tabId, label) {
  try {
    const r = await promise;
    const where = r && r.instance ? ` → ${r.instance.title}` : '';
    await report(tabId, true, `${label} sent to web-chat${where}`);
  } catch (e) {
    const msg = String((e && e.message) || e);
    await report(tabId, false, `${label} failed — ${msg}`, { code: e && e.code });
    console.error('[web-chat tab stream]', e);
  }
}

// Right-click → "Send tab to web-chat" as an alternative to the popup. Uses the
// last-used instance (no picker here); falls back to the hub's single-instance
// resolution.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'wc-capture',
    title: 'Send tab to web-chat',
    contexts: ['page', 'action'],
  });
  // Selection-only entry: send just the highlighted text as a Markdown clipping
  // Shown only when there's a selection (contexts:['selection']).
  chrome.contextMenus.create({
    id: 'wc-capture-selection',
    title: 'Capture selection → web-chat',
    contexts: ['selection'],
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab && tab.id;
  if (info.menuItemId === 'wc-capture') {
    runFromMenu(captureActiveTab(), tabId, 'Tab');
  } else if (info.menuItemId === 'wc-capture-selection') {
    runFromMenu(captureSelection(), tabId, 'Selection');
  }
});
