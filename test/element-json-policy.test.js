// C-16-1: the built-in element types' element.json files, held to the one
// policy source (annotation engine tranche 2, U323; results/gate-t1-exit.md,
// DECISIONS.md I.5 J2: "the element.json files and the ratchet holding each
// built-in element.json equal to BUILTIN_ELEMENT_TYPES land in 2C").
//
// lib/core/element-policy BUILTIN_ELEMENT_TYPES is the one declaration of the
// built-in types' policy ({type, family, remote, private}); the shipped pack,
// templates/elements/web-chat-builtins/, carries the same fields in each
// elements/<type>/element.json so that the built-ins install through the one
// pack path like any other type. This file is the ratchet that keeps the two
// equal: change one without the other and it fails. It also pins the engine
// fields (schema, reads, anchors), and the toolbar fields to the values
// DECISIONS.md K.2 item 1 (U335's grammar) and ruling U323-U335@builtin-
// settings (a) give them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { BUILTIN_ELEMENT_TYPES } = require('../lib/core/element-policy');
const { BUILTIN_ELEMENT_TYPE_NAMES, BUILTIN_ELEMENT_PACK } = require('../lib/core/names');
const { validateElement, readElementJson } = require('../lib/packs/elements');
const { validateManifest, parseManifest } = require('../lib/packs/manifest');
const { validate: validateImage } = require('../lib/core/brand-image');
const { imageSize } = require('../lib/core/image-file');
const { ELEMENTS_TEMPLATE_DIR } = require('../lib/server/builtins');

const PACK_DIR = ELEMENTS_TEMPLATE_DIR;
const typeDir = (type) => path.join(PACK_DIR, 'elements', type);
const elementJson = (type) => JSON.parse(fs.readFileSync(path.join(typeDir(type), 'element.json'), 'utf8'));
const POLICY_FIELDS = ['type', 'family', 'remote', 'private'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

test('C-16-1: the shipped pack is templates/elements/web-chat-builtins, named BUILTIN_ELEMENT_PACK', () => {
  assert.equal(path.basename(PACK_DIR), BUILTIN_ELEMENT_PACK);
  assert.equal(path.relative(path.join(__dirname, '..'), PACK_DIR).split(path.sep).join('/'), 'templates/elements/web-chat-builtins');
  const m = parseManifest(PACK_DIR);
  assert.equal(m.name, BUILTIN_ELEMENT_PACK);
  assert.equal(m.version, '1.1.0'); // 1.1.0: chat-comment (tranche 3, U415)
  assert.equal(typeof m.description, 'string');
});

test('C-16-1: the pack lists exactly BUILTIN_ELEMENT_TYPE_NAMES, in order, and ships a directory for each and no other', () => {
  const m = parseManifest(PACK_DIR);
  assert.deepStrictEqual(m.elements, [...BUILTIN_ELEMENT_TYPE_NAMES]);
  const dirs = fs.readdirSync(path.join(PACK_DIR, 'elements'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepStrictEqual(dirs, [...BUILTIN_ELEMENT_TYPE_NAMES].sort());
  assert.deepStrictEqual(Object.keys(m).sort(), ['description', 'elements', 'name', 'version'],
    'no components, themes or skill: the pack is the three types');
  assert.equal(fs.existsSync(path.join(PACK_DIR, 'SKILL.md')), false);
});

for (const row of BUILTIN_ELEMENT_TYPES) {
  test(`C-16-1: ${row.type}/element.json's policy fields deep-equal its BUILTIN_ELEMENT_TYPES row`, () => {
    const json = elementJson(row.type);
    assert.deepStrictEqual(pick(json, POLICY_FIELDS), {
      type: row.type, family: row.family, remote: { see: row.remote.see, send: row.remote.send }, private: row.private,
    });
    // Every policy field is written out, none left to a default.
    for (const k of POLICY_FIELDS) assert.ok(k in json, `${row.type}: "${k}" is written`);
  });
}

test('C-16-1: every built-in type has a row, and every row a type (no type in one source only)', () => {
  assert.deepStrictEqual(BUILTIN_ELEMENT_TYPES.map((r) => r.type), [...BUILTIN_ELEMENT_TYPE_NAMES]);
  for (const type of BUILTIN_ELEMENT_TYPE_NAMES) {
    assert.ok(fs.existsSync(path.join(typeDir(type), 'element.json')), `${type}/element.json is shipped`);
  }
});

test('each built-in element.json passes validateElement with 0 errors, and the manifest validates as the built-in pack', () => {
  for (const type of BUILTIN_ELEMENT_TYPE_NAMES) {
    const read = readElementJson(typeDir(type));
    assert.ok(read.ok, read.error);
    const v = validateElement(read.raw, { stageDir: PACK_DIR, name: type, builtin: true });
    assert.deepStrictEqual(v.errors, [], `${type}: no errors`);
    assert.equal(v.ok, true);
  }
  const m = validateManifest(parseManifest(PACK_DIR), { stageDir: PACK_DIR, builtin: true });
  assert.deepStrictEqual(m.errors, []);
  assert.deepStrictEqual(m.elements.map((e) => e.name), [...BUILTIN_ELEMENT_TYPE_NAMES]);
  // …and only as the built-in pack: without `builtin` the names are reserved.
  const third = validateManifest(parseManifest(PACK_DIR), { stageDir: PACK_DIR });
  assert.equal(third.errors.length > 0, true);
});

test('the engine fields: schema, reads and anchors (box grab: page only, ruling U328c@grab-after-send a)', () => {
  const want = {
    // F.6 (U406): the comment writes comment@2 (a chained comment) and reads both.
    comment: { schema: 'comment@2', reads: ['comment@1', 'comment@2'], anchors: ['element', 'range', 'source'] },
    highlight: { schema: 'highlight@1', reads: ['highlight@1'], anchors: ['range', 'source'] },
    'box-grab': { schema: 'box-grab@1', reads: ['box-grab@1'], anchors: ['page'] },
    // tranche 3, U415 (RULED CHAT@type a): the chat comment, on the chat anchors.
    'chat-comment': { schema: 'chat-comment@1', reads: ['chat-comment@1'], anchors: ['turn', 'item', 'item-range', 'diff-line'] },
  };
  assert.deepStrictEqual(Object.keys(want), [...BUILTIN_ELEMENT_TYPE_NAMES]);
  for (const [type, fields] of Object.entries(want)) {
    assert.deepStrictEqual(pick(elementJson(type), ['schema', 'reads', 'anchors']), fields, type);
  }
});

test('no draw.js in the built-in pack: the chrome draws the built-ins', () => {
  for (const type of BUILTIN_ELEMENT_TYPE_NAMES) {
    assert.equal(fs.existsSync(path.join(typeDir(type), 'draw.js')), false, `${type} ships no draw.js`);
  }
});

// The toolbar fields, exactly as K.2-1 (U335's grammar) and F2 (a) give them,
// with the display label K.2-46 adds.
const TOOLBAR = {
  comment: {
    label: 'Comment',
    icons: { light: 'icon-light.svg', dark: 'icon-dark.svg' },
    settings: { small: { type: 'object', properties: { shared: { type: 'boolean', title: 'Visible to Claude', default: true } } } },
    hotkeys: [{ action: 'arm', label: 'Pin comment', default: 'C' }],
    profiles: false,
    input: 'taps',
    wake: true,
    summary_key: 'text',
  },
  highlight: {
    label: 'Highlight',
    icons: { light: 'icon-light.svg', dark: 'icon-dark.svg' },
    settings: {
      small: {
        type: 'object',
        properties: {
          color: { type: 'string', title: 'Colour', enum: ['gold', 'accent', 'green', 'rust'], default: 'gold' },
          snap: { type: 'string', title: 'Snap to', enum: ['words', 'blocks'], default: 'words' },
        },
      },
    },
    hotkeys: [],
    profiles: true,
    input: 'selection',
    wake: true,
    summary_key: 'note',
  },
  'box-grab': {
    label: 'Box grab',
    icons: { light: 'icon-light.svg', dark: 'icon-dark.svg' },
    settings: { small: { type: 'object', properties: { snap: { type: 'string', title: 'Snap to', enum: ['block', 'free'], default: 'block' } } } },
    hotkeys: [],
    profiles: false,
    input: 'strokes',
    wake: true,
  },
  // tranche 3, U415: armed by the Comment tool (`tool`), so no hotkeys of its own.
  'chat-comment': {
    label: 'Comment',
    icons: { light: 'icon-light.svg', dark: 'icon-dark.svg' },
    settings: { small: { type: 'object', properties: { shared: { type: 'boolean', title: 'Visible to Claude', default: true } } } },
    input: 'taps',
    wake: true,
    summary_key: 'text',
    tool: 'comment',
  },
};

test('the toolbar fields are exactly the table (label, icons, settings.small, hotkeys, profiles, input, wake, summary_key; no needs)', () => {
  assert.deepStrictEqual(Object.keys(TOOLBAR), [...BUILTIN_ELEMENT_TYPE_NAMES]);
  for (const [type, want] of Object.entries(TOOLBAR)) {
    const json = elementJson(type);
    const rest = Object.fromEntries(Object.entries(json).filter(([k]) => ![...POLICY_FIELDS, 'schema', 'reads', 'anchors'].includes(k)));
    assert.deepStrictEqual(rest, want, `${type}: the toolbar fields and nothing else`);
    assert.equal('needs' in json, false, `${type}: needs is absent`);
  }
  const profiled = BUILTIN_ELEMENT_TYPE_NAMES.filter((t) => elementJson(t).profiles === true);
  assert.deepStrictEqual(profiled, ['highlight'], 'profiles: true on highlight only (H-1 a, K.2-7)');
});

test('highlight\'s colours are token names, never a raw CSS colour', () => {
  const { enum: colours, default: dflt } = elementJson('highlight').settings.small.properties.color;
  for (const c of colours) assert.match(c, /^[a-z]+$/, `${c} is a token name the chrome maps to --wc-${c}`);
  assert.ok(colours.includes(dflt));
});

test('each icon file exists, is an inert SVG through the one image check, and is 24×24', () => {
  for (const type of BUILTIN_ELEMENT_TYPE_NAMES) {
    const { icons } = elementJson(type);
    for (const mode of ['light', 'dark']) {
      const file = path.join(typeDir(type), icons[mode]);
      assert.equal(path.dirname(file), typeDir(type), `${type} ${mode}: inside the type's own directory`);
      const st = fs.lstatSync(file);
      assert.ok(st.isFile() && !st.isSymbolicLink(), `${type} ${mode}: a regular file`);
      const bytes = fs.readFileSync(file);
      assert.equal(validateImage(bytes), 'svg', `${type} ${mode}: an SVG brand-image accepts`);
      assert.deepStrictEqual(imageSize(bytes), { width: 24, height: 24 }, `${type} ${mode}: a 24×24 viewBox`);
      assert.doesNotMatch(bytes.toString('utf8'), /currentColor/, `${type} ${mode}: fixed colours (an <img> has no currentColor)`);
    }
    const light = fs.readFileSync(path.join(typeDir(type), icons.light), 'utf8');
    const dark = fs.readFileSync(path.join(typeDir(type), icons.dark), 'utf8');
    assert.notEqual(light, dark, `${type}: the dark icon differs from the light`);
    assert.equal(light.match(/ d="([^"]+)"/)[1], dark.match(/ d="([^"]+)"/)[1], `${type}: the same glyph in both modes`);
  }
});
