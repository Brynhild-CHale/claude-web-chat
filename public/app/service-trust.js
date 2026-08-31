// Service trust notice — INFORMATIONAL ONLY. It grants nothing.
//
// A component's `service.js` runs as a host process on the user's machine, so
// approving one is a real privilege decision. That decision deliberately does
// NOT happen here, because this page cannot make it safely:
//
//   Pane scripts are compiled with `new Function` and run in this same window
//   realm (public/mount-runtime.js) with `document`, `fetch` and `WebSocket`,
//   and no CSP is served. A pane can therefore synthesise a click on any button
//   in this UI, open its own same-origin socket and read anything the server
//   broadcasts to the shell, and call any localhost endpoint. Nothing delivered
//   to this page — a nonce, a token, a hidden DOM node — is a secret from the
//   very code the gate exists to gate. And a repository can commit
//   `.web-chat/draft.json` plus a component directory, which the daemon restores
//   at boot, so "clone a repo and run open" is enough to get a pane script
//   running.
//
// So consent lives where pane JS cannot reach it: the filesystem, written by
// `claude-web-chat trust` in the terminal. This card exists purely to tell the
// user that a service is waiting and which command to run.

// DISMISSAL IS NOT DENIAL. The × below hides the card for this browser session
// only; the request stays pending on the server and `claude-web-chat trust
// <name> --deny` remains the only way to refuse it. Dismissals — and the pending
// map itself — are keyed by the request's TRUST KEY, the identity the daemon
// mints once and sends with every notice (project root + service.js contents +
// service-facing params; lib/server/services.js). So a DIFFERENT component, the
// same one after an edit, and the same one mounted a second time with DIFFERENT
// PARAMS are three cards and three decisions. Keying by the service.js hash
// alone collapsed that last pair into one card, and then either pane's clear —
// or an approval of just one variant — took the other's card away from every
// browser while its request was still pending on the server.
//
// Session, not local, storage is what makes "session" mean session, and it goes
// through storage.js — the one home for the private-window guard (a blocked
// accessor throws on the getter itself, which would otherwise abort module
// bootstrap and leave a dead page).
import { esc } from './esc.js';
import { getSessionJson, setSessionJson } from './storage.js';

const DISMISS_KEY = 'wc:svc-trust-dismissed';

function dismissedSet() {
  const raw = getSessionJson(DISMISS_KEY, []);
  return new Set(Array.isArray(raw) ? raw : []);
}
function rememberDismissal(key) {
  const s = dismissedSet();
  s.add(key);
  setSessionJson(DISMISS_KEY, [...s]);   // private window — the card simply returns on the next announce
}

// trust key -> { name, command, params }
const pending = new Map();
let host = null;

function ensureHost() {
  if (host && host.isConnected) return host;
  host = document.createElement('div');
  host.id = 'service-trust';
  host.className = 'svc-trust-host hidden';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  // Delegated so it survives every repaint (the card markup is rebuilt wholesale).
  host.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-dismiss]');
    if (!btn) return;
    rememberDismissal(btn.getAttribute('data-dismiss'));
    repaint();
  });
  document.body.appendChild(host);
  return host;
}

function repaint() {
  const el = ensureHost();
  const dismissed = dismissedSet();
  const shown = [...pending.entries()].filter(([key]) => !dismissed.has(key));
  if (!shown.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = shown.map(([key, p]) => (
    '<div class="svc-trust-card" data-key="' + esc(key) + '">' +
      '<button class="svc-trust-x" type="button" data-dismiss="' + esc(key) + '"' +
        ' title="Hide for this session — this does NOT deny the request"' +
        ' aria-label="Hide this notice for this session (does not deny the request)">×</button>' +
      '<h3>&ldquo;' + esc(p.name) + '&rdquo; is waiting for approval</h3>' +
      '<p>This component ships a <code>service.js</code> that would run as a process ' +
        'on your machine, with your permissions, while its pane is open.</p>' +
      '<p>Approving is a terminal action — it cannot be done from this page, ' +
        'because a component&rsquo;s own code runs here too. In your terminal:</p>' +
      '<pre class="svc-trust-cmd"><code>' + esc(p.command) + '</code></pre>' +
      // Two panes of one component with different params are two decisions.
      // Without this the two cards read identically and the user cannot tell
      // which one the command in front of them is about.
      (p.params ? '<p class="svc-trust-params">params: <code>' + esc(p.params) + '</code></p>' : '') +
      '<p class="svc-trust-foot">Run it with <code>--deny</code> to refuse and stop being asked. ' +
        'The pane stays inert until you decide. Closing this card only hides it for ' +
        'this browser session — it neither approves nor denies.</p>' +
    '</div>'
  )).join('');
}

// The notice reflects live server state; it is re-announced whenever a viewer
// connects, so dropping it on disconnect just avoids showing a stale card.
export function resetTrustPrompts() {
  pending.clear();
  repaint();
}

// Summarise the params for the card. Nothing here is a secret from the page —
// it rendered the pane with these params — and it is the only thing that tells
// two variants of one component apart.
function describeParams(params) {
  if (!params || typeof params !== 'object') return '';
  const keys = Object.keys(params);
  if (!keys.length) return '';
  return keys.map((k) => {
    let v;
    try { v = JSON.stringify(params[k]); } catch { v = String(params[k]); }
    if (v && v.length > 40) v = v.slice(0, 39) + '…';
    return `${k}=${v}`;
  }).join(' ');
}

export function onTrustPrompt(msg) {
  if (!msg || !msg.key) return;
  pending.set(msg.key, {
    name: msg.name || 'service',
    command: msg.command || `claude-web-chat trust ${msg.name || ''}`.trim(),
    params: describeParams(msg.params),
  });
  repaint();
}

export function onTrustClear(msg) {
  if (!msg || !msg.key) return;
  pending.delete(msg.key);
  repaint();
}
