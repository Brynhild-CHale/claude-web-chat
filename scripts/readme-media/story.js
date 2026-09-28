// The README clips' demo story — choosing a cache for an orders API — driven
// through the daemon's HTTP API as if Claude and a user were taking turns.
// Dev-only (scripts/ is not in the release `files` allowlist).
//
// The graph it leaves (labels as the chrome shows them):
//
//   n1.0  the question: title, today's traffic, an options table, a constraints form
//         — a window of content, so what the next turns add lands below the fold
//   n1.1  ★ recommendation — the form applied (a browser write); chart, verdict
//         and a constraint check added BELOW the options (a replay scrolls to them)
//   n1.2  the read path, below the recommendation — two chat-only turns fold into it
//   n1.3  a rollout checklist at the end of the page
//   n1.1.0 / n1.1.1  a branch from the recommendation: stay in-process
//
// Every pane is plain HTML styled with --wc-* tokens, so the clips follow the
// theme the story applies (Georgetown Blue, light).

const CSS = `<style>
:host{display:block;font:14px/1.45 var(--wc-font);color:var(--wc-fg)}
.wrap{padding:14px 16px}
h4{margin:0 0 10px;font:600 12px/1 var(--wc-font);letter-spacing:.08em;text-transform:uppercase;color:var(--wc-muted)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--wc-border-light)}
th{font-weight:600;color:var(--wc-muted);font-size:12px}
td.n{font-variant-numeric:tabular-nums}
tr.pick td{background:color-mix(in srgb,var(--wc-accent) 12%,transparent);font-weight:600}
.yes{color:var(--wc-green)} .no{color:var(--wc-rust)}
label{display:block;margin:0 0 10px;font-size:13px;color:var(--wc-muted)}
select,input[type=range]{display:block;width:100%;margin-top:4px;font:inherit;color:var(--wc-fg)}
select{padding:6px 8px;border:1px solid var(--wc-border);border-radius:var(--wc-radius-sm);background:var(--wc-panel-bg)}
.row{display:flex;gap:14px;align-items:center;margin:0 0 12px;font-size:13px}
.row label{display:flex;gap:6px;align-items:center;margin:0;color:var(--wc-fg)}
button{font:600 13px var(--wc-font);padding:8px 14px;border:0;border-radius:var(--wc-radius-sm);background:var(--wc-accent);color:var(--wc-accent-fg);cursor:pointer}
.ok{margin-left:10px;font-size:13px;color:var(--wc-green)}
svg text{font-family:var(--wc-font);fill:var(--wc-fg)}
</style>`;

const OPTIONS = [
  // key, name, p99 ms, survives a restart, ops cost
  ['redis', 'Redis (managed)', 1.8, true, '$$'],
  ['memcached', 'Memcached', 1.2, false, '$$'],
  ['lru', 'In-process LRU', 0.05, false, '—'],
  ['pg', 'Postgres only', 14, true, '—'],
];

function optionsTable(pick) {
  const rows = OPTIONS.map(([k, name, p99, warm, cost]) => `<tr class="${k === pick ? 'pick' : ''}">`
    + `<td>${name}</td><td class="n">${p99} ms</td><td class="${warm ? 'yes' : 'no'}">${warm ? 'yes' : 'no'}</td><td>${cost}</td></tr>`);
  return `${CSS}<div class="wrap"><table>
<tr><th>Layer</th><th>p99 read</th><th>Survives restart</th><th>Ops cost</th></tr>
${rows.join('\n')}
</table></div>`;
}

// The constraints form. Apply writes the declared signal key `cache_apply`; the
// pane re-shows an applied payload so the committed node reads as "applied".
const FORM = `${CSS}<div class="wrap"><h4>Your constraints</h4>
<label>Read latency target (p99)<select id="lat"><option>under 50 ms</option><option>under 20 ms</option><option>under 5 ms</option></select></label>
<label>Monthly budget for the cache <b id="bv">$150</b><input id="budget" type="range" min="0" max="500" step="10" value="150"></label>
<div class="row"><label><input id="warm" type="checkbox"> Must survive a restart warm</label></div>
<div class="row"><label><input type="radio" name="replicas" value="1" checked> 1 API instance</label><label><input type="radio" name="replicas" value="n"> several</label></div>
<button id="apply">Apply</button><span class="ok" id="done"></span></div>
<script>
const q = (s) => root.querySelector(s);
q('#budget').addEventListener('input', (e) => { q('#bv').textContent = '$' + e.target.value; });
const show = (v) => {
  if (!v || !v.payload) return;
  const p = v.payload;
  q('#lat').value = p.latency;
  q('#budget').value = p.budget;
  q('#bv').textContent = '$' + p.budget;
  q('#warm').checked = !!p.warm;
  root.querySelectorAll('input[name=replicas]').forEach((r) => { r.checked = r.value === p.replicas; });
  q('#done').textContent = '✓ Applied';
};
show(store.get('cache_apply'));
store.subscribe('cache_apply', show);
q('#apply').addEventListener('click', () => {
  const prev = store.get('cache_apply');
  store.set({ cache_apply: { seq: ((prev && prev.seq) || 0) + 1, payload: {
    latency: q('#lat').value, budget: Number(q('#budget').value), warm: q('#warm').checked,
    replicas: (root.querySelector('input[name=replicas]:checked') || {}).value } } });
});
</script>`;

// p99 read latency as horizontal bars (square-root scaled so 0.05 ms still
// shows), the picked option in the accent colour, the 20 ms target dashed.
function latencyChart(pick) {
  const W = 520;
  const x0 = 140;
  const span = W - x0 - 60;
  const len = (ms) => Math.max(6, Math.sqrt(ms / 25) * span);
  const order = ['pg', 'redis', 'memcached', 'lru'].map((k) => OPTIONS.find((o) => o[0] === k));
  const bars = order.map(([k, name, ms], i) => {
    const y = 30 + i * 32;
    const on = k === pick;
    return `<text x="0" y="${y + 17}" font-size="13"${on ? ' font-weight="700"' : ''}>${name}</text>`
      + `<rect x="${x0}" y="${y}" width="${len(ms).toFixed(1)}" height="22" rx="3" fill="${on ? 'var(--wc-accent)' : 'var(--wc-border)'}"/>`
      + `<text x="${(x0 + len(ms) + 8).toFixed(1)}" y="${y + 17}" font-size="12">${ms} ms</text>`;
  }).join('\n');
  const t = (x0 + len(20)).toFixed(1);
  return `${CSS}<div class="wrap"><h4>p99 read latency · orders by id</h4>
<svg viewBox="0 0 ${W} 160" width="100%" role="img" aria-label="p99 read latency by option">
${bars}
<line x1="${t}" y1="26" x2="${t}" y2="158" stroke="var(--wc-rust)" stroke-dasharray="4 4"/>
<text x="${Number(t) + 4}" y="20" font-size="11" fill="var(--wc-rust)">20 ms target</text>
</svg></div>`;
}

const VERDICTS = {
  redis: ['Redis (managed)', 'Meets the 20 ms target with room to spare, stays warm across deploys, and every API instance shares it.', '~$90 / month'],
  lru: ['In-process LRU', 'Fastest by far and free — but each instance warms its own copy, and every deploy starts cold.', '$0 / month'],
};

function verdictCard(pick) {
  const [name, why, cost] = VERDICTS[pick];
  return `${CSS}<div class="wrap"><h4>Recommendation</h4>
<div style="font:600 22px/1.2 var(--wc-display);margin:0 0 8px">${name}</div>
<div style="margin:0 0 10px">${why}</div>
<div style="color:var(--wc-muted);font-size:13px">Estimated cost: <b style="color:var(--wc-fg)">${cost}</b></div></div>`;
}

// Today's read traffic by endpoint (n1.0): gives the first page enough height
// that everything the recommendation adds lands below the fold.
const TRAFFIC = (() => {
  const rows = [['GET /orders/:id', 4200], ['GET /orders?customer=', 1650], ['POST /orders', 900], ['PATCH /orders/:id', 380], ['GET /orders/:id/items', 1400]];
  const max = 4200;
  const bars = rows.map(([name, rpm], i) => {
    const y = 12 + i * 34;
    const w = (rpm / max) * 560;
    const hot = i === 0;
    return `<text x="0" y="${y + 17}" font-size="13"${hot ? ' font-weight="700"' : ''}>${name}</text>`
      + `<rect x="200" y="${y}" width="${w.toFixed(1)}" height="22" rx="3" fill="${hot ? 'var(--wc-accent)' : 'var(--wc-border)'}"/>`
      + `<text x="${(208 + w).toFixed(1)}" y="${y + 17}" font-size="12">${rpm.toLocaleString('en-US')} / min</text>`;
  }).join('\n');
  return `${CSS}<div class="wrap"><h4>Requests per minute · last 7 days, peak hour</h4>
<svg viewBox="0 0 900 186" width="100%" role="img" aria-label="requests per minute by endpoint">
${bars}
</svg></div>`;
})();

// Each constraint against the two candidates (n1.1): the second row of the
// recommendation, so the section is about a window tall.
const FIT_ROWS = [
  ['p99 read under 20 ms', true, true],
  ['Warm after a deploy or restart', true, false],
  ['One copy shared by every instance', true, false],
  ['Within $150 / month', true, true],
  ['No new service to run', false, true],
  ['Invalidation is one DELETE', true, false],
];

function fitTable(pick) {
  const mark = (ok) => `<td class="${ok ? 'yes' : 'no'}">${ok ? '✓' : '✗'}</td>`;
  const head = (k, name) => `<th${k === pick ? ' style="color:var(--wc-accent)"' : ''}>${name}</th>`;
  return `${CSS}<div class="wrap"><h4>Your constraints, checked</h4><table>
<tr><th>Constraint</th>${head('redis', 'Redis (managed)')}${head('lru', 'In-process LRU')}</tr>
${FIT_ROWS.map(([c, r, l]) => `<tr><td>${c}</td>${mark(r)}${mark(l)}</tr>`).join('\n')}
</table></div>`;
}

function box(x, label, on) {
  const fill = on ? 'color-mix(in srgb,var(--wc-accent) 16%,var(--wc-panel-bg))' : 'var(--wc-panel-bg)';
  return `<rect x="${x}" y="55" width="150" height="56" rx="8" fill="${fill}" stroke="${on ? 'var(--wc-accent)' : 'var(--wc-border)'}" stroke-width="1.5"/>`
    + `<text x="${x + 75}" y="88" text-anchor="middle" font-size="14" font-weight="600">${label}</text>`;
}

const READ_PATH = `${CSS}<div class="wrap"><h4>Read path · GET /orders/:id</h4>
<svg viewBox="0 0 720 170" width="100%" role="img" aria-label="read path: client, orders-api, Redis, Postgres">
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="var(--wc-muted)"/></marker></defs>
${box(10, 'Client')}${box(190, 'orders-api')}${box(370, 'Redis', true)}${box(550, 'Postgres')}
<line x1="160" y1="83" x2="186" y2="83" stroke="var(--wc-muted)" stroke-width="1.5" marker-end="url(#arr)"/>
<line x1="340" y1="83" x2="366" y2="83" stroke="var(--wc-muted)" stroke-width="1.5" marker-end="url(#arr)"/>
<path d="M445,111 C445,150 625,150 625,115" fill="none" stroke="var(--wc-muted)" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#arr)"/>
<text x="535" y="160" text-anchor="middle" font-size="12" fill="var(--wc-muted)">miss → read through, set TTL 60 s</text>
<text x="445" y="44" text-anchor="middle" font-size="12" fill="var(--wc-green)">hit ≈ 1.8 ms</text>
<text x="265" y="44" text-anchor="middle" font-size="12" fill="var(--wc-muted)">invalidate on write</text>
</svg></div>`;

const KEYS = `${CSS}<div class="wrap"><h4>Keys &amp; invalidation</h4>
<table><tr><th>Key</th><th>TTL</th></tr>
<tr><td><code>order:{id}</code></td><td class="n">60 s</td></tr>
<tr><td><code>order:{id}:items</code></td><td class="n">60 s</td></tr>
<tr><td colspan="2" style="color:var(--wc-muted);font-size:13px;border:0;padding-top:10px">Deleted on <code>PATCH</code> / <code>DELETE</code>, never updated in place.</td></tr></table></div>`;

const ROLLOUT = `${CSS}<div class="wrap"><h4>Rollout</h4>
<div class="row"><label><input type="checkbox" checked> Provision Redis (1 GB, multi-AZ)</label></div>
<div class="row"><label><input type="checkbox"> Ship read-through behind a flag</label></div>
<div class="row"><label><input type="checkbox"> Compare p99 for a week, then remove the flag</label></div></div>`;

// One turn as the harness frames it: the UserPromptSubmit lock, Claude's
// writes, then the Stop commit (which commits nothing when the page is
// unchanged — the trigger folds onto the next node).
async function turn({ post }, message, reply, writes) {
  await post('/api/turn-begin', { message, author: 'user' });
  if (writes) await writes();
  return post('/api/turn-end', { author: 'claude', reply });
}

// io: { post(path, body), send(wsFrame), sleep(ms) } → the committed nodes' ids.
async function drive(io, { theme = 'georgetown-blue' } = {}) {
  const { post, send, sleep } = io;
  await post('/api/theme/apply', { name: theme, scope: 'global' });

  const n0 = await turn(io, 'Help me pick a caching layer for the orders API.',
    'I put the options and a constraints form on the page — set your constraints and hit Apply.', async () => {
      await post('/api/markdown', { id: 'md-title', text: '# Caching the orders API\n\n`GET /orders/:id` is 40% of traffic and reads straight from Postgres. Four ways to put a cache in front of it:' });
      await post('/api/markdown', { id: 'md-today', text: '## Today' });
      await post('/api/render', { id: 'traffic', html: TRAFFIC });
      await post('/api/markdown', { id: 'md-options', text: '## Options' });
      await post('/api/render', { id: 'opt-table', html: optionsTable(null), place: { span: 7 } });
      await post('/api/render', { id: 'ask-form', html: FORM, place: { span: 5 }, params: { signals: [{ key: 'cache_apply', wake: 'queue' }] } });
    });

  // The user fills the form in the page and hits Apply: a browser form write
  // and a gesture store write, exactly what the pane's script would send.
  send({ type: 'pane:form', id: 'ask-form', form_state: { '#lat:0': 'under 20 ms', '#budget:0': '150', '#warm:0': true } });
  send({ type: 'store:set', mount: 'ask-form', gesture: true, patch: { cache_apply: { seq: 1, payload: { latency: 'under 20 ms', budget: 150, warm: true, replicas: 'n' } } } });
  await sleep(300);

  const n1 = await turn(io, '(Push) constraints applied',
    'Under 20 ms, warm across restarts and several instances rules out the in-process cache — Redis it is.', async () => {
      await post('/api/render', { id: 'opt-table', html: optionsTable('redis') });
      await post('/api/markdown', { id: 'md-rec', text: '## Recommendation\n\nWith **p99 under 20 ms**, a warm restart and several API instances, a shared cache wins.' });
      await post('/api/render', { id: 'rec-chart', html: latencyChart('redis'), place: { span: 7 } });
      await post('/api/render', { id: 'rec-card', html: verdictCard('redis'), place: { span: 5 } });
      await post('/api/render', { id: 'rec-fit', html: fitTable('redis') });
    });
  await post('/api/graph/bookmark', { id: n1.node_id, name: 'recommendation' });

  // Two chat-only turns: the page does not change, so both fold forward.
  await turn(io, 'Why not Memcached? It is faster.', 'Only by 0.6 ms at p99, and it loses everything on restart — you asked for a warm start.');
  await turn(io, 'What TTL would you use?', '60 s with invalidate-on-write; orders change rarely after checkout.');

  const n2 = await turn(io, 'Sketch the read path.', 'Added the read path under the recommendation: read-through with a 60 s TTL, invalidated on write.', async () => {
    await post('/api/markdown', { id: 'md-path', text: '## Read path\n\nRead-through on a miss; every write to an order deletes its key.' });
    await post('/api/render', { id: 'read-path', html: READ_PATH, place: { span: 8 } });
    await post('/api/render', { id: 'keys', html: KEYS, place: { span: 4 } });
  });

  const n3 = await turn(io, 'Give me a rollout checklist.', 'Checklist added at the end of the page.', async () => {
    await post('/api/markdown', { id: 'md-rollout', text: '## Rollout' });
    await post('/api/render', { id: 'rollout', html: ROLLOUT });
  });

  // A branch: back to the recommendation, the other direction.
  await post('/api/graph/active', { id: n1.node_id });
  const b0 = await turn(io, 'What if we just stay in-process?', 'Branched: the in-process LRU is fastest and free, but every instance warms its own copy.', async () => {
    await post('/api/render', { id: 'opt-table', html: optionsTable('lru') });
    await post('/api/markdown', { id: 'md-rec', text: '## Recommendation\n\nIf a cold start after each deploy is acceptable, skip the network hop entirely.' });
    await post('/api/render', { id: 'rec-chart', html: latencyChart('lru') });
    await post('/api/render', { id: 'rec-card', html: verdictCard('lru') });
    await post('/api/render', { id: 'rec-fit', html: fitTable('lru') });
  });
  const b1 = await turn(io, 'How big should each LRU be?', 'About 20k orders per instance keeps the hit rate near 90%.', async () => {
    await post('/api/markdown', { id: 'md-rec', text: '## Recommendation\n\nIf a cold start after each deploy is acceptable, skip the network hop entirely: **20k entries** per instance.' });
  });

  // …and back to the trunk tip, where a fresh viewer lands.
  await post('/api/graph/active', { id: n3.node_id });
  return { n0, n1, n2, n3, b0, b1 };
}

// flow.gif — the product's own scripted replay render (POST /api/replay/render),
// drawn at 1280×800 and written at 960 wide: a 16:10 frame. Each step scrolls
// the frame to what it added (the recommendation, then the read path), so the
// holds leave room for the scroll and a dwell on it; 20 fps keeps a scroll
// (at most 700 ms) smooth, and still frames cost one GIF frame each.
const FLOW = {
  format: 'gif',
  width: 960,
  size: '1280x800',
  fps: 20, // fades and scroll moves are sampled at this rate
  script: {
    from: 'n1.0',
    to: 'n1.2',
    title: 'Caching the orders API',
    steps: [
      { node: 'n1.0', hold_ms: 4000, caption: 'Claude puts the question on the page: options, and a form' },
      { node: 'n1.1', hold_ms: 5500, caption: 'You apply your constraints; Claude recommends', transition: 'fade' },
      { node: 'n1.2', hold_ms: 5500, caption: 'Two chat-only turns fold; the read path lands', transition: 'fade' },
    ],
  },
};

// replay.gif — Claude opening a directed replay in the watching browser
// (export({script, open:true}) → POST /api/replay/open), recorded from the chrome.
const REPLAY = {
  from: 'n1.0',
  to: 'n1.1.1',
  title: 'Two directions for the cache',
  steps: [
    { node: 'n1.0', hold_ms: 3000, caption: 'The options, and a form for constraints' },
    { node: 'n1.1', hold_ms: 4500, caption: 'Applied → Redis', transition: 'fade' },
    { node: 'n1.1.0', hold_ms: 4500, caption: 'Branch: stay in-process', transition: 'fade' },
    { node: 'n1.1.1', hold_ms: 3500, caption: 'Size the LRU', transition: 'fade' },
  ],
};

module.exports = { drive, FLOW, REPLAY };
