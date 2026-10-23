'use strict';
// The element record layer — one home for "what an element (a comment pin, in
// tranche 1) is, every version of its text, and which graph node pinned which
// version", kept in ONE append-only log on lib/core/applog's engine.
//
// It lives in lib/core, not lib/server, because the v3→v4 migration
// (lib/update) may import only lib/core (test/dependency-direction.test.js).
// The daemon's store (lib/server/domain/elements) is a thin binding over it.
//
// THE FILE: .web-chat/elements/log.jsonl (projectPaths().elementsLog), one
// record per line, each a plain object whose `t` names its type:
//
//   epoch      {boot, at, pid}  the engine's own, written lazily before the
//              first append of each open (lib/core/applog)
//   el         {id, kind, created_at}  an element's identity, once per id
//   ver        {id, v, parent_v, seq, schema, payload, payload_hash, src_hash,
//              original, writer, provenance, owner, author, at}  one version
//   commit     {node, parent, created_at, pins: ['c3@2', …], digest, at}  a
//              committed node and the id@v of every pin it carries
//   migration  {from, to, at, seq_floor, …counts}  the v3→v4 migration's mark
//   close      {boot, at, held: ['c3@2', …], complete}  a graceful shutdown's
//              mark, written after the draft (U352; DECISIONS F-DEL c): the
//              id@v of every live copy the shutdown held. `complete` is false
//              when the draft was not written or a live copy carried no v, and
//              such a close covers nothing. Ids only, never text.
//   ack        {boot, at, keys: ['uncommitted-lost c3@2', …]}  the boot
//              reconcile's acknowledgement of persistent states it reported
//              ('<state> <key>'), so a later boot counts them as acknowledged.
//              Keys only, never text.
//
// A malformed close or ack is counted `skipped`, never fatal; a reader older
// than these two (0.9.0-alpha.1) counts them `unknown` and ignores them.
//
// `v` counts per element (1, 2, …); `seq` is ONE counter across every version
// of every element: it mints ids ('c' + the first version's seq), it is the
// API's pin.seq, and it is the comment cursor. `parent_v` lives only in the
// version record.
//
// THE ONE WRITER OF ELEMENT TEXT (PLAN 1A.5; C-13). appendVersion is the only
// code in lib/, bin/ or scripts/ that spells a version record
// (test/conventions.test.js holds it). It passes the payload through the
// INJECTED redactor (a lib/core/redact createRedactor() instance; this file
// never builds one) BEFORE the bytes land, and so the four sibling fields
// and the author. Every anchor record stored later carries pane text (64
// characters of the element's head, plus 128 per row-like ancestor: 1C's
// record, lib/core/anchors.js): whoever persists one — tranche 2's side table
// and its element writes — goes through this writer too, never a write of
// its own.
//
// THE TWO HASHES. payload_hash is stableHash of the stored (redacted) payload;
// src_hash is stableHash of the payload as the caller held it (raw, always:
// DECISIONS C3), so a node copy written raw by 0.8.5 still finds its version
// without running the redactor at boot. Both cover exactly {text, shared,
// replies, anchor} (payloadOf). The sibling fields — `original` (the locator as
// the copy stored it, F3), `writer` ({class, owner, verified}), `provenance`
// (queue.provenance's object) and `owner` (the advisory owner, null in tranche
// 1) — sit OUTSIDE both: changing any of them changes neither hash (F3). A
// write's writer and provenance ride the version that write appended (an add,
// an edit or a reply), never the payload (ruling A2).
//
// READING. load() builds every index in applog's onRecord callback and redacts
// NOTHING (GT-12: a boot is not a redaction pass). Text is masked lazily, at
// read time: version(), latest() and versionsOf() hand out views whose payload
// and sibling fields pass the redactor when they are read, and maskView(rec)
// is the eager form, so a value the redactor learns after the write (addKnown)
// is masked on every read while the bytes on disk are never rewritten. The raw
// indexed record never leaves this closure.
//
// MINTING (PLAN 1A.2, G-9). nextSeq() = 1 + the max of every version's seq,
// every reserveSeq(n), the migration record's seq_floor and every `"seq":<n>`
// in the log's own `<file>.torn-*` asides (a torn tail may hold the newest
// seq a crash never finished writing), and every id or seq the boot reconcile
// reads in an unreadable node file's aside (its reserveSeq; GT-10, K1). One
// tolerant scanner reads all such bytes: maxElementSeqIn. nextV(id) = 1 + the max of every v seen
// for the id and every reserve(id, v). Both are peeks; a version or a
// reservation consumes. mintId() reserves a fresh seq and returns 'c' + it, and
// that id's first version takes the same seq, so an id is always 'c' + the
// seq of its first version. Neither ever decreases across a reopen.
//
// THE HOME NODE (DECISIONS C1). homeOf(id, v) is the node of the FIRST commit
// record, in log order, whose pins name id@v.
//
// THE COMMIT DIGEST (notes-A D4). nodeDigest covers a node's identity and its
// pins' id@v, never the file's bytes: a node file is rewritten in place by a
// bookmark (routes/graph.js), a node theme (routes/theme.js) and the late-Stop
// patch (turn-guard.js), none of which changes it. A copy with no `v` (a node
// written before the upgrade, or by 0.8.5 during a rollback) contributes
// `id@`, so the migration and the daemon's boot compute one digest from one
// file.
//
// lib/core: requires only lib/core modules and Node builtins.

const fs = require('fs');
const path = require('path');
const { openLog } = require('./applog');
const { stableHash, stableStringify } = require('./stable-json');

const SCHEMA = 'comment@1';
const CONVERTED = 'pin-locator@1';
// The sibling fields of a version: redacted on write and on read, outside both hashes.
const SIBLINGS = ['original', 'writer', 'provenance', 'owner'];
// The only keys a version's payload may own: both hashes cover these and
// nothing else (PLAN 1A.4; F3), so appendVersion refuses any other.
const PAYLOAD_KEYS = new Set(['text', 'shared', 'replies', 'anchor']);

const isPosInt = (n) => Number.isSafeInteger(n) && n > 0;
const pinKey = (id, v) => `${id}@${v}`;
// The id@v a close record holds: an element id (a letter, then letters, digits,
// '_' or '-', at most 64) and a positive decimal v. Ids only, so a close never
// carries text; heldCopies (lib/server/domain/elements) keeps only what passes.
const PIN_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}@[1-9][0-9]{0,15}$/;
const isPinKey = (s) => typeof s === 'string' && PIN_KEY_RE.test(s) && isPosInt(Number(s.slice(s.lastIndexOf('@') + 1)));
// An ack key: '<state> <key>', the state a lowercase name and the key ids,
// file names, digests or offsets (letters, digits and @ : . _ + -) — never text.
const ACK_KEY_RE = /^[a-z][a-z-]{0,63} [A-Za-z0-9@:._+-]{1,200}$/;
const isAckKey = (s) => typeof s === 'string' && ACK_KEY_RE.test(s);
// A value exactly as the log's bytes carry it (an undefined property dropped,
// as JSON.stringify drops it), so a stored record rehashes to its own hashes
// whether it was just appended or read back from disk.
const jsonClean = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

// ── pure helpers ────────────────────────────────────────────────────────────

// The legacy pin locator ({mount, selector, text, ordinal}) as an element
// anchor record, form pin-locator@1 (ruling A1, notes-A D6). Pure. On a legacy
// locator it reads only the four locator fields (C-10); a record that already
// has the full converted shape (isConverted) is returned as it is, so the
// converter is idempotent on its own output. Anything else is a legacy
// locator, however it names its form: the anchor is client data, stored as the
// pane sent it. The record has no row head: the migration has no DOM. A
// locator with no string mount cannot be placed anywhere and throws
// {reason: 'anchor-without-mount'}.
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function isConverted(a) {
  if (!own(a, 'form') || a.form !== CONVERTED) return false;
  const { v, kind, mount, path: p, fingerprint: f, ordinal } = a;
  return v === 1 && kind === 'element' && typeof mount === 'string' && mount !== ''
    && !!p && typeof p === 'object' && typeof p.selector === 'string'
    && !!f && typeof f === 'object' && typeof f.tag === 'string' && typeof f.text === 'string'
    && Array.isArray(f.classes) && f.classes.every((c) => typeof c === 'string')
    && (ordinal === null || Number.isInteger(ordinal));
}
function convertAnchor(a) {
  if (a == null) return null;
  if (isConverted(a)) return a;
  const mount = a.mount;
  if (typeof mount !== 'string' || !mount) {
    throw Object.assign(new Error('anchor without a mount'), { reason: 'anchor-without-mount' });
  }
  const selector = a.selector;
  const text = a.text;
  const ordinal = a.ordinal;
  const sel = typeof selector === 'string' ? selector : '';
  const tag = (sel.match(/^[a-z][a-z0-9-]*/i) || ['*'])[0].toLowerCase();
  const classes = sel.split('.').slice(1).filter(Boolean);
  return {
    v: 1, kind: 'element', form: CONVERTED, mount,
    path: { selector: sel },
    fingerprint: { tag, classes, text: typeof text === 'string' ? text : '' },
    ordinal: Number.isInteger(ordinal) ? ordinal : null,
  };
}

// A reply as the payload carries it: {author, at, text}; every other key
// (a reply's writer and provenance among them: they ride the version that
// appended the reply, ruling A2) is dropped, and so is an undefined field.
function replyOf(r) {
  const out = {};
  if (r && r.author !== undefined) out.author = r.author;
  if (r && r.at !== undefined) out.at = r.at;
  if (r && r.text !== undefined) out.text = r.text;
  return out;
}

// The payload a version stores for a node copy, and every hash of it hashes:
// {text, shared, replies, anchor} and nothing else (PLAN 1A.4). The declared
// normalisation: an absent `replies` equals []; an absent `text` reads as '';
// the anchor is converted (convertAnchor). An undefined `shared` is left out
// (as the bytes would leave it).
function payloadOf(copy) {
  const c = copy || {};
  const out = { text: c.text ?? '' };
  if (c.shared !== undefined) out.shared = c.shared;
  out.replies = (Array.isArray(c.replies) ? c.replies : []).map(replyOf);
  out.anchor = convertAnchor(c.anchor ?? null);
  return out;
}

// Does a node copy hold version `rec`'s payload? The raw copy matches
// src_hash, a redacted one payload_hash. No redaction at check time. A copy
// whose anchor cannot be converted matches nothing.
function copyMatches(copy, rec) {
  if (!rec) return false;
  let h;
  try { h = stableHash(payloadOf(copy)); } catch { return false; }
  return h === rec.payload_hash || h === rec.src_hash;
}

// A committed node's digest (notes-A D4): its identity and its pins' id@v.
function nodeDigest(node) {
  const n = node || {};
  return stableHash({
    id: n.id,
    parent_id: n.parent_id,
    created_at: n.created_at,
    pins: (n.comments || []).map((c) => c.id + '@' + (c.v ?? '')).sort(),
  });
}

// ── park rule b2 (DECISIONS C3), ported unchanged from the measured prototype
// (design/annotation-engine-redesign/tests/F5/lib/park.js) ──
//
//   (b)  a copy is kept on its node when its anchor mount is present, or when it is the
//        FIRST ghost of an absent run (its nearest carrying ancestor had the pane, or no
//        ancestor carries the pin);
//   (b2) (b), plus a ghost copy whose payload changed against its nearest carrier (a reply
//        landed while the pane was gone) is kept.
//
// A kept ghost is an ORPHAN on its node (it shows in the tray); a ghost b2 does not keep is
// PARKED: its id@v stays in the node's derived list (node copies stay whole, nothing is
// rewritten) and in the log, but the node does not draw or tray it.
// parkB2 memoises parkHash per copy and reads the nearest carrier once (U248): a cost change, not a rule change.

// The reply identity parkMetrics counts by.
const replyKey = (r) => stableStringify([r.author, r.at, r.text]);
// What "the payload changed" means for parking: text, shared and replies.
const parkHash = (c) => stableHash({ text: c.text ?? '', shared: c.shared, replies: (c.replies || []).map((r) => [r.author, r.text, r.at]) });

// copies: {node, id, anchor_mount_present, text, shared, replies}; topo: {parentOf(id)}
function parkB2(copies, topo) {
  const byPin = new Map();
  for (const c of copies) { if (!byPin.has(c.id)) byPin.set(c.id, new Map()); byPin.get(c.id).set(c.node, c); }
  const nearestCarrier = (id, nid) => { const nm = byPin.get(id); let a = topo.parentOf(nid); while (a && !nm.has(a)) a = topo.parentOf(a); return a ? nm.get(a) : null; };
  // One parkHash per copy object for this parkB2 call (the copies are not mutated while it is read).
  const hashes = new Map();
  const hashOf = (c) => { let h = hashes.get(c); if (h === undefined) { h = parkHash(c); hashes.set(c, h); } return h; };
  // (b) then (b2), with the nearest carrier read once: present, or no carrier, or a carrier
  // whose mount is present → kept; else kept only when the payload changed against it.
  const keepB2 = (c) => { if (c.anchor_mount_present) return true; const p = nearestCarrier(c.id, c.node); if (!p || p.anchor_mount_present) return true; return hashOf(p) !== hashOf(c); };
  const stateOf = (c) => (c.anchor_mount_present ? 'present' : keepB2(c) ? 'orphan' : 'parked');
  return { stateOf, keepB2, nearestCarrier, byPin };
}

// The S-5 metrics for one rule over the copies: orphans per pin-carrying node, homeless pin
// ids (no kept copy anywhere), replies lost (a reply no kept copy carries).
function parkMetrics(copies, nodes, stateOf) {
  const perNode = new Map(nodes.map((n) => [n.id, 0]));
  const homes = new Map(); const byPin = new Map(); let kept = 0; let parked = 0;
  for (const c of copies) {
    if (!byPin.has(c.id)) byPin.set(c.id, []); byPin.get(c.id).push(c);
    const s = stateOf(c);
    if (s === 'parked') { parked++; continue; }
    kept++;
    if (s === 'orphan') perNode.set(c.node, perNode.get(c.node) + 1);
    if (!homes.has(c.id)) homes.set(c.id, []); homes.get(c.id).push(c);
  }
  let homeless = 0; let repliesLost = 0; const homelessIds = [];
  for (const [id, list] of byPin) {
    const all = new Set(); for (const c of list) for (const r of c.replies || []) all.add(replyKey(r));
    const h = homes.get(id) || [];
    if (!h.length) { homeless++; homelessIds.push(id); repliesLost += all.size; continue; }
    const have = new Set(); for (const c of h) for (const r of c.replies || []) have.add(replyKey(r));
    for (const k of all) if (!have.has(k)) repliesLost++;
  }
  const carrying = new Set(copies.map((c) => c.node));
  const s = nodes.filter((n) => carrying.has(n.id)).map((n) => perNode.get(n.id)).sort((a, b) => a - b);
  const median = s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
  return { kept_copies: kept, parked_copies: parked, orphans_total: s.reduce((a, b) => a + b, 0), median_orphans_per_node: median, max_orphans_per_node: s.length ? s[s.length - 1] : null, pin_carrying_nodes: s.length, homeless_pin_ids: homeless, homeless_ids: homelessIds, replies_lost: repliesLost };
}

// Ancestor-or-self over a node set ({id, parent_id}[]) as an INDEX, not a walk:
// an Euler tour (tin/tout per node, one iterative DFS from every root), so the
// question is two integer comparisons — what the migration asks once per copy
// (a parent-chain walk per copy would be O(depth) each). Ported from the
// prototype's ancestryOf. lib/server/domain/lineage `ancestry` stays the
// daemon's one parent-chain walk. A node outside the set, or on a parent
// cycle no root reaches, is nobody's ancestor.
function ancestryIndex(nodes) {
  const ids = new Set();
  for (const n of nodes) if (n && n.id != null) ids.add(n.id);
  const children = new Map([...ids].map((id) => [id, []]));
  const roots = [];
  const seenRoot = new Set();
  for (const n of nodes) {
    if (!n || n.id == null) continue;
    if (n.parent_id != null && n.parent_id !== n.id && ids.has(n.parent_id)) children.get(n.parent_id).push(n.id);
    else if (!seenRoot.has(n.id)) { seenRoot.add(n.id); roots.push(n.id); }
  }
  const tin = new Map(); const tout = new Map(); let clock = 0;
  for (const root of roots) {
    const stack = [[root, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1]; const [id, k] = top;
      if (k === 0) tin.set(id, clock++);
      const kids = children.get(id) || [];
      if (k < kids.length) { top[1] = k + 1; stack.push([kids[k], 0]); } else { tout.set(id, clock++); stack.pop(); }
    }
  }
  const isAncestorOrSelf = (a, n) => { const ta = tin.get(a); const tn = tin.get(n); return ta !== undefined && tn !== undefined && ta <= tn && tout.get(n) <= tout.get(a); };
  return { tin, tout, isAncestorOrSelf };
}

// Copied verbatim from lib/server/graph.js (its comment and its function), so
// the daemon's graph loader and the migration share one predicate; graph.js
// requires this copy once the daemon binds the log.
// The graph-node shape predicate, used by graph.load below as readJson's
// `validate`. It lives here and not in lib/core/fsjson because core holds no
// type-specific knowledge (the boundary lib/core/resources.js draws).
//
// Both fields are load-bearing at load time and nowhere else is either checked:
// `created_at` drives the chronological sort, and `id` is parsed back into an
// integer to seed nextSeq. Every node ever written is `n${nextSeq}` with a
// numeric created_at (domain/turns commitNode), so this rejects nothing real —
// only the shapes a torn or placeholder file produces.
function isGraphNode(n) {
  return !!n && typeof n === 'object' && /^n\d+$/.test(n.id) && Number.isFinite(n.created_at);
}

// ── the log ─────────────────────────────────────────────────────────────────

// THE TOLERANT SCANNER (GT-10, ruling K1): the highest n over every
// `"seq": <n>` and every `"id": "c<n>"` in some bytes, whitespace allowed after
// the colon, safe integers only, 0 when there is none. It never parses: the
// bytes it is for (a torn log tail, a node file or draft that does not read)
// are malformed by definition. Reading ids as well as seqs only ever raises a
// floor, since an element id is 'c' + the seq of its first version. Any `seq`
// counts, a pane store's too (the signal-key convention writes Date.now()), so
// such bytes make ids jump, never collide. The one reader of such bytes: the
// log's torn asides (tornSeqOf), the migration's maxSeqIn and the boot
// reconcile's floor (lib/server/domain/elements-reconcile floorFromAsides).
const ELEMENT_SEQ_RE = /"seq":\s*(\d+)|"id":\s*"c(\d+)"/g;
function maxElementSeqIn(text) {
  if (typeof text !== 'string' || !text) return 0;
  let max = 0;
  for (const m of text.matchAll(ELEMENT_SEQ_RE)) {
    const n = Number(m[1] ?? m[2]);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

// The highest seq or element id in the log's own torn asides (`<file>.torn-*`).
// In a dry run the tail is still in the file (nothing was set aside), so its
// bytes are read from there.
function tornSeqOf(file, { dryRun, tornBytes }) {
  let max = 0;
  const scan = (text) => { const n = maxElementSeqIn(text); if (n > max) max = n; };
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.torn-`;
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try { scan(fs.readFileSync(path.join(dir, name), 'utf8')); } catch {}
  }
  if (dryRun && tornBytes > 0) {
    try {
      const buf = fs.readFileSync(file);
      scan(buf.subarray(Math.max(0, buf.length - tornBytes)).toString('utf8'));
    } catch {}
  }
  return max;
}

function createElementLog({ file, redactor, dryRun = false, bootId, now = Date.now, fsync = false } = {}) {
  if (!redactor || typeof redactor.value !== 'function') {
    throw new TypeError('createElementLog: inject a redactor (lib/core/redact createRedactor())');
  }
  let lastNow = null;
  const clock = () => { lastNow = now(); return lastNow; };
  const log = openLog(file, { dryRun, bootId, now: clock, fsync });

  const elements = new Map();     // id → el record
  const versions = new Map();     // id → Map(v → ver record), first record of an id@v wins
  const latestV = new Map();      // id → max v in the log
  const reservedV = new Map();    // id → max v reserved
  const payloadIdx = new Map();   // id → Map(payload_hash → [v])
  const srcIdx = new Map();       // id → Map(src_hash → [v])
  const seqIdx = new Map();       // id → Map(seq → newest v carrying it)
  const firstSeq = new Map();     // id minted by mintId → the seq its first version takes
  const commitList = [];          // every commit record, in log order
  const commitByNode = new Map(); // node → its last commit record
  const home = new Map();         // 'id@v' → the node of the first commit pinning it
  const epochList = [];           // {boot, at, pid, index}
  const verIndex = new Map();     // 'id@v' → the record index of its (first) version record
  const closeList = [];           // {index, boot, at, held: Set('id@v'), complete}, in log order
  const ackedKeys = new Set();    // every '<state> <key>' an ack names
  let ackCount = 0;
  let migrationRec = null;
  let seqFloor = 0;
  let maxSeqSeen = 0;
  let reservedSeq = 0;
  let tornSeq = 0;
  let nextIndex = 0;
  const counts = { dupes: 0, skipped: 0, unknown: 0 };

  const push = (map, id, key, v) => {
    let m = map.get(id);
    if (!m) { m = new Map(); map.set(id, m); }
    const list = m.get(key);
    if (list) { if (!list.includes(v)) list.push(v); } else m.set(key, [v]);
  };

  // Index one record. Never redacts, never throws.
  function index(rec, i) {
    switch (rec.t) {
      case 'epoch':
        epochList.push({ boot: rec.boot, at: rec.at, pid: rec.pid, index: i });
        return;
      case 'el':
        if (typeof rec.id !== 'string' || !rec.id) { counts.skipped++; return; }
        if (elements.has(rec.id)) { counts.dupes++; return; }
        elements.set(rec.id, rec);
        return;
      case 'ver': {
        // Every version record's seq is spent, an unusable one's too.
        if (isPosInt(rec.seq) && rec.seq > maxSeqSeen) maxSeqSeen = rec.seq;
        if (typeof rec.id !== 'string' || !rec.id || !isPosInt(rec.v) || !isPosInt(rec.seq)) { counts.skipped++; return; }
        let m = versions.get(rec.id);
        if (!m) { m = new Map(); versions.set(rec.id, m); }
        if (m.has(rec.v)) { counts.dupes++; return; }
        m.set(rec.v, rec);
        verIndex.set(pinKey(rec.id, rec.v), i);
        if (!(latestV.get(rec.id) >= rec.v)) latestV.set(rec.id, rec.v);
        if (typeof rec.payload_hash === 'string') push(payloadIdx, rec.id, rec.payload_hash, rec.v);
        if (typeof rec.src_hash === 'string') push(srcIdx, rec.id, rec.src_hash, rec.v);
        let s = seqIdx.get(rec.id);
        if (!s) { s = new Map(); seqIdx.set(rec.id, s); }
        if (!(s.get(rec.seq) >= rec.v)) s.set(rec.seq, rec.v);
        return;
      }
      case 'commit':
        if (typeof rec.node !== 'string' || !rec.node || !Array.isArray(rec.pins)) { counts.skipped++; return; }
        commitList.push(rec);
        commitByNode.set(rec.node, rec);
        for (const p of rec.pins) {
          if (typeof p !== 'string') continue;
          const at = p.lastIndexOf('@');
          if (at <= 0 || !isPosInt(Number(p.slice(at + 1)))) continue;
          if (!home.has(p)) home.set(p, rec.node);
        }
        return;
      case 'migration':
        migrationRec = rec;
        if (Number.isSafeInteger(rec.seq_floor) && rec.seq_floor > seqFloor) seqFloor = rec.seq_floor;
        return;
      case 'close':
        if (!Array.isArray(rec.held) || !rec.held.every(isPinKey) || typeof rec.complete !== 'boolean') { counts.skipped++; return; }
        closeList.push({ index: i, boot: rec.boot ?? null, at: rec.at ?? null, held: new Set(rec.held), complete: rec.complete });
        return;
      case 'ack':
        if (!Array.isArray(rec.keys) || !rec.keys.every(isAckKey)) { counts.skipped++; return; }
        for (const k of rec.keys) ackedKeys.add(k);
        ackCount++;
        return;
      default:
        counts.unknown++;
    }
  }

  function load() {
    const st = log.load({ onRecord: (rec, { index: i }) => index(rec, i) });
    nextIndex = st.complete;
    tornSeq = tornSeqOf(file, { dryRun, tornBytes: st.torn ? st.torn.bytes : 0 });
    return stats();
  }

  // Append one record (already as its bytes carry it) and index it. The
  // engine's lazy epoch, when this append wrote it, is indexed first.
  function write(rec) {
    const before = log.stats().epoch_written;
    try {
      log.append(rec);
    } finally {
      if (!before && log.stats().epoch_written) {
        epochList.push({ boot: log.bootId, at: lastNow, pid: process.pid, index: nextIndex++ });
      }
    }
    index(rec, nextIndex++);
    return rec;
  }

  // ── minting ──
  const maxSeq = () => Math.max(maxSeqSeen, reservedSeq, seqFloor, tornSeq);
  const nextSeq = () => maxSeq() + 1;
  function reserveSeq(n) {
    if (!isPosInt(n)) throw new TypeError('reserveSeq: a positive integer');
    if (n > reservedSeq) reservedSeq = n;
    return nextSeq();
  }
  const nextV = (id) => Math.max(latestV.get(id) || 0, reservedV.get(id) || 0) + 1;
  function reserve(id, v) {
    if (typeof id !== 'string' || !id || !isPosInt(v)) throw new TypeError('reserve: an id and a positive integer v');
    if (!(reservedV.get(id) >= v)) reservedV.set(id, v);
    return nextV(id);
  }
  // A fresh element id, 'c' + a seq reserved for its first version.
  function mintId() {
    let seq = nextSeq();
    while (elements.has(`c${seq}`) || versions.has(`c${seq}`) || firstSeq.has(`c${seq}`)) { reserveSeq(seq); seq = nextSeq(); }
    reserveSeq(seq);
    firstSeq.set(`c${seq}`, seq);
    return `c${seq}`;
  }

  function ensureElement({ id, kind = 'comment', created_at = null } = {}) {
    if (typeof id !== 'string' || !id) throw new TypeError('ensureElement: an id');
    if (elements.has(id)) return { ...elements.get(id) };
    return { ...write(jsonClean({ t: 'el', id, kind, created_at })) };
  }

  // THE ONE WRITER OF ELEMENT TEXT. The payload ({text, shared, replies,
  // anchor}: payloadOf) and every sibling field pass the redactor before the
  // bytes land; v is minted here, seq is the caller's (a migrated copy keeps
  // its own) or minted. Returns the stored (redacted) record.
  function appendVersion({
    id, payload, parent_v = null, seq, author = null, at, schema = SCHEMA,
    original = null, writer = null, provenance = null, owner = null,
  } = {}) {
    if (typeof id !== 'string' || !id) throw new TypeError('appendVersion: an id');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('appendVersion: a payload object');
    const stray = Object.keys(payload).filter((k) => !PAYLOAD_KEYS.has(k));
    if (stray.length) throw new TypeError(`appendVersion: a payload holds only text, shared, replies and anchor (payloadOf), not ${stray.join(', ')}`);
    const v = nextV(id);
    if (parent_v !== null && !(isPosInt(parent_v) && parent_v < v)) throw new TypeError('appendVersion: parent_v is null or an earlier v');
    let s = seq;
    if (s === undefined || s === null) s = !versions.has(id) && firstSeq.has(id) ? firstSeq.get(id) : nextSeq();
    if (!isPosInt(s)) throw new TypeError('appendVersion: seq is a positive integer');
    const raw = jsonClean(payload);
    const redacted = jsonClean(redactor.value(raw));
    const sib = {};
    for (const k of SIBLINGS) {
      const val = { original, writer, provenance, owner }[k];
      sib[k] = val == null ? null : jsonClean(redactor.value(jsonClean(val)));
    }
    const rec = {
      t: 'ver', id, v, parent_v, seq: s, schema,
      payload: redacted,
      payload_hash: stableHash(redacted),
      src_hash: stableHash(raw),
      ...sib,
      author: author == null ? null : jsonClean(redactor.value(author)),
      at: at ?? now(),
    };
    write(rec);
    firstSeq.delete(id);
    return jsonClean(rec);
  }

  // A committed node and the id@v of every pin it carries (node first, log after).
  function appendCommit({ node, pins } = {}) {
    if (!node || typeof node.id !== 'string' || !node.id) throw new TypeError('appendCommit: a node with an id');
    if (!Array.isArray(pins) || pins.some((p) => typeof p !== 'string')) throw new TypeError('appendCommit: pins are id@v strings');
    const rec = jsonClean({
      t: 'commit', node: node.id, parent: node.parent_id ?? null, created_at: node.created_at ?? null,
      pins: pins.slice(), digest: nodeDigest(node), at: now(),
    });
    write(rec);
    return { ...rec, pins: rec.pins.slice() };
  }

  // A graceful shutdown's mark (U352): the id@v of every live copy it held, and
  // whether it covers them all. Ids only: anything that is not an id@v string
  // is refused with a TypeError, so no text can ride it.
  function appendClose({ held, complete } = {}) {
    if (!Array.isArray(held) || !held.every(isPinKey)) throw new TypeError('appendClose: held is a list of id@v strings');
    if (typeof complete !== 'boolean') throw new TypeError('appendClose: complete is a boolean');
    const rec = jsonClean({ t: 'close', boot: log.bootId, at: now(), held: [...new Set(held)], complete });
    write(rec);
    return { ...rec, held: rec.held.slice() };
  }

  // The boot reconcile's acknowledgement (U352): '<state> <key>' strings only,
  // anything else refused with a TypeError.
  function appendAck({ keys } = {}) {
    if (!Array.isArray(keys) || !keys.length || !keys.every(isAckKey)) throw new TypeError("appendAck: keys is a non-empty list of '<state> <key>' strings");
    const rec = jsonClean({ t: 'ack', boot: log.bootId, at: now(), keys: [...new Set(keys)] });
    write(rec);
    return { ...rec, keys: rec.keys.slice() };
  }

  // The v3→v4 migration's mark: its seq_floor keeps every seq a copy held
  // below the next one minted.
  function appendMigration({ from = 3, to = 4, seq_floor = 0, ...counts_ } = {}) {
    if (!Number.isSafeInteger(seq_floor) || seq_floor < 0) throw new TypeError('appendMigration: seq_floor is a non-negative integer');
    const rec = jsonClean({ ...counts_, t: 'migration', from, to, at: now(), seq_floor });
    write(rec);
    return { ...rec };
  }

  // ── reading ──
  const rv = (x) => (x == null ? x : redactor.value(x));
  // The record with its text (payload, sibling fields, author) through the
  // redactor NOW: a value learned after the write is masked; the bytes are not
  // rewritten.
  const rawOf = new WeakMap(); // view → raw record
  function maskView(rec) {
    if (!rec || typeof rec !== 'object') return null;
    const r = rawOf.get(rec) || rec;
    if (r.t !== 'ver') return jsonClean(r);
    const out = { ...r, payload: rv(r.payload), author: rv(r.author) };
    for (const k of SIBLINGS) out[k] = rv(r[k]);
    return out;
  }
  // A lazy masking view of a stored version: its plain fields as stored, its
  // text through the redactor at each read (so a caller after v, seq or a hash
  // pays nothing for the text). One view per record, kept.
  const views = new WeakMap();
  function view(r) {
    if (!r) return null;
    let o = views.get(r);
    if (!o) {
      o = {};
      for (const k of Object.keys(r)) {
        if (k === 'payload' || k === 'author' || SIBLINGS.includes(k)) {
          Object.defineProperty(o, k, { get: () => rv(r[k]), enumerable: true });
        } else {
          o[k] = r[k];
        }
      }
      Object.freeze(o);
      views.set(r, o);
      rawOf.set(o, r);
    }
    return o;
  }
  const stored = (id, v) => (versions.get(id) || new Map()).get(v) || null;
  const version = (id, v) => view(stored(id, v));
  const versionsOf = (id) => [...(versions.get(id) || new Map()).values()].sort((a, b) => a.v - b.v).map(view);
  const latest = (id) => (latestV.has(id) ? view(stored(id, latestV.get(id))) : null);
  function byHash(id, h) {
    const out = new Set([...(((payloadIdx.get(id) || new Map()).get(h)) || []), ...(((srcIdx.get(id) || new Map()).get(h)) || [])]);
    return [...out].sort((a, b) => a - b);
  }
  // The newest v of `id` carrying `seq` (a migrated element's copies may share
  // one seq; a reader still checks the hash before trusting it), or null.
  const bySeq = (id, seq) => ((seqIdx.get(id) || new Map()).get(seq) ?? null);
  const homeOf = (id, v) => home.get(pinKey(id, v)) ?? null;
  const copyCommit = (c) => (c ? { ...c, pins: c.pins.slice() } : null);
  const commitOf = (nodeId) => copyCommit(commitByNode.get(nodeId));
  const pinsOf = (nodeId) => (commitByNode.has(nodeId) ? commitByNode.get(nodeId).pins.slice() : null);
  const commits = () => commitList.map(copyCommit);
  const epochs = () => epochList.map((e) => ({ ...e }));
  const migration = () => (migrationRec ? jsonClean(migrationRec) : null);
  const element = (id) => (elements.has(id) ? { ...elements.get(id) } : null);
  const ids = () => [...new Set([...elements.keys(), ...versions.keys()])];
  // The record index of id@v's version record (log order across reopens), or null.
  const indexOf = (id, v) => verIndex.get(pinKey(id, v)) ?? null;
  // Every close, in log order: {index, boot, at, held: a Set of id@v (a copy), complete}.
  const closes = () => closeList.map((c) => ({ ...c, held: new Set(c.held) }));
  // Every '<state> <key>' an ack names (a copy).
  const acked = () => new Set(ackedKeys);

  function stats() {
    let nVersions = 0;
    for (const m of versions.values()) nVersions += m.size;
    return {
      ...log.stats(),
      elements: elements.size,
      versions: nVersions,
      commits: commitList.length,
      epochs: epochList.length,
      migration: !!migrationRec,
      closes: closeList.length,
      acks: ackCount,
      max_seq: maxSeq(),
      next_seq: nextSeq(),
      torn_seq: tornSeq,
      dupes: counts.dupes,
      skipped: counts.skipped,
      unknown: counts.unknown,
    };
  }

  return {
    file, dryRun, bootId: log.bootId,
    load, close: () => log.close(), stats,
    ensureElement, appendVersion, appendCommit, appendClose, appendAck, appendMigration,
    nextSeq, reserveSeq, nextV, reserve, mintId,
    version, versionsOf, latest, byHash, bySeq, homeOf, commitOf, pinsOf, commits, epochs, migration,
    maxSeq, element, ids, maskView, indexOf, closes, acked,
  };
}

module.exports = {
  createElementLog,
  SCHEMA,
  CONVERTED,
  SIBLINGS,
  convertAnchor,
  payloadOf,
  copyMatches,
  nodeDigest,
  parkB2,
  parkMetrics,
  parkHash,
  replyKey,
  ancestryIndex,
  isGraphNode,
  maxElementSeqIn,
  isPinKey,
  isAckKey,
};
