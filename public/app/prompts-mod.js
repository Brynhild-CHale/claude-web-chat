// What the chat chrome says about an MCP server's form request (spec §15.7,
// tranche 6; ruled F8 (a), notes-C Q-C15 (b)). Pure helpers, DOM-free, run
// under plain `node --test`:
//
//   pendingElicitation(m, conversationId) → the pending, answerable
//       elicitation ask of that conversation (the newest), or null
//   elicitationLine(ask) → 'MCP input · <server>'
//
// chat-present.js's uiState puts the line on the bar (and the phone's tab and
// sheet, which read the same state) with act 'answer', which opens the chat
// at the awaiting card; the card is kind-agnostic and mounts the answer frame
// for any answerable pending ask, so the form needs no other chrome.
//
// LOCAL ONLY (ruled D3 (a)): an elicitation is never answered remotely, at
// any access level, so a remote page — the phone through the tunnel — gets
// null here and keeps "Needs you — answer in the terminal". The level ladder
// is chat-state.js's, never a copy.
import { atLeast } from './chat-state.js';

const mapOf = (v) => (v instanceof Map ? v : new Map());

export function pendingElicitation(m, conversationId) {
  if (!m || !conversationId) return null;
  const access = m.access || {};
  if (access.remote === true || !atLeast(access.level, 'local')) return null;
  let best = null;
  for (const a of mapOf(m.awaiting).values()) {
    if (!a || a.kind !== 'elicitation' || a.conversation_id !== conversationId) continue;
    if (a.state !== 'pending' || a.answerable !== true) continue;
    if (!best || (a.created_at || 0) > (best.created_at || 0)) best = a;
  }
  return best;
}

export function elicitationLine(ask) {
  const server = ask && typeof ask.tool_name === 'string' && ask.tool_name ? ask.tool_name : 'an MCP server';
  return `MCP input · ${server}`;
}
