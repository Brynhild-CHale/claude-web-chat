// Graph label helpers shared by topbar (view chip, branch picker) and graph-view
// (DAG labels, nav). All read view.graphCache — the last /api/graph payload.
import { view } from './state.js';

export function seqNum(id) { const m = /^n(\d+)$/.exec(id || ''); return m ? +m[1] : 0; }
export function nodeById(id) { return view.graphCache && view.graphCache.nodes.find(n => n.id === id); }
export function labelFor(id) {
  if (!id) return '—';
  const n = nodeById(id);
  return (n && n.label) || id;
}
// RAW commit children — no collapse awareness. One consumer by design: topbar's
// ⑃ branch picker, which is asking about the commit graph. Everything that
// describes what is ON SCREEN (keyboard nav, fork glyphs, the breadcrumb, the
// scope filter, the ↓ button) reads graph-view's graphIndex() instead, which is
// built from displayNodes(). Reaching for this one from a display consumer is
// the bug it caused before: a step onto a node the DAG never drew.
export function childrenOf(id) {
  if (!view.graphCache) return [];
  return view.graphCache.nodes
    .filter(n => n.parent_id === id)
    .sort((a, b) => (a.created_at - b.created_at) || (seqNum(a.id) - seqNum(b.id)));
}
