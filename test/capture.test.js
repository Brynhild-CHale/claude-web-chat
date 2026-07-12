const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { withServer } = require('../test-support/helpers');

// Scaffold a project profile bundle under the root's .web-chat/profiles.
function putProfile(root, name, opts = {}) {
  const dir = path.join(root, '.web-chat', 'profiles', name);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { name, description: opts.description || `${name} desc`, matchers: opts.matchers || [] };
  if (opts.pane) meta.pane = opts.pane;
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(meta));
  fs.writeFileSync(
    path.join(dir, 'extract.js'),
    opts.extractJs || `module.exports = ({ url }) => ({ kind: ${JSON.stringify(name)}, url, n: 7 });`,
  );
  if (opts.paneJs) fs.writeFileSync(path.join(dir, 'pane.js'), opts.paneJs);
}

// All capture panes for a profile suffix. Per-page dedupe (the default) keys the
// mount as `tab-capture:<suffix>:<page-hash>`; 'profile' dedupe uses the bare
// `tab-capture:<suffix>`. Match both shapes.
function paneMounts(hello, suffix) {
  const base = 'tab-capture:' + suffix;
  return hello.mounts.filter((x) => x.id === base || x.id.startsWith(base + ':'));
}

// Send a pane:state update over WS (the only path that mutates a mount's mode),
// then resolve once the server has had a moment to apply it.
function wsSetPaneState(port, id, pane_state) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://localhost:${port}/ws`);
    sock.on('open', () => {
      sock.send(JSON.stringify({ type: 'pane:state', id, pane_state }));
      setTimeout(() => { sock.close(); resolve(); }, 60);
    });
    sock.on('error', reject);
  });
}

const TABLE_HTML = '<html><head><title>Sheet</title></head><body><h1>Budget</h1>'
  + '<table><tr><th>Item</th><th>Cost</th></tr><tr><td>Rent</td><td>1200</td></tr><tr><td>Food</td><td>400</td></tr></table>'
  + '</body></html>';
const TEXT_HTML = '<html><head><title>Doc</title></head><body><p>SECRET-MARKER hello world</p><script>var x=1</script></body></html>';

test('capture: ingest distills, sets tab_capture signal, emits capture event, writes raw sidecar', async (t) => {
  const { api, root } = await withServer(t);

  const r = await api.post('/api/capture', { url: 'https://x/doc', title: 'Doc', html: TEXT_HTML });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.capture_id, 'cap1');
  assert.equal(r.json.profile, 'default');
  assert.equal(r.json.distilled.kind, 'page-text');
  assert.match(r.json.distilled.text, /SECRET-MARKER hello world/);

  // signal key set (wake path)
  const store = (await api.get('/api/store')).json;
  assert.equal(store.tab_capture.capture_id, 'cap1');
  assert.equal(store.tab_capture.seq, 1);
  // raw DOM must NOT be in the store (out-of-context tier)
  assert.equal(JSON.stringify(store).includes('<script>'), false);

  // capture event emitted
  const ev = (await api.get('/api/events')).json;
  assert.ok(ev.events.some((e) => e.kind === 'capture' && e.capture_id === 'cap1'));

  // raw sidecar written
  const sidecar = path.join(root, '.web-chat', 'captures', 'cap1.html');
  assert.ok(fs.existsSync(sidecar));
  assert.equal(fs.readFileSync(sidecar, 'utf8'), TEXT_HTML);
});

test('capture: profile auto-selects (tables on tabular page), hint overrides', async (t) => {
  const { api } = await withServer(t);

  const tbl = await api.post('/api/capture', { url: 'https://x/sheet', html: TABLE_HTML });
  assert.equal(tbl.json.profile, 'tables');
  assert.equal(tbl.json.distilled.table_count, 1);
  assert.deepEqual(tbl.json.distilled.tables[0].headers, ['Item', 'Cost']);
  assert.deepEqual(tbl.json.distilled.tables[0].rows, [['Rent', '1200'], ['Food', '400']]);

  // explicit hint forces a profile even though the page would auto-match tables
  const forced = await api.post('/api/capture', { url: 'https://x/sheet', html: TABLE_HTML, profile: 'default' });
  assert.equal(forced.json.profile, 'default');
  assert.equal(forced.json.distilled.kind, 'page-text');
});

test('capture: list captures and read a committed node\'s captures', async (t) => {
  const { api } = await withServer(t);

  await api.post('/api/capture', { url: 'https://x/a', html: TEXT_HTML });
  await api.post('/api/capture', { url: 'https://x/b', html: TABLE_HTML });

  const all = (await api.get('/api/captures')).json;
  assert.equal(all.captures.length, 2);
  assert.equal(all.next_cursor, 2);
  assert.ok(Array.isArray(all.profiles));

  // since cursor
  const since1 = (await api.get('/api/captures?since=1')).json;
  assert.equal(since1.captures.length, 1);
  assert.equal(since1.captures[0].id, 'cap2');
});

test('capture: records persist into node.captures and survive restart; raw stays out of the node', async (t) => {
  const { api, root, graceful } = await withServer(t);

  await api.post('/api/capture', { url: 'https://x/doc', title: 'Doc', html: TEXT_HTML });
  await api.post('/api/turn-begin', {});
  const end = await api.post('/api/turn-end', { summary: 't' });
  assert.ok(end.json.node_id);

  await graceful();

  const { api: api2 } = await withServer(t, { root });
  const node = (await api2.get(`/api/graph/node/${end.json.node_id}`)).json;
  assert.ok(Array.isArray(node.captures));
  assert.equal(node.captures[0].id, 'cap1');
  assert.equal(node.captures[0].distilled.kind, 'page-text'); // distilled rides into the node
  assert.ok(node.captures[0].raw_ref); // reference only
  // The raw DOM itself is NOT inlined in the node. (The default capture's pane is
  // now the reader-lite simplified view, which legitimately carries its own
  // mode-toggle <script> — like every profile pane — so assert on the captured
  // page's RAW script BODY instead, which stays stripped everywhere.)
  assert.equal(JSON.stringify(node).includes('var x=1'), false);

  // and the sidecar is still readable after restart
  const got = await api2.get('/api/captures/cap1/raw');
  assert.equal(got.status, 200);
  assert.match(got.json.raw, /SECRET-MARKER/);
});

test('capture: inspect raw — full (capped), selector, query, profile-rerun', async (t) => {
  const { api } = await withServer(t);

  await api.post('/api/capture', { url: 'https://x/sheet', html: TABLE_HTML });

  const full = await api.get('/api/captures/cap1/raw');
  assert.equal(full.json.mode, 'full');
  assert.match(full.json.raw, /<table>/);

  const sel = await api.get('/api/captures/cap1/raw?selector=' + encodeURIComponent('th'));
  assert.equal(sel.json.mode, 'selector');
  assert.equal(sel.json.count, 2);
  assert.equal(sel.json.matches[0].text, 'Item');

  const q = await api.get('/api/captures/cap1/raw?query=Budget');
  assert.equal(q.json.mode, 'query');
  assert.equal(q.json.count, 1);

  const prof = await api.get('/api/captures/cap1/raw?profile=tables');
  assert.equal(prof.json.mode, 'profile');
  assert.equal(prof.json.result.table_count, 1);

  const missing = await api.get('/api/captures/nope/raw');
  assert.equal(missing.status, 404);
});

test('capture: sets the tab_capture signal and emits the capture event', async (t) => {
  // Channels-only wake: Claude no longer arms /api/wait, so the
  // capture's wake surface is probed directly — the store signal a channel/driver
  // keys off, plus the capture event in the log.
  const { api } = await withServer(t);

  await api.post('/api/capture', { url: 'https://x/doc', html: TEXT_HTML });

  const store = (await api.get('/api/store')).json;
  assert.equal(store.tab_capture.capture_id, 'cap1');

  const ev = (await api.get('/api/events')).json;
  const cap = ev.events.find((e) => e.kind === 'capture');
  assert.ok(cap, 'a capture event landed in the log');
  assert.equal(cap.capture_id, 'cap1');
});

test('capture: capture id stays globally unique after navigating to an earlier node', async (t) => {
  const { api } = await withServer(t);

  await api.post('/api/capture', { url: 'https://x/a', html: TEXT_HTML });           // cap1
  await api.post('/api/turn-begin', {});
  const n0 = (await api.post('/api/turn-end', { summary: 't' })).json.node_id;

  await api.post('/api/capture', { url: 'https://x/b', html: TABLE_HTML });          // cap2
  await api.post('/api/turn-begin', {});
  await api.post('/api/turn-end', { summary: 't' });

  // navigate back to the earlier node and capture again
  const nav = await api.post('/api/graph/active', { id: n0 });
  assert.equal(nav.json.ok, true);
  const c = await api.post('/api/capture', { url: 'https://x/c', html: TEXT_HTML }); // must be cap3, not cap2
  assert.equal(c.json.capture_id, 'cap3');
});

test('capture: CORS preflight + headers on POST', async (t) => {
  const { baseUrl } = await withServer(t);

  const pre = await fetch(baseUrl + '/api/capture', {
    method: 'OPTIONS',
    headers: { Origin: 'chrome-extension://abc', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
  assert.match(pre.headers.get('access-control-allow-headers') || '', /X-WC-Token/i);

  const post = await fetch(baseUrl + '/api/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://abc' },
    body: JSON.stringify({ url: 'u', html: TEXT_HTML }),
  });
  assert.equal(post.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
});

test('capture: token gate rejects missing/wrong token, accepts correct', async (t) => {
  const { api } = await withServer(t, {
    seed: async ({ root }) => {
      fs.writeFileSync(path.join(root, '.web-chat', 'capture-token'), 'sekret\n');
    },
  });

  const noTok = await api.post('/api/capture', { url: 'u', html: TEXT_HTML });
  assert.equal(noTok.status, 401);

  const wrong = await api.post('/api/capture', { url: 'u', html: TEXT_HTML }, { 'X-WC-Token': 'nope' });
  assert.equal(wrong.status, 401);

  const right = await api.post('/api/capture', { url: 'u', html: TEXT_HTML }, { 'X-WC-Token': 'sekret' });
  assert.equal(right.status, 200);
  assert.equal(right.json.ok, true);
});

test('capture: a matched profile with a pane renders into its own mount (reduced mode, owner-tagged)', async (t) => {
  const { api, wsHello } = await withServer(t, {
    seed: async ({ root }) => {
      putProfile(root, 'rich', {
        matchers: [{ type: 'domain', value: 'rich.test' }],
        paneJs: 'module.exports = { render: (d) => `<div data-wc-when="expanded">FULL:${d.n}</div><div data-wc-when="reduced">MINI</div>`, reduce: (d) => ({ n: d.n }) };',
      });
    },
  });

  const r = await api.post('/api/capture', { url: 'https://rich.test/a', title: 'R', html: '<p>x</p>' });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.profile, 'rich');

  const hello = await wsHello();
  const ms = paneMounts(hello, 'rich');
  assert.equal(ms.length, 1, 'one per-page mount created');
  const m = ms[0];
  assert.match(m.id, /^tab-capture:rich:[0-9a-f]{8}$/, 'per-page keyed mount id');
  assert.equal(m.owner, 'service:tab-stream');
  assert.equal(m.pane_state.mode, 'reduced');
  assert.equal(m.params.modes, true);
  assert.match(m.params.title, /Capture · rich — R/); // page-aware title
  assert.match(m.html, /wc-pane-modes/);
  assert.match(m.html, /FULL:7/);   // full representation present
  assert.match(m.html, /MINI/);     // reduced representation present (one payload, two views)
  // legacy single mount must not coexist
  assert.ok(!hello.mounts.some((x) => x.id === 'tab-capture'));
});

test('capture: a matched profile WITHOUT a pane falls back to the generic card', async (t) => {
  const { api, wsHello } = await withServer(t, {
    seed: async ({ root }) => {
      putProfile(root, 'nopane', { matchers: [{ type: 'domain', value: 'np.test' }] });
    },
  });

  await api.post('/api/capture', { url: 'https://np.test/a', html: '<p>x</p>' });
  const hello = await wsHello();
  const ms = paneMounts(hello, 'nopane');
  assert.equal(ms.length, 1);
  assert.match(ms[0].html, /Captured/); // feedbackCard marker
});

test('capture: two different pages of the same profile coexist as separate panes', async (t) => {
  const { api, wsHello } = await withServer(t, {
    seed: async ({ root }) => {
      putProfile(root, 'rich', {
        matchers: [{ type: 'domain', value: 'rich.test' }],
        paneJs: 'module.exports = { render: () => `<div data-wc-when="expanded">F</div><div data-wc-when="reduced">M</div>` };',
      });
    },
  });

  await api.post('/api/capture', { url: 'https://rich.test/a', html: '<p>1</p>' });
  await api.post('/api/capture', { url: 'https://rich.test/b', html: '<p>2</p>' });

  const hello = await wsHello();
  const ms = paneMounts(hello, 'rich');
  assert.equal(ms.length, 2, 'distinct pages → distinct coexisting panes');
  assert.notEqual(ms[0].id, ms[1].id);
});

test('capture: re-capturing the SAME page replaces its pane in place, preserving toggled mode', async (t) => {
  const { api, port, wsHello } = await withServer(t, {
    seed: async ({ root }) => {
      putProfile(root, 'rich', {
        matchers: [{ type: 'domain', value: 'rich.test' }],
        paneJs: 'module.exports = { render: () => `<div data-wc-when="expanded">F</div><div data-wc-when="reduced">M</div>` };',
      });
    },
  });

  await api.post('/api/capture', { url: 'https://rich.test/a', html: '<p>1</p>' }); // mode → reduced
  const h1 = await wsHello();
  const id = paneMounts(h1, 'rich')[0].id;
  await wsSetPaneState(port, id, { mode: 'expanded' });                          // user expands THIS page's pane
  await api.post('/api/capture', { url: 'https://rich.test/a', html: '<p>2</p>' });  // same URL → same id

  const hello = await wsHello();
  const ms = paneMounts(hello, 'rich');
  assert.equal(ms.length, 1, 'same page → one pane (replace in place)');
  assert.equal(ms[0].id, id);
  assert.equal(ms[0].pane_state.mode, 'expanded', 'toggled mode survives the next capture');
  assert.equal(ms[0].params.mode, 'expanded');
});

test('capture: dedupe_by:profile keeps a single pane every capture shares', async (t) => {
  const { api, wsHello } = await withServer(t, {
    seed: async ({ root }) => {
      putProfile(root, 'dash', {
        matchers: [{ type: 'domain', value: 'dash.test' }],
        pane: { dedupe_by: 'profile' },
      });
    },
  });

  await api.post('/api/capture', { url: 'https://dash.test/a', html: '<p>1</p>' });
  await api.post('/api/capture', { url: 'https://dash.test/b', html: '<p>2</p>' });

  const hello = await wsHello();
  const ms = paneMounts(hello, 'dash');
  assert.equal(ms.length, 1, 'profile dedupe → one shared pane (replace in place)');
  assert.equal(ms[0].id, 'tab-capture:dash', 'bare suffix id, no per-page hash');
});

test('capture: an interaction result is recorded and tagged on timeout', async (t) => {
  const { api } = await withServer(t);

  await api.post('/api/capture', {
    url: 'https://x/doc', html: TEXT_HTML,
    interaction: { ran: true, timed_out: true, last_step: 'wait-diff', log: [{ step: 'wait-diff', note: 'timeout' }] },
  });
  const all = (await api.get('/api/captures')).json;
  const rec = all.captures[0];
  assert.equal(rec.interaction.ran, true);
  assert.equal(rec.interaction.timed_out, true);
  assert.equal(rec.interaction.last_step, 'wait-diff');
  assert.equal(rec.interaction_timed_out, true);
});

test('capture: a throwing profile falls back to default and still records', async () => {
  // The tables profile throws if given malformed table HTML? It is defensive, so
  // instead verify the resilience contract directly via the registry.
  const { runProfile } = require('../lib/capture/profiles');
  const boom = { name: 'boom', match: () => true, extract() { throw new Error('kaboom'); } };
  const out = runProfile(boom, { url: 'u', html: TEXT_HTML });
  assert.equal(out.profile, 'default');
  assert.equal(out.fell_back_from, 'boom');
  assert.match(out.error, /kaboom/);
});
