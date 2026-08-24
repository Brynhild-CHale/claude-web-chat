// The queue rail. Wake-worthy
// signals (captures, pane signals, comments) collect as server-side queue items;
// this reads GET /api/queue and folds the `queue` WS frames. The rail is split
// VSCode-git-style into STAGED (sent on the next Push) and HELD (kept back). Each
// item can be Unstaged (held) / Staged, or Reverted (removed from the queue AND
// its web-chat artifact). Push flushes the staged items into one wake.
//
// The queue is NOT carried on the WS hello/reset (that frame's shape is golden-
// pinned), so we hydrate once via GET and stay live off the frames.
import { $ } from './state.js';
import { isCommentAnswered } from './comments.js';

let items = [];
const isStaged = (it) => it.staged !== false; // default staged; held is explicit

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
  try {
    const r = await fetch('/api/queue').then((x) => x.json());
    fetched = Array.isArray(r.items) ? r.items : [];
  } catch { return; } // leave the mirror as-is on a failed fetch
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
  render();
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
export async function refreshPending() {
  const rail = railEl();
  if (!rail) return;
  let pending = null;
  try { pending = (await fetch('/api/queue/pending').then((r) => r.json())).pending || null; } catch { return; }
  pendingId = pending ? pending.id : null;
  const box = rail.querySelector('.rail-pending');
  rail.classList.toggle('has-pending', !!pending);
  if (!box) return;
  box.classList.toggle('hidden', !pending);
  if (!pending) return;
  const txt = box.querySelector('.rp-text');
  if (txt) {
    const n = Number((pending.envelope && pending.envelope.meta && pending.envelope.meta.count) || 0);
    const what = n === 1 ? '1 signal' : `${n} signals`;
    txt.textContent = `⇢ Parked: ${what} deliver with your next message.`;
  }
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
export function foldQueueFrame(msg) {
  if (msg.op === 'add' && msg.item) {
    if (!items.some((x) => x.id === msg.item.id)) items.push(msg.item);
  } else if (msg.op === 'update') {
    const it = items.find((x) => x.id === msg.id);
    if (!it) return;
    it.staged = msg.staged !== false;
    // F9: a summary refresh (a queued comment's text was edited) rides the update
    // frame as a rebuilt item — reflect it so the rail row isn't stale.
    if (msg.item) { it.summary = msg.item.summary; it.why_wake = msg.item.why_wake; }
  } else if (msg.op === 'remove') {
    // C4: a remove frame carries `ids` (the batched flush + single removes alike);
    // `id` is a back-compat alias for a single-id removal.
    const ids = Array.isArray(msg.ids) ? msg.ids : (msg.id != null ? [msg.id] : []);
    if (!ids.length) return;
    const drop = new Set(ids);
    items = items.filter((x) => !drop.has(x.id));
  } else if (msg.op === 'clear') {
    items = [];
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
  // F6: don't drop the staged rows or clear the note until the POST confirms — a
  // failed push (daemon mid-restart) must lose neither the batch nor the typed note.
  let ok = false;
  let result = null;
  try {
    const r = await fetch('/api/queue/push', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }),
    });
    ok = r.ok;
    if (ok) { try { result = await r.json(); } catch {} }
  } catch {}
  if (!ok) { showPushError(); return; } // keep note + rows; surface a visible rail error
  // Confirmed AT THE HTTP LAYER: clear the note and drop the staged rows; held
  // ones survive. The server also emits ONE batched `queue` remove frame (C4).
  if (add) add.value = '';
  items = items.filter((x) => !isStaged(x));
  render();
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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seq, park }),
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
// reconnect. Optimistic; the server confirms with an `update` frame.
async function setStaged(id, staged) {
  const it = items.find((x) => x.id === id);
  if (it) { it.staged = staged; render(); }
  try {
    await fetch('/api/queue/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staged }),
    });
  } catch {}
}

// Revert — remove the item from the queue AND its web-chat artifact (a comment's
// pin, a capture/signal's origin pane). ?revert=1 drives the server side.
async function revertItem(id) {
  items = items.filter((x) => x.id !== id);
  render();
  try { await fetch('/api/queue/' + encodeURIComponent(id) + '?revert=1', { method: 'DELETE' }); } catch {}
}

function itemRow(it) {
  const row = document.createElement('div');
  const staged = isStaged(it);
  row.className = 'rail-item' + (staged ? '' : ' held');
  row.dataset.id = it.id;

  const dot = document.createElement('span');
  // B4: a queued comment dot mirrors its marker — coral until Claude has replied,
  // then green. The item carries no answered flag, so derive from the comments cache.
  const answered = it.kind === 'comment' && (it.answered || isCommentAnswered(it.comment_id));
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

  const stage = document.createElement('button');
  stage.className = 'qi-stage';
  stage.textContent = staged ? '−' : '+';
  stage.title = staged ? 'hold back (unstage)' : 'stage for the next push';
  stage.addEventListener('click', () => setStaged(it.id, !staged));

  const rev = document.createElement('button');
  rev.className = 'qi-revert'; rev.textContent = '⟲';
  rev.title = 'revert — remove from queue and web-chat';
  rev.addEventListener('click', () => revertItem(it.id));

  row.append(dot, body, stage, rev);
  return row;
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

function render() {
  const rail = railEl();
  if (!rail) return;
  const count = items.length;
  const staged = items.filter(isStaged);
  const held = items.filter((x) => !isStaged(x));

  const countEl = rail.querySelector('.rail-count'); if (countEl) countEl.textContent = String(count);
  const badge = rail.querySelector('.rail-head .badge'); if (badge) badge.textContent = String(count);

  const chips = rail.querySelector('.rail-chips');
  if (chips) {
    chips.innerHTML = '';
    for (const it of items.slice(0, 6)) {
      const c = document.createElement('span');
      c.className = 'rail-chip qi-' + (it.kind || 'signal') + (isStaged(it) ? '' : ' held');
      chips.appendChild(c);
    }
  }

  const list = rail.querySelector('.rail-items');
  if (list) {
    list.innerHTML = '';
    if (!count) {
      const empty = document.createElement('div');
      empty.className = 'rail-empty';
      empty.textContent = 'No queued signals. Captures, pane signals, and pane activity collect here.';
      list.appendChild(empty);
    } else {
      list.appendChild(sectionHeader('Staged', staged.length, 'staged'));
      for (const it of staged) list.appendChild(itemRow(it));
      if (held.length) {
        list.appendChild(sectionHeader('Held', held.length, 'held'));
        for (const it of held) list.appendChild(itemRow(it));
      }
    }
  }

  updatePushLabel();
}
