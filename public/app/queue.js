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

const railEl = () => $('queue-rail');
const q = (sel) => { const r = railEl(); return r ? r.querySelector(sel) : null; };

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
  await hydrateQueue();
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
  if (!items.some(isStaged) && !note) return;
  // F6: don't drop the staged rows or clear the note until the POST confirms — a
  // failed push (daemon mid-restart) must lose neither the batch nor the typed note.
  clearPushError();
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
  // Confirmed: clear the note and drop the staged rows; held ones survive. The
  // server also emits ONE batched `queue` remove frame (C4) — belt-and-suspenders.
  if (add) add.value = '';
  items = items.filter((x) => !isStaged(x));
  render();
  // a parked push (no channel connected) is delivered on the user's NEXT
  // message, not woken now — say WHEN. The copy
  // is server-sent (result.delivers).
  if (result && result.mode === 'parked') showParkedNote(result.delivers);
}

// transient confirmation that a Push was PARKED (delivered with the next
// message) rather than woken live. Mirrors the .rail-notice styling; auto-clears.
function showParkedNote(text) {
  const rail = railEl();
  if (!rail) return;
  clearPushError();
  let note = rail.querySelector('.rail-parked');
  if (!note) {
    note = document.createElement('div');
    note.className = 'rail-parked';
    const push = rail.querySelector('.rail-push');
    if (push) push.insertAdjacentElement('beforebegin', note); else rail.appendChild(note);
  }
  note.textContent = text || 'Pushed — delivers with your next message.';
  clearTimeout(showParkedNote._t);
  showParkedNote._t = setTimeout(() => { const n = railEl() && railEl().querySelector('.rail-parked'); if (n) n.remove(); }, 6000);
}

// F6: a visible rail error state (mirrors .rail-notice styling, coral) when a push
// fails, so the kept batch/note aren't a silent mystery. Cleared on the next push.
function showPushError() {
  const rail = railEl();
  if (!rail) return;
  if (rail.querySelector('.rail-error')) return;
  const err = document.createElement('div');
  err.className = 'rail-error';
  err.textContent = 'Push failed — your batch and note are kept. Try again.';
  const push = rail.querySelector('.rail-push');
  if (push) push.insertAdjacentElement('beforebegin', err);
  else rail.appendChild(err);
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
