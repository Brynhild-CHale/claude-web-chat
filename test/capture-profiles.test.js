// Bundled-profile tier + fixture tests.
//
// Two concerns in one file:
//   1. The BUNDLED tier itself — profiles that ship in the package under
//      lib/capture/profiles/bundled/<name>/ load through the same machinery as
//      user profiles, keep matchers/panes/matched:true, sit below project+global
//      and above builtins in precedence, and are overridable by re-authoring.
//   2. Each bundled profile against a synthetic-but-representative HTML fixture
//      (test/fixtures/profiles/<name>.html) built to hit its REAL selectors —
//      asserting the distilled shape (keys present + non-empty, caps honored) and
//      that its pane renders non-empty HTML in both modes without throwing.
//
// Live-site drift stays a manual concern: when a site's DOM changes, re-capture
// the fixture. These tests catch OUR regressions in the extraction/pane code.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolate ~/.web-chat before any path is resolved so the user's real global
// profiles (the dogfood ~/.web-chat/profiles/{gmail,wikipedia,youtube}) can never
// shadow the BUNDLED copies these tests are meant to exercise. Paths are computed
// per-call (pure), so setting HOME here governs every resolvePaths/userPaths call.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-bundled-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const reg = require('../lib/capture/profiles');
const { defaultReduce } = require('../lib/server/routes/capture');
const { resolvePaths } = require('../lib/server/paths');

const FIXTURES = path.join(__dirname, 'fixtures', 'profiles');
function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, `${name}.html`), 'utf8');
}

// Load ONLY the bundled tier + builtins: point project + global at dirs that do
// not exist, so those tiers are empty and the bundled dir (package-static) is the
// only source of matcher-carrying profiles. getProfile('gmail') is then the
// bundled copy, not a user one.
function loadBundledOnly() {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-bundled-empty-'));
  return reg.loadUserProfiles({
    PROFILES_DIR: path.join(empty, 'project'),
    SYSTEM_PROFILES_DIR: path.join(empty, 'global'),
  });
}

// --- helpers for the project-override test (mirror profile-loader.test.js) ---
function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-bundled-root-'));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  return dir;
}
function putProfile(profilesDir, name, opts = {}) {
  const dir = path.join(profilesDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { name, description: opts.description || `${name} desc`, matchers: opts.matchers || [] };
  if (opts.pane) meta.pane = opts.pane;
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(meta));
  fs.writeFileSync(
    path.join(dir, 'extract.js'),
    opts.extractJs || `module.exports = ({ url }) => ({ kind: ${JSON.stringify(name)}, url });`,
  );
}

function nonEmpty(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

const BUNDLED_NAMES = ['gmail', 'wikipedia', 'youtube', 'reddit'];

// ---------------------------------------------------------------------------
// The bundled tier
// ---------------------------------------------------------------------------

test('bundled tier: the shipped profiles register with scope "bundled", matchers, and a pane', () => {
  loadBundledOnly();
  const listed = reg.listProfiles();
  for (const name of BUNDLED_NAMES) {
    const p = listed.find((x) => x.name === name);
    assert.ok(p, `${name} is loaded from the bundled dir`);
    assert.equal(p.scope, 'bundled', `${name} carries scope "bundled"`);
    assert.equal(p.has_pane, true, `${name} carries a capture pane`);
    assert.ok(Array.isArray(p.matchers) && p.matchers.length > 0, `${name} carries URL matchers`);
  }
});

test('bundled tier: a bundled match beats the builtin tables distiller and reports matched:true (Contract 7)', () => {
  loadBundledOnly();
  // The wikipedia fixture contains a <table class="infobox">, so the builtin
  // `tables` distiller would also match — the bundled profile must still win and,
  // unlike a builtin, must count as a match so the consent button is offered.
  const html = readFixture('wikipedia');
  const r = reg.resolve({ url: 'https://en.wikipedia.org/wiki/Red_panda', html });
  assert.equal(r.profile.name, 'wikipedia', 'bundled wins over builtin tables even with a <table> present');
  assert.equal(r.tier, 'bundled');
  assert.equal(r.matched, true, 'bundled match offers "Capture with wikipedia"');
});

test('bundled tier: an explicit hint to a bundled profile resolves matched:true across any URL', () => {
  loadBundledOnly();
  const r = reg.resolve({ url: 'https://unrelated.example/whatever', hint: 'youtube' });
  assert.equal(r.profile.name, 'youtube');
  assert.equal(r.tier, 'bundled');
  assert.equal(r.matched, true);
});

test('bundled tier: a project profile re-authoring a bundled name overrides it entirely', () => {
  const root = tmpRoot();
  const paths = resolvePaths(root); // HOME is FAKE_HOME → global tier empty
  putProfile(paths.PROFILES_DIR, 'gmail', {
    matchers: [{ type: 'regex', value: 'mail\\.google\\.com/mail/' }],
    extractJs: 'module.exports = () => ({ kind: "project-gmail" });',
  });
  reg.loadUserProfiles(paths);

  // Exactly one "gmail" — the project copy shadows the bundled one entirely.
  const gmails = reg.listProfiles().filter((p) => p.name === 'gmail');
  assert.equal(gmails.length, 1, 'no duplicate gmail entry');
  assert.equal(gmails[0].scope, 'project');

  const url = 'https://mail.google.com/mail/u/0/#inbox/x';
  const r = reg.resolve({ url });
  assert.equal(r.tier, 'project', 'project match dominates the bundled one');
  const out = reg.runProfile(r.profile, { url, html: '' });
  assert.equal(out.distilled.kind, 'project-gmail', 'the project extractor runs, not the bundled one');
});

// ---------------------------------------------------------------------------
// Per-profile fixture tests
// ---------------------------------------------------------------------------

const SPECS = {
  gmail: {
    url: 'https://mail.google.com/mail/u/0/#inbox/abc123',
    kind: 'email',
    // keys that must be present AND non-empty in the distilled payload
    required: ['subject', 'contacts', 'messages', 'attachments'],
    check(d) {
      assert.equal(d.messageCount, 2, 'both messages extracted');
      assert.equal(d.contacts.length, 2, 'both thread contacts collected');
      assert.ok(d.messages.every((m) => m.from && m.from.email && m.body), 'each message has sender + body');
      // The quoted reply-chain (.gmail_quote) and signature (.im) are stripped.
      const body = d.messages[0].body;
      assert.ok(!/QUOTED_HISTORY/.test(body), 'quoted reply-chain stripped from body');
      assert.ok(!/SIGNATURE/.test(body), 'signature block stripped from body');
      const att = d.attachments[0];
      assert.ok(att.filename && att.mime && att.url, 'attachment name/mime/link extracted');
    },
  },
  wikipedia: {
    url: 'https://en.wikipedia.org/wiki/Red_panda',
    kind: 'wikipedia',
    required: ['title', 'shortDescription', 'summaryHtml', 'infobox', 'sections', 'image'],
    check(d) {
      assert.ok(d.image && nonEmpty(d.image.src), 'primary image src extracted');
      assert.ok(d.infobox.facts.length >= 1, 'infobox facts extracted');
      // The fixture supplies five non-empty lead paragraphs; the extractor caps
      // the lead summary at three.
      assert.equal(d.summaryHtml.length, 3, 'lead-summary cap of 3 honored (from 5 paragraphs)');
      const titles = d.sections.map((s) => s.title);
      assert.ok(!titles.includes('References'), 'reference/nav sections dropped by the SKIP set');
      assert.ok(titles.includes('Description'), 'content sections kept');
    },
  },
  youtube: {
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    kind: 'youtube',
    required: ['videoId', 'title', 'channel', 'views', 'published', 'likes', 'thumbnail', 'description', 'links'],
    check(d) {
      assert.equal(d.videoId, 'dQw4w9WgXcQ', 'video id parsed from the URL');
      assert.ok(d.channel.name && d.channel.url, 'channel name + url extracted');
      assert.match(d.thumbnail, /i\.ytimg\.com/, 'thumbnail derived from the video id');
      assert.ok(d.links.some((l) => l.href === 'https://example.com/spotify'), '/redirect?q= link unwrapped');
      assert.ok(!d.links.some((l) => /youtube\.com\/@/.test(l.href)), 'left-nav channel link excluded');
      assert.ok(d.links.length <= 25, 'description-links cap respected');
    },
  },
  reddit: {
    url: 'https://www.reddit.com/r/aww/comments/abc123/red_panda_being_adorable/',
    kind: 'reddit',
    required: ['title', 'subreddit', 'author', 'titleHref', 'bodyHtml', 'image', 'comments'],
    check(d) {
      assert.equal(d.source, 'shreddit', 'the modern shreddit path ran');
      assert.equal(d.subreddit, 'r/aww', 'subreddit-prefixed-name normalized');
      assert.equal(d.author, 'u/panda_fan', 'author prefixed with u/');
      assert.ok(/^https?:\/\//.test(d.titleHref), 'titleHref is an absolute link to open the thread');
      assert.ok(nonEmpty(d.image.src) && /redd\.it/.test(d.image.src), 'primary image src extracted for the image post');
      assert.ok(
        d.bodyHtml.some((p) => /<a href="https:\/\/example\.com\/redpandas"/.test(p)),
        'self-text body link preserved',
      );
      // 6 top-level comments + 1 nested reply → cap keeps 5, nesting drops the reply.
      assert.equal(d.comments.length, 5, 'top-comment cap of 5 honored (from 6 top-level)');
      const authors = d.comments.map((c) => c.author);
      assert.ok(authors.includes('u/commenter5'), '5th top-level comment kept (cap boundary)');
      assert.ok(!authors.includes('u/nested_replier'), 'nested reply excluded from top-level comments');
      assert.ok(!authors.includes('u/commenter6'), '6th top-level comment dropped by the cap');
      assert.ok(
        d.comments.every((c) => c.author && c.text && c.permalink),
        'each comment carries author + text + permalink',
      );
      assert.ok(
        d.comments.every((c) => /^https?:\/\//.test(c.permalink)),
        'comment permalinks absolutized',
      );
    },
  },
};

for (const name of BUNDLED_NAMES) {
  const spec = SPECS[name];

  test(`bundled profile "${name}": fixture distills to the expected shape`, () => {
    loadBundledOnly();
    const html = readFixture(name);

    const r = reg.resolve({ url: spec.url, html });
    assert.equal(r.profile.name, name, 'the fixture URL resolves to this bundled profile');
    assert.equal(r.matched, true, 'bundled match reported');

    const out = reg.runProfile(r.profile, { url: spec.url, html });
    assert.equal(out.profile, name, 'the profile ran');
    assert.equal(out.fell_back_from, undefined, 'the extractor did not throw (no fallback to default)');

    const d = out.distilled;
    assert.equal(d.kind, spec.kind, 'distilled.kind');
    for (const key of spec.required) {
      assert.ok(nonEmpty(d[key]), `distilled.${key} is present and non-empty`);
    }
    spec.check(d);
  });

  test(`bundled profile "${name}": pane renders non-empty HTML in both modes without throwing`, () => {
    loadBundledOnly();
    const html = readFixture(name);
    const profile = reg.getProfile(name);
    const out = reg.runProfile(profile, { url: spec.url, html });

    const pane = profile.pane;
    assert.ok(pane && typeof pane.render === 'function', 'profile carries a renderable pane');

    // Reduced view is derived from the SAME distilled payload (Contract 6) via the
    // pane's own reduce(), or the platform default when a pane omits it.
    const reduced = pane.reduce ? pane.reduce(out.distilled) : defaultReduce(out.distilled);

    for (const mode of ['reduced', 'expanded']) {
      let rendered;
      assert.doesNotThrow(() => {
        rendered = pane.render(out.distilled, { reduced, mode });
      }, `pane.render did not throw in ${mode} mode`);
      assert.ok(
        typeof rendered === 'string' && rendered.trim().length > 0,
        `pane.render returned non-empty HTML in ${mode} mode`,
      );
    }

    // The pane declares a distinct expanded region, so the two modes really differ.
    const full = pane.render(out.distilled, { reduced, mode: 'expanded' });
    assert.match(full, /data-wc-when="expanded"/, 'pane declares an expanded-mode region');
  });
}

// ---------------------------------------------------------------------------
// reddit: the old.reddit fallback path distills to the same shape
// ---------------------------------------------------------------------------

test('bundled profile "reddit": old.reddit DOM distills to the same shape via the fallback path', () => {
  loadBundledOnly();
  const url = 'https://old.reddit.com/r/aww/comments/abc123/red_panda_being_adorable/';
  const html = readFixture('reddit-old');

  // old.reddit.com/r/<sub>/comments/ still resolves to the bundled reddit profile.
  const r = reg.resolve({ url, html });
  assert.equal(r.profile.name, 'reddit', 'old.reddit post URL resolves to the reddit profile');
  assert.equal(r.matched, true);

  const out = reg.runProfile(r.profile, { url, html });
  assert.equal(out.fell_back_from, undefined, 'old.reddit extraction did not throw (no fallback to default)');

  const d = out.distilled;
  assert.equal(d.kind, 'reddit');
  assert.equal(d.source, 'old.reddit', 'the old.reddit fallback path ran, not shreddit');
  assert.equal(d.subreddit, 'r/aww', 'data-subreddit-prefixed normalized');
  assert.equal(d.author, 'u/panda_fan', 'data-author prefixed with u/');
  assert.ok(/^https?:\/\//.test(d.titleHref), 'titleHref absolutized against old.reddit');
  assert.ok(d.image && /i\.redd\.it/.test(d.image.src), 'image derived from data-url');
  assert.ok(
    d.bodyHtml.some((p) => /example\.com\/redpandas/.test(p)),
    'self-text link preserved',
  );
  // 2 top-level comments + 1 nested reply → keep 2, drop the nested reply.
  assert.equal(d.comments.length, 2, 'two top-level comments (nested reply excluded)');
  const authors = d.comments.map((c) => c.author);
  assert.ok(!authors.includes('u/nested_old'), 'nested reply excluded from top-level comments');
  assert.ok(
    d.comments.every((c) => c.author && c.text && c.permalink),
    'each comment carries author + text + permalink',
  );
});
