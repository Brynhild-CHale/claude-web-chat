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

const { resolveNodeRef } = require('./refs');
const { ancestry } = require('./lineage');
const { pageOrder } = require('./page');

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
  const { computeCollapse } = require('../graph');
  const cap = Math.max(1, Math.min(MAX_STEPS, Number(maxSteps) || MAX_STEPS));

  const seg = lineageSegment(graph, { from, to });
  if (!seg.ok) return seg;
  const { segment, labels, T, fromDefault } = seg;
  const collapse = includeCollapsed ? null : computeCollapse(graph);
  const lastIdx = segment.length - 1;

  const steps = [];
  let carried = []; // captions of skipped nodes, waiting for the next kept step
  let carriedCount = 0;
  let skipped = 0;
  for (let i = 0; i < segment.length; i++) {
    const id = segment[i];
    const node = graph.nodes.get(id) || {};
    const own = ownFolded(node);
    const hidden = collapse && i !== 0 && i !== lastIdx && (collapse.get(id) || {}).collapsed;
    if (hidden) {
      const a = absorbed(graph, labels, id);
      carried.push(...a.list);
      carriedCount += a.count;
      skipped++;
      continue;
    }
    const prev = steps.length ? steps[steps.length - 1] : null;
    steps.push({
      ...stepOf(graph, labels, id, prev),
      folded: [...carried, ...own.list],
      folded_count: carriedCount + own.count,
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

// The lineage from `from` down to `to`, as stored ids, root-most first — the
// one walk both a plain replay and a script are checked against.
// → { ok:true, segment, labels, T, fromDefault } | { ok:false, code, error, which }
function lineageSegment(graph, { from, to } = {}) {
  const { computeLabels } = require('../graph');
  const T = resolveNodeRef(graph, to, { allowLive: false });
  if (!T.ok) return { ok: false, code: T.code, error: T.error, which: 'to' };

  // lineage's walk is newest first; a replay plays root … to.
  const chain = ancestry(graph, T.id).reverse();
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
  return { ok: true, segment: chain.slice(startIdx), labels: computeLabels(graph), T, fromDefault };
}

// A node's own folded turns, in caption shape. folded_count counts turns the
// cap aged out of `folded`, too.
function ownFolded(node) {
  const list = Array.isArray(node.folded) ? node.folded.map(foldedEntry) : [];
  return { list, count: Math.max(list.length, Number(node.folded_count) || 0) };
}

// What a HIDDEN node hands on to the next step: the turns folded onto it
// (oldest first — they happened before it did), then its own trigger.
// → { list, count }
function absorbed(graph, labels, id) {
  const node = graph.nodes.get(id) || {};
  const own = ownFolded(node);
  return {
    list: [...own.list, {
      at: node.created_at ?? null,
      author: node.author || null,
      ...captionOf(node.trigger),
      id,
      label: labels.get(id) || id,
      collapsed: true,
    }],
    count: own.count + 1,
  };
}

// One step's caption fields for node `id`, timed against the step before it.
function stepOf(graph, labels, id, prev) {
  const node = graph.nodes.get(id) || {};
  return {
    id,
    label: labels.get(id) || id,
    author: node.author || null,
    ...captionOf(node.trigger),
    created_at: node.created_at ?? null,
    dt_from_prev: prev && Number.isFinite(prev.created_at) && Number.isFinite(node.created_at)
      ? node.created_at - prev.created_at : null,
  };
}

// ── replay scripts ──────────────────────────────────────────────────────────
//
// A SCRIPT is how Claude directs a replay instead of taking every node at one
// pace: the two moments to play between, and — optionally — the beats in
// between, each with its own timing and caption:
//
//   { from, to, title?, default_hold_ms?, include_prompts?,
//     steps?: [{ node | nodes:[…], hold_ms?, caption?, transition?, scroll? }] }
//
// A step names ONE node, or a GROUP of consecutive nodes played as one beat: a
// group shows its last node's surface, and its caption lists every node in it.
// Nodes the steps do not name are not shown — the script picks its moments.
// `scroll` directs where the frame looks while the beat is held: 'auto' (the
// default — what the step added, then what it changed; lib/server/replay/
// document stepFocus), 'none' (stay where the last beat left off), or the id of
// one pane or markdown item on the shown node's page.
// Without `steps` a script is the plain replay: every node on the path as the
// graph draws it, each at the default hold. That is the ONE model every
// consumer plays — the replay document, the player and the GIF/video renderer
// all take normalizeReplayScript's answer; a replay with no script is a script
// with no steps.
//
// Checked, never guessed: every node a step names must lie on the from → to
// path, in path order, each once; a group must be a contiguous run (a node the
// graph viewer hides as a no-change repeat may sit inside it unnamed); holds are
// clamped to HOLD_MIN–HOLD_MAX and captions/titles cut to length. Anything else
// is a refusal naming the step and the node, so the caller can fix the script.

const HOLD_MIN = 500;
const HOLD_MAX = 20000;
const CAPTION_MAX = 280;
const TITLE_MAX = 120;
const TRANSITIONS = ['cut', 'fade'];
const SCRIPT_KEYS = ['from', 'to', 'steps', 'default_hold_ms', 'include_prompts', 'title'];
const STEP_KEYS = ['node', 'nodes', 'hold_ms', 'caption', 'transition', 'scroll'];
const SCROLL_WORDS = ['auto', 'none'];

const clampHold = (n) => Math.round(Math.min(HOLD_MAX, Math.max(HOLD_MIN, n)));
// Whitespace collapsed, then cut to `max` characters (an ellipsis marks the cut).
function clipText(s, max) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

const bad = (error, extra = {}) => ({ ok: false, code: 'bad-script', error, ...extra });

// A hold: absent → null (the default applies), a finite number → clamped,
// anything else → an error string.
function readHold(v, where) {
  if (v == null) return { hold: null };
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return { error: `${where} must be a number of milliseconds (${HOLD_MIN}–${HOLD_MAX})` };
  return { hold: clampHold(n) };
}

// normalizeReplayScript(graph, script, { includeCollapsed })
// → { ok:true, from, to, from_default, title, include_prompts (true|false|null:
//     unsaid), default_hold_ms (null: unsaid), scripted, steps:[path step + {
//     hold_ms, transition, caption, group, scroll (null: auto | 'none' | an
//     item id) }], skipped, truncated, total_steps,
//     script (the same script with every ref pinned to a stored id — normalizing
//     it again gives this same answer) }
// → { ok:false, code, error, which?, step? }  code: a path code (no-active |
//     not-found | live-not-allowed | not-ancestor) | bad-script | off-path |
//     out-of-order | not-contiguous | too-many-steps
function normalizeReplayScript(graph, script = {}, { includeCollapsed = false } = {}) {
  if (script == null || typeof script !== 'object' || Array.isArray(script)) return bad('a replay script is an object: { from, to, steps? }');
  for (const k of Object.keys(script)) {
    if (!SCRIPT_KEYS.includes(k)) return bad(`unknown script field '${k}' — a script takes ${SCRIPT_KEYS.join(', ')}`);
  }
  for (const k of ['from', 'to']) {
    if (script[k] != null && typeof script[k] !== 'string') return bad(`'${k}' is a node label or id`, { which: k });
  }
  let title = null;
  if (script.title != null) {
    if (typeof script.title !== 'string') return bad("'title' is a string");
    title = clipText(script.title, TITLE_MAX) || null;
  }
  if (script.include_prompts != null && typeof script.include_prompts !== 'boolean') return bad("'include_prompts' is true or false");
  const dh = readHold(script.default_hold_ms, "'default_hold_ms'");
  if (dh.error) return bad(dh.error);
  const header = {
    title,
    include_prompts: script.include_prompts ?? null,
    default_hold_ms: dh.hold,
  };

  // No steps: the plain replay, every drawn node at the default hold.
  if (script.steps == null) {
    const r = resolveReplayPath(graph, { from: script.from, to: script.to, includeCollapsed });
    if (!r.ok) return r;
    return {
      ...r,
      ...header,
      scripted: false,
      steps: r.steps.map((s) => ({ ...s, hold_ms: dh.hold, transition: null, caption: null, group: null, scroll: null })),
      script: pinned({ from: r.from.id, to: r.to.id }, header, null),
    };
  }

  if (!Array.isArray(script.steps)) return bad("'steps' is a list of { node | nodes, hold_ms?, caption?, transition? }");
  if (!script.steps.length) return bad("'steps' is empty — leave it out to play every node on the path");
  if (script.steps.length > MAX_STEPS) {
    return { ok: false, code: 'too-many-steps', error: `a script plays at most ${MAX_STEPS} steps; this one has ${script.steps.length} — group trivial nodes into one step` };
  }

  const seg = lineageSegment(graph, { from: script.from, to: script.to });
  if (!seg.ok) return seg;
  const { segment, labels, T } = seg;
  const { computeCollapse } = require('../graph');
  const collapse = includeCollapsed ? null : computeCollapse(graph);
  const hiddenAt = (i) => !!(collapse && (collapse.get(segment[i]) || {}).collapsed);
  const pos = new Map(segment.map((id, i) => [id, i]));
  const labelOf = (id) => labels.get(id) || id;
  const pathName = `${labelOf(segment[0])} → ${T.label}`;

  const steps = [];
  const pinnedSteps = [];
  let lastPos = -1;
  let lastLabel = null;
  // What a step carries, as a plain replay's step does: the run of HIDDEN
  // nodes directly before its first node (back to the step before), each
  // absorbed as the graph viewer absorbs it. A drawn node the script skips
  // ends the run — its turns, and those of hidden nodes above it, went with
  // it. So a script naming every drawn node plays exactly the plain replay,
  // "+N folded" included (a GIF render hands the browser such a script).
  const carriedBefore = (p, after) => {
    let q = p;
    while (q - 1 > after && q - 1 > 0 && hiddenAt(q - 1)) q--;
    const out = { list: [], count: 0 };
    for (let k = q; k < p; k++) {
      const a = absorbed(graph, labels, segment[k]);
      out.list.push(...a.list);
      out.count += a.count;
    }
    return out;
  };

  for (let si = 0; si < script.steps.length; si++) {
    const n = si + 1;
    const st = script.steps[si];
    const prevPos = lastPos;
    if (st == null || typeof st !== 'object' || Array.isArray(st)) return bad(`step ${n} is an object: { node | nodes, hold_ms?, caption?, transition? }`, { step: n });
    for (const k of Object.keys(st)) {
      if (!STEP_KEYS.includes(k)) return bad(`step ${n}: unknown field '${k}' — a step takes ${STEP_KEYS.join(', ')}`, { step: n });
    }
    const hasNode = st.node != null;
    const hasNodes = st.nodes != null;
    if (hasNode === hasNodes) return bad(`step ${n} names its node with exactly one of 'node' (one node) or 'nodes' (a group)`, { step: n });
    const refs = hasNode ? [st.node] : st.nodes;
    if (!Array.isArray(refs) || !refs.length) return bad(`step ${n}: 'nodes' is a non-empty list of node labels or ids`, { step: n });
    const hold = readHold(st.hold_ms, `step ${n}: 'hold_ms'`);
    if (hold.error) return bad(hold.error, { step: n });
    if (st.transition != null && !TRANSITIONS.includes(st.transition)) return bad(`step ${n}: 'transition' is 'cut' or 'fade'`, { step: n });
    if (st.caption != null && typeof st.caption !== 'string') return bad(`step ${n}: 'caption' is a string`, { step: n });
    if (st.scroll != null && (typeof st.scroll !== 'string' || !st.scroll)) return bad(`step ${n}: 'scroll' is 'auto', 'none' or the id of a pane or markdown item on the step's page`, { step: n });

    const ids = [];
    for (let ri = 0; ri < refs.length; ri++) {
      const ref = refs[ri];
      if (typeof ref !== 'string' || !ref) return bad(`step ${n}: a node is named by its label or id`, { step: n });
      const R = resolveNodeRef(graph, ref, { allowLive: false });
      if (!R.ok) return { ok: false, code: R.code, error: `step ${n}: ${R.error} (${ref})`, step: n };
      const p = pos.get(R.id);
      if (p == null) {
        return { ok: false, code: 'off-path', step: n, error: `step ${n}: ${R.label} is not on the replay's path ${pathName} — every step names nodes of that one lineage` };
      }
      if (p <= lastPos) {
        return {
          ok: false, code: 'out-of-order', step: n,
          error: `step ${n}: ${R.label} ${p === lastPos ? 'is named twice' : `comes before ${lastLabel} on the path`} — steps run from → to, each node once`,
        };
      }
      if (ri > 0) {
        const gap = [];
        for (let q = lastPos + 1; q < p; q++) if (!hiddenAt(q)) gap.push(labelOf(segment[q]));
        if (gap.length) {
          return {
            ok: false, code: 'not-contiguous', step: n,
            error: `step ${n}: the group skips ${gap.join(', ')} between ${lastLabel} and ${R.label} — a group is a run of consecutive nodes; name ${gap.length === 1 ? 'it' : 'them'} too, or split the group`,
          };
        }
      }
      lastPos = p;
      lastLabel = R.label;
      ids.push(R.id);
    }

    const shown = ids[ids.length - 1];
    const node = graph.nodes.get(shown) || {};
    const own = ownFolded(node);
    const carried = carriedBefore(pos.get(ids[0]), prevPos);
    // An item id must be on the page this beat shows — a typo would otherwise
    // quietly play as 'auto'.
    const scroll = st.scroll == null || st.scroll === 'auto' ? null : st.scroll;
    if (scroll != null && !SCROLL_WORDS.includes(scroll) && !pageOrder(node).includes(scroll)) {
      return bad(`step ${n}: 'scroll' names '${clipText(scroll, 60)}', which is not a pane or markdown item on ${labelOf(shown)}'s page — use one of its ids, 'auto' or 'none'`, { step: n });
    }
    const caption = st.caption != null ? (clipText(st.caption, CAPTION_MAX) || null) : null;
    const effHold = hold.hold ?? dh.hold;
    steps.push({
      ...stepOf(graph, labels, shown, steps.length ? steps[steps.length - 1] : null),
      folded: [...carried.list, ...own.list],
      folded_count: carried.count + own.count,
      hold_ms: effHold,
      transition: st.transition || null,
      caption,
      group: ids.length > 1 ? ids.map((id) => ({ id, label: labelOf(id) })) : null,
      scroll,
    });
    pinnedSteps.push({
      ...(ids.length > 1 ? { nodes: ids } : { node: ids[0] }),
      ...(hold.hold != null ? { hold_ms: hold.hold } : {}),
      ...(caption ? { caption } : {}),
      ...(st.transition ? { transition: st.transition } : {}),
      ...(scroll != null ? { scroll } : {}),
    });
  }

  const fromId = segment[0];
  return {
    ok: true,
    from: { id: fromId, label: labelOf(fromId) },
    to: { id: T.id, label: T.label },
    from_default: seg.fromDefault,
    ...header,
    scripted: true,
    steps,
    // Path nodes the script does not show.
    skipped: segment.length - steps.reduce((a, s) => a + (s.group ? s.group.length : 1), 0),
    truncated: false,
    total_steps: steps.length,
    script: pinned({ from: fromId, to: T.id }, header, pinnedSteps),
  };
}

function pinned(ends, header, steps) {
  return {
    ...ends,
    ...(header.title ? { title: header.title } : {}),
    ...(header.default_hold_ms != null ? { default_hold_ms: header.default_hold_ms } : {}),
    ...(header.include_prompts != null ? { include_prompts: header.include_prompts } : {}),
    ...(steps ? { steps } : {}),
  };
}

module.exports = {
  resolveReplayPath, normalizeReplayScript, MAX_STEPS, HOLD_MIN, HOLD_MAX, CAPTION_MAX, TITLE_MAX,
};
