// Two real chromes through a real daemon (annotation engine PLAN.md 2B.1, §7
// obligation 8; GT-06's convergence clauses; U314): test-support/chrome-pair.js
// boots two bootShell chromes in child processes — a desktop and a phone, live
// setTimeout and requestAnimationFrame — each bridged to a withServer daemon's
// socket and reporting through public/app/overlay-report.js.
//
//   - 50 seeded surface changes in F9 C-9's shape (20 version steps of a pane,
//     15 re-renders of the same html, 15 unrelated store patches): at most one
//     report per change per viewer, under 1 % of anchors flapping, and at
//     quiescence the daemon's held answers equal each viewer's last answers;
//   - the ordered counter across a restore: Set active mid-run → every held
//     answer afterwards carries the new surface, and a report a child sent
//     before the reset (held on the wire across it) is refused stale-surface;
//   - a remote page with no transport registered sends no report on its
//     socket; one with a transport hands it every batch instead.
//
// The anchors: on each of four panes, five rows — three 0.8.5-shaped pins
// (converted pin-locator@1 anchors, found by their locator: re-resolved,
// their full record minted) and two engine records (exact), every one a live
// comment pin the daemon's hello carries.
const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer, waitUntil, commentBody } = require('../test-support/helpers');
const { spawnChrome, chromePair, DESKTOP } = require('../test-support/chrome-pair');
const { paneSpec, storeDigest } = require('../lib/server/domain/reports');

const SEED = 9009;
const PANES = ['p0', 'p1', 'p2', 'p3'];
const ROWS_N = 20;
const ANCHORED = [0, 4, 8, 12, 16];
const ENGINE = new Set([4, 12]);   // the rest are locator pins
const SKIPPED = 8;                 // the row a variant-1 version drops
const WORDS = ['harbor', 'quartz', 'lantern', 'meadow', 'cobalt', 'tundra', 'violet', 'ember', 'saffron', 'glacier',
  'orchard', 'pylon', 'marble', 'thistle', 'canyon', 'falcon', 'juniper', 'magnet', 'nectar', 'obsidian',
  'pewter', 'quiver', 'russet', 'sable', 'timber', 'umber', 'vortex', 'willow', 'zephyr', 'basalt', 'cinder',
  'dahlia', 'estuary', 'fennel', 'garnet', 'heron', 'indigo', 'jasper', 'kestrel', 'lichen', 'mosaic'];
const rowText = (id, i) => `${id}: ${WORDS[(i * 7) % WORDS.length]} ${WORDS[(i * 11 + 3) % WORDS.length]} ${WORDS[(i * 13 + 5) % WORDS.length]} — entry ${i}`;
// Three versions per pane, cycled: all rows; one anchored row dropped; an
// unanchored row inserted above the rest.
function paneHtml(id, variant) {
  const rows = [];
  if (variant === 2) rows.push(`<div class="it">${id}: a header row of its own words</div>`);
  for (let i = 0; i < ROWS_N; i++) if (!(variant === 1 && i === SKIPPED)) rows.push(`<div class="it">${rowText(id, i)}</div>`);
  return `<div class="list">${rows.join('')}</div>`;
}

function mulberry32(a) {
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function ok(p, what) {
  const r = await p;
  assert.ok(r.status === 200 && (!r.json || r.json.ok !== false), `${what}: ${r.status} ${r.text}`);
  return r.json;
}

// Four panes, five pins each (the engine records taken from a chrome's DOM).
async function seedSurface(d, recorder) {
  for (const id of PANES) await ok(d.api.post('/api/render', { id, html: paneHtml(id, 0) }), `render ${id}`);
  await recorder.call('mark');
  await recorder.call('settle', { frames: false, min: 300 });
  const pins = [];
  for (const id of PANES) {
    for (const i of ANCHORED) {
      const anchor = ENGINE.has(i)
        ? await recorder.call('record', { mount: id, selector: '.it', index: i })
        : { mount: id, selector: 'div.it', ordinal: i, text: rowText(id, i) };
      const r = await ok(d.anonApi.post('/api/elements', commentBody({ text: `note ${id}:${i}`, shared: true, anchor })), `pin ${id}:${i}`);
      pins.push({ id: r.pin.id, v: r.pin.v, mount: id, row: i, engine: ENGINE.has(i) });
    }
  }
  return pins;
}

// Mark every chrome, run the change, then wait for every chrome to go quiet.
async function change(chromes, fn, { frames = true, min = 150 } = {}) {
  await Promise.all(chromes.map((c) => c.call('mark')));
  await fn();
  return Promise.all(chromes.map((c) => c.call('settle', { frames, min })));
}

const itemsOf = (frames) => frames.flatMap((f) => f.mounts.flatMap((m) => m.items.map((i) => ({ ...i, mount: m.mount, gen: m.gen, surface: f.surface }))));
const keyOf = (mount, id, v) => `${mount}|${id}@${v}`;

// The daemon's held answers, as each viewer's `last` keys them.
function heldOf(d) {
  const out = {};
  for (const a of d.srv.reports.answers()) out[keyOf(a.mount, a.id, a.v)] = a;
  return out;
}
async function assertConverged(d, chromes, pins, what) {
  const held = heldOf(d);
  const surface = d.srv.reports.surface();
  assert.equal(Object.keys(held).length, pins.length, `${what}: one held answer per pin (${Object.keys(held).length})`);
  for (const a of Object.values(held)) {
    assert.equal(a.surface, surface, `${what}: ${a.id} held on the current surface`);
    assert.equal(a.gen, d.srv.state.mounts.get(a.mount).gen || 0, `${what}: ${a.id} held under its pane's current gen`);
  }
  for (const c of chromes) {
    const { surface: s, answers } = await c.call('last');
    assert.equal(s, surface, `${what}: ${c.name} on the daemon's surface`);
    for (const [k, a] of Object.entries(held)) {
      assert.ok(answers[k], `${what}: ${c.name} reported ${k}`);
      assert.equal(answers[k].state, a.state, `${what}: ${c.name}'s last answer for ${k} is the held one`);
    }
  }
}

test('two chromes, 50 seeded changes (C-9\'s shape): at most one report per change per viewer, < 1 % flapping, held = each viewer\'s last at quiescence', { timeout: 240000 }, async (t) => {
  const d = await withServer(t);
  const recorder = await spawnChrome(t, { port: d.port, name: 'recorder' });
  const pins = await seedSurface(d, recorder);
  await recorder.call('exit');
  const chromes = await chromePair(t, { port: d.port });
  // The first answers: each viewer's hello carries the pins (read from the boot on).
  const first = await Promise.all(chromes.map((c) => c.call('settle', { frames: false, min: 900 })));
  for (const [i, r] of first.entries()) {
    assert.equal(r.reports.length, 1, `${chromes[i].name}: one first report (${r.reports.length})`);
    const items = itemsOf(r.reports);
    assert.equal(items.length, pins.length, 'every pin answered');
    assert.ok(items.filter((x) => pins.find((p) => p.id === x.id).engine).every((x) => x.state === 'exact'), 'the engine records exact');
    const loc = items.filter((x) => !pins.find((p) => p.id === x.id).engine);
    assert.ok(loc.every((x) => x.state === 're-resolved' && x.how === 'locator' && x.record && x.record.kind === 'element'),
      'each locator pin re-resolved by its locator, its record minted');
  }
  await assertConverged(d, chromes, pins, 'after the first answers');

  // The run: 20 version steps, 15 same-html re-renders, 15 store patches.
  const rand = mulberry32(SEED);
  const kinds = [...Array(20).fill('version'), ...Array(15).fill('rerender'), ...Array(15).fill('store')];
  for (let i = kinds.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [kinds[i], kinds[j]] = [kinds[j], kinds[i]]; }
  const variant = Object.fromEntries(PANES.map((p) => [p, 0]));
  const lastState = chromes.map(() => new Map());   // per viewer: pin key → state last sent
  let flaps = 0;
  let opportunities = 0;
  let orphanSteps = 0;
  const perChange = [];
  for (let k = 0; k < kinds.length; k++) {
    const kind = kinds[k];
    const pane = PANES[Math.floor(rand() * PANES.length)];
    let changedPane = null;
    const results = await change(chromes, async () => {
      if (kind === 'version') {
        variant[pane] = (variant[pane] + 1) % 3;
        changedPane = pane;
        await ok(d.api.post('/api/render', { id: pane, html: paneHtml(pane, variant[pane]) }), `version ${pane}`);
      } else if (kind === 'rerender') {
        await ok(d.api.post('/api/render', { id: pane, html: paneHtml(pane, variant[pane]) }), `re-render ${pane}`);
      } else {
        await ok(d.api.post('/api/store', { patch: { unrelated: k } }), 'store patch');
      }
    }, { min: kind === 'version' && variant[pane] === 1 ? 650 : 150 });
    if (kind === 'version' && variant[pane] === 1) orphanSteps += 1;
    results.forEach((r, v) => {
      perChange.push({ k, kind, viewer: chromes[v].name, reports: r.reports.length });
      const seen = new Map();
      for (const it of itemsOf(r.reports)) {
        const key = keyOf(it.mount, it.id, it.v);
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push(it.state);
      }
      for (const p of pins) {
        const key = keyOf(p.mount, p.id, p.v);
        opportunities += 1;
        const states = seen.get(key) || [];
        const before = lastState[v].get(key);
        // A flap: two different answers for one change, or a different answer
        // on a change that left this pin's pane as it was.
        if (new Set(states).size > 1) flaps += 1;
        else if (states.length && p.mount !== changedPane && before !== undefined && states[0] !== before) flaps += 1;
        if (states.length) lastState[v].set(key, states[states.length - 1]);
      }
    });
    if (kind === 'version' && variant[pane] === 1) {
      const gone = pins.find((p) => p.mount === pane && p.row === SKIPPED);
      for (const [v] of chromes.entries()) {
        assert.equal(lastState[v].get(keyOf(gone.mount, gone.id, gone.v)), 'orphaned', `change ${k}: the dropped row reported orphaned by ${chromes[v].name}`);
      }
    }
  }
  const over = perChange.filter((c) => c.reports > 1);
  assert.deepEqual(over, [], 'at most one report per change per viewer');
  const sent = perChange.filter((c) => c.reports === 1).length;
  assert.ok(sent >= kinds.length, `the changes were reported (${sent} of ${perChange.length})`);
  assert.ok(orphanSteps > 0, 'a version step dropped an anchored row');
  const rate = flaps / opportunities;
  t.diagnostic(`reports: ${sent} of ${perChange.length} change×viewer slots sent one, ${over.length} more than one; flapping ${flaps}/${opportunities} = ${(rate * 100).toFixed(2)} %`);
  assert.ok(rate < 0.01, `flapping ${flaps}/${opportunities} = ${(rate * 100).toFixed(2)} %`);
  await assertConverged(d, chromes, pins, 'at quiescence');
  const st = d.srv.reports.stats();
  assert.equal(st.refused['stale-gen'] || 0, 0, 'no report under a stale gen');
  assert.equal(st.refused['stale-surface'] || 0, 0, 'no report under a stale surface');
  assert.equal(st.dropped_items.shape || 0, 0, 'no item dropped for its shape');
  assert.equal(st.dropped_items.record || 0, 0, 'no minted record refused');
  assert.ok(st.confirms > 0, 'the store patches were confirmed');
});

test('the ordered counter across a restore, two chromes: Set active mid-run → every held answer carries the new surface; a report sent before the reset is refused stale-surface', { timeout: 120000 }, async (t) => {
  const d = await withServer(t);
  const recorder = await spawnChrome(t, { port: d.port, name: 'recorder' });
  const pins = await seedSurface(d, recorder);
  await recorder.call('exit');
  const chromes = await chromePair(t, { port: d.port });
  const [a] = chromes;
  await Promise.all(chromes.map((c) => c.call('settle', { frames: false, min: 900 })));
  await ok(d.api.post('/api/turn-begin', { message: 'first' }), 'turn-begin');
  const n0 = (await ok(d.api.post('/api/turn-end', { author: 'claude', summary: 'first' }), 'turn-end')).node_id;
  // The run goes on: a version step and a re-render.
  await change(chromes, () => ok(d.api.post('/api/render', { id: 'p1', html: paneHtml('p1', 2) }), 'version p1'));
  await change(chromes, () => ok(d.api.post('/api/render', { id: 'p2', html: paneHtml('p2', 0) }), 're-render p2'));
  await ok(d.api.post('/api/turn-begin', { message: 'second' }), 'turn-begin');
  const n1 = (await ok(d.api.post('/api/turn-end', { author: 'claude', summary: 'second' }), 'turn-end')).node_id;
  assert.notEqual(n1, n0);
  const s0 = d.srv.reports.surface();

  // Chrome A's next report is held on the wire while the surface is restored.
  await a.call('hold');
  const held = await change([a], () => ok(d.api.post('/api/store', { patch: { unrelated: 1 } }), 'store patch'));
  assert.equal(held[0].reports.length, 1, 'A sent its report (held on the wire)');
  assert.equal(held[0].reports[0].surface, s0);
  const refusedBefore = d.srv.reports.stats().refused['stale-surface'] || 0;
  await change(chromes, () => ok(d.api.post('/api/graph/active', { id: n0 }), 'set active'), { min: 900 });
  const s1 = d.srv.reports.surface();
  assert.ok(s1 > s0, 'the reset bumped the counter');
  await a.call('release');
  await waitUntil(() => (d.srv.reports.stats().refused['stale-surface'] || 0) > refusedBefore, { timeout: 5000, what: 'the pre-reset report refused stale-surface' });

  // Every held answer afterwards carries the new surface, and the run converges.
  await change(chromes, () => ok(d.api.post('/api/render', { id: 'p3', html: paneHtml('p3', 1) }), 'version p3'), { min: 650 });
  await change(chromes, () => ok(d.api.post('/api/store', { patch: { unrelated: 2 } }), 'store patch'));
  const answers = d.srv.reports.answers();
  assert.equal(answers.length, pins.length);
  assert.ok(answers.every((x) => x.surface === s1), 'every held answer on the new surface');
  await assertConverged(d, chromes, pins, 'after the restore');
});

test('a store write that moves one anchored row of a store-driven pane: every held answer of the mount is re-stamped with the store now and recordable for the live content', { timeout: 120000 }, async (t) => {
  const d = await withServer(t);
  // A Claude pane that draws its rows from the store (a git, todo or service
  // board's shape); its answers are recordable (a service's are live-only).
  const rows = (drop = -1) => Array.from({ length: ROWS_N }, (_, i) => rowText('sd', i)).filter((_, i) => i !== drop);
  await ok(d.api.post('/api/store', { patch: { sd_rows: rows() } }), 'seed the rows');
  const html = `<div class="rows"></div><script>
    function draw(list) {
      var box = root.querySelector('.rows'); box.textContent = '';
      (list || []).forEach(function (r) { var el = document.createElement('div'); el.className = 'row'; el.textContent = r; box.appendChild(el); });
    }
    draw(store.get('sd_rows'));
    store.subscribe('sd_rows', draw);
  </script>`;
  await ok(d.api.post('/api/render', { id: 'sd', html }), 'render sd');
  // The pins (engine records from a recorder chrome), then the viewer: its
  // hello carries them.
  const recorder = await spawnChrome(t, { port: d.port, name: 'recorder' });
  await recorder.call('settle', { frames: false, min: 300 });
  const pins = [];
  for (const i of ANCHORED) {
    const anchor = await recorder.call('record', { mount: 'sd', selector: '.row', index: i });
    const r = await ok(d.anonApi.post('/api/elements', commentBody({ text: `note sd:${i}`, shared: true, anchor })), `pin sd:${i}`);
    pins.push({ id: r.pin.id, v: r.pin.v, row: i });
  }
  await recorder.call('exit');
  const c = await spawnChrome(t, { port: d.port, name: 'viewer' });
  await c.call('settle', { frames: false, min: 900 });
  await waitUntil(() => d.srv.reports.answers({ mount: 'sd' }).length === pins.length, { timeout: 10000, what: 'every pin answered' })
    .catch(async (e) => {
      throw new Error(`${e.message}: ${JSON.stringify({ daemon: d.srv.reports.stats(), chrome: await c.call('stats'), overlay: await c.call('overlay') })}`);
    });
  const before = d.srv.reports.answers({ mount: 'sd' });
  assert.ok(before.every((a) => a.state === 'exact'), JSON.stringify(before.map((a) => a.state)));

  // The last anchored row goes: its answer moves to orphaned, the rest stand.
  const gone = pins.find((p) => p.row === ANCHORED[ANCHORED.length - 1]);
  const [run] = await change([c], () => ok(d.api.post('/api/store', { patch: { sd_rows: rows(gone.row) } }), 'drop a row'), { min: 300 });
  assert.equal(run.reports.length, 1, `one report for the store change (${run.reports.length})`);
  const entries = run.reports[0].mounts.filter((m) => m.mount === 'sd');
  assert.deepEqual(entries.map((m) => m.items.map((i) => `${i.id}:${i.state}`)), [[], [`${gone.id}:orphaned`]],
    'one confirm, right ahead of the changed item');

  const held = d.srv.reports.answers({ mount: 'sd' });
  assert.equal(held.length, pins.length);
  const digest = storeDigest(d.srv.state.store);
  const orphan = held.find((a) => a.id === gone.id);
  assert.equal(orphan.state, 'orphaned');
  for (const a of held) {
    assert.equal(a.qual.store, digest, `${a.id} stamped with the store now`);
    assert.equal(a.storeEpoch, orphan.storeEpoch, `${a.id} under the current store epoch`);
  }
  const rec = d.srv.reports.recordable({ specOf: (m) => (d.srv.state.mounts.get(m) ? paneSpec(d.srv.state.mounts.get(m)) : null), storeDigest: digest });
  assert.deepEqual(rec.filter((a) => a.mount === 'sd').map((a) => a.id).sort(), pins.map((p) => p.id).sort(),
    'every held answer of the mount is recordable for the live content and store');
  assert.equal(d.srv.reports.stats().confirms, 1, 'one confirm for the one store change');
});

test('a remote page with no transport registered sends no report on its socket; with one, the transport takes every batch', { timeout: 120000 }, async (t) => {
  const d = await withServer(t);
  const recorder = await spawnChrome(t, { port: d.port, name: 'recorder' });
  const pins = await seedSurface(d, recorder);
  await recorder.call('exit');
  const remote = { '/api/health': { ok: true, remote: true } };
  const [bare, carried] = await Promise.all([
    spawnChrome(t, { port: d.port, viewport: DESKTOP, routes: remote, name: 'remote-bare' }),
    spawnChrome(t, { port: d.port, viewport: DESKTOP, routes: remote, transport: true, name: 'remote-carried' }),
  ]);
  const runs = await change([bare, carried], async () => {
    await ok(d.api.post('/api/render', { id: 'p0', html: paneHtml('p0', 1) }), 'version p0');
  }, { min: 900 });
  assert.deepEqual(runs[0].reports, [], 'no report on the bare remote page\'s socket');
  assert.deepEqual(runs[1].reports, [], 'no report on the carried page\'s socket either');
  assert.equal(bare.events.length, 0);
  const batches = carried.events.filter((e) => e.event === 'transport').map((e) => e.msg);
  assert.ok(batches.length >= 1, 'the transport took the batches');
  assert.ok(batches.every((m) => m.type === 'report' && Number.isSafeInteger(m.surface)));
  assert.equal(new Set(itemsOf(batches).map((i) => i.id)).size, pins.length, `every pin answered through the transport: ${JSON.stringify(batches.map((m) => m.mounts.map((x) => [x.mount, x.items.length])))} ${JSON.stringify(await carried.call('stats'))}`);
  assert.equal(d.srv.reports.stats().accepted, 0, 'nothing reached the daemon\'s socket path');
});
