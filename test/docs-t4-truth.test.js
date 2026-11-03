'use strict';
// Tranche 4's documentation claims, held to the code they describe (U591,
// test/docs-t3-truth.test.js's method).
//
// The rulings this tranche's docs carry: the realm sentence (contract 08,
// Q-08.3; U512's wording, verbatim in docs/extending.md and in the loader's
// own header), record(id) the live record beside it, event-anchor.js the one
// owner of the event-time anchor's observer, anchors-src's compact the one
// compaction rule; and in the rules text Claude reads — the annotation counts
// as a result field with the private count framed as the user's own notes
// (U563-U580@catalogue-tool-edits a, U563@private-count a), ink private by
// default with the picture on request (AD5, PICTURE@when a), a stroke found
// by the text under it (U551@hits-scope-text-order a), the engine's undo on
// Mod+Z, live versions only, the version history named as the way back past a
// commit (AF9, PLAN-T4 F5; form 5 AR1 b: it steps back), an erase final for
// Mod+Z (U566@tray-method-name a), points and words (U532, U588) and the
// movable glyph (U587). The two rules files and the two skill copies stay
// byte-identical, the MCP tool count stays 24, and the changelog's pending
// notes name no protocol bump (PROTO@none).

const test = require('node:test');
const assert = require('node:assert/strict');

const { read, mcpTools } = require('../test-support/doc-truth');
const { PORTAL_PROTOCOL_VERSION } = require('../lib/core/versions');
const { SHAPES } = require('../lib/core/ink-shape');
const { DESCRIBE_KEYS } = require('../lib/core/strokes');
const { EXPORT_ELEMENTS_MAX, OVER_CAP } = require('../lib/server/export');
const anchorsSrc = require('../lib/server/runtime/anchors-src');
const inspectCapture = require('../lib/mcp/tools/inspect_capture');

const RULES = ['.claude/rules/web-chat.md', 'templates/rules/web-chat.md'];
const SKILLS = ['templates/skills/respond-to-comment/SKILL.md', '.claude/skills/respond-to-comment/SKILL.md'];

const REALM = 'an approved type\'s draw() runs in the surface page\'s own realm live, and in each document\'s own realm under PREVIEW_CSP (B1); a pack cannot add a layer or a placement mode';

// The bullet of a rules file that opens with `- **<lead>`, whole (one line).
function bullet(body, lead) {
  const line = body.split('\n').find((l) => l.startsWith(`- **${lead}`));
  assert.ok(line, `the rules text has a bullet that opens "${lead}"`);
  return line;
}

test('the two rules files and the two skill copies are byte-identical', () => {
  assert.equal(read(RULES[0]), read(RULES[1]));
  assert.equal(read(SKILLS[0]), read(SKILLS[1]));
});

test('tranche 4 adds no MCP tool: there are still 24, and the rules say so', () => {
  assert.equal(mcpTools().length, 24);
  for (const rel of RULES) assert.match(read(rel), /the 24 tools above are unchanged/);
});

test('the realm sentence is the loader\'s own, verbatim, in docs/extending.md', () => {
  assert.ok(read('public/app/element-types.js').includes(`// ${REALM}\n`), 'element-types.js\'s THE REALM paragraph carries the sentence');
  const ext = read('docs/extending.md');
  assert.ok(ext.includes(`> ${REALM}\n`), 'docs/extending.md quotes the realm sentence as written');
  assert.ok(ext.includes('record(id) is the live record, previewed node or not'), 'beside it: record(id) reads the live record');
  assert.match(ext, /\*\*A slow draw is not caught\.\*\*/, 'and it says a slow draw is not caught');
});

test('docs/extending.md names event-anchor.js the observer\'s owner and anchors-src\'s compact the one compaction rule', () => {
  const ext = read('docs/extending.md');
  assert.match(ext, /`public\/app\/event-anchor\.js` `createEventAnchors` → [^|]*THE one owner of the event-time anchor and of its index-invalidation MutationObserver/);
  assert.match(ext, /a second probe, pending list or shadow-root observer \(the event-time anchor's index observer is public\/app\/event-anchor\.js's own, below\)/,
    'the overlay-hidden row\'s observer clause allows event-anchor.js\'s observer (finding U542)');
  assert.match(ext, /`lib\/server\/runtime\/anchors-src` `compact` \(THE one compaction rule of the served runtimes\)/);
  assert.equal(typeof anchorsSrc.compact, 'function', 'anchors-src exports the compact the docs name');
});

test('shell.js\'s key dispatch comment names the two fixed Mod+ rows, ⌘K and ⌘Z', () => {
  const shell = read('public/app/shell.js');
  assert.match(shell, /Two ⌘\/Ctrl chords are the page's, the two fixed\n\s*\/\/ Mod\+ rows: ⌘K \(the palette\) and ⌘Z \(elements\.undo/);
  assert.doesNotMatch(shell, /a ⌘\/Ctrl chord other than ⌘K is the browser's/, 'the stale sentence is gone');
  assert.match(read('public/app/element-undo.js'), /export const UNDO_CHORD = 'Mod\+Z';/, 'the undo the docs name is on Mod+Z');
});

for (const rel of RULES) {
  test(`${rel}: the annotations result field, and the private count as the user's own notes`, () => {
    const b = bullet(read(rel), 'Annotation counts.');
    assert.match(b, /`render`, `use_component` and `clear` answer, in an `annotations` result field/);
    assert.match(b, /\*\*Check them before you replace an annotated pane\*\*/);
    assert.match(b, /No tool's description changed: the field is part of the answer/, 'a result field, no description edit (U563-U580 a)');
    assert.match(b, /`private` counts the user's own private notes on that item: they are not addressed to you and never reach you — never act on them/);
  });

  test(`${rel}: ink private by default, described as text first, the picture on request, found by the text under it`, () => {
    const b = bullet(read(rel), 'Ink and other free-form strokes');
    assert.match(b, /are \*\*private by default\*\*/);
    assert.match(b, /reaches you as text first/);
    for (const shape of SHAPES) assert.ok(b.includes(shape), `the rules name the shape "${shape}" (ink-shape SHAPES)`);
    assert.ok(DESCRIBE_KEYS.includes('text_under') && b.includes('`text_under`'), 'the words under a stroke are its records\' text_under');
    assert.match(b, /A stroke has no words of its own: it is described, and found by the element search \(`GET \/api\/elements\/search`\), by the text under it/);
    assert.match(b, /The \*\*picture is on request\*\*/);
    assert.match(b, /inspect_capture\(\{capture_id: 'element:<id>'\}\)/);
    assert.ok(inspectCapture.elementOfUrl('element:h1') === 'h1', 'inspect_capture takes element:<id>, as the rules say');
    assert.match(b, /Never ask for one on every wake/);
  });

  test(`${rel}: the undo on Mod+Z, its scope, the version history past a commit, and an erase final`, () => {
    const b = bullet(read(rel), 'Undo.');
    assert.match(b, /The user's Mod\+Z \(⌘Z, Ctrl\+Z\) undoes the last annotation they made on the pane under the pointer/);
    assert.match(b, /repeated, it steps back through their older annotations, newest first/, 'form 5 AR1 b');
    assert.match(b, /It undoes live versions only: it stops at the last node commit, never touches a chat pin/, 'AF9 a');
    assert.match(b, /Past a commit, the way back is the graph inspector's version history: an older node set active there/, 'AF9\'s (c) pointer, F5');
    assert.match(b, /a block's ◷ history restores the pane's content, never its annotations/, 'pane history (domain/mounts restoreMount) copies no element reference');
    assert.match(b, /An erase is final for Mod\+Z/);
    assert.doesNotMatch(b, /PENDING/, 'form 5 has ruled UNDO@repeat (AR1 b): no pending marker');
  });

  test(`${rel}: points, words and the movable glyph`, () => {
    const b = bullet(read(rel), 'Where a comment pins.');
    assert.match(b, /an image, an svg, a canvas or an element marked `data-fixed-aspect` pins a \*\*point\*\*/);
    assert.match(b, /`anchor\.kind` is `'point'`, with `x` and `y`/);
    assert.match(b, /A tap on a word of text pins that \*\*word\*\*, as a range/);
    assert.match(b, /drag a comment's glyph off its anchor/);
  });

  test(`${rel}: the export cap's refusal, and the flat ctx.record for pack authors`, () => {
    const body = read(rel);
    assert.equal(EXPORT_ELEMENTS_MAX, 4 * 1024 * 1024);
    const cap = bullet(body, 'Annotations in an export.');
    assert.ok(cap.includes('4 MiB') && cap.includes(`code: '${OVER_CAP}'`), 'the rules give the cap and its code as export.js has them');
    assert.match(bullet(body, 'Writing an element pack'), /read `ctx\.record\(id\)\.points`, never `\.payload`/, 'U522b');
  });
}

for (const rel of SKILLS) {
  test(`${rel}: a point pin, a word pin and a stroke group's description before the picture`, () => {
    const body = read(rel);
    assert.match(body, /- \*\*A point on an image, an svg or a canvas\*\* — `anchor\.kind` is `'point'`/);
    assert.match(body, /`chart \(whole pane\)`: it does not say where, so read `x` and `y`/);
    assert.match(body, /- \*\*A word\*\* — a tap on text pins that word as a range: `anchor\.quote\.exact` is the word/);
    assert.match(body, /## Strokes under or beside a comment/);
    for (const key of ['shape', 'confidence', 'count', 'bbox', 'text_under']) {
      assert.ok(body.includes(`\`${key}\``), `the skill names the describe field ${key}`);
    }
    assert.match(body, /Ask for one only when the words and the\s+shape do not answer: `inspect_capture\(\{capture_id: 'element:<id>'\}\)`/);
  });
}

test('the guide covers reviewed element packs, the undo key, annotations in documents and the export cap', () => {
  const g = read('docs/guide.md');
  assert.match(g, /\*\*A pack that adds annotation tools\.\*\*[^\n]*`pack review <name>`[^\n]*`pack approve <name>`/);
  assert.match(g, /Every update of the pack goes through the same quarantine again/, 'the re-approve cost of an update');
  assert.match(g, /\*\*Undo an annotation\.\*\* ⌘Z \(Ctrl\+Z off a Mac\)/);
  assert.match(g, /\*\*Annotations in previews, exports and replays\.\*\*[^\n]*never in a file, whoever downloads it/, 'AI9 a');
  assert.match(g, /An export's annotations are capped at 4 MiB/);
  assert.match(g, /`claude-web-chat export \[node\] --strip`/);
  assert.match(read('lib/cli/index.js'), /--strip leaves out what does not fit the export cap/, 'the CLI help names the flag the guide does');
  assert.match(g, /at most 389 conversations in memory/, 'U575\'s line stands');
});

test('the changelog\'s pending notes name no protocol bump, and the portal is still at 12', () => {
  const cl = read('CHANGELOG.md');
  const pending = cl.slice(cl.indexOf('## [Unreleased]'), cl.indexOf('\n## [', cl.indexOf('## [Unreleased]') + 1));
  assert.match(pending, /\*\*The built-in pack reinstalls once; no protocol bump\.\*\*/);
  assert.match(pending, /The\s+tunnel portal's protocol stays 12/);
  assert.equal(PORTAL_PROTOCOL_VERSION, 12);
});
