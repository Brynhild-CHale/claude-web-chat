// A level's Save sends the type's whole settings payload (annotation engine
// 2D.6; DECISIONS.md K.2-87; U336a), against the real chrome booted once in
// jsdom (test-support/chrome-shell), with the real form-renderer drawing the
// frame.
//
// The toolbar record merges `settings` per TYPE (lib/core/toolbar-record: a
// type's payload replaces), so the settings frame — the one writer that knows
// both levels — sends the type's whole plain payload for the project tier:
// the project tier's current settings[type], each field the OTHER level's
// schema declares (the type's registry row in GET /api/toolbar's tools[])
// carried untouched, the frame's values over it, and a key no level declares
// dropped.
//
// Pinned here:
//   - current {a: 1, b: 2}: a small Save of {a: 3} sends {a: 3, b: 2} (red
//     before K.2-87: it sent {a: 3}); a large Save of {b: 4} sends {a: 1, b: 4};
//   - a type that declares the small level only sends the frame's values
//     alone; with no current value a Save sends the frame's values;
//   - the current value is the project tier's own record, never the merged
//     view: a user-tier default is not copied into the project's record;
//   - a key no level declares is dropped; a field the open level declares and
//     the frame leaves empty stays out (the user cleared it), even when the
//     other level declares it too;
//   - a profile Save is unchanged: the profile list, the named profile's
//     settings replaced by the frame's values.
const test = require('node:test');
const { before, beforeEach, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const FORM_DIR = path.join(REPO, 'templates/components/form-renderer');
const FORM_HTML = fs.readFileSync(path.join(FORM_DIR, 'component.html'), 'utf8');
const FORM_META = JSON.parse(fs.readFileSync(path.join(FORM_DIR, 'meta.json'), 'utf8'));

const SMALL = { type: 'object', properties: { a: { type: 'integer', title: 'A' } } };
const LARGE = { type: 'object', properties: { b: { type: 'integer', title: 'B' } } };
const row = (type, settings, extra = {}) => ({
  type, label: type, pack: { name: 'fun', version: '1.0.0' }, builtin: false, icons: null,
  hotkeys: [], settings, profiles: false, input: 'taps', installed: true, ...extra,
});
// `both` declares c at both levels (the daemon checks a key against every
// level that declares it): the open frame owns it, so it is never carried.
const SMALL_C = { type: 'object', properties: { a: { type: 'integer', title: 'A' }, c: { type: 'integer', title: 'C' } } };
const LARGE_C = { type: 'object', properties: { b: { type: 'integer', title: 'B' }, c: { type: 'integer', title: 'C' } } };
const TOOLS = [
  row('fixture', { small: SMALL, large: LARGE }, { profiles: true }),
  row('lone', { small: SMALL }),
  row('both', { small: SMALL_C, large: LARGE_C }),
];
const PROJECT = ({ settings = {}, profiles = {} } = {}) => ({ v: 1, pinned: [], hidden: [], settings, profiles, bindings: {} });
const USER = ({ settings = {} } = {}) => ({ v: 1, bindings: {}, fingerDraws: false, settings });
const VIEW = (project = PROJECT(), user = USER()) => ({ ok: true, v: 1, project, user,
  merged: { bindings: {}, settings: {} }, canWrite: true, canWriteUser: true, tools: TOOLS });

const DESKTOP = { width: 1280, height: 800, coarse: false };

let shell, W, $, TS, ts, ov;
let view = VIEW();
function routes() {
  return {
    '/api/components/form-renderer': { ...FORM_META, source: FORM_HTML, has_service: false },
    '/api/toolbar': () => view,
  };
}

before(async () => {
  shell = await bootShell({ routes: routes() });
  W = shell.window;
  $ = shell.$;
  TS = await shell.importApp('tool-settings.js');
  ts = await shell.importApp('toolbar-state.js');
  ov = await shell.importApp('overlay.js');
});

beforeEach(async () => {
  TS.closeToolSettings();
  ov.setArmed(null);
  view = VIEW();
  shell.setRoutes(routes());
  shell.setViewport(DESKTOP);
  await ts.refreshToolbar();
});

after(async () => { await shell.restore(); });

const patches = () => shell.calls.filter((c) => c.url === '/api/toolbar' && c.method === 'PATCH');
const frameOf = (level) => $(level === 'small' ? 'tool-settings-small' : 'tool-settings-large');

async function useView(project, user) {
  view = VIEW(project, user);
  await ts.refreshToolbar();
  assert.equal(ts.toolbarState().tools.length, TOOLS.length, 'the registry rows landed');
}

// Open `type`'s `level` frame (the schema its row declares, the value given),
// set the frame's one field to `input` ('' clears it) and Save. → the body of
// the one PATCH it sent.
async function saveLevel({ type = 'fixture', level, value = {}, input, profile = null }) {
  const schema = level === 'small' ? SMALL : LARGE;
  const key = level === 'small' ? 'a' : 'b';
  const r = TS.openToolSettings({ type, level, schema, value, profile, label: type });
  assert.equal(r.ok, true, `opened: ${JSON.stringify(r)}`);
  const done = await r.ready;
  assert.equal(done.ok, true, `the form mounted: ${JSON.stringify(done)}`);
  const root = frameOf(level).querySelector('.ts-host').shadowRoot;
  const field = root.querySelector(`#f_${key}`);
  assert.ok(field, `the frame draws ${key}`);
  field.value = String(input);
  const n = patches().length;
  root.querySelector('#submit').click();
  await waitUntil(() => patches().length > n, { timeout: 2000, what: 'the PATCH' });
  await shell.tick();
  const sent = patches().slice(n);
  assert.equal(sent.length, 1, 'one PATCH');
  return sent[0].body;
}

test('a small Save keeps the large-only fields: current {a: 1, b: 2}, Save {a: 3} → {a: 3, b: 2}', async () => {
  await useView(PROJECT({ settings: { fixture: { a: 1, b: 2 } } }));
  const body = await saveLevel({ level: 'small', value: { a: 1, b: 2 }, input: 3 });
  assert.deepEqual(body, { settings: { fixture: { a: 3, b: 2 } } });
});

test('a large Save keeps the small-only fields: current {a: 1, b: 2}, Save {b: 4} → {a: 1, b: 4}', async () => {
  await useView(PROJECT({ settings: { fixture: { a: 1, b: 2 } } }));
  const body = await saveLevel({ level: 'large', value: { a: 1, b: 2 }, input: 4 });
  assert.deepEqual(body, { settings: { fixture: { a: 1, b: 4 } } });
});

test('a type that declares the small level only sends the frame\'s values alone', async () => {
  await useView(PROJECT({ settings: { lone: { a: 1, b: 2 } } }));
  const body = await saveLevel({ type: 'lone', level: 'small', value: { a: 1 }, input: 3 });
  assert.deepEqual(body, { settings: { lone: { a: 3 } } });
});

test('with no current value the Save sends the frame\'s values', async () => {
  await useView(PROJECT());
  assert.deepEqual(await saveLevel({ level: 'small', input: 3 }), { settings: { fixture: { a: 3 } } });
  assert.deepEqual(await saveLevel({ level: 'large', input: 4 }), { settings: { fixture: { b: 4 } } });
});

test('the current value is the project tier\'s own record: a user-tier default is not copied in', async () => {
  await useView(PROJECT({ settings: { fixture: { a: 1 } } }), USER({ settings: { fixture: { b: 9 } } }));
  const body = await saveLevel({ level: 'small', value: ts.settingsOf('fixture'), input: 3 });
  assert.deepEqual(body, { settings: { fixture: { a: 3 } } }, 'b stays the user tier\'s, not the project\'s');
});

test('a key no level declares is dropped; a field the open level declares and the frame clears stays out', async () => {
  await useView(PROJECT({ settings: { fixture: { a: 1, b: 2, z: 7 } } }));
  assert.deepEqual(await saveLevel({ level: 'small', value: { a: 1, b: 2 }, input: 3 }), { settings: { fixture: { a: 3, b: 2 } } });
  assert.deepEqual(await saveLevel({ level: 'small', value: { a: 1, b: 2 }, input: '' }), { settings: { fixture: { b: 2 } } });
});

test('a field both levels declare belongs to the open frame: cleared there, it is not carried back', async () => {
  await useView(PROJECT({ settings: { both: { a: 1, b: 2, c: 5 } } }));
  const r = TS.openToolSettings({ type: 'both', level: 'small', schema: SMALL_C, value: { a: 1, c: 5 }, profile: null, label: 'both' });
  assert.equal((await r.ready).ok, true);
  const root = frameOf('small').querySelector('.ts-host').shadowRoot;
  root.querySelector('#f_a').value = '3';
  root.querySelector('#f_c').value = '';
  const n = patches().length;
  root.querySelector('#submit').click();
  await waitUntil(() => patches().length > n, { timeout: 2000, what: 'the PATCH' });
  assert.deepEqual(patches().at(-1).body, { settings: { both: { a: 3, b: 2 } } });
});

test('the current value is read at Save time: a write landed while the frame was open is kept', async () => {
  await useView(PROJECT({ settings: { fixture: { a: 1, b: 2 } } }));
  const r = TS.openToolSettings({ type: 'fixture', level: 'small', schema: SMALL, value: { a: 1, b: 2 }, profile: null, label: 'fixture' });
  assert.equal((await r.ready).ok, true);
  await useView(PROJECT({ settings: { fixture: { a: 1, b: 5 } } }));
  const root = frameOf('small').querySelector('.ts-host').shadowRoot;
  root.querySelector('#f_a').value = '3';
  const n = patches().length;
  root.querySelector('#submit').click();
  await waitUntil(() => patches().length > n, { timeout: 2000, what: 'the PATCH' });
  assert.deepEqual(patches().at(-1).body, { settings: { fixture: { a: 3, b: 5 } } });
});

test('a profile Save still sends the profile list, the named profile\'s settings replaced (one payload)', async () => {
  await useView(PROJECT({
    settings: { fixture: { a: 1, b: 2 } },
    profiles: { fixture: [{ name: 'cool', settings: { a: 5, b: 6 } }, { name: 'warm', settings: { a: 1, b: 2 } }] },
  }));
  const body = await saveLevel({ level: 'small', value: { a: 1, b: 2 }, input: 3, profile: 'warm' });
  assert.deepEqual(body, { profiles: { fixture: [
    { name: 'cool', settings: { a: 5, b: 6 } }, { name: 'warm', settings: { a: 3 } },
  ] } });
  assert.ok(!('settings' in body), 'the plain settings are not written');
});
