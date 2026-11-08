'use strict';
// Tranche 5's tail documentation (U691): the 5B and 5C claims, held to the
// code they describe (test/docs-t4-truth.test.js's method).
//
// The rulings this text carries: CHROME@csp (C3, a) — a DOM allowlist on a
// marker's subtree with ctx.layer withdrawn, plus a Report-Only CSP that
// measures and breaks nothing (no enforced CSP on the surface page, and the
// allowlist a DOM rule only, C-5B-17-doc); the blend per marker part's
// group.blend (U624, H4 = b); the per-group describe and the as-delivered
// re-send (U633, U633c; J2); the re-read interval's wording (at most one
// re-read per second while Claude streams, never "one GET per hello");
// REQ@tranche-alpha (C4, a) — the exit's build is 0.9.0-alpha.6; PROTO@none
// and SCHEMA@4; CATALOGUE@result-minor — still 24 tools. ES modules in
// public/app are read as text, never imported.

const test = require('node:test');
const assert = require('node:assert/strict');

const { read, mcpTools } = require('../test-support/doc-truth');
const { PORTAL_PROTOCOL_VERSION, SCHEMA_VERSION } = require('../lib/core/versions');
const { SURFACE_CSP_REPORT_ONLY, PREVIEW_CSP } = require('../lib/core/cors');

const RULES = ['.claude/rules/web-chat.md', 'templates/rules/web-chat.md'];
const NINE = ['svg', 'g', 'path', 'line', 'polyline', 'circle', 'rect', 'div', 'span'];

// Prose wrapped across lines, read as one line.
const flat = (s) => s.replace(/\s+/g, ' ');

// The code's allowlist, read from overlay.js's frozen literal.
function markerAllowlist() {
  const src = read('public/app/overlay.js');
  const m = src.match(/export const MARKER_ALLOWLIST = Object\.freeze\(\{\s*svg: Object\.freeze\(\[([^\]]*)\]\),\s*html: Object\.freeze\(\[([^\]]*)\]\),?\s*\}\);/);
  assert.ok(m, 'overlay.js no longer declares MARKER_ALLOWLIST as two frozen lists — re-point this check');
  const names = (list) => [...list.matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  return [...names(m[1]), ...names(m[2])];
}

function unreleased() {
  const text = read('CHANGELOG.md');
  const start = text.indexOf('## [Unreleased]');
  assert.ok(start >= 0, 'CHANGELOG.md has an [Unreleased] section');
  const next = text.indexOf('\n## [', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

test('the nine elements the docs name are the overlay\'s MARKER_ALLOWLIST', () => {
  assert.deepEqual(markerAllowlist(), NINE);
  const list = 'svg, g, path, line, polyline, circle, rect, div and span';
  assert.ok(flat(read('docs/component-packs.md')).includes(list), 'component-packs.md lists the nine');
  assert.ok(flat(read('docs/extending.md')).includes(`(\`MARKER_ALLOWLIST\`, nine elements: ${list};`), 'extending.md\'s note lists the nine');
  assert.ok(flat(unreleased()).includes('svg, g, path, line, polyline, circle, rect, div and span'), 'the changelog lists the nine');
});

test('the draw ctx carries no layer in either realm, and the docs say so', () => {
  const overlay = read('public/app/overlay.js');
  const drawCtx = overlay.slice(overlay.indexOf('function drawCtx('));
  assert.ok(drawCtx.length > 0, 'overlay.js no longer has drawCtx — re-point this check');
  assert.doesNotMatch(drawCtx.slice(0, drawCtx.indexOf('\n}\n')), /\blayer\s*[:,]/, 'the live draw ctx hands no layer');
  assert.doesNotMatch(read('lib/server/runtime/elements-doc-src.js'), /layer: layer/, 'the document ctx hands no layer');
  const ext = flat(read('docs/extending.md'));
  assert.ok(ext.includes('The draw and move ctx carry no `layer` in either realm'), 'extending.md\'s pack author\'s note');
  assert.ok(ext.includes('the draw and move ctx carry no layer — a type draws into group.container, and what blends into group.blend'), 'extending.md\'s allowlist row');
  const packs = flat(read('docs/component-packs.md'));
  assert.ok(packs.includes('carries no `layer`: a type draws into `group.container`'), 'component-packs.md: draw into group.container');
  assert.ok(packs.includes('`group.blend`, in a blend layer of its own: it draws what should blend there and the rest into `group.container`'), 'component-packs.md: the blend per part');
});

test('the allowlist is documented as a DOM rule only, and no doc claims an enforced surface CSP', () => {
  const src = read('lib/server/index.js');
  assert.match(src, /setHeader\('Content-Security-Policy-Report-Only', SURFACE_CSP_REPORT_ONLY\)/, 'the surface page sends the policy report-only');
  assert.doesNotMatch(src, /setHeader\('Content-Security-Policy', SURFACE_CSP_REPORT_ONLY\)/, 'never as an enforced header');
  assert.doesNotMatch(SURFACE_CSP_REPORT_ONLY, /report-uri|report-to/, 'the policy names no report sink (H6)');
  assert.match(PREVIEW_CSP, /img-src data: blob:/);
  assert.match(PREVIEW_CSP, /connect-src 'none'/);
  const ext = flat(read('docs/extending.md'));
  assert.ok(ext.includes('`SURFACE_CSP_REPORT_ONLY`, report-only and sink-less — never an enforced CSP on the surface page without contract 08 first'), 'the routed tripwire sentence');
  assert.ok(ext.includes('The allowlist is a DOM rule only: a URL a draw writes may be fetched at insertion before the walk removes it, the Report-Only header reports and blocks nothing'), 'extending.md: C-5B-17-doc');
  assert.ok(ext.includes('A type never attaches a shadow root to a marker part'), 'extending.md: the shadow-root line');
  assert.ok(flat(read('docs/component-packs.md')).includes('The walk is a DOM rule only'), 'component-packs.md: C-5B-17-doc');
  const notes = flat(unreleased());
  assert.ok(notes.includes('report-only header measures and blocks nothing, and there is still no enforced Content-Security-Policy on the surface page'), 'the changelog says the header only measures');
  for (const rel of ['docs/extending.md', 'docs/component-packs.md', 'docs/guide.md', 'CHANGELOG.md', ...RULES]) {
    assert.doesNotMatch(flat(read(rel)), /(?<!until the )surface page (?:now )?(?:enforces|has an enforced|sends an enforced)/i, `${rel} claims an enforced surface CSP`);
  }
});

test('extending.md names every 5B and 5C engine this tail documents', () => {
  const ext = read('docs/extending.md');
  for (const name of [
    'allowlistWalk', 'MARKER_INERT_ATTRS', 'stats().dom_refused', // U632
    '`pinned()`', 'pinnedEmit', // U634
    'replaceDescribe', 'reshapedSummary', 'keepElementItem', // U633, U633b, U633c
    'REREAD_MIN_MS', // U635
    'clampedOffset', 'GLYPH_DROP_HINT', 'overlay:glyph-refused', // U631
    'cold_missing', 'cold_dirty', // U642
    'stageStrokesFixture', 'strokeBodies', 'stroke_failures', // U641
    'pinGroups', 'probePicture', 'openPair', 'picturePath(id, which)', 'PIN_LABEL', // U629
  ]) assert.ok(ext.includes(name), `docs/extending.md names ${name}`);
  assert.ok(flat(ext).includes('a collapsed one-group describe\'s cover lives in memory beside the object only, so a graceful restart, a re-send or a re-fold loses it'), 'the fold\'s in-memory limit (HAND FOLD 7)');
});

test('the re-read interval is the constant the docs name, and no doc says one GET per hello', () => {
  const src = read('public/app/chat-pins.js');
  assert.match(src, /export const REREAD_MIN_MS = 1000;/);
  assert.ok(flat(read('docs/extending.md')).includes('at most one re-read per second'));
  assert.ok(flat(read('CLAUDE.md')).includes('at most one re-read per second while Claude streams'));
  for (const rel of ['docs/extending.md', 'docs/guide.md', 'CLAUDE.md', 'CHANGELOG.md', ...RULES]) {
    assert.doesNotMatch(flat(read(rel)), /one GET per hello/i, `${rel} says "one GET per hello"`);
  }
});

test('CLAUDE.md carries the short rows and the restart lines U690 named', () => {
  const c = flat(read('CLAUDE.md'));
  for (const name of ['allowlistWalk', 'SURFACE_CSP_REPORT_ONLY', '`pinned()`', 'replaceDescribe', 'REREAD_MIN_MS', 'clampedOffset', 'pinGroups', 'cold_missing', 'stageStrokesFixture']) {
    assert.ok(c.includes(name), `CLAUDE.md names ${name}`);
  }
  assert.ok(c.includes('`lib/core/redact.js` (the redactor, its `pinned()` view included) and `lib/core/cors.js` (the surface page\'s Report-Only header) → `claude-web-chat restart`; so does `lib/channel/policy.js`'), 'the restart lines');
});

test('the rules carry 5B\'s two sentences, byte-identical, and still 24 tools', () => {
  assert.equal(read(RULES[0]), read(RULES[1]));
  assert.equal(mcpTools().length, 24);
  for (const rel of RULES) {
    const body = read(rel);
    assert.ok(body.includes('A folded item lists each group\'s guess under `describe.groups`, newest last. An edit to one of a folded item\'s strokes refreshes only its own group\'s entry'), `${rel}: one entry per group, an edit refreshes its own`);
    assert.ok(body.includes('a re-send of a stroke group sends what is still shared, as it was last delivered: a stroke the user un-shared after it was sent is never sent again.'), `${rel}: no re-send of an un-shared stroke`);
    assert.match(body, /the 24 tools above are unchanged/);
    assert.doesNotMatch(body, /SURFACE_CSP|allowlist|Report-Only|pinned\(\)/, `${rel} names nothing Claude does not act on`);
  }
});

test('the guide covers the glyph clamp, the phone pin and the re-send', () => {
  const g = flat(read('docs/guide.md'));
  assert.ok(g.includes('A glyph dragged toward the edge of its block stops there, and one dropped over a frame goes back where it was: nothing is saved.'));
  assert.ok(g.includes('the phone draws it as a pin instead: tap the pin to see that part of the page with the ink and without it.'));
  assert.ok(g.includes('when a stroke group is sent again it carries only what is still shared, as it was last delivered'));
});

test('[Unreleased] names 0.9.0-alpha.6, no protocol bump and no migration, and the picture only on request', () => {
  const notes = flat(unreleased());
  assert.match(notes, /0\.9\.0-alpha\.6/);
  assert.ok(notes.includes('No protocol bump: the tunnel portal stays on 12'));
  assert.equal(PORTAL_PROTOCOL_VERSION, 12, 'PROTO@none');
  assert.ok(notes.includes('No migration: the project schema stays 4'));
  assert.equal(SCHEMA_VERSION, 4, 'SCHEMA@4');
  assert.ok(notes.includes('Back on 0.9.0-alpha.5'), 'the rollback target is alpha.5');
  assert.ok(notes.includes('`--disable-gpu`'), 'U617b\'s line rides alpha.5\'s picture bullet (HAND FOLD 7)');
  assert.ok(notes.includes('**On a phone, a shared margin stroke Claude has pictured is a pin.**'), 'Added: the phone pin');
  assert.doesNotMatch(notes, /picture (?:on|with) every wake|per wake picture/i, 'PICTURE@when a: never per wake');
});
