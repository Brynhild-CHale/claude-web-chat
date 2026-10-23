'use strict';
// The side table (annotation engine, PLAN.md 2B.2; DECISIONS.md F-SIDE a, A3,
// E-STORE a, F-DOCS a; rulings U311@qualifier-mechanism = a and
// U313@side-table-changed-rule = a): what the live viewers' resolvers answered
// for the elements a committed node carries — exact, re-resolved or orphaned —
// kept beside the node, never in it.
//
//   createSideTable({graph, bus, reports, log}) → ctx.sideTable
//     answersFor(nodeId)        Map('id@v' → answer): the node's own recorded
//                               answers, then each ancestor's along
//                               lineage `ancestry` (the one parent-chain
//                               walk) for an id@v the node carries, taken only
//                               while that answer's qualifier matches the
//                               node's own item spec and store
//     answerOf(nodeId, id, v)   one of them, or null
//     recordOf(id, v)           the converted anchor's full record minted at
//                               the first live resolve (U314), masked, or null
//     stats()                   {commits, sets, items, unchanged, records,
//                               skipped_read_only, no_node, append_failures}
//     stop()                    its bus subscription
//
// WHEN. One subscriber on the main bus acts on `{kind: 'graph', op:
// 'turn-end' | 'commit', id}` — what every commitNode path emits once the node
// file is written and its commit record appended (domain/turns commitNode), so
// the answers record lands AFTER the commit record (node first, log after:
// PLAN 1A.3) and turns.js is not edited. The bus calls a subscriber
// synchronously inside the emit, so a Set active's preserve commit is recorded
// before the restore's reset bumps the report counter and empties the held
// answers.
//
// WHAT. For the committed node: its id@v set is its commit record's pins
// (graph.elements.pinsOf, which carry its E-STORE references after its
// comment copies) plus node.elements and every comment copy holding a `v` —
// so a record set never names an id@v the node does not carry. The
// candidates are reports.recordable(): the held answers whose daemon-stamped
// qualifier {spec, store} equals the committed node's — spec the node's own
// item (reports paneSpec of its mount record, markdownSpec of its markdown
// text), store reports storeDigest(node.store) — so an answer stamped before a
// store write and never confirmed is not recorded, and a service pane's
// (live_only) never is (P-11; GT-06). Nothing here asks whether the node is
// the active one: the held answers are ordered by the per-surface counter and
// the mount gen (B6 = b, U311), and the counter's bump at every reset is what
// keeps a pre-restore answer out.
//
// CHANGED ONLY (E2 a; notes-B Q7). An answer is written when it differs — in
// state, how, why, tie or qualifier — from what the node would inherit along
// its ancestry (answersFor(parent) for that id@v, taken only while its
// qualifier matches the node's own); a candidate that carries a minted record
// the log does not hold yet is written too, so the record is never lost.
// Nothing changed → nothing appended. ONE record set per commit, through the
// element log's one redacting writer (graph.elements.log.appendAnswers, the
// record layer the store exposes; domain/elements.js is not edited), never
// one per report.
//
// THE MINTED RECORD. An answer's `record` (U314's full anchor record, pane
// text) rides the first set that carries its id@v and no later one: the log
// keeps the first in log order (recordOf), passes it through the redactor
// before the bytes land, and it is never a version — versionsOf(id) and the
// version-record ratchet are unchanged.
//
// FAILURE. The element store read-only → nothing appended, counted
// (skipped_read_only). An append that throws goes to
// graph.elements.noteAppendFailure(e) and is counted; the commit has already
// landed and is unaffected. Each step is reached through its object, never a
// captured reference, so a harness can wrap one.
//
// NOT. The side table never enters a node, a draft, the store or the event
// ring (it emits nothing), SNAPSHOT_FIELDS, snapshotView, nodeViewKey and
// liveIsDirty never see it (S-15), and the documents' builders (preview, export,
// replay) take no input from it in this build (F-DOCS a): answersFor / answerOf /
// recordOf are the seam U329's diff_nodes 'orphaned' column reads, and the one
// the documents will read when they draw elements.

const { ancestry, findMount } = require('./lineage');
const { paneSpec, markdownSpec, storeDigest } = require('./reports');
const { parsePin, isAnswerCode } = require('../../core/element-log');

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const pinKey = (id, v) => `${id}@${v}`;

// The content hash of a node's item `mount` (a pane or a markdown item), as
// reports stamped the live one; null when the node has no such item.
function specOf(node, mount) {
  const m = findMount(node, mount);
  if (m) return paneSpec(m);
  const md = (node && Array.isArray(node.markdown) ? node.markdown : []).find((x) => x && x.id === mount);
  return md ? markdownSpec(md.text) : null;
}

// Every id@v a committed node carries: its commit record's pins (the comment
// copies, then its element references), its references, and every comment copy
// that holds a v (a node whose commit record never landed still has those).
function carriedBy(graph, node) {
  const out = new Set();
  const add = (s) => { const p = parsePin(s); if (p) out.add(pinKey(p.id, p.v)); };
  let pins = null;
  try { pins = graph.elements && typeof graph.elements.pinsOf === 'function' ? graph.elements.pinsOf(node.id) : null; } catch { pins = null; }
  for (const s of Array.isArray(pins) ? pins : []) add(s);
  for (const s of Array.isArray(node.elements) ? node.elements : []) add(s);
  for (const c of Array.isArray(node.comments) ? node.comments : []) {
    if (isObj(c) && typeof c.id === 'string' && Number.isSafeInteger(c.v) && c.v > 0) out.add(pinKey(c.id, c.v));
  }
  return out;
}

// One held answer as an answers item: exactly the log's keys, codes that are
// not codes left out (how/why are never text in the log).
function itemOf(a, { withRecord }) {
  const it = { id: a.id, v: a.v, mount: a.mount, state: a.state };
  if (isAnswerCode(a.how)) it.how = a.how;
  if (isAnswerCode(a.why)) it.why = a.why;
  if (typeof a.tie === 'number' && Number.isFinite(a.tie)) it.tie = a.tie;
  it.gen = a.gen;
  it.surface = a.surface;
  it.qual = { spec: a.qual.spec, store: a.qual.store };
  it.source = { peer: a.source.peer, device: a.source.device ?? null };
  if (withRecord && isObj(a.record)) it.record = a.record;
  return it;
}

// Does an answer (held or recorded) say the same as another?
function sameAnswer(a, b) {
  const code = (x) => (isAnswerCode(x) ? x : null);
  const tie = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return a.state === b.state && code(a.how) === code(b.how) && code(a.why) === code(b.why)
    && tie(a.tie) === tie(b.tie)
    && !!a.qual && !!b.qual && a.qual.spec === b.qual.spec && a.qual.store === b.qual.store;
}

function createSideTable({ graph, bus, reports, log = () => {} } = {}) {
  if (!graph) throw new TypeError('createSideTable: graph is required');
  const say = (...a) => { try { log(...a); } catch {} };
  const counts = {
    commits: 0, sets: 0, items: 0, unchanged: 0, records: 0,
    skipped_read_only: 0, no_node: 0, append_failures: 0,
  };
  const recordLog = () => (graph.elements && graph.elements.log) || null;

  // The answers recorded ON a node (its own record set), as Map('id@v' → item).
  function ownOf(nodeId) {
    const l = recordLog();
    const out = new Map();
    if (!l || typeof l.answersOf !== 'function') return out;
    for (const it of l.answersOf(nodeId)) {
      const { record, ...rest } = it;
      void record;
      out.set(pinKey(it.id, it.v), { node: nodeId, ...rest });
    }
    return out;
  }

  // What `node` holds along its ancestry for the id@v in `keys` (a Set), each
  // the nearest recorded answer, taken only while its qualifier matches the
  // node's own item spec and store; `self` says whether the node's own record
  // set is read (answersFor) or skipped (what a commit would inherit).
  function along(node, keys, { self }) {
    const out = new Map();
    if (!node || !keys.size) return out;
    const store = storeDigest(node.store);
    const specs = new Map();
    const spec = (mount) => {
      if (!specs.has(mount)) specs.set(mount, specOf(node, mount));
      return specs.get(mount);
    };
    const open = new Set(keys);
    const chain = ancestry(graph, node.id);
    for (const nid of self ? chain : chain.slice(1)) {
      if (!open.size) break;
      const own = ownOf(nid);
      for (const [k, a] of own) {
        if (!open.has(k)) continue;
        // The nearest recorded answer decides: it carries down while it matches.
        open.delete(k);
        if (nid === node.id || (a.qual && a.qual.store === store && a.qual.spec === spec(a.mount))) out.set(k, a);
      }
    }
    return out;
  }

  function answersFor(nodeId) {
    const node = graph.nodes && graph.nodes.get(nodeId);
    if (!node) return new Map();
    return along(node, carriedBy(graph, node), { self: true });
  }

  function answerOf(nodeId, id, v) {
    return answersFor(nodeId).get(pinKey(id, v)) || null;
  }

  function recordOf(id, v) {
    const l = recordLog();
    return l && typeof l.recordOf === 'function' ? l.recordOf(id, v) : null;
  }

  // At one commit: the changed answers of the committed node, as one set.
  function onCommit(nodeId) {
    counts.commits++;
    const els = graph.elements;
    if (!els || !reports || typeof reports.recordable !== 'function') return;
    if (els.readOnly) { counts.skipped_read_only++; return; }
    const node = graph.nodes && graph.nodes.get(nodeId);
    if (!node) { counts.no_node++; return; }
    const carried = carriedBy(graph, node);
    if (!carried.size) { counts.unchanged++; return; }
    const candidates = reports.recordable({
      specOf: (mount) => specOf(node, mount),
      storeDigest: storeDigest(node.store),
    }).filter((a) => carried.has(pinKey(a.id, a.v)));
    if (!candidates.length) { counts.unchanged++; return; }
    const inherited = along(node, new Set(candidates.map((a) => pinKey(a.id, a.v))), { self: false });
    const l = recordLog();
    const items = [];
    for (const a of candidates) {
      const k = pinKey(a.id, a.v);
      const inh = inherited.get(k);
      const newRecord = isObj(a.record) && !recordOf(a.id, a.v);
      if (inh && sameAnswer(a, inh) && !newRecord) continue;
      items.push(itemOf(a, { withRecord: newRecord }));
    }
    if (!items.length) { counts.unchanged++; return; }
    try {
      if (!l || typeof l.appendAnswers !== 'function') throw new TypeError('the element log has no appendAnswers');
      l.appendAnswers({ node: nodeId, items });
      counts.sets++;
      counts.items += items.length;
      counts.records += items.filter((it) => it.record !== undefined).length;
    } catch (e) {
      counts.append_failures++;
      say(`side table: could not append the answers of ${nodeId} (${(e && (e.code || e.reason || e.message)) || 'error'})`);
      try { els.noteAppendFailure(e); } catch {}
    }
  }

  const off = bus && typeof bus.subscribe === 'function'
    ? bus.subscribe((e) => {
      if (!e || e.kind !== 'graph' || (e.op !== 'turn-end' && e.op !== 'commit') || typeof e.id !== 'string') return;
      try { onCommit(e.id); } catch (err) { say(`side table: ${(err && err.message) || err}`); }
    })
    : null;
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    if (typeof off === 'function') { try { off(); } catch {} }
  }

  const stats = () => ({ ...counts });

  return { answersFor, answerOf, recordOf, stats, stop };
}

module.exports = { createSideTable, specOf };
