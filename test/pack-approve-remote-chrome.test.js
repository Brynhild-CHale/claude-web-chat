// The element pack's Approve on its quarantine card, seen REMOTELY (annotation
// engine tranche 2, U322a; DECISIONS.md K.4 reading (iv): a user-tier approve
// stays host-only — the control's check refuses it for a non-host viewer "and
// the card says so").
//
// The companion of test/pack-approve-chrome.test.js, booted once
// (test-support/chrome-shell) as a REMOTE page: /api/health says remote and
// names an answer origin (test/overlay-report-remote-chrome.test.js's boot), so
// remote.js's remoteNow() is true for the whole file — it is asked once per
// page load, which is why this is its own file. The viewer is at `full`, so
// mayAct() holds and the control frame CAN be mounted: what keeps a frame that
// check() would refuse ('host-only') off a user-tier card is the card's own
// tier rule, which names the host's command instead. A project-tier element
// card beside it still mounts its frame, on the answer origin.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');

const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const AORIGIN = 'https://wc-0a1b2c3d-a.example.com';
const SHA = 'a'.repeat(40);

const elementQ = (name, tier) => ({
  name, version: '1.0.0', tier, description: 'Sticky notes on the surface.',
  source: { url: `https://example.test/acme/${name}`, via: 'tarball', sha: SHA },
  components: [], themes: [], services: [], skill: null, collisions: [], errors: [], warnings: [],
  elements: [{ name: 'sticky', schema: 'sticky@1', reads: ['sticky@1'], anchors: ['element', 'range'], draw: 'draw.js', files: ['element.json', 'draw.js'] }],
});

let shell, doc, drawer, S, R;
let rev = 500;
const access = { level: 'full', remote: true };
const packsBody = { ok: true, packs: [], quarantined: [elementQ('mark-all', 'system'), elementQ('mark-here', 'local')], pending: [] };

const snapshot = () => ({
  v: 1, enabled: true, now: Date.now(), rev: ++rev, content: true, access, capabilities: {},
  primary: null, aggregate: { state: 'idle' }, conversations: [], tasks: [], asks: [],
});

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/health': respond({ ok: true, remote: true }, { headers: { 'X-WC-Answer-Origin': AORIGIN } }),
      '/api/mirror': () => snapshot(),
      '/api/asks': () => ({ asks: [], answer: null }),
      '/api/packs': () => packsBody,
    },
  });
  doc = shell.document;
  drawer = await shell.importApp('drawer.js');
  S = await shell.importApp('chat-state.js');
  R = await shell.importApp('remote.js');
});

after(() => shell.restore());

const cardOf = (name) => [...doc.querySelectorAll('#drawer-manage .pk-card.pk-quarantined')]
  .find((c) => c.querySelector('.pk-name').textContent === name) || null;

test('a remote viewer at full: the user-tier element card says Approve it on the host with the command, and mounts no frame', async () => {
  const want = rev + 1;
  await shell.frame(helloFrame());
  await waitUntil(() => S.mirror.rev >= want && (S.mirror.access || {}).level === 'full', { timeout: 3000, what: 'the snapshot' });
  await waitUntil(() => R.remoteKnown(), { timeout: 3000, what: 'remote.js answered' });
  assert.equal(R.remoteNow(), true, 'booted as a remote page');

  await drawer.openDrawerManage();
  await waitUntil(() => cardOf('mark-all') && cardOf('mark-here'), { timeout: 3000, what: 'the quarantine cards' });
  await shell.tick();

  const all = cardOf('mark-all');
  assert.equal(all.querySelector('iframe'), null, 'no frame that check() would refuse as host-only');
  assert.match(all.textContent, /Approve it on the host/);
  assert.match(all.textContent, /Installing for all projects is the host’s to do/);
  assert.deepEqual([...all.querySelectorAll('.rn-cmd')].map((c) => c.textContent), ['claude-web-chat pack approve mark-all']);

  // The project tier is a remote full viewer's to approve: its frame mounts,
  // on the answer origin.
  const here = cardOf('mark-here');
  const frames = [...here.querySelectorAll('.pk-actions iframe.wc-answer-frame')];
  assert.equal(frames.length, 1, 'one confirm frame');
  const u = new URL(frames[0].src);
  assert.deepEqual([u.origin, u.pathname, u.searchParams.get('name'), u.searchParams.get('tier')],
    [AORIGIN, '/answer/control/pack-approve', 'mark-here', 'local']);
  assert.ok(!/Approve it on the host/.test(here.textContent));
});
