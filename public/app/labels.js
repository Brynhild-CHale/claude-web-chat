// Graph label helpers shared by topbar (node label, status pill) and graph-view
// (DAG labels, nav). All read view.graphCache — the last /api/graph payload.
import { view } from './state.js';

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
