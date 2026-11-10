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
//     count (`evicted`). A gap is reported, never filled.
//   * BATCHES (C-07.11). Entries in ascending ring position, each reduced by
//     projectAudit BEFORE it is kept (C-11.18; the hub repeats it), at most
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
//     are dropped and the next batch goes out not contiguous (the hub records
//     the gap). After a link reconnect ('ready') every sent, unacknowledged
//     batch is sent again first, in order (the hub dedupes by source.key).
//   * RECONCILE (C-07.12, C-07.13). After any read with since > 0 and after any
//     batch sent not contiguous: GET /api/captures?since=<capture_seq> and
//     GET /api/elements?since=<element_seq>, each record reduced by
//     projectAudit's capture or element row. Captures ride the next batch's
//     `reconciled` (07-source-batch's closed item: kind, capture_id, seq, ts,
//     source). 07-source-batch.json (v1.4) has no field for an element record,
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

  function stateOf(chatId) {
    let st = chats.get(chatId);
    if (!st) {
      st = {
        id: chatId,
        root: null,          // the folder's real path, else the root
        port: null,          // the daemon's port, when the lifecycle names it
        cursor: null,        // the hub's 07 source cursor
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
        readGen: 0,
        markNext: {},        // flags for the next ingested item: restart, broken, gap
        bootCheck: null,     // {boot, done, reinit, element_reset} at a boot change
        firstSent: new Set(), // boots whose first batch went out
        failedOpens: 0,
        openedSinceClose: false,
        poll: null,          // {timer, first}
        reconciling: false,
        flushing: false,
        reconcileAgain: false,
        dropped: 0,
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

  function project(st, entry, record) {
    return d.projectAudit(entry, { ...(record ? { record } : {}), root: st.root, home });
  }

  function takeMarks(st) {
    const m = st.markNext;
    st.markNext = {};
    return m;
  }

  // A boot change (or a reset): positions start again; the next item read
  // opens the new boot's first batch with the restart gap.
  function restartAt(st, boot, { check }) {
    const old = st.boot;
    st.boot = boot;
    st.pos = 0;
    st.markNext = { ...st.markNext, restart: true };
    delete st.markNext.gap;
    if (check && old != null && old !== boot && st.cursor) startBootCheck(st, boot);
  }

  function ingestEntry(st, boot, entry, since) {
    if (!entry || typeof entry !== 'object') return;
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

  function enforceCap(st) {
    let n = st.pending.length;
    let bytes = 0;
    for (const it of st.pending) bytes += it.bytes;
    for (const b of st.inflight) { n += b.n; bytes += b.bytes; }
    for (const b of st.resend) { n += b.n; bytes += b.bytes; }
    let dropped = 0;
    while ((n > UNACKED_MAX_ENTRIES || bytes > UNACKED_MAX_BYTES) && st.pending.length) {
      const it = st.pending.shift();
      n--;
      bytes -= it.bytes;
      dropped++;
      // What the dropped item opened (a restart, a gap) moves to the next one,
      // and the next one cannot claim to continue.
      const carry = { restart: it.restart, gap: it.gap };
      const next = st.pending[0];
      if (next) {
        if (carry.restart) next.restart = true;
        if (carry.gap && !next.gap && !next.restart) next.gap = carry.gap;
        next.broken = true;
      } else {
        st.markNext = { ...st.markNext, broken: true, ...(carry.restart ? { restart: true } : {}) };
      }
    }
    if (dropped) {
      st.dropped += dropped;
      say(`ring chat ${logId(st.id)} unacknowledged buffer full: ${dropped} dropped`);
    }
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

  function queueReconciled(st, records) {
    const have = new Set(st.reconciled.map((r) => r.capture_id));
    for (const rec of records) {
      const item = reconciledItem(project(st, rec, 'capture'));
      if (item && !have.has(item.capture_id)) { st.reconciled.push(item); have.add(item.capture_id); }
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

  async function readRecords(st, { captureSince, elementSince }) {
    const caps = await hostGet(st, `/api/captures?since=${captureSince}`);
    const els = await hostGet(st, `/api/elements?since=${elementSince}`);
    return {
      caps: caps && Array.isArray(caps.captures) ? caps : null,
      els: els && Array.isArray(els.elements) ? els : null,
    };
  }

  function scheduleReconcile(st) {
    if (st.reconciling) { st.reconcileAgain = true; return; }
    st.reconciling = true;
    (async () => {
      do {
        st.reconcileAgain = false;
        const c = st.cursor || { capture_seq: 0, element_seq: 0 };
        const { caps, els } = await readRecords(st, { captureSince: c.capture_seq, elementSince: c.element_seq });
        if (caps) queueReconciled(st, caps.captures);
        if (els) handElements(st, els.elements);
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
    (async () => {
      const { caps, els } = await readRecords(st, { captureSince: c.capture_seq, elementSince: c.element_seq });
      if (caps && isSeq(caps.next_cursor) && caps.next_cursor < c.capture_seq) check.reinit = true;
      if (!check.reinit && els && isSeq(els.next_cursor) && els.next_cursor < c.element_seq) check.element_reset = true;
      // A re-initialised surface counts from 0 again: its records are read
      // from 0, the hub's capture_seq and element_seq being reset by the flag.
      let records = caps;
      let elements = els;
      if (check.reinit || check.element_reset) {
        const again = await readRecords(st, { captureSince: check.reinit ? 0 : c.capture_seq, elementSince: 0 });
        if (check.reinit) records = again.caps;
        elements = again.els;
      }
      if (records) queueReconciled(st, records.captures);
      if (elements) handElements(st, elements.elements);
    })().catch(() => {}).finally(() => {
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
      if (take.length && (it.restart || it.gap)) break;
      if (take.length >= BATCH_MAX_ENTRIES || (take.length && bytes + it.bytes > BATCH_MAX_BYTES)) break;
      take.push(it);
      bytes += it.bytes;
    }
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
    for (;;) {
      const f = formBatch(st);
      if (!f) return;
      if (typeof ln.batchSlot !== 'function' || !ln.batchSlot(st.id)) return;
      if (f.resend) {
        st.resend.shift();
        const id = ln.send('events', 'events.batch', { batch: f.resend.batch });
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
    const since = st.boot != null && isSeq(st.pos) ? st.pos : 0;
    // C-07.9: against a daemon that has not named its boot, read health as the
    // hold opens (the provider runs just before the open).
    st.healthBefore = st.headerSeen ? null : healthBoot(st);
    return since;
  }

  function onOpen(st, msg) {
    st.openedSinceClose = true;
    st.failedOpens = 0;
    stopPoll(st);
    if (msg.port != null && isPort(msg.port)) st.port = msg.port;
    const since = isSeq(msg.since) ? msg.since : 0;
    const r = { gen: ++st.readGen, since, boot: null, state: 'resolving', buf: [], second: false, skipThrough: 0 };
    st.read = r;
    const hb = headerBoot(msg.response && msg.response.headers);
    const before = st.healthBefore;
    st.healthBefore = null;
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

  function setCursor(chatId, cursor) {
    if (typeof chatId !== 'string' || !CHAT_RE.test(chatId)) throw new TypeError('setCursor: a chat label is required');
    const c = normCursor(cursor);
    if (!c) throw new TypeError('setCursor: a 07 source cursor is required');
    const st = stateOf(chatId);
    st.cursor = c;
    const fresh = st.boot == null && !st.pending.length && !st.inflight.length && !st.read;
    if (fresh) {
      st.boot = c.boot;
      st.pos = c.boot != null ? c.seq : null;
      st.sentBoot = c.boot;
      st.sentPos = c.boot != null ? c.seq : 0;
      return;
    }
    // Batches the hub has committed (its cursor covers them) need no resend,
    // and entries it holds are not sent again.
    const covered = (b) => b.batch.boot === c.boot && b.batch.entries.every((e) => e.seq <= c.seq);
    st.inflight = st.inflight.filter((b) => !covered(b));
    st.resend = st.resend.filter((b) => !covered(b));
    if (c.boot != null && c.boot === st.boot) {
      st.pending = st.pending.filter((it) => it.boot !== c.boot || it.pos == null || it.pos > c.seq);
      if (isSeq(st.pos) && c.seq > st.pos) st.pos = c.seq;
      if (st.sentBoot === c.boot && c.seq > st.sentPos) st.sentPos = c.seq;
    }
    pump(st);
  }

  function onAck(frame) {
    const ack = frame && frame.ack;
    if (!ack || typeof ack !== 'object' || typeof ack.chat_id !== 'string') return;
    const st = chats.get(ack.chat_id);
    if (!st) return;
    const i = st.inflight.findIndex((b) => b.batch.batch_id === ack.batch_id);
    if (i >= 0) st.inflight.splice(i, 1);
    const c = normCursor(ack.cursor);
    if (c) st.cursor = c;
    pump(st);
  }

  // After a reconnect every unacknowledged batch goes again, first, in order.
  function onLinkReady() {
    for (const st of chats.values()) {
      if (st.inflight.length) {
        st.resend = st.inflight.concat(st.resend);
        st.inflight = [];
      }
      pump(st);
    }
  }

  // The chat's folder (the root for projectAudit's label mask, and for the
  // registry lookup when the lifecycle names no port).
  function track(chat) {
    const id = chat && (chat.id != null ? chat.id : chat.chat_id);
    if (typeof id !== 'string' || typeof (chat && chat.root) !== 'string') return;
    const st = stateOf(id);
    st.root = realpath(chat.root) || chat.root;
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
    return { pending: st.pending.length, inflight: st.inflight.length, unacked, dropped: st.dropped, polling: Boolean(st.poll) };
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
