'use strict';
// A v3 project on disk, for the v3→v4 comment migration's tests (U204) and for
// the units that build on it (U209's reconcile, U240's end-to-end): node files,
// graph/_meta.json, draft.json and `_version.json` {version: 3}, written the way
// a 0.8.5 daemon writes them (domain/turns commitNode's node shape, the comment
// routes' pin shape).
//
// v3Graph(root, opts) → {root, stateDir, paths, nodes, active, draft, cases, asideSeq}
//
// THE FIXED GRAPH (the default), every case GT-09 names:
//
//   n1 ─ n2 ─┬─ n3 ─ n4        branch A
//            └─ n5 ─ n6        branch B (active; the draft sits on n6)
//
//   c1  anchored on m-a everywhere. The fork's two branches append CONFLICTING
//       replies (n3 'A says', n5 'B says'); n4 replaces n3's reply with an
//       edited one: a NON-PREFIX edge (n4's replies do not extend n3's).
//   c2  a PAGE NOTE (anchor null) with NO `replies` key at all.
//   c4  anchored on m-b, which exists only on n1: n2's copy is the first ghost,
//       n3's an unchanged ghost (parked under b2), n4's a ghost a reply landed
//       on (a changed ghost: kept).
//   c5  edited to the same text with the same seq on both branches (n3, n5): an
//       equal-hash, equal-parent_v twin whose home (n3) is on the other branch,
//       so C1 refuses the reuse at n5 and n5 mints its own version.
//   c9  a RE-MINTED id: n4 (branch A) and n6 (branch B) each hold a c9 with a
//       different created_at (a 0.8.5 daemon minted the id twice, G-9).
//   draft.json (base_active n6): c1 with one more reply, and a new pin c21.
//   graph/n9.json.corrupt-<ts>: an unreadable node file set aside, holding
//       '"seq":42' — an id the migration must never mint again.
//
// opts:
//   unmappable: true | 'no-id' | 'no-created_at' | 'anchor-without-mount' |
//               'duplicate-id-in-node'  add one copy strict refuses, on n2
//   staleDraft: true    the draft's base_active is n4, not the active n6
//   noDraft: true       no draft.json
//   secret: '<text>'    appended to c1's text on n1 (and every later copy)
//   scale: {nodes, copies, seed}  instead of the fixed graph, a seeded synthetic
//                       one: `nodes` nodes (mostly a chain, a fork about every
//                       tenth node), each carrying up to `copies` pins that are
//                       edited, replied to and ghosted at random
//   version: 3          the `_version.json` stamped (null: none written)
//
// Test support only; it writes with plain fs on purpose (a fixture is not a
// durable record).

const fs = require('fs');
const path = require('path');
const { projectPaths } = require('../lib/core/paths');

const T0 = 1760000000000;
const ASIDE_SEQ = 42;

const writeJson = (file, v) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(v, null, 2));
};

const mount = (id) => ({ id, html: `<section id="${id}"><p class="lead">Pane ${id}</p></section>`, owner: 'claude' });
const anchorOn = (m, text, ordinal = 0) => ({ mount: m, selector: 'p.lead', text, ordinal });
const clone = (v) => JSON.parse(JSON.stringify(v));

function node(id, parent, i, mounts, comments, extra = {}) {
  return {
    id,
    parent_id: parent,
    created_at: T0 + i * 1000,
    author: 'claude',
    trigger: { kind: 'turn', message: `turn ${i}`, summary: `turn ${i}` },
    mounts: mounts.map(mount),
    store: {},
    comments,
    captures: [],
    ...extra,
  };
}

function fixedGraph(opts) {
  const sec = opts.secret ? ` ${opts.secret}` : '';
  const c1 = { id: 'c1', seq: 1, created_at: T0 + 100, shared: true, text: `first${sec}`, anchor: anchorOn('m-a', 'Pane m-a'), replies: [] };
  const c2 = { id: 'c2', seq: 2, created_at: T0 + 200, shared: false, text: 'page note', anchor: null };
  const c4 = { id: 'c4', seq: 4, created_at: T0 + 400, shared: true, text: 'on the second pane', anchor: anchorOn('m-b', 'Pane m-b'), replies: [] };
  const c5 = { id: 'c5', seq: 3, created_at: T0 + 300, shared: true, text: 'draft wording', anchor: anchorOn('m-a', 'Pane m-a', 1), replies: [] };
  const c5edit = { ...clone(c5), text: 'settled wording', seq: 8 };
  const replyA = { author: 'user', text: 'A says', at: T0 + 3100 };
  const replyB = { author: 'claude', text: 'B says', at: T0 + 5100 };
  const c1A = { ...clone(c1), replies: [replyA], seq: 5 };
  const c1Aedit = { ...clone(c1), replies: [{ ...replyA, text: 'A says (edited)' }], seq: 9 };
  const c1B = { ...clone(c1), replies: [replyB], seq: 6 };
  const c4reply = { ...clone(c4), replies: [{ author: 'user', text: 'reply on a ghost', at: T0 + 4100 }], seq: 10 };
  const c9a = { id: 'c9', seq: 11, created_at: T0 + 4200, shared: true, text: 'minted on A', anchor: anchorOn('m-a', 'Pane m-a', 2), replies: [] };
  const c9b = { id: 'c9', seq: 12, created_at: T0 + 6200, shared: true, text: 'minted again on B', anchor: anchorOn('m-a', 'Pane m-a', 3), replies: [] };

  const n1 = node('n1', null, 1, ['m-a', 'm-b'], [clone(c1), clone(c2), clone(c4)]);
  const n2c = [clone(c1), clone(c2), clone(c4), clone(c5)];
  if (opts.unmappable) {
    const kind = opts.unmappable === true ? 'no-id' : opts.unmappable;
    const bad = { id: 'c30', seq: 30, created_at: T0 + 2300, shared: true, text: 'unmappable', anchor: anchorOn('m-a', 'x'), replies: [] };
    if (kind === 'no-id') delete bad.id;
    else if (kind === 'no-created_at') delete bad.created_at;
    else if (kind === 'anchor-without-mount') bad.anchor = { selector: 'p', text: 'x', ordinal: 0 };
    else if (kind === 'duplicate-id-in-node') bad.id = 'c1';
    else throw new Error(`v3Graph: unknown unmappable kind ${kind}`);
    n2c.push(bad);
  }
  const n2 = node('n2', 'n1', 2, ['m-a'], n2c);
  const n3 = node('n3', 'n2', 3, ['m-a'], [clone(c1A), clone(c2), clone(c4), clone(c5edit)]);
  const n4 = node('n4', 'n3', 4, ['m-a'], [clone(c1Aedit), clone(c2), clone(c4reply), clone(c5edit), clone(c9a)]);
  const n5 = node('n5', 'n2', 5, ['m-a'], [clone(c1B), clone(c2), clone(c5edit)]);
  const n6 = node('n6', 'n5', 6, ['m-a'], [clone(c1B), clone(c2), clone(c5edit), clone(c9b)]);
  const nodes = [n1, n2, n3, n4, n5, n6];
  const active = 'n6';
  const draftComments = [
    { ...clone(c1B), replies: [replyB, { author: 'user', text: 'draft reply', at: T0 + 7100 }], seq: 20 },
    clone(c2), clone(c5edit), clone(c9b),
    { id: 'c21', seq: 21, created_at: T0 + 7200, shared: true, text: 'a pin only the draft holds', anchor: anchorOn('m-a', 'Pane m-a', 4), replies: [] },
  ];
  const cases = {
    conflict: { id: 'c1', fork: 'n2', nodes: ['n3', 'n5'] },
    nonPrefix: { id: 'c1', node: 'n4', parent: 'n3' },
    c1Refused: { id: 'c5', twin: 'n3', node: 'n5' },
    ghosts: { id: 'c4', present: 'n1', firstGhost: 'n2', unchangedGhost: 'n3', changedGhost: 'n4' },
    pageNote: { id: 'c2' },
    noReplies: { id: 'c2' },
    reminted: { id: 'c9', nodes: ['n4', 'n6'] },
    draft: { ids: ['c1', 'c2', 'c5', 'c9', 'c21'], newId: 'c21' },
  };
  return { nodes, active, draftComments, cases, draftBase: opts.staleDraft ? 'n4' : active };
}

// mulberry32, as test-support/fake-secrets.js seeds it.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scaledGraph({ nodes: count = 100, copies: k = 14, seed = 1 } = {}) {
  const r = rng(seed);
  const MOUNTS = ['m-0', 'm-1', 'm-2', 'm-3'];
  let seq = 0;
  let pinNo = 0;
  const nodes = [];
  for (let i = 1; i <= count; i++) {
    const parent = i === 1 ? null : (r() < 0.1 ? nodes[Math.floor(r() * nodes.length)] : nodes[nodes.length - 1]);
    const mounts = MOUNTS.filter((m, j) => j === 0 || r() < 0.85);
    const comments = [];
    for (const p of (parent ? parent.comments : [])) {
      const c = clone(p);
      const x = r();
      if (x < 0.06) { c.replies = (c.replies || []).concat([{ author: r() < 0.5 ? 'user' : 'claude', text: `reply ${seq + 1}`, at: T0 + i * 1000 + 1 }]); c.seq = ++seq; }
      else if (x < 0.09) { c.text = `${c.text} (edit ${seq + 1})`; c.seq = ++seq; }
      comments.push(c);
    }
    while (comments.length < k) {
      const s = ++seq;
      pinNo++;
      const m = MOUNTS[Math.floor(r() * MOUNTS.length)];
      comments.push({ id: `c${s}`, seq: s, created_at: T0 + i * 1000 + comments.length, shared: r() < 0.8, text: `pin ${pinNo}`, anchor: r() < 0.08 ? null : anchorOn(m, `Pane ${m}`, comments.length % 3), replies: [] });
    }
    nodes.push(node(`n${i}`, parent ? parent.id : null, i, mounts, comments));
  }
  const last = nodes[nodes.length - 1];
  return { nodes, active: last.id, draftComments: clone(last.comments).slice(0, 2), cases: {}, draftBase: last.id };
}

function v3Graph(root, opts = {}) {
  const paths = projectPaths(root);
  const g = opts.scale ? scaledGraph(opts.scale) : fixedGraph(opts);
  if (opts.staleDraft && opts.scale) g.draftBase = g.nodes[0].id;
  fs.mkdirSync(paths.graphDir, { recursive: true });
  for (const n of g.nodes) writeJson(path.join(paths.graphDir, `${n.id}.json`), n);
  writeJson(paths.meta, { active: g.active, lock: null, pending_bookmark: null, pending_folded: [], pending_folded_dropped: 0 });
  // The aside a 0.8.5 daemon left of a node file it could not read.
  fs.writeFileSync(path.join(paths.graphDir, 'n9.json.corrupt-1760000009000'), `{"id":"n9","comments":[{"id":"c42","seq":${ASIDE_SEQ},"text":"lost`);
  let draft = null;
  if (!opts.noDraft) {
    const last = g.nodes.find((n) => n.id === g.draftBase) || g.nodes[g.nodes.length - 1];
    draft = {
      schema_version: 1,
      base_active: g.draftBase,
      mounts: clone(last.mounts),
      store: {},
      comments: g.draftComments,
      captures: [],
      queue: [],
    };
    writeJson(paths.draft, draft);
  }
  const version = opts.version === undefined ? 3 : opts.version;
  if (version != null) fs.writeFileSync(paths.version, JSON.stringify({ version }, null, 2) + '\n');
  return { root, stateDir: paths.dir, paths, nodes: g.nodes, active: g.active, draft, cases: g.cases, asideSeq: ASIDE_SEQ };
}

module.exports = { v3Graph, T0, ASIDE_SEQ };
