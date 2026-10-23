// The element manifest's toolbar fields (annotation engine tranche 2, U335;
// PLAN.md 2D.5, DECISIONS.md I.6 and K.2 items 1, 6, 7, 10, 16, 45 and 46,
// rulings H-1 (a), 2C@types-dir (a) and U323-U335@builtin-settings (a)).
//
// element.json's label, icons, settings, hotkeys, profiles, input, wake,
// summary_key and needs are validated in lib/packs/elements toolbarFields —
// through lib/core/brand-image validate (the one image check), lib/core/paths
// fence (the one fence for a handed path), lib/core/toolbar-record validChord
// (the one chord grammar) and lib/core/settings-schema validateSchema (the one
// settings subset) — inside U322's element.json validation, so a bad field is
// refused naming itself, shown by `pack review` and refused at `pack approve`.
// The built-in pack's three files (U323's) carry exactly the ruled values, and
// the icons they name install into each type's directory.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { packFixture, tmpDir, fakeForge, repoWithArchive } = require('../test-support/packs');
const { withServer, withTempHome } = require('../test-support/helpers');
const { projectPaths } = require('../lib/core/paths');
const { encodePng } = require('../lib/core/png');
const icon = require('../lib/core/icon');
const { BUILTIN_ELEMENT_TYPE_NAMES } = require('../lib/core/names');
const { validateSchema, checkValue } = require('../lib/core/settings-schema');
const elements = require('../lib/packs/elements');
const { toolbarFields, validateElement, readElementJson, elementFiles, INPUT_KINDS, TOOLBAR_KEYS } = elements;
const { validateManifest, parseManifest } = require('../lib/packs/manifest');
const { listPacks } = require('../lib/packs/store');
const packs = require('../lib/packs/install');
const { ELEMENTS_TEMPLATE_DIR } = require('../lib/server/builtins');

// ── fixtures ────────────────────────────────────────────────────────────────
const SHA = 'a'.repeat(40);
const svg = (w = 24, h = 24, body = '<path d="M4 4h16v16H4z"/>') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" stroke="#2f2b26">${body}</svg>\n`;
const png = (w, h = w) => encodePng(Buffer.alloc(w * h * 4, 0x80), w, h);
const DRAW = "export default function draw(el, ctx) { ctx.box(el).textContent = 'sticky'; }\n";

// A sound set of every toolbar field.
const GOOD = Object.freeze({
  label: 'Sticky note',
  icons: { light: 'icon-light.svg', dark: 'icon-dark.png' },
  settings: {
    small: {
      type: 'object',
      properties: {
        color: { type: 'string', title: 'Colour', enum: ['gold', 'accent', 'green', 'rust'], default: 'gold' },
        size: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
      },
    },
    large: { type: 'object', properties: { note: { type: 'string', maxLength: 200 } }, required: ['note'] },
  },
  hotkeys: [{ action: 'arm', label: 'Sticky note', default: 'Shift+S' }, { action: 'cycle-colour', label: 'Next colour' }],
  profiles: true,
  input: 'taps',
  wake: true,
  summary_key: 'note',
  needs: { network: 'api.example.com, to fetch the sticker set', key: { name: 'sticker-key', label: 'Sticker API key' } },
});

// One type's files on disk: element.json from `json` (a key set to undefined
// is left out) plus the files given.
function typeFiles(type, json, files) {
  const body = { type, family: 'page', remote: { see: 'read', send: 'full' }, schema: `${type}@1`, anchors: ['element', 'range'], ...json };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  const out = { [`elements/${type}/element.json`]: JSON.stringify(body, null, 2) + '\n', [`elements/${type}/draw.js`]: DRAW };
  for (const [rel, bytes] of Object.entries(files)) out[`elements/${type}/${rel}`] = bytes;
  return out;
}

const ICONS = Object.freeze({ 'icon-light.svg': svg(), 'icon-dark.png': png(48) });

function stage({ name = 'mark-pack', json = GOOD, files = ICONS } = {}) {
  return packFixture({
    name, version: '1.0.0', components: [], skill: false,
    manifest: { name, version: '1.0.0', description: 'Sticky notes on the surface.', elements: ['sticky'] },
    extraFiles: typeFiles('sticky', json, files),
  });
}

// What U322's validation (validateManifest over a staged tree) says.
function validateStage(dir) {
  return validateManifest(parseManifest(dir), { stageDir: dir });
}

// The fields the errors name, in order.
const fieldsOf = (errors) => errors.map((e) => {
  const m = /^element "sticky": "([^"]+)" /.exec(e);
  return m ? m[1] : `?${e}`;
});

// ── a sound element.json ────────────────────────────────────────────────────
test('a sound element.json with every toolbar field passes, kept as written, for each input kind', () => {
  for (const input of ['taps', 'strokes', 'selection']) {
    const dir = stage({ json: { ...GOOD, input } });
    const m = validateStage(dir);
    assert.deepStrictEqual(m.errors, [], input);
    assert.deepStrictEqual(m.warnings, [], `${input}: a toolbar field is not an unknown key`);
    const d = m.elements[0].descriptor;
    for (const k of TOOLBAR_KEYS) assert.deepStrictEqual(d[k], { ...GOOD, input }[k], `${input}: ${k} kept as written`);
    assert.deepStrictEqual(toolbarFields({ ...GOOD, input }, path.join(dir, 'elements', 'sticky')), { ok: true, errors: [] });
  }
  assert.deepStrictEqual([...INPUT_KINDS], ['taps', 'strokes', 'selection']);
  // Every field is optional: none at all passes, and so does a type without icons.
  assert.deepStrictEqual(validateStage(stage({ json: {}, files: {} })).errors, []);
  assert.deepStrictEqual(toolbarFields({}, null), { ok: true, errors: [] });
  // Eight hotkeys is the cap, inclusive.
  const eight = Array.from({ length: 8 }, (_, i) => ({ action: `a${i}`, label: `A${i}` }));
  assert.deepStrictEqual(toolbarFields({ hotkeys: eight }, null), { ok: true, errors: [] });
  // Icons under assets/ are fine too.
  const assets = stage({ json: { icons: { light: 'assets/a.svg', dark: 'assets/dark/a.svg' } }, files: { 'assets/a.svg': svg(), 'assets/dark/a.svg': svg(32, 32) } });
  assert.deepStrictEqual(validateStage(assets).errors, []);
});

// ── each refusal names its field ────────────────────────────────────────────
test('each bad field is refused naming its field (icons, hotkeys, label, input, wake, settings, needs)', () => {
  const withIcon = (light, files) => ({ json: { ...GOOD, icons: { light, dark: 'icon-dark.png' } }, files: { ...ICONS, ...files } });
  const big = Buffer.concat([png(48), Buffer.alloc(300 * 1024 - png(48).length)]);
  const cases = [
    ['an icon path with ../', withIcon('../other/icon.svg', {}), 'icons.light', /must be a relative path inside the type's directory/],
    ['an absolute icon path', withIcon('/etc/icon.svg', {}), 'icons.light', /must be a relative path/],
    ['a missing icon', withIcon('gone.svg', {}), 'icons.light', /"gone\.svg" is missing/],
    ['an SVG with a <script>', withIcon('bad.svg', { 'bad.svg': svg(24, 24, '<script>alert(1)</script>') }), 'icons.light', /"bad\.svg": SVG refused: it contains a <script> element/],
    ['a 300 KB PNG', withIcon('big.png', { 'big.png': big }), 'icons.light', /image is 307200 bytes; the limit is 262144/],
    ['a 40 px PNG', withIcon('small.png', { 'small.png': png(40) }), 'icons.light', /40×40: a PNG icon is at least 48 px a side/],
    ['a non-square SVG', withIcon('wide.svg', { 'wide.svg': svg(24, 20) }), 'icons.light', /24×20: a tool's icon is square/],
    ['a non-square PNG', withIcon('wide.png', { 'wide.png': png(64, 48) }), 'icons.light', /64×48: a tool's icon is square/],
    ['an SVG with no viewBox', withIcon('nobox.svg', { 'nobox.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>\n' }), 'icons.light', /its size cannot be read/],
    ['a PNG named .svg', withIcon('liar.svg', { 'liar.svg': png(48) }), 'icons.light', /"liar\.svg" is not an SVG/],
    ['a text file', withIcon('notes.svg', { 'notes.svg': 'hello\n' }), 'icons.light', /not an SVG or PNG image/],
    ['one icon only', { json: { ...GOOD, icons: { light: 'icon-light.svg' } } }, 'icons.dark', /both icons or neither/],
    ['a hotkey default Mod+K', { json: { ...GOOD, hotkeys: [{ action: 'arm', label: 'Arm', default: 'Mod+K' }] } }, 'hotkeys.0.default', /never ⌘\/Ctrl, Alt, Escape or Tab/],
    ['a hotkey default Alt+C', { json: { ...GOOD, hotkeys: [{ action: 'arm', label: 'Arm', default: 'Alt+C' }] } }, 'hotkeys.0.default', /"Alt\+C" is not a chord/],
    ['a hotkey default Escape', { json: { ...GOOD, hotkeys: [{ action: 'arm', label: 'Arm', default: 'Escape' }] } }, 'hotkeys.0.default', /not a chord/],
    ['a hotkey label with U+202E', { json: { ...GOOD, hotkeys: [{ action: 'arm', label: 'Arm‮mrof' }] } }, 'hotkeys.0.label', /control, bidi or invisible/],
    ['a hotkey action that is not kebab', { json: { ...GOOD, hotkeys: [{ action: 'Arm', label: 'Arm' }] } }, 'hotkeys.0.action', /kebab-case/],
    ['a hotkey action twice', { json: { ...GOOD, hotkeys: [{ action: 'arm', label: 'A' }, { action: 'arm', label: 'B' }] } }, 'hotkeys.1.action', /listed twice/],
    ['two actions on one default', { json: { ...GOOD, hotkeys: [{ action: 'arm', label: 'A', default: 'k' }, { action: 'cycle', label: 'B', default: 'K' }] } }, 'hotkeys.1.default', /K is already another action's default/],
    ['nine hotkeys', { json: { ...GOOD, hotkeys: Array.from({ length: 9 }, (_, i) => ({ action: `a${i}`, label: `A${i}` })) } }, 'hotkeys', /at most 8 \(got 9\)/],
    ['a hotkey field it does not know', { json: { ...GOOD, hotkeys: [{ action: 'arm', label: 'Arm', when: 'always' }] } }, 'hotkeys.0.when', /not a hotkey field/],
    ['a label of 61 characters', { json: { ...GOOD, label: 'x'.repeat(61) } }, 'label', /at most 60 characters/],
    ['a label with U+202E', { json: { ...GOOD, label: 'Sticky‮' } }, 'label', /control, bidi or invisible/],
    ['input drag', { json: { ...GOOD, input: 'drag' } }, 'input', /must be one of taps, strokes, selection \(got "drag"\)/],
    ['wake yes', { json: { ...GOOD, wake: 'yes' } }, 'wake', /must be true or false \(got "yes"\)/],
    ['profiles 1', { json: { ...GOOD, profiles: 1 } }, 'profiles', /must be true or false/],
    ['settings.small with a nested object', { json: { ...GOOD, settings: { small: { type: 'object', properties: { a: { type: 'object', properties: {} } } } } } }, ['settings.small.properties.a.properties', 'settings.small.properties.a.type'], /no nested object or array/],
    ['a settings level it does not know', { json: { ...GOOD, settings: { medium: { type: 'object', properties: {} } } } }, 'settings.medium', /not a settings level/],
    ['a settings title with U+202E', { json: { ...GOOD, settings: { small: { type: 'object', properties: { a: { type: 'boolean', title: 'On‮' } } } } } }, 'settings.small.properties.a.title', /control, bidi or invisible/],
    ['a settings enum string with U+200B', { json: { ...GOOD, settings: { small: { type: 'object', properties: { a: { type: 'string', enum: ['go​ld'] } } } } } }, 'settings.small.properties.a.enum.0', /control, bidi or invisible/],
    ['a summary_key with a dot', { json: { ...GOOD, summary_key: 'payload.note' } }, 'summary_key', /must name a payload field/],
    ['needs.network too long', { json: { ...GOOD, needs: { network: 'n'.repeat(201) } } }, 'needs.network', /at most 200 characters/],
    ['needs.key with a bad name', { json: { ...GOOD, needs: { key: { name: 'Sticker_Key', label: 'Key' } } } }, 'needs.key.name', /kebab-case/],
    ['needs.key without a label', { json: { ...GOOD, needs: { key: { name: 'sticker-key' } } } }, 'needs.key.label', /non-empty string/],
    ['needs trust (derived, never declared)', { json: { ...GOOD, needs: { trust: true } } }, 'needs.trust', /is not a need \(network, key\)/],
  ];
  for (const [what, opts, field, re] of cases) {
    const m = validateStage(stage(opts));
    assert.deepStrictEqual(fieldsOf(m.errors), [].concat(field), `${what}: ${m.errors.join(' | ')}`);
    assert.match(m.errors[0], re, what);
    assert.deepStrictEqual(m.elements, [], `${what}: the type is refused`);
  }
});

test('an icon that is a symlink is refused, even one pointing at a sound icon inside the directory', () => {
  const dir = stage({ json: { ...GOOD, icons: { light: 'icon-light.svg', dark: 'link.svg' } } });
  fs.symlinkSync('icon-light.svg', path.join(dir, 'elements', 'sticky', 'link.svg'));
  const m = validateStage(dir);
  assert.deepStrictEqual(fieldsOf(m.errors), ['icons.dark']);
  assert.match(m.errors[0], /"link\.svg" is a link/);
  // A link pointing out of the directory is refused by the fence first.
  const out = stage({ json: { ...GOOD, icons: { light: 'icon-light.svg', dark: 'away/icon.svg' } } });
  fs.symlinkSync(tmpDir('wc-tb-away-'), path.join(out, 'elements', 'sticky', 'away'));
  assert.match(validateStage(out).errors.join(' | '), /"icons\.dark" "away\/icon\.svg" is outside the type's directory/);
  // And neither installs: elementFiles takes a regular file inside the directory only.
  assert.deepStrictEqual(elementFiles(path.join(dir, 'elements', 'sticky')), ['element.json', 'draw.js', 'icon-light.svg']);
  assert.deepStrictEqual(elementFiles(path.join(out, 'elements', 'sticky')), ['element.json', 'draw.js', 'icon-light.svg']);
});

test('without a stage only the icon paths\' shape is checked (the registry reads an installed, verified type)', () => {
  assert.deepStrictEqual(toolbarFields({ icons: { light: 'gone.svg', dark: 'gone.png' } }, null), { ok: true, errors: [] });
  assert.deepStrictEqual(toolbarFields({ icons: { light: '../x.svg', dark: 'x.gif' } }, null).errors.map((e) => e.field), ['icons.light', 'icons.dark']);
  const v = validateElement({ type: 'sticky', family: 'page', remote: { see: 'read', send: 'full' }, schema: 'sticky@1', anchors: ['element'], input: 'drag' }, { name: 'sticky' });
  assert.deepStrictEqual(v.errors, ['element "sticky": "input" must be one of taps, strokes, selection (got "drag")']);
});

// ── the icons install with the type (K.2-45) ────────────────────────────────
test('elementFiles installs the icons element.json names; an icon under assets/ is listed once', () => {
  const dir = stage();
  assert.deepStrictEqual(elementFiles(path.join(dir, 'elements', 'sticky')), ['element.json', 'draw.js', 'icon-light.svg', 'icon-dark.png']);
  const nested = stage({ json: { icons: { light: 'img/l.svg', dark: 'assets/d.svg' } }, files: { 'img/l.svg': svg(), 'assets/d.svg': svg(), 'assets/z.svg': svg() } });
  assert.deepStrictEqual(elementFiles(path.join(nested, 'elements', 'sticky')), ['element.json', 'draw.js', 'img/l.svg', 'assets/d.svg', 'assets/z.svg']);
  // A path outside the directory is never listed, and the validation refuses it.
  const outside = stage({ json: { icons: { light: '../../web-chat-pack.json', dark: 'icon-light.svg' } } });
  assert.deepStrictEqual(elementFiles(path.join(outside, 'elements', 'sticky')), ['element.json', 'draw.js', 'icon-light.svg']);
  assert.deepStrictEqual(fieldsOf(validateStage(outside).errors), ['icons.light']);
});

test('a fresh boot installs the built-in icons into .web-chat/element-types/<type>/', async (t) => {
  await withServer(t, async ({ root }) => {
    for (const type of BUILTIN_ELEMENT_TYPE_NAMES) {
      const json = JSON.parse(fs.readFileSync(path.join(ELEMENTS_TEMPLATE_DIR, 'elements', type, 'element.json'), 'utf8'));
      for (const mode of ['light', 'dark']) {
        const installed = path.join(projectPaths(root).elementTypesDir, type, json.icons[mode]);
        assert.ok(fs.existsSync(installed), `${type}: ${json.icons[mode]} installed`);
        assert.deepStrictEqual(fs.readFileSync(installed), fs.readFileSync(path.join(ELEMENTS_TEMPLATE_DIR, 'elements', type, json.icons[mode])));
      }
    }
    assert.ok(fs.existsSync(path.join(projectPaths(root).elementTypesDir, 'comment', 'icon-light.svg')));
    assert.ok(fs.existsSync(path.join(projectPaths(root).elementTypesDir, 'comment', 'icon-dark.svg')));
  });
});

// ── review shows the refusal, approve refuses the pack ──────────────────────
function runCli(args, { cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'claude-web-chat.js'), ...args], {
      cwd, env: { ...process.env, WEB_CHAT_NO_GH: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('pack review shows a bad toolbar field\'s refusal and pack approve refuses the pack (U322\'s path); nothing lands', async (t) => {
  withTempHome(t);
  const root = tmpDir('wc-tb-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  const bad = stage({ json: { ...GOOD, hotkeys: [{ action: 'arm', label: 'Arm', default: 'Mod+K' }] } });
  const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(bad, { sha: SHA }) } });
  const { record } = await packs.quarantinePack({ url: forge.url('acme', 'marks'), root });
  const refusal = 'element "sticky": "hotkeys.0.default" "Mod+K" is not a chord a tool may default to: [Shift+]<key>, never ⌘/Ctrl, Alt, Escape or Tab';
  assert.ok(record.errors.includes(refusal), record.errors.join(' | '));
  const r = packs.reviewQuarantine({ name: 'mark-pack', root });
  assert.ok(r.manifest.errors.includes(refusal), 'the review carries the refusal');
  const cli = await runCli(['pack', 'review', 'mark-pack'], { cwd: root });
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(cli.stdout.includes(`✗ ${refusal}`), cli.stdout);
  assert.throws(() => packs.approvePack({ name: 'mark-pack', root }), (e) => e.userFacing && e.message.includes(refusal));
  assert.equal(fs.existsSync(projectPaths(root).elementTypesDir), false, 'nothing installed');
  assert.deepStrictEqual(listPacks(root), []);
});

// ── the built-ins (U323's files, read from disk) ────────────────────────────
const typeDir = (type) => path.join(ELEMENTS_TEMPLATE_DIR, 'elements', type);
const builtin = (type) => readElementJson(typeDir(type)).raw;

test('the three built-in element.json files pass toolbarFields and validateElement, icons and all', () => {
  for (const type of BUILTIN_ELEMENT_TYPE_NAMES) {
    assert.deepStrictEqual(toolbarFields(builtin(type), typeDir(type)), { ok: true, errors: [] }, type);
    const v = validateElement(builtin(type), { stageDir: ELEMENTS_TEMPLATE_DIR, name: type, builtin: true });
    assert.deepStrictEqual([v.errors, v.warnings], [[], []], type);
  }
});

test('the built-ins carry exactly the ruled table (K.2-1, F2 a, K.2-6, K.2-7, K.2-10, K.2-16, K.2-46), and none declares needs', () => {
  const want = {
    comment: { label: 'Comment', hotkeys: [{ action: 'arm', label: 'Pin comment', default: 'C' }], profiles: false, input: 'taps', wake: true, summary_key: 'text' },
    highlight: { label: 'Highlight', hotkeys: [], profiles: true, input: 'selection', wake: true, summary_key: 'note' },
    'box-grab': { label: 'Box grab', hotkeys: [], profiles: false, input: 'strokes', wake: true },
  };
  for (const type of BUILTIN_ELEMENT_TYPE_NAMES) {
    const j = builtin(type);
    for (const [k, v] of Object.entries(want[type])) assert.deepStrictEqual(j[k], v, `${type}.${k}`);
    assert.equal('summary_key' in j, 'summary_key' in want[type], `${type}: summary_key`);
    assert.equal('needs' in j, false, `${type}: no needs`);
    assert.deepStrictEqual(Object.keys(j.icons).sort(), ['dark', 'light']);
    assert.deepStrictEqual(Object.keys(j.settings), ['small'], `${type}: settings.small only`);
  }
  const props = (type) => builtin(type).settings.small.properties;
  assert.deepStrictEqual(props('comment'), { shared: { type: 'boolean', title: 'Visible to Claude', default: true } });
  assert.deepStrictEqual(props('highlight').color.enum, ['gold', 'accent', 'green', 'rust']);
  assert.equal(props('highlight').color.default, 'gold');
  assert.deepStrictEqual(props('highlight').snap.enum, ['words', 'blocks']);
  assert.equal(props('highlight').snap.default, 'words');
  assert.deepStrictEqual(Object.keys(props('highlight')).sort(), ['color', 'snap']);
  assert.deepStrictEqual(props('box-grab'), { snap: { type: 'string', title: 'Snap to', enum: ['block', 'free'], default: 'block' } });
  // Each schema is valid, and each default passes checkValue.
  for (const type of BUILTIN_ELEMENT_TYPE_NAMES) {
    const schema = builtin(type).settings.small;
    assert.deepStrictEqual(validateSchema(schema), { ok: true, errors: [] }, type);
    const defaults = Object.fromEntries(Object.entries(schema.properties).map(([k, p]) => [k, p.default]));
    assert.deepStrictEqual(checkValue(schema, defaults), { ok: true, errors: [] }, type);
  }
});

// K.2-6: one input-kind grammar. The chrome cannot require lib/, so the
// overlay's registerType keeps its own list (public/app/overlay.js INPUT_KINDS);
// this holds the two equal.
test('the overlay\'s INPUT_KINDS is the manifest\'s (K.2-6)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'overlay.js'), 'utf8');
  const m = /export const INPUT_KINDS = Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, 'overlay.js exports INPUT_KINDS');
  assert.deepStrictEqual(JSON.parse(`[${m[1].replace(/'/g, '"')}]`), [...INPUT_KINDS]);
});

test('icon: TOOL_ICON_SIDE is exported and is 48 (a 24 px glyph at 2×)', () => {
  assert.equal(icon.TOOL_ICON_SIDE, 48);
  assert.equal(icon.TAB_ICON_SIDE, 16);
});
