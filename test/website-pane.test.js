// The `website` builtin's pane script, driven under jsdom the way the mount
// runtime drives it in the browser (attachAndExtract + runScripts, so the code
// under test is the shipped component.html byte-for-byte).
//
// What it pins is the decision the pane makes BEFORE it points its iframe
// anywhere: /api/embed-check is an advisory "will this frame?", and the daemon
// refuses to fetch a private target on a pane's behalf (the SSRF fence in
// lib/server/routes/embed.js). That refusal must not be painted as "could not
// reach this URL" — the browser can frame a local dev server perfectly well,
// and did until the fence landed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const mount = require('../public/mount-runtime.js');

const PANE = fs.readFileSync(
  path.join(__dirname, '..', 'templates', 'components', 'website', 'component.html'),
  'utf8',
);

// Mount the real component.html into a jsdom document. The pane body runs
// through `new Function`, so its free variables (document, location, fetch)
// resolve against the NODE globals — hence the swap-and-restore below.
function mountPane(t, { url, reply, replyDelay = 0 }) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost:5173/' });
  const saved = {
    window: global.window,
    document: global.document,
    location: global.location,
    CustomEvent: global.CustomEvent,
    fetch: global.fetch,
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.location = dom.window.location;
  global.CustomEvent = dom.window.CustomEvent;
  const calls = [];
  global.fetch = async (u) => {
    calls.push(String(u));
    if (replyDelay) await new Promise((r) => setTimeout(r, replyDelay));
    return { json: async () => reply };
  };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete global[k]; else global[k] = v;
    }
    dom.window.close();
  });

  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  const { root, scripts } = mount.attachAndExtract(host, PANE);
  const errors = [];
  mount.runScripts(root, scripts, mount.createStore({}), { url }, 'w1', (e) => errors.push(e));
  assert.deepEqual(errors.map((e) => e.message), [], 'the pane script must not throw at mount');
  return { root, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const frameSrc = (root) => root.getElementById('frame').getAttribute('src');
const sandboxOf = (root) => root.getElementById('frame').getAttribute('sandbox').split(/\s+/).sort();
const overlay = (root) => {
  const el = root.querySelector('.br-block .h');
  return el ? el.textContent : null;
};

// The daemon's answer for a target it will not dial itself.
const PRIVATE = {
  ok: false, blocked: false, reachable: false,
  reason: 'target is not a public host', code: 'private-target',
};

// Every one of these worked in 0.6.0 and none of them is matched by a literal
// prefix table: a name only the user's resolver knows about, a container name,
// a Tailscale CGNAT address, and an IPv6 unique-local literal.
for (const url of [
  'http://myapp.test/',
  'http://foo.local:8080/',
  'http://host.docker.internal:3000/',
  'http://100.101.102.103:5173/',
  'http://[fd7a:115c:a1e0::1]/',
]) {
  test(`a target the daemon will not fetch is framed anyway, not painted unreachable: ${url}`, async (t) => {
    const { root, calls } = mountPane(t, { url, reply: PRIVATE });
    await settle();
    assert.equal(calls.length, 1, 'the pane still asks — the server is the authority');
    assert.equal(overlay(root), null, 'no "could not reach" overlay');
    assert.equal(frameSrc(root), url, 'the browser is left to frame it, which it can');
    assert.equal(root.getElementById('frame').classList.contains('hidden'), false);
  });
}

test('a genuinely unreachable public target still says so', async (t) => {
  const { root } = mountPane(t, {
    url: 'https://example.com/',
    reply: { ok: false, blocked: false, reachable: false, reason: 'timeout', code: null },
  });
  await settle();
  assert.equal(overlay(root), 'could not reach this URL');
  assert.equal(frameSrc(root), null, 'nothing was framed');
});

test('a public target that refuses framing still gets the blocked message', async (t) => {
  const { root } = mountPane(t, {
    url: 'https://example.com/',
    reply: {
      ok: true, reachable: true, status: 200, finalUrl: 'https://example.com/',
      blocked: true, reason: 'X-Frame-Options: DENY',
    },
  });
  await settle();
  assert.equal(overlay(root), 'this site refuses to be embedded');
  assert.equal(root.querySelector('.br-block .reason').textContent, 'X-Frame-Options: DENY');
});

test('a frameable public target is framed at the final URL the check reports', async (t) => {
  const { root } = mountPane(t, {
    url: 'https://example.com/',
    reply: {
      ok: true, reachable: true, status: 200,
      finalUrl: 'https://example.com/landing', blocked: false, reason: null,
    },
  });
  await settle();
  assert.equal(overlay(root), null);
  assert.equal(frameSrc(root), 'https://example.com/landing');
});

test('localhost keeps its no-round-trip fast path', async (t) => {
  const { root, calls } = mountPane(t, {
    url: 'http://localhost:3000/',
    reply: { ok: false, reachable: false, reason: 'should never be asked' },
  });
  await settle();
  assert.deepEqual(calls, [], 'the obvious case needs no pre-check at all');
  assert.equal(frameSrc(root), 'http://localhost:3000/');
});

// security-website-javascript-url-remote-html: the frame is allow-same-origin, so
// a javascript:/data:/blob:/file: URL pointed at it runs in (or reads) the
// surface's own origin. Whoever supplies it — Claude's params, a remote viewer's
// spawn, the address bar — it is refused before anything is asked or framed, and
// the refusal offers no "try embed anyway", ↻ or ↗ route round it.
for (const url of [
  'javascript://%0aalert(document.domain)',
  'data:text/html,<script>alert(1)</script>',
  'blob:http://localhost:5173/0f0f',
  'file:///etc/passwd',
  'JaVaScRiPt://x%0aalert(1)',
]) {
  test(`a URL that is not a web page is refused outright: ${url.slice(0, 24)}`, async (t) => {
    const { root, calls } = mountPane(t, { url, reply: { ok: false, reachable: false, reason: 'x', code: null } });
    await settle();
    assert.deepEqual(calls, [], 'not even asked about');
    assert.equal(overlay(root), 'only web pages can be shown here');
    assert.equal(root.querySelector('.br-block .try'), null, 'no "try embed anyway"');
    assert.equal(frameSrc(root), null);
    root.getElementById('btn-refresh').click();
    assert.equal(frameSrc(root), null, '↻ has nothing to load');
  });
}

test('the address bar is held to the same rule', async (t) => {
  const { root } = mountPane(t, { url: '', reply: {} });
  root.getElementById('url-input').value = 'javascript://%0aalert(1)';
  root.getElementById('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle();
  assert.equal(overlay(root), 'only web pages can be shown here');
  assert.equal(frameSrc(root), null);
});

test('the daemon\'s unsupported-scheme answer, or a non-web final URL, is never framed', async (t) => {
  const refused = mountPane(t, {
    url: 'https://example.com/',
    reply: { ok: false, blocked: false, reachable: false, reason: 'only http', code: 'unsupported-scheme' },
  });
  await settle();
  assert.equal(overlay(refused.root), 'only web pages can be shown here');
  assert.equal(refused.root.querySelector('.br-block .try'), null);
  assert.equal(frameSrc(refused.root), null);
});

test('a final URL that is not a web page falls back to the checked one', async (t) => {
  const { root } = mountPane(t, {
    url: 'https://example.com/',
    reply: { ok: true, reachable: true, status: 200, finalUrl: 'javascript:alert(1)', blocked: false },
  });
  await settle();
  assert.equal(frameSrc(root), 'https://example.com/');
});

// R4-4: a page on the surface's own origin — above all the preview documents,
// which hold historical pane code and whose PREVIEW_CSP assumes the framer
// sandboxes them — is framed WITHOUT allow-same-origin, so it gets an opaque
// origin and cannot reach the chrome through parent/top. Another site keeps
// allow-same-origin (its own origin; its logins work).
const OWN = ['allow-forms', 'allow-popups', 'allow-scripts'];
const WEB = ['allow-forms', 'allow-popups', 'allow-same-origin', 'allow-scripts'];

for (const url of ['/preview/node/n1', '/preview/pane/n1/m1', 'http://localhost:5173/replay', '/']) {
  test(`a page on the surface's own origin is framed without allow-same-origin: ${url}`, async (t) => {
    const { root, calls } = mountPane(t, { url, reply: {} });
    await settle();
    assert.deepEqual(calls, [], 'our own origin needs no pre-check');
    assert.equal(frameSrc(root), url);
    assert.deepEqual(sandboxOf(root), OWN);
    root.getElementById('btn-refresh').click();
    assert.deepEqual(sandboxOf(root), OWN, '↻ keeps the sandbox');
  });
}

test('another origin keeps allow-same-origin — another site, or another port on this host', async (t) => {
  const web = mountPane(t, {
    url: 'https://example.com/',
    reply: { ok: true, reachable: true, status: 200, finalUrl: 'https://example.com/', blocked: false, reason: null },
  });
  await settle();
  assert.equal(frameSrc(web.root), 'https://example.com/');
  assert.deepEqual(sandboxOf(web.root), WEB);
  const dev = mountPane(t, { url: 'http://localhost:3000/', reply: {} });
  await settle();
  assert.deepEqual(sandboxOf(dev.root), WEB);
});

test('the sandbox follows the frame: own origin, then another site, then back', async (t) => {
  const { root } = mountPane(t, {
    url: '/preview/node/n1',
    reply: { ok: true, reachable: true, status: 200, finalUrl: 'https://example.com/', blocked: false, reason: null },
  });
  await settle();
  assert.deepEqual(sandboxOf(root), OWN);
  const go = async (u) => {
    root.getElementById('url-input').value = u;
    root.getElementById('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle();
  };
  await go('https://example.com/');
  assert.equal(frameSrc(root), 'https://example.com/');
  assert.deepEqual(sandboxOf(root), WEB);
  await go('/replay');
  assert.equal(frameSrc(root), '/replay');
  assert.deepEqual(sandboxOf(root), OWN);
});

for (const url of ['/api/store', '/API/Store', '/api', '/tunnel/setup', 'http://localhost:5173/api/graph', '/app/../api/store']) {
  test(`the surface's own API and setup launcher are refused, not framed: ${url}`, async (t) => {
    const { root, calls } = mountPane(t, { url, reply: {} });
    await settle();
    assert.deepEqual(calls, []);
    assert.equal(frameSrc(root), null, 'nothing was framed');
    assert.match(overlay(root), /own API is not a page/);
    root.getElementById('btn-refresh').click();
    assert.equal(frameSrc(root), null, '↻ has nothing to load');
  });
}

test('a check that lands on the surface\'s own API is refused too', async (t) => {
  const { root } = mountPane(t, {
    url: 'https://example.com/',
    reply: { ok: true, reachable: true, status: 200, finalUrl: 'http://localhost:5173/api/store', blocked: false },
  });
  await settle();
  assert.equal(frameSrc(root), null);
  assert.match(overlay(root), /own API is not a page/);
});

// The guardrail. The private-address predicate lives in exactly one place
// (lib/server/routes/embed.js); a pane cannot require it, so the only safe
// number of copies in the pane is zero. This fails the build if one grows back.
test('the pane carries no copy of the private-address predicate', () => {
  // Regex-escaped as it would be inside a pane-side matcher, so `169\.254`
  // counts as a mention of 169.254.
  const bare = PANE.replace(/\\/g, '');
  for (const literal of ['169.254', '192.168', '172.16', '100.64', '127.0.0', 'fc00', '::1']) {
    assert.equal(
      bare.includes(literal), false,
      `component.html mentions ${literal} — the server is the authority on private targets`,
    );
  }
});
