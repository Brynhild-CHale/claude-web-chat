// What lies under ONE stroke, taken at create (annotation engine tranche 4,
// plan 4F.2, U562; DECISIONS.md N.1 AD3, AD5; K.5 J2; D2; rulings STREAM@4F
// AF1 (a), U562@text-under-non-text (a), U513-U561@derived-fields-home (a);
// DESCRIBE@where: the text under from the chrome at create).
//
// One deriver on the engine's stroke commit (target-frame.js
// registerStrokeDerive, U561's seam — this module never edits it), so any
// strokes type gets it and a pack ships no describe code (AD3). At a commit it
// reads the live DOM once, for the stroke's OWN box (its points' bboxOf, in
// frame units, mapped to client pixels through the target's rect), and
// answers three of lib/core/strokes' DESCRIBE_KEYS, top level on the payload:
//
//   bbox        the stroke's own box [x, y, w, h], frame units (1e-4)
//   text_under  what the stroke lies over, cut at TEXT_UNDER_MAX (…); omitted
//               when there is none:
//                 an <svg> target: its <text>/<tspan> nodes whose client rect
//                   meets the box;
//                 a [data-fixed-aspect] target, a pane frame's element, and
//                   a page stroke's items (THE FRAMES, below): its text
//                   nodes whose Range client rects meet the box;
//                 an <img>: its alt, else its aria-label, whole;
//                 a <canvas>: its aria-label, else its fallback content's
//                   text, whole — neither has text geometry (RULED
//                   U562@text-under-non-text (a)).
//   text_box    the union of the met text rects, frame units (1e-4); omitted
//               for an img or a canvas and when nothing met.
//
// The box "meets" a rect when they overlap, the box grown by MEET_PAD_PX
// above (an underline sits below its words) and 1 px elsewhere. Bounded: at
// most TEXT_NODES_MAX text nodes are inspected per stroke. It never reads
// outside the stroke's items (a TreeWalker rooted at the target, or at each
// item's root, enters no iframe and no nested shadow root) and never reads a
// frame.
//
// THE FRAMES (tranche 5, 5A.5, U622; REQ@ink-scope-v2, REQ@arrow-endpoints
// (a), DRIFT@beside). A target frame's or a pane frame's stroke (frame.kind
// 'target' or 'pane': the target is the fixed-aspect element, or the pane's
// outermost element, U611) reads its target as above — the Range path for
// prose. A PAGE stroke (frame.kind 'page', U612: its target is #main, its
// points and bbox in the page box's units, frame.rect that box at commit) is
// read from its ITEMS only, never from #main's tree: `items` lists the
// endpoints' items ({id, kind 'pane' | 'md', root, rect}, the from item
// first, one entry for an 'inside' or a 'beside' stroke), and each item's
// root — a pane's shadowRoot (a TreeWalker rooted at it walks that root's
// tree and enters no nested root and no iframe) or the markdown block — is
// walked by the Range path under ONE shared budget: TEXT_NODES_MAX text
// nodes over every item together. The texts join from-item first, each kept
// once, cut at TEXT_UNDER_MAX as for one target; text_box is the met rects'
// union in the page box's units. A margin stroke lying in a gutter meets no
// text and takes none. No items, no root, no page box: the bbox alone. The
// drift a re-wrap causes is the overlay's to measure (data-el-drift, U614);
// the daemon's describe carries only the frame word (DRIFT@beside).
//
// WHO SEES IT. The fields ride the stroke's own record, so a PRIVATE stroke's
// text is seen only by a reader that sees its private elements (a local
// browser, lib/server/audience.js) — never Claude, never a remote viewer. The
// log's one writer redacts the payload before the bytes land
// (lib/core/element-log appendVersion). The group's shape, count and box are
// composed on the daemon from the SHARED members alone (lib/core/ink-shape
// describeOf, lib/server/index.js elementWake); the text reaches Claude only
// as the excerpt, only while the excerpt switch is on.
import { registerStrokeDerive } from './target-frame.js';
import { bboxOf } from './strokes.js';

// lib/core/ink-shape's TEXT_UNDER_MAX (held equal by test/ink-describe-chrome).
export const TEXT_UNDER_MAX = 300;
export const TEXT_NODES_MAX = 200;
export const MEET_PAD_PX = 6;
const SKIP = new Set(['script', 'style', 'template', 'noscript', 'title', 'desc', 'metadata']);

const round4 = (v) => Math.round(v * 1e4) / 1e4;
const fold = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

function cut(s) {
  if (s.length <= TEXT_UNDER_MAX) return s;
  let kept = s.slice(0, TEXT_UNDER_MAX - 1);
  if (/[\ud800-\udbff]$/.test(kept)) kept = kept.slice(0, -1);
  return `${kept.trimEnd()}…`;
}

function rectOf(target, frame) {
  const b = target && typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null;
  if (b && b.width > 0 && b.height > 0) return { left: b.left, top: b.top, w: b.width, h: b.height };
  const r = frame && frame.rect;
  return r && r.w > 0 && r.h > 0 ? r : null;
}

const meets = (r, box) => r && (r.width > 0 || r.height > 0)
  && r.left <= box.right && r.left + r.width >= box.left && r.top <= box.bottom && r.top + r.height >= box.top;

// The text-geometry walk: the met nodes' text and the union of their met
// rects (client pixels), reading at most TEXT_NODES_MAX text nodes.
// `acc` (a page stroke's items, U622) carries the texts, the union and the
// nodes read so far from one root to the next, so the bound is shared.
function textUnder(target, box, svg, acc) {
  const doc = target.ownerDocument;
  const walker = doc.createTreeWalker(target, 4 /* NodeFilter.SHOW_TEXT */);
  const texts = acc ? acc.texts : [];
  let u = acc ? acc.union : null;
  let read = acc ? acc.read : 0;
  for (let n = walker.nextNode(); n && read < TEXT_NODES_MAX; n = walker.nextNode()) {
    read += 1;
    const t = fold(n.nodeValue);
    if (!t) continue;
    const parent = n.parentElement;
    if (!parent || SKIP.has(String(parent.localName || '').toLowerCase())) continue;
    let rects = [];
    if (svg) {
      // Only what an svg draws as text: a <text> or a <tspan>, its box.
      const host = typeof parent.closest === 'function' ? parent.closest('text, tspan') : null;
      if (!host || !target.contains(host)) continue;
      const r = typeof parent.getBoundingClientRect === 'function' ? parent.getBoundingClientRect() : null;
      if (r) rects = [r];
    } else {
      const range = doc.createRange();
      range.selectNodeContents(n);
      const list = typeof range.getClientRects === 'function' ? range.getClientRects() : null;
      rects = list ? Array.from(list) : [];
    }
    let hit = false;
    for (const r of rects) {
      if (!meets(r, box)) continue;
      hit = true;
      u = u
        ? { l: Math.min(u.l, r.left), t: Math.min(u.t, r.top), r: Math.max(u.r, r.left + r.width), b: Math.max(u.b, r.top + r.height) }
        : { l: r.left, t: r.top, r: r.left + r.width, b: r.top + r.height };
    }
    if (hit && !texts.includes(t)) texts.push(t);
  }
  if (acc) { acc.union = u; acc.read = read; }
  return { text: texts.join(' '), union: u, read };
}

// The client-pixel box a stroke's bbox covers in a rect, grown as `meets`
// reads it; and a union of met rects back in that rect's units.
const boxIn = (r, bbox) => ({
  left: r.left + bbox[0] * r.w - 1,
  top: r.top + bbox[1] * r.h - MEET_PAD_PX,
  right: r.left + (bbox[0] + bbox[2]) * r.w + 1,
  bottom: r.top + (bbox[1] + bbox[3]) * r.h + 1,
});
const unionIn = (u, r) => [
  round4((u.l - r.left) / r.w), round4((u.t - r.top) / r.h),
  round4((u.r - u.l) / r.w), round4((u.b - u.t) / r.h),
];

// A page stroke (U622): its items' roots, from-item first, under one budget.
function pageUnder(a, bbox, out) {
  const r = a.frame && a.frame.rect;
  if (!r || !(r.w > 0) || !(r.h > 0) || !Array.isArray(a.items)) return out;
  const box = boxIn(r, bbox);
  const acc = { texts: [], union: null, read: 0 };
  for (const it of a.items.slice(0, 2)) {
    if (acc.read >= TEXT_NODES_MAX) break;
    const root = it && typeof it === 'object' ? it.root : null;
    // A pane's shadowRoot (11) or the markdown block (1); anything else (a
    // closed or absent root) is not read.
    if (!root || (root.nodeType !== 11 && root.nodeType !== 1) || !root.ownerDocument) continue;
    textUnder(root, box, false, acc);
  }
  if (acc.texts.length) out.text_under = cut(acc.texts.join(' '));
  if (acc.union) out.text_box = unionIn(acc.union, r);
  return out;
}

// The deriver: registerStrokeDerive's fn({frame, points, bbox, target,
// items?}).
export function deriveDescribe(arg) {
  const a = arg && typeof arg === 'object' ? arg : {};
  const target = a.target || (a.frame && a.frame.target) || null;
  const bbox = Array.isArray(a.bbox) && a.bbox.length === 4 ? a.bbox : bboxOf(a.points || []);
  if (!bbox || !bbox.every((v) => Number.isFinite(v))) return {};
  const out = { bbox: bbox.map(round4) };
  if (a.frame && a.frame.kind === 'page') return pageUnder(a, bbox, out);
  if (!target || target.nodeType !== 1) return out;
  const tag = String(target.localName || '').toLowerCase();
  const attr = (k) => fold(typeof target.getAttribute === 'function' ? target.getAttribute(k) : '');
  if (tag === 'img') {
    const t = attr('alt') || attr('aria-label');
    if (t) out.text_under = cut(t);
    return out;
  }
  if (tag === 'canvas') {
    const t = attr('aria-label') || fold(target.textContent);
    if (t) out.text_under = cut(t);
    return out;
  }
  const r = rectOf(target, a.frame);
  if (!r) return out;
  const { text, union } = textUnder(target, boxIn(r, bbox), tag === 'svg');
  if (text) out.text_under = cut(text);
  if (union) out.text_box = unionIn(union, r);
  return out;
}

let unregister = null;
export function initInkDescribe() {
  if (unregister) return;
  unregister = registerStrokeDerive('describe', deriveDescribe);
}
