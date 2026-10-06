// lib/server/mirror/graph-link.js — the graph link: each closed chat turn and
// the graph node it rode into (spec §2.8, §2.12, §15.4).
//
// A source under the facade's contract (lib/server/mirror/index.js, THE SOURCE
// CONTRACT), built only on the engine it is handed: the turn machine's graph-link
// states on `engine.model` (pendingTurns, attachTurn, orphanPending, linkState,
// segmentOf, resolveTurn) and the model's lookups; `engine.graph`, read and
// never written; `engine.mainBus`, listened to and never emitted on. Its api is
// what the facade's dispatch table routes to:
//
//   attachToNode(nodeId, {commit}) → {v: 1, turns: [ref]} | null
//       commitNode's call (lib/server/domain/turns.js), before the node file is
//       written. Synchronous. Takes EVERY pending turn — closed, not attached,
//       in any conversation, superseded or not — and attaches it to the node.
//       `commit` is the Stop's {session_id, prompt_id, locked} (null for a
//       manual commit and the two preserves): the pending turn of that session
//       whose id, whose `replaces`, or whose resolveTurn alias is that
//       prompt_id gets role 'commit'; every other turn 'folded'. When the
//       prompt_id names no pending turn (a prompt absorbed mid-turn keeps the
//       lock's prompt_id), the session's most recently ended pending turn (the
//       greatest ended_at; a tie goes to the higher seq) gets 'commit' ONLY
//       when `locked` is true — the locked turn-end commit, whose Stop's
//       session holds the lock. On every other path (the 'unlocked-turn'
//       commit, which a late Stop the turn guard had no record of falls through
//       to; /api/commit; both preserves) nothing is inferred and every turn is
//       'folded': a stale Stop is never stamped onto a newer turn (ruling
//       U44@commit-match-fallback, C1 a′, 2026-10-06). A ref is
//       {conversation_id, session_id, turn_id, seq, role, from?, to?}: from/to
//       the turn's byte segment in its session's transcript as far as it has
//       been read (the transcript lags a Stop by about a record), omitted when
//       none is known. References only: no text, no path — the facade's row is
//       exempt from the read boundary and `safe` (a throw answers null).
//   nodeTurns(ref) → {node: {id, label}, turns} | null
//       A node's turns from its node.mirror.turns (the durable record), each the
//       model's serialized header plus `role`, or, when the model no longer
//       holds the turn, {id, conversation_id, session_id, seq, role,
//       unavailable: true}. `live` lists the pending turns, oldest first. A ref
//       domain/refs cannot resolve answers null.
//   summaries() → {nodes: {[node_id]: {turns, superseded, rewound_at?}}}
//       One entry per node carrying node.mirror.turns: how many turns, how many
//       of them a rewind has since superseded, and the newest `at` of the
//       rewound notices covering those (§15.4; the graph's rewind marks).
//
// THE LABEL. commitNode registers the node only after attachToNode returns, so
// the label is unknown at attach time: the turns are attached with the node's
// id as their label, and re-attached with the real one (computeLabels, 'n1.14')
// when the commit's own graph event ({kind: 'graph', op: 'turn-end' | 'commit',
// id}) goes out on the main bus — or, should that be missed, at the next
// reconcile that finds the node registered. The chrome's node chip reads the
// header's label first (public/app/chat-turns.js).
//
// ORPHANS. A re-aim that moves the commit point without a preserve — the main
// bus's {op: 'set-active'} with no `preserved`, and {op: 'new-graph'}, exactly
// where the routes discard the folded accumulator — orphans every pending turn:
// still in the stream, never attached. A 'wipe' stays on the node, and leaves
// them pending. With dirty work set-active's preserve commit has already taken
// them, so its event (which names `preserved`) orphans nothing.
//
// THE BOOT REBUILD (reconcile). The node files are the durable record; the
// mirror's index can be lost, or older than a node. At start() the source maps
// turn_id → {node_id, role} from every node carrying node.mirror.turns, and
// fixes the cutoff at the newest node's created_at. reconcile() runs at start(),
// after each batch another source applies (onChanges) and before each api call
// — more than once, because the transcripts source restores turns after
// start(): a pending turn the map holds is attached to its recorded node and
// role; a pending turn that ended before the cutoff is an orphan; a later one
// stays pending, to ride the next commit. Every turn this source attaches joins
// the map. A committed node is never rewritten (§15.4): nothing here writes the
// graph.
//
// Dependency direction: lib/server/mirror; reads lib/server/graph's labels and
// lib/server/domain/refs's resolver, both required lazily (graph.js
// top-imports the domain modules: the load-time cycle refs.js avoids the same way).

const SOURCE_NAME = 'graph-link';
const ROLES = new Set(['commit', 'folded']);
const MIRROR_V = 1;

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;

// A node's durable record, when it has a usable one.
function mirrorTurns(node) {
  const m = isPlain(node) ? node.mirror : null;
  if (!isPlain(m) || !Array.isArray(m.turns)) return null;
  return m.turns.filter((r) => isPlain(r) && nonEmpty(r.turn_id));
}

// Ordered by conversation, then seq (§2.8's answer order).
function byConversationThenSeq(a, b) {
  const ca = String(a.conversation_id || '');
  const cb = String(b.conversation_id || '');
  if (ca !== cb) return ca < cb ? -1 : 1;
  return (finite(a.seq) ? a.seq : 0) - (finite(b.seq) ? b.seq : 0);
}

function createGraphLinkSource() {
  return { attach };
}

function attach(engine) {
  const model = engine.model;
  const say = (m) => { try { engine.log(m); } catch { /* a logger never breaks a source */ } };

  // turn id → {node_id, role}: the node files' record, plus every attach here.
  const recorded = new Map();
  // node id → the turn ids attached to it here whose label is still the id.
  const awaitingLabel = new Map();
  let cutoff = null;
  let booted = false;
  let offBus = null;

  function graph() {
    const g = engine.graph;
    return g && g.nodes instanceof Map ? g : null;
  }

  function labelsNow() {
    const g = graph();
    if (!g || !(g.topology instanceof Map)) return null;
    const { computeLabels } = require('../graph');
    return computeLabels(g);
  }

  // The node files' record and the boot cutoff (the newest node's created_at).
  function rebuild() {
    booted = true;
    cutoff = null;
    const g = graph();
    if (!g) return;
    for (const node of g.nodes.values()) {
      if (!isPlain(node) || !nonEmpty(node.id)) continue;
      if (finite(node.created_at) && (cutoff === null || node.created_at > cutoff)) cutoff = node.created_at;
      for (const r of mirrorTurns(node) || []) {
        recorded.set(r.turn_id, { node_id: node.id, role: ROLES.has(r.role) ? r.role : 'folded' });
      }
    }
  }

  // The record for a pending turn: its id, the id it replaced, or one the
  // turn machine resolves to it (an alias taken after the node was written).
  function recordOf(t) {
    if (recorded.has(t.id)) return recorded.get(t.id);
    if (nonEmpty(t.replaces) && recorded.has(t.replaces)) return recorded.get(t.replaces);
    return null;
  }

  function attachOne(turnId, nodeId, label, role) {
    const header = model.attachTurn(turnId, { id: nodeId, label, role });
    if (!header) return null;
    recorded.set(header.id, { node_id: nodeId, role });
    return header;
  }

  // Re-attach the turns of `nodeId` waiting for a label, now that it has one.
  function relabel(nodeId, labels) {
    const ids = awaitingLabel.get(nodeId);
    if (!ids) return;
    const g = graph();
    if (!g || !g.nodes.has(nodeId)) return;
    const map = labels || labelsNow();
    const label = map && map.get(nodeId);
    if (!nonEmpty(label)) return;
    awaitingLabel.delete(nodeId);
    for (const id of ids) {
      const turnId = model.resolveTurn(id) || id;
      const rec = recorded.get(turnId) || recorded.get(id);
      if (!rec || rec.node_id !== nodeId || model.linkState(turnId) !== 'attached') continue;
      model.attachTurn(turnId, { id: nodeId, label, role: rec.role });
    }
  }

  function reconcile() {
    if (!booted) rebuild();
    const g = graph();
    if (awaitingLabel.size && g) {
      const labels = labelsNow();
      for (const nodeId of [...awaitingLabel.keys()]) if (g.nodes.has(nodeId)) relabel(nodeId, labels);
    }
    const pending = model.pendingTurns();
    if (!pending.length) return;
    let labels = null;
    for (const t of pending) {
      const rec = recordOf(t);
      if (!rec || !g || !g.nodes.has(rec.node_id)) continue;
      if (!labels) labels = labelsNow();
      const label = (labels && labels.get(rec.node_id)) || rec.node_id;
      attachOne(t.id, rec.node_id, label, rec.role);
    }
    if (cutoff !== null) model.orphanPending({ before: cutoff });
  }

  // ── the main bus: labels and orphans ──
  function onMainEvent(e) {
    if (!isPlain(e) || e.kind !== 'graph') return;
    try {
      if ((e.op === 'turn-end' || e.op === 'commit') && nonEmpty(e.id)) {
        relabel(e.id);
        return;
      }
      if ((e.op === 'set-active' && !e.preserved) || e.op === 'new-graph') {
        reconcile();
        model.orphanPending();
      }
    } catch (err) {
      say(`mirror: ${SOURCE_NAME} graph event failed (${err && err.name === 'TypeError' ? 'TypeError' : 'Error'})`);
    }
  }

  // ── the api ──
  function attachToNode(nodeId, { commit = null } = {}) {
    if (!nonEmpty(nodeId)) return null;
    reconcile();
    const pending = model.pendingTurns();
    if (!pending.length) return null;
    const commitId = commitTurnOf(pending, commit);
    const refs = [];
    const attached = [];
    for (const t of [...pending].sort(byConversationThenSeq)) {
      const role = t.id === commitId ? 'commit' : 'folded';
      const header = attachOne(t.id, nodeId, nodeId, role);
      if (!header) continue;
      attached.push(header.id);
      const ref = {
        conversation_id: header.conversation_id, session_id: header.session_id ?? null,
        turn_id: header.id, seq: header.seq, role,
      };
      const seg = model.segmentOf(header.id);
      if (isPlain(seg) && finite(seg.from) && finite(seg.to)) { ref.from = seg.from; ref.to = seg.to; }
      refs.push(ref);
    }
    if (!refs.length) return null;
    awaitingLabel.set(nodeId, [...(awaitingLabel.get(nodeId) || []), ...attached]);
    return { v: MIRROR_V, turns: refs };
  }

  // The turn the commit's Stop closed (C1 a′): the pending turn of the Stop's
  // session its prompt_id names; else, on the locked turn-end path only, that
  // session's most recently ended pending turn; else none.
  function commitTurnOf(pending, commit) {
    if (!isPlain(commit) || !nonEmpty(commit.session_id)) return null;
    const own = pending.filter((t) => t.session_id === commit.session_id);
    if (!own.length) return null;
    if (nonEmpty(commit.prompt_id)) {
      const named = model.resolveTurn(commit.prompt_id);
      const hit = own.find((t) => t.id === commit.prompt_id || t.replaces === commit.prompt_id || t.id === named);
      if (hit) return hit.id;
    }
    if (commit.locked !== true) return null;
    let best = null;
    for (const t of own) {
      const at = finite(t.ended_at) ? t.ended_at : -Infinity;
      const bestAt = best && finite(best.ended_at) ? best.ended_at : -Infinity;
      if (!best || at > bestAt || (at === bestAt && (finite(t.seq) ? t.seq : 0) > (finite(best.seq) ? best.seq : 0))) best = t;
    }
    return best ? best.id : null;
  }

  function turnView(r) {
    const id = model.resolveTurn(r.turn_id) || r.turn_id;
    const role = ROLES.has(r.role) ? r.role : 'folded';
    const header = model.turn(id) ? model.serializeTurn(id) : null;
    if (header) return { ...header, role };
    return {
      id: r.turn_id, conversation_id: r.conversation_id ?? null, session_id: r.session_id ?? null,
      seq: finite(r.seq) ? r.seq : null, role, unavailable: true,
    };
  }

  function nodeTurns(ref) {
    reconcile();
    if (ref === 'live') {
      return { node: { id: 'live', label: 'live' }, turns: model.pendingTurns().map((t) => model.serializeTurn(t.id)).filter(Boolean) };
    }
    const g = graph();
    if (!g) return null;
    const { resolveNodeRef } = require('../domain/refs');
    const r = resolveNodeRef(g, ref, { allowLive: false });
    if (!r || !r.ok) return null;
    return { node: { id: r.id, label: r.label }, turns: (mirrorTurns(r.node) || []).map(turnView) };
  }

  // The rewound notice covering a superseded turn: walking back over the
  // superseded turns of its session, the first that carries rw_<id> (the
  // notice sits on the first turn of each superseded run).
  function rewoundAt(t) {
    const list = model.turnsOf(t.conversation_id, { session_id: t.session_id });
    let i = list.findIndex((x) => x.id === t.id);
    for (; i >= 0 && list[i].superseded === true; i--) {
      const notice = model.item(`rw_${list[i].id}`);
      if (isPlain(notice) && notice.notice === 'rewound') return finite(notice.at) ? notice.at : null;
    }
    return null;
  }

  function summaries() {
    reconcile();
    const out = {};
    const g = graph();
    if (!g) return { nodes: out };
    for (const node of g.nodes.values()) {
      const refs = mirrorTurns(node);
      if (!refs || !refs.length) continue;
      let superseded = 0;
      let at = null;
      for (const r of refs) {
        const id = model.resolveTurn(r.turn_id) || r.turn_id;
        const t = model.turn(id);
        if (!t || t.superseded !== true) continue;
        superseded += 1;
        const when = rewoundAt(t);
        if (when !== null && (at === null || when > at)) at = when;
      }
      out[node.id] = { turns: refs.length, superseded, ...(at !== null ? { rewound_at: at } : {}) };
    }
    return { nodes: out };
  }

  return {
    start() {
      rebuild();
      if (!offBus && engine.mainBus && typeof engine.mainBus.subscribe === 'function') {
        offBus = engine.mainBus.subscribe(onMainEvent);
      }
      reconcile();
      return Promise.resolve();
    },
    stop() {
      if (offBus) { try { offBus(); } catch { /* already gone */ } offBus = null; }
      return Promise.resolve();
    },
    onChanges() { reconcile(); },
    api: { attachToNode, nodeTurns, summaries },
  };
}

module.exports = { createGraphLinkSource, SOURCE_NAME };
