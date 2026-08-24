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

// hash -> { name, command }
const pending = new Map();
let host = null;

function ensureHost() {
  if (host && host.isConnected) return host;
  host = document.createElement('div');
  host.id = 'service-trust';
  host.className = 'svc-trust-host hidden';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  document.body.appendChild(host);
  return host;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function repaint() {
  const el = ensureHost();
  if (!pending.size) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = [...pending.entries()].map(([hash, p]) => (
    '<div class="svc-trust-card" data-hash="' + esc(hash) + '">' +
      '<h3>&ldquo;' + esc(p.name) + '&rdquo; is waiting for approval</h3>' +
      '<p>This component ships a <code>service.js</code> that would run as a process ' +
        'on your machine, with your permissions, while its pane is open.</p>' +
      '<p>Approving is a terminal action — it cannot be done from this page, ' +
        'because a component&rsquo;s own code runs here too. In your terminal:</p>' +
      '<pre class="svc-trust-cmd"><code>' + esc(p.command) + '</code></pre>' +
      '<p class="svc-trust-foot">Run it with <code>--deny</code> to refuse and stop being asked. ' +
        'The pane stays inert until you decide.</p>' +
    '</div>'
  )).join('');
}

// The notice reflects live server state; it is re-announced whenever a viewer
// connects, so dropping it on disconnect just avoids showing a stale card.
export function resetTrustPrompts() {
  pending.clear();
  repaint();
}

export function onTrustPrompt(msg) {
  if (!msg || !msg.hash) return;
  pending.set(msg.hash, {
    name: msg.name || 'service',
    command: msg.command || `claude-web-chat trust ${msg.name || ''}`.trim(),
  });
  repaint();
}

export function onTrustClear(msg) {
  if (!msg || !msg.hash) return;
  pending.delete(msg.hash);
  repaint();
}
