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
export function childrenOf(id) {
  if (!view.graphCache) return [];
  return view.graphCache.nodes
    .filter(n => n.parent_id === id)
    .sort((a, b) => (a.created_at - b.created_at) || (seqNum(a.id) - seqNum(b.id)));
}
