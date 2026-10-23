'use strict';
// The boot reconcile of the element log against the graph (PLAN 1A.3; GT-10).
//
// createServer calls it ONCE per boot, after graph.load and clearLockOnBoot and
// before the active node is restored: reconcileElements({graph, store, bus,
// paths, migration}) → report. It names every state a crash, a rollback or a
// hand edit can leave the log and the graph in, repairs the ones that can be
// repaired without rewriting a node file, and reports them — never stderr only:
//
//   paths.elementsBootReport   {at, boot, clean, states, timings: {log_load_ms,
//                              reconcile_ms}, log: {bytes, records}, migration,
//                              mint_floor, ack: {appended, keys}}
//                              (lib/core/fsjson writeJsonAtomic)
//   store.setIntegrity(report) where GET /api/health reads it (graph_integrity:
//                              a LOCAL request only, counts and no text)
//   ONE bus event when not clean: {kind: 'integrity', op: 'boot', clean: false,
//                              states: {<state>: count}} — counts only; kind
//                              'integrity', not 'graph', because three
//                              subscribers react to every 'graph' event
//   ONE stderr line when not clean.
//
// COST. O(nodes) through the commit digests: a node whose nodeDigest equals its
// commit record's costs one small hash — no payload hashing and NO redaction
// (GT-12: a boot is not a redaction pass; C-1 stays the migration's one-time
// cost). The version census walks every version's plain fields (v, parent_v)
// and never reads a payload. A payload is hashed only on a node that is already
// not clean (a dangling record, an adoption, a repair).
//
// THE STATES (report.states[<name>] = {count, examples: [≤ 20 ids or file
// names]}, present only when count > 0; some add `detail`). `clean` is
// report.clean: no state but the NORMAL ones.
//
//   node-without-commit-record   a loaded node no commit record names (0.8.5
//        committed it during a rollback, or a crash fell between writeNode and
//        the log append): ADOPTED — store.adopt maps each copy to a version
//        (its own hash-checked v, a seq or hash match, else one appended from
//        the copy) and appends the commit record.
//   rolled-forward   the newest node N (created_at, then id) has N.parent_id ===
//        the meta's active and N is not the meta's last_node: the meta was not
//        saved after N's commit. active and last_node move to N, the pending
//        bookmark is cleared when N carries it (the G-5 duplicated bookmark),
//        pending_folded loses the entries N.folded carries, and the meta is
//        saved once. A deliberate re-aim is never rolled forward: its saveMeta
//        recorded last_node = N.
//   commit-record-without-node   an ORPHAN: a record names a node that did not
//        load (the aside file named when there is one); a node file this boot's
//        load set aside with no record is reported here too (record: false).
//        Never adopted by another node: graph.load claims every n<K>.json*
//        filename, so the id is never minted again. An aside's detail carries
//        max_seq: the highest seq or element id its bytes still show
//        (maxElementSeqIn). The element mint takes the max over every node
//        aside on disk, this boot's and earlier ones', as a floor
//        (report.mint_floor = {seq, files}; GT-10, K1), in both branches.
//   dangling-commit-record   the node loaded but its digest differs from its
//        record's: reported, never adopted as the node's truth (restore still
//        hash-checks every copy through attachLive).
//   node-pins-missing-version   a record pins id@v the log does not hold: the
//        version is re-appended from the node's copy at exactly v (the versions
//        below it reserved), so the pin resolves; `repaired: false` when a later
//        version of the id already exists or the node holds no copy of it.
//   copy-v-mismatch   a copy carries a v that differs from its record's pin, or
//        (on a node already not clean) its payload fails copyMatches against
//        the pinned version; plus what this boot's adoptions counted.
//   id-reminted-suspect   an adopted copy that matched no version of an id the
//        log already holds, with a different created_at: 0.8.5 re-minted the
//        id while rolled back (AG-1's residual: not repairable without
//        rewriting nodes).
//   uncommitted-lost   a version appended in an ENDED epoch that no commit
//        record pins, the restored draft does not hold, no later version was
//        built on and no complete close record after it drops (below): a hard
//        stop's unsaved work. Reported, never deleted. Every epoch but this
//        boot's has ended, and at the reconcile this boot has appended only
//        what the reconcile itself adopts or repairs (all of it pinned), so a
//        version is this boot's exactly when the reconcile appended it.
//   discarded   (normal; U352, DECISIONS F-DEL c) such a version that some
//        COMPLETE close record appended after it (a graceful stop's mark,
//        lib/core/element-log) does not hold: neither committed nor carried by
//        the draft at that graceful stop, so the user dropped it (a delete, a
//        Wipe, a re-aim). C2 stands: a delete appends nothing; the close says
//        what was still held. The check walks only the closes after the
//        version's record index until a complete one lacks it.
//   acknowledged   (normal; U352) a recurring state an earlier boot reported
//        and acknowledged with an ack record ('<state> <key>'): counted here,
//        examples '<state> <key>', instead of under its own name. The
//        ack-eligible states and their keys (ACK_KEYS below): uncommitted-lost
//        (id@v), commit-record-without-node (the record's node id; the aside
//        name for record: false), dangling-commit-record (<node>:<its digest
//        now>, so a node edited again reports again), copy-v-mismatch as
//        compareNodes notes it (<node>:<id>@<v>; this boot's adoption delta has
//        no key), node-pins-missing-version with repaired: false
//        (<node>:<id>@<v>) and bad-line (@<byte offset>; @+<count> for the
//        lines past the offsets the log keeps). An uncommitted-lost version an
//        ack names stays acknowledged even when a later close lacks it (it was
//        lost before that boot began). Every other state is never acked: it
//        does not recur, or it must keep blocking.
//   superseded   (normal) an unpinned version a later version of the same
//        element was built on (its parent_v): an intermediate edit or reply.
//   draft-pinned   (normal) an unpinned version the draft boot will restore
//        holds (draft.json read through fsjson readJson: the draft's own attach
//        runs after the restore).
//   roll-forward-unconfirmed   (normal) the newest node's parent is the active
//        node but the meta carries no last_node (a 0.8.5 meta, or no commit
//        since the upgrade): a crash and a deliberate re-aim look alike there,
//        so nothing moves.
//   meta-set-aside   graph.load set an unreadable _meta.json aside (the active
//        node was recovered from the latest commit).
//   torn-tail-set-aside   the log's torn tail (lib/core/applog), its aside named.
//   bad-line   complete log lines that do not parse: count and byte offsets.
//   migration-refused   the v3→v4 migration refused (U204): its report path;
//        comments are read-only and the log is not compared with the graph.
//   reconcile-error   the reconcile itself threw; the boot goes on.
//
// It never rewrites a node file, the draft or a log record; it appends only
// through the store (adopt; and acknowledge, the ack record) and the log's one
// version writer (appendVersion).
//
// THE ACK (U352). After the report is written, handed to the store and
// announced, a report that is not clean appends ONE ack naming every
// ack-eligible key it reported that no earlier ack names (the full list; the
// examples stay capped), through store.acknowledge: a read-only store
// acknowledges nothing, so such a state keeps being reported, and a refused
// append is counted and logged once by the store, never failing the boot. The
// report then carries ack: {appended: 0|1, keys: <how many it named>} — counts,
// no text — and is written again.

const fs = require('fs');
const path = require('path');
// Reached through the module object (elementLog.copyMatches, .payloadOf), so a
// test can count what a clean boot hashes.
const elementLog = require('../../core/element-log');
const { readJson, writeJsonAtomic } = require('../../core/fsjson');
const { projectPaths } = require('../../core/paths');
const { stableKey } = require('../../core/stable-json');
const { heldCopies } = require('./elements');

const EXAMPLES_MAX = 20;
// The states, in report order. NORMAL ones are counted and leave a boot clean.
const STATES = Object.freeze([
  'node-without-commit-record',
  'rolled-forward',
  'commit-record-without-node',
  'dangling-commit-record',
  'node-pins-missing-version',
  'copy-v-mismatch',
  'id-reminted-suspect',
  'uncommitted-lost',
  'superseded',
  'draft-pinned',
  'discarded',
  'acknowledged',
  'roll-forward-unconfirmed',
  'meta-set-aside',
  'torn-tail-set-aside',
  'bad-line',
  'migration-refused',
  'reconcile-error',
]);
const NORMAL = Object.freeze(new Set(['superseded', 'draft-pinned', 'discarded', 'acknowledged', 'roll-forward-unconfirmed']));
// The states that recur on every boot while their cause stands, so an ack
// record may acknowledge them (U352): each noted with a stable key.
const ACK_KEYS = Object.freeze(new Set([
  'uncommitted-lost',
  'commit-record-without-node',
  'dangling-commit-record',
  'copy-v-mismatch',
  'node-pins-missing-version',
  'bad-line',
]));
// The report's path as a reader names it (relative to .web-chat/).
const REPORT_NAME = 'elements/boot-report.json';

const isPosInt = (n) => Number.isSafeInteger(n) && n > 0;
const nodeSeq = (id) => { const m = /^n(\d+)$/.exec(String(id)); return m ? Number(m[1]) : -1; };
const byAge = (a, b) => (a.created_at - b.created_at) || (nodeSeq(a.id) - nodeSeq(b.id));
const validCopy = (c) => !!c && typeof c === 'object' && typeof c.id === 'string' && c.id !== '';
const copiesOf = (node) => (Array.isArray(node.comments) ? node.comments : []).filter(validCopy);

// `acked`: every '<state> <key>' an earlier ack names (the log's acked()).
function createStates({ acked = new Set() } = {}) {
  const states = new Map();
  // Every ack-eligible '<state> <key>' this boot reported (uncapped).
  const ackKeys = new Set();
  const get = (name) => {
    let s = states.get(name);
    if (!s) { s = { count: 0, examples: [] }; states.set(name, s); }
    return s;
  };
  const isAcked = (name, key) => key != null && ACK_KEYS.has(name) && acked.has(`${name} ${key}`);
  // An ack-eligible state with a key an ack names is counted acknowledged;
  // one no ack names joins the keys this boot acknowledges.
  function keyed(name, key, count) {
    if (key == null || !ACK_KEYS.has(name)) return false;
    const k = `${name} ${key}`;
    if (!acked.has(k)) { ackKeys.add(k); return false; }
    const s = get('acknowledged');
    s.count += count;
    if (s.examples.length < EXAMPLES_MAX) s.examples.push(k);
    return true;
  }
  function note(name, example, detail, key) {
    if (keyed(name, key, 1)) return;
    const s = get(name);
    s.count++;
    if (example != null && s.examples.length < EXAMPLES_MAX) s.examples.push(example);
    if (detail) {
      if (!s.detail) s.detail = [];
      if (s.detail.length < EXAMPLES_MAX) s.detail.push(detail);
    }
  }
  function add(name, count, examples = [], key) {
    if (!(count > 0)) return;
    if (keyed(name, key, count)) return;
    const s = get(name);
    s.count += count;
    for (const e of examples) if (s.examples.length < EXAMPLES_MAX) s.examples.push(e);
  }
  function toJSON() {
    const out = {};
    for (const name of STATES) if (states.has(name)) out[name] = states.get(name);
    return out;
  }
  const clean = () => [...states.keys()].every((k) => NORMAL.has(k));
  return { note, add, toJSON, clean, isAcked, ackKeys: () => [...ackKeys] };
}

function relName(file, webChatDir) {
  if (webChatDir) {
    const rel = path.relative(webChatDir, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return path.basename(file);
}

// The migration runner's answer (lib/update/migrations run) as the report
// carries it: a state, a version, and the refusal's report path.
function migrationSummary(migration, webChatDir) {
  if (!migration || typeof migration !== 'object') return { state: 'none' };
  if (migration.refused) {
    const r = migration.refused;
    const file = r && typeof r.report === 'string' ? r.report : null;
    return { state: 'refused', from: r && r.from != null ? r.from : null, report: file ? relName(file, webChatDir) : null };
  }
  if (migration.deferred != null) return { state: 'deferred', version: migration.deferred };
  if (migration.gap != null) return { state: 'gap', version: migration.gap };
  if (migration.ok) return { state: 'ok', version: migration.version != null ? migration.version : null };
  return { state: 'none' };
}

// ── the parts ───────────────────────────────────────────────────────────────

// Each loaded node against its commit record: the nodes to adopt (in age order,
// so a parent's record exists before its child is adopted) and the pins whose
// version the log lost.
function compareNodes({ nodes, log, states }) {
  const adopt = [];
  const missing = [];
  for (const node of nodes) {
    const rec = log.commitOf(node.id);
    if (!rec) { adopt.push(node); continue; }
    const pins = elementLog.pinMapOf(rec.pins);
    const copies = copiesOf(node);
    const digest = elementLog.nodeDigest(node);
    const clean = digest === rec.digest;
    if (!clean) states.note('dangling-commit-record', node.id, null, `${node.id}:${digest}`);
    for (const c of copies) {
      const v = pins.get(c.id);
      if (c.v != null && c.v !== v) { const k = `${node.id}:${c.id}@${c.v}`; states.note('copy-v-mismatch', k, null, k); continue; }
      // A node already not clean has its copies hash-checked against the pins
      // (a clean node's were checked when its record was written).
      const rv = !clean && isPosInt(v) ? log.version(c.id, v) : null;
      if (rv && !elementLog.copyMatches(c, rv)) { const k = `${node.id}:${c.id}@${v}`; states.note('copy-v-mismatch', k, null, k); }
    }
    for (const [id, v] of pins) {
      if (isPosInt(v) && !log.version(id, v)) missing.push({ node, id, v, copy: copies.find((c) => c.id === id) || null });
    }
  }
  return { adopt, missing };
}

function adoptNodes({ list, store, log, states }) {
  if (!list.length) return;
  const mismatchBefore = store.stats().copy_v_mismatch || 0;
  let failed = 0;
  for (const node of list) {
    // What the log knew of each copy's id before this node was adopted.
    const before = new Map();
    for (const c of copiesOf(node)) {
      if (before.has(c.id)) continue;
      const el = log.element(c.id);
      const next = log.nextV(c.id);
      before.set(c.id, { next, had: next > 1, created_at: el ? el.created_at : null, copy: c });
    }
    let rec = null;
    try {
      rec = store.adopt(node);
    } catch (e) {
      failed++;
      states.note('node-without-commit-record', node.id, { node: node.id, adopted: false, why: (e && e.code) || 'error' });
      continue;
    }
    states.note('node-without-commit-record', node.id, { node: node.id, adopted: !!rec });
    if (!rec) continue;
    for (const [id, v] of elementLog.pinMapOf(rec.pins)) {
      const b = before.get(id);
      if (!b || !b.had || v < b.next) continue; // it matched a version the log held
      const created = b.copy.created_at;
      if (Number.isFinite(created) && b.created_at != null && created !== b.created_at) {
        states.note('id-reminted-suspect', `${node.id}:${id}`);
      }
    }
  }
  if (failed) console.error(`[web-chat] the boot reconcile could not adopt ${failed} node(s) into the element log; the next boot tries again`);
  const delta = (store.stats().copy_v_mismatch || 0) - mismatchBefore;
  if (delta > 0) states.add('copy-v-mismatch', delta);
}

// A pinned version the log lost: re-appended from the node's copy at exactly
// its v (the versions below it reserved) through the store's write gate
// (store.repair, U354): a read-only store, or a filesystem refusal (which
// leaves the store read-only, 'log-unwritable'), answers READ_ONLY, and a
// TypeError leaves the store writable; both are repaired: false.
function repairMissing({ missing, store, states }) {
  for (const m of missing) {
    let repaired = false;
    if (m.copy) {
      try {
        repaired = store.repair({ node: m.node, id: m.id, v: m.v, copy: m.copy }).repaired === true;
      } catch (e) {
        if (!(e instanceof TypeError || (e && e.code === 'READ_ONLY'))) throw e;
        repaired = false;
      }
    }
    const key = `${m.node.id}:${m.id}@${m.v}`;
    // Only an unrepaired pin recurs, so only it is ack-eligible.
    states.note('node-pins-missing-version', key, { node: m.node.id, pin: `${m.id}@${m.v}`, repaired }, repaired ? null : key);
  }
}

// The mint's floor from the node files graph.load set aside (GT-10, ruling
// K1): this boot's (graph.loadReport.nodes_aside) and every earlier boot's
// (`n<K>.json.corrupt-*` in graphDir), each read by the one tolerant scanner,
// and log.reserveSeq(max) — the log's own reservation, so its stats show the
// floor. A reservation is not persisted: the floor is recomputed at every boot
// from the asides on disk, and holds until the user removes an aside.
// → {seq, files: [aside names with a seq], scans: Map(aside name → max)}.
const NODE_ASIDE_RE = /^n\d+\.json\.corrupt-/;
function floorFromAsides({ graph, log, graphDir }) {
  const scans = new Map();
  if (!graphDir) return { seq: 0, files: [], scans };
  const report = graph.loadReport || {};
  const names = new Set();
  for (const a of (Array.isArray(report.nodes_aside) ? report.nodes_aside : [])) {
    if (a && typeof a.aside === 'string' && a.aside) names.add(a.aside);
    // A file the load could not move aside is still under its own name.
    else if (a && typeof a.file === 'string' && /^n\d+\.json$/.test(a.file)) names.add(a.file);
  }
  let listing = [];
  try { listing = fs.readdirSync(graphDir); } catch { listing = []; }
  for (const f of listing) if (NODE_ASIDE_RE.test(f)) names.add(f);
  let seq = 0;
  const files = [];
  for (const name of [...names].sort()) {
    let n = 0;
    try {
      // The pin-shaped seqs inside the bytes' "comments" arrays (U354); the
      // wide scan only when the tear fell before the comments key.
      const text = fs.readFileSync(path.join(graphDir, name), 'utf8');
      const pins = elementLog.maxPinSeqIn(text);
      n = pins.found ? pins.max : elementLog.maxElementSeqIn(text);
    } catch { n = 0; }
    scans.set(name, n);
    if (n > 0) files.push(name);
    if (n > seq) seq = n;
  }
  if (seq > 0) log.reserveSeq(seq);
  return { seq, files, scans };
}

// Records naming no loaded node, the node files this load set aside, and a
// set-aside meta. An aside's detail carries its scan's max_seq.
function findOrphans({ graph, log, states, graphDir, scans = new Map() }) {
  const report = graph.loadReport || {};
  const asides = Array.isArray(report.nodes_aside) ? report.nodes_aside : [];
  const idOf = (file) => { const m = /^(n\d+)\.json$/.exec(String(file || '')); return m ? m[1] : null; };
  const asideOf = new Map();
  for (const a of asides) if (idOf(a.file)) asideOf.set(idOf(a.file), a.aside || null);
  // A file an EARLIER boot set aside: looked up only when a record needs it.
  let listing = null;
  const earlierAside = (id) => {
    if (!graphDir) return null;
    if (listing == null) { try { listing = fs.readdirSync(graphDir); } catch { listing = []; } }
    return listing.find((f) => f.startsWith(`${id}.json.corrupt-`)) || null;
  };
  const maxSeqOf = (aside) => (aside ? { max_seq: scans.get(aside) || 0 } : {});
  const named = new Set();
  for (const rec of log.commits()) {
    if (named.has(rec.node)) continue;
    named.add(rec.node);
    if (graph.nodes.has(rec.node)) continue;
    const aside = asideOf.has(rec.node) ? asideOf.get(rec.node) : earlierAside(rec.node);
    states.note('commit-record-without-node', aside || rec.node, { node: rec.node, aside, record: true, ...maxSeqOf(aside) }, rec.node);
  }
  for (const a of asides) {
    const id = idOf(a.file);
    if (id && named.has(id)) continue;
    states.note('commit-record-without-node', a.aside || a.file, { node: id, aside: a.aside || null, record: false, ...maxSeqOf(a.aside) }, a.aside || a.file);
  }
  if (report.meta_aside) states.note('meta-set-aside', report.meta_aside.aside || '_meta.json');
}

// Ids are never reused: graph.load claims every n<K>.json* filename, and this
// claims every id a commit record names, so a node file that is gone outright
// (no aside left to claim) never lets the next commit re-mint its id and
// shadow the orphan record (commitOf keeps the last record per node, homeOf
// the first).
function claimRecordIds({ graph, log }) {
  for (const rec of log.commits()) {
    const seq = nodeSeq(rec.node);
    if (seq >= graph.nextSeq) graph.nextSeq = seq + 1;
  }
}

// The meta that was not saved after the newest commit.
function rollForward({ graph, nodes, states }) {
  const newest = nodes.length ? nodes[nodes.length - 1] : null;
  if (!newest) return;
  const active = graph.active ?? null;
  if (newest.id === active || newest.id === graph.lastNode) return;
  if ((newest.parent_id ?? null) !== active) return;
  if (graph.lastNode == null) { states.note('roll-forward-unconfirmed', newest.id); return; }
  graph.active = newest.id;
  graph.lastNode = newest.id;
  const pb = graph.pendingBookmark;
  if (pb && newest.bookmarked === true && (newest.name || '') === (pb.name || '') && !!newest.wipe === !!pb.wipe) {
    graph.pendingBookmark = null;
  }
  if (Array.isArray(graph.pendingFolded) && graph.pendingFolded.length && Array.isArray(newest.folded)) {
    const carried = new Set(newest.folded.map((f) => stableKey(f)));
    graph.pendingFolded = graph.pendingFolded.filter((f) => !carried.has(stableKey(f)));
    if (!graph.pendingFolded.length) graph.pendingFoldedDropped = 0;
  }
  try {
    graph.saveMeta();
  } catch (e) {
    console.error(`[web-chat] the boot reconcile could not save graph/_meta.json after rolling forward: ${e && e.message}`);
  }
  states.note('rolled-forward', newest.id, { node: newest.id, from: active });
}

// The id@v of every pin the draft holds, when it is the draft boot restores
// (loadDraft sets any other aside): read through heldCopies, the one reader the
// close record's `held` uses too (U352; K.2-4), so the two never disagree; a
// comment copy whose v the log does not hold is found by its seq, as before.
function draftHeld({ graph, log }) {
  const held = new Set();
  if (!graph.draftPath) return held;
  const r = readJson(graph.draftPath);
  if (!r.ok || !r.value || typeof r.value !== 'object' || r.value.base_active !== (graph.active ?? null)) return held;
  for (const k of heldCopies(r.value)) held.add(k);
  for (const c of (Array.isArray(r.value.comments) ? r.value.comments : [])) {
    if (!validCopy(c) || (isPosInt(c.v) && log.version(c.id, c.v)) || !isPosInt(c.seq)) continue;
    const v = log.bySeq(c.id, c.seq);
    if (isPosInt(v)) held.add(`${c.id}@${v}`);
  }
  return held;
}

// Every version no commit record pins: draft-pinned, superseded, discarded or
// lost. Plain fields only (v, parent_v, the record index, the closes' id@v
// sets): no payload is read, so nothing is redacted. `firstOfBoot` is each id's
// first v this boot could append (an id it does not name is wholly this boot's).
function censusVersions({ log, held, firstOfBoot, states }) {
  const pinned = new Set();
  for (const rec of log.commits()) for (const p of rec.pins) pinned.add(p);
  const closes = log.closes();
  // The first close appended after record index i (closes are in log order).
  const firstAfter = (i) => {
    let lo = 0; let hi = closes.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (closes[mid].index > i) hi = mid; else lo = mid + 1; }
    return lo;
  };
  // Did a complete close after the version drop it? Walks the closes after its
  // record index until a complete one lacks it.
  const dropped = (key, i) => {
    if (i == null) return false;
    for (let k = firstAfter(i); k < closes.length; k++) {
      if (closes[k].complete && !closes[k].held.has(key)) return true;
    }
    return false;
  };
  for (const id of log.ids()) {
    const vers = log.versionsOf(id);
    if (!vers.length) continue;
    const builtOn = new Set();
    for (const r of vers) if (isPosInt(r.parent_v)) builtOn.add(r.parent_v);
    const first = firstOfBoot.has(id) ? firstOfBoot.get(id) : 1;
    for (const r of vers) {
      const key = `${id}@${r.v}`;
      if (pinned.has(key)) continue;
      if (held.has(key)) { states.note('draft-pinned', key); continue; }
      if (builtOn.has(r.v)) { states.note('superseded', key); continue; }
      if (r.v >= first) continue; // this boot's own epoch has not ended
      if (!states.isAcked('uncommitted-lost', key) && dropped(key, log.indexOf(id, r.v))) { states.note('discarded', key); continue; }
      states.note('uncommitted-lost', key, null, key);
    }
  }
}

// ── the reconcile ───────────────────────────────────────────────────────────

function reconcileElements({ graph, store, bus = null, paths, migration = null, now = Date.now } = {}) {
  const t0 = Date.now();
  let acked = new Set();
  try { if (store && store.log && typeof store.log.acked === 'function') acked = store.log.acked(); } catch { acked = new Set(); }
  const states = createStates({ acked });
  let pp = null;
  try { pp = paths && paths.elementsBootReport ? paths : (paths && paths.root ? projectPaths(paths.root) : null); } catch { pp = null; }
  const webChatDir = (pp && pp.dir) || (paths && paths.WEB_CHAT_DIR) || null;
  const graphDir = (paths && paths.GRAPH_DIR) || (pp && pp.graphDir) || null;
  const hasStore = !!(store && store.log);
  let floor = { seq: 0, files: [], scans: new Map() };
  try {
    if (graph && graph.nodes) {
      const nodes = [...graph.nodes.values()].sort(byAge);
      if (hasStore) {
        const log = store.log;
        const st = store.stats();
        if (st.torn) states.note('torn-tail-set-aside', st.torn.aside || `${st.torn.bytes} bytes`);
        if (st.bad > 0) {
          // One key per kept offset (the log is append-only), and one for the
          // lines past the offsets the log keeps.
          const offsets = Array.isArray(st.bad_offsets) ? st.bad_offsets : [];
          for (const off of offsets) states.note('bad-line', off, null, `@${off}`);
          if (st.bad > offsets.length) states.add('bad-line', st.bad - offsets.length, [], `@+${st.bad}`);
        }
        floor = floorFromAsides({ graph, log, graphDir });
        if (migration && migration.refused) {
          // The log is not trusted (D15): nothing is compared or appended.
          states.note('migration-refused', migrationSummary(migration, webChatDir).report || 'migration-report');
          claimRecordIds({ graph, log });
          rollForward({ graph, nodes, states });
        } else {
          const firstOfBoot = new Map();
          for (const id of log.ids()) firstOfBoot.set(id, log.nextV(id));
          const { adopt, missing } = compareNodes({ nodes, log, states });
          adoptNodes({ list: adopt, store, log, states });
          repairMissing({ missing, store, log, states });
          findOrphans({ graph, log, states, graphDir, scans: floor.scans });
          claimRecordIds({ graph, log });
          rollForward({ graph, nodes, states });
          censusVersions({ log, held: draftHeld({ graph, log }), firstOfBoot, states });
        }
      } else {
        rollForward({ graph, nodes, states });
      }
    }
  } catch (e) {
    states.note('reconcile-error', (e && (e.code || e.message)) || 'error');
  }
  let st = null;
  if (hasStore) { try { st = store.stats(); } catch { st = null; } }
  const report = {
    at: now(),
    boot: hasStore ? store.log.bootId : null,
    clean: states.clean(),
    states: states.toJSON(),
    timings: {
      log_load_ms: st && Number.isFinite(st.load_ms) ? st.load_ms : null,
      reconcile_ms: Date.now() - t0,
    },
    log: st
      ? { bytes: (st.bytes_at_load || 0) + (st.appended_bytes || 0), records: (st.complete || 0) + (st.appended_records || 0) }
      : { bytes: 0, records: 0 },
    migration: migrationSummary(migration, webChatDir),
    mint_floor: { seq: floor.seq, files: floor.files },
    ack: { appended: 0, keys: 0 },
    ...(hasStore && store.readOnly ? { read_only: store.readOnlyReason || true } : {}),
  };
  const writeReport = () => {
    if (!pp || !pp.elementsBootReport) return;
    try {
      writeJsonAtomic(pp.elementsBootReport, report, { newline: true });
    } catch (e) {
      console.error(`[web-chat] could not write .web-chat/${REPORT_NAME}: ${(e && (e.code || e.message)) || 'error'}`);
    }
  };
  writeReport();
  if (store && typeof store.setIntegrity === 'function') store.setIntegrity(report);
  if (!report.clean) {
    const counts = countsOf(report);
    const line = Object.entries(counts).filter(([k]) => !NORMAL.has(k)).map(([k, n]) => `${k} ${n}`).join(', ');
    console.error(`[web-chat] the element log and the graph disagreed at boot (${line}); see .web-chat/${REPORT_NAME}`);
    if (bus && typeof bus.emit === 'function') {
      try { bus.emit({ event: { kind: 'integrity', op: 'boot', clean: false, states: counts } }); } catch {}
    }
    // The ack, right after the report (U352): every ack-eligible key reported
    // that no earlier ack names, in ONE record through the store's gate.
    const keys = states.ackKeys().filter((k) => elementLog.isAckKey(k));
    if (keys.length && hasStore && typeof store.acknowledge === 'function') {
      let rec = null;
      try { rec = store.acknowledge(keys); } catch { rec = null; }
      report.ack = { appended: rec ? 1 : 0, keys: keys.length };
      writeReport();
    }
  }
  return report;
}

// {<state>: count} of a report: what the bus event and /api/health carry.
function countsOf(report) {
  const out = {};
  const s = (report && report.states) || {};
  for (const name of Object.keys(s)) out[name] = s[name] && Number.isFinite(s[name].count) ? s[name].count : 0;
  return out;
}

// A report's mint floor seq; a report an older boot wrote (no mint_floor) reads
// as 0.
function mintFloorOf(report) {
  const f = report && report.mint_floor;
  return f && Number.isSafeInteger(f.seq) && f.seq > 0 ? f.seq : 0;
}

// GET /api/health's graph_integrity (a LOCAL request only): counts, never text.
// Null before a reconcile has reported.
function integritySummary(store) {
  const report = store && typeof store.integrity === 'function' ? store.integrity() : null;
  if (!report || typeof report !== 'object') return null;
  return { clean: report.clean === true, states: countsOf(report), report: REPORT_NAME };
}

module.exports = { reconcileElements, integritySummary, countsOf, mintFloorOf, STATES, NORMAL, ACK_KEYS, REPORT_NAME };
