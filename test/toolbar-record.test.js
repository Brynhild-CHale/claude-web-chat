// The toolbar's records (lib/core/toolbar-record; annotation engine 2D.2): the
// one validator, chord grammar and patcher of .web-chat/toolbar.json and
// ~/.web-chat/toolbar.json. The project tier is committable, so it is held to
// "grants nothing, offers nothing": no pack source, no chrome rebinding.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const R = require('../lib/core/toolbar-record');
const { projectPaths, userPaths } = require('../lib/core/paths');

const { validChord, normalizeProject, normalizeUser, applyPatch, view, emptyProject, emptyUser, ToolbarRecordError } = R;

function refusal(fn) {
  try { fn(); } catch (e) {
    assert.ok(e instanceof ToolbarRecordError, `a ToolbarRecordError, not ${e && e.name}: ${e && e.message}`);
    return e;
  }
  assert.fail('expected a refusal');
}

test('paths: projectPaths().toolbar and userPaths().toolbar are toolbar.json in each tier; neither is a profiles key', () => {
  const root = path.resolve('/tmp/wc-toolbar-paths');
  assert.equal(projectPaths(root).toolbar, path.join(root, '.web-chat', 'toolbar.json'));
  assert.equal(userPaths().toolbar, path.join(userPaths().root, 'toolbar.json'));
  assert.notEqual(projectPaths(root).toolbar, projectPaths(root).profiles);
  assert.notEqual(userPaths().toolbar, userPaths().profiles);
  // Tool profiles are a field inside toolbar.json, never the capture-profile
  // directory: the record module names no path at all.
  const src = fs.readFileSync(path.join(__dirname, '../lib/core/toolbar-record.js'), 'utf8');
  assert.match(src, /const \{ isSafeId \} = require\('\.\/paths'\);/, 'toolbar-record takes isSafeId from paths, and no path');
});

test('validChord: the grammar — accepted chords, lowercase letters normalised, the refused ones', () => {
  for (const s of ['C', 'Shift+/', '?', '[', '7', 'Space', 'ArrowUp', 'F5', 'Enter', 'F12', 'Shift+C', '`', '\\', '\'', ']', ',', '.', ';', '-', '=']) {
    assert.equal(validChord(s), s, s);
  }
  assert.equal(validChord('c'), 'C');
  assert.equal(validChord('Shift+c'), 'Shift+C');
  for (const s of ['Mod+K', 'Alt+C', 'Ctrl+S', 'Meta+S', 'Escape', 'Tab', 'c c', '', 'x'.repeat(40), 'F13', 'Shift+',
    'Shift+Shift+C', 'shift+C', 'space', 'Esc', 'Shift+Escape', 'Shift+Tab', '!', 'é', null, undefined, 3]) {
    assert.equal(validChord(s), null, JSON.stringify(s));
  }
});

test('targets: each kind round-trips; a slot outside 1–9 and a forbidden character in a label are refused', () => {
  const user = { bindings: {
    P: { kind: 'chrome', action: 'chrome.push' },
    1: { kind: 'slot', n: 1 },
    H: { kind: 'tool', type: 'highlight', profile: 'Yellow', label: 'Highlight', pack: { name: 'web-chat', source: 'https://example.test/p.git' } },
    X: null,
  } };
  const { record } = normalizeUser(user);
  assert.deepEqual(record.bindings, user.bindings);
  assert.deepEqual(normalizeUser(JSON.parse(JSON.stringify(record))).record, record, 'a written record reads back as itself');
  for (const n of [0, 10, 1.5, '1']) {
    const e = refusal(() => normalizeUser({ bindings: { 2: { kind: 'slot', n } } }));
    assert.equal(e.field, 'bindings.2.n', JSON.stringify(n));
  }
  const e = refusal(() => normalizeUser({ bindings: { H: { kind: 'tool', type: 'highlight', label: 'abc‮def' } } }));
  assert.equal(e.field, 'bindings.H.label');
  assert.equal(refusal(() => normalizeUser({ bindings: { H: { kind: 'tool', type: '../x' } } })).field, 'bindings.H.type');
  assert.equal(refusal(() => normalizeUser({ bindings: { H: { kind: 'nope' } } })).field, 'bindings.H.kind');
  assert.equal(refusal(() => normalizeUser({ bindings: { H: { kind: 'chrome', action: 'Push!' } } })).field, 'bindings.H.action');
  assert.equal(refusal(() => normalizeUser({ bindings: { H: { kind: 'slot', n: 1, run: 'x' } } })).field, 'bindings.H.run');
  assert.equal(refusal(() => normalizeUser({ bindings: { 'Mod+K': { kind: 'slot', n: 1 } } })).field, 'bindings.Mod+K');
  assert.equal(refusal(() => normalizeUser({ bindings: { c: null, C: null } })).field, 'bindings.C', 'two spellings of one chord');
});

test('the project tier grants and offers nothing: a pack source and a chrome target are refused there, accepted at the user tier', () => {
  const tool = { kind: 'tool', type: 'box-grab', pack: { name: 'grabs', source: 'https://example.test/grabs.git' } };
  let r = applyPatch(emptyProject(), { bindings: { 'Shift+/': tool } }, 'project');
  assert.deepEqual([r.ok, r.field], [false, 'bindings.Shift+/.pack']);
  assert.equal(refusal(() => normalizeProject({ bindings: { G: tool } })).field, 'bindings.G.pack', 'read the same as a write');
  r = applyPatch(emptyUser(), { bindings: { 'Shift+/': tool } }, 'user');
  assert.equal(r.ok, true);
  assert.deepEqual(r.record.bindings['Shift+/'], tool);

  r = applyPatch(emptyProject(), { bindings: { P: { kind: 'chrome', action: 'chrome.push' } } }, 'project');
  assert.deepEqual([r.ok, r.field], [false, 'bindings.P']);
  assert.match(r.why, /user record/);
  r = applyPatch(emptyProject(), { bindings: { P: null, 1: { kind: 'slot', n: 3 }, H: { kind: 'tool', type: 'highlight' } } }, 'project');
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.record.bindings, { 1: { kind: 'slot', n: 3 }, H: { kind: 'tool', type: 'highlight' }, P: null });
  r = applyPatch(emptyUser(), { bindings: { P: { kind: 'chrome', action: 'chrome.push' } } }, 'user');
  assert.equal(r.ok, true);
  // No field of either record names an install, an approval, a trust, a run or a fetch.
  assert.deepEqual(Object.keys(emptyProject()).sort(), ['bindings', 'hidden', 'pinned', 'profiles', 'settings', 'v']);
  assert.deepEqual(Object.keys(emptyUser()).sort(), ['bindings', 'fingerDraws', 'settings', 'v']);
});

test('pinned and hidden: disjoint, at most 64, no duplicates, opaque type ids', () => {
  assert.equal(refusal(() => normalizeProject({ pinned: ['comment'], hidden: ['comment'] })).field, 'hidden');
  const many = Array.from({ length: 65 }, (_, i) => `t${i}`);
  assert.equal(refusal(() => normalizeProject({ pinned: many })).field, 'pinned');
  assert.equal(refusal(() => normalizeProject({ hidden: many })).field, 'hidden');
  assert.equal(normalizeProject({ pinned: many.slice(0, 64) }).record.pinned.length, 64);
  assert.equal(refusal(() => normalizeProject({ pinned: ['a', 'a'] })).field, 'pinned[1]');
  assert.equal(refusal(() => normalizeProject({ pinned: ['a/b'] })).field, 'pinned[0]');
});

test('settings payloads: plain JSON, depth ≤ 4, ≤ 16 KB; profiles ≤ 16 a type with unique names', () => {
  const ok = { a: { b: { c: { d: 1 } } }, list: [1, 'x', true, null] };
  assert.deepEqual(normalizeProject({ settings: { highlight: ok } }).record.settings.highlight, ok);
  assert.equal(refusal(() => normalizeProject({ settings: { highlight: { a: { b: { c: { d: { e: 1 } } } } } } })).field,
    'settings.highlight.a.b.c.d');
  assert.equal(refusal(() => normalizeProject({ settings: { highlight: { big: 'x'.repeat(17 * 1024) } } })).field, 'settings.highlight');
  assert.equal(refusal(() => normalizeProject({ settings: { highlight: [] } })).field, 'settings.highlight');
  assert.equal(refusal(() => normalizeProject({ settings: { highlight: { s: 'a​b' } } })).field, 'settings.highlight.s');
  assert.equal(refusal(() => normalizeUser({ settings: { highlight: { n: Infinity } } })).field, 'settings.highlight.n');

  const prof = (n) => Array.from({ length: n }, (_, i) => ({ name: `p${i}`, settings: { colour: 'gold' } }));
  assert.equal(normalizeProject({ profiles: { highlight: prof(16) } }).record.profiles.highlight.length, 16);
  assert.equal(refusal(() => normalizeProject({ profiles: { highlight: prof(17) } })).field, 'profiles.highlight');
  assert.equal(refusal(() => normalizeProject({ profiles: { highlight: [{ name: 'A' }, { name: 'A' }] } })).field,
    'profiles.highlight[1].name');
  assert.equal(refusal(() => normalizeProject({ profiles: { highlight: [{ name: '' }] } })).field, 'profiles.highlight[0].name');
  assert.equal(refusal(() => normalizeProject({ profiles: { highlight: [{ name: 'x'.repeat(41) }] } })).field, 'profiles.highlight[0].name');
  assert.deepEqual(normalizeProject({ profiles: { highlight: [{ name: 'Bare' }] } }).record.profiles.highlight, [{ name: 'Bare', settings: {} }]);
});

test('a record from JSON.parse with a __proto__ key is refused at any depth, and nothing reaches Object.prototype', () => {
  for (const raw of [
    '{"__proto__": {"polluted": 1}}',
    '{"settings": {"__proto__": {"polluted": 1}}}',
    '{"settings": {"highlight": {"__proto__": {"polluted": 1}}}}',
    '{"bindings": {"__proto__": {"kind": "slot", "n": 1}}}',
    '{"profiles": {"highlight": [{"name": "a", "settings": {"x": {"__proto__": {"polluted": 1}}}}]}}',
  ]) {
    refusal(() => normalizeProject(JSON.parse(raw)));
    assert.equal(applyPatch(emptyProject(), JSON.parse(raw), 'project').ok, false, raw);
    assert.equal(({}).polluted, undefined, raw);
    assert.equal(Object.prototype.polluted, undefined, raw);
  }
  refusal(() => normalizeUser(JSON.parse('{"constructor": {"prototype": {"polluted": 1}}}')));
  assert.equal(({}).polluted, undefined);
});

test('normalize: absent is the empty record; unknown top-level fields are listed, never carried; a future version is refused', () => {
  assert.deepEqual(normalizeProject(undefined), { record: emptyProject(), ignored: [] });
  assert.deepEqual(normalizeUser(null), { record: emptyUser(), ignored: [] });
  const r = normalizeProject({ v: 1, pinned: ['comment'], later: { x: 1 } });
  assert.deepEqual(r.ignored, ['later']);
  assert.ok(!('later' in r.record));
  assert.equal(refusal(() => normalizeProject({ v: 2 })).field, 'v');
  assert.equal(refusal(() => normalizeProject([])).field, '');
  assert.equal(refusal(() => normalizeUser({ fingerDraws: 'yes' })).field, 'fingerDraws');
  assert.equal(normalizeUser({ fingerDraws: true }).record.fingerDraws, true);
});

test('applyPatch: bindings merge per key; unset deletes a key while a stored null stays an explicit unbind', () => {
  let rec = emptyUser();
  let r = applyPatch(rec, { bindings: { A: { kind: 'slot', n: 1 }, B: { kind: 'slot', n: 2 } } }, 'user');
  assert.equal(r.ok, true);
  r = applyPatch(r.record, { bindings: { b: null, C: { kind: 'slot', n: 3 } } }, 'user');
  assert.deepEqual(r.record.bindings, { A: { kind: 'slot', n: 1 }, B: null, C: { kind: 'slot', n: 3 } });
  r = applyPatch(r.record, { unset: { bindings: ['a'] } }, 'user');
  assert.deepEqual(r.record.bindings, { B: null, C: { kind: 'slot', n: 3 } }, 'A gone; B still a stored null');
  rec = r.record;
  assert.equal(applyPatch(rec, { bindings: { A: null }, unset: { bindings: ['A'] } }, 'user').ok, false, 'set and unset at once');
  assert.equal(applyPatch(rec, { unset: { bindings: ['Mod+K'] } }, 'user').field, 'unset.bindings.Mod+K');
  assert.equal(applyPatch(rec, { fingerDraws: true }, 'user').record.fingerDraws, true);
  // The caller's record is never mutated.
  assert.deepEqual(rec.bindings, { B: null, C: { kind: 'slot', n: 3 } });
});

test('applyPatch: the project record — replace pinned/hidden (order is the list), merge settings and profiles per type, unset per type', () => {
  let r = applyPatch(emptyProject(), { pinned: ['comment', 'highlight'], hidden: ['box-grab'] }, 'project');
  assert.deepEqual([r.record.pinned, r.record.hidden], [['comment', 'highlight'], ['box-grab']]);
  r = applyPatch(r.record, { pinned: ['highlight', 'comment'] }, 'project');
  assert.deepEqual(r.record.pinned, ['highlight', 'comment'], 'reordered');
  // Pinning the hidden box-grab without naming hidden: refused, 400's field.
  const bad = applyPatch(r.record, { pinned: ['highlight', 'comment', 'box-grab'] }, 'project');
  assert.deepEqual([bad.ok, bad.field], [false, 'hidden']);
  r = applyPatch(r.record, { pinned: ['highlight', 'comment', 'box-grab'], hidden: [] }, 'project');
  assert.equal(r.ok, true, 'named consistently: un-hidden');
  r = applyPatch(r.record, { settings: { highlight: { colour: 'gold' } }, profiles: { highlight: [{ name: 'Rust', settings: { colour: 'rust' } }] } }, 'project');
  r = applyPatch(r.record, { settings: { comment: { visible: true } } }, 'project');
  assert.deepEqual(r.record.settings, { highlight: { colour: 'gold' }, comment: { visible: true } });
  r = applyPatch(r.record, { unset: { settings: ['highlight'], profiles: ['highlight'] } }, 'project');
  assert.deepEqual([r.record.settings, r.record.profiles], [{ comment: { visible: true } }, {}]);
  assert.equal(applyPatch(r.record, { fingerDraws: true }, 'project').field, 'fingerDraws', 'a user-tier field');
  assert.equal(applyPatch(emptyUser(), { profiles: {} }, 'user').field, 'profiles', 'profiles are the project record\'s');
  assert.equal(applyPatch(emptyUser(), { unset: { profiles: [] } }, 'user').field, 'unset.profiles');
  assert.equal(applyPatch(emptyProject(), { settings: { highlight: null } }, 'project').field, 'settings.highlight');
  assert.equal(applyPatch(emptyProject(), null, 'project').ok, false);
  assert.equal(applyPatch(emptyProject(), {}, 'nope').ok, false);
});

test('view: user ⊕ project bindings through tier-merge — a project null shadows a user binding, reported with tier project; settings per field', () => {
  const user = applyPatch(emptyUser(), {
    bindings: { P: { kind: 'chrome', action: 'chrome.push' }, 1: { kind: 'slot', n: 1 } },
    settings: { highlight: { colour: 'gold', snap: 'words' } },
  }, 'user').record;
  const project = applyPatch(emptyProject(), {
    bindings: { P: null, H: { kind: 'tool', type: 'highlight' } },
    settings: { highlight: { colour: 'rust' } },
  }, 'project').record;
  const v = view(project, user);
  assert.deepEqual(v.project, project);
  assert.deepEqual(v.user, user);
  assert.deepEqual(JSON.parse(JSON.stringify(v.merged.bindings)), {
    1: { value: { kind: 'slot', n: 1 }, tier: 'user', shadows: [] },
    H: { value: { kind: 'tool', type: 'highlight' }, tier: 'project', shadows: [] },
    P: { value: null, tier: 'project', shadows: [{ tier: 'user', value: { kind: 'chrome', action: 'chrome.push' } }] },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(v.merged.settings)), {
    highlight: {
      colour: { value: 'rust', tier: 'project', shadows: [{ tier: 'user', value: 'gold' }] },
      snap: { value: 'words', tier: 'user', shadows: [] },
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(view().merged)), { bindings: {}, settings: {} });
});

test('the module is lib/core-pure: it requires only paths, text and tier-merge', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/core/toolbar-record.js'), 'utf8');
  const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(reqs, ['./paths', './text', './tier-merge']);
});
