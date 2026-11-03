'use strict';
// THE ENGINE'S UNDO (annotation engine 4A.3, U518; DECISIONS N.1 AD6, AF9
// UNDO@scope, AF10 WRITER@undo-selection, AI13 U518@undo-item-and-chord).
//
// One undo over the element log for every page type and every pack: it
// retracts the newest LIVE version the caller's own writer stamp wrote on an
// item (a pane or a markdown item), whatever its type. No type and no pack
// ships an undo of its own (UNDO@rule).
//
//   undoOnItem(ctx, {item, writer, provenance, seesPrivate})
//     ctx       {state, bus, elements (the element store, graph.elements),
//               commentEvent (routes/elements commentEventFor: the comment
//               write's ring event, the chain_private rule's one home)}
//     item      a pane or markdown item id, or null: every item on the page
//               (the answer names the item undone)
//     writer    the caller's stamp {class, owner, verified} (routes/elements
//               stampOf over writers.resolveWriter)
//     → {ok: true, undone: {id, type, v, item, how: 'removed' | 'reverted',
//        to_v?, now_v?}, newer?: [{id, type, writer_class}], hint?}
//        (v: the version retracted; to_v: the version whose payload the
//        revert holds; now_v: the appended version, the live one now)
//     → {ok: false, status: 409, error: 'nothing to undo', hint, newer?}
//
// THE CANDIDATES: every live comment copy (state.comments, at its pin's v)
// and every live page element reference (element-refs refsOf, at its id@v),
// whose live version's anchor names `item` (element-refs anchorItem, the one
// item rule: an anchor's mount, a markdown source's md, a page record's item,
// a box grab's rect.item). Never one of these:
//   * a chat element (UNDO@scope: chat is out; the surface never holds one,
//     and a reference whose type is chat-family is skipped all the same);
//   * a committed version (homeOf names its node: the scope ends at the node
//     commit; the graph and the inspector's version history are the way back);
//   * a private one, for a reader that does not see private records
//     (audience.seesPrivate: AD5/J2, C-16-2) — not picked, not named.
//
// THE STEP BACK (U518b; form 5 AR1 = b, DECISIONS N.5): a version the undo
// wrote (store.revertElement, marked by domain/elements revertedTo with the v
// it restores) retracts its parent, so it is never itself undone: a
// candidate's ACTION is its live version read through every revert to the
// version that revert restores (actionOf). Repeated undo so walks the caller's
// older actions — on one element its edits newest first down to its create,
// then the next element — and never toggles between the last two versions.
// The action is what the pick reads (its writer, its seq) and what the act
// retracts; the live version stays what the act appends after (parent_v).
//
// THE PICK (AF10: attribution picks, it protects nothing — C-15-1..3): among
// the candidates whose action's writer.owner is the caller's, the one whose
// action has the greatest seq. Another writer's action newer than it on the
// same item is named in `newer` and the hint, and left as it is — never a
// refusal keyed on writer. When the caller wrote none: 409 'nothing to undo',
// the hint naming any other writer's version there and the inspector's history.
// A walk that reaches a version a commit names is no candidate either (AF9:
// the scope ends at the node commit, so a revert back to a committed version —
// an ordinary one or a committed revert — is the last step; the walk never
// passes through it to an older action).
//
// THE ACT, on the action vA, as the equivalent write makes it:
//   v1  → domain/comments removeElement (the tray's Delete path): nothing is
//         appended to the log (C2), its frame sent;
//   vA  → store.revertElement(id, toV, {parentV: the live v, …}): one appended
//         version whose payload is toV's (the version vA's parent_v names, else
//         A − 1), then announced as an edit — a comment's pin replaced in
//         state.comments and emitComments with op 'edit' (became_shared /
//         became_private as the PATCH computes them); any other type's
//         reference moved (putRef) and emitElements with elementEvent 'edit'
//         and was_shared — so the wake policy treats an undo exactly as that
//         edit.
// A deletion is not a version and is never undone here.

const { parsePin } = require('../../core/element-log');
const { revertedTo } = require('./elements');
const { refsOf, putRef, anchorItem } = require('./element-refs');
const { emitComments, emitElements, elementEvent, removeElement } = require('./comments');

const CHAT_FAMILY = 'chat';
const COMMENT = 'comment';
const isPosInt = (n) => Number.isSafeInteger(n) && n > 0;
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

const NOTHING_ERROR = 'nothing to undo';
const NOTHING_HINT = 'nothing you annotated here is live since the last commit; a committed or deleted annotation comes back from the graph (the inspector\'s version history)';
const PAGE_NOTHING_HINT = 'nothing you annotated on this page is live since the last commit; a committed or deleted annotation comes back from the graph (the inspector\'s version history)';

const typeWords = (type) => String(type || 'element').replace(/-/g, ' ');

// The action a live version shows (THE STEP BACK): the version itself, or,
// for a revert, the action of the version it restores — each revert restores
// an earlier v, so the walk ends. The walk ends at the first version a commit
// names (AF9: the scope ends at the node commit): that version, whether an
// ordinary one or itself a revert, is no action of the live scope, so the
// candidate is out (null) — the revert back to it was the last step.
function actionOf(store, id, ver) {
  let cur = ver;
  for (let to = revertedTo(cur); to != null; to = revertedTo(cur)) {
    const next = store.version(id, to);
    if (!next) break;
    if (store.homeOf(id, next.v) != null) return null;
    cur = next;
  }
  return cur;
}

// What one live element offers the undo: its live version, the action it
// shows, and who wrote that action.
function liveOf(store, state, seesPrivate) {
  const out = [];
  const take = (id, v, extra) => {
    if (typeof id !== 'string' || !id || !isPosInt(v)) return;
    const ver = store.version(id, v);
    if (!ver) return;
    if (store.homeOf(id, v) != null) return;
    const payload = isObj(ver.payload) ? ver.payload : {};
    const shared = payload.shared !== false;
    if (!shared && !seesPrivate) return;
    const act = actionOf(store, id, ver);
    if (!act) return;
    const w = isObj(act.writer) ? act.writer : null;
    out.push({
      id, v, ver, act, shared,
      seq: Number.isFinite(act.seq) ? act.seq : 0,
      item: anchorItem(payload),
      owner: w && typeof w.owner === 'string' ? w.owner : null,
      writerClass: w && typeof w.class === 'string' ? w.class : null,
      ...extra,
    });
  };
  for (const pin of Array.isArray(state.comments) ? state.comments : []) {
    if (pin && typeof pin.id === 'string') take(pin.id, pin.v, { type: COMMENT, pin });
  }
  for (const ref of refsOf(state)) {
    const p = parsePin(ref);
    if (!p) continue;
    const type = store.typeOf(p.id);
    if (!type || type === COMMENT || store.familyOf(type) === CHAT_FAMILY) continue;
    take(p.id, p.v, { type });
  }
  return out;
}

const bySeq = (a, b) => b.seq - a.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const named = (c) => ({ id: c.id, type: c.type, writer_class: c.writerClass });
const describe = (c) => `${typeWords(c.type)} by ${c.writerClass || 'an unknown writer'}`;

function newerHint(newer) {
  if (!newer.length) return null;
  if (newer.length === 1) return `a newer annotation on this pane is ${describe(newer[0])}; it was left as it is`;
  return `newer annotations on this pane are ${newer.map(describe).join(', ')}; they were left as they are`;
}

function undoOnItem(ctx, { item = null, writer, provenance = null, seesPrivate = false } = {}) {
  const { state, bus, elements: store, commentEvent } = ctx || {};
  if (!store || !state || !bus) throw new TypeError('undoOnItem: ctx {state, bus, elements}');
  if (typeof commentEvent !== 'function') throw new TypeError('undoOnItem: ctx.commentEvent (routes/elements commentEventFor)');
  if (!isObj(writer)) throw new TypeError('undoOnItem: the caller\'s writer stamp');
  const owner = typeof writer.owner === 'string' && writer.owner ? writer.owner : null;
  const want = typeof item === 'string' && item ? item : null;

  const live = liveOf(store, state, seesPrivate === true).filter((c) => want == null || c.item === want);
  const mine = owner == null ? [] : live.filter((c) => c.owner === owner).sort(bySeq);
  const picked = mine[0] || null;

  if (!picked) {
    const others = live.filter((c) => c.owner !== owner).sort(bySeq);
    const lead = want == null ? PAGE_NOTHING_HINT : NOTHING_HINT;
    const hint = others.length
      ? `${lead}; the newest annotation ${want == null ? 'on this page' : 'here'} is ${describe(others[0])}, left as it is`
      : lead;
    return { ok: false, status: 409, error: NOTHING_ERROR, hint, ...(others.length ? { newer: others.map(named) } : {}) };
  }

  const newer = live.filter((c) => c.owner !== owner && c.item === picked.item && c.seq > picked.seq).sort(bySeq);
  const act = picked.act;
  const undone = { id: picked.id, type: picked.type, v: act.v, item: picked.item };

  if (act.v === 1) {
    // The create: the tray's Delete path (C2: nothing appended).
    removeElement(state, bus, picked.id, { elements: store });
    undone.how = 'removed';
  } else {
    const toV = isPosInt(act.parent_v) ? act.parent_v : act.v - 1;
    const r = store.revertElement(picked.id, toV, { parentV: picked.v, writer, provenance });
    undone.how = 'reverted';
    undone.to_v = toV;
    if (picked.type === COMMENT) {
      const prev = picked.pin;
      const pin = r.pin;
      const idx = state.comments.findIndex((c) => c && c.id === picked.id);
      // A new array (the bus ring and a queued item may hold the old one).
      const next = state.comments.slice();
      if (idx >= 0) next[idx] = pin;
      state.comments = next;
      const becameShared = !prev.shared && pin.shared;
      const becamePrivate = prev.shared && !pin.shared;
      emitComments(state, bus, commentEvent({ kind: 'comment', op: 'edit', pin, became_shared: becameShared, became_private: becamePrivate }));
      undone.now_v = pin.v;
    } else {
      const rec = r.element;
      putRef(state, rec.id, rec.v);
      emitElements(state, bus, store, picked.type, { ...elementEvent(state, 'edit', rec), was_shared: picked.shared });
      undone.now_v = rec.v;
    }
  }
  const out = { ok: true, undone };
  if (newer.length) {
    out.newer = newer.map(named);
    out.hint = newerHint(newer);
  }
  return out;
}

module.exports = { undoOnItem, NOTHING_ERROR };
