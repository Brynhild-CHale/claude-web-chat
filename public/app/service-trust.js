// Service trust prompt — CHROME, deliberately not a mount.
//
// This is the gate that decides whether a component's service.js runs as a host
// process on the user's machine, so it must satisfy two things a pane cannot:
//
//  1. It must be impossible to miss. It used to be sent as a render targeting
//     'overlay', which resolves to the graph-viewer div (display:none until the
//     user presses G) — so the prompt was invisible and services could never be
//     approved at all.
//  2. It must be impossible to forge. The decision used to travel as an ordinary
//     store key, which any pane can write — a component could mount a second
//     pane and approve its own service. Mounts use OPEN shadow roots, so a
//     per-prompt nonce hidden in the prompt's DOM would not have helped either.
//
// Living in chrome fixes both: the modal is painted into the document by the
// shell, and the decision goes back on a dedicated `service:decision` WS frame
// that pane JS has no way to send (panes get `store`, never the socket).

import { send } from './ws.js';

// hash -> nonce for prompts currently on screen.
const outstanding = new Map();
let host = null;

function ensureHost() {
  if (host && host.isConnected) return host;
  host = document.createElement('div');
  host.id = 'service-trust';
  host.className = 'svc-trust-host hidden';
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
  if (!outstanding.size) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = [...outstanding.entries()].map(([hash, o]) => (
    '<div class="svc-trust-card" data-hash="' + esc(hash) + '">' +
      '<h3>Run host service for &ldquo;' + esc(o.name) + '&rdquo;?</h3>' +
      '<p>This component ships a <code>service.js</code> that will run as a process ' +
        'on your machine while its pane is open. It can read and write files with ' +
        'your permissions.</p>' +
      '<p class="svc-trust-hash">service.js sha256: <code>' + esc(String(hash).slice(0, 16)) + '&hellip;</code></p>' +
      '<div class="svc-trust-row">' +
        '<button class="svc-trust-no" data-decide="deny">Deny</button>' +
        '<button class="svc-trust-ok" data-decide="approve">Approve &amp; run</button>' +
      '</div>' +
    '</div>'
  )).join('');
}

function decide(hash, decision) {
  const o = outstanding.get(hash);
  if (!o) return;
  outstanding.delete(hash);
  send({ type: 'service:decision', hash, decision, nonce: o.nonce });
  repaint();
}

// Delegated: the card list is re-rendered on every change, so bind once on the host.
function bind() {
  const el = ensureHost();
  if (el.dataset.bound) return;
  el.dataset.bound = '1';
  el.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-decide]');
    if (!btn) return;
    const card = btn.closest('[data-hash]');
    if (card) decide(card.dataset.hash, btn.dataset.decide);
  });
}

// A prompt is meaningful only while this socket is up: the server drops its
// outstanding-prompt memo when the last viewer disconnects, so a nonce held
// across a reconnect would no longer match. Clear on disconnect and let the
// server re-prompt.
export function resetTrustPrompts() {
  outstanding.clear();
  repaint();
}

export function onTrustPrompt(msg) {
  if (!msg || !msg.hash || !msg.nonce) return;
  bind();
  outstanding.set(msg.hash, { name: msg.name || 'service', nonce: msg.nonce });
  repaint();
}

export function onTrustClear(msg) {
  if (!msg || !msg.hash) return;
  outstanding.delete(msg.hash);
  repaint();
}
