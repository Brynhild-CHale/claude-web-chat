// web-chat tab stream — background service worker.
//
// On a user gesture (popup button or context menu) it grabs the active tab's
// rendered DOM and POSTs it to the web-chat *hub* — a fixed-port router — which
// forwards it to the web-chat instance the user picked. The server runs a
// profile to distill it and folds it into that conversation. The extension is
// intentionally dumb: all distillation/storage lives server-side (so profiles
// can be iterated in the repo, and the same backend serves the hosted product).

const DEFAULTS = { endpoint: 'http://localhost:5170', token: '', profile: '', lastInstance: '' };

async function getConfig() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

function hubBase(cfg) {
  return cfg.endpoint.replace(/\/+$/, '');
}

// Ask the hub which web-chat instances are currently running, for the picker.
async function listInstances() {
  const cfg = await getConfig();
  const res = await fetch(hubBase(cfg) + '/api/instances');
  if (!res.ok) throw new Error(`hub ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  const { instances = [] } = await res.json();
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
  const headers = {};
  if (cfg.token) headers['X-WC-Token'] = cfg.token;
  const instance = instanceId || cfg.lastInstance || '';
  const q = '/api/profile-match?url=' + encodeURIComponent(url || '') +
    (instance ? '&instance=' + encodeURIComponent(instance) : '');
  let res;
  try {
    res = await fetch(hubBase(cfg) + q, { headers });
  } catch (e) {
    return { matched: false, error: String((e && e.message) || e) };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { matched: false, error: `hub ${res.status}${text ? ': ' + text.slice(0, 120) : ''}` };
  }
  return res.json().catch(() => ({ matched: false, error: 'bad JSON from hub' }));
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

async function captureActiveTab(instanceId, useProfile) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('no active tab');
  if (/^(chrome|edge|brave|about|chrome-extension|moz-extension|view-source):/i.test(tab.url || '')) {
    throw new Error('cannot capture browser/internal pages');
  }

  // Slice 0: the profile button selects the profile (distillation + pane) but does
  // NOT yet inject interaction — that lands in Slice 1, gated on the eval/CSP spike.

  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: grabPage,
  });
  if (!result || typeof result.html !== 'string') throw new Error('failed to read page DOM');

  const cfg = await getConfig();
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers['X-WC-Token'] = cfg.token;
  const body = { url: result.url, title: result.title, html: result.html };
  // Explicit profile button wins; else the options-page force-profile (if any).
  // The raw "Capture & send" button passes no useProfile → stays raw/passive.
  if (useProfile) body.profile = useProfile;
  else if (cfg.profile) body.profile = cfg.profile;
  // Which instance to route to. Explicit arg (from the popup picker) wins; else
  // fall back to the last one used. With neither, the hub uses a lone instance
  // or replies 409 listing the choices.
  const instance = instanceId || cfg.lastInstance;
  if (instance) body.instance = instance;

  const res = await fetch(hubBase(cfg) + '/api/capture', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const err = new Error(json.error || `hub ${res.status}: ${res.statusText}`);
    err.instances = json.instances; // 409/404 carry the list so the popup can prompt
    throw err;
  }
  // Remember the instance actually used for next time / the context menu.
  if (json.instance && json.instance.id) {
    chrome.storage.sync.set({ lastInstance: json.instance.id });
  }
  return json;
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('no active tab');
  if (/^(chrome|edge|brave|about|chrome-extension|moz-extension|view-source):/i.test(tab.url || '')) {
    throw new Error('cannot capture browser/internal pages');
  }

  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: grabSelection,
  });
  if (!result || typeof result.html !== 'string' || !result.html.trim()) {
    throw new Error('no text selected');
  }

  const cfg = await getConfig();
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers['X-WC-Token'] = cfg.token;
  const body = { url: result.url, title: result.title, html: result.html, kind: 'selection' };
  const instance = instanceId || cfg.lastInstance;
  if (instance) body.instance = instance;

  const res = await fetch(hubBase(cfg) + '/api/capture', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const err = new Error(json.error || `hub ${res.status}: ${res.statusText}`);
    err.instances = json.instances;
    throw err;
  }
  if (json.instance && json.instance.id) {
    chrome.storage.sync.set({ lastInstance: json.instance.id });
  }
  return json;
}

// Popup → background bridge.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'capture') {
    captureActiveTab(msg.instance, msg.useProfile).then(
      (result) => sendResponse({ ok: true, result }),
      (e) => sendResponse({ ok: false, error: String((e && e.message) || e), instances: e && e.instances }),
    );
    return true; // keep the channel open for the async response
  }
  if (msg && msg.type === 'list-instances') {
    listInstances().then(
      (instances) => sendResponse({ ok: true, instances }),
      (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }),
    );
    return true;
  }
  if (msg && msg.type === 'profile-match') {
    matchProfile(msg.url, msg.instance).then(
      (match) => sendResponse({ ok: true, match }),
      (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }),
    );
    return true;
  }
  if (msg && msg.type === 'selection-info') {
    selectionInfo().then(
      (info) => sendResponse({ ok: true, info }),
      (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }),
    );
    return true;
  }
  if (msg && msg.type === 'capture-selection') {
    captureSelection(msg.instance).then(
      (result) => sendResponse({ ok: true, result }),
      (e) => sendResponse({ ok: false, error: String((e && e.message) || e), instances: e && e.instances }),
    );
    return true;
  }
});

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
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'wc-capture') {
    captureActiveTab().catch((e) => console.error('[web-chat tab stream]', e));
  } else if (info.menuItemId === 'wc-capture-selection') {
    captureSelection().catch((e) => console.error('[web-chat tab stream]', e));
  }
});
