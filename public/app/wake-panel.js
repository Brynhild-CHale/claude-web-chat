// The "what wakes Claude" panel. Fills the reserved
// 7a chrome slot (.wake-slot in the queue rail) so the interaction contract is
// VISIBLE — instead of living in chat history ("the panel sends to form_submit
// when you hit Apply"). Reads GET /api/queue/policy: whether a channel is
// actually connected, that wake is user-triggered (Push), and the live declared
// signals split by wake mode.
import { $ } from './state.js';

const slot = () => { const r = $('queue-rail'); return r ? r.querySelector('.wake-slot') : null; };
const notice = () => { const r = $('queue-rail'); return r ? r.querySelector('.rail-notice') : null; };

function tooltip(p) {
  const lines = [
    `Channel: ${p.channel_connected ? 'connected' : 'not connected'}`,
    'Wake trigger: Push (manual) — nothing wakes Claude until you push',
    `Captures auto-enqueue: ${p.captures_enqueue ? 'yes' : 'no'}`,
  ];
  if (p.immediate_signals && p.immediate_signals.length) {
    lines.push('Immediate signals (wake at once): ' + p.immediate_signals.map((s) => s.key).join(', '));
  }
  if (p.queue_signals && p.queue_signals.length) {
    lines.push('Queue signals (fold into rail): ' + p.queue_signals.map((s) => s.key).join(', '));
  }
  return lines.join('\n');
}

export async function refreshWakePanel() {
  const el = slot();
  if (!el) return;
  let p;
  try { p = await fetch('/api/queue/policy').then((r) => r.json()); } catch { return; }

  // Surface the "channels not enabled" notice when no bridge is connected — Push
  // can't wake Claude until the session runs with the Channels capability. B8: the
  // text (title/body/command) is server-sent so the incantation lives in one place.
  const rn = notice();
  if (rn) {
    rn.classList.toggle('hidden', !!p.channel_connected);
    const hint = p.activation_hint || {};
    const set = (sel, text) => { const el = rn.querySelector(sel); if (el) el.textContent = text || ''; };
    set('.rn-title', hint.title ? `⚠ ${hint.title}` : '');
    set('.rn-body', hint.body);
    set('.rn-cmd', hint.command);
    // standing parked-delivery line so the user knows a Push isn't lost while
    // channels are off — it's held and delivered with their next message.
    set('.rn-parked', p.parked_delivery);
  }

  const imm = (p.immediate_signals || []).length;
  el.innerHTML = '';
  el.title = tooltip(p);

  const gear = document.createElement('span'); gear.className = 'gear'; gear.textContent = '⚙';
  const label = document.createElement('span');
  label.textContent = ` wakes: Push${imm ? ` · ⚡${imm}` : ''} · `;
  const dot = document.createElement('span');
  dot.className = 'wake-dot' + (p.channel_connected ? ' on' : '');
  dot.textContent = p.channel_connected ? '● channel' : '○ manual';

  el.append(gear, label, dot);
}

export function initWakePanel() {
  refreshWakePanel();
  // The connect/disconnect of the bridge and render/clear of declared signals
  // have no push channel to the browser, so poll on a slow interval. Cheap
  // endpoint; 5s keeps the indicator honest without a tight loop.
  setInterval(refreshWakePanel, 5000);
}
