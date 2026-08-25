// Onboarding + feedback for the two bundled browser extensions.
//
// Three areas, all previously untested:
//   * the served install pages (/extensions…) — the only place that can name the
//     sideload path on THIS machine;
//   * the manifest/icon assets those pages and Chrome both depend on;
//   * background.js's user-visible failure behaviour, exercised by running the
//     real service-worker source in a vm with a stub `chrome`/`fetch`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const zlib = require('zlib');
const { withServer } = require('../test-support/helpers');

const EXT_ROOT = path.join(__dirname, '..', 'extensions');
const NAMES = ['tab-stream', 'embed-helper'];
const ICON_SIZES = [16, 32, 48, 128];

// ---------------------------------------------------------------- install page

test('GET /extensions lists both bundled extensions', async (t) => {
  const { api } = await withServer(t);
  const { status, text } = await api.get('/extensions');
  assert.equal(status, 200);
  for (const name of NAMES) {
    assert.match(text, new RegExp(`href="/extensions/${name}"`), `links ${name}`);
  }
});

test('an install page names the extension folder on THIS machine', async (t) => {
  const { api } = await withServer(t);
  const { status, text } = await api.get('/extensions/tab-stream');
  assert.equal(status, 200);
  // The whole point: a path the user can paste into "Load unpacked". A README
  // cannot produce this — only the running daemon knows where it was installed.
  const expected = path.join(EXT_ROOT, 'tab-stream');
  assert.ok(text.includes(expected), `page must print ${expected}`);
  assert.match(text, /Load unpacked/);
  assert.match(text, /about:debugging/, 'covers Firefox-based browsers too');
});

test('the tab-stream page reports live hub reachability, naming the fix command', async (t) => {
  const { api } = await withServer(t);
  const { text } = await api.get('/extensions/tab-stream');
  assert.match(text, /data-hub="http:\/\/localhost:5170"/, 'probes the real hub origin');
  assert.match(text, /claude-web-chat open/, 'the failure branch names the command');
});

test('the embed-helper page detects the extension via its sentinel meta', async (t) => {
  const { api } = await withServer(t);
  const { text } = await api.get('/extensions/embed-helper');
  assert.match(text, /data-probe="claude-web-chat-embed-helper"/);
});

test('install pages HTML-escape the machine path (a project dir may contain markup)', async (t) => {
  // Guards the templating itself: the path is interpolated, so it must go
  // through escapeHtml rather than String.replace (which also mangles `$&`).
  const { api } = await withServer(t);
  const { text } = await api.get('/extensions/tab-stream');
  const body = text.slice(text.indexOf('<main>'));
  assert.ok(!/<script(?! )/.test(body.replace(/<script>[\s\S]*$/, '')), 'no stray script in body');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'routes', 'extensions.js'), 'utf8');
  assert.match(src, /escapeHtml\(extDir\)/, 'the path is escaped, not raw-interpolated');
});

test('an unknown extension name 404s instead of resolving a path', async (t) => {
  const { api } = await withServer(t);
  const bogus = await api.get('/extensions/nope');
  assert.equal(bogus.status, 404);
  const traversal = await api.get('/extensions/..%2f..%2fpackage.json');
  assert.equal(traversal.status, 404, 'no path escape through :name');
});

test('/extensions/:name/download serves a real zip of the extension folder', async (t) => {
  const { api } = await withServer(t);
  const res = await api.raw('/extensions/tab-stream/download');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /claude-web-chat-tab-stream\.zip/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'local file header signature');
  assert.ok(buf.includes(Buffer.from('manifest.json')), 'contains the manifest');
  assert.ok(buf.includes(Buffer.from('icons/icon128.png')), 'contains the icons');
});

test('legacy /embed-helper URLs still resolve (the website component links them)', async (t) => {
  const { api } = await withServer(t);
  const res = await api.raw('/embed-helper', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/extensions/embed-helper');
  const files = await api.get('/embed-helper/files/manifest.json');
  assert.equal(files.status, 200);
});

test('extension source files are served for review before install', async (t) => {
  const { api } = await withServer(t);
  const manifest = await api.get('/extensions/tab-stream/files/manifest.json');
  assert.equal(manifest.status, 200);
  assert.equal(JSON.parse(manifest.text).manifest_version, 3);
  const icon = await api.raw('/extensions/tab-stream/files/icons/icon48.png');
  assert.equal(icon.status, 200);
});

// ---------------------------------------------------------------- icon assets

// Minimal independent PNG reader: signature + IHDR + a zlib-decodable IDAT.
// Deliberately does NOT reuse make-icons.js's encoder — a test that trusts the
// encoder it is checking proves nothing.
function readPng(file) {
  const buf = fs.readFileSync(file);
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(SIG), `${file}: PNG magic bytes`);
  let off = 8;
  let ihdr = null;
  const idat = [];
  let sawIend = false;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = data;
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') sawIend = true;
    off += 12 + len;
  }
  assert.ok(ihdr, `${file}: has IHDR`);
  assert.ok(sawIend, `${file}: has IEND`);
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  // Throws if the deflate stream or its adler32 is wrong.
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, height * (width * 4 + 1), `${file}: scanline count/stride`);
  return { width, height, depth: ihdr[8], colorType: ihdr[9], raw };
}

test('both extensions ship decodable PNG icons at every manifest size', () => {
  for (const name of NAMES) {
    for (const size of ICON_SIZES) {
      const file = path.join(EXT_ROOT, name, 'icons', `icon${size}.png`);
      assert.ok(fs.existsSync(file), `${file} must exist`);
      const png = readPng(file);
      assert.equal(png.width, size, `${file} width`);
      assert.equal(png.height, size, `${file} height`);
      assert.equal(png.depth, 8);
      assert.equal(png.colorType, 6, 'RGBA');
    }
  }
});

test('icons are not blank — the toolbar button must actually show something', () => {
  for (const name of NAMES) {
    const { raw, width, height } = readPng(path.join(EXT_ROOT, name, 'icons', 'icon128.png'));
    let opaque = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (raw[y * (width * 4 + 1) + 1 + x * 4 + 3] > 200) opaque++;
      }
    }
    assert.ok(opaque > width * height * 0.5, `${name}: icon is mostly opaque, not an empty file`);
  }
});

test('every manifest icon reference resolves to a file that exists', () => {
  for (const name of NAMES) {
    const dir = path.join(EXT_ROOT, name);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.ok(manifest.icons, `${name}: manifest declares icons`);
    const refs = [...Object.values(manifest.icons)];
    if (manifest.action && manifest.action.default_icon) {
      refs.push(...Object.values(manifest.action.default_icon));
    }
    assert.ok(refs.length >= ICON_SIZES.length);
    for (const ref of refs) {
      assert.ok(fs.existsSync(path.join(dir, ref)), `${name}: ${ref} is referenced but missing`);
    }
  }
});

test('manifests stay MV3-shaped', () => {
  for (const name of NAMES) {
    const m = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, name, 'manifest.json'), 'utf8'));
    assert.equal(m.manifest_version, 3);
    assert.ok(m.name && m.version && m.description);
    // MV3 forbids the MV2 spellings; a stray one makes Chrome refuse the load.
    assert.ok(!('browser_action' in m) && !('page_action' in m), `${name}: no MV2 action key`);
    assert.ok(!(m.background && m.background.scripts), `${name}: no MV2 background.scripts`);
    for (const key of Object.keys(m.icons)) {
      assert.ok(ICON_SIZES.includes(Number(key)), `${name}: icon key ${key} is a pixel size`);
    }
  }
});

// -------------------------------------------------- background.js behaviour

// Run the real service worker in a vm with a stub `chrome`, capturing the
// listeners it registers and everything it does to the user-visible surfaces
// (badge, injected script, storage).
function loadBackground({ fetchImpl }) {
  const listeners = {};
  const calls = { badge: [], title: [], scripts: [], localSet: [], syncSet: [] };
  const chrome = {
    storage: {
      sync: {
        get: async () => ({}),
        set: (v) => { calls.syncSet.push(v); },
      },
      local: { set: async (v) => { calls.localSet.push(v); } },
    },
    runtime: { onMessage: { addListener: (fn) => { listeners.message = fn; } } },
    contextMenus: {
      create: () => {},
      onClicked: { addListener: (fn) => { listeners.menu = fn; } },
    },
    tabs: { query: async () => [{ id: 7, url: 'https://example.com/a' }] },
    scripting: {
      executeScript: async ({ func, args }) => {
        calls.scripts.push({ func, args });
        // grabPage/grabSelection stand in for the page realm.
        return [{ result: { url: 'https://example.com/a', title: 'A', html: '<p>hi</p>' } }];
      },
    },
    action: {
      setBadgeText: (v) => { calls.badge.push(v.text); },
      setBadgeBackgroundColor: () => {},
      setTitle: (v) => { calls.title.push(v.title); },
    },
  };
  chrome.runtime.onInstalled = { addListener: (fn) => { listeners.installed = fn; } };

  const sandbox = { chrome, fetch: fetchImpl, console: { error: () => {} }, setTimeout, clearTimeout, Date };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(EXT_ROOT, 'tab-stream', 'background.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'background.js' });
  return { listeners, calls, chrome };
}

// Ask the background for something over the popup bridge and await its reply.
function ask(listeners, msg) {
  return new Promise((resolve) => {
    listeners.message(msg, {}, resolve);
  });
}

const deadHub = () => { throw new TypeError('Failed to fetch'); };

test('a dead hub yields an actionable message naming the command, not "Failed to fetch"', async () => {
  const { listeners } = loadBackground({ fetchImpl: deadHub });
  const resp = await ask(listeners, { type: 'list-instances' });
  assert.equal(resp.ok, false);
  assert.equal(resp.code, 'hub-unreachable', 'typed so the popup can render a fix-it panel');
  assert.equal(resp.command, 'claude-web-chat open');
  assert.equal(resp.endpoint, 'http://localhost:5170', 'says WHAT was unreachable');
  assert.match(resp.error, /Can't reach the web-chat hub at http:\/\/localhost:5170/);
  assert.match(resp.error, /claude-web-chat open/);
  assert.doesNotMatch(resp.error, /Failed to fetch/, 'the raw transport error must not leak through');
});

test('the capture path reports the same actionable hub error', async () => {
  const { listeners } = loadBackground({ fetchImpl: deadHub });
  const resp = await ask(listeners, { type: 'capture' });
  assert.equal(resp.code, 'hub-unreachable');
  assert.match(resp.error, /claude-web-chat open/);
});

test('a right-click capture failure is reported on the badge, in the page, and in storage', async () => {
  const { listeners, calls } = loadBackground({ fetchImpl: deadHub });
  listeners.installed();
  await listeners.menu({ menuItemId: 'wc-capture' }, { id: 7 });
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(calls.badge.includes('!'), 'toolbar badge shows the failure');
  assert.ok(
    calls.title.some((t2) => /claude-web-chat open/.test(t2)),
    'the tooltip carries the actionable message',
  );
  const toast = calls.scripts.find((s) => /Tab failed/.test(String(s.args && s.args[0])));
  assert.ok(toast, 'a toast is injected into the page that was right-clicked');
  assert.equal(toast.args[1], false, 'styled as an error');
  const stored = calls.localSet.find((v) => v.lastResult);
  assert.ok(stored, 'the outcome is persisted for the popup to show later');
  assert.equal(stored.lastResult.ok, false);
  assert.equal(stored.lastResult.code, 'hub-unreachable');
});

test('a right-click capture SUCCESS is reported too', async () => {
  const okHub = async () => ({
    ok: true,
    json: async () => ({ ok: true, capture_id: 'c1', instance: { id: 'i1', title: 'demo' } }),
  });
  const { listeners, calls } = loadBackground({ fetchImpl: okHub });
  listeners.installed();
  await listeners.menu({ menuItemId: 'wc-capture' }, { id: 7 });
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(calls.badge.includes('✓'));
  const stored = calls.localSet.find((v) => v.lastResult);
  assert.ok(stored && stored.lastResult.ok, 'success recorded');
  assert.match(stored.lastResult.message, /demo/, 'names the instance it landed in');
});

// ------------------------------------------------- `claude-web-chat open` front door

const open = require('../lib/cli/commands/open');

function openDeps(overrides = {}) {
  const calls = { browsed: [], logs: [], errs: [], exits: [] };
  const deps = {
    launchBrowser: (u) => calls.browsed.push(u),
    log: (m) => calls.logs.push(m),
    errlog: (m) => calls.errs.push(m),
    exit: (c) => calls.exits.push(c),
    readPortfile: () => ({ port: 5999, url: 'http://localhost:5999' }),
    probeReachable: async () => true,
    spawnDaemonProcess: () => {},
    waitForPortfile: async () => ({ port: 5999, url: 'http://localhost:5999', pid: 1 }),
    ...overrides,
  };
  return { calls, deps };
}

test('`open extensions` opens the install page, not the surface root', async () => {
  const { calls, deps } = openDeps();
  await open(['extensions'], deps);
  assert.deepEqual(calls.browsed, ['http://localhost:5999/extensions']);
});

test('`open` with no target still opens the surface root', async () => {
  const { calls, deps } = openDeps();
  await open([], deps);
  assert.deepEqual(calls.browsed, ['http://localhost:5999']);
});

test('a cold start points at the extensions page — the only in-product mention', async () => {
  const { calls, deps } = openDeps({ readPortfile: () => null });
  await open([], deps);
  assert.ok(
    calls.logs.some((l) => /\/extensions$/.test(l)),
    `cold start must advertise the extensions page; logs were ${JSON.stringify(calls.logs)}`,
  );
});

test('an unknown open target is refused rather than silently opening the surface', async () => {
  const { calls, deps } = openDeps();
  await open(['bogus'], deps);
  assert.deepEqual(calls.browsed, [], 'nothing opened');
  assert.deepEqual(calls.exits, [1]);
  assert.match(calls.errs[0], /unknown open target/);
});

test('the popup renders the fix-it panel instead of echoing the error string', () => {
  const popupJs = fs.readFileSync(path.join(EXT_ROOT, 'tab-stream', 'popup.js'), 'utf8');
  const popupHtml = fs.readFileSync(path.join(EXT_ROOT, 'tab-stream', 'popup.html'), 'utf8');
  assert.match(popupJs, /hub-unreachable/, 'branches on the typed code');
  assert.match(popupJs, /claude-web-chat open/, 'names the command as a fallback');
  assert.match(popupJs, /showLastResult\(\)/, 'surfaces a context-menu outcome on open');
  assert.match(popupHtml, /id="fixit-cmd"/, 'the command has its own copyable element');
});
