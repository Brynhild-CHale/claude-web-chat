'use strict';
// A large v3 project with seeded fakes, for the v3→v4 planner's timing and its
// frozen plans (U248; GT-09.C-1's shape, read in-repo).
//
// It re-creates the shape the gate's C-1 row writes (the F5 adapter's --built
// branch: the synthetic generator at 14 elements a page, life 20, seeded fakes
// in a quarter of the pin texts and an eighth of the anchor texts, mounts [] on
// every node) with NO design/ input: the generator is ported here, and its one
// corpus input — the note's pretty-printed size, drawn per id@v — is a fixed
// table of the corpus's 5 % quantiles (sizes only, never a corpus text).
//
//   scaleFakesGraph({n = 3000, elements = 14, life = 20, seed = 0xF5}) → nodes
//   writeScaleFakes(root, nodes) → projectPaths(root)
//       graph/<id>.json pretty-printed, graph/_meta.json {active: the last
//       node}, _version.json {version: 3}: what a 0.8.5 daemon leaves
//   planDigest(stateDir) → {digest, plan}
//       planMigration over readProject(stateDir) and a dry-run open of the
//       element log, and the plan's digest: stableHash of {rest, actions, pins,
//       draft, states} ({actions, detail, ...rest} = plan; a commit action's
//       node replaced by its id; pins, draft and states read off `detail`).
//       Never called inside a timed run.
//
// Test support only; it writes with plain fs on purpose (a fixture is not a
// durable record), as test-support/v3-graph.js does.

const fs = require('fs');
const path = require('path');
const { projectPaths } = require('../lib/core/paths');
const { stableHash } = require('../lib/core/stable-json');
const { createRedactor } = require('../lib/core/redact');
const { createElementLog } = require('../lib/core/element-log');
const { readProject, planMigration } = require('../lib/core/element-migrate');
const { fakeSecrets, mulberry32 } = require('./fake-secrets');

// The corpus's per-copy pretty-printed sizes at every 5 % quantile (0 … 100 %).
const NOTE_SIZES = [326, 505, 573, 607, 607, 730, 773, 875, 886, 958, 1017, 1078, 1135, 1221, 1365, 1471, 1484, 1569, 1669, 1930, 2472];
const T_BASE = 1784236000000;
const WORDS = 'anchor pane node graph branch version thread reply mark highlight note page element store fold commit render layout diff resolve orphan migrate ledger index search token service'.split(' ');

const seedOfText = (s) => parseInt(stableHash(s).slice(0, 8), 16);

function filler(seedStr, len) {
  const r = mulberry32(seedOfText(seedStr));
  let s = '';
  while (s.length < len) s += WORDS[Math.floor(r() * WORDS.length)] + ' ';
  return s.slice(0, len);
}

const noteSize = (key) => NOTE_SIZES[Math.floor(mulberry32(seedOfText(key))() * NOTE_SIZES.length)];

// Parent per node: a new root with p 1/60, else the previous node with p 0.97,
// else a node 2–20 back (a fork).
function topologyOf(n, seed) {
  const r = mulberry32(seed);
  const parent = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    if (r() < 1 / 60) { parent[i] = null; continue; }
    parent[i] = r() < 0.97 ? i - 1 : Math.max(0, i - 2 - Math.floor(r() * 19));
  }
  return parent;
}

// The stub element copy of slot s, generation g, version v: a pure function of
// (id, v), so a copy of id@v is byte-equal on every node that holds it.
function elementCopy(s, g, v) {
  const id = `e${s}_${g}`;
  const kind = ['note', 'highlight', 'mark'][s % 3];
  const anchor = { mount: `pane-${s % 7}`, path: `div.section:nth(${s % 9}) > p:nth(${(s * 3) % 7})`, fingerprint: { tag: 'p', text: filler(`fp${id}`, 60) } };
  const base = { id, v, kind, created_at: T_BASE + g * 1000 + s, seq: s + 1, shared: s % 5 !== 0, anchor };
  if (kind === 'note') {
    const target = noteSize(`${id}@${v}`);
    const shell = { ...base, text: '', replies: Array.from({ length: v - 1 }, (_, k) => ({ author: k % 2 ? 'claude' : 'user', at: T_BASE + g * 1000 + k * 37, text: '' })) };
    const room = Math.max(40, target - JSON.stringify(shell, null, 2).length);
    const share = Math.floor(room / v);
    return { ...shell, text: filler(`t${id}`, room - share * (v - 1)), replies: shell.replies.map((r, k) => ({ ...r, text: filler(`r${id}${k}`, share) })) };
  }
  if (kind === 'highlight') return { ...base, text: filler(`h${id}`, 120), color: ['gold', 'green', 'rust'][v - 1], note: v > 1 ? filler(`hn${id}${v}`, 80) : '' };
  return { ...base, text: filler(`m${id}`, 40), color: ['gold', 'green', 'rust'][v - 1], shape: 'circle' };
}

function scaleFakesGraph({ n = 3000, elements = 14, life = 20, seed = 0xF5 } = {}) {
  const FAKES = fakeSecrets({ seed: 0x0909 }).filter((f) => !f.context && !f.known);
  const seedOf = (id) => seedOfText(`fake:${id}`);
  const seedOfAnchor = (id) => seedOfText(`fake-anchor:${id}`);
  const parent = topologyOf(n, seed);
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const comments = [];
    for (let s = 0; s < elements; s++) {
      const phase = (s * 7919) % life;
      const g = Math.floor((i + phase) / life);
      const age = (i + phase) % life;
      const v = 1 + Math.floor((age * 3) / life);
      const c = elementCopy(s, g, v);
      let text = c.text;
      if (c.color) text += ` [${c.color}${c.shape ? ` ${c.shape}` : ''}${c.note ? ` ${c.note}` : ''}]`;
      const k = seedOf(c.id);
      if (k % 4 === 0) text += ` ${FAKES[k % FAKES.length].text}`;
      let anchorText = c.anchor.fingerprint.text;
      const k2 = seedOfAnchor(c.id);
      if (k2 % 8 === 0) anchorText += ` ${FAKES[k2 % FAKES.length].text}`;
      comments.push({ id: c.id, seq: c.seq + c.v, created_at: c.created_at, shared: c.shared, text, anchor: { mount: c.anchor.mount, selector: 'p', text: anchorText, ordinal: s % 7 }, replies: c.replies || [] });
    }
    nodes.push({ id: `n${i}`, parent_id: parent[i] == null ? null : `n${parent[i]}`, created_at: T_BASE + i * 60000, mounts: [], comments });
  }
  return nodes;
}

function writeScaleFakes(root, nodes) {
  const p = projectPaths(root);
  fs.mkdirSync(p.graphDir, { recursive: true });
  for (const n of nodes) fs.writeFileSync(path.join(p.graphDir, `${n.id}.json`), JSON.stringify(n, null, 2));
  fs.writeFileSync(p.meta, JSON.stringify({ active: nodes.length ? nodes[nodes.length - 1].id : null }, null, 2));
  fs.writeFileSync(p.version, JSON.stringify({ version: 3 }) + '\n');
  return p;
}

function digestOf(plan) {
  const { actions, detail, ...rest } = plan;
  return stableHash({
    rest,
    actions: actions.map((a) => (a.op === 'commit' ? { ...a, node: a.node.id } : a)),
    pins: [...detail.pins],
    draft: detail.draft,
    states: [...detail.states],
  });
}

function planDigest(stateDir) {
  const paths = projectPaths(path.dirname(stateDir));
  const redactor = createRedactor();
  const log = createElementLog({ file: paths.elementsLog, redactor, dryRun: true });
  try {
    log.load();
    const { nodes, meta, draft, asides } = readProject(stateDir);
    const plan = planMigration({ nodes, meta, draft, log, asides, redact: (x) => redactor.value(x) });
    return { digest: digestOf(plan), plan };
  } finally {
    log.close();
  }
}

module.exports = { scaleFakesGraph, writeScaleFakes, planDigest, digestOf, NOTE_SIZES };
