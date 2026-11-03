// Orphans visible, and the re-anchor affordance (annotation engine 2A.6;
// public/app/orphans.js). The real chrome (test-support/chrome-shell, booted
// once); the overlay's answers come from the real resolver and the real
// hidden-state probe (U303).
//
// Pinned here:
//   - an overlay with three orphans (one carried guess, two guess-less) and one
//     hidden element (a service-backed pane whose service waits on trust): the
//     ⌘K row's count, the stand-in popover and the inspector section for the
//     node on screen list exactly the three; the hidden one is absent; the
//     inspector shows no section for a node that is not on screen;
//   - the C-10-shaped carried guess (a converted pin whose text no longer
//     matches; the guess is the labelled element) is drawn at the labelled
//     truth; clicking it opens the card; 'Leave it' sends nothing; 'Re-anchor
//     here' sends exactly one PATCH /api/elements/<id> whose body carries the
//     anchor record() makes of the guess element, the version the overlay holds
//     and the device claim; the live set then takes the new version;
//   - a refusal ({ok:false, refused, hint}) shows the hint in the card and
//     changes nothing;
//   - a guess-less orphan: 'Re-anchor…' arms a pick; Escape cancels it with no
//     request; a click on an element writes one PATCH with that element's
//     record;
//   - while previewing every write path shows READONLY_HINT and sends nothing,
//     while the list and the guess still show;
//   - a section fallback (a source record whose quote and bracket are gone,
//     drawn over its section; never an orphan): a click on its marker opens the
//     card with the section wording, and 'Re-anchor here' sends the guess
//     case's PATCH shape with a source anchor over the section (K.2-74);
//   - the section card's own refusal: when 'Re-anchor here' finds the section
//     gone or longer than CONFIG.quote_max, the card shows NO_SECTION_HINT
//     (never the guess's NO_GUESS_HINT) and sends nothing (K.2-79; U328e);
//   - a preview opened while a pick is pending leaves the card up with
//     READONLY_HINT and sends nothing (K.2-74).
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { convertAnchor } = require('../lib/core/element-log');

let shell, W, M, ov, oh, sp, anchors, bus, topbar, orph, gv, sh, md;
const states = new Map();   // id → the newest answer's state

// The pane whose lead line was edited after the pin was dropped: the pin's
// locator still names `p.lead`, ordinal 0, with the OLD text, so the resolver
// carries the labelled element (the lead line) as a guess (C-10, K-10).
const P1 = {
  id: 'p1', target: 'main', params: {},
  html: '<p class="lead">lead of p1, edited since</p><p class="other">another line</p><button class="go">Go</button>',
};
const P2 = { id: 'p2', target: 'main', params: {}, html: '<p class="lead">lead of p2</p>' };
// A service-backed pane whose service is waiting on trust: an anchor that does
// not resolve there is HIDDEN (service-pending), never an orphan.
const SVC = { id: 'svc', target: 'main', params: {}, component: 'svc-x', html: '<div class="rows"></div>' };

const GUESS = { id: 'c10', v: 1, type: 'comment', shared: true, replies: 0,
  anchor: convertAnchor({ mount: 'p1', selector: 'p.lead', ordinal: 0, text: 'lead of p1' }) };
const LOST1 = { id: 'c11', v: 3, type: 'comment', shared: true, replies: 0,
  anchor: convertAnchor({ mount: 'p1', selector: 'p.vanished', ordinal: 0, text: 'gone' }) };
const LOST2 = { id: 'c12', v: 1, type: 'comment', shared: true, replies: 0,
  anchor: convertAnchor({ mount: 'p2', selector: 'p.vanished', ordinal: 0, text: 'gone too' }) };
const HIDDEN = { id: 'c13', v: 1, type: 'comment', shared: true, replies: 0,
  anchor: convertAnchor({ mount: 'svc', selector: 'div.row', ordinal: 0, text: 'a row' }) };
const ROWS = [GUESS, LOST1, LOST2, HIDDEN];

// The labelled truth has its own box; everything else is the whole window.
const LEAD_BOX = { left: 300, top: 150, width: 120, height: 18, right: 420, bottom: 168, x: 300, y: 150 };
const WHOLE = { left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800, x: 0, y: 0 };
const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const lead = () => rootOf('p1').querySelector('p.lead');
const rectOf = (x) => (x === lead() ? LEAD_BOX : WHOLE);

// What PATCH /api/elements/:id answers: set per test.
let patchAnswer = null;
const patches = () => shell.calls.filter((c) => c.method === 'PATCH' && c.url.startsWith('/api/elements/'));
const orphanIds = () => ov.orphans().map((o) => o.id);
const card = () => W.document.querySelector('.wc-reanchor-card');
const listPop = () => W.document.querySelector('.wc-orphans-pop');
const rowIdsIn = (el) => [...el.querySelectorAll('.wc-orphan-row')].map((r) => r.dataset.elId);
const markersFor = (id) => [...W.document.getElementById('el-layer').querySelectorAll('.el-marker')]
  .filter((m) => (m.dataset.elIds || '').split(' ').includes(id));
const liveRow = (id) => ov.elementsOf('live').find((r) => r.id === id);
const noteText = () => (card() && card().querySelector('.wc-reanchor-note').textContent) || '';
const btn = (cls) => card() && card().querySelector(`.${cls}`);

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/graph': { nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }, { id: 'n2', label: 'n2', parent_id: 'n1', created_at: 2 }], active: 'n1' },
      '/api/services/pending': { ok: true, pending: [{ name: 'svc-x' }] },
      '/api/elements/*': (url, init) => {
        if (!init || String(init.method).toUpperCase() !== 'PATCH') return respond({ error: 'not stubbed' }, { status: 404 });
        return typeof patchAnswer === 'function' ? patchAnswer(url, init) : patchAnswer;
      },
    },
  });
  W = shell.window;
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  oh = await shell.importApp('overlay-hidden.js');
  sp = await shell.importApp('service-pending.js');
  anchors = (await shell.importApp('anchors.js')).default;
  ({ bus } = await shell.importApp('bus.js'));
  topbar = await shell.importApp('topbar.js');
  orph = await shell.importApp('orphans.js');
  gv = await shell.importApp('graph-view.js');
  sh = await shell.importApp('shell.js');
  md = await shell.importApp('markdown.js');
  ov.initOverlay({ rectOf });
  ov.onAnswers((m) => { for (const i of m.items) states.set(i.id, i.state); });
  await waitUntil(() => sp.pendingServices().has('svc-x'), { timeout: 4000, what: 'the pending list to name svc-x' });
  await shell.frame(helloFrame({ active: 'n1', mounts: [P1, P2, SVC] }));
  ov.setElements('live', ROWS);
  // Past every pane's mount grace (a pane still mounting reads hidden).
  await new Promise((r) => setTimeout(r, oh.MOUNT_GRACE_MS + 60));
  await waitUntil(() => orphanIds().join() === 'c10,c11,c12', { timeout: 4000, what: 'the three orphans' });
});

after(async () => { if (shell) await shell.restore(); });

test('the three orphans are listed in the ⌘K row, the stand-in popover and the inspector for the node on screen; the hidden one nowhere', async () => {
  assert.deepEqual(orphanIds(), ['c10', 'c11', 'c12']);
  assert.equal(states.get('c13'), 'hidden', 'the service-pending pane\'s element reads hidden (U303)');
  assert.ok(!orphanIds().includes('c13'), 'the hidden element is never an orphan');
  // ⌘K: one row, counting three.
  sh.openPalette();
  await waitUntil(() => shell.$('cmd-list').querySelector('.palette-item'), { timeout: 3000, what: 'the palette rows' });
  const labels = [...shell.$('cmd-list').querySelectorAll('.palette-item')].map((r) => r.textContent);
  const row = labels.filter((l) => /Orphaned elements/.test(l));
  assert.equal(row.length, 1, `one palette row: ${labels.join(' | ')}`);
  assert.match(row[0], /Orphaned elements \(3\)/);
  // Running it opens the stand-in list.
  const item = [...shell.$('cmd-list').querySelectorAll('.palette-item')].find((r) => /Orphaned elements/.test(r.textContent));
  // A palette row runs on its mousedown (shell.js renderPalette).
  item.dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await shell.tick();
  assert.ok(listPop(), 'the stand-in list is open');
  assert.equal(shell.$('cmd-palette').classList.contains('hidden'), true, 'the palette closed');
  assert.deepEqual(rowIdsIn(listPop()), ['c10', 'c11', 'c12']);
  assert.ok(!listPop().querySelector('[id]'), 'classes only, never an element id');
  const r10 = listPop().querySelector('[data-el-id="c10"]');
  assert.equal(r10.querySelector('.wc-orphan-type').textContent, 'comment');
  assert.equal(r10.querySelector('.wc-orphan-place').textContent, 'pane p1');
  assert.ok(r10.querySelector('.wc-orphan-guess'), 'the carried guess is flagged');
  assert.equal(listPop().querySelector('[data-el-id="c11"] .wc-orphan-guess'), null);
  // Escape closes it through the one dismiss layer.
  shell.key('Escape');
  await shell.tick();
  assert.equal(listPop(), null, 'Escape closes the list');
  // The list re-opens and an outside press closes it.
  orph.openOrphanList();
  shell.press(shell.$('topbar') || W.document.body);
  await shell.tick();
  assert.equal(listPop(), null, 'an outside press closes the list');

  // The inspector: the node on screen (n1, active) has the section …
  await gv.openOverlay();
  await gv.selectNode('n1');
  await waitUntil(() => shell.$('gv-inspector').querySelector('.wc-orphans-insp'), { timeout: 3000, what: 'the inspector section' });
  const sec = shell.$('gv-inspector').querySelector('.wc-orphans-insp');
  assert.deepEqual(rowIdsIn(sec), ['c10', 'c11', 'c12']);
  assert.match(sec.textContent, /ORPHANED ELEMENTS · 3/);
  // … a node not on screen has none.
  await gv.selectNode('n2');
  await waitUntil(() => /n2/.test((shell.$('gv-inspector').querySelector('.gv-insp-label') || {}).textContent || ''), { timeout: 3000, what: 'n2 inspected' });
  await shell.tick(20);
  assert.equal(shell.$('gv-inspector').querySelector('.wc-orphans-insp'), null, 'no section for a node not on screen');
  gv.closeOverlay();
  assert.equal(patches().length, 0, 'listing writes nothing');
});

test('the carried guess is drawn at the labelled truth; its card: Leave it writes nothing; a refusal shows its hint and changes nothing; Re-anchor here writes one PATCH with record() of the guess element', async () => {
  await waitUntil(() => markersFor('c10').some((m) => m.style.display !== 'none'), { timeout: 3000, what: 'the guess marker drawn' });
  const [m] = markersFor('c10');
  assert.ok(m.classList.contains('el-guess'), 'drawn as a carried guess, never a hit');
  assert.equal(m.style.left, `${LEAD_BOX.left}px`, 'at the labelled truth (the lead line)');
  assert.equal(m.style.top, `${LEAD_BOX.top}px`);
  const seen = [];
  const off = bus.on('overlay:guess', (d) => seen.push(d));
  try {
    // A click on the guess marker opens the card.
    shell.click(m);
    await shell.tick();
    assert.equal(seen.length, 1);
    assert.ok(card(), 'the card is open');
    assert.equal(card().dataset.elId, 'c10');
    assert.ok(btn('wc-reanchor-here') && btn('wc-reanchor-leave'));
    // Leave it: nothing sent, the card closes.
    shell.click(btn('wc-reanchor-leave'));
    await shell.tick(20);
    assert.equal(card(), null);
    assert.equal(patches().length, 0, 'Leave it sends nothing');

    // A refusal: its hint in the card, nothing changed.
    const before_ = JSON.stringify(liveRow('c10'));
    patchAnswer = respond({ ok: false, refused: 'stale', hint: 'H-REFUSED: someone moved it first' }, { status: 409 });
    shell.click(markersFor('c10')[0]);
    await shell.tick();
    shell.click(btn('wc-reanchor-here'));
    await waitUntil(() => /H-REFUSED/.test(noteText()), { timeout: 3000, what: 'the refusal hint' });
    assert.equal(patches().length, 1);
    assert.ok(card().querySelector('.wc-reanchor-note').classList.contains('wc-refused'));
    assert.equal(JSON.stringify(liveRow('c10')), before_, 'the live set is unchanged');
    assert.deepEqual(orphanIds(), ['c10', 'c11', 'c12']);
    shell.key('Escape');
    await shell.tick();
    assert.equal(card(), null, 'Escape closes the card');

    // Re-anchor here: one PATCH whose anchor is record() of the guess element.
    const want = anchors.record(rootOf('p1'), lead(), { mount: 'p1' });
    assert.ok(want && want.kind === 'element');
    patchAnswer = (url, init) => {
      const b = JSON.parse(init.body);
      return { ok: true, pin: { id: 'c10', v: 2 }, element: { id: 'c10', v: 2, type: 'comment', record: b.anchor, anchor: b.anchor } };
    };
    const n0 = patches().length;
    shell.click(markersFor('c10')[0]);
    await shell.tick();
    shell.click(btn('wc-reanchor-here'));
    await waitUntil(() => /Re-anchored/.test(noteText()), { timeout: 3000, what: 'the re-anchored line' });
    const sent = patches().slice(n0);
    assert.equal(sent.length, 1, 'exactly one PATCH');
    assert.equal(sent[0].url, '/api/elements/c10');
    assert.deepEqual(sent[0].body.anchor, want, 'the anchor record() makes of the guess element');
    assert.equal(sent[0].body.device, 'desktop', 'the device claim');
    assert.equal(sent[0].body.base_v, 1, 'the version the overlay holds');
    assert.deepEqual(Object.keys(sent[0].body).sort(), ['anchor', 'base_v', 'device'], 'an anchor-only re-anchor body');
    assert.equal(noteText(), 'Re-anchored · anchor v2 written, the node untouched');
    assert.equal(liveRow('c10').v, 2, 'the live set takes the new version');
    assert.deepEqual(liveRow('c10').anchor, want);
    await waitUntil(() => !orphanIds().includes('c10'), { timeout: 3000, what: 'c10 re-found' });
    shell.key('Escape');
    await shell.tick();
  } finally { off(); patchAnswer = null; }
});

test('a guess-less orphan: Re-anchor… arms a pick, Escape cancels it with no request; a click on an element writes one PATCH with its record', async () => {
  orph.openOrphanList();
  const act = () => listPop().querySelector('[data-el-id="c11"] .wc-orphan-act');
  const n0 = patches().length;
  shell.click(act());
  await shell.tick();
  assert.equal(listPop(), null, 'the list gives way to the card');
  assert.ok(card(), 'the pick card is up');
  assert.match(card().textContent, /click the element in a pane/);
  // Escape ends the pick: nothing sent, and a click on the page is the page's.
  shell.key('Escape');
  await shell.tick();
  assert.equal(card(), null);
  W.__goClicked = 0;
  rootOf('p1').querySelector('button.go').addEventListener('click', () => { W.__goClicked++; }, { once: true });
  shell.press(rootOf('p1').querySelector('button.go'));
  await shell.tick(20);
  assert.equal(W.__goClicked, 1, 'the cancelled pick no longer takes the click');
  assert.equal(patches().length, n0, 'Escape sends nothing');

  // Again, and pick the other line.
  patchAnswer = (url, init) => {
    const b = JSON.parse(init.body);
    return { ok: true, pin: { id: 'c11', v: 4 }, element: { id: 'c11', v: 4, type: 'comment', record: b.anchor } };
  };
  try {
    orph.openOrphanList();
    shell.click(act());
    await shell.tick();
    const other = rootOf('p1').querySelector('p.other');
    const want = anchors.record(rootOf('p1'), other, { mount: 'p1' });
    shell.press(other);
    await waitUntil(() => /Re-anchored/.test(noteText()), { timeout: 3000, what: 'the picked re-anchor written' });
    const sent = patches().slice(n0);
    assert.equal(sent.length, 1, 'one PATCH');
    assert.equal(sent[0].url, '/api/elements/c11');
    assert.deepEqual(sent[0].body.anchor, want, 'the clicked element\'s record');
    assert.equal(sent[0].body.anchor.kind, 'element', 'the element\'s own anchor kind');
    assert.equal(sent[0].body.base_v, 3);
    assert.equal(sent[0].body.device, 'desktop');
    assert.equal(noteText(), 'Re-anchored · anchor v4 written, the node untouched');
    assert.equal(liveRow('c11').v, 4);
    await waitUntil(() => !orphanIds().includes('c11'), { timeout: 3000, what: 'c11 re-found' });
    shell.key('Escape');
    await shell.tick();
  } finally { patchAnswer = null; }
});

test('a section fallback: its marker opens the card with the section wording; Re-anchor here sends the guess case\'s PATCH shape with a source anchor over the section', async () => {
  const before0 = '## Plan\n\nAlpha beta gamma delta epsilon zeta.\n\n## Other\n\nUnrelated words.\n';
  const after0 = '## Plan\n\nEverything here was rewritten from scratch.\n\n## Other\n\nUnrelated words.\n';
  await shell.frame({ type: 'markdown', id: 'md-sec', text: before0, owner: 'claude' });
  const block = () => M.itemEl(W.document, 'md-sec').el;
  const tn = block().querySelector('p').firstChild;
  const at = tn.data.indexOf('gamma delta');
  const range = W.document.createRange();
  range.setStart(tn, at);
  range.setEnd(tn, at + 'gamma delta'.length);
  const rec = anchors.recordSource(block(), range, md.sourceMap(before0), before0);
  assert.ok(rec && rec.kind === 'source' && rec.slug === 'plan');
  // A range's box inside the window, so the generic marker's glyph shows.
  const SEC_BOX = { left: 200, top: 400, width: 80, height: 16, right: 280, bottom: 416, x: 200, y: 400 };
  // The markdown item's own box (F.3): a comment on markdown draws its glyph
  // in the item's left margin, so the item sits inside the window too.
  const MD_BOX = { left: 180, top: 380, width: 600, height: 120, right: 780, bottom: 500, x: 180, y: 380 };
  ov.initOverlay({ rectOf: (x) => (x && typeof x.cloneContents === 'function' ? SEC_BOX
    : x && x.dataset && x.dataset.mdId != null ? MD_BOX : rectOf(x)) });
  const S = { id: 'c30', v: 1, type: 'comment', shared: true, replies: 0, anchor: rec };
  ov.upsertElements('live', [S]);
  const seen = [];
  const off = bus.on('overlay:guess', (d) => seen.push(d));
  patchAnswer = (url, init) => {
    const b = JSON.parse(init.body);
    return { ok: true, element: { id: 'c30', v: 2, type: 'comment', record: b.anchor } };
  };
  const n0 = patches().length;
  try {
    await waitUntil(() => states.get('c30') === 'exact', { timeout: 3000, what: 'c30 a hit' });
    await shell.frame({ type: 'markdown', id: 'md-sec', text: after0, owner: 'claude' });
    await waitUntil(() => markersFor('c30').some((m) => m.classList.contains('el-section') && m.style.display !== 'none'),
      { timeout: 3000, what: 'the section fallback drawn' });
    assert.ok(!orphanIds().includes('c30'), 'a section fallback is never an orphan');
    shell.click(markersFor('c30')[0]);
    await shell.tick();
    assert.deepEqual(seen, [{ id: 'c30', v: 1, type: 'comment', mount: 'md-sec', scope: 'live', how: 'section' }]);
    assert.ok(card(), 'the card is open');
    assert.equal(card().dataset.elId, 'c30');
    assert.equal(card().querySelector('.wc-reanchor-text').textContent, orph.sectionText('markdown md-sec', 1));
    assert.match(card().textContent, /anchored to its section/);
    assert.ok(btn('wc-reanchor-here') && btn('wc-reanchor-leave'));
    // What the resolver answers at the press, recorded as a source anchor.
    const map = md.sourceMap(after0);
    const ans = anchors.resolveSource(block(), after0, map, rec);
    assert.equal(ans.how, 'section');
    const want = anchors.recordSource(block(), ans.range, map, after0, { md: 'md-sec' });
    assert.ok(want && want.kind === 'source' && want.slug === 'plan', 'a source anchor over the Plan section');
    shell.click(btn('wc-reanchor-here'));
    await waitUntil(() => /Re-anchored/.test(noteText()), { timeout: 3000, what: 'the re-anchored line' });
    const sent = patches().slice(n0);
    assert.equal(sent.length, 1, 'exactly one PATCH');
    assert.equal(sent[0].url, '/api/elements/c30');
    assert.deepEqual(Object.keys(sent[0].body).sort(), ['anchor', 'base_v', 'device'], 'the guess case\'s anchor-only body');
    assert.deepEqual(sent[0].body.anchor, want);
    assert.equal(sent[0].body.base_v, 1);
    assert.equal(sent[0].body.device, 'desktop');
    assert.equal(noteText(), 'Re-anchored · anchor v2 written, the node untouched');
    assert.equal(liveRow('c30').v, 2);
    assert.deepEqual(liveRow('c30').anchor, want);
    shell.key('Escape');
    await shell.tick();
  } finally {
    off();
    patchAnswer = null;
    ov.initOverlay({ rectOf });
    ov.removeElements('live', ['c30']);
    await shell.frame({ type: 'markdown:remove', id: 'md-sec' });
    await shell.tick();
  }
});

// K.2-79 (U328e): the section card offers no guess, so its refusal names the
// section: gone from the page, or too long to anchor to.
test('a section fallback whose section is too long or gone: Re-anchor here shows NO_SECTION_HINT and sends nothing', async () => {
  const before0 = '## Plan\n\nAlpha beta gamma delta epsilon zeta.\n\n## Other\n\nUnrelated words.\n';
  const after0 = '## Plan\n\nEverything here was rewritten from scratch.\n\n## Other\n\nUnrelated words.\n';
  const long0 = `## Plan\n\n${'Rewritten and grown well past any quote. '.repeat(80)}\n\n## Other\n\nUnrelated words.\n`;
  const gone0 = '## Other\n\nUnrelated words.\n';
  await shell.frame({ type: 'markdown', id: 'md-sec2', text: before0, owner: 'claude' });
  const block = () => M.itemEl(W.document, 'md-sec2').el;
  const tn = block().querySelector('p').firstChild;
  const at = tn.data.indexOf('gamma delta');
  const range = W.document.createRange();
  range.setStart(tn, at);
  range.setEnd(tn, at + 'gamma delta'.length);
  const rec = anchors.recordSource(block(), range, md.sourceMap(before0), before0);
  assert.ok(rec && rec.kind === 'source' && rec.slug === 'plan');
  const SEC_BOX = { left: 200, top: 400, width: 80, height: 16, right: 280, bottom: 416, x: 200, y: 400 };
  // The markdown item's own box (F.3): a comment on markdown draws its glyph
  // in the item's left margin, so the item sits inside the window too.
  const MD_BOX = { left: 180, top: 380, width: 600, height: 120, right: 780, bottom: 500, x: 180, y: 380 };
  ov.initOverlay({ rectOf: (x) => (x && typeof x.cloneContents === 'function' ? SEC_BOX
    : x && x.dataset && x.dataset.mdId != null ? MD_BOX : rectOf(x)) });
  ov.upsertElements('live', [{ id: 'c31', v: 1, type: 'comment', shared: true, replies: 0, anchor: rec }]);
  patchAnswer = { ok: true, element: { id: 'c31', v: 2, type: 'comment' } };
  const n0 = patches().length;
  try {
    await waitUntil(() => states.get('c31') === 'exact', { timeout: 3000, what: 'c31 a hit' });
    await shell.frame({ type: 'markdown', id: 'md-sec2', text: after0, owner: 'claude' });
    await waitUntil(() => markersFor('c31').some((m) => m.classList.contains('el-section') && m.style.display !== 'none'),
      { timeout: 3000, what: 'the section fallback drawn' });
    shell.click(markersFor('c31')[0]);
    await shell.tick();
    assert.ok(card() && card().dataset.elId === 'c31', 'the section card is open');
    assert.equal(card().querySelector('.wc-reanchor-noteline'), null, 'a comment marker names no note: no note line');
    // Too long: the Plan section grown past CONFIG.quote_max before the press.
    assert.ok(long0.length > 2000);
    await shell.frame({ type: 'markdown', id: 'md-sec2', text: long0, owner: 'claude' });
    await shell.tick();
    shell.click(btn('wc-reanchor-here'));
    await shell.tick();
    assert.equal(noteText(), orph.NO_SECTION_HINT, 'the refusal names the section');
    assert.notEqual(noteText(), orph.NO_GUESS_HINT);
    assert.ok(card().querySelector('.wc-reanchor-note').classList.contains('wc-refused'));
    // Gone: the Plan heading itself removed.
    await shell.frame({ type: 'markdown', id: 'md-sec2', text: gone0, owner: 'claude' });
    await shell.tick();
    assert.ok(card() && card().dataset.elId === 'c31', 'the card stays up across the re-render');
    card().querySelector('.wc-reanchor-note').textContent = '';
    shell.click(btn('wc-reanchor-here'));
    await shell.tick();
    assert.equal(noteText(), orph.NO_SECTION_HINT, 'gone: the same hint');
    assert.equal(patches().length, n0, 'nothing sent');
    shell.key('Escape');
    await shell.tick();
  } finally {
    patchAnswer = null;
    ov.initOverlay({ rectOf });
    ov.removeElements('live', ['c31']);
    await shell.frame({ type: 'markdown:remove', id: 'md-sec2' });
    await shell.tick();
  }
});

test('while previewing: the list and the guess still show; every write path answers READONLY_HINT and sends nothing', async () => {
  const node = {
    id: 'n2', mounts: [P1, P2], store: {}, created_at: 2,
    lean_elements: [
      { id: 'c20', v: 1, type: 'comment', shared: true, replies: 0, anchor: GUESS.anchor },
      { id: 'c21', v: 1, type: 'comment', shared: true, replies: 0, anchor: LOST2.anchor },
    ],
  };
  shell.setRoutes({ '/api/graph/node/n2': node });
  const n0 = patches().length;
  try {
    await topbar.previewNode('n2');
    await shell.tick();
    assert.equal(ov.drawnScopeOf(), 'preview');
    await new Promise((r) => setTimeout(r, oh.MOUNT_GRACE_MS + 60));
    await waitUntil(() => orphanIds().join() === 'c20,c21', { timeout: 4000, what: 'the preview\'s orphans' });
    assert.equal(orph.nodeOnScreen(), 'n2');
    // The list still shows.
    orph.openOrphanList();
    assert.deepEqual(rowIdsIn(listPop()), ['c20', 'c21']);
    // A guess-less row's Re-anchor…: the hint, no pick.
    shell.click(listPop().querySelector('[data-el-id="c21"] .wc-orphan-act'));
    await shell.tick();
    assert.equal(noteText(), topbar.READONLY_HINT);
    shell.press(rootOf('p1').querySelector('p.other'));
    await shell.tick(20);
    // The guess still shows, and its Re-anchor here answers the hint.
    await waitUntil(() => markersFor('c20').some((m) => m.style.display !== 'none'), { timeout: 3000, what: 'the preview guess drawn' });
    shell.click(markersFor('c20')[0]);
    await shell.tick();
    assert.equal(card().dataset.elId, 'c20');
    shell.click(btn('wc-reanchor-here'));
    await shell.tick(20);
    assert.equal(noteText(), topbar.READONLY_HINT);
    assert.equal(patches().length, n0, 'a preview sends nothing');
    shell.key('Escape');
    await shell.tick();
  } finally {
    topbar.returnToActive();
    await shell.tick();
  }
  assert.equal(ov.drawnScopeOf(), 'live');
});

test('a preview opened while a pick is pending: the card stays up with READONLY_HINT, and nothing is sent', async () => {
  const node = { id: 'n2', mounts: [P1, P2], store: {}, created_at: 2, lean_elements: [] };
  shell.setRoutes({ '/api/graph/node/n2': node });
  const n0 = patches().length;
  try {
    const row = liveRow('c11');
    orph.startPick({ id: 'c11', v: row.v, type: 'comment', mount: 'p1', scope: 'live' });
    await shell.tick();
    assert.ok(card(), 'the pick card is up');
    assert.match(card().textContent, /click the element in a pane/);
    await topbar.previewNode('n2');
    await shell.tick(20);
    assert.ok(card(), 'the card is still up');
    assert.equal(noteText(), topbar.READONLY_HINT);
    shell.press(rootOf('p1').querySelector('p.other'));
    await shell.tick(20);
    assert.equal(patches().length, n0, 'nothing sent');
  } finally {
    shell.key('Escape');
    await shell.tick();
    topbar.returnToActive();
    await shell.tick();
  }
  assert.equal(ov.drawnScopeOf(), 'live');
});

// An orphaned, guess-less POINT pin (4C.1; U532): the card names the point
// pick's hint and arms pick({kind: 'point'}); a click on a paragraph writes
// nothing and the pick waits; the card's Escape cancels with nothing written;
// a click inside another svg PATCHes {anchor: {kind: 'point', …}} through
// write(), the record recordPoint makes of that click.
test('a guess-less point pin: the card shows the point hint and arms the point pick; a paragraph writes nothing; Escape cancels; a click inside another svg PATCHes a point anchor', async () => {
  const SVG_BOX = { left: 500, top: 300, width: 200, height: 100, right: 700, bottom: 400, x: 500, y: 300 };
  await shell.frame({ type: 'render', id: 'pv', target: 'main', params: {},
    html: '<svg class="chart" width="200" height="100" viewBox="0 0 200 100"><circle class="dot" cx="50" cy="50" r="10"></circle></svg><p class="para">a paragraph of prose</p>' });
  await waitUntil(() => M.itemEl(W.document, 'pv'), { timeout: 3000, what: 'the pv pane mounted' });
  const svg = rootOf('pv').querySelector('svg');
  svg.getBoundingClientRect = () => SVG_BOX;
  const tap = (node, x, y) => {
    const init = { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', pointerId: 91, isPrimary: true, clientX: x, clientY: y };
    node.dispatchEvent(new W.PointerEvent('pointerdown', { ...init, buttons: 1 }));
    node.dispatchEvent(new W.PointerEvent('pointerup', { ...init, buttons: 0 }));
    node.dispatchEvent(new W.PointerEvent('click', { ...init, detail: 1 }));
  };
  // The pin's target is gone from p2: no element answers its record, no guess.
  const made = anchors.recordPoint(rootOf('pv'), svg, 550, 350, { mount: 'pv' });
  assert.equal(made.kind, 'point', 'precondition: a point record');
  const LOSTPT = { id: 'c14', v: 2, type: 'comment', shared: true, replies: 0,
    anchor: { ...made, mount: 'p2', at: { path: [9, 9, 9], sib: 0 }, fp: { ...made.fp, tag: 'video', cls: ['gone'], attrs: [] }, rows: [] } };
  ov.setElements('live', [...ROWS, LOSTPT]);
  await waitUntil(() => orphanIds().includes('c14'), { timeout: 4000, what: 'the point pin orphaned' });
  assert.ok(!ov.orphans().find((o) => o.id === 'c14').guess, 'guess-less');
  const act = () => listPop().querySelector('[data-el-id="c14"] .wc-orphan-act');
  const n0 = patches().length;
  patchAnswer = (url, init) => {
    const b = JSON.parse(init.body);
    return { ok: true, pin: { id: 'c14', v: 3 }, element: { id: 'c14', v: 3, type: 'comment', record: b.anchor } };
  };
  try {
    orph.openOrphanList();
    shell.click(act());
    await shell.tick();
    assert.ok(card(), 'the pick card is up');
    assert.ok(card().textContent.includes(orph.PICK_HINTS.point), 'the point pick\'s hint');
    assert.doesNotMatch(card().textContent, /no anchor kind/);
    // A paragraph is no fixed-aspect target: nothing written, the pick waits.
    tap(rootOf('pv').querySelector('p.para'), 560, 420);
    await shell.tick(20);
    assert.equal(patches().length, n0, 'a paragraph writes nothing');
    assert.ok(card(), 'the pick still waits');
    // The card's Escape cancels: nothing written, the card gone.
    shell.key('Escape');
    await shell.tick();
    assert.equal(card(), null);
    tap(rootOf('pv').querySelector('circle'), 600, 325);
    await shell.tick(20);
    assert.equal(patches().length, n0, 'Escape writes nothing, and the cancelled pick takes no click');
    // Again, and click inside the svg.
    orph.openOrphanList();
    shell.click(act());
    await shell.tick();
    const want = anchors.recordPoint(rootOf('pv'), svg, 600, 325, { mount: 'pv' });
    tap(rootOf('pv').querySelector('circle'), 600, 325);
    await waitUntil(() => /Re-anchored/.test(noteText()), { timeout: 3000, what: 'the picked point written' });
    const sent = patches().slice(n0);
    assert.equal(sent.length, 1, 'one PATCH');
    assert.equal(sent[0].url, '/api/elements/c14');
    assert.equal(sent[0].body.anchor.kind, 'point');
    assert.deepEqual(sent[0].body.anchor, want, 'the record recordPoint makes of the click');
    assert.equal(sent[0].body.anchor.mount, 'pv');
    assert.equal(sent[0].body.base_v, 2);
    assert.equal(noteText(), 'Re-anchored · anchor v3 written, the node untouched');
    shell.key('Escape');
    await shell.tick();
  } finally {
    patchAnswer = null;
    ov.setElements('live', ROWS);
  }
});
