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
