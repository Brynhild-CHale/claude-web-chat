// The connector's ring reader (contract 07 C-07.7 to C-07.15; 05 C-05.24,
// C-05.48; 11 C-11.18): one chat daemon's main ring, as ordered events.batch
// frames from the hub's cursor.
//
//   * THE HOLD IS THE READ (C-07.8). This module opens no stream. install(ctx)
//     subscribes to the lifecycle's fan-out (lib/connector/lifecycle.js, the
//     one GET /api/events/stream per running chat) and sets its cursor
//     provider, so the hold opens with the `since` C-07.10's table picks. The
//     other reads — the poll fallback, the re-base, the capture and element
//     reconciliation — are one-shot host reads through lib/client with an
//     explicit port and noSpawn. Only the main ring crosses (C-07.7): the hook
//     tap and the mirror bus are never read here.
//   * THE BOOT (C-07.9, C-07.15). The X-WC-Boot header of the read's response
//     when the daemon sends it; else GET /api/health (through the lifecycle's
//     healthOf, fresh) issued as the hold opens, and again after the stream's
//     first entry (or after each poll). A read whose boot is not the one its
//     `since` was chosen against is discarded and re-based: a one-shot
//     GET /api/events?since=0 reads the new boot's ring, and the stream's later
//     entries continue past that read's `latest`. A boot is compared for
//     equality only, never parsed.
//   * THE CURSOR (C-07.10). The hub holds it: setCursor takes the 07-cursor the
//     hub sent (chat.assign), events.ack replaces it. No cursor: since 0, and a
//     ring whose oldest entry is above 1 makes the first batch not contiguous
//     with no gap object (the hub records `unknown`). The same boot: resume
//     from the cursor's seq. Another boot, or a read answering `reset`: since 0,
//     and the new boot's first batch carries {gap, dropped: 0, oldest, reset}
//     (the hub records `restart`). An eviction (`gap`, dropped > 0): `since` is
//     unchanged, what came is ingested and the batch carries the gap with its
//     count (`evicted`). A gap is reported, never filled. The same rows hold
//     whichever of the read and the connector's first cursor comes first
//     (`connect run` resumes a chat's read before its link starts): a read
//     asked for, opened or settled from 0 before the first cursor is met by
//     it (meetFirstCursor) as if it had opened from the cursor; a read asked
//     after it is asked from it (adoptCursor).
//   * BATCHES (C-07.11). Entries in ascending ring position, each reduced by
//     projectAudit BEFORE it is kept (C-11.18; the hub repeats it) against the
//     chat's root — a read held, unprojected, until the root is known (track,
//     or a lifecycle 'open' naming the chat), so a label never leaves unmasked
//     — at most
//     BATCH_MAX_ENTRIES and BATCH_MAX_BYTES a batch, one batch per link slot
//     (link.batchSlot: 4 unacknowledged per chat, C-05.24). `contiguous` only
//     when the batch's first ring position is the position the hub will hold +
//     1 in the same boot. THE CAPTURE RULE: a capture entry with capture_seq
//     (U750) has its ring position as seq; one without it (an older daemon)
//     carries the counter as seq and moves no position (an undercount only
//     makes the next batch read as not contiguous, never a loss).
//   * THE UNACKNOWLEDGED BUFFER. What is read and not yet acknowledged —
//     pending and sent — is kept in memory only, at most UNACKED_MAX_ENTRIES
//     entries or UNACKED_MAX_BYTES per chat; past it the oldest pending entries
//     are dropped and a re-read is owed: the entry kept past the hole is held,
//     and after each events.ack one host poll GET /api/events?since=<the hub's
//     cursor> refills the hole in ring order, as far as the room goes, until
//     it reaches what the stream holds (never a second stream). A re-read
//     that cannot be made is abandoned and the held entry goes not contiguous
//     (the hub records the gap).
//   * THE RESUME (C-07.11: the connector "resends them after a reconnect from
//     the cursor the hub hands back"; 05 C-05.20). At every link 'ready' (the
//     hello.ack) every sent, unacknowledged batch goes back to the resend
//     queue and the chat is HELD: nothing of it — no resend, no new batch, no
//     owed re-read — is sent until its cursor arrives on that link
//     (setCursor, from the chat.assign C-05.20 has the hub send per chat
//     placed there). Then the batches and pending entries the cursor covers
//     are dropped, the rest go first, in order, and the pump resumes. A link
//     that drops again before the cursor keeps the hold for the next one; no
//     timer ever releases it (a timer could send below a cursor), and a chat
//     the hub no longer assigns is released only by forget().
//   * RECONCILE (C-07.12, C-07.13). After any read with since > 0 and after any
//     batch sent not contiguous: GET /api/captures?since=<capture_seq> and
//     GET /api/elements?since=<element_seq>, each record reduced by
//     projectAudit's capture or element row. Captures ride the next batch's
//     `reconciled` (07-source-batch's closed item: kind, capture_id, seq, ts,
//     source) — once per link: a record an unacknowledged batch carries, one
//     at or below the capture `since` its read asked at, or one a batch that
//     left acknowledged while that read was out carried, is not queued again
//     (queueReconciled, U723e). 07-source-batch.json (v1.4) has no field for an element record,
//     so projected element records go to the `onElementRecords` seam and never
//     onto the wire here (a wc note; the hand-off names it).
//   * REINIT (C-07.12a). On every boot change, before the new boot's first
//     batch, both routes are read once: a capture next_cursor, or a capture
//     entry's counter in that first batch, below the cursor's capture_seq sets
//     `reinit: true`; an element next_cursor below element_seq alone sets
//     `element_reset: true`.
//   * THE POLL FALLBACK (C-07.8, C-07.11). When the stream fails three opens
//     running while health answers: GET /api/events?since every POLL_VIEWER_MS
//     with a viewer, POLL_IDLE_MS without, taking `latest` as the read
//     position, until the stream opens again. The poll never holds.
//
// Nothing here reads a project's .web-chat/ (C-11.4), persists the buffer, or
// sends `kinds`, `wake`, `hold=0` or Last-Event-ID. Log lines carry a chat id
// (when safe), a code or a count; never an entry, a boot token or a path.

const crypto = require('crypto');
const client = require('../client');
const registry = require('../util/registry');
const { projectAudit } = require('../core/remote-policy');
const { homeDir, realpath, isSafeId } = require('../core/paths');
const { BOOT_HEADER } = require('../core/cors');

const BATCH_MAX_ENTRIES = 250;            // 07-source-batch: entries maxItems 500
const BATCH_MAX_BYTES = 256 * 1024;       // well under C-05.10's 1 MiB frame
const RECONCILED_MAX = 50;                // 07-source-batch: reconciled maxItems 50
const UNACKED_MAX_ENTRIES = 2000;         // C-07.11
const UNACKED_MAX_BYTES = 4 * 1024 * 1024; // C-07.11
const FAILED_OPENS_TO_POLL = 3;           // C-07.8's fallback
const POLL_VIEWER_MS = 2_000;
const POLL_IDLE_MS = 10_000;
const REBASE_RETRY_MS = 2_000;
const READ_TIMEOUT_MS = 5_000;

const BOOT_KEY = BOOT_HEADER.toLowerCase();
const CHAT_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;
const CAPTURE_ID_RE = /^cap[0-9]{1,16}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const isSeq = (n) => Number.isInteger(n) && n >= 0;
const isPort = (p) => Number.isInteger(p) && p > 0 && p <= 65535;
const isBoot = (b) => typeof b === 'string' && b.length >= 1 && b.length <= 128;
const logId = (id) => (isSafeId(id) ? id : '?');
const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v));

// The boot a response names: its X-WC-Boot header, else null.
function headerBoot(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const v = headers[BOOT_KEY];
  return isBoot(v) ? v : null;
}

// A 07 source cursor as the hub sent it, or null.
function normCursor(c) {
  if (!c || typeof c !== 'object' || c.type !== 'source') return null;
  if (!(c.boot === null || isBoot(c.boot)) || !isSeq(c.seq)) return null;
  return {
    type: 'source',
    chat_id: c.chat_id,
    ring: 'main',
    boot: c.boot,
    seq: c.seq,
    capture_seq: isSeq(c.capture_seq) ? c.capture_seq : 0,
    element_seq: isSeq(c.element_seq) ? c.element_seq : 0,
    ...(Number.isInteger(c.surface_gen) && c.surface_gen >= 1 ? { surface_gen: c.surface_gen } : {}),
  };
}

// b_ and a ULID (48 bits of time over 80 random bits), upper-case Crockford.
function mintBatchId(now, randomBytes) {
  const rnd = randomBytes(10);
  let v = BigInt(Math.max(0, Math.floor(now())));
  for (const byte of rnd) v = (v << 8n) | BigInt(byte);
  let out = '';
  for (let i = 25; i >= 0; i--) out += CROCKFORD[Number((v >> BigInt(5 * i)) & 31n)];
  return `b_${out}`;
}

// A projected entry the batch schema takes: integer seq and ts, a kind of 1–64.
function batchable(p) {
  return isSeq(p.seq) && isSeq(p.ts) && typeof p.kind === 'string' && p.kind.length >= 1 && p.kind.length <= 64;
}

// A projected capture record as 07-source-batch's closed `reconciled` item.
function reconciledItem(p) {
  if (!CAPTURE_ID_RE.test(p.capture_id || '') || !Number.isInteger(p.seq) || p.seq < 1 || !isSeq(p.ts)) return null;
  const out = { kind: 'capture', capture_id: p.capture_id, seq: p.seq, ts: p.ts };
  if (typeof p.source === 'string' && p.source.length <= 64) out.source = p.source;
  return out;
}

function createRing({ lifecycle = null, link = null, log = () => {}, onElementRecords = null, deps = {} } = {}) {
  const d = {
    client,
    registry,
    projectAudit,
    now: Date.now,
    randomBytes: crypto.randomBytes,
    home: undefined,
    portOf: null,
    setTimeout,
    clearTimeout,
    setImmediate,
    ...deps,
  };
  const home = d.home !== undefined ? d.home : homeDir();
  const say = (line) => { try { log(line); } catch {} };
  const unref = (t) => { try { if (t && typeof t.unref === 'function') t.unref(); } catch {} return t; };

  let lc = lifecycle;
  let ln = link;
  const chats = new Map();
  // The link's generation: one more at every 'ready'. 0 until the ring sees
  // one (a ring installed on a link already up holds nothing).
  let linkGen = 0;

  // THE RESUME's hold: the chat's cursor has not arrived on this link yet.
  const held = (st) => linkGen > 0 && st.cursorLink !== linkGen;

  function stateOf(chatId) {
    let st = chats.get(chatId);
    if (!st) {
      st = {
        id: chatId,
        root: null,          // the folder's real path, else the root
        port: null,          // the daemon's port, when the lifecycle names it
        cursor: null,        // the hub's 07 source cursor
        cursorLink: 0,       // the link generation the cursor last arrived on
        boot: null,          // the boot of the ring being read
        pos: null,           // the highest ring position read in that boot
        sentBoot: null,      // the boot and position the hub will hold
        sentPos: 0,          //   once every sent batch commits
        pending: [],         // read, projected, not yet sent
        inflight: [],        // sent, not acknowledged: {batch, n, bytes}
        resend: [],          // inflight batches to send again after a reconnect
        reconciled: [],      // capture records for the next batch
        healthBefore: null,  // the health read issued as the hold opened
        headerSeen: false,   // the last read's response named its boot
        read: null,          // the current stream read
        asked: false,        // the provider answered and that read has not opened or closed
        readGen: 0,
        markNext: {},        // flags for the next ingested item: restart, broken, gap
        bootCheck: null,     // {boot, done, reinit, element_reset} at a boot change
        leftDuring: new Set(), // per record read in flight: capture_ids of the batches that left acknowledged meanwhile
        firstSent: new Set(), // boots whose first batch went out
        failedOpens: 0,
        openedSinceClose: false,
        poll: null,          // {timer, first}
        reconciling: false,
        flushing: false,
        reconcileAgain: false,
        dropped: 0,
        reread: null,        // {boot, after, upTo, marks, legacy, running}: a hole owed
        resumed: null,       // {boot, seq, first}: THE FIRST CURSOR met a read from below it
      };
      chats.set(chatId, st);
    }
    return st;
  }

  // ── reads the ring makes itself (host reads, explicit port, noSpawn) ──────

  async function portOf(st) {
    if (isPort(st.port)) return st.port;
    if (typeof d.portOf === 'function') {
      try { const p = await d.portOf(st.id); if (isPort(p)) return p; } catch {}
    }
    if (!st.root) return null;
    try {
      const rec = await d.registry.daemonFor(st.root);
      if (!rec || !isPort(rec.port)) return null;
      const ok = await d.registry.answersFor(rec, d.registry.instanceId(st.root), { strictInstance: true });
      return ok ? rec.port : null;
    } catch {
      return null;
    }
  }

  async function hostGet(st, pathStr, { withHeaders = false } = {}) {
    const port = await portOf(st);
    if (!port) return null;
    try {
      return await d.client.get(pathStr, { port, noSpawn: true, timeout: READ_TIMEOUT_MS, ...(withHeaders ? { withHeaders: true } : {}) });
    } catch (e) {
      say(`ring chat ${logId(st.id)} read failed: ${(e && (e.code || e.status)) || 'error'}`);
      return null;
    }
  }

  async function healthBoot(st) {
    if (!lc || typeof lc.healthOf !== 'function') return null;
    let h = null;
    try { h = await lc.healthOf(st.id, { fresh: true }); } catch { h = null; }
    return h && isBoot(h.boot) ? h.boot : null;
  }

  // ── ingest ─────────────────────────────────────────────────────────────────

  // C-11.18 masks a label against the chat's root, so nothing is projected
  // before the root is known (track, or a lifecycle 'open' naming the chat):
  // the read waits for it (onOpen), and this is the backstop — an empty
  // projection is never batchable, so an entry without a root never leaves.
  function project(st, entry, record) {
    if (!st.root) return {};
    return d.projectAudit(entry, { ...(record ? { record } : {}), root: st.root, home });
  }

  function takeMarks(st) {
    const m = st.markNext;
    st.markNext = {};
    return m;
  }

  // A boot change (or a reset): positions start again; the next item read
  // opens the new boot's first batch with the restart gap. With `from`, the
  // change is not the read's but the first cursor's (meetFirstCursor): the
  // read of `boot` settled before the cursor of boot `from` arrived, so the
  // boot and the read position stay, and the mark lands on the first pending
  // item of `boot`, else on the next item to arrive.
  function restartAt(st, boot, { check, from }) {
    // A re-read of the old positions is impossible now.
    abandonReread(st, 'restart');
    st.resumed = null;
    const old = from !== undefined ? from : st.boot;
    const first = from !== undefined ? st.pending.find((it) => it.boot === boot) : null;
    if (first) {
      first.restart = true;
      delete first.gap;
    } else {
      if (from === undefined) {
        st.boot = boot;
        st.pos = 0;
      }
      st.markNext = { ...st.markNext, restart: true };
      delete st.markNext.gap;
    }
    if (check && old != null && old !== boot && st.cursor) startBootCheck(st, boot);
  }

  // An item that opens the run after the first cursor (meetFirstCursor) above
  // cursor + 1, with nothing else said of it: the daemon's ring no longer
  // reaches back to the cursor, so it carries the evicted gap a read from the
  // cursor would have answered (bus.read: dropped = oldest - 1 - since). An
  // item with no ring position (an older daemon's capture), or one already
  // marked, is left to formBatch (not contiguous, no gap object: unknown).
  function markEvictedSince(it, seq) {
    if (it.pos == null || it.pos <= seq + 1 || it.restart || it.gap || it.broken || it.hole) return;
    it.gap = { gap: true, dropped: it.pos - seq - 1, oldest: it.pos };
  }

  function ingestEntry(st, boot, entry, since) {
    if (!entry || typeof entry !== 'object') return;
    // After the first cursor met a read from below it, what the hub holds of
    // that boot is not kept, and what follows names the cursor as its since.
    const rs = st.resumed && st.resumed.boot === boot ? st.resumed : null;
    if (rs && isSeq(entry.seq) && entry.seq <= rs.seq && !(entry.kind === 'capture' && !isSeq(entry.capture_seq))) return;
    if (rs) since = Math.max(since, rs.seq);
    const p = project(st, entry);
    if (!batchable(p)) {
      st.markNext = { ...st.markNext, broken: true };
      say(`ring chat ${logId(st.id)} entry dropped: not batchable`);
      return;
    }
    const legacyCapture = entry.kind === 'capture' && !isSeq(entry.capture_seq);
    const item = {
      e: p,
      boot,
      since,
      pos: legacyCapture ? null : p.seq,
      captureSeq: entry.kind === 'capture' ? (isSeq(entry.capture_seq) ? entry.capture_seq : p.seq) : null,
      bytes: bytesOf(p),
      ...takeMarks(st),
    };
    if (rs && rs.first) {
      rs.first = false;
      markEvictedSince(item, rs.seq);
    }
    if (item.pos != null && boot === st.boot) st.pos = Math.max(isSeq(st.pos) ? st.pos : 0, item.pos);
    st.pending.push(item);
    schedulePump(st);
  }

  // Entries arrive one by one (an SSE chunk delivers many in one go): the
  // flush runs once after the burst, sends what the link's window takes, and
  // only then holds the rest to the unacknowledged cap.
  function schedulePump(st) {
    if (st.flushing) return;
    st.flushing = true;
    d.setImmediate(() => {
      st.flushing = false;
      pump(st);
      enforceCap(st);
    });
  }

  // THE CAP AND THE RE-READ (C-07.11: "if it loses them, it re-reads the ring
  // from the hub's cursor"). Past the cap the oldest pending entry is dropped
  // and a re-read is owed for the hole: {boot, after, upTo} — the ring
  // positions after `after` through `upTo` were read and let go. The first
  // entry kept past the hole is marked `hole` and held (formBatch sends
  // nothing from it on) until the re-read has filled the hole in order. While
  // the re-read is owed, what yields to the cap is the oldest entry the stream
  // delivered past the hole (the re-read reaches it too), so the hole widens
  // and the refill keeps the room. A re-read that cannot be made (another
  // boot, a ring that is not the one read, a read that fails) is abandoned:
  // the held entry goes not contiguous (an `unknown` gap at the hub) — the
  // brief's fallback. Nothing is invented: what the ring evicted meanwhile is
  // reported as an evicted gap (C-07.10).
  function holeIndex(st) {
    const i = st.pending.findIndex((it) => it.hole);
    return i < 0 ? st.pending.length : i;
  }

  function addGap(marks, dropped, oldest) {
    const prior = marks.gap && isSeq(marks.gap.dropped) ? marks.gap.dropped : 0;
    marks.gap = { gap: true, dropped: prior + dropped, oldest };
  }

  // The item after a dropped one (or, with none read yet, the next ingested).
  function markAfterDrop(st, at, marks) {
    const next = st.pending[at];
    if (next) Object.assign(next, marks);
    else st.markNext = { ...st.markNext, ...marks };
  }

  function enforceCap(st) {
    let n = st.pending.length;
    let bytes = 0;
    for (const it of st.pending) bytes += it.bytes;
    for (const b of st.inflight) { n += b.n; bytes += b.bytes; }
    for (const b of st.resend) { n += b.n; bytes += b.bytes; }
    let dropped = 0;
    while (n > UNACKED_MAX_ENTRIES || bytes > UNACKED_MAX_BYTES) {
      const at = st.reread ? holeIndex(st) : 0;
      if (at >= st.pending.length) break;
      const [it] = st.pending.splice(at, 1);
      n--;
      bytes -= it.bytes;
      dropped++;
      const o = st.reread;
      if (o && it.boot === o.boot) {
        // The hole widens; the re-read recomputes any gap or break inside it.
        if (it.pos != null) o.upTo = Math.max(o.upTo, it.pos); else o.legacy = true;
        markAfterDrop(st, at, { hole: true });
      } else if (!o && it.boot === st.boot && it.pos != null) {
        // A new hole: what the dropped item opened rides the re-read's first.
        st.reread = {
          boot: it.boot, after: it.pos - 1, upTo: it.pos, legacy: false, running: false,
          marks: { ...(it.restart ? { restart: true } : {}), ...(it.gap ? { gap: it.gap } : {}), ...(it.broken ? { broken: true } : {}) },
        };
        markAfterDrop(st, at, { hole: true });
      } else {
        // No re-read can cover it (another boot, a capture with no ring
        // position): what it opened moves to the next one, which cannot claim
        // to continue.
        const next = st.pending[at];
        if (next) {
          if (it.restart) next.restart = true;
          if (it.gap && !next.gap && !next.restart) next.gap = it.gap;
          next.broken = true;
        } else {
          st.markNext = { ...st.markNext, broken: true, ...(it.restart ? { restart: true } : {}) };
        }
      }
    }
    if (dropped) {
      st.dropped += dropped;
      say(`ring chat ${logId(st.id)} unacknowledged buffer full: ${dropped} dropped, re-read owed`);
    }
  }

  // Room the refill may take: the cap less what is sent and what was refilled
  // already (the entries held past the hole yield to it, enforceCap).
  function refillRoom(st) {
    let n = UNACKED_MAX_ENTRIES;
    let bytes = UNACKED_MAX_BYTES;
    for (const b of st.inflight.concat(st.resend)) { n -= b.n; bytes -= b.bytes; }
    const h = holeIndex(st);
    for (let i = 0; i < h; i++) { n--; bytes -= st.pending[i].bytes; }
    return { n, bytes };
  }

  // After an ack (or a reconnect): one host poll from the hub's cursor, never
  // a second stream.
  function maybeReread(st) {
    const o = st.reread;
    if (!o || o.running || chats.get(st.id) !== st || !st.root || held(st)) return;
    const room = refillRoom(st);
    if (room.n < 1 || room.bytes < 1) return;
    o.running = true;
    let progressed = false;
    (async () => {
      const c = st.cursor;
      const since = c && c.boot === o.boot ? c.seq : 0;
      const before = st.headerSeen ? null : await healthBoot(st);
      if (st.reread !== o) return;
      const res = await hostGet(st, `/api/events?since=${since}`, { withHeaders: true });
      if (st.reread !== o) return;
      let b = res ? headerBoot(res.headers) : null;
      if (res && !b) {
        const after = await healthBoot(st);
        if (st.reread !== o) return;
        b = after && (!before || after === before) ? after : null;
      }
      const body = res && res.body;
      if (!body || !Array.isArray(body.events) || b !== o.boot || body.reset === true) {
        abandonReread(st, res ? 'boot' : 'read');
        return;
      }
      progressed = refill(st, o, body, since);
    })().catch(() => {}).finally(() => {
      o.running = false;
      pump(st);
      if (progressed && st.reread === o && !st.inflight.length && !st.resend.length) maybeReread(st);
    });
  }

  // One re-read's answer: the hole's entries in ring order, as far as the room
  // goes, inserted before the held entry. Returns whether it moved.
  function refill(st, o, body, since) {
    const latest = isSeq(body.latest) ? body.latest : 0;
    // A ring that does not reach the hole is not the ring that was read.
    if (latest < o.upTo) { abandonReread(st, 'ring'); return false; }
    const room = refillRoom(st);
    let marks = o.marks;
    o.marks = {};
    const items = [];
    const from = o.after;
    let full = false;
    for (const e of body.events) {
      if (!e || typeof e !== 'object' || !isSeq(e.seq)) continue;
      if (e.kind === 'capture' && !isSeq(e.capture_seq)) { o.legacy = true; continue; }
      if (e.seq <= o.after) continue;
      if (e.seq > o.upTo) break;   // the stream delivered it: held past the hole
      const p = project(st, e);
      const size = bytesOf(p);
      if (room.n < 1 || size > room.bytes) { full = true; break; }
      if (e.seq > o.after + 1) addGap(marks, e.seq - o.after - 1, e.seq);   // evicted meanwhile
      o.after = e.seq;
      if (!batchable(p)) { marks.broken = true; say(`ring chat ${logId(st.id)} entry dropped: not batchable`); continue; }
      items.push({
        e: p, boot: o.boot, since, pos: e.seq,
        captureSeq: e.kind === 'capture' ? e.capture_seq : null,
        bytes: size, ...marks,
      });
      marks = {};
      room.n--;
      room.bytes -= size;
    }
    // What the ring no longer holds of the hole is reported, never filled.
    if (!full && o.after < o.upTo) {
      addGap(marks, o.upTo - o.after, o.upTo + 1);
      o.after = o.upTo;
    }
    st.pending.splice(holeIndex(st), 0, ...items);
    enforceCap(st);   // the entries held past the hole yield; the hole may widen
    if (o.after >= o.upTo) completeReread(st, o, marks);
    else o.marks = marks;
    return o.after > from;
  }

  function completeReread(st, o, marks) {
    st.reread = null;
    const i = st.pending.findIndex((it) => it.hole);
    if (i >= 0) {
      const it = st.pending[i];
      delete it.hole;
      Object.assign(it, marks);
    } else {
      const m = { ...st.markNext, ...marks };
      delete m.hole;
      st.markNext = m;
    }
    if (o.legacy) scheduleReconcile(st);
  }

  function abandonReread(st, why) {
    const o = st.reread;
    if (!o) return;
    st.reread = null;
    const marks = o.marks || {};
    const i = st.pending.findIndex((it) => it.hole);
    const next = i >= 0 ? st.pending[i] : null;
    if (next) {
      delete next.hole;
      if (marks.restart) next.restart = true;
      if (marks.gap && !next.gap && !next.restart) next.gap = marks.gap;
      next.broken = true;
    } else {
      const m = { ...st.markNext, broken: true, ...(marks.restart ? { restart: true } : {}) };
      delete m.hole;
      st.markNext = m;
    }
    say(`ring chat ${logId(st.id)} re-read abandoned: ${why}`);
  }

  // A gap the read answered (bus.read's fields, or the SSE gap event).
  function ingestGap(st, r, g) {
    if (!g || g.gap !== true) return false;
    if (g.reset === true) return 'reset';
    if (isSeq(g.dropped) && g.dropped > 0) {
      const oldest = Number.isInteger(g.oldest) && g.oldest >= 1 ? g.oldest : null;
      st.markNext = { ...st.markNext, gap: { gap: true, dropped: g.dropped, oldest } };
    }
    return true;
  }

  // ── the reconcile and the boot check ──────────────────────────────────────

  // ONE RULE (U723e; the gate's C-6A4-23-reconcile-repeat): a capture record
  // a read answers is queued for the next batch only if the hub neither has it
  // nor is about to. It is judged by what held when the read was ASKED, never
  // by the cursor when it answers (a hub ack can lift capture_seq over records
  // it never received: a stream capture entry raises it). It is not queued when
  //   (i) the queue holds it, or a batch formed and sent (inflight) or taken
  //       back for the resend (resend) and not yet acknowledged carries it —
  //       read off the batch itself, so kept exactly as long as the batch is;
  //  (ii) its counter is at or below the capture `since` its read asked at
  //       (the hub's acknowledged capture_seq when the read was issued; 0 for
  //       the reinit re-read, C-07.12a: the old counter names another
  //       surface); or
  // (iii) a batch that left acknowledged since that read was issued — by its
  //       ack (onAck) or by a handed-back cursor that covers it (setCursor) —
  //       carried it. Each read keeps those ids in its own set, registered on
  //       st.leftDuring from its issue until its answer is queued, so the
  //       record is dropped with the read: nothing is kept while no record read
  //       is in flight.
  // C-07.12's reads are unchanged (one after any batch that is not
  // contiguous); this decides only what a read's answer queues. A batch that
  // leaves unacknowledged by any other way (a relink resends it from the
  // cursor; a send that failed marks the next not contiguous, so it is read
  // again) frees its records to be queued again.
  function noteLeft(st, b) {
    if (!st.leftDuring.size) return;
    for (const r of b.batch.reconciled || []) {
      for (const left of st.leftDuring) left.add(r.capture_id);
    }
  }

  function closeRead(st, read) {
    if (read) st.leftDuring.delete(read.left);
  }

  function queueReconciled(st, records, read) {
    const have = new Set(st.reconciled.map((r) => r.capture_id));
    for (const b of st.inflight.concat(st.resend)) {
      for (const r of b.batch.reconciled || []) have.add(r.capture_id);
    }
    for (const id of read.left) have.add(id);
    for (const rec of records) {
      const item = reconciledItem(project(st, rec, 'capture'));
      if (item && !have.has(item.capture_id) && item.seq > read.floor) { st.reconciled.push(item); have.add(item.capture_id); }
    }
  }

  function handElements(st, records) {
    const out = [];
    for (const rec of records) out.push(project(st, rec, 'element'));
    if (!out.length) return;
    if (typeof onElementRecords === 'function') {
      try { onElementRecords(st.id, out); } catch {}
    } else {
      say(`ring chat ${logId(st.id)} element records read: ${out.length} (no carrier)`);
    }
  }

  // The read's `left` set is registered before the capture route is asked;
  // the caller closes it (closeRead) once the answer is queued, or dropped.
  async function readRecords(st, { captureSince, elementSince }) {
    const read = { floor: captureSince, left: new Set(), caps: null, els: null };
    st.leftDuring.add(read.left);
    try {
      const caps = await hostGet(st, `/api/captures?since=${captureSince}`);
      const els = await hostGet(st, `/api/elements?since=${elementSince}`);
      read.caps = caps && Array.isArray(caps.captures) ? caps : null;
      read.els = els && Array.isArray(els.elements) ? els : null;
      return read;
    } catch (e) {
      closeRead(st, read);
      throw e;
    }
  }

  function scheduleReconcile(st) {
    if (!st.root) return;   // no record is read before the root (C-11.18)
    if (st.reconciling) { st.reconcileAgain = true; return; }
    st.reconciling = true;
    (async () => {
      do {
        st.reconcileAgain = false;
        const c = st.cursor || { capture_seq: 0, element_seq: 0 };
        const read = await readRecords(st, { captureSince: c.capture_seq, elementSince: c.element_seq });
        try {
          if (read.caps) queueReconciled(st, read.caps.captures, read);
          if (read.els) handElements(st, read.els.elements);
        } finally { closeRead(st, read); }
      } while (st.reconcileAgain && chats.get(st.id) === st);
    })().catch(() => {}).finally(() => {
      st.reconciling = false;
      pump(st);
    });
  }

  // C-07.12a: before the new boot's first batch, read both routes once.
  function startBootCheck(st, boot) {
    const c = st.cursor;
    const check = { boot, done: false, reinit: false, element_reset: false };
    st.bootCheck = check;
    let first = null;
    let again = null;
    (async () => {
      first = await readRecords(st, { captureSince: c.capture_seq, elementSince: c.element_seq });
      const { caps, els } = first;
      if (caps && isSeq(caps.next_cursor) && caps.next_cursor < c.capture_seq) check.reinit = true;
      if (!check.reinit && els && isSeq(els.next_cursor) && els.next_cursor < c.element_seq) check.element_reset = true;
      // A re-initialised surface counts from 0 again: its records are read
      // from 0, the hub's capture_seq and element_seq being reset by the flag.
      let records = first;
      let elements = els;
      if (check.reinit || check.element_reset) {
        again = await readRecords(st, { captureSince: check.reinit ? 0 : c.capture_seq, elementSince: 0 });
        if (check.reinit) records = again;
        elements = again.els;
      }
      if (records.caps) queueReconciled(st, records.caps.captures, records);
      if (elements) handElements(st, elements.elements);
    })().catch(() => {}).finally(() => {
      closeRead(st, first);
      closeRead(st, again);
      check.done = true;
      pump(st);
    });
  }

  // ── batches ────────────────────────────────────────────────────────────────

  function formBatch(st) {
    if (st.resend.length) return { resend: st.resend[0] };
    const head = st.pending[0];
    const boot = head ? head.boot : st.boot;
    if (!isBoot(boot)) return null;
    if (st.bootCheck && st.bootCheck.boot === boot && !st.bootCheck.done) return null;
    if (!head && (!st.reconciled.length || boot !== st.sentBoot)) return null;
    const take = [];
    let bytes = 0;
    for (const it of st.pending) {
      if (it.boot !== boot) break;
      // Held until the owed re-read has filled the hole before it, in order.
      if (it.hole && st.reread && st.reread.boot === it.boot) break;
      if (take.length && (it.restart || it.gap)) break;
      if (take.length >= BATCH_MAX_ENTRIES || (take.length && bytes + it.bytes > BATCH_MAX_BYTES)) break;
      take.push(it);
      bytes += it.bytes;
    }
    if (head && !take.length) return null;   // the head is held behind a hole
    const first = take[0] || null;
    const firstOfBoot = !st.firstSent.has(boot);
    let gap = null;
    let contiguous;
    if (first && first.restart) {
      const oldest = first.pos != null && first.pos >= 1 ? first.pos : null;
      gap = { gap: true, dropped: 0, oldest, reset: true };
      contiguous = false;
    } else if (first && first.gap) {
      // C-07.11: a gap's dropped is not trusted when the oldest entry may be a
      // capture's counter (an older daemon): then no gap object, not contiguous.
      gap = first.pos == null ? null : { ...first.gap };
      contiguous = false;
    } else if (!first) {
      contiguous = true;   // records only: the batch claims no ring position
    } else if (st.sentBoot != null && st.sentBoot !== boot) {
      contiguous = false;
    } else {
      // The first entry must be a ring position (an older daemon's capture is
      // not) and the one after what the hub will hold.
      contiguous = first.pos != null && first.pos === st.sentPos + 1;
    }
    if (take.some((it) => it.broken)) contiguous = false;
    const reconciled = boot === st.boot ? st.reconciled.slice(0, RECONCILED_MAX) : [];
    let reinit = false;
    let elementReset = false;
    if (firstOfBoot && st.bootCheck && st.bootCheck.boot === boot) {
      reinit = st.bootCheck.reinit;
      elementReset = st.bootCheck.element_reset;
      const floor = st.cursor ? st.cursor.capture_seq : 0;
      if (take.some((it) => it.captureSeq != null && it.captureSeq < floor)) reinit = true;
      if (reinit) elementReset = false;
    }
    const since = first ? first.since : (isSeq(st.sentPos) ? st.sentPos : 0);
    const batch = {
      type: 'events.batch',
      batch_id: mintBatchId(d.now, d.randomBytes),
      chat_id: st.id,
      ring: 'main',
      boot,
      since,
      contiguous,
      ...(gap ? { gap } : {}),
      entries: take.map((it) => it.e),
      ...(reconciled.length ? { reconciled } : {}),
      ...(reinit ? { reinit: true } : {}),
      ...(elementReset ? { element_reset: true } : {}),
    };
    let last = null;
    for (const it of take) if (it.pos != null) last = it.pos;
    return { batch, take, reconciledN: reconciled.length, bytes: bytesOf(batch), last, restart: Boolean(first && first.restart) };
  }

  function pump(st) {
    if (chats.get(st.id) !== st || !ln) return;
    // Held after a reconnect until the chat's cursor arrives (THE RESUME).
    if (held(st)) return;
    for (;;) {
      const f = formBatch(st);
      if (!f) return;
      if (typeof ln.batchSlot !== 'function' || !ln.batchSlot(st.id)) return;
      if (f.resend) {
        st.resend.shift();
        // A frame holding a registered secret throws (U716b, code 'secret');
        // it must not escape this 'ready' listener (EventEmitter would skip
        // every later one, the authority log's among them). Treated as not
        // sent, and what follows cannot claim to continue it (hand fold 7 (h)).
        let id = null;
        try { id = ln.send('events', 'events.batch', { batch: f.resend.batch }); } catch (e) {
          say(`ring chat ${logId(st.id)} resend refused: ${(e && e.code) || 'error'}`);
          const next = st.pending[0];
          if (next) next.broken = true; else st.markNext = { ...st.markNext, broken: true };
          continue;
        }
        if (id) st.inflight.push(f.resend);
        else say(`ring chat ${logId(st.id)} resend not sent`);
        continue;
      }
      st.pending.splice(0, f.take.length);
      st.reconciled.splice(0, f.reconciledN);
      st.firstSent.add(f.batch.boot);
      if (f.restart || st.sentBoot !== f.batch.boot) st.sentPos = 0;
      st.sentBoot = f.batch.boot;
      if (f.last != null) st.sentPos = Math.max(st.sentPos, f.last);
      const rec = { batch: f.batch, n: f.take.length, bytes: f.bytes };
      let id = null;
      try { id = ln.send('events', 'events.batch', { batch: f.batch }); } catch (e) {
        say(`ring chat ${logId(st.id)} batch refused: ${(e && e.code) || 'error'}`);
      }
      if (id) st.inflight.push(rec);
      else {
        // Not on the wire (a secret in it, or the link went down between the
        // slot and the send): what follows cannot claim to continue it.
        const next = st.pending[0];
        if (next) next.broken = true; else st.markNext = { ...st.markNext, broken: true };
        say(`ring chat ${logId(st.id)} batch not sent`);
      }
      if (!f.batch.contiguous) scheduleReconcile(st);
    }
  }

  // ── the stream read (the lifecycle's fan-out) ─────────────────────────────

  function provider(chatId) {
    const st = stateOf(chatId);
    // A new ask supersedes one that never opened (the lifecycle emits no
    // close for a hold it closed itself). A cursor that waited for that ask
    // sets the since now: a read asked after the cursor is asked from it.
    st.asked = false;
    adoptCursor(st);
    st.asked = true;
    const since = st.boot != null && isSeq(st.pos) ? st.pos : 0;
    // C-07.9: against a daemon that has not named its boot, read health as the
    // hold opens (the provider runs just before the open).
    st.healthBefore = st.headerSeen ? null : healthBoot(st);
    return since;
  }

  function onOpen(st, msg) {
    st.asked = false;
    st.openedSinceClose = true;
    st.failedOpens = 0;
    stopPoll(st);
    if (msg.port != null && isPort(msg.port)) st.port = msg.port;
    if (msg.chat && typeof msg.chat === 'object') track({ ...msg.chat, id: st.id });
    const since = isSeq(msg.since) ? msg.since : 0;
    const r = { gen: ++st.readGen, since, boot: null, state: 'resolving', buf: [], second: false, skipThrough: 0 };
    st.read = r;
    r.headerBoot = headerBoot(msg.response && msg.response.headers);
    r.before = st.healthBefore;
    st.healthBefore = null;
    // Fail closed (C-11.18): without the chat's root nothing is projected, so
    // the read holds what it is handed until track() names the root.
    if (!st.root) {
      r.state = 'unrooted';
      say(`ring chat ${logId(st.id)} read held: no root`);
      return;
    }
    resolveBoot(st, r);
  }

  // The read's boot: the header, else health (the read issued as the hold
  // opened, else a fresh one).
  function resolveBoot(st, r) {
    r.state = 'resolving';
    const hb = r.headerBoot;
    const before = r.before;
    r.before = null;
    if (hb) {
      st.headerSeen = true;
      r.boot = hb;
      r.second = true;
      settle(st, r);
      return;
    }
    st.headerSeen = false;
    Promise.resolve(before || healthBoot(st)).then((b) => {
      if (st.read !== r) return;
      if (!b) { r.state = 'dead'; say(`ring chat ${logId(st.id)} read has no boot`); return; }
      r.boot = b;
      settle(st, r);
    }, () => {});
  }

  // The read's boot is known: resume, or re-base.
  function settle(st, r) {
    if (st.boot != null && r.boot !== st.boot) {
      restartAt(st, r.boot, { check: true });
      if (r.since > 0) { rebase(st, r); return; }
    } else if (st.boot == null) {
      st.boot = r.boot;
      st.pos = 0;
      // A cursor that arrived while this read (opened from 0) learnt its boot.
      meetFirstCursor(st);
    }
    r.state = r.second ? 'live' : 'awaiting';
    if (r.since > 0) scheduleReconcile(st);
    drain(st, r);
  }

  function drain(st, r) {
    if (r.state === 'awaiting' && r.buf.some((m) => m.type === 'entry')) { secondCheck(st, r); return; }
    if (r.state !== 'live') return;
    const buf = r.buf;
    r.buf = [];
    for (const m of buf) handle(st, r, m);
    pump(st);
  }

  // C-07.9's second read: after the stream's first entry, health again.
  function secondCheck(st, r) {
    if (r.checking) return;
    r.checking = true;
    healthBoot(st).then((b) => {
      r.checking = false;
      if (st.read !== r) return;
      if (b && b === r.boot) { r.second = true; r.state = 'live'; drain(st, r); return; }
      if (!b) { r.state = 'dead'; say(`ring chat ${logId(st.id)} read has no boot`); return; }
      // The boot moved under the read: discard what it delivered and re-base.
      r.buf = [];
      r.boot = b;
      r.second = true;
      restartAt(st, b, { check: true });
      rebase(st, r);
    }, () => {});
  }

  // Read the read's boot from 0 with one poll; the stream's later entries
  // continue past its `latest`. A poll whose boot is not the read's leaves the
  // read waiting and tries again.
  function rebase(st, r) {
    r.state = 'rebasing';
    r.buf = r.buf.filter((m) => m.type === 'entry' || m.type === 'gap');
    r.since = 0;
    (async () => {
      const res = await hostGet(st, '/api/events?since=0', { withHeaders: true });
      if (st.read !== r) return;
      const body = res && res.body;
      let b = res ? headerBoot(res.headers) : null;
      if (res && !b) b = await healthBoot(st);
      if (st.read !== r) return;
      if (!body || !Array.isArray(body.events) || b !== r.boot) {
        r.retry = unref(d.setTimeout(() => { if (st.read === r) rebase(st, r); }, REBASE_RETRY_MS));
        return;
      }
      const latest = isSeq(body.latest) ? body.latest : 0;
      for (const e of body.events) ingestEntry(st, r.boot, e, 0);
      if (st.boot === r.boot) st.pos = Math.max(st.pos || 0, latest);
      r.skipThrough = latest;
      // Stream entries buffered before the re-base answered are discarded up
      // to what the poll covered; a gap the stream reported for the old since
      // means nothing for a read from 0.
      r.buf = r.buf.filter((m) => m.type === 'entry');
      r.state = 'live';
      drain(st, r);
    })().catch(() => {});
  }

  function handle(st, r, m) {
    if (m.type === 'gap') {
      const g = ingestGap(st, r, m.gap);
      if (g === 'reset') {
        restartAt(st, r.boot, { check: false });
        rebase(st, r);
      }
      return;
    }
    const e = m.entry;
    if (!e || typeof e !== 'object') return;
    if (isSeq(e.seq) && e.seq <= r.skipThrough && !(e.kind === 'capture' && !isSeq(e.capture_seq))) return;
    if (r.state !== 'live') { r.buf.push(m); return; }
    ingestEntry(st, r.boot, e, r.since);
  }

  function onEntry(st, msg) {
    const r = st.read;
    if (!r || r.state === 'dead') return;
    const m = { type: 'entry', entry: msg.entry };
    if (r.state === 'live') { handle(st, r, m); return; }
    r.buf.push(m);
    if (r.state === 'awaiting') secondCheck(st, r);
  }

  function onGapMsg(st, msg) {
    const r = st.read;
    if (!r || r.state === 'dead') return;
    const m = { type: 'gap', gap: msg.gap };
    if (r.state === 'live') { handle(st, r, m); return; }
    r.buf.push(m);
  }

  function onClose(st) {
    const r = st.read;
    if (r && r.retry) { try { d.clearTimeout(r.retry); } catch {} }
    st.read = null;
    st.asked = false;
    if (st.openedSinceClose) st.failedOpens = 0; else st.failedOpens++;
    st.openedSinceClose = false;
    if (st.failedOpens >= FAILED_OPENS_TO_POLL && !st.poll) maybePoll(st);
  }

  // ── the poll fallback ─────────────────────────────────────────────────────

  async function maybePoll(st) {
    if (!lc || typeof lc.healthOf !== 'function') return;
    let h = null;
    try { h = await lc.healthOf(st.id, { fresh: true }); } catch { h = null; }
    if (!h || st.poll || st.read || chats.get(st.id) !== st) return;
    st.poll = { timer: null, first: true };
    say(`ring chat ${logId(st.id)} stream failed ${st.failedOpens} opens: polling`);
    pollOnce(st, st.poll, h);
  }

  function stopPoll(st) {
    if (!st.poll) return;
    if (st.poll.timer) { try { d.clearTimeout(st.poll.timer); } catch {} }
    st.poll = null;
  }

  async function pollOnce(st, p, health) {
    if (st.poll !== p) return;
    if (!st.root) {
      // Nothing is read before the root is known (C-11.18): try again later.
      say(`ring chat ${logId(st.id)} poll held: no root`);
      p.timer = unref(d.setTimeout(() => { p.timer = null; pollOnce(st, p, null).catch(() => {}); }, POLL_IDLE_MS));
      return;
    }
    let again = 0;
    let since = st.boot != null && isSeq(st.pos) ? st.pos : 0;
    // C-07.9 against a daemon that has not named its boot: health before the
    // poll chooses since, and health after it confirms the boot.
    const before = st.headerSeen ? null : await healthBoot(st);
    if (st.poll !== p) return;
    if (before && st.boot != null && before !== st.boot) {
      restartAt(st, before, { check: true });
      since = 0;
    }
    const res = await hostGet(st, `/api/events?since=${since}`, { withHeaders: true });
    if (st.poll !== p) return;
    if (res && res.body && Array.isArray(res.body.events)) {
      let b = headerBoot(res.headers);
      if (b) st.headerSeen = true;
      else {
        st.headerSeen = false;
        const after = await healthBoot(st);
        if (st.poll !== p) return;
        b = after && (!before || after === before) ? after : null;
        if (!b) again = 1;   // the boot moved under the poll: discard it, read again
      }
      if (b) again = ingestPoll(st, p, b, since, res.body);
    }
    let viewers = health && Number.isInteger(health.viewers) ? health.viewers : 0;
    if (!health && lc && typeof lc.healthOf === 'function') {
      try { const h = await lc.healthOf(st.id); viewers = h && Number.isInteger(h.viewers) ? h.viewers : 0; } catch {}
    }
    if (st.poll !== p) return;
    const wait = again ? 0 : (viewers > 0 ? POLL_VIEWER_MS : POLL_IDLE_MS);
    p.timer = unref(d.setTimeout(() => { p.timer = null; pollOnce(st, p, null).catch(() => {}); }, wait));
  }

  // One poll's answer; returns 1 when it must be read again at once (a re-base).
  function ingestPoll(st, p, boot, since, body) {
    if (st.boot != null && boot !== st.boot) {
      restartAt(st, boot, { check: true });
      if (since > 0) return 1;
    } else if (st.boot == null) {
      st.boot = boot;
      st.pos = 0;
      // A cursor that arrived while this poll (from 0) was in flight.
      meetFirstCursor(st);
    }
    if (body.gap === true && body.reset === true) {
      restartAt(st, boot, { check: false });
      return 1;
    }
    if (body.gap === true) ingestGap(st, null, body);
    for (const e of body.events) ingestEntry(st, boot, e, since);
    if (isSeq(body.latest) && st.boot === boot) st.pos = Math.max(st.pos || 0, body.latest);
    if (since > 0 && p.first) scheduleReconcile(st);
    p.first = false;
    pump(st);
    return 0;
  }

  // ── the hub's side ─────────────────────────────────────────────────────────

  // THE FIRST CURSOR (C-07.10 rows 2 to 4 whichever of the read and the cursor
  // comes first; U723c, U723d). `connect run` resumes a chat's read before it
  // starts the link, so the first cursor of this connector's life may land
  // anywhere among the read's own events. ONE rule decides: the cursor sets
  // the read's since only when nothing of the chat has been asked for or read
  // (adoptCursor: the cursor-first order — the read is then asked from the
  // cursor and nothing below it is read at all); in every other order the
  // read, asked from 0, is met here once its boot is known:
  //   * asked, the cursor, then the open (the gate's order, t6-6A-r3): the
  //     cursor waits; the read opens from 0 and settle meets it;
  //   * opened, the cursor while its boot is still unknown (the header-less
  //     stream's health, a poll in flight): settle or ingestPoll meets it;
  //   * the read settled — boot known, entries read or not — then the cursor:
  //     setCursor meets it;
  //   * asked, the cursor, then the read fails or is superseded unopened: the
  //     next stream ask adopts the cursor (provider), as in the cursor-first
  //     order; a poll that starts instead (that was the third failed open)
  //     reads from 0 and ingestPoll meets it.
  // Whichever it is, the hub's cursor, not the read's since, says what the hub
  // holds, and the first batch reads as it would had the read opened from the
  // cursor:
  //   * the cursor's boot is the read's (row 2, resume): what the cursor
  //     covers is not sent, then or later (st.resumed); the hub will hold the
  //     cursor (sentBoot, sentPos), so the first batch is contiguous from it
  //     and names its seq as since; an item opening the run above cursor + 1
  //     carries the evicted gap (markEvictedSince); and the reconcile a read
  //     with since > 0 makes is made.
  //   * another boot (rows 3 and 4): the first item of the read's boot (else
  //     the next to arrive) is marked restart through restartAt, which
  //     abandons an owed re-read and runs C-07.12a's boot check; formBatch
  //     holds that boot's first batch until the check is done.
  //   * a cursor with no boot (row 1): nothing changes.
  // "Nothing of the chat sent in this connector's life" is what makes it the
  // first cursor. The rule leans on two things: the link is down before its
  // first 'ready' (batchSlot answers false), and THE RESUME's hold lets
  // nothing of a chat out between a 'ready' and that chat's cursor — so before
  // the first cursor no batch of the chat can have gone. Callers pump after.
  function meetFirstCursor(st) {
    const c = st.cursor;
    if (!c || c.boot == null || !isBoot(st.boot)) return;
    if (st.sentBoot != null || st.inflight.length || st.resend.length) return;
    st.pending = st.pending.filter((it) => it.boot !== c.boot || it.pos == null || it.pos > c.seq);
    st.sentBoot = c.boot;
    st.sentPos = c.seq;
    let head = null;
    for (const it of st.pending) {
      if (it.boot !== c.boot) continue;
      if (!head) head = it;
      if (it.since < c.seq) it.since = c.seq;
    }
    if (head) markEvictedSince(head, c.seq);
    if (c.boot === st.boot) {
      st.resumed = { boot: c.boot, seq: c.seq, first: !head };
      if (isSeq(st.pos) && c.seq > st.pos) st.pos = c.seq;
      if (c.seq > 0) scheduleReconcile(st);
    } else {
      restartAt(st, st.boot, { check: true, from: c.boot });
    }
  }

  // The cursor-first order of THE FIRST CURSOR: nothing of the chat asked for
  // (a stream read the provider answered and that has not opened or closed),
  // open (a stream read), polling, read or sent — the cursor alone sets the
  // boot and the read position, so the read is asked from it. Returns whether
  // it did; otherwise the read already asked for is met by meetFirstCursor.
  function adoptCursor(st) {
    const c = st.cursor;
    if (!c || st.boot != null || st.asked || st.read || st.poll) return false;
    if (st.pending.length || st.inflight.length || st.resend.length) return false;
    st.boot = c.boot;
    st.pos = c.boot != null ? c.seq : null;
    st.sentBoot = c.boot;
    st.sentPos = c.boot != null ? c.seq : 0;
    return true;
  }

  function setCursor(chatId, cursor) {
    if (typeof chatId !== 'string' || !CHAT_RE.test(chatId)) throw new TypeError('setCursor: a chat label is required');
    const c = normCursor(cursor);
    if (!c) throw new TypeError('setCursor: a 07 source cursor is required');
    const st = stateOf(chatId);
    const wasHeld = held(st);
    st.cursor = c;
    st.cursorLink = linkGen;
    if (adoptCursor(st)) return;
    // Batches the hub has committed (its cursor covers them) need no resend,
    // and entries it holds are not sent again. A batch's reconciled capture
    // records are covered by the cursor's capture_seq, never by its seq: a
    // batch of records alone is not covered by any cursor of its boot.
    const covered = (b) => b.batch.boot === c.boot
      && b.batch.entries.every((e) => e.seq <= c.seq)
      && (b.batch.reconciled || []).every((r) => r.seq <= c.capture_seq);
    for (const b of st.inflight.concat(st.resend)) if (covered(b)) noteLeft(st, b);
    st.inflight = st.inflight.filter((b) => !covered(b));
    st.resend = st.resend.filter((b) => !covered(b));
    if (c.boot != null && c.boot === st.boot) {
      st.pending = st.pending.filter((it) => it.boot !== c.boot || it.pos == null || it.pos > c.seq);
      if (isSeq(st.pos) && c.seq > st.pos) st.pos = c.seq;
      if (st.sentBoot === c.boot && c.seq > st.sentPos) st.sentPos = c.seq;
    }
    // The read settled before this, the first cursor of the connector's life
    // (C-07.10 rows 2 to 4 in the read-first order); before the pump below.
    meetFirstCursor(st);
    // What the hub holds of an owed hole needs no re-read.
    const o = st.reread;
    if (o && c.boot === o.boot && c.seq > o.after) {
      o.after = Math.min(c.seq, o.upTo);
      o.marks = {};
      if (o.after >= o.upTo) completeReread(st, o, {});
    }
    pump(st);
    // The hold released: an owed re-read goes on from this cursor.
    if (wasHeld) maybeReread(st);
  }

  function onAck(frame) {
    const ack = frame && frame.ack;
    if (!ack || typeof ack !== 'object' || typeof ack.chat_id !== 'string') return;
    const st = chats.get(ack.chat_id);
    if (!st) return;
    const i = st.inflight.findIndex((b) => b.batch.batch_id === ack.batch_id);
    if (i >= 0) noteLeft(st, st.inflight.splice(i, 1)[0]);
    const c = normCursor(ack.cursor);
    if (c) st.cursor = c;
    pump(st);
    // The ack freed room: an owed re-read goes on from the hub's cursor.
    maybeReread(st);
  }

  // After a reconnect every unacknowledged batch goes again, first, in order —
  // but only from the cursor the hub hands back on the new link (C-07.11):
  // every chat is held until its setCursor, which drops what the cursor
  // covers and pumps the rest (THE RESUME).
  function onLinkReady() {
    linkGen++;
    for (const st of chats.values()) {
      if (st.inflight.length) {
        st.resend = st.inflight.concat(st.resend);
        st.inflight = [];
      }
    }
  }

  // The chat's folder (the root for projectAudit's label mask, and for the
  // registry lookup when the lifecycle names no port).
  function track(chat) {
    const id = chat && (chat.id != null ? chat.id : chat.chat_id);
    if (typeof id !== 'string' || typeof (chat && chat.root) !== 'string') return;
    const st = stateOf(id);
    st.root = realpath(chat.root) || chat.root;
    // A read that opened before the root was known goes on now.
    if (st.read && st.read.state === 'unrooted') resolveBoot(st, st.read);
  }

  function onLifecycle(msg) {
    if (!msg || typeof msg.chatId !== 'string') return;
    const st = stateOf(msg.chatId);
    switch (msg.type) {
      case 'open': onOpen(st, msg); return;
      case 'entry': onEntry(st, msg); return;
      case 'gap': onGapMsg(st, msg); return;
      case 'close': onClose(st); return;
      default:
    }
  }

  function cursorOf(chatId) {
    const st = chats.get(chatId);
    return st && st.cursor ? { ...st.cursor } : null;
  }

  // What the ring holds for a chat, as counts (status and tests).
  function stats(chatId) {
    const st = chats.get(chatId);
    if (!st) return null;
    let unacked = st.pending.length;
    for (const b of st.inflight.concat(st.resend)) unacked += b.n;
    return { pending: st.pending.length, inflight: st.inflight.length, unacked, dropped: st.dropped, polling: Boolean(st.poll), reread: Boolean(st.reread), held: held(st) };
  }

  function forget(chatId) {
    const st = chats.get(chatId);
    if (!st) return;
    stopPoll(st);
    if (st.read && st.read.retry) { try { d.clearTimeout(st.read.retry); } catch {} }
    chats.delete(chatId);
  }

  const api = { setCursor, track, cursorOf, stats, forget };

  // CONNECTOR@install-seam: the ring reads through the run context's one
  // lifecycle and sends on its one link.
  function install(ctx) {
    if (!ctx || typeof ctx !== 'object') throw new TypeError('install: a context object is required');
    if (ctx.ring && ctx.ring !== api) throw new Error('install: a ring is already installed');
    lc = lc || ctx.lifecycle;
    ln = ln || ctx.link;
    if (!lc || typeof lc.subscribe !== 'function' || typeof lc.setCursorProvider !== 'function') {
      throw new TypeError('install: a lifecycle (subscribe, setCursorProvider) is required');
    }
    const undo = [];
    undo.push(lc.subscribe(onLifecycle));
    lc.setCursorProvider(provider);
    undo.push(() => lc.setCursorProvider(null));
    if (typeof lc.onTick === 'function') {
      undo.push(lc.onTick(({ chatId, chat }) => {
        const st = chats.get(chatId);
        if (chat && (!st || !st.root)) track({ ...chat, id: chatId });
      }));
    }
    if (ln && typeof ln.channel === 'function') undo.push(ln.channel('events', { kinds: ['events.ack'], handle: onAck }));
    if (ln && typeof ln.on === 'function') {
      ln.on('ready', onLinkReady);
      undo.push(() => ln.off('ready', onLinkReady));
    }
    ctx.ring = api;
    return () => {
      for (const fn of undo.reverse()) { try { if (typeof fn === 'function') fn(); } catch {} }
      for (const id of [...chats.keys()]) forget(id);
      if (ctx.ring === api) delete ctx.ring;
    };
  }
  api.install = install;

  return api;
}

module.exports = {
  createRing,
  headerBoot,
  mintBatchId,
  BATCH_MAX_ENTRIES,
  BATCH_MAX_BYTES,
  RECONCILED_MAX,
  UNACKED_MAX_ENTRIES,
  UNACKED_MAX_BYTES,
  FAILED_OPENS_TO_POLL,
  POLL_VIEWER_MS,
  POLL_IDLE_MS,
};
