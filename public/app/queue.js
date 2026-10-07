// The queue rail. Wake-worthy
// signals (captures, pane signals, comments) collect as server-side queue items;
// this reads GET /api/queue and folds the `queue` WS frames. The rail is split
// VSCode-git-style into STAGED (sent on the next Push) and HELD (kept back). Each
// item can be Unstaged (held) / Staged, or Reverted (removed from the queue AND
// its web-chat artifact). Push flushes the staged items into one wake.
//
// The queue is NOT carried on the WS hello/reset (that frame's shape is golden-
// pinned), so we hydrate once via GET and stay live off the frames.
//
// The queue stays this module's: the chat chrome's chips, trays and phone Tasks
// (chat-present.js) read it through queueSnapshot(), and every render() ends by
// announcing the new snapshot on the chrome bus as `queue` — so the rail, the
// `queue N` chip and the phone's Queue count the same items, from one list.
//
// COMPOSER MESSAGES (design spec §6.1-§6.6, U62). A message is a queue item of
// kind 'message', and this module is the chrome's ONE send path for it:
//
//   sendMessage({text, skill, files, conversation_id, send}) → POST /api/queue/message
//   editMessage(id, {text, skill?, files?})                 → PATCH /api/queue/:id
//   sendNow(id)                                             → POST /api/queue/push {ids: [id]}
//   recallPending(parkId)                                   → POST /api/queue/pending/recall {id}
//
// Each answers the daemon's parsed body ({ok: true, …} or a refusal {ok: false,
// refused, hint, …}) and never throws: a network failure answers refused
// 'network'. A message's TEXT never rides a frame (§6.1): a frame that touches a
// message schedules one coalesced hydrateQueue(), and the GET serves the text
// at `read` and above (below, `text_hidden`). The receipts (§6.6) fold from the
// GET's `receipts` and the `receipt` frames. queueSnapshot().messages is THE
// pending list the rail, the trays and the composer's bubbles all read: the
// queued and held messages, and every message whose receipt is not yet
// confirmed (a confirmed one stays, saying so, until the next hydrate or
// CONFIRMED_HOLD_MS, whichever is first).
import { $ } from './state.js';
import { isCommentAnswered } from './comments.js';
import { deviceKind } from './viewport.js';
import { bus } from './bus.js';
import { mirror } from './chat-state.js';

let items = [];
const isStaged = (it) => it.staged !== false; // default staged; held is explicit
const isMessage = (it) => !!it && it.kind === 'message';
// A message the user typed, as against a stop request (§6.9: a message item too,
// with no text, sent at once). Take back and the pending list count these.
const isTypedMessage = (it) => isMessage(it) && it.source !== 'task-stop';

/* ---------- the pending messages: receipts and what is known of each ---------- */
export const MESSAGE_CACHE_MAX = 50;      // as the daemon's state.messageReceipts is
export const CONFIRMED_HOLD_MS = 10000;   // how long a confirmed message still says so
const RECEIPT_STATES = ['queued', 'sending', 'sent', 'parked', 'handed_over', 'unconfirmed', 'failed', 'confirmed'];
// msg_id → {state, at}: the GET's `receipts`, then the `receipt` frames.
let receipts = new Map();
// msg_id → when this page saw it turn confirmed (its 'Received' hold).
const confirmedAt = new Map();
// msg_id → the last known fields of a message, text included when this page
// was allowed to read it: what a message that left the queue still shows.
// Bounded like the daemon's receipts; `local` is the state a send's own answer
// gave (wake → sending, parked → parked) until a receipt says more.
const known = new Map();

function remember(msgId, fields) {
  if (typeof msgId !== 'string' || !msgId) return;
  const prev = known.get(msgId);
  const next = { ...(prev || {}), ...fields };
  if (prev) known.delete(msgId);   // re-inserted: the newest last
  known.set(msgId, next);
  while (known.size > MESSAGE_CACHE_MAX) known.delete(known.keys().next().value);
}

// The fields a message item tells about itself, its text only when it has one.
function fieldsOf(it) {
  const f = {
    id: it.id, msg_id: it.msg_id, chars: Number.isFinite(it.chars) ? it.chars : null,
    skill_name: it.skill && typeof it.skill.name === 'string' ? it.skill.name : null,
    files_count: Array.isArray(it.files) ? it.files.length : (Number.isFinite(it.files_count) ? it.files_count : 0),
    conversation_id: it.conversation_id || null, device: it.device || null,
    autosend: it.autosend === true, enqueued_at: it.enqueued_at || 0, source: it.source || null,
  };
  if (typeof it.text === 'string' && it.text_hidden !== true) f.text = it.text;
  return f;
}
const learn = (it) => { if (isMessage(it) && it.msg_id) remember(it.msg_id, fieldsOf(it)); };

// The in-flight push awaiting a delivery ack (see watchAck). A live wake is only
// "sent" once the bridge acks it back as a `wake-ack` frame; until then the rail
// shows "Sending…", and if the ack never comes it flips to a rejection the user
// can retry. `null` when nothing is in flight.
let pendingPush = null;
const ACK_TIMEOUT_MS = 6000; // how long the rail waits for a delivery ack before rejecting
// Acks that arrived BEFORE their watch was armed. The `wake-ack` WS frame can beat
// the push's HTTP response (the bridge acks in ms), so an ack may land before
// watchAck runs — we remember its seq here so the imminent watchAck resolves
// immediately instead of falsely timing out. Bounded; monotonic seqs.
const recentAcks = new Set();

const railEl = () => $('queue-rail');
const q = (sel) => { const r = railEl(); return r ? r.querySelector(sel) : null; };

// Reveal the rail. Every push confirmation, rejection and recovery button lives
// INSIDE .rail-expanded, which is invisible (and pointer-events:none) while the
// rail is collapsed — so pressing P with a collapsed rail used to post the whole
// feedback conversation somewhere the user could not see or click. The rail's
// open/pinned state is owned by shell.js; it registers its opener here at boot so
// this module can demand visibility without importing back into shell (cycle).
let openRail = () => {};
export function setRailOpener(fn) { if (typeof fn === 'function') openRail = fn; }

// Fetch the authoritative queue snapshot and RECONCILE it against the local
// mirror rather than overwriting. Run on init AND on every (re)connect: the GET
// is authoritative for the server's current ids (so items the client missed
// while disconnected appear, and items removed server-side while disconnected
// disappear), while any frame-added item the snapshot predates is preserved.
export async function hydrateQueue() {
  let fetched;
  let served = null;
  try {
    const r = await fetch('/api/queue').then((x) => x.json());
    fetched = Array.isArray(r.items) ? r.items : [];
    if (Array.isArray(r.receipts)) served = r.receipts;
  } catch { return; } // leave the mirror as-is on a failed fetch
  if (served) {
    // The daemon's receipts are the truth (never persisted: after its restart
    // a message it no longer tracks is unknown here too, not lost).
    receipts = new Map();
    for (const rec of served) {
      if (rec && typeof rec.msg_id === 'string' && RECEIPT_STATES.includes(rec.state)) {
        receipts.set(rec.msg_id, { state: rec.state, at: rec.at || 0 });
      }
    }
    for (const [id, k] of known) {
      if (k.local && !receipts.has(id)) known.set(id, { ...k, local: null });
      if (receipts.has(id) && receipts.get(id).state === 'confirmed') known.delete(id);
    }
  }
  // A confirmed message said 'Received' until this refresh (§7.10).
  confirmedAt.clear();
  const serverIds = new Set(fetched.map((it) => it.id));
  const byId = new Map();
  for (const it of fetched) byId.set(it.id, it);
  // Keep local items the snapshot didn't return only if they're NEWER than the
  // snapshot's newest (i.e. arrived via a frame during/after the fetch) — an
  // older local item absent from the server was genuinely removed.
  const newestServerSeq = fetched.reduce((m, it) => Math.max(m, it.enqueued_at || 0), 0);
  for (const it of items) {
    if (!serverIds.has(it.id) && (it.enqueued_at || 0) > newestServerSeq) byId.set(it.id, it);
  }
  items = [...byId.values()].sort((a, b) => (a.enqueued_at || 0) - (b.enqueued_at || 0));
  for (const it of items) learn(it);
  render();
}

// One GET for a burst of frames that touch messages: a frame never carries a
// message's text (§6.1), so the rail reads it again. A hydrate already in
// flight may predate the change, so one more follows it.
let hydrateTimer = null;
let hydrating = null;
let hydrateAgain = false;
function scheduleHydrate() {
  if (hydrateTimer !== null) return;
  if (hydrating) { hydrateAgain = true; return; }
  hydrateTimer = setTimeout(() => {
    hydrateTimer = null;
    hydrating = hydrateQueue().finally(() => {
      hydrating = null;
      if (hydrateAgain) { hydrateAgain = false; scheduleHydrate(); }
    });
  }, 0);
}

export async function initQueue() {
  const push = q('.rail-push');
  if (push) push.addEventListener('click', pushQueue);
  const add = q('.rail-add');
  if (add) {
    add.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pushQueue(); } });
    // Toggle the Push button live as the comment is typed/cleared.
    add.addEventListener('input', updatePushLabel);
  }
  const cancel = q('.rp-cancel');
  if (cancel) cancel.addEventListener('click', cancelPending);
  await hydrateQueue();
  await refreshPending();
  // The park is consumed by the turn-begin hook on the user's next message — an
  // event the browser never sees — so the standing indicator has to poll to learn
  // it's gone. Same cadence as the wake panel; the endpoint is a field read.
  setInterval(refreshPending, 5000);
}

/* ---------- standing parked-delivery indicator ---------- */
// A parked push is durable server state: it sits in state.pendingWake until the
// user's next message delivers it. The moment-of-push confirmation is transient
// by design, which left the user with a delivery pending and nothing on screen
// saying so — and no way to take it back. This mirrors GET /api/queue/pending.
let pendingId = null;
// The park itself, so render() can list WHAT is waiting rather than only that
// something is. The endpoint returns the wake envelope (summary only, by
// contract), which is exactly the granularity a rail row shows.
let parked = null;
export async function refreshPending() {
  const rail = railEl();
  if (!rail) return;
  let pending = null;
  try { pending = (await fetch('/api/queue/pending').then((r) => r.json())).pending || null; } catch { return; }
  pendingId = pending ? pending.id : null;
  parked = pending;
  const box = rail.querySelector('.rail-pending');
  rail.classList.toggle('has-pending', !!pending);
  // The narrow bottom bar's counterpart of the collapsed rail's ⇢ (the rail is
  // hidden below 760px): Queue [n] counts queued items only, and a parked push
  // has already left them, so without this a phone read 'Queue 0' while a
  // delivery waited on the next message.
  const bb = $('bb-queue');
  if (bb) {
    bb.classList.toggle('has-pending', !!pending);
    bb.setAttribute('aria-label', pending ? 'Queue to Claude — a push is parked; it delivers with your next message' : 'Queue to Claude');
  }
  render(); // the held batch is part of the item list, not just a badge
  if (!box) return;
  box.classList.toggle('hidden', !pending);
  if (!pending) return;
  const txt = box.querySelector('.rp-text');
  if (txt) txt.textContent = `⇢ Parked: ${parkedWhat(pending)} deliver with your next message.`;
  // A park that holds the user's words offers Take back in place of Cancel,
  // which would discard them (ruling C1 a); a park without one keeps Cancel.
  const words = parkHoldsMessage(pending);
  const cancel = box.querySelector('.rp-cancel');
  if (cancel) cancel.hidden = words;
  let back = box.querySelector('.rp-takeback');
  if (words && !back) {
    back = document.createElement('button');
    back.type = 'button';
    back.className = 'rp-takeback';
    back.textContent = 'Take back';
    back.title = 'return the message to the queue — anything else parked still delivers';
    back.addEventListener('click', takeBack);
    (cancel || txt || box).insertAdjacentElement(cancel || txt ? 'afterend' : 'beforeend', back);
  }
  if (back) back.hidden = !words;
}

// What the park holds, counted: the user's messages, stop requests, then the
// rest as signals ('1 message, 2 signals'). A park of signals alone reads as it
// always has ('2 signals').
function parkedWhat(pending) {
  const rows = (pending && Array.isArray(pending.items)) ? pending.items : [];
  const msgs = rows.filter(isTypedMessage).length;
  const stops = rows.filter((it) => isMessage(it) && !isTypedMessage(it)).length;
  const signals = Math.max(0, parkedCount(pending) - msgs - stops);
  const parts = [];
  if (msgs) parts.push(msgs === 1 ? '1 message' : `${msgs} messages`);
  if (stops) parts.push(stops === 1 ? '1 stop request' : `${stops} stop requests`);
  if (signals || !parts.length) parts.push(signals === 1 ? '1 signal' : `${signals} signals`);
  return parts.join(', ');
}
const parkHoldsMessage = (pending) => !!pending && Array.isArray(pending.items) && pending.items.some(isTypedMessage);

// Take back (§6.3, ruling C1 a): the park's messages return to the queue,
// staged with autosend off; its stop requests and signals stay parked, and the
// rail then shows what is left, with Cancel.
async function takeBack() {
  if (!pendingId) return;
  const r = await recallPending(pendingId);
  if (!r.ok) {
    const el = railBanner('rail-error');
    if (el) { el.setAttribute('role', 'alert'); el.textContent = r.hint || 'Take back failed — try again.'; }
  }
  await hydrateQueue();
  await refreshPending();
}

/* ---------- the held batch, itemised ---------- */
// How many signals the park holds. `meta.count` is authoritative (the envelope
// caps its printed lines at 50 for a large batch); the items are the fallback.
function parkedMetaCount(pending) {
  const meta = (pending && pending.envelope && pending.envelope.meta) || {};
  const n = Number(meta.count);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function parkedCount(pending) {
  return parkedMetaCount(pending) || parkedRows(pending).length;
}
// What the park holds, item by item. The daemon serves it as `items` —
// `pendingWake.batch` reduced to the summary-only fields the rail renders, which
// is the same shape a queued item has. This used to be reconstructed by
// regex-parsing `envelope.content`: prose that lib/channel/envelope.js writes for
// CLAUDE (a header line, `- [kind] summary` bullets, an optional user note, an
// optional "N earlier signals omitted"), with the structured batch stripped from
// the response. That made the rail's rendering an implicit contract across three
// modules, silently broken by any rewording — a different bullet, a summary
// containing a newline, the 50-line cap.
//
// The fallback is now a COUNT, not a second parser: an envelope without items
// says how many are waiting rather than pretending to itemise them.
function parkedRows(pending) {
  const items = pending && pending.items;
  if (Array.isArray(items) && items.length) return items.slice();  // copied: render() unshifts the note
  const n = parkedMetaCount(pending);
  return n > 0 ? [{ kind: 'signal', summary: `${n} signal${n === 1 ? '' : 's'} awaiting delivery` }] : [];
}
// Take the park back. /api/queue/pending/consume is the same id-checked drain the
// turn-begin hook uses, so cancelling is exactly "consume it and deliver nothing".
async function cancelPending() {
  if (!pendingId) return;
  try {
    await fetch('/api/queue/pending/consume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: pendingId }),
    });
  } catch {}
  await refreshPending();
}

// Fold a `queue` WS frame (op add|update|remove|clear) into the local mirror.
// Called from the ws.js handler map.
// A frame that touches a message item schedules one hydrateQueue(): the frame
// never carries its text (§6.1). `receipt` {msg_id, state, at} moves a
// message's receipt (§6.6).
export function foldQueueFrame(msg) {
  if (msg.op === 'add' && msg.item) {
    if (!items.some((x) => x.id === msg.item.id)) items.push(msg.item);
    if (isMessage(msg.item)) { learn(msg.item); scheduleHydrate(); }
  } else if (msg.op === 'update') {
    const it = items.find((x) => x.id === msg.id);
    if (!it) return;
    it.staged = msg.staged !== false;
    if (isMessage(it) || isMessage(msg.item)) {
      // A message's update carries its public fields (chars, the skill's
      // name, waiting, …), never its text: fold them, keep the text this page
      // read, and read the queue again for the new one.
      if (msg.item) {
        const { skill, files_count: filesCount, text: _never, ...rest } = msg.item;
        Object.assign(it, rest);
        if (!it.skill || !skill || it.skill.name !== skill.name) it.skill = skill || null;
        if (Number.isFinite(filesCount)) {
          if (Array.isArray(it.files) && it.files.length !== filesCount) delete it.files;
          it.files_count = filesCount;
        }
      }
      learn(it);
      scheduleHydrate();
    } else if (msg.item) {
      // F9: a summary refresh (a queued comment's text was edited) rides the update
      // frame as a rebuilt item — reflect it so the rail row isn't stale.
      it.summary = msg.item.summary; it.why_wake = msg.item.why_wake;
    }
  } else if (msg.op === 'remove') {
    // C4: a remove frame carries `ids` (the batched flush + single removes alike);
    // `id` is a back-compat alias for a single-id removal.
    const ids = Array.isArray(msg.ids) ? msg.ids : (msg.id != null ? [msg.id] : []);
    if (!ids.length) return;
    const drop = new Set(ids);
    const gone = items.filter((x) => drop.has(x.id) && isMessage(x));
    // Removed, not delivered: the daemon drops its receipt, so the message
    // leaves the pending list too. A flush keeps it: its receipt moves on.
    if (msg.reason !== 'flushed') for (const it of gone) { known.delete(it.msg_id); receipts.delete(it.msg_id); }
    items = items.filter((x) => !drop.has(x.id));
    if (gone.length) scheduleHydrate();
  } else if (msg.op === 'clear') {
    items = [];
  } else if (msg.op === 'receipt') {
    if (typeof msg.msg_id !== 'string' || !RECEIPT_STATES.includes(msg.state)) return;
    receipts.set(msg.msg_id, { state: msg.state, at: msg.at || Date.now() });
    if (msg.state === 'confirmed') confirmedAt.set(msg.msg_id, Date.now());
  } else {
    return;
  }
  render();
}

// P / Push button. Flushes the STAGED items → one wake (held items stay), sending
// the comment field as `note`. Proceeds when there's a staged item OR a non-empty
// comment: a comment alone is a deliberate note-only wake. Guards on the STAGED
// count so the P shortcut can't push an all-held, comment-less queue.
export async function pushQueue() {
  const add = q('.rail-add');
  const note = ((add && add.value) || '').trim();
  // Nothing to send. This used to be a silent `return`: pressing P with an empty
  // queue did and said nothing, which reads as "the key is broken". Say so instead.
  if (!items.some(isStaged) && !note) { showNothingToPush(); return; }
  openRail(); // the confirmation/rejection conversation below must be visible
  clearRailBanners(); // a new push resets the whole feedback state, not just errors
  { const held = q('.rail-held-msgs'); if (held) held.remove(); } // outlives an ack, not a new push
  // F6: don't drop the staged rows or clear the note until the POST confirms — a
  // failed push (daemon mid-restart) must lose neither the batch nor the typed note.
  let ok = false;
  let result = null;
  try {
    const r = await fetch('/api/queue/push', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note, device: deviceKind() }),
    });
    ok = r.ok;
    if (ok) { try { result = await r.json(); } catch {} }
  } catch {}
  if (!ok) { showPushError(); return; } // keep note + rows; surface a visible rail error
  // Confirmed AT THE HTTP LAYER: clear the note and drop the staged rows; held
  // ones survive. The server also emits ONE batched `queue` remove frame (C4).
  if (add) add.value = '';
  // Messages the push left queued (a viewer below `full`: `held_messages`; one
  // the park had no room for: `waiting_ids`) stay on the rail.
  const heldMsgs = result && Number.isFinite(result.held_messages) ? result.held_messages : 0;
  const waiting = new Set(result && Array.isArray(result.waiting_ids) ? result.waiting_ids : []);
  items = items.filter((x) => !isStaged(x) || (isMessage(x) && (heldMsgs > 0 || waiting.has(x.id))));
  render();
  if (heldMsgs > 0 || waiting.size) scheduleHydrate();
  if (result && result.mode === 'parked') {
    // No live channel — held and delivered on the user's NEXT message. Reliable;
    // no ack to await. Copy is server-sent (result.delivers).
    showParkedNote(result.delivers);
    refreshPending(); // and raise the STANDING indicator, which outlives the note
  } else if (result && result.mode === 'wake' && result.seq != null) {
    // A live wake was fired — but HTTP 200 only means the daemon emitted it, NOT
    // that it reached Claude. Await the bridge's delivery ack; reject on timeout.
    watchAck(result.seq);
  }
  if (heldMsgs > 0) showHeldMessages(heldMsgs);
}

// A Push from a viewer below `full` sends the staged signals and leaves every
// message queued (§6.3): say so, until the next push.
function showHeldMessages(n) {
  const el = railBanner('rail-held-msgs');
  if (!el) return;
  el.textContent = `${n === 1 ? '1 message stays' : `${n} messages stay`} queued: sending a message from this page needs full access`;
}

// Arm the delivery-confirmation watch for a live wake `seq`. Shows a transient
// "Sending…" state; a matching `wake-ack` frame (onWakeAck) confirms it, and if
// none arrives within ACK_TIMEOUT_MS the push is REJECTED with retry/hold actions.
function watchAck(seq) {
  clearAckWatch();
  clearRailBanners();
  // The ack may have already arrived (WS beat the HTTP response) — resolve now.
  if (recentAcks.has(seq)) { recentAcks.delete(seq); showDelivered(); return; }
  pendingPush = { seq, timer: null };
  showSending();
  pendingPush.timer = setTimeout(() => {
    if (pendingPush) pendingPush.timer = null;
    showPushRejected(seq);
  }, ACK_TIMEOUT_MS);
}
function clearAckWatch() {
  if (pendingPush && pendingPush.timer) clearTimeout(pendingPush.timer);
  pendingPush = null;
}

// A `wake-ack` frame arrived — the bridge confirms the wake reached Claude.
// Resolve the matching in-flight watch into a brief "Delivered" confirmation.
// Ignores acks for a superseded/absent push (stale seq).
export function onWakeAck(seq) {
  if (pendingPush && pendingPush.seq === seq) {
    clearAckWatch();
    clearRailBanners();
    showDelivered();
    return;
  }
  // Arrived before watchAck armed — stash it so the imminent watch resolves at once.
  recentAcks.add(seq);
  if (recentAcks.size > 64) recentAcks.delete(recentAcks.values().next().value);
}

// transient confirmation that a Push was PARKED (delivered with the next
// message) rather than woken live. Mirrors the .rail-notice styling; auto-clears.
function showParkedNote(text) {
  clearPushError();
  const note = railBanner('rail-parked'); // railBanner reveals the rail (see above)
  if (!note) return;
  note.textContent = text || 'Pushed — delivers with your next message.';
  clearTimeout(showParkedNote._t);
  showParkedNote._t = setTimeout(() => { const n = railEl() && railEl().querySelector('.rail-parked'); if (n) n.remove(); }, 6000);
}

// Insert a transient banner just above the Push button, replacing any existing
// one of the same class. Returns the element so callers can fill it in.
function railBanner(cls) {
  const rail = railEl();
  if (!rail) return null;
  // Every banner is push feedback, and every one of them is inside the expanded
  // rail — so raising one is also a demand that the rail be on screen.
  openRail();
  let el = rail.querySelector('.' + cls);
  if (!el) {
    el = document.createElement('div');
    el.className = cls;
    el.setAttribute('role', 'status');
    const push = rail.querySelector('.rail-push');
    if (push) push.insertAdjacentElement('beforebegin', el); else rail.appendChild(el);
  }
  return el;
}
// Clear every transient push banner + its timer — called whenever the push state
// transitions (new push, ack, rejection) so stale banners never stack.
function clearRailBanners() {
  clearTimeout(showParkedNote._t);
  clearTimeout(showDelivered._t);
  clearTimeout(showNothingToPush._t);
  for (const cls of ['rail-sending', 'rail-parked', 'rail-error', 'rail-nothing']) {
    const el = q('.' + cls);
    if (el) el.remove();
  }
}

// P with an empty queue and no note. Not an error — just says why nothing happened.
function showNothingToPush() {
  clearRailBanners();
  const el = railBanner('rail-nothing');
  if (!el) return;
  el.textContent = 'Nothing to push yet — captures, pane signals and comments collect here first.';
  clearTimeout(showNothingToPush._t);
  showNothingToPush._t = setTimeout(() => { const n = q('.rail-nothing'); if (n) n.remove(); }, 4000);
}

// "Sending…" — a live wake was fired and we're awaiting the bridge's delivery ack.
function showSending() {
  const el = railBanner('rail-sending');
  if (el) el.textContent = 'Sending to Claude…';
}
// "Delivered" — the ack arrived; the wake reached Claude. Brief, auto-clears.
function showDelivered() {
  const el = railBanner('rail-parked');
  if (!el) return;
  el.textContent = 'Delivered to Claude ✓';
  clearTimeout(showDelivered._t);
  showDelivered._t = setTimeout(() => { const n = q('.rail-parked'); if (n) n.remove(); }, 3000);
}

// The rejection the whole mechanism exists for: no ack came back, so the wake
// likely never reached Claude. The batch is RETAINED server-side (pendingAck) —
// Retry re-fires it, Hold converts it to a parked wake delivered on the next
// message. `seq` correlates the retained batch.
function showPushRejected(seq) {
  const el = railBanner('rail-error');
  if (!el) return;
  el.setAttribute('role', 'alert');
  el.textContent = '';
  const msg = document.createElement('div');
  msg.className = 'rail-error-msg';
  msg.textContent = "This didn't reach Claude. Your batch is kept — try again.";
  const actions = document.createElement('div');
  actions.className = 'rail-error-actions';
  const retry = document.createElement('button');
  retry.className = 'rail-retry';
  retry.textContent = 'Retry';
  retry.addEventListener('click', () => repush(seq, false));
  const hold = document.createElement('button');
  hold.className = 'rail-hold';
  hold.textContent = 'Hold for next message';
  hold.addEventListener('click', () => repush(seq, true));
  actions.append(retry, hold);
  el.append(msg, actions);
}

// Recovery — ask the server to re-deliver the retained in-flight batch. `park`
// true holds it for the next message (the reliable fallback); false re-fires a
// live wake and re-arms the ack watch on the new seq.
async function repush(seq, park) {
  clearRailBanners();
  let result = null, ok = false;
  try {
    const r = await fetch('/api/queue/repush', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seq, park, device: deviceKind() }),
    });
    ok = r.ok;
    if (ok) { try { result = await r.json(); } catch {} }
  } catch {}
  if (!ok) { showPushRejected(seq); return; } // still stuck — keep the rejection actionable
  if (result && result.mode === 'parked') showParkedNote(result.delivers);
  else if (result && result.mode === 'wake' && result.seq != null) watchAck(result.seq);
}

// F6: a visible rail error state (mirrors .rail-notice styling, coral) when a push
// fails, so the kept batch/note aren't a silent mystery. Cleared on the next push.
function showPushError() {
  const err = railBanner('rail-error'); // railBanner reveals the rail (see above)
  if (!err) return;
  err.setAttribute('role', 'alert');
  err.textContent = 'Push failed — your batch and note are kept. Try again.';
}
function clearPushError() {
  const err = q('.rail-error');
  if (err) err.remove();
}

// Re-render the rail from the current mirror. Called by ws.js on a `comments`
// frame so a queued comment's dot flips coral→green live the moment Claude replies
// (B4 — the answered state is derived from the comments cache at render time).
export function renderQueue() { render(); }

// Unstage (hold) / stage an item — persisted server-side so it stays held across
// reconnect. Optimistic; the server confirms with an `update` frame. The rail's
// −/+ and the queue tray's Hold / Stage both go through here.
export async function setStaged(id, staged) {
  const it = items.find((x) => x.id === id);
  if (it) { it.staged = staged; render(); }
  try {
    await fetch('/api/queue/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staged }),
    });
  } catch {}
}

// Revert — remove the item from the queue AND undo its web-chat artifact: a
// comment's pin is deleted, a capture's pane is dropped, and an activity/signal
// item's interaction is undone (form values and the signal key go back; the pane,
// which Claude or a driver rendered, stays). ?revert=1 drives the server side.
async function revertItem(id) {
  items = items.filter((x) => x.id !== id);
  render();
  try { await fetch('/api/queue/' + encodeURIComponent(id) + '?revert=1', { method: 'DELETE' }); } catch {}
}

// Remove — the item leaves the queue and NOTHING else changes: the queue tray's
// Remove (design spec §7.6). Revert above stays the rail's ⟲. Optimistic like
// the rail's own buttons; a refusal (a remote viewer below `full` removing a
// message) re-reads the queue, so the item comes back rather than vanishing
// here while the daemon keeps it. Answers whether the daemon removed it.
export async function removeItem(id) {
  items = items.filter((x) => x.id !== id);
  render();
  let ok = false;
  try { ok = (await fetch('/api/queue/' + encodeURIComponent(id), { method: 'DELETE' })).ok === true; } catch {}
  if (!ok) await hydrateQueue();
  return ok;
}

// What the chat chrome reads of the queue: the items in rail order (each a
// frozen copy, `staged` made explicit), the counts the rail shows, and the
// parked push, if one waits for the next message.
export function queueSnapshot() {
  const list = items.map((it) => Object.freeze({ ...it, staged: isStaged(it) }));
  const staged = list.filter((it) => it.staged).length;
  return Object.freeze({
    items: Object.freeze(list),
    count: list.length,
    staged,
    held: list.length - staged,
    parked: parked ? Object.freeze({ id: parked.id || null, count: parkedCount(parked) }) : null,
    messages: pendingMessages(),
  });
}

// The conversation a message's place is counted in: null is the primary's.
const convKey = (cid) => cid || (mirror && mirror.serverPrimary) || null;
const confirmedShown = (msgId, now) => confirmedAt.has(msgId) && now - confirmedAt.get(msgId) < CONFIRMED_HOLD_MS;

// THE pending list (§7.10): the queued and held messages, then every message
// that has left the queue and is not yet confirmed (a confirmed one for its
// hold), oldest first. `position` numbers the queued autosend messages of one
// conversation from 1 (§6.4's order); a held one has none. A stop request is
// not the user's words and is not listed; a message this page knows nothing of
// but a receipt (after a reload) is not listed either.
function pendingMessages() {
  const now = Date.now();
  const out = [];
  const inQueue = new Set();
  for (const it of items) {
    if (!isTypedMessage(it) || !it.msg_id) continue;
    inQueue.add(it.msg_id);
    const f = { ...(known.get(it.msg_id) || {}), ...fieldsOf(it) };
    if (it.text_hidden === true) delete f.text;
    const rec = receipts.get(it.msg_id);
    out.push({ ...f, state: isStaged(it) ? 'queued' : 'held', at: (rec && rec.at) || it.enqueued_at || 0 });
  }
  for (const [msgId, k] of known) {
    if (inQueue.has(msgId) || k.source === 'task-stop') continue;
    const rec = receipts.get(msgId);
    const state = rec ? rec.state : k.local;
    if (!state) continue;
    if (state === 'confirmed' && !confirmedShown(msgId, now)) continue;
    out.push({ ...k, state, at: (rec && rec.at) || k.enqueued_at || 0 });
  }
  out.sort((a, b) => (a.enqueued_at || 0) - (b.enqueued_at || 0));
  const places = new Map();
  return Object.freeze(out.map((m) => {
    let position = null;
    if (m.state === 'queued' && m.autosend) {
      const key = convKey(m.conversation_id);
      position = (places.get(key) || 0) + 1;
      places.set(key, position);
    }
    const e = {
      id: m.id || null, msg_id: m.msg_id, state: m.state, at: m.at, chars: Number.isFinite(m.chars) ? m.chars : null,
      files_count: m.files_count || 0, conversation_id: m.conversation_id || null, device: m.device || null,
      autosend: m.autosend === true, position,
    };
    if (typeof m.text === 'string') e.text = m.text;
    if (m.skill_name) e.skill_name = m.skill_name;
    return Object.freeze(e);
  }));
}

/* ---------- the one send path (§6.3) ---------- */
// Every request answers the parsed body and never throws. An answer that is
// not ok and names no `refused` (a 403 below `full`, a 415) gets one, so a
// caller reads `refused` and `hint` alike.
const NETWORK_HINT = 'The daemon did not answer — check that web-chat is running, then try again.';
async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, refused: 'network', hint: NETWORK_HINT };
  }
  let out = null;
  try { out = await res.json(); } catch { out = null; }
  if (!out || typeof out !== 'object') {
    return res.ok ? { ok: true } : { ok: false, refused: 'network', hint: NETWORK_HINT, status: res.status };
  }
  if (out.ok !== true && typeof out.refused !== 'string') {
    return { ...out, ok: false, refused: res.status === 403 ? 'forbidden' : (out.code || 'error'),
      hint: out.hint || out.error || NETWORK_HINT, status: res.status };
  }
  return out;
}

// A composer message: POST /api/queue/message. `send` is 'auto' (when Claude
// is free), 'now' or 'hold'. A message the daemon delivered or parked at once
// never sits in the queue, so the pending list keeps the words sent here.
export async function sendMessage({ text, skill, files, conversation_id: conversationId, send = 'auto' } = {}) {
  const body = { text, files, conversation_id: conversationId, send, device: deviceKind() };
  if (skill !== undefined) body.skill = skill;
  const r = await request('POST', '/api/queue/message', body);
  if (r.ok === true && typeof r.msg_id === 'string') {
    const local = r.mode === 'wake' || r.mode === 'transported' ? 'sending' : r.mode === 'parked' ? 'parked' : null;
    const prev = known.get(r.msg_id) || {};
    const fields = {
      id: r.id || prev.id || null, msg_id: r.msg_id,
      chars: Number.isFinite(prev.chars) ? prev.chars : (typeof text === 'string' ? text.length : 0),
      skill_name: prev.skill_name || (skill && typeof skill.name === 'string' ? skill.name : null),
      files_count: prev.files_count || (Array.isArray(files) ? files.length : 0),
      conversation_id: conversationId || null, device: deviceKind(), autosend: send === 'auto',
      enqueued_at: prev.enqueued_at || Date.now(), source: 'composer',
    };
    if (typeof text === 'string') fields.text = text;
    if (local) fields.local = local;
    remember(r.msg_id, fields);
    render();
  }
  return r;
}

// Edit a queued or held message: PATCH /api/queue/:id with the fields given.
export async function editMessage(id, { text, skill, files } = {}) {
  const body = {};
  if (text !== undefined) body.text = text;
  if (skill !== undefined) body.skill = skill;
  if (files !== undefined) body.files = files;
  return request('PATCH', '/api/queue/' + encodeURIComponent(id), body);
}

// Send now: release this one message whatever Claude is doing (§6.4).
export async function sendNow(id) {
  return request('POST', '/api/queue/push', { ids: [id], device: deviceKind() });
}

// Take back a park's messages (the rail's Take back).
export async function recallPending(parkId) {
  return request('POST', '/api/queue/pending/recall', { id: parkId });
}

// One row builder for both lists. A PARKED row is the read-only variant: that
// batch has already left the queue, so there is nothing to stage or revert —
// cancelling the whole delivery is the one action, and it lives on .rail-pending
// above. It used to be a second, thinner copy of this function, which is why a
// parked row dropped the source and why-wake lines a staged one shows.
// What ⟲ actually does, per kind (lib/server/domain/queue revertArtifact). Only a
// capture's own pane is ever removed — never promise that for anything else.
function revertTitle(kind) {
  if (kind === 'message') return 'remove — take this message out of the queue (nothing else changes)';
  if (kind === 'comment') return 'revert — remove from queue and delete this comment pin';
  if (kind === 'capture') return 'revert — remove from queue and drop the captured pane';
  return 'revert — remove from queue and undo this interaction (the pane stays)';
}

function itemRow(it, { parked = false } = {}) {
  const row = document.createElement('div');
  const staged = !parked && isStaged(it);
  row.className = parked ? 'rail-item parked' : ('rail-item' + (staged ? '' : ' held'));
  if (it.id) row.dataset.id = it.id;

  const dot = document.createElement('span');
  // B4: a queued comment dot mirrors its marker — coral until Claude has replied,
  // then green. The item carries no answered flag, so derive from the comments cache.
  const answered = !parked && it.kind === 'comment' && (it.answered || isCommentAnswered(it.comment_id));
  dot.className = 'qi-dot qi-' + (it.kind || 'signal') + (answered ? ' answered' : '');

  const body = document.createElement('div');
  body.className = 'qi-body';
  const top = document.createElement('div');
  top.className = 'qi-top';
  const kindEl = document.createElement('span'); kindEl.className = 'qi-kind'; kindEl.textContent = it.kind || 'signal';
  const srcEl = document.createElement('span'); srcEl.className = 'qi-src'; srcEl.textContent = it.source || '';
  top.append(kindEl, srcEl);
  const why = document.createElement('div'); why.className = 'qi-why'; why.textContent = it.why_wake || '';
  const sum = document.createElement('div'); sum.className = 'qi-summary'; sum.textContent = it.summary || '';
  body.append(top, why, sum);
  if (!parked && isMessage(it)) messageBody(row, it, sum, body);
  if (parked) { row.append(dot, body); return row; }
  if (it.kind === 'signal' && it.signal_key) body.append(...peekControls(it));

  const stage = document.createElement('button');
  stage.className = 'qi-stage';
  stage.textContent = staged ? '−' : '+';
  stage.title = staged ? 'hold — keep for later' : 'stage — send with this push';
  stage.addEventListener('click', () => setStaged(it.id, !staged));

  const rev = document.createElement('button');
  rev.className = 'qi-revert'; rev.textContent = '⟲';
  rev.title = revertTitle(it.kind);
  // Revert on a message is a plain remove (§6.1): there is no artifact to undo.
  rev.addEventListener('click', () => (isMessage(it) ? removeItem(it.id) : revertItem(it.id)));

  row.append(dot, body, stage, rev);
  return row;
}

// A queued message's row: its text (read from GET /api/queue, never a frame),
// or — the text hidden from this viewer — its length; then the skill and the
// file count, and a wait the park imposes (§6.4).
function messageBody(row, it, sum, body) {
  row.classList.add('rail-msg');
  if (!isTypedMessage(it)) return;   // a stop request: its summary names the task id
  const f = fieldsOf(it);
  const k = known.get(it.msg_id);
  const text = typeof f.text === 'string' ? f.text
    : (it.text_hidden !== true && k && typeof k.text === 'string' ? k.text : null);
  if (text !== null) {
    sum.className = 'qi-summary qi-msg-text';
    sum.textContent = text;
  } else if (it.text_hidden === true) {
    const n = Number.isFinite(f.chars) ? f.chars : 0;
    sum.className = 'qi-summary qi-msg-hidden';
    sum.textContent = `message · ${n} ${n === 1 ? 'char' : 'chars'} (hidden from remote viewers of this project)`;
  }
  // Neither: a frame's item, its text on the way (the summary stands meanwhile).
  const bits = [];
  if (f.skill_name) bits.push(`/${f.skill_name}`);
  if (f.files_count) bits.push(f.files_count === 1 ? '1 file' : `${f.files_count} files`);
  if (it.waiting === 'parked_message') bits.push('waits: a message is already parked');
  if (!bits.length) return;
  const meta = document.createElement('div');
  meta.className = 'qi-msg-meta';
  meta.textContent = bits.join(' · ');
  body.append(meta);
}

/* ---------- a signal's value, on request ----------
   The item's summary carries the signal KEY only, by contract: that summary is
   what reaches Claude, and a value there could be anything a pane wrote. The
   user looking at the rail is another matter — "form_submit" says nothing about
   WHAT they are about to hand off. So a signal row can show its key's value, read
   when the user opens it (GET /api/store?keys=, the get_store read) and never
   copied into the item. Keyed by item id so an open peek survives the rail's
   re-renders; pruned in render() when its item leaves. */
const peeks = new Map(); // item id → { state: 'loading'|'ok'|'absent'|'err', text }
const PEEK_MAX = 600;    // characters of JSON shown; the store read is not capped

function formatPeek(v) {
  let text;
  try { text = JSON.stringify(v, null, 1); } catch { text = String(v); }
  if (text === undefined) text = String(v);
  return text.length > PEEK_MAX ? text.slice(0, PEEK_MAX) + '…' : text;
}

async function togglePeek(it) {
  if (peeks.has(it.id)) { peeks.delete(it.id); render(); return; }
  peeks.set(it.id, { state: 'loading', text: '' });
  render();
  let entry;
  try {
    const r = await fetch('/api/store?keys=' + encodeURIComponent(it.signal_key));
    const got = await r.json();
    entry = got && Object.hasOwn(got, it.signal_key)
      ? { state: 'ok', text: formatPeek(got[it.signal_key]) }
      : { state: 'absent', text: 'not set — the key is not in the store now' };
  } catch {
    entry = { state: 'err', text: 'could not read the store' };
  }
  if (!peeks.has(it.id)) return; // closed again while the read was in flight
  peeks.set(it.id, entry);
  render();
}

function peekControls(it) {
  const peek = peeks.get(it.id);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'qi-peek';
  btn.textContent = (peek ? '▾ ' : '▸ ') + 'value';
  btn.title = `show what ${it.signal_key} holds now (not sent to Claude)`;
  btn.setAttribute('aria-expanded', String(!!peek));
  btn.addEventListener('click', () => togglePeek(it));
  if (!peek) return [btn];
  const out = document.createElement('pre');
  out.className = 'qi-value' + (peek.state === 'ok' ? '' : ' ' + peek.state);
  out.textContent = peek.state === 'loading' ? 'reading…' : peek.text; // text, never markup
  return [btn, out];
}

function updatePushLabel() {
  const push = q('.rail-push');
  if (!push) return;
  const staged = items.filter(isStaged).length;
  const add = q('.rail-add');
  const hasNote = !!((add && add.value) || '').trim();
  // Enabled with a STAGED item OR a non-empty comment.
  push.disabled = staged === 0 && !hasNote;
  push.innerHTML = staged > 0
    ? `Push ${staged} → Claude <kbd>P</kbd>`
    : (hasNote ? `Send comment → Claude <kbd>P</kbd>` : `Push 0 → Claude <kbd>P</kbd>`);
}

function sectionHeader(label, n, cls) {
  const h = document.createElement('div');
  h.className = 'rail-sec ' + cls;
  const cap = document.createElement('span'); cap.className = 'rail-sec-cap'; cap.textContent = label;
  const cnt = document.createElement('span'); cnt.className = 'rail-sec-cnt'; cnt.textContent = String(n);
  h.append(cap, cnt);
  return h;
}

// Draw the rail, then tell the chrome the queue rendered (bus `queue`, with the
// snapshot) — whether or not there is a rail to draw into, so a chip never
// waits on the rail's markup.
function render() {
  const now = Date.now();
  for (const [id, t] of [...confirmedAt]) if (now - t >= CONFIRMED_HOLD_MS) confirmedAt.delete(id);
  drawRail();
  bus.emit('queue', queueSnapshot());
}

function drawRail() {
  const rail = railEl();
  if (!rail) return;
  const count = items.length;
  const staged = items.filter(isStaged);
  const held = items.filter((x) => !isStaged(x));
  for (const id of peeks.keys()) if (!items.some((x) => x.id === id)) peeks.delete(id);

  const countEl = rail.querySelector('.rail-count'); if (countEl) countEl.textContent = String(count);
  const badge = rail.querySelector('.rail-head .badge'); if (badge) badge.textContent = String(count);
  // …and the narrow bottom bar's Queue [n], which opens this rail as a full screen.
  const bb = $('bb-queue-count'); if (bb) bb.textContent = String(count);

  const chips = rail.querySelector('.rail-chips');
  if (chips) {
    chips.innerHTML = '';
    for (const it of items.slice(0, 6)) {
      const c = document.createElement('span');
      c.className = 'rail-chip qi-' + (it.kind || 'signal') + (isStaged(it) ? '' : ' held');
      chips.appendChild(c);
    }
  }

  // A parked push is real, durable server state (GET /api/queue/pending) that the
  // user's next message will deliver — so it belongs IN the item list, under its
  // own header, exactly the way staged and held items are shown. The transient
  // "delivers with your next message" note expires after 6s; this does not.
  const parkedList = parked ? parkedRows(parked) : [];

  const list = rail.querySelector('.rail-items');
  if (list) {
    list.innerHTML = '';
    if (!count && !parkedList.length) {
      const empty = document.createElement('div');
      empty.className = 'rail-empty';
      empty.textContent = 'No queued signals. Captures, pane signals, and pane activity collect here.';
      list.appendChild(empty);
    } else {
      if (count) {
        list.appendChild(sectionHeader('Staged', staged.length, 'staged'));
        for (const it of staged) list.appendChild(itemRow(it));
        if (held.length) {
          list.appendChild(sectionHeader('Held', held.length, 'held'));
          for (const it of held) list.appendChild(itemRow(it));
        }
      }
      if (parkedList.length) {
        list.appendChild(sectionHeader('Held for next prompt', parkedCount(parked), 'parked'));
        if (parked.note) parkedList.unshift({ kind: 'note', summary: parked.note });
        for (const it of parkedList) list.appendChild(itemRow(it, { parked: true }));
      }
    }
  }

  updatePushLabel();
}
