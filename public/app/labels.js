// Label helpers shared across the chrome: the graph's (topbar's node label and
// status pill, graph-view's DAG labels and nav), which read view.graphCache —
// the last /api/graph payload — and `ago`, the one relative-time phrase.
//
// DOM-free: nothing here touches the document at load or call time, so the chat
// chrome's store and presentation model (chat-state.js, chat-present.js) import
// it under plain `node --test`.
import { view } from './state.js';

// "just now" / "42s ago" / "3m ago" / "2h ago" / "4d ago", against the clock
// that stamped `ts` — the SERVER's: a route sends its `now`, and the chat chrome
// passes serverNow(). null when either is not a number. The Sessions panel's
// "last tool 3m ago" and the chat chrome's "Done · 4m ago" are this one phrase.
export function ago(ts, now) {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return null;
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function seqNum(id) { const m = /^n(\d+)$/.exec(id || ''); return m ? +m[1] : 0; }
export function nodeById(id) { return view.graphCache && view.graphCache.nodes.find(n => n.id === id); }
export function labelFor(id) {
  if (!id) return '—';
  const n = nodeById(id);
  return (n && n.label) || id;
}
// A node's clock time as the chrome shows it (HH:MM) — the palette's hint, a
// sleeve row, a phone log card. '' for a node with no timestamp.
export function nodeTime(n) {
  return n && n.created_at ? new Date(n.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}
// RAW commit children — no collapse awareness. Its one consumer was the
// surface's ▾ branch picker, dropped with the chrome restyle (forks are chosen
// on the graph screen now); it stays for a question about the COMMIT graph, and
// only that. Everything that
// describes what is ON SCREEN (keyboard nav, fork glyphs, the breadcrumb, the
// scope filter, the ↑/↓ buttons) reads graph-view's graphIndex() instead, which is
// built from displayNodes(). Reaching for this one from a display consumer is
// the bug it caused before: a step onto a node the DAG never drew.
export function childrenOf(id) {
  if (!view.graphCache) return [];
  return view.graphCache.nodes
    .filter(n => n.parent_id === id)
    .sort((a, b) => (a.created_at - b.created_at) || (seqNum(a.id) - seqNum(b.id)));
}
