// The v3→v4 planner at scale (U248; GT-09.C-1's shape, test-support/v3-scale-fakes).
//
// Two shapes, chosen by the environment so the suite stays quick and never
// flakes on a timing:
//   default            300 nodes x 14 (4,200 copies): the plan's digest, no time bound.
//   WEB_CHAT_BENCH=1   3,000 x 14 (42,000 copies): its digest, then migrateComments
//                      (dryRun) once warm and 5 times timed with a full GC before
//                      each; derive_ms (planMigration alone) printed with the 5 runs
//                      and the load average before and after, and a loose bound
//                      (median <= 600 ms). The 230 ms line binds only at the gate.
// The digest is computed by one separate planMigration call, never inside a
// timed run. Both digests were recorded on the planner as ae/int 8a889f8 left it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scaleFakesGraph, writeScaleFakes, planDigest } = require('../test-support/v3-scale-fakes');
const { migrateComments } = require('../lib/core/element-migrate');
const { createRedactor } = require('../lib/core/redact');

const BENCH = process.env.WEB_CHAT_BENCH === '1';
const RUNS = 5;

function project(t, n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-v3-scale-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  return writeScaleFakes(root, scaleFakesGraph({ n, elements: 14 }));
}

function fullGc() {
  try {
    require('v8').setFlagsFromString('--expose-gc');
    return require('vm').runInNewContext('gc');
  } catch {
    return null;
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

test('the 300 x 14 seeded-fakes project plans exactly as at 8a889f8', { skip: BENCH && 'WEB_CHAT_BENCH=1 runs the 3,000 x 14 shape' }, (t) => {
  const p = project(t, 300);
  const { digest, plan } = planDigest(p.dir);
  assert.strictEqual(plan.copies, 4200);
  assert.strictEqual(plan.actions.filter((a) => a.op === 'ver').length, 772);
  assert.strictEqual(digest, '1b5d73c82f2efa468c341584d5b98d6f9363279a');
});

test('the 3,000 x 14 seeded-fakes project: its plan, and derive_ms over 5 quiet runs', { skip: !BENCH && 'set WEB_CHAT_BENCH=1 for the 3,000 x 14 timing' }, (t) => {
  const p = project(t, 3000);
  const { digest, plan } = planDigest(p.dir);
  assert.strictEqual(plan.copies, 42000);
  assert.strictEqual(plan.actions.filter((a) => a.op === 'ver').length, 7865);
  assert.strictEqual(digest, 'b1fbc4bed7df80d205e018800122bb8ebb90a47e');

  const gc = fullGc();
  const runs = [];
  if (gc) gc();
  const loadBefore = os.loadavg();
  for (let k = 0; k <= RUNS; k++) {
    if (gc) gc();
    const d = migrateComments(p.dir, { dryRun: true, redactor: createRedactor() });
    assert.ok(d.ok && d.dry_run, 'the dry run answers ok');
    if (k > 0) runs.push(d.report.derive_ms);
  }
  const loadAfter = os.loadavg();
  const med = median(runs);
  const la = (l) => l.map((x) => x.toFixed(2)).join(' / ');
  t.diagnostic(`derive_ms median ${med} ms; runs ${runs.join(', ')}; gc ${gc ? 'before each run' : 'unavailable'}`);
  t.diagnostic(`loadavg (1 / 5 / 15 min) before ${la(loadBefore)}; after ${la(loadAfter)}`);
  assert.ok(med <= 600, `derive_ms median ${med} ms is over the loose 600 ms bound`);
});
