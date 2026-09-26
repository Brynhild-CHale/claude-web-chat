// lib/server/domain/replay-path.js — which nodes a replay plays, and what each
// one says.
//
// A replay is a walk DOWN one lineage, `from` → `to`, one frame per node the
// graph viewer DRAWS. The graph viewer hides the byte-identical no-change nodes
// older graphs are full of (graph.computeCollapse) and closes the trunk up over
// them; a replay that stopped on each of those would show the same frame N
// times with a different caption, so it skips them the same way — and, like the
// viewer's absorbed list, keeps what they said: a skipped node's trigger (and
// any turns already folded onto it) merge into the `folded[]` of the next step
// that is kept. Nothing is dropped, only regrouped.
//
// Pure: it reads `graph` (nodes, topology, viewKeys, active) and returns data.
// No fs, no bus, no HTTP — the route and, later, the replay document and the
// GIF renderer all consume this one answer.

const { resolveNodeRef, ancestorChain } = require('./refs');

// A replay longer than this is truncated to its LAST MAX_STEPS steps — the
// frames closest to `to`, which is where the user asked the replay to arrive.
// It bounds the document the player builds and the frames a render captures.
const MAX_STEPS = 200;

// One trigger, in caption shape. `reply` is the short summary of Claude's reply
// when the node recorded one (additive; absent on older nodes → null).
function captionOf(trigger) {
  const t = trigger || {};
  return {
    kind: t.kind || null,
    prompt: t.message || '',
    reply: t.reply || null,
    summary: t.summary || '',
  };
}

// A folded entry (domain/turns accumulateFolded) in caption shape.
function foldedEntry(f) {
  return {
    at: f.at ?? null,
    author: f.author || null,
    ...captionOf({ kind: f.kind, message: f.message, summary: f.summary, reply: f.reply }),
  };
}

// resolveReplayPath(graph, { from, to, includeCollapsed, maxSteps })
//   to     — any node ref (domain/refs); defaults to `active`. `live` is refused:
//            a replay plays committed history.
//   from   — any node ref that is an ANCESTOR of `to` (or `to` itself). Default:
//            the nearest bookmarked node walking up from `to` (inclusive — a
//            bookmark is where the user said "a fresh start happens here"), else
//            the root of `to`'s tree.
//   includeCollapsed — true plays every commit, the raw history (the viewer's
//            show-collapsed toggle); false (default) plays the graph as drawn.
// The two endpoints are always steps, even when one is a node the viewer would
// hide: the caller named it.
//
// → { ok:true, from:{id,label}, to:{id,label}, from_default:'bookmark'|'root'|null,
//     steps:[{id, label, author, kind, prompt, reply, summary, folded[],
//             folded_count, created_at, dt_from_prev}],
//     skipped, truncated, total_steps }
// → { ok:false, code, error, which? }   code: no-active | not-found |
//     live-not-allowed | not-ancestor
function resolveReplayPath(graph, { from, to, includeCollapsed = false, maxSteps = MAX_STEPS } = {}) {
  const { computeLabels, computeCollapse } = require('../graph');
  const cap = Math.max(1, Math.min(MAX_STEPS, Number(maxSteps) || MAX_STEPS));

  const T = resolveNodeRef(graph, to, { allowLive: false });
  if (!T.ok) return { ok: false, code: T.code, error: T.error, which: 'to' };

  const chain = ancestorChain(graph, T.id); // root … to
  const topo = graph.topology;

  let startIdx;
  let fromDefault = null;
  if (from == null || from === '') {
    startIdx = 0;
    fromDefault = 'root';
    for (let i = chain.length - 1; i >= 0; i--) {
      if (topo.get(chain[i]).bookmarked) { startIdx = i; fromDefault = 'bookmark'; break; }
    }
  } else {
    const F = resolveNodeRef(graph, from, { allowLive: false });
    if (!F.ok) return { ok: false, code: F.code, error: F.error, which: 'from' };
    startIdx = chain.indexOf(F.id);
    if (startIdx < 0) {
      return {
        ok: false, code: 'not-ancestor', which: 'from',
        error: `${F.label} is not an ancestor of ${T.label} — a replay plays one lineage, from an earlier node down to a later one`,
      };
    }
  }

  const labels = computeLabels(graph);
  const collapse = includeCollapsed ? null : computeCollapse(graph);
  const segment = chain.slice(startIdx);
  const lastIdx = segment.length - 1;

  const steps = [];
  let carried = []; // captions of skipped nodes, waiting for the next kept step
  let carriedCount = 0;
  let skipped = 0;
  for (let i = 0; i < segment.length; i++) {
    const id = segment[i];
    const node = graph.nodes.get(id) || {};
    const own = Array.isArray(node.folded) ? node.folded.map(foldedEntry) : [];
    // folded_count counts turns the cap aged out of `folded`, too.
    const ownCount = Math.max(own.length, Number(node.folded_count) || 0);
    const hidden = collapse && i !== 0 && i !== lastIdx && (collapse.get(id) || {}).collapsed;
    if (hidden) {
      // Oldest first: the turns folded onto this node happened before it did.
      carried.push(...own, {
        at: node.created_at ?? null,
        author: node.author || null,
        ...captionOf(node.trigger),
        id,
        label: labels.get(id) || id,
        collapsed: true,
      });
      carriedCount += ownCount + 1;
      skipped++;
      continue;
    }
    const prev = steps.length ? steps[steps.length - 1] : null;
    steps.push({
      id,
      label: labels.get(id) || id,
      author: node.author || null,
      ...captionOf(node.trigger),
      folded: [...carried, ...own],
      folded_count: carriedCount + ownCount,
      created_at: node.created_at ?? null,
      dt_from_prev: prev && Number.isFinite(prev.created_at) && Number.isFinite(node.created_at)
        ? node.created_at - prev.created_at : null,
    });
    carried = [];
    carriedCount = 0;
  }

  const total = steps.length;
  const kept = total > cap ? steps.slice(total - cap) : steps;
  if (kept !== steps) kept[0] = { ...kept[0], dt_from_prev: null };
  const first = kept[0];
  return {
    ok: true,
    from: { id: first.id, label: first.label },
    to: { id: T.id, label: T.label },
    from_default: fromDefault,
    steps: kept,
    skipped,
    truncated: total > cap,
    total_steps: total,
  };
}

module.exports = { resolveReplayPath, MAX_STEPS };
