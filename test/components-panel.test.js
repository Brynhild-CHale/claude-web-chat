// The ＋ drawer, under jsdom with the real module graph and the real index.html.
//
// What is pinned here is everything the drawer walked into on its way to
// becoming the components AND packs manager:
//
//   * ＋ TOGGLES. It could not before: the button declared no `aria-controls`,
//     so the dismiss layer's pointerdown closed the drawer and the button's own
//     click reopened it. The attribute is the fix, not decoration.
//   * Escape has ONE owner. Typing Escape in the pack URL field clears the field
//     and leaves the drawer open; Escape anywhere else closes it. The drawer used
//     to add a second document-level listener with its own idea of precedence.
//   * A component name is rendered as TEXT. Pack install is what makes names and
//     descriptions attacker-controlled — they arrive from a repository somebody
//     else wrote, into a page with no CSP where pane scripts already run
//     unsandboxed.
//   * An install invalidates ONE component cache, so the ⌘K palette sees it
//     without a reload. The palette's private cache was never invalidated.
//   * A builtin collision renders with NO override control at all.
//   * Spawning uses a STABLE slot, so panes stop stacking forever.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

// ── one boot for the whole file (the ESM cache would hand a second import the
// same already-initialised modules; node --test gives each FILE its own process)
let W, $, tick, calls, routes, press, focusOn;
// The modules capture the BARE global `fetch` at import time, so a test cannot
// swap responses by reassigning window.fetch afterwards — the global still points
// at the original. One indirection, and `withFetch` swaps what it delegates to.
let fetchImpl;
async function withFetch(fn, body) {
  const prev = fetchImpl;
  fetchImpl = async (url, opts) => (await fn(url, opts)) || prev(url, opts);
  try { return await body(); } finally { fetchImpl = prev; }
}

function jsonRes(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

test('boot the shell', async () => {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8')
    .replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  W = dom.window;

  W.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} };

  calls = [];
  routes = {
    '/api/graph': { nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }], active: 'n1' },
    '/api/components': { components: [] },
    '/api/packs': { ok: true, packs: [], quarantined: [] },
    '/api/services/pending': { ok: true, pending: [] },
    '/api/themes': { themes: [] },
  };
  fetchImpl = async (url, opts) => {
    calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null });
    for (const [k, v] of Object.entries(routes)) {
      if (url === k) return jsonRes(typeof v === 'function' ? v() : v);
    }
    if (url.startsWith('/api/theme')) return jsonRes({ name: 'web-chat' });
    return jsonRes({ ok: true });
  };
  W.fetch = (...a) => fetchImpl(...a);

  const saved = {};
  // EventTarget/Event/CustomEvent must come from the SAME realm: public/app/bus.js
  // constructs an EventTarget at import time and dispatches CustomEvents at it,
  // and Node's EventTarget rejects a jsdom CustomEvent as "not an Event".
  for (const k of ['window', 'document', 'location', 'EventTarget', 'Event', 'CustomEvent',
    'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent',
    'getComputedStyle', 'localStorage', 'WebSocket', 'fetch', 'HTMLElement', 'Node', 'Element']) {
    try { saved[k] = global[k]; global[k] = W[k]; } catch {}
  }
  global.setInterval = () => 0;
  global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  W.__wcMount = require(path.join(REPO, 'public/mount-runtime.js'));

  await import(pathToFileURL(path.join(REPO, 'public/app/main.js')).href);

  $ = (id) => W.document.getElementById(id);
  tick = () => new Promise((r) => setTimeout(r, 25));
  press = (el) => {
    el.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, composed: true }));
    el.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  };
  focusOn = (el) => { el.focus(); el.dispatchEvent(new W.FocusEvent('focusin', { bubbles: true })); };
  await tick();
  assert.ok($('drawer'), 'the drawer exists');
});

const drawerOpen = () => !$('drawer').classList.contains('hidden');
const key = (k, target) => (target || W.document).dispatchEvent(new W.KeyboardEvent('keydown', { key: k, bubbles: true }));

async function openDrawer() {
  if (!drawerOpen()) { press($('btn-add')); await tick(); }
}

// ── the button ──────────────────────────────────────────────────────────────

test('the ＋ button declares the panel it controls — which is what makes it a toggle', () => {
  const btn = $('btn-add');
  assert.equal(btn.getAttribute('aria-controls'), 'drawer');
  assert.equal(btn.getAttribute('aria-haspopup'), 'dialog');
  assert.match(btn.getAttribute('title'), /spawn a pane, manage packs/);
  assert.equal(btn.textContent, '＋', 'the glyph stays — spawning is still the dominant action');
});

test('＋ opens AND closes, and keeps aria-expanded honest', async () => {
  assert.equal($('btn-add').getAttribute('aria-expanded'), 'false');
  await openDrawer();
  assert.ok(drawerOpen(), '＋ opened it');
  assert.equal($('btn-add').getAttribute('aria-expanded'), 'true');

  press($('btn-add'));
  await tick();
  assert.ok(!drawerOpen(), '＋ closed it — the toggle the missing aria-controls used to break');
  assert.equal($('btn-add').getAttribute('aria-expanded'), 'false');
});

test('the drawer is a dialog with two tabs, Library first', async () => {
  await openDrawer();
  assert.equal($('drawer').getAttribute('role'), 'dialog');
  const tabs = [...$('drawer-tabs').querySelectorAll('[role="tab"]')].map((b) => b.dataset.tab);
  assert.deepEqual(tabs, ['library', 'manage']);
  assert.equal($('drawer-tab-library').getAttribute('aria-selected'), 'true');
  assert.ok(!$('drawer-library').classList.contains('hidden'));
  assert.ok($('drawer-manage').classList.contains('hidden'));
});

// ── Escape has one owner ────────────────────────────────────────────────────

test('Escape closes the drawer', async () => {
  await openDrawer();
  key('Escape');
  await tick();
  assert.ok(!drawerOpen());
});

test('Escape typed in the pack URL field clears the field and LEAVES THE DRAWER OPEN', async () => {
  await openDrawer();
  press($('drawer-tab-manage'));
  await tick();
  const url = $('pk-url');
  assert.ok(url, 'the Manage tab has a URL field');
  assert.notEqual(W.document.activeElement, url,
    'opening Manage must NOT focus the field — an editable element owns its own keys, so Escape would do nothing at all');

  url.value = 'https://github.com/acme/half-typed';
  url.focus();
  key('Escape', url);
  await tick();
  assert.ok(drawerOpen(), 'a half-typed URL is cleared, not thrown away with the panel');
  assert.equal(url.value, '');

  // …and a SECOND Escape, on the now-empty field, closes the drawer. The shell's
  // one Escape owner stands down for ANY editable chrome field, so a field that
  // only ever cleared itself would leave the panel un-closable from the keyboard
  // for as long as it held focus.
  key('Escape', url);
  await tick();
  assert.ok(!drawerOpen(), 'Escape on an empty field falls through to the one Escape owner');
});

// ── the hostile-name case ───────────────────────────────────────────────────

test('a component named with markup renders as TEXT, not as an element', async () => {
  const evil = '<img src=x onerror="window.__pwned = 1">';
  routes['/api/components'] = { components: [
    { name: evil, description: '<script>window.__pwned2 = 1</script>', location: 'local' },
  ] };
  // A pack install is what makes these attacker-controlled, so invalidate the
  // cache the way an install does and reopen.
  const { invalidate } = await import(pathToFileURL(path.join(REPO, 'public/app/components.js')).href);
  invalidate();
  if (drawerOpen()) { key('Escape'); await tick(); }
  await openDrawer();
  await tick();

  const lib = $('drawer-library');
  assert.equal(lib.querySelector('img'), null, 'no element was parsed out of the name');
  assert.equal(lib.querySelector('script'), null, 'nor out of the description');
  assert.equal(W.__pwned, undefined);
  assert.equal(W.__pwned2, undefined);
  assert.ok(lib.textContent.includes(evil), 'the name is shown, verbatim, as text');
});

// ── rows ────────────────────────────────────────────────────────────────────

test('a row is a real button with a duplicate control, grouped by tier, chipped by capability', async () => {
  routes['/api/components'] = { components: [
    { name: 'form-renderer', description: 'builtin one', location: 'local', builtin: true },
    { name: 'deploy-board', description: 'Live deploys.', location: 'local', has_service: true, has_seed: true, params_schema: { properties: { env: {} } } },
    { name: 'shared-thing', description: 'from the user tier', location: 'system', shadows: ['system'] },
    { name: 'mismatched', description: 'meta disagrees', location: 'local', meta_name: 'Mismatched' },
  ] };
  const { invalidate } = await import(pathToFileURL(path.join(REPO, 'public/app/components.js')).href);
  invalidate();
  if (drawerOpen()) { key('Escape'); await tick(); }
  await openDrawer();
  await tick();

  const lib = $('drawer-library');
  const groups = [...lib.querySelectorAll('.de-group')].map((g) => g.textContent);
  assert.deepEqual(groups, ['BUILT-IN', 'THIS PROJECT', 'ALL PROJECTS']);

  const rows = [...lib.querySelectorAll('.drawer-entry')];
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.equal(r.querySelector('.de-main').tagName, 'BUTTON', 'a row is a real button…');
    assert.equal(r.getAttribute('role'), null, '…not role=option (an option must not contain interactive children)');
    assert.equal(r.querySelector('.de-dup').tagName, 'BUTTON', 'and carries its own duplicate control');
  }

  const chipsOf = (name) => {
    const row = rows.find((r) => r.querySelector('.de-name').textContent === name);
    return [...row.querySelectorAll('.de-chip')].map((c) => c.textContent);
  };
  assert.ok(chipsOf('form-renderer').includes('built-in'));
  const deploy = chipsOf('deploy-board');
  assert.ok(deploy.includes('service'));
  assert.ok(deploy.includes('seed'));
  assert.ok(deploy.includes('form'), 'a params_schema means the drawer can build a form for it');
  assert.ok(chipsOf('shared-thing').includes('all projects'));
  assert.ok(chipsOf('shared-thing').some((c) => c.startsWith('shadows')));
  assert.ok(chipsOf('mismatched').some((c) => c.includes('Mismatched')),
    'the registry lists by directory; a meta.json that disagrees is flagged, not silently preferred');
});

test('a service awaiting approval says so, and names the terminal command', async () => {
  routes['/api/components'] = { components: [{ name: 'deploy-board', description: 'd', location: 'local', has_service: true }] };
  routes['/api/services/pending'] = { ok: true, pending: [{ name: 'deploy-board' }] };
  const { invalidate } = await import(pathToFileURL(path.join(REPO, 'public/app/components.js')).href);
  invalidate();
  if (drawerOpen()) { key('Escape'); await tick(); }
  await openDrawer();
  await tick();

  const row = $('drawer-library').querySelector('.drawer-entry');
  assert.ok([...row.querySelectorAll('.de-chip')].some((c) => /needs approval/.test(c.textContent)));
  const cmd = row.querySelector('.rn-cmd');
  assert.equal(cmd.textContent, 'claude-web-chat trust deploy-board');
  routes['/api/services/pending'] = { ok: true, pending: [] };
});

// ── spawning ────────────────────────────────────────────────────────────────

test('a row spawns into a STABLE slot; ⧉ takes the next one', async () => {
  routes['/api/components'] = { components: [{ name: 'deploy-board', description: 'd', location: 'local' }] };
  const { invalidate } = await import(pathToFileURL(path.join(REPO, 'public/app/components.js')).href);
  invalidate();
  if (drawerOpen()) { key('Escape'); await tick(); }
  await openDrawer();
  await tick();

  calls.length = 0;
  press($('drawer-library').querySelector('.de-main'));
  await tick();
  const first = calls.find((c) => c.url === '/api/components/deploy-board/use');
  assert.equal(first.body.id, 'spawn-deploy-board', 'a stable slot — panes stop stacking forever');
  assert.ok(!drawerOpen(), 'spawning closes the drawer');

  await openDrawer();
  await tick();
  calls.length = 0;
  press($('drawer-library').querySelector('.de-dup'));
  await tick();
  const dup = calls.find((c) => c.url === '/api/components/deploy-board/use');
  assert.equal(dup.body.id, 'spawn-deploy-board-2', '⧉ mints the next free slot');
});

test('a component with a schema it cannot satisfy spawns the form first', async () => {
  routes['/api/components'] = { components: [
    { name: 'deploy-board', description: 'd', location: 'local', params_schema: { properties: { env: {} }, required: ['env'] } },
  ] };
  const { invalidate } = await import(pathToFileURL(path.join(REPO, 'public/app/components.js')).href);
  invalidate();
  if (drawerOpen()) { key('Escape'); await tick(); }
  await openDrawer();
  await tick();

  calls.length = 0;
  press($('drawer-library').querySelector('.de-main'));
  await tick();
  const form = calls.find((c) => c.url === '/api/components/form-renderer/use');
  assert.ok(form, 'the form-renderer went up first');
  assert.equal(form.body.id, 'spawn-form-deploy-board');
  assert.equal(form.body.params.submit_key, '__spawn_deploy-board', 'ONE stable signal key per component');
  assert.equal(calls.some((c) => c.url === '/api/components/deploy-board/use'), false, 'and the component waits for it');
});

test('a soft rejection is READ and reported, not discarded as success', async () => {
  routes['/api/components'] = { components: [{ name: 'owned-pane', description: 'd', location: 'local' }] };
  const { invalidate } = await import(pathToFileURL(path.join(REPO, 'public/app/components.js')).href);
  invalidate();
  if (drawerOpen()) { key('Escape'); await tick(); }
  await openDrawer();
  await tick();

  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  await withFetch(
    async (url) => (url === '/api/components/owned-pane/use'
      ? jsonRes({ ok: false, rejected: true, owned: true, owner: 'service:git', hint: "pane 'x' is owned by 'service:git'" })
      : null),
    async () => {
      press($('drawer-library').querySelector('.de-main'));
      await tick();
    },
  );
  console.warn = realWarn;
  assert.ok(warned.join(' ').includes("owned by 'service:git'"),
    'the lockReject envelope used to be thrown away, so a refusal looked exactly like success');
});

// ── Manage ──────────────────────────────────────────────────────────────────

test('the install form leads with Download for review, and says what a pack is', async () => {
  if (drawerOpen()) { key('Escape'); await tick(); }
  await openDrawer();
  press($('drawer-tab-manage'));
  await tick();

  const actions = $('drawer-manage').querySelector('.pk-actions');
  const [primary, secondary] = [...actions.querySelectorAll('button')];
  assert.equal(primary.textContent, 'Download for review');
  assert.ok(primary.classList.contains('primary'), 'review is the advised default');
  assert.equal(secondary.textContent, 'Install now');
  assert.ok(!secondary.classList.contains('primary'));

  const warn = $('drawer-manage').querySelector('.pk-warn').textContent;
  assert.match(warn, /run in this page/);
  assert.match(warn, /service\.js/);
  assert.match(warn, /claude-web-chat trust/);
  assert.match(warn, /SKILL\.md/, 'the skill becoming part of Claude’s instructions is the thing people miss');

  assert.ok($('pk-global'), 'the all-projects checkbox is present — and it genuinely works (see pack-routes)');
});

test('Install now takes a second click for a URL that was never reviewed', async () => {
  await openDrawer();
  press($('drawer-tab-manage'));
  await tick();
  $('pk-url').value = 'https://github.com/acme/never-read';
  const now = [...$('drawer-manage').querySelectorAll('.pk-actions button')][1];

  calls.length = 0;
  press(now);
  await tick();
  assert.equal(calls.some((c) => c.url === '/api/packs/install'), false, 'the first click arms, it does not install');
  assert.match(now.textContent, /click again/);
  assert.match($('drawer-manage').querySelector('.pk-status').textContent, /without reviewing/);

  press(now);
  await tick();
  assert.ok(calls.some((c) => c.url === '/api/packs/install'), 'the second click goes ahead');
  // …and never a native dialog, which blocks the browser and wedges drivers.
  assert.equal(W.confirm && W.confirm.called, undefined);
});

test('Download for review posts to quarantine, never to install', async () => {
  await openDrawer();
  press($('drawer-tab-manage'));
  await tick();
  $('pk-url').value = 'https://github.com/acme/ops-pack';
  calls.length = 0;
  press([...$('drawer-manage').querySelectorAll('.pk-actions button')][0]);
  await tick();
  const q = calls.find((c) => c.url === '/api/packs/quarantine');
  assert.ok(q, 'it quarantines');
  assert.equal(q.body.url, 'https://github.com/acme/ops-pack');
  assert.equal(q.body.global, false);
  assert.equal(calls.some((c) => c.url === '/api/packs/install'), false);
});

test('a quarantine card shows provenance, services, and SKILL.md inline', async () => {
  routes['/api/packs'] = { ok: true, packs: [], quarantined: [{
    name: 'acme-ops', version: '1.2.0', tier: 'local',
    description: 'Acme ops panes.',
    source: { url: 'https://github.com/acme/ops-pack', via: 'release', ref: 'v1.2.0', sums_verified: true, sha: '4f8c2a1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    services: ['deploy-board'],
    components: [
      { name: 'deploy-board', description: 'Live deploys.', has_service: true, has_seed: false },
      { name: 'incident-timeline', description: 'Incidents.', has_service: false, has_seed: true },
    ],
    skill: { description: 'Use when the user asks about deploys.', dest: '.claude/skills/acme-ops/SKILL.md' },
    errors: [], collisions: [], files: 6, present: true,
  }] };
  if (drawerOpen()) { key('Escape'); await tick(); }
  await openDrawer();
  press($('drawer-tab-manage'));
  await tick();

  const card = $('drawer-manage').querySelector('.pk-quarantined');
  assert.ok(card, 'the quarantined pack has a card');
  assert.match(card.querySelector('.pk-prov').textContent, /release v1\.2\.0 · sha256 verified · 4f8c2a1/);
  assert.ok([...card.querySelectorAll('.de-chip')].some((c) => /service\.js/.test(c.textContent)),
    'a component carrying host code is flagged before approval, not after');
  assert.deepEqual([...card.querySelectorAll('.pk-unit .de-name')].map((n) => n.textContent),
    ['deploy-board', 'incident-timeline'],
    'every component it would add is listed — not only the ones with a service');

  const skill = card.querySelector('.pk-skill');
  assert.ok(skill, 'SKILL.md is expandable inline — the artefact nobody thinks to read');
  assert.match(skill.querySelector('summary').textContent, /what this tells Claude/);
  assert.match(skill.textContent, /Use when the user asks about deploys/);

  const badge = $('drawer-tabs').querySelector('[data-tab="manage"] .tab-badge');
  assert.equal(badge.textContent, '1');
  assert.ok(!badge.classList.contains('hidden'), 'the Manage tab says something is waiting');
});

test('a builtin collision renders as a refusal with NO override control at all', async () => {
  routes['/api/packs'] = { ok: true, packs: [], quarantined: [{
    name: 'evil-pack', tier: 'local',
    source: { via: 'archive', sha: 'deadbee0000000000000000000000000000000000' },
    services: [],
    errors: ['component "git-dashboard" is a built-in name — refused'],
    collisions: [{ kind: 'component', name: 'git-dashboard', severity: 'refused', owner: 'builtin', detail: '"git-dashboard" is a built-in component. There is no override.' }],
    files: 3, present: true,
  }] };
  if (drawerOpen()) { key('Escape'); await tick(); }
  await openDrawer();
  press($('drawer-tab-manage'));
  await tick();

  const card = $('drawer-manage').querySelector('.pk-quarantined');
  assert.match(card.textContent, /There is no override/);
  const labels = [...card.querySelectorAll('.pk-actions button')].map((b) => b.textContent);
  assert.equal(labels.includes('Install it'), false, 'no install control — not a disabled one, none');
  assert.ok(labels.includes('Discard'), 'discarding it is still offered — nothing was ever live');
});

test('a user-component collision offers keep-mine / replace, and replace is a terminal command', async () => {
  routes['/api/packs'] = { ok: true, packs: [], quarantined: [{
    name: 'acme-ops', tier: 'local',
    source: { via: 'archive', sha: 'abc1234000000000000000000000000000000000' },
    services: [], errors: [],
    collisions: [{ kind: 'component', name: 'deploy-board', severity: 'replace', owner: 'you', detail: 'you already have a component called "deploy-board"' }],
    files: 3, present: true,
  }] };
  if (drawerOpen()) { key('Escape'); await tick(); }
  await openDrawer();
  press($('drawer-tab-manage'));
  await tick();

  const card = $('drawer-manage').querySelector('.pk-quarantined');
  assert.match(card.textContent, /Already exists/);
  assert.match(card.textContent, /keeps yours/);
  assert.equal(card.querySelector('.rn-cmd').textContent, 'claude-web-chat pack approve acme-ops --replace');
  assert.ok([...card.querySelectorAll('.pk-actions button')].some((b) => b.textContent === 'Install it'),
    'installing (which keeps yours) is still offered');
});

test('a drifted pack refuses to be removed from here, and shows the terminal command', async () => {
  routes['/api/packs'] = { ok: true, quarantined: [], packs: [{
    name: 'acme-ops', version: '1.2.0', tier: 'local', drift: true,
    description: 'Acme ops panes.',
    source: { via: 'archive', sha: 'abc1234000000000000000000000000000000000' },
    components: ['deploy-board'], services: [], skill: null,
  }] };
  if (drawerOpen()) { key('Escape'); await tick(); }
  await openDrawer();
  press($('drawer-tab-manage'));
  await tick();

  const card = $('drawer-manage').querySelector('.pk-card');
  assert.ok([...card.querySelectorAll('.de-chip')].some((c) => c.textContent === 'locally edited'));

  await withFetch(
    async (url, opts) => ((url === '/api/packs/acme-ops' && opts && opts.method === 'DELETE')
      ? jsonRes({ ok: false, drift: true, hint: '"acme-ops" has local edits', command: 'claude-web-chat pack remove acme-ops' })
      : null),
    async () => {
      press([...card.querySelectorAll('.pk-actions button')].find((b) => b.textContent === 'Remove'));
      await tick();
    },
  );

  assert.equal(card.querySelector('.rn-cmd').textContent, 'claude-web-chat pack remove acme-ops');
  assert.match(card.textContent, /you have edited this/i);
});

test('with no pack routes on the daemon, Manage degrades to a sentence and a command', async () => {
  if (drawerOpen()) { key('Escape'); await tick(); }
  await withFetch(
    async (url) => (url === '/api/packs' ? { ok: false, status: 404, json: async () => ({}), text: async () => '' } : null),
    async () => {
      await openDrawer();
      press($('drawer-tab-manage'));
      await tick();
    },
  );

  const manage = $('drawer-manage');
  assert.match(manage.textContent, /Not wired to this build yet/);
  assert.equal(manage.querySelector('.rn-cmd').textContent, 'claude-web-chat pack get <repository-url>');
  assert.equal(manage.querySelector('.pk-url'), null, 'and offers no form it could not honour');
  routes['/api/packs'] = { ok: true, packs: [], quarantined: [] };
});

// ── the shared cache ────────────────────────────────────────────────────────

test('a `components` WS frame invalidates the ONE cache the palette also reads', async () => {
  routes['/api/components'] = { components: [{ name: 'before-install', description: 'd', location: 'local' }] };
  const mod = await import(pathToFileURL(path.join(REPO, 'public/app/components.js')).href);
  mod.invalidate();
  assert.deepEqual((await mod.components()).map((c) => c.name), ['before-install']);

  // An install happens somewhere — this browser's drawer, another browser, or the
  // CLI's `pack announce`. The daemon broadcasts `components`.
  routes['/api/components'] = { components: [
    { name: 'before-install', description: 'd', location: 'local' },
    { name: 'deploy-board', description: 'from a pack', location: 'local' },
  ] };
  assert.deepEqual((await mod.components()).map((c) => c.name), ['before-install'], 'still cached until told otherwise');

  mod.invalidate();  // what the ws `components` handler calls
  const after = (await mod.components()).map((c) => c.name);
  assert.ok(after.includes('deploy-board'),
    'the palette used to memoise its own copy and never invalidate it, so an install was invisible until reload');
});

test('the ⌘K palette offers Component packs… and lists components from that one cache', async () => {
  if (drawerOpen()) { key('Escape'); await tick(); }
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'k', metaKey: true }));
  await tick();
  const labels = [...$('cmd-list').querySelectorAll('.palette-item')].map((r) => r.textContent);
  assert.ok(labels.some((l) => l.includes('Component packs…')));
  assert.ok(labels.some((l) => l.includes('deploy-board')), 'the freshly-installed component is here without a reload');
  key('Escape');
});

test('a transient fetch failure does NOT poison the component cache for the session', async () => {
  const mod = await import(pathToFileURL(path.join(REPO, 'public/app/components.js')).href);
  routes['/api/components'] = { components: [{ name: 'deploy-board', description: 'd', location: 'local' }] };
  mod.invalidate();

  // The daemon blips while the drawer is opening.
  await withFetch(
    async (url) => (url === '/api/components' ? Promise.reject(new Error('network down')) : null),
    async () => { assert.deepEqual(await mod.components(), [], 'the failed call answers empty, which is honest'); },
  );

  // …and the very next call retries rather than serving a cached []. A cached
  // empty list is indistinguishable from "this project has no components", and
  // nothing but a WS frame or a reload would ever have cleared it — so one blip
  // left the Library tab and the ⌘K palette permanently empty.
  assert.deepEqual((await mod.components()).map((c) => c.name), ['deploy-board']);
});
