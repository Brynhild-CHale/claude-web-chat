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
const { typeOfId } = require('../core/element-log');
const { SHAPES } = require('../core/ink-shape');

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

// THE element item (K.2-10; U423, PLAN.md 3B.2): the queue domain's one item
// kind for EVERY element type whose declaration wakes — the comment and the
// chat family included. Built from a NORMALISED event (normalise below: an
// element event as the ring carries it, or a comment event adapted to it)
// and the type's declaration `decl`, which the subscriber read from the
// type's descriptor (lib/server/index.js elementWake):
//   wake     the declaration (lib/packs/elements wakeOf: {coalesce,
//            respond}); `true` reads as {coalesce: 'count', respond: false}
//   label    the manifest's label, else the type's name
//   text     the payload field the manifest's summary_key names, redacted
//            (K.2-16)
//   replies  for a thread-bearing type ({respond: true}): its replies
//            ({author, text}), redacted; the THREAD rule below reads them
//   where    the anchor's words, when the wiring hands them (a comment's item,
//            chain and section; a chat pin's `on <record label>`); a string,
//            even empty, replaces the label and id@v
// The summary is `where` (else the label and id@v), then the quoted text,
// sanitized and truncated to the queue's cap — so a highlight's and a box
// grab's are what they always were, and the comment's equals commentItem's.
// THE THREAD RULE (S-7's condition: generic to every respond type, F8's rule
// now the engine's): the quoted text is the newest reply not by 'claude',
// else the summary field; why_wake follows what was quoted. The element's own
// id rides as `element_id` (the queue owns `id`); `respond: true` and
// `coalesce: 'none'` ride as declared (words, never text). A box grab's
// settled `image` block rides as given. (The wiring adds the declaration's
// `label` to the item it raises, for the queue's group summary `<label> ×N`.)
function wakeDecl(w) {
  if (w === true) return { coalesce: 'count', respond: false };
  if (!w || typeof w !== 'object') return null;
  return { coalesce: w.coalesce === 'none' ? 'none' : 'count', respond: w.respond === true };
}
function threadQuote(decl, respond) {
  const text = typeof decl.text === 'string' ? decl.text.trim() : '';
  if (!respond) return { text, fromReply: false };
  const replies = Array.isArray(decl.replies) ? decl.replies : [];
  for (let i = replies.length - 1; i >= 0; i--) {
    const r = replies[i];
    if (r && r.author !== 'claude') return { text: String(r.text == null ? '' : r.text).trim(), fromReply: true };
  }
  return { text, fromReply: false };
}
// A stroke group's description (U562; lib/core/ink-shape describeOf, composed
// on the daemon from the group's SHARED members, lib/server/index.js
// elementWake): re-checked here, so the item carries a SHAPES word and
// numbers only — {shape, confidence, count, bbox} — or nothing. It holds no
// page text (the text under a stroke rides only as the excerpt), so no
// TEXT_RULES row reads it.
//
// A folded item (U562a, PQ-4F-3) also carries `groups` — one checked entry
// per stroke group it folded, {shape, confidence, count, bbox, element_ids},
// in fold order, newest last, at most DESCRIBE_GROUPS_MAX — and
// `groups_dropped`, the older groups the cap let go. A malformed list or
// count drops the whole describe, as any malformed field does.
const DESCRIBE_GROUPS_MAX = 16;
function checkedGuess(d) {
  if (!d || typeof d !== 'object') return null;
  const { shape, confidence, count, bbox } = d;
  if (typeof shape !== 'string' || !SHAPES.includes(shape)) return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  if (!Number.isInteger(count) || count < 1) return null;
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return { shape, confidence, count, bbox: bbox.slice() };
}
function checkedGroupEntry(e) {
  const g = checkedGuess(e);
  if (!g) return null;
  const ids = e.element_ids;
  if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === 'string' && id)) return null;
  return { ...g, element_ids: ids.slice() };
}
function checkedDescribe(d) {
  const out = checkedGuess(d);
  if (!out) return null;
  if (d.groups !== undefined) {
    if (!Array.isArray(d.groups) || !d.groups.length || d.groups.length > DESCRIBE_GROUPS_MAX) return null;
    const groups = d.groups.map(checkedGroupEntry);
    if (groups.some((g) => !g)) return null;
    out.groups = groups;
  }
  if (d.groups_dropped !== undefined) {
    if (!out.groups || !Number.isInteger(d.groups_dropped) || d.groups_dropped < 1) return null;
    out.groups_dropped = d.groups_dropped;
  }
  return out;
}
const describeWords = (d) => `${d.shape} · ${d.count} stroke${d.count === 1 ? '' : 's'}`;

function elementItem(event, decl = {}) {
  const w = wakeDecl(decl.wake) || { coalesce: 'count', respond: false };
  const label = typeof decl.label === 'string' && decl.label.trim() ? decl.label.trim() : event.type;
  const { text, fromReply } = threadQuote(decl, w.respond);
  const describe = checkedDescribe(decl.describe);
  const parts = typeof decl.where === 'string'
    ? (decl.where.trim() ? [decl.where.trim()] : [])
    : [label, `${event.id}@${event.v}`];
  // The shape words go before the id part (after a chat type's where).
  if (describe) parts.splice(typeof decl.where === 'string' ? parts.length : parts.length - 1, 0, describeWords(describe));
  if (text) parts.push(`"${text}"`);
  const noun = label.toLowerCase();
  return {
    kind: 'element',
    source: 'browser',
    type: event.type,
    element_id: event.id,
    ...(event.v != null ? { v: event.v } : {}),
    why_wake: w.respond ? (fromReply ? `${noun} reply` : `${noun} pinned for Claude`) : `${label} sent to Claude`,
    summary: sanitizeSummary(parts.join(' · ') || event.type),
    origin_mount: event.mount || null,
    ...(w.respond ? { respond: true } : {}),
    ...(w.coalesce === 'none' ? { coalesce: 'none' } : {}),
    ...(event.seq != null ? { seq: event.seq } : {}),
    ...(event.image && typeof event.image === 'object' ? { image: event.image } : {}),
    ...(describe ? { describe } : {}),
    // The group's member list (U424a, Y5 = b): a raise is a group of one.
    members: [{ id: event.id, words: memberWords(text) }],
    more: 0,
  };
}

// A group's members, as the rail names them (U424a; RULED X4 = a, Y5 = b):
// `members` holds up to MEMBERS_SHOWN {id, words} entries — the NEWEST
// members, listed in queue order (oldest → newest), each one's words the
// text its summary quotes (the THREAD rule's pick: a comment's note or its
// newest user reply, a highlight's note), cut to MEMBER_WORDS_MAX with U+2026
// ('' when the member has none) — and `more` the members beyond the list
// (count − members.length). The newest three because a raise always carries
// the raised member's own words: a new pin and a reply that moves a queued
// pin to the end both leave the list whole; only a member leaving can shrink
// it below three (its successor's words are not on the item), and `more`
// still counts every member left. Pure words, never read by the envelope or
// the wake: `summary` and `count` are what they were, so the delivery is
// byte-equal; below `read` the list is the item's text-free label
// (lib/core/remote-policy TEXT_RULES.items).
const MEMBERS_SHOWN = 3;
const MEMBER_WORDS_MAX = 60;
function memberWords(text) {
  return sanitizeSummary(typeof text === 'string' ? text : '', { max: MEMBER_WORDS_MAX });
}
function membersListOf(it) {
  if (!it || !Array.isArray(it.members)) return [];
  return it.members.filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id && typeof m.words === 'string')
    .map((m) => ({ id: m.id, words: m.words }));
}
// Re-derive `members` and `more` from the group's element_ids and the words
// `known` (id → words) holds, as FRESH arrays and entries (a served frame's
// shallow copy keeps the old list: groupCopy, F7).
function syncMembers(group, known = new Map(membersListOf(group).map((m) => [m.id, m.words]))) {
  const ids = membersOf(group);
  const list = ids.filter((id) => known.has(id)).slice(-MEMBERS_SHOWN).map((id) => ({ id, words: known.get(id) }));
  group.members = list;
  group.more = Math.max(0, ids.length - list.length);
  return group;
}

// The group fold (U423): `incoming` — an element item, or a kept group being
// re-sent — folds INTO the queued group `group` in place. Its members become
// the newest (an existing member moves to the end, never twice); the newest's
// element_id, v, summary, why_wake, image and a stroke group's describe
// (each dropped when the newest has none) become the group's; every member
// keeps its own excerpt entry (setExcerpts). `count` is the member count.
// Pure data — the queue domain owns the frames.
function membersOf(it) {
  if (!it || typeof it !== 'object') return [];
  if (Array.isArray(it.element_ids)) return it.element_ids.filter((x) => typeof x === 'string' && x);
  return typeof it.element_id === 'string' && it.element_id ? [it.element_id] : [];
}
function excerptsOf(it) {
  if (!it) return [];
  if (Array.isArray(it.excerpt)) {
    return it.excerpt.filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && typeof e.text === 'string' && e.text)
      .map((e) => ({ id: e.id, text: e.text }));
  }
  if (typeof it.excerpt === 'string' && it.excerpt && it.element_id) return [{ id: it.element_id, text: it.excerpt }];
  return [];
}
// The describe fold (U562a, PQ-4F-3: what a Push delivers carries every
// group's shape guess). `prior` is the queued item's checked describe (its
// one group's ids are `priorIds`, the members it held), `next` the
// incoming's (its ids `nextIds`). An incoming entry continues a listed group
// when it names one of that group's ids, or — a group grows a stroke at a
// time, each raise describing the group so far — when it counts more strokes
// and its box holds the listed group's (BOX_SLOP over describeOf's 4-place
// rounding); the newest such entry is replaced, else the entry is appended.
// One group left (and none dropped) → that group's describe alone, exactly
// as before; more → the newest's shape and confidence, count summed, bbox
// the union, and `groups`, at most DESCRIBE_GROUPS_MAX (oldest dropped,
// counted in `groups_dropped`). No incoming describe: a listed fold is left
// as it is; a one-group describe is dropped, as before.
const BOX_SLOP = 2e-4;
const round4 = (v) => Math.round(v * 1e4) / 1e4;
function boxHolds(outer, inner) {
  return inner[0] >= outer[0] - BOX_SLOP && inner[1] >= outer[1] - BOX_SLOP
    && inner[0] + inner[2] <= outer[0] + outer[2] + BOX_SLOP && inner[1] + inner[3] <= outer[1] + outer[3] + BOX_SLOP;
}
function entriesOf(d, ids) {
  if (!d) return [];
  if (d.groups) return d.groups.map((g) => ({ ...g, element_ids: g.element_ids.slice() }));
  const { shape, confidence, count, bbox } = d;
  return ids.length ? [{ shape, confidence, count, bbox: bbox.slice(), element_ids: ids.slice() }] : [];
}
function foldDescribe(prior, priorIds, next, nextIds) {
  if (!next) return prior && prior.groups ? prior : null;
  let list = entriesOf(prior, priorIds);
  let dropped = (prior && prior.groups_dropped) || 0;
  for (const n of entriesOf(next, nextIds)) {
    let at = -1;
    for (let i = list.length - 1; i >= 0 && at < 0; i--) {
      const e = list[i];
      if (e.element_ids.some((id) => n.element_ids.includes(id)) || (n.count > e.count && boxHolds(n.bbox, e.bbox))) at = i;
    }
    const ids = at >= 0 ? [...list[at].element_ids.filter((id) => !n.element_ids.includes(id)), ...n.element_ids] : n.element_ids.slice();
    if (at >= 0) list.splice(at, 1);
    list = list.map((e) => ({ ...e, element_ids: e.element_ids.filter((id) => !n.element_ids.includes(id)) }))
      .filter((e) => e.element_ids.length);
    list.push({ ...n, element_ids: ids });
  }
  dropped += (next.groups_dropped) || 0;
  while (list.length > DESCRIBE_GROUPS_MAX) { list.shift(); dropped += 1; }
  if (!list.length) return null;
  const top = list[list.length - 1];
  if (list.length === 1 && !dropped) return { shape: top.shape, confidence: top.confidence, count: top.count, bbox: top.bbox.slice() };
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const { bbox: b } of list) {
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[0] + b[2]); y1 = Math.max(y1, b[1] + b[3]);
  }
  return {
    shape: top.shape,
    confidence: top.confidence,
    count: list.reduce((n, e) => n + e.count, 0),
    bbox: [round4(x0), round4(y0), round4(x1 - x0), round4(y1 - y0)],
    groups: list,
    ...(dropped ? { groups_dropped: dropped } : {}),
  };
}
function mergeElement(group, incoming) {
  const inIds = membersOf(incoming);
  const priorIds = membersOf(group);
  const ids = [...membersOf(group).filter((id) => !inIds.includes(id)), ...inIds];
  const byId = new Map(excerptsOf(group).filter((e) => !inIds.includes(e.id)).map((e) => [e.id, e]));
  for (const e of excerptsOf(incoming)) byId.set(e.id, e);
  group.element_ids = ids;
  group.count = ids.length;
  const newest = typeof incoming.element_id === 'string' && ids.includes(incoming.element_id) ? incoming.element_id : ids[ids.length - 1];
  group.element_id = newest;
  if (incoming.v != null && newest === incoming.element_id) group.v = incoming.v;
  else delete group.v;
  if (typeof incoming.label === 'string' && incoming.label) group.label = incoming.label;
  if (newest === incoming.element_id && incoming.summary != null) {
    group.summary = incoming.summary;
    group.why_wake = incoming.why_wake;
  } else {
    group.summary = groupLabelSummary(group);
  }
  if (incoming.image && typeof incoming.image === 'object' && newest === incoming.element_id) group.image = incoming.image;
  else delete group.image;
  // The stroke description (U562; per folded group, U562a): one group's
  // item carries the newest's describe, dropped when the newest has none —
  // as the picture; a fold over several groups keeps each one's guess.
  const described = newest === incoming.element_id ? checkedDescribe(incoming.describe) : null;
  const folded = foldDescribe(priorIds.length ? checkedDescribe(group.describe) : null, priorIds, described, inIds);
  if (folded) group.describe = folded;
  else delete group.describe;
  if (incoming.respond === true) group.respond = true;
  if (incoming.seq != null) group.seq = incoming.seq;
  setExcerpts(group, ids.filter((id) => byId.has(id)).map((id) => byId.get(id)));
  // The members (U424a): the incoming's words win for its ids.
  const words = new Map(membersListOf(group).filter((m) => !inIds.includes(m.id)).map((m) => [m.id, m.words]));
  for (const m of membersListOf(incoming)) words.set(m.id, m.words);
  syncMembers(group, words);
  return group;
}
// A group's excerpts (notes-B D-4, the shape the envelope reads): none → no
// field; a one-member group's one entry → its text, a string, as an element
// item has always carried it; else [{id, text}] per member, oldest first.
// Every path that changes a group's membership ends here (mergeElement and
// the queue domain's remove, refresh and re-send), so the member list
// (U424a) is re-derived here too: a member that left leaves the list, and
// `more` counts what is left.
function setExcerpts(group, entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) delete group.excerpt;
  else if (list.length === 1 && membersOf(group).length === 1 && list[0].id === group.element_id) group.excerpt = list[0].text;
  else group.excerpt = list.map((e) => ({ id: e.id, text: e.text }));
  if (Array.isArray(group.members)) syncMembers(group);
}
// A group whose newest member left reads `<label> ×N` until the next raise.
function groupLabelSummary(group) {
  const label = typeof group.label === 'string' && group.label ? group.label : (group.type || 'element');
  return sanitizeSummary(`${label} ×${membersOf(group).length}`);
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
    // The WRITER, not the declarer: two panes may declare the same key, and the
    // registry keeps only the last declarer (signals.derive). The per-pane store
    // facade stamps the writing pane on the event; the declarer is the fallback
    // for an unattributed write.
    origin_mount: event.mount || decl.mount || null,
    seq: event.seq,
    payload_seq: paySeq,
  };
}

// A pinned comment → its queue item. Since U423 (PLAN.md 3B.2; K.2-22's
// interim ends) the comment is one more element type on the declarative path:
// commentItem is a thin wrapper answering the comment's elementItem — the
// adapter's normalised event (normalise below) and the comment's words
// (commentWords) under the comment's declaration (COMMENT_DECL, element.json's
// {coalesce: 'count', respond: true}). Kept exported so a caller that builds a
// comment's item keeps its call. Only a SHARED pin is ever raised (classify
// decides), and a shared pin's text is already Claude-visible via
// get_comments, so the (short) text may ride in the summary.
//
// A CHAINED pin (F.6, comment@2) names its chain after the item, smallest
// first, from the pin's own `chain` and each id's letter (element-log
// typeOfId): `m1 · on highlight h7 › box grab g3 · "text"`. `hidden` is the
// event's `chain_private` (the route reads which members are private now;
// this function holds no state): such a member reads 'a private element',
// with no type and no id (RULED U406@private-chain-member Q8 (a)). The pane
// and section levels ride get_comments' chain_label, never the summary (it
// holds no page order). A chainless pin's summary is unchanged.
function chainSummary(pin, hidden) {
  const ids = Array.isArray(pin && pin.chain) ? pin.chain.filter((x) => typeof x === 'string' && x) : [];
  if (!ids.length) return '';
  const priv = new Set(Array.isArray(hidden) ? hidden : []);
  return 'on ' + ids.map((id) => {
    if (priv.has(id)) return 'a private element';
    const t = typeOfId(id);
    return `${t ? t.replace(/-/g, ' ') : 'element'} ${id}`;
  }).join(' › ');
}
// The comment's words, as its declaration hands them: `where` is the item the
// pin is on (its 0.8.5 locator's mount, a pane or a markdown item — panes and
// markdown share one id space — else its anchor's mount, else a source
// record's md; F.3), then the chain, then `on section "…"`; `text` the pin's
// own text and `replies` its thread (the THREAD rule picks the quote).
function commentWords(pin, hidden = []) {
  const p = pin && typeof pin === 'object' ? pin : {};
  const item = commentItemId(p);
  const section = p.locator && typeof p.locator.section === 'string' ? p.locator.section.trim() : '';
  const parts = [];
  if (item) parts.push(item);
  const chain = chainSummary(p, hidden);
  if (chain) parts.push(chain);
  if (section) parts.push(`on section "${section.length > 60 ? section.slice(0, 60) + '…' : section}"`);
  return {
    where: parts.join(' · '),
    text: String(p.text == null ? '' : p.text),
    replies: Array.isArray(p.replies) ? p.replies : [],
  };
}
// The comment's declaration when the caller hands none (a bare classify, a
// test): element.json's own, held equal by test/declarative-wake.test.js.
const COMMENT_DECL = Object.freeze({ wake: Object.freeze({ coalesce: 'count', respond: true }), label: 'Comment' });
function commentItem(pin, { hidden = [] } = {}) {
  const ev = normalise({ kind: 'comment', op: 'add', pin });
  return elementItem(ev, { ...COMMENT_DECL, ...commentWords(pin, hidden) });
}
function commentItemId(pin) {
  const isId = (x) => (typeof x === 'string' && x !== '') || typeof x === 'number';
  const loc = pin.locator && typeof pin.locator === 'object' ? pin.locator : null;
  const a = pin.anchor && typeof pin.anchor === 'object' ? pin.anchor : null;
  for (const x of [loc && loc.mount, a && a.mount, a && a.md]) if (isId(x)) return x;
  return null;
}

// ── The opt-OUT activity layer ────────────────────────────────────────────
// Declared signals are the semantic layer (named payloads, immediate wakes) —
// but they depend on the pane's own script running `store.set` correctly, which
// is exactly what breaks when a component is mis-authored (a script that queried
// `document` instead of its shadow `root` dies at mount and its declared signal
// never fires). The activity layer is the safety net underneath: the shell's
// DELEGATED listeners (which pierce the shadow boundary and survive a dead pane
// script) and undeclared browser store writes fold into ONE rolling 'activity'
// queue item per mount — counts only, NEVER values (the payload stays behind
// get_store / get_events, same injection posture as captures). Routing is
// opt-out per pane (`params.routing:'none'`), and service-owned panes default
// out (their store control-loop is pane↔service traffic, not a handoff).

const ACTIVITY_COUNT_KEYS = ['click', 'change', 'submit', 'store'];
const ACTIVITY_KEYS_MAX = 12;

function activitySummary(mountId, counts, keys) {
  const bits = [];
  if (counts.change) bits.push(`${counts.change} edit${counts.change === 1 ? '' : 's'}`);
  if (counts.submit) bits.push(`${counts.submit} submit${counts.submit === 1 ? '' : 's'}`);
  if (counts.click) bits.push(`${counts.click} click${counts.click === 1 ? '' : 's'}`);
  if (counts.store) bits.push(`${counts.store} store write${counts.store === 1 ? '' : 's'}`);
  const parts = [mountId || 'surface', bits.join(', ')];
  if (keys && keys.length) {
    const shown = keys.slice(0, ACTIVITY_KEYS_MAX);
    parts.push(`keys: ${shown.join(', ')}${keys.length > shown.length ? '…' : ''}`);
  }
  return sanitizeSummary(parts.filter(Boolean).join(' · '));
}

// A dom event / undeclared browser store write → a fresh activity item. Counts
// and touched key NAMES only — a value never rides the item (it lives in the
// store / event log, fetched by tool call).
function activityItem(event) {
  const counts = { click: 0, change: 0, submit: 0, store: 0 };
  let keys = [];
  let mountId = null;
  if (event.kind === 'dom') {
    mountId = event.mountId || null;
    if (ACTIVITY_COUNT_KEYS.includes(event.type)) counts[event.type] = 1;
  } else {
    mountId = event.mount || null;
    counts.store = 1;
    keys = Object.keys(event.patch || {});
  }
  return {
    kind: 'activity',
    source: event.source || 'browser',
    origin_mount: mountId,
    why_wake: 'pane activity',
    counts,
    keys,
    summary: activitySummary(mountId, counts, keys),
    seq: event.seq,
    // The element a renderer's event names (X-5, tranche 2 fills it). The key
    // exists only when the event carries one, so every item, frame and ring
    // entry stays byte-identical until then.
    ...(event.element != null ? { origin_element: event.element } : {}),
  };
}

// Fold `incoming` into an already-queued activity item IN PLACE: sum counts,
// union key names (capped), rebuild the summary, advance seq. Pure data merge —
// the queue domain owns the bus emit.
function mergeActivity(existing, incoming) {
  const counts = { ...(existing.counts || {}) };
  for (const k of ACTIVITY_COUNT_KEYS) counts[k] = (counts[k] || 0) + ((incoming.counts || {})[k] || 0);
  existing.counts = counts;
  existing.keys = [...new Set([...(existing.keys || []), ...(incoming.keys || [])])].slice(0, ACTIVITY_KEYS_MAX * 2);
  existing.summary = activitySummary(existing.origin_mount, counts, existing.keys);
  if (incoming.seq != null) existing.seq = incoming.seq;
  return existing;
}

// A click only counts as activity when it plausibly hit an affordance — a bare
// click on prose/whitespace (text selection, focus) is not a handoff-worthy
// interaction. change/submit always count.
const INTERACTIVE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY', 'OPTION']);
function domIsMeaningful(event) {
  if (event.type === 'change' || event.type === 'submit') return true;
  if (event.type !== 'click') return false;
  if (INTERACTIVE_TAGS.has(String(event.tag || '').toUpperCase())) return true;
  return Boolean(event.dataset && Object.keys(event.dataset).length);
}

// ── The declarative element path (U423; PLAN.md 3B.2, readiness R5 S-7) ──
// ONE path for every element type, the comment and the chat family included:
// it reads only the type's declaration (elementTypes[type], above) and a
// NORMALISED event:
//   {type, op, id, v, shared, prev_shared, mount, author, pending, image,
//    seq, chain_private}
// An element event is that already ({kind: 'element', …} from domain/comments
// elementEvent; `was_shared` on a PATCH's edit is prev_shared). A comment
// event ({kind: 'comment', op, pin, became_shared, became_private, author,
// chain_private}) is adapted to it here — THE WRITER ADAPTER, S-7's one
// type-shaped seam: type 'comment', id the pin's, the shared flag (false
// when it became private), prev_shared from became_shared / became_private,
// mount the pin's item. Answers null for an event that names no element.
function normalise(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.kind === 'element') {
    if (!event.type) return null;
    return {
      type: event.type, op: event.op, id: event.id, v: event.v,
      shared: event.shared !== false,
      prev_shared: typeof event.was_shared === 'boolean' ? event.was_shared : null,
      mount: event.mount || null, author: event.author, pending: event.pending, image: event.image,
      chain_private: Array.isArray(event.chain_private) ? event.chain_private : [],
      has: true,
    };
  }
  if (event.kind !== 'comment') return null;
  const pin = event.pin && typeof event.pin === 'object' ? event.pin : null;
  const id = pin ? pin.id : event.id;
  const shared = pin ? !(event.became_private || pin.shared === false) : false;
  return {
    type: 'comment', op: event.op, id, v: pin && pin.v != null ? pin.v : undefined,
    shared,
    prev_shared: event.became_shared ? false : event.became_private ? true : null,
    mount: pin ? commentItemId(pin) : null, author: event.author, pending: false, image: null,
    seq: pin ? pin.seq : undefined,
    chain_private: Array.isArray(event.chain_private) ? event.chain_private : [],
    has: !!pin,
  };
}

// The rules, over a normalised event and its type's declaration (no type is
// named here):
//   * no declaration, or one that does not wake → nothing;
//   * delete → dequeue by element id;
//   * not shared: a raising op (a private add, send, reply, anchor) →
//     nothing; any other (an edit that left shared or changed a private
//     one, a box grab's settle) → dequeue (idempotent);
//   * a shared element whose picture is still being drawn (`pending`) →
//     nothing yet;
//   * add, grab, send of a shared one → enqueue; an edit that made it shared
//     (prev_shared false) → enqueue; any other edit → refresh in place;
//   * reply (a thread, any {respond: true} type): Claude's own → nothing (the
//     self-wake gate); a user's → enqueue, which the queue folds into the
//     element's queued item (raises or refreshes); a type that does not
//     respond → nothing.
// An enqueue's item and a refresh's are elementItem's.
const QUIET_PRIVATE = new Set(['add', 'send', 'reply', 'anchor']);
function declarative(ev, decl) {
  const w = decl ? wakeDecl(decl.wake) : null;
  if (!w || !ev.id) return null;
  if (ev.op === 'delete') return { action: 'dequeue', element_id: ev.id };
  if (!ev.has) return null;
  if (!ev.shared) return QUIET_PRIVATE.has(ev.op) ? null : { action: 'dequeue', element_id: ev.id };
  if (ev.pending) return null;
  const item = () => elementItem(ev, decl);
  if (ev.op === 'add' || ev.op === 'grab' || ev.op === 'send') return { action: 'enqueue', item: item() };
  if (ev.op === 'edit') {
    return ev.prev_shared === false ? { action: 'enqueue', item: item() } : { action: 'refresh', element_id: ev.id, item: item() };
  }
  if (ev.op === 'reply') return w.respond && ev.author !== 'claude' ? { action: 'enqueue', item: item() } : null;
  return null;
}

// classify(event, { signals, routing }) → null | { action, item? }
//   * null                    — not wake-worthy (server-sourced, unknown kind, or
//                               a browser event a pane opted out of routing).
//   * { action:'enqueue', item } — folds into the queue (the default).
//   * { action:'wake', item }    — emits a wake immediately, bypassing the queue.
//   * { action:'coalesce', item } — folds into the ROLLING activity item for the
//                               event's origin mount (merge, not stack).
//   * { action:'dequeue', element_id } — DROPS the element from the queue (it
//                               was un-shared or deleted); carries no wake item.
//   * { action:'refresh', element_id, item } — REBUILDS a queued element's
//                               words in place (a shared element was edited);
//                               the subscriber no-ops if it isn't queued (F9).
//                               Every element type, the comment included
//                               (K.2-10; the declarative path above).
// `signals` is the declared-signal registry: `{ [key]: { wake, mount, why } }`
// (built from render `params.signals`). `routing` is the per-mount opt-out map
// (see lib/server/domain/signals deriveRouting): `{ [mountId]: 'auto'|'none' }`.
function classify(event, { signals = {}, routing = {}, elementTypes = {} } = {}) {
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
    if (!keys.length) {
      // A browser write that touches no DECLARED key coalesces as activity —
      // but ONLY when the client stamped it gesture-proximate (a real user
      // interaction preceded it). A pane script's init/tick/reactive writes
      // carry no gesture and must never masquerade as user activity (they'd
      // enqueue a phantom item on every mount otherwise).
      if (!event.gesture) return null;
      if (!Object.keys(patch).length) return null;
      const mountId = event.mount || null;
      if (mountId && routing[mountId] === 'none') return null;
      return { action: 'coalesce', item: activityItem(event) };
    }
    // An immediate-declared signal in the patch wins over a queued one.
    const key = keys.find((k) => (signals[k] || {}).wake === 'immediate') || keys[0];
    const decl = signals[key] || {};
    const item = signalItem(event, key, decl);
    return { action: decl.wake === 'immediate' ? 'wake' : 'enqueue', item };
  }

  if (event.kind === 'dom') {
    // The delegated-listener safety net: a shell-forwarded pane interaction
    // coalesces into the mount's rolling activity item even when the pane's own
    // script is broken (the delegated listeners live in the shell, not the pane).
    // Server-side dom replays don't exist today, but gate on source anyway.
    if (event.source && event.source !== 'browser') return null;
    const mountId = event.mountId || null;
    if (mountId && routing[mountId] === 'none') return null;
    if (!domIsMeaningful(event)) return null;
    return { action: 'coalesce', item: activityItem(event) };
  }

  if (event.kind === 'element' || event.kind === 'comment') {
    const ev = normalise(event);
    if (!ev) return null;
    // A comment classified with no declaration handed (a bare classify)
    // reads the comment's own (COMMENT_DECL) and its words from the pin.
    const given = (elementTypes || {})[ev.type];
    const decl = event.kind === 'comment'
      ? { ...COMMENT_DECL, ...(event.pin ? commentWords(event.pin, ev.chain_private) : {}), ...(given || {}) }
      : given;
    return declarative(ev, decl);
  }

  return null;
}

module.exports = {
  classify, captureItem, signalItem, commentItem, commentWords, chainSummary, elementItem, mergeElement, membersOf,
  groupLabelSummary, setExcerpts, excerptsOf, syncMembers, MEMBERS_SHOWN, DESCRIBE_GROUPS_MAX, MEMBER_WORDS_MAX, normalise, activityItem, mergeActivity, hostOf, COMMENT_DECL,
};
