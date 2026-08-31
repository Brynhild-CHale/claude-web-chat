// The generic leaf helpers that were promoted into lib/core, and the facts that
// must stay single-sourced once they live there. Each of these had two or more
// homes before; this file is where "there is one, and it behaves like this" is
// written down, so a re-divergence fails a test rather than a review.

const test = require('node:test');
const assert = require('node:assert');

const { escapeHtml } = require('../lib/core/html');
const {
  CHANNEL_ENV, CHANNEL_ENV_VALUE, CHANNEL_NAME, LAUNCH_COMMAND,
} = require('../lib/core/channels');

// ── escapeHtml ──────────────────────────────────────────────────────────────

test('escapeHtml: the default escapes all five characters', () => {
  assert.equal(
    escapeHtml(`<a href="x" title='y'>&</a>`),
    '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
  );
});

test('escapeHtml: & is replaced first, so output is never double-escaped', () => {
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('escapeHtml: nullish renders as empty, not the literal "null"', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
});

test('escapeHtml: one mode, all five characters — safe in an attribute value', () => {
  assert.equal(escapeHtml(`it's <b>&</b> "q"`), `it&#39;s &lt;b&gt;&amp;&lt;/b&gt; &quot;q&quot;`);
  // There is no fewer-characters mode, and an options argument does not create
  // one: an escaper that is only safe in a text node is the defect the engine
  // exists to remove, and a mode nothing calls is a promise nothing keeps.
  assert.equal(escapeHtml(`it's "q"`, { quotes: false }), `it&#39;s &quot;q&quot;`);
});

test('escapeHtml: the capture reader render uses the engine, not a private copy', () => {
  const { simplifiedDocument } = require('../lib/capture/profiles/simplify');
  const doc = simplifiedDocument({ title: `Ivan's <script>`, url: 'https://x/y', bodyHtml: '<p>hi</p>' });
  assert.match(doc, /Ivan&#39;s &lt;script&gt;/, 'apostrophe and angle brackets both escaped');
  assert.equal(/<title>[^<]*<script/.test(doc), false);
});

test('escapeHtml: the old homes re-export the SAME function, not a copy', () => {
  assert.equal(require('../lib/server/util/html').escapeHtml, escapeHtml);
  assert.equal(require('../lib/server/export').htmlEscape, escapeHtml);
});

// ── isInside / realpath ─────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isInside, realpath } = require('../lib/core/paths');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir; // deliberately NOT realpath'd — that is what isInside is for
}

test('isInside: a directory is inside itself, and its existing children are', (t) => {
  const root = tmp(t, 'wc-inside-');
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, path.join(root, 'a', 'b')), true);
});

// The documented fail-closed edge, pinned because a caller that fences a path
// which does not exist YET (a file about to be written) will get `false` on any
// machine whose tmp/home is reached through a symlink — macOS $TMPDIR being the
// everyday case. isInside answers about the filesystem, not about strings; a
// caller that needs to fence a not-yet-existing path must check the lexical
// shape of the relative part separately (lib/packs does exactly that).
test('isInside: a child that does not exist under a symlinked parent fails CLOSED', (t) => {
  const base = fs.realpathSync(tmp(t, 'wc-inside-'));
  const real = path.join(base, 'real');
  const link = path.join(base, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  // Same directory, reached two ways. The parent resolves through the symlink;
  // the child cannot (it is not there to resolve), so the two disagree.
  assert.equal(isInside(link, path.join(link, 'not-created-yet')), false);
  assert.equal(isInside(real, path.join(real, 'not-created-yet')), true);
});

test('isInside: a traversal out is refused, even before it exists', (t) => {
  const root = tmp(t, 'wc-inside-');
  assert.equal(isInside(root, path.join(root, '..', 'elsewhere')), false);
  assert.equal(isInside(root, path.join(root, 'a', '..', '..', 'etc', 'passwd')), false);
  assert.equal(isInside(root, path.dirname(root)), false);
});

test('isInside: a sibling with the parent as a name PREFIX is not inside it', (t) => {
  const base = tmp(t, 'wc-inside-');
  const versions = path.join(base, 'versions');
  const backup = path.join(base, 'versions-backup');
  fs.mkdirSync(versions);
  fs.mkdirSync(backup);
  assert.equal(isInside(versions, backup), false);
});

test('isInside: a symlink pointing OUT of the parent resolves out and is refused', (t) => {
  const base = tmp(t, 'wc-inside-');
  const inside = path.join(base, 'inside');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(inside);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret'), 'x');
  fs.symlinkSync(path.join(outside, 'secret'), path.join(inside, 'link'));
  // Lexically `inside/link` is inside; by realpath it is not. The realpath
  // answer is the one a fence needs.
  assert.equal(isInside(inside, path.join(inside, 'link')), false);
});

test('isInside: a symlinked parent still matches its own real children', (t) => {
  const base = tmp(t, 'wc-inside-');
  const real = path.join(base, 'real');
  const link = path.join(base, 'link');
  fs.mkdirSync(path.join(real, 'child'), { recursive: true });
  fs.symlinkSync(real, link);
  assert.equal(isInside(link, path.join(real, 'child')), true);
  assert.equal(isInside(real, path.join(link, 'child')), true);
});

test('isInside: a missing side is never inside anything', () => {
  assert.equal(isInside('', '/tmp'), false);
  assert.equal(isInside('/tmp', ''), false);
  assert.equal(isInside(null, null), false);
});

test('realpath: returns null rather than throwing for a path that is not there', () => {
  assert.equal(realpath(path.join(os.tmpdir(), 'wc-definitely-not-here-9c1f')), null);
  assert.equal(realpath(os.tmpdir()), fs.realpathSync(os.tmpdir()));
});

test('isInside: the old home re-exports the SAME function, not a copy', () => {
  assert.equal(require('../lib/update/install-layout').isInside, isInside);
});

// The re-export is a compatibility shim with, right now, no consumer in lib/.
// It is also invisible to test/dependency-direction.test.js: install-layout and
// packs are both SHARED, and shared→shared is legal, so switching
// lib/packs/fetch.js back to `require('../update/install-layout').isInside`
// would reopen the exact sideways path this unit closed and pass every
// direction test. This is the check that notices — it is about WHERE isInside
// is imported from, which the direction rule cannot express.
test('isInside: nothing imports the predicate from the shim — core/paths is the home', () => {
  const LIB = path.resolve(__dirname, '..', 'lib');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && e.name.endsWith('.js')) files.push(f);
    }
  })(LIB);
  // Matched against the WHOLE file, not line by line. The old scan required the
  // require() and the name to share a source line, so the ordinary multi-line
  // destructure —
  //   const {
  //     isInside,
  //   } = require('../update/install-layout');
  // — slipped straight through the check whose entire job is to catch it. Three
  // spellings reach the shim's copy, and all three are the defect.
  // No backreference in REQ: it is spliced into three larger patterns where its
  // group number shifts, and a stale \1 silently stopped matching.
  const REQ = String.raw`require\(\s*['"][^'"]*install-layout(?:\.js)?['"]\s*\)`;
  const NAMES = String.raw`isInside|realpath`;
  const SPELLINGS = [
    // const { … isInside … } = require('…install-layout')  — newlines and all
    new RegExp(String.raw`\{[^{}]*\b(?:${NAMES})\b[^{}]*\}\s*=\s*${REQ}`),
    // require('…install-layout').isInside
    new RegExp(`${REQ}\\s*\\.\\s*(?:${NAMES})\\b`),
  ];
  const offenders = [];
  for (const f of files) {
    if (f.endsWith(path.join('update', 'install-layout.js'))) continue; // the shim itself
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(LIB, f);
    for (const re of SPELLINGS) {
      const m = src.match(re);
      if (m) offenders.push(`${rel}: ${m[0].replace(/\s+/g, ' ')}`);
    }
    // const layout = require('…install-layout')  …later…  layout.isInside(…).
    // Not a blanket "file mentions both": lib/cli/commands/update.js legitimately
    // requires the shim and says "realpath" in a comment about Node's cache.
    const alias = src.match(new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${REQ}`));
    if (alias) {
      const use = src.match(new RegExp(String.raw`\b${alias[1]}\s*\.\s*(?:${NAMES})\b`));
      if (use) offenders.push(`${rel}: ${use[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `isInside/realpath live in lib/core/paths — import them from there, not through the install-layout shim:\n  ${offenders.join('\n  ')}`);
});

// ── fence ───────────────────────────────────────────────────────────────────

const { fence, nearestExisting } = require('../lib/core/paths');

test('fence: a path that does not exist yet, under a symlinked parent, is allowed', (t) => {
  // The everyday save: a new file in a new directory, under a $TMPDIR that is
  // itself a link on macOS. This is the case `isInside` alone gets wrong, and
  // the reason `fence` exists at all.
  const root = tmp(t, 'wc-fence-new-');
  assert.equal(fence(root, 'notes/a.txt'), path.join(root, 'notes', 'a.txt'));
  assert.equal(fence(root, '.'), path.resolve(root));
});

test('fence: a lexical traversal out is refused whether or not it exists', (t) => {
  const root = tmp(t, 'wc-fence-lex-');
  assert.equal(fence(root, '../elsewhere.txt'), null);
  assert.equal(fence(root, 'a/../../etc/passwd'), null);
  assert.equal(fence(root, path.join(os.tmpdir(), 'absolute.txt')), null);
  assert.equal(fence('', 'a.txt'), null, 'no parent is no fence');
});

test('fence: a symlink resolving out of the parent is refused', (t) => {
  const root = tmp(t, 'wc-fence-link-');
  const outside = tmp(t, 'wc-fence-out-');
  fs.writeFileSync(path.join(outside, 'passwd'), 'secret\n');
  fs.symlinkSync(path.join(outside, 'passwd'), path.join(root, 'link.txt'));
  fs.symlinkSync(outside, path.join(root, 'linkdir'));
  assert.equal(fence(root, 'link.txt'), null);
  assert.equal(fence(root, 'linkdir'), null);
  assert.equal(fence(root, 'linkdir/passwd'), null);
});

// The half a following walk cannot see. `existsSync` follows links, so a link
// whose target is MISSING reads as "nothing there yet" — the anchor walk steps
// over it, lands on the root, and answers "inside". The caller then writes, and
// the write lands at the target: a file created outside the fence, by a path
// the fence approved. git commits symlinks, so this is a link a repository can
// ship. The anchor is found by lstat for exactly this.
test('fence: a DANGLING symlink inside the parent is refused, not read as absent', (t) => {
  const root = tmp(t, 'wc-fence-dangle-');
  const outside = tmp(t, 'wc-fence-dangle-out-');
  fs.symlinkSync(path.join(outside, 'new.txt'), path.join(root, 'dangling.txt'));
  fs.symlinkSync(path.join(outside, 'nodir'), path.join(root, 'dangdir'));

  assert.equal(fence(root, 'dangling.txt'), null, 'a dangling leaf link is not a free filename');
  assert.equal(fence(root, 'dangdir/new.txt'), null, 'nor is a dangling link in the middle of the path');
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false, 'and nothing was created outside');

  // A dangling link that points back INSIDE the fence is refused on the same
  // rule: we cannot resolve it, so we do not vouch for where a write lands.
  fs.symlinkSync(path.join(root, 'inner.txt'), path.join(root, 'dangling-in.txt'));
  assert.equal(fence(root, 'dangling-in.txt'), null);
});

test('nearestExisting: the two walks differ on exactly the dangling link', (t) => {
  const root = tmp(t, 'wc-anchor-');
  const outside = tmp(t, 'wc-anchor-out-');
  const link = path.join(root, 'dangling.txt');
  fs.symlinkSync(path.join(outside, 'nope'), link);

  // Following (the default, what lib/packs/tree.js wants): the link is absent,
  // so the anchor is its parent. By lstat (what `fence` wants): it is there.
  assert.equal(nearestExisting(link), path.resolve(root));
  assert.equal(nearestExisting(link, { follow: false }), path.resolve(link));

  // Everything else agrees: a plain missing tail anchors at the deepest real dir.
  const missing = path.join(root, 'a', 'b', 'c.txt');
  assert.equal(nearestExisting(missing), path.resolve(root));
  assert.equal(nearestExisting(missing, { follow: false }), path.resolve(root));
});

// ── the Node floor ──────────────────────────────────────────────────────────

const { NODE_FLOOR, checkNodeFloor } = require('../lib/core/versions');
const { nodeFloorMessage } = require('../lib/cli/commands/init');

test('the Node floor is ONE number: core, package.json engines and install.sh agree', () => {
  const REPO = path.resolve(__dirname, '..');

  const engines = require('../package.json').engines.node;
  const enginesFloor = parseInt(String(engines).replace(/[^\d.]/g, '').split('.')[0], 10);
  assert.equal(enginesFloor, NODE_FLOOR,
    `package.json engines says "${engines}" but lib/core/versions NODE_FLOOR is ${NODE_FLOOR}`);

  // install.sh cannot require() anything, so its copy of the number is a shell
  // literal. It is the FIRST gate a new user meets; it must not be the one that
  // disagrees.
  const sh = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8');
  const m = sh.match(/node_major"?\s*-lt\s+(\d+)/);
  assert.ok(m, 'install.sh no longer has a `-lt <major>` Node gate — did it move?');
  assert.equal(parseInt(m[1], 10), NODE_FLOOR,
    `install.sh refuses below ${m[1]} but lib/core/versions NODE_FLOOR is ${NODE_FLOOR}`);
});

test('checkNodeFloor: parses the running-version shapes it is handed', () => {
  assert.equal(checkNodeFloor('22.0.0').ok, true);
  assert.equal(checkNodeFloor('v24.3.1').ok, true);
  assert.equal(checkNodeFloor('21.7.3').ok, false);
  assert.equal(checkNodeFloor('20.0.0').major, 20);
  assert.equal(checkNodeFloor('nonsense').ok, false, 'an unparseable version fails closed');
  assert.equal(checkNodeFloor().ok, true, 'this suite is running on a supported Node');
});

test('init refuses Node below the floor, and says which floor and why', () => {
  assert.equal(nodeFloorMessage('24.1.0'), null);
  assert.equal(nodeFloorMessage(String(NODE_FLOOR) + '.0.0'), null);

  // The regression this closes: 18 through 21 used to print a green tick here.
  for (const v of ['18.20.4', '20.11.1', '21.7.3']) {
    const msg = nodeFloorMessage(v);
    assert.ok(msg, `init must refuse Node ${v}`);
    assert.match(msg, new RegExp(`Node ${NODE_FLOOR} or newer`));
    assert.match(msg, /require\(esm\)/, 'the message names the reason, not just the number');
    assert.ok(!/Node 18 or newer/.test(msg), 'the stale floor is gone from the message');
  }
});

// ── the repo slug ───────────────────────────────────────────────────────────

const versions = require('../lib/core/versions');

test('the repo slug is ONE fact: every URL the program prints is built from it', () => {
  assert.equal(require('../lib/update/release').REPO_SLUG, versions.REPO_SLUG);
  assert.equal(require('../lib/update/check').RELEASES_PAGE, versions.RELEASES_PAGE);

  for (const u of [versions.REPO_URL, versions.RELEASES_PAGE, versions.DOCS_URL,
    versions.INSTALL_SH_URL, versions.releaseTagUrl('v1.2.3')]) {
    assert.ok(u.includes(versions.REPO_SLUG), `${u} does not carry the slug`);
  }
  assert.equal(versions.releaseTagUrl('v1.2.3'), `${versions.REPO_URL}/releases/tag/v1.2.3`);
});

test('no source file under lib/ hardcodes the repo slug except its one home', () => {
  const LIB = path.join(path.resolve(__dirname, '..'), 'lib');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!e.name.endsWith('.js')) continue;
      const n = (fs.readFileSync(f, 'utf8').match(/Brynhild-CHale\/claude-web-chat/g) || []).length;
      if (n) offenders.push(`lib/${path.relative(LIB, f)} (${n})`);
    }
  };
  walk(LIB);
  // The one home. Anything else is a URL that would ignore WEB_CHAT_REPO — the
  // failure this consolidated: `update` downloaded from the override while the
  // very next line told the user to curl the original repo's install.sh.
  assert.deepEqual(offenders, ['lib/core/versions.js (1)']);
});

// ── channels: the launch incantation ────────────────────────────────────────
//
// Single-sourcing the string is only half the guarantee: install, init, doctor
// and the queue rail all print whatever lib/core/channels says, so a wrong
// string is wrong in four places at once. The audited regression was a
// `--dangerously-load-development-channels` with no channel argument — a flag
// that parses, runs, and activates nothing. Nothing in the suite named the
// argument, so re-dropping it was invisible. It is named here.

test('channels: LAUNCH_COMMAND loads the channel by name, not a bare flag', () => {
  assert.equal(CHANNEL_NAME, 'server:web-chat');
  assert.ok(
    LAUNCH_COMMAND.endsWith(`--dangerously-load-development-channels ${CHANNEL_NAME}`),
    `the flag takes the channel to load; without it the command is inert: ${LAUNCH_COMMAND}`,
  );
});

test('channels: LAUNCH_COMMAND is composed from the env constants it exports', () => {
  assert.equal(
    LAUNCH_COMMAND,
    `${CHANNEL_ENV}=${CHANNEL_ENV_VALUE} claude --dangerously-load-development-channels ${CHANNEL_NAME}`,
  );
  assert.ok(LAUNCH_COMMAND.startsWith('WEB_CHAT_CHANNEL=1 claude '),
    'the env opt-in and the binary are what a user copies verbatim');
});
