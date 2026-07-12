// The wake policy — the ONE pure function that decides whether a bus event is
// wake-worthy and, if so, whether it queues (the default deliberate-handoff
// path) or wakes Claude immediately (a pane that declared `wake:'immediate'`).
//
// Consumed by a single server-side bus subscriber (registered at boot in
// lib/server/index.js) so classification lives in one place and both the queue
// and the immediate-wake path share it. Kept pure (no I/O, no bus, no state) so
// it is trivially unit-testable and can't accidentally emit.
//
// Self-wake safety: Claude's own set_store and
// drivers' writes POST /api/store → `source:'server'`; browser pane clicks arrive
// over WS → `source:'browser'`; captures are `source:'ext:tab-stream'`. This
// policy enqueues ONLY browser/ext-sourced events, so Claude's mutations never
// enqueue and never wake — no loop.

const { sanitizeSummary } = require('./envelope');

// Best-effort host of a URL without throwing on junk. Trusted-frame only: we
// surface the host + profile + id, never the captured body.
function hostOf(url) {
  const s = String(url || '');
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
  if (m) return m[1];
  // Bare host (no scheme) — take the authority-looking prefix.
  const m2 = s.match(/^([^/?#\s]+)/);
  return m2 ? m2[1] : '';
}

// A capture event → a queue item. The event carries only the trusted frame
// (id/seq/url/profile/source); the body lives in a sidecar Claude fetches by
// tool call (get_captures / inspect_capture).
function captureItem(event) {
  const host = hostOf(event.url);
  const parts = [];
  parts.push(host ? `captured ${host}` : 'captured page');
  if (event.profile) parts.push(`profile ${event.profile}`);
  if (event.capture_id) parts.push(event.capture_id);
  return {
    kind: 'capture',
    source: event.source || 'ext:tab-stream',
    capture_id: event.capture_id,
    why_wake: 'page captured',
    summary: sanitizeSummary(parts.join(' · ')),
    origin_mount: event.mount || null,
    seq: event.seq,
  };
}

// A browser signal write → a queue item. NEVER inlines the payload — just the
// key and its bumped seq, which is all Claude needs to know it should re-read the
// store. The real payload is fetched by get_store.
function signalItem(event, key, decl) {
  const value = (event.patch || {})[key];
  const paySeq = (value && typeof value === 'object' && 'seq' in value) ? value.seq : undefined;
  return {
    kind: 'signal',
    source: event.source || 'browser',
    signal_key: key,
    why_wake: decl.why ? String(decl.why) : `${key} fired`,
    summary: sanitizeSummary(paySeq != null ? `${key} · seq ${paySeq}` : key),
    origin_mount: decl.mount || null,
    seq: event.seq,
    payload_seq: paySeq,
  };
}

// A pinned comment → a queue item. Only a SHARED pin reaches here — a fresh add, a
// user reply, or a private→shared toggle (private pins never enqueue — see
// classify). Unlike a signal payload there is
// no body to hide: a shared pin's text is already Claude-visible via
// get_comments, so the (short) text may ride in the summary. Claude fetches the
// full pin set with get_comments on wake.
function commentItem(pin) {
  const replies = Array.isArray(pin.replies) ? pin.replies : [];
  // F8: the handoff quotes the last USER message, never Claude's own reply — walk
  // back past any trailing author:'claude' replies. The re-share path (Claude
  // answered → user un-shared → user re-shared) must hand off the user's words, not
  // Claude's; if the user never replied, quote the root pin. why_wake follows what
  // was actually quoted ('comment reply' only when a user reply was).
  let userReply = null;
  for (let i = replies.length - 1; i >= 0; i--) {
    if (replies[i] && replies[i].author !== 'claude') { userReply = replies[i]; break; }
  }
  const text = String((userReply ? userReply.text : pin.text) || '').trim();
  const parts = [];
  if (pin.anchor && pin.anchor.mount) parts.push(pin.anchor.mount);
  if (text) parts.push(`"${text}"`);
  return {
    kind: 'comment',
    source: 'browser',
    comment_id: pin.id,
    why_wake: userReply ? 'comment reply' : 'comment pinned for Claude',
    summary: sanitizeSummary(parts.join(' · ') || 'comment'),
    origin_mount: (pin.anchor && pin.anchor.mount) || null,
    seq: pin.seq,
  };
}

// classify(event, { signals }) → null | { action, item? }
//   * null                    — not wake-worthy (server-sourced, unknown kind, or
//                               a browser write that touches no DECLARED signal key).
//   * { action:'enqueue', item } — folds into the queue (the default).
//   * { action:'wake', item }    — emits a wake immediately, bypassing the queue.
//   * { action:'dequeue', comment_id } — DROPS matching queue items (a pin was
//                               un-shared or deleted); carries no wake item.
//   * { action:'refresh', comment_id, item } — REBUILDS a queued comment item's
//                               summary in place (a shared pin's text was edited);
//                               the subscriber no-ops if it isn't queued (F9).
// `signals` is the declared-signal registry: `{ [key]: { wake, mount, why } }`
// (built from render `params.signals`). Absent → only captures classify.
function classify(event, { signals = {} } = {}) {
  if (!event || !event.kind) return null;

  if (event.kind === 'capture') {
    // Captures are always the deliberate-send of a page; they queue by default.
    return { action: 'enqueue', item: captureItem(event) };
  }

  if (event.kind === 'store') {
    // Self-wake gate: only a browser (pane) write can be a signal. Claude's and
    // drivers' writes are 'server' and must never enqueue.
    if (event.source !== 'browser') return null;
    const patch = event.patch || {};
    const keys = Object.keys(patch).filter((k) => signals[k]);
    if (!keys.length) return null; // a browser write to plain state — not a signal
    // An immediate-declared signal in the patch wins over a queued one.
    const key = keys.find((k) => (signals[k] || {}).wake === 'immediate') || keys[0];
    const decl = signals[key] || {};
    const item = signalItem(event, key, decl);
    return { action: decl.wake === 'immediate' ? 'wake' : 'enqueue', item };
  }

  if (event.kind === 'comment') {
    // DEQUEUE side (mirror of enqueue): a pin that's turned PRIVATE again, or is
    // deleted outright, must leave the wake rail — the reverse of the toggle/add
    // that put it there. Idempotent downstream (a no-op if it was never queued), so
    // a private add or a queue-revert delete harmlessly resolves to a 0-item drop.
    // B7: an un-share keys on the writer-stamped `became_private` (symmetric with
    // became_shared); the raw shared===false is a cheap defensive fallback.
    if (event.op === 'delete') return { action: 'dequeue', comment_id: event.id };
    if (event.op === 'edit' && event.pin && (event.became_private || event.pin.shared === false)) {
      return { action: 'dequeue', comment_id: event.pin.id };
    }
    // ENQUEUE side — deliberate handoffs (the wake continues the thread): a shared
    // pin's ADD, a USER reply on a shared pin, and a private→shared TOGGLE (op:'edit'
    // with became_shared — the note was just made visible to Claude). Claude's own
    // reply (author:'claude', now that reply_comment exists) or a private pin never
    // enqueue — that's the self-wake gate for the one MCP write path. The add/reply/
    // edit events carry the full pin (shared → not redacted); delete doesn't.
    if (!event.pin || event.pin.shared === false) return null;
    if (event.op === 'add') return { action: 'enqueue', item: commentItem(event.pin) };
    if (event.op === 'reply' && event.author !== 'claude') return { action: 'enqueue', item: commentItem(event.pin) };
    if (event.op === 'edit' && event.became_shared) return { action: 'enqueue', item: commentItem(event.pin) };
    // F9: a plain text edit of an ALREADY-shared pin (no privacy flip) — refresh the
    // queued item's summary so the wake line never quotes stale/retracted text. The
    // subscriber no-ops when the pin isn't queued (refresh never enqueues).
    if (event.op === 'edit') return { action: 'refresh', comment_id: event.pin.id, item: commentItem(event.pin) };
    return null;
  }

  return null;
}

module.exports = { classify, captureItem, signalItem, commentItem, hostOf };
