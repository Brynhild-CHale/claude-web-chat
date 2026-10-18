'use strict';
// The v3→v4 comment migration — one home for "map every comment pin a v3
// project holds (the `comments` copies on its graph nodes and its draft) into
// the element log" (PLAN 1A.4; DECISIONS C3 strict-b2, F3 sibling-field, F4,
// G4; GT-09).
//
// THREE PARTS, one direction:
//
//   readProject(stateDir)   reads the node files (fsjson readJson with
//                           element-log's isGraphNode), graph/_meta.json and
//                           draft.json, lists every file it could not read
//                           (never refusing for one), and scans the asides a
//                           0.8.5 daemon left (G-9) for the seqs they hold.
//   planMigration({...})    PURE: no file, no clock, no write. It reads the log
//                           through its read API only and answers what the
//                           migration would append, as an ordered action list
//                           and a report.
//   migrateComments(...)    plans against a DRY-RUN open of the log (strict: a
//                           dry run always comes first), measures the bytes by
//                           playing the actions into that dry open, and — unless
//                           refused or asked for a dry run — plays the same
//                           actions through a real open of lib/core/element-log,
//                           THE writer (U202). This file never spells a record.
//
// THE RULES (per pin id, copies visited in graph order: parents before
// children, one DFS over ancestryIndex's tour):
//
//   strict    a copy with no id, a second copy of one id on one node, a copy with
//             no created_at, or an anchor with no mount is UNMAPPED, and any
//             unmapped copy refuses the whole migration: 0 bytes appended, the
//             report written to projectPaths().migrationReport.
//   reuse (a) on the edge: the nearest ancestor carrier's version, when the
//             copy's payload hash AND its sibling fields (seq, the original
//             locator) equal that version's (F3's beside rule).
//   reuse (b) by hash: a version with the same hash, the same parent_v and equal
//             siblings whose home node is this node or one of its ancestors
//             (C1). A twin whose home is on another branch is REFUSED and the
//             copy mints its own version beside it (F4). A version the log holds
//             with no home yet (a crash between a version and its node's commit
//             record) is taken, and the commit this plan writes homes it.
//   mint (c)  otherwise: v = the log's next v, parent_v = the nearest ancestor
//             carrier's v; its home becomes this node through the commit record
//             the migration writes for it (one per pin-carrying node, graph
//             order, so homeOf answers uniformly).
//
//   payloadOf, convertAnchor and the declared normalisation (an absent
//   `replies` equals [], a reply projected to {author, at, text}) are
//   element-log's, never re-implemented here. The converted anchor
//   (pin-locator@1, ruling A1) is the payload's; the copy's locator rides
//   beside it as the version's `original` sibling, outside both hashes.
//
//   The draft's copies (only when draft.base_active is the active node,
//   loadDraft's own rule; else reported 'draft-stale-skipped') are planned as
//   UNCOMMITTED versions on base_active's ancestry: no commit record.
//
//   Park rule b2 (element-log parkB2/parkMetrics) is computed for the report
//   only and derived on read later; it is never written as state. A page note
//   (anchor null) has no mount to lose, so it counts as present.
//
//   seq_floor is the max seq over every node copy, every draft copy (a stale
//   draft's too) and every `"seq":<n>` in the files a 0.8.5 daemon could have
//   minted ids into and then failed to read: graph/n*.json.corrupt-*,
//   graph/n*.json.*.tmp, draft.json.corrupt-*, draft.json.*.tmp and any node
//   file or draft.json that does not read. The migration record carries it, so
//   the log never mints a seq a copy already holds.
//
//   Two copies of one id with different created_at are flagged
//   'id-reminted-suspect' (reported, never refused): they share one element,
//   whose created_at is the first-visited copy's.
//
// Append-only: the migration never rewrites a node file or the draft
// (CLAUDE.md "never rewrite graph history"). It writes the element log and, on a
// refusal, the report beside it — nothing else.
//
// lib/core: requires only lib/core modules and Node builtins (lib/update may
// import only lib/core: test/dependency-direction.test.js).

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { projectPaths } = require('./paths');
const { readJson, writeJsonAtomic } = require('./fsjson');
const { stableHash, stableStringify } = require('./stable-json');
const { createRedactor } = require('./redact');
const {
  createElementLog, payloadOf, convertAnchor, parkB2, parkMetrics, ancestryIndex, isGraphNode,
} = require('./element-log');

const FROM = 3;
const TO = 4;
const SEQ_RE = /"seq":\s*(\d+)/g;
const NODE_ASIDE_RE = /^n\d+\.json\.(?:corrupt-.*|.+\.tmp)$/;
const DRAFT_ASIDE_RE = /^draft\.json\.(?:corrupt-.*|.+\.tmp)$/;

const isPosInt = (n) => Number.isSafeInteger(n) && n > 0;
// A value as the log's bytes would carry it (undefined dropped), for comparing
// a copy's locator with a stored `original`.
const clean = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

// ── reading the project ─────────────────────────────────────────────────────

function maxSeqIn(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return 0; }
  let max = 0;
  SEQ_RE.lastIndex = 0;
  let m;
  while ((m = SEQ_RE.exec(text))) { const n = Number(m[1]); if (Number.isSafeInteger(n) && n > max) max = n; }
  return max;
}

const whyOf = (r) => (r.invalid ? 'not a graph node' : (r.error && r.error.message) || 'unreadable');

// The project as the migration reads it. Never throws for a file it cannot
// read: it lists it (unreadable) and scans it for seqs (asides).
//   nodes       every node file that reads as a graph node
//   meta        {state: 'ok'|'absent'|'unreadable', active}
//   draft       {state: 'ok'|'absent'|'unreadable', value}
//   unreadable  [{file, why}] (paths relative to .web-chat/)
//   asides      [{file, max_seq}]
function readProject(stateDir) {
  const p = projectPaths(path.dirname(stateDir));
  const rel = (f) => path.relative(p.dir, f).split(path.sep).join('/');
  const nodes = [];
  const unreadable = [];
  const asides = [];
  let names = [];
  try {
    names = fs.readdirSync(p.graphDir).sort();
  } catch (e) {
    if (!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) unreadable.push({ file: rel(p.graphDir), why: e.message });
  }
  for (const f of names) {
    const full = path.join(p.graphDir, f);
    if (f.endsWith('.json') && f !== '_meta.json') {
      // graph.load's own reader and predicate: what it would load, this plans.
      const r = readJson(full, { validate: isGraphNode });
      if (r.ok) { nodes.push(r.value); continue; }
      if (r.absent) continue;
      unreadable.push({ file: rel(full), why: whyOf(r) });
      asides.push({ file: rel(full), max_seq: maxSeqIn(full) });
    } else if (NODE_ASIDE_RE.test(f)) {
      asides.push({ file: rel(full), max_seq: maxSeqIn(full) });
    }
  }
  const mr = readJson(p.meta, { validate: (m) => m && typeof m === 'object' && !Array.isArray(m) });
  let meta;
  if (mr.ok) meta = { state: 'ok', active: mr.value.active || null };
  else if (mr.absent) meta = { state: 'absent', active: null };
  else { meta = { state: 'unreadable', active: null }; unreadable.push({ file: rel(p.meta), why: whyOf(mr) }); }

  const dr = readJson(p.draft, { validate: (d) => d && typeof d === 'object' && !Array.isArray(d) });
  let draft;
  if (dr.ok) draft = { state: 'ok', value: dr.value };
  else if (dr.absent) draft = { state: 'absent', value: null };
  else {
    draft = { state: 'unreadable', value: null };
    unreadable.push({ file: rel(p.draft), why: whyOf(dr) });
    asides.push({ file: rel(p.draft), max_seq: maxSeqIn(p.draft) });
  }
  let top = [];
  try { top = fs.readdirSync(p.dir).sort(); } catch {}
  for (const f of top) if (DRAFT_ASIDE_RE.test(f)) asides.push({ file: f, max_seq: maxSeqIn(path.join(p.dir, f)) });
  return { nodes, meta, draft, unreadable, asides };
}

// ── planning ────────────────────────────────────────────────────────────────

// Why a copy cannot be mapped (strict refuses on any), or null.
function unmappedReason(c, seenInNode) {
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id) return 'no-id';
  if (seenInNode.has(c.id)) return 'duplicate-id-in-node';
  seenInNode.add(c.id);
  if (typeof c.created_at !== 'number' || !Number.isFinite(c.created_at)) return 'no-created_at';
  try { convertAnchor(c.anchor ?? null); } catch (e) { return (e && e.reason) || 'anchor-not-convertible'; }
  return null;
}

// The active node as graph.load settles it: _meta.json's active when it names a
// loaded node; null when the meta says null or is absent; the latest node when
// the meta is unreadable or names a node that is not there.
function activeOf(nodes, meta) {
  const latest = () => {
    let best = null;
    for (const n of nodes) if (!best || n.created_at > best.created_at) best = n;
    return best ? best.id : null;
  };
  if (!meta || meta.state === 'absent') return null;
  if (meta.state === 'unreadable') return latest();
  if (meta.active && !nodes.some((n) => n.id === meta.active)) return latest();
  return meta.active || null;
}

const presentOn = (node) => {
  const ids = new Set();
  for (const m of (Array.isArray(node.mounts) ? node.mounts : [])) if (m && m.id != null) ids.add(String(m.id));
  for (const m of (Array.isArray(node.markdown) ? node.markdown : [])) if (m && m.id != null) ids.add(String(m.id));
  return ids;
};

// planMigration({nodes, meta, draft, log, asides, redact}) — PURE.
//   nodes   graph nodes (readProject().nodes)
//   meta    {state, active} (readProject().meta)
//   draft   {state, value} (readProject().draft), or null
//   log     a LOADED element log (a dry-run open is enough); only its read API
//           is used (element, version, byHash, homeOf, pinsOf, nextV)
//   asides  [{file, max_seq}] (readProject().asides)
//   redact  the redactor's value(), to compare a copy's locator with a stored
//           (redacted) `original`; identity when omitted
// Returns {refused, unmapped, counters, park, seq_floor, draft, suspects,
// refused_reuse, nodes, copies, versions, elements, draft_copies, graph_nodes,
// active, actions, detail} (nodes: the pin-carrying ones; versions: the id@v
// pinned anywhere; elements: the pin ids):
// `actions` is the ordered list the apply plays through element-log, `detail`
// the per-copy mapping and park state (left out of the report).
function planMigration({ nodes = [], meta = null, draft = null, log, asides = [], redact = null } = {}) {
  if (!log || typeof log.byHash !== 'function') throw new TypeError('planMigration: a loaded element log');
  const red = typeof redact === 'function' ? redact : (x) => x;

  // The graph as graph.load holds it (a later file of one id wins), in a stable
  // order: created_at, then the id's number.
  const seqOfId = (id) => Number(String(id).slice(1));
  const byId = new Map();
  for (const n of [...nodes].filter(isGraphNode).sort((a, b) => (a.created_at - b.created_at) || (seqOfId(a.id) - seqOfId(b.id)))) byId.set(n.id, n);
  const graphNodes = [...byId.values()];
  const anc = ancestryIndex(graphNodes);
  const order = graphNodes.filter((n) => anc.tin.has(n.id)).sort((a, b) => anc.tin.get(a.id) - anc.tin.get(b.id))
    .concat(graphNodes.filter((n) => !anc.tin.has(n.id)));
  // A parent edge the tour walked (a node on a parent cycle has none), so every
  // walk up terminates.
  const parentOf = (id) => {
    const n = byId.get(id);
    const p = n && n.parent_id;
    return p != null && p !== id && anc.tin.has(id) && anc.tin.has(p) && anc.isAncestorOrSelf(p, id) ? p : null;
  };
  const isAnc = (a, n) => a != null && n != null && (a === n || anc.isAncestorOrSelf(a, n));
  const active = activeOf(graphNodes, meta);

  const counters = {
    reused_on_edge: 0, reused_by_hash: 0, reused_homeless: 0,
    minted_root: 0, minted_edge: 0, beside_only_mints: 0, reuse_refused_home_off_ancestry: 0,
    elements_new: 0, versions_new: 0, commits_new: 0, commits_present: 0,
  };
  const unmapped = [];
  const refusedReuse = [];
  const actions = [];
  const detail = { pins: new Map(), draft: [], states: new Map() };

  // What this plan adds, beside what the log already holds.
  const planned = new Map();      // id → Map(v → info)
  const plannedHash = new Map();  // id → Map(hash → [v])
  const plannedMaxV = new Map();  // id → max planned v
  const plannedEl = new Set();
  const claimed = new Map();      // 'id@v' → node (a homeless log version this plan homes)
  const logInfo = new Map();      // 'id@v' → info read from the log (cached)
  const carriers = new Map();     // id → Map(node → {v, key: the copy as JSON})
  const createdAts = new Map();   // id → Map(created_at → [node])
  let seqFloor = 0;
  const noteSeq = (s) => { if (Number.isSafeInteger(s) && s > seqFloor) seqFloor = s; };
  for (const a of asides) noteSeq(a && a.max_seq);

  function info(id, v) {
    const m = planned.get(id);
    if (m && m.has(v)) return m.get(v);
    const key = `${id}@${v}`;
    if (!logInfo.has(key)) {
      const r = log.version(id, v);
      logInfo.set(key, r ? {
        fromLog: true, parent_v: r.parent_v ?? null, seq: r.seq,
        hashes: [r.payload_hash, r.src_hash], orig: stableStringify(clean(r.original)),
      } : null);
    }
    const i = logInfo.get(key);
    if (!i) return null;
    return { ...i, home: log.homeOf(id, v) ?? claimed.get(key) ?? null };
  }
  const nextVOf = (id) => Math.max(log.nextV(id) - 1, plannedMaxV.get(id) || 0) + 1;

  function noteCreated(c, where) {
    let m = createdAts.get(c.id);
    if (!m) { m = new Map(); createdAts.set(c.id, m); }
    if (!m.has(c.created_at)) m.set(c.created_at, []);
    m.get(c.created_at).push(where);
  }

  // Map one copy: returns its v. `start` is where the carrier walk begins (the
  // parent for a node, base_active itself for the draft); `home` the node a
  // minted version is homed on (null for the draft); `homeOk` C1's test;
  // `where` names the copy's place in the report.
  function mapCopy(c, { start, home, homeOk, where }) {
    const id = c.id;
    const nv = carriers.get(id) || new Map();
    let a = start;
    while (a != null && !nv.has(a)) a = parentOf(a);
    const carrier = a != null ? nv.get(a) : null;
    const pv = carrier ? carrier.v : null;
    // The common case, cheaply: a copy byte-identical (as JSON) to its nearest
    // carrier's has that copy's payload, seq and locator, so rule (a) holds
    // for it exactly as it held for the carrier's — no hash needed.
    const key = JSON.stringify(c);
    if (carrier && carrier.key === key) { counters.reused_on_edge++; return { v: pv, key }; }
    const payload = payloadOf(c);
    const h = stableHash(payload);
    let origRaw = null;
    let origRed = null;
    const rawOrig = () => (origRaw ??= stableStringify(clean(c.anchor ?? null)));
    const origOf = (i) => (typeof i.orig === 'function' ? (i.orig = i.orig()) : i.orig);
    const origFor = (i) => (i.fromLog ? (origRed ??= stableStringify(clean(red(clean(c.anchor ?? null))))) : rawOrig());
    const sibEq = (i) => (!isPosInt(c.seq) || i.seq == null || i.seq === c.seq) && origOf(i) === origFor(i);
    let v = null;
    let hashOnly = false;
    let refused = false;
    if (pv != null) {
      const i = info(id, pv);
      if (i && i.hashes.includes(h)) {
        if (sibEq(i)) { v = pv; counters.reused_on_edge++; } else hashOnly = true;
      }
    }
    if (v == null) {
      const cands = new Set(log.byHash(id, h));
      for (const x of (((plannedHash.get(id) || new Map()).get(h)) || [])) cands.add(x);
      for (const x of [...cands].sort((p, q) => p - q)) {
        const i = info(id, x);
        if (!i || (i.parent_v ?? null) !== pv) continue;
        if (!sibEq(i)) { hashOnly = true; continue; }
        if (i.home == null) {
          if (!i.fromLog) continue;
          // A version a crash left before its node's commit record: this plan homes it.
          v = x;
          if (home != null) claimed.set(`${id}@${x}`, home);
          counters.reused_homeless++;
          break;
        }
        if (homeOk(i.home)) { v = x; counters.reused_by_hash++; break; }
        refused = true;
      }
    }
    if (v == null) {
      if (!log.element(id) && !plannedEl.has(id)) {
        plannedEl.add(id);
        actions.push({ op: 'el', id, created_at: c.created_at });
        counters.elements_new++;
      }
      v = nextVOf(id);
      plannedMaxV.set(id, v);
      if (!planned.has(id)) planned.set(id, new Map());
      const anchor = c.anchor ?? null;
      planned.get(id).set(v, { fromLog: false, parent_v: pv, seq: isPosInt(c.seq) ? c.seq : null, hashes: [h], orig: origRaw ?? (() => stableStringify(clean(anchor))), home });
      if (!plannedHash.has(id)) plannedHash.set(id, new Map());
      const hm = plannedHash.get(id);
      if (!hm.has(h)) hm.set(h, []);
      hm.get(h).push(v);
      const last = payload.replies[payload.replies.length - 1];
      actions.push({
        op: 'ver', id, v, parent_v: pv, seq: isPosInt(c.seq) ? c.seq : undefined, payload,
        original: c.anchor ?? null, author: last && last.author != null ? last.author : 'user',
        at: last && Number.isFinite(last.at) ? last.at : c.created_at,
      });
      counters.versions_new++;
      if (pv == null) counters.minted_root++; else counters.minted_edge++;
      if (hashOnly) counters.beside_only_mints++;
      if (refused) { counters.reuse_refused_home_off_ancestry++; refusedReuse.push({ id, node: where, v }); }
    }
    return { v, key };
  }

  // The graph, in order.
  let copies = 0;
  let pinNodes = 0;
  const parkCopies = [];
  for (const n of order) {
    const list = Array.isArray(n.comments) ? n.comments : [];
    if (!list.length) continue;
    const seen = new Set();
    const pins = [];
    const present = presentOn(n);
    for (const c of list) {
      copies++;
      if (c && typeof c === 'object') noteSeq(c.seq);
      const why = unmappedReason(c, seen);
      if (why) { unmapped.push({ node: n.id, id: c && typeof c === 'object' && typeof c.id === 'string' ? c.id : null, reason: why }); continue; }
      noteCreated(c, n.id);
      const { v, key } = mapCopy(c, { start: parentOf(n.id), home: n.id, homeOk: (h) => isAnc(h, n.id), where: n.id });
      if (!carriers.has(c.id)) carriers.set(c.id, new Map());
      carriers.get(c.id).set(n.id, { v, key });
      pins.push(`${c.id}@${v}`);
      parkCopies.push({
        node: n.id, id: c.id, text: c.text, shared: c.shared, replies: Array.isArray(c.replies) ? c.replies : [],
        anchor_mount_present: c.anchor == null ? true : present.has(String(c.anchor.mount)),
      });
    }
    if (!pins.length) continue;
    pinNodes++;
    detail.pins.set(n.id, pins);
    const have = log.pinsOf(n.id);
    if (have && stableStringify(have) === stableStringify(pins)) { counters.commits_present++; continue; }
    actions.push({ op: 'commit', node: n, pins });
    counters.commits_new++;
  }

  // The draft: uncommitted versions on base_active's ancestry, only when
  // loadDraft would restore it.
  const dv = draft && draft.state === 'ok' ? draft.value : null;
  const dList = dv && Array.isArray(dv.comments) ? dv.comments : [];
  for (const c of dList) if (c && typeof c === 'object') noteSeq(c.seq);
  const draftOut = {
    state: !draft || draft.state === 'absent' ? 'absent' : draft.state === 'unreadable' ? 'draft-unreadable' : null,
    base_active: dv ? (dv.base_active ?? null) : null, active, copies: dList.length, versions_new: 0,
  };
  if (dv) {
    if (dv.base_active !== active) draftOut.state = 'draft-stale-skipped';
    else if (!dList.length) draftOut.state = 'empty';
    else {
      draftOut.state = 'migrated';
      const base = dv.base_active;
      const seen = new Set();
      const before = counters.versions_new;
      for (const c of dList) {
        const why = unmappedReason(c, seen);
        if (why) { unmapped.push({ node: 'draft', id: c && typeof c === 'object' && typeof c.id === 'string' ? c.id : null, reason: why }); continue; }
        noteCreated(c, 'draft');
        const { v } = mapCopy(c, { start: base ?? null, home: null, homeOk: (h) => isAnc(h, base), where: 'draft' });
        detail.draft.push(`${c.id}@${v}`);
      }
      draftOut.versions_new = counters.versions_new - before;
    }
  }
  const draftCopies = draftOut.state === 'migrated' ? dList.length : 0;

  // Park rule b2, for the report.
  const park = parkB2(parkCopies, { parentOf });
  for (const c of parkCopies) detail.states.set(`${c.node}|${c.id}`, park.stateOf(c));
  const metrics = parkMetrics(parkCopies, graphNodes, park.stateOf);
  const states = { present: 0, orphan: 0, parked: 0 };
  for (const s of detail.states.values()) states[s]++;

  const suspects = [];
  for (const [id, m] of createdAts) {
    if (m.size < 2) continue;
    suspects.push({ id, reason: 'id-reminted-suspect', created_at: [...m.keys()].sort((p, q) => p - q), nodes: [...new Set([...m.values()].flat())] });
  }

  const pinIds = new Set(carriers.keys());
  for (const x of detail.draft) pinIds.add(x.slice(0, x.lastIndexOf('@')));
  const mapped = new Set();
  for (const l of detail.pins.values()) for (const x of l) mapped.add(x);
  for (const x of detail.draft) mapped.add(x);
  const refusedAll = unmapped.length > 0;
  const counts = { nodes: pinNodes, copies, versions: mapped.size, elements: pinIds.size, draft_copies: draftCopies };
  if (!refusedAll && (copies > 0 || draftCopies > 0)) {
    actions.push({ op: 'migration', from: FROM, to: TO, seq_floor: seqFloor, ...counts });
  }
  return {
    refused: refusedAll,
    unmapped,
    counters,
    park: { rule: 'b2', ...metrics, states },
    seq_floor: seqFloor,
    draft: draftOut,
    suspects,
    refused_reuse: refusedReuse,
    ...counts,
    graph_nodes: graphNodes.length,
    active,
    actions,
    detail,
  };
}

// Play a plan's actions through an element log (dry or real). A version whose
// v is not the planned one means the log changed under the plan: throw before
// writing anything that would pin the wrong v.
function applyPlan(log, plan) {
  for (const a of plan.actions) {
    if (a.op === 'el') {
      log.ensureElement({ id: a.id, kind: 'comment', created_at: a.created_at });
    } else if (a.op === 'ver') {
      if (log.nextV(a.id) !== a.v) throw new Error(`element-migrate: ${a.id}@${a.v} was planned, the log would write ${a.id}@${log.nextV(a.id)}`);
      log.appendVersion({ id: a.id, payload: a.payload, parent_v: a.parent_v, seq: a.seq, author: a.author, at: a.at, original: a.original });
    } else if (a.op === 'commit') {
      log.appendCommit({ node: a.node, pins: a.pins });
    } else if (a.op === 'migration') {
      const { op, ...rec } = a;
      log.appendMigration(rec);
    }
  }
}

// The report: the plan without its actions and detail, plus what the run
// learned (derive_ms, the bytes, the files it could not read).
function reportOf(plan, project, extra) {
  const { actions, detail, ...rest } = plan;
  const ver = actions.filter((a) => a.op === 'ver').length;
  return {
    from: FROM,
    to: TO,
    ...rest,
    versions_to_mint: ver,
    reused: plan.counters.reused_on_edge + plan.counters.reused_by_hash + plan.counters.reused_homeless,
    unreadable: project.unreadable,
    asides: project.asides.filter((a) => a.max_seq > 0),
    ...extra,
  };
}

const round = (ms) => Math.round(ms * 10) / 10;

// migrateComments(stateDir, {dryRun, redactor, bootId, now, fsync}) →
//   {ok, already: true, migration}              the log holds the migration record (0 bytes)
//   {ok, empty: true, report}                   no copy anywhere: nothing written, no directory
//   {refused: true, report, report_file}        an unmapped copy: 0 bytes appended; the report
//                                               written (not on a dry run: report_file null)
//   {ok, dry_run: true, report}                 the dry run's answer (nothing written)
//   {ok, migrated: true, report}                appended; report.appended counts the bytes
// Every element log it opens is closed before it returns, on every path (a
// throw included), so the daemon's store can open the same log right after.
function migrateComments(stateDir, { dryRun = false, redactor = createRedactor(), bootId, now = Date.now, fsync = false } = {}) {
  const paths = projectPaths(path.dirname(stateDir));
  const file = paths.elementsLog;
  const boot = bootId != null ? String(bootId) : `${process.pid}:${now()}`;
  const opts = { file, redactor, bootId: boot, now, fsync };
  let dry = null;
  let real = null;
  try {
    dry = createElementLog({ ...opts, dryRun: true });
    dry.load();
    if (dry.migration()) return { ok: true, already: true, migration: dry.migration() };
    const project = readProject(stateDir);
    const t0 = performance.now();
    const plan = planMigration({
      nodes: project.nodes, meta: project.meta, draft: project.draft, log: dry, asides: project.asides,
      redact: (x) => redactor.value(x),
    });
    const derive_ms = round(performance.now() - t0);
    if (plan.refused) {
      const report = reportOf(plan, project, { derive_ms, would_append: { records: 0, bytes: 0 }, dry_run: !!dryRun });
      if (!dryRun) writeJsonAtomic(paths.migrationReport, report, { newline: true });
      return { refused: true, report, report_file: dryRun ? null : paths.migrationReport };
    }
    if (plan.copies === 0 && plan.draft.state !== 'migrated') {
      return { ok: true, empty: true, report: reportOf(plan, project, { derive_ms, would_append: { records: 0, bytes: 0 }, dry_run: !!dryRun }) };
    }
    applyPlan(dry, plan);
    const ds = dry.stats();
    const report = reportOf(plan, project, { derive_ms, would_append: { records: ds.pending_records, bytes: ds.pending_bytes }, dry_run: !!dryRun });
    dry.close();
    dry = null;
    if (dryRun) return { ok: true, dry_run: true, report };
    real = createElementLog(opts);
    real.load();
    if (real.migration()) return { ok: true, already: true, migration: real.migration() };
    applyPlan(real, plan);
    const rs = real.stats();
    report.appended = { records: rs.appended_records, bytes: rs.appended_bytes };
    return { ok: true, migrated: true, report };
  } finally {
    if (dry) dry.close();
    if (real) real.close();
  }
}

module.exports = {
  readProject,
  planMigration,
  applyPlan,
  migrateComments,
  activeOf,
  FROM,
  TO,
};
