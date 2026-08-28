// Conventions tripwire — the automated half of "one engine per concept". Each
// banned construct has a single eventual home;
// until the phase that extracts that home lands, today's occurrences are
// grandfathered by a per-file BASELINE and this test RATCHETS:
//
//   (a) no file may EXCEED its baseline (a new or grown occurrence fails — route
//       it through the engine instead of hand-rolling mechanism N+1); and
//   (b) no file may fall BELOW its baseline without lowering the number here (so a
//       consolidation phase that removes occurrences is forced to tighten the
//       ceiling in the same PR).
//
// Net effect: the ceiling can only ever move toward zero-outside-the-home; it can
// never silently grow. Counts are per-file substring counts (not file:line — line
// numbers drift with unrelated edits). test/ and test-support/ are intentionally
// NOT scanned by THESE patterns, so the harness may use raw http/ws/fetch; the
// five constructs that do have a single home inside test-support (the deadline
// poll, the SSE opener, the server boot, the hub boot) are ratcheted separately
// by test/harness-conventions.test.js.
//
// A pattern names either `roots` (scan these trees) or `files` (scan exactly
// these paths). The `files` form exists for a construct that is legitimate in
// most of the tree and must stay at zero in a few named places — a tree-wide
// ceiling there would be a permanent table of files whose baseline is "correct
// forever", which is a weaker contract than the one this file states.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

const PATTERNS = [
  {
    name: 'http.request(',
    // Two allowed homes: lib/client/ (the daemon HTTP client) and
    // lib/core/portfiles.js (the two liveness probes — core cannot import the
    // client, so they stay in the leaf). Phase 1 collapses the scattered copies
    // toward these; consumer entries below drop to 0 as they migrate.
    home: 'lib/client/ + lib/core/portfiles.js (Phase 1)',
    what: 'internal daemon HTTP client',
    roots: ['lib'],
    re: /http\.request\(/g,
    baseline: {
      'lib/client/index.js': 2,
      'lib/core/portfiles.js': 2,
    },
  },
  {
    name: 'os.homedir()',
    home: 'lib/core/paths.js (extracted in Phase 1)',
    what: 'building the ~/.web-chat state dir',
    roots: ['lib'],
    re: /os\.homedir\(\)/g,
    baseline: {
      'lib/core/paths.js': 1,
    },
  },
  {
    // Require a quoted first arg so the doc-comment in export.js that writes
    // `new Function(store, root, …)` (no quote) is not counted — only real
    // string-literal eval sites are.
    name: 'new Function(',
    home: 'the unified mount runtime — public/mount-runtime.js (Phase 4 ✅)',
    what: 'dynamic eval of pane/component <script> bodies',
    roots: ['lib', 'public'],
    re: /new Function\(\s*['"]/g,
    // Phase 4 single-sourced the mount runtime into public/mount-runtime.js — the
    // ONE remaining eval site. The three former copies (client, export, preview)
    // now consume the shared primitives and hold zero.
    baseline: {
      // Two eval sites, both here: runScripts (pane <script> bodies) and the
      // lazily-derived async constructor runSeed uses (a component's seed.js).
      'public/mount-runtime.js': 2,
    },
  },
  {
    // The OTHER spelling of dynamic eval, and the reason this pattern exists:
    // public/app/drawer.js built an AsyncFunction with
    // `Object.getPrototypeOf(async function(){}).constructor` to run a
    // component's seed.js. That is a second eval site in the window realm — the
    // exact thing the pattern above exists to prevent — and it sat there for the
    // life of the ratchet because the ratchet matched the literal text
    // `new Function('`. Matching the derivation spelling too means the next
    // person who reaches for it has to come here and say why.
    name: 'getPrototypeOf(async function',
    home: 'the unified mount runtime — public/mount-runtime.js (runSeed)',
    what: 'deriving the AsyncFunction constructor for dynamic eval',
    roots: ['lib', 'public'],
    re: /getPrototypeOf\(\s*async\s*function/g,
    baseline: {
      'public/mount-runtime.js': 1,
    },
  },
  {
    // The component-name grammar. A component name BECOMES A DIRECTORY, so this
    // literal is not a style rule — it is the containment rule that keeps a name
    // from carrying a separator out of the components dir, and it is paired with
    // the reserved builtin list in the same module. It was declared twice
    // (routes/components.js and packs/manifest.js) while the reserved list lived
    // somewhere neither of them shared, which is exactly how POST
    // /api/components ended up enforcing half the policy. A second copy is how
    // the halves come back.
    name: '/^[a-z][a-z0-9-]*$/ (the component-name grammar)',
    home: 'lib/core/names.js (COMPONENT_NAME_RE / isComponentName / assertComponentName)',
    what: 'deciding whether a name may become a component directory',
    roots: ['lib', 'public'],
    re: /\/\^\[a-z\]\[a-z0-9-\]\*\$\//g,
    baseline: {
      'lib/core/names.js': 1,
    },
  },
  {
    // The HTML escape chain, SPELLING ONE: a sequence of .replace() calls. It
    // always starts `.replace(/&/g` — the ampersand must go first or the escaper
    // double-escapes its own output — so that prefix is an exact fingerprint.
    // lib/server/export.js carried one of these privately until the engine
    // landed in lib/core/html.js.
    name: '.replace(/&/g',
    home: 'lib/core/html.js — `escapeHtml(s)`',
    what: 'hand-rolled HTML entity escaping (chain spelling)',
    roots: ['lib', 'public'],
    re: /\.replace\(\/&\/g/g,
    baseline: {
      'lib/core/html.js': 1,
      // NOT an HTML escaper, and deliberately not routed through one:
      // jsonForScript rewrites & to the JS `&` escape so a JSON blob
      // cannot break out of the <script> element carrying it. Different output,
      // different threat — escapeHtml would emit `&amp;` into JSON and corrupt
      // the payload.
      'lib/server/export.js': 1,
    },
  },
  {
    // The escape chain, SPELLING TWO — and the more common one in this tree: a
    // character-class replace against a lookup map,
    // `.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', … }[c]))`. The row above does
    // not match it at all, so for nine of the eleven copies that existed when
    // the engine landed, "copy N+1 fails the build" was simply not true. The
    // map's first entry is the fingerprint, in either quote style.
    //
    // What the baseline grandfathers, and why each entry is still there:
    //
    //   * public/app/esc.js IS the client-side home (it collapsed four copies
    //     with three different character sets), and it is a module the chrome
    //     imports. It escapes all five, same as lib/core/html.js.
    //   * the two builtin component templates. Their pane script is evaluated in
    //     the BROWSER by the mount runtime with no module scope — no import, no
    //     require — so neither home is reachable from one. They are pinned
    //     because they are the files users copy when authoring a component.
    //
    // The eight bundled capture profiles used to be here too. They are gone:
    // extractors and panes now get `esc` on their ctx (CTX_HELPERS in
    // lib/capture/profiles/index.js), which is the only mechanism a bundle
    // living outside the package has.
    name: "{ '&': '&amp;' } map",
    home: "lib/core/html.js (host) · public/app/esc.js (client) · the injected `esc` for capture profiles",
    what: 'hand-rolled HTML entity escaping (lookup-map spelling)',
    roots: ['lib', 'public', 'templates'],
    exts: ['.js', '.html'],
    re: /['"]&['"]\s*:\s*['"]&amp;['"]/g,
    baseline: {
      'public/app/esc.js': 1,
      'templates/components/file-editor/component.html': 1,
      'templates/components/git-dashboard/component.html': 1,
    },
  },
  {
    // The escaper, spelled as a DECLARATION rather than as its body. Both rows
    // above match a particular way of writing the replacement; this one matches
    // the name, so a copy that escapes a different character set, or builds the
    // map some other way, still trips it. It is the row that would have caught
    // the nine `esc` declarations across lib/capture the moment a tenth
    // appeared, regardless of how its author spelled the body.
    //
    // A capture profile takes `esc` off its ctx and a component template gets
    // the two entries explained above; nothing else in lib/ or public/ may
    // declare one.
    name: 'const esc = / function esc(',
    home: 'lib/core/html.js (host) · public/app/esc.js (client) · the injected `esc` for capture profiles',
    what: 'declaring a local HTML escaper instead of taking the shared one',
    roots: ['lib', 'public', 'templates'],
    exts: ['.js', '.html'],
    re: /(?:const|let|var)\s+esc\s*=|function\s+esc\s*\(/g,
    baseline: {
      'public/app/esc.js': 1,
      'templates/components/file-editor/component.html': 1,
      'templates/components/git-dashboard/component.html': 1,
    },
  },
  {
    // Hand-rolled path containment: `path.relative(...)` plus a `..` prefix
    // test. It is the wrong answer twice over — it says nothing about symlinks
    // (reads and writes follow them, so a link inside the fence walks out of
    // it), and it cannot be made right by adding a realpath call at one site
    // while the other copies keep the old shape. The tree had two; the last one
    // was templates/components/file-editor/service.js, which is why `templates`
    // is scanned here — a builtin service is host code the user approves once,
    // and its fence is exactly what they are approving.
    //
    // The one home is lib/core/paths: `isInside(parent, child)` for a path on
    // disk, `fence(parent, child)` for one you were handed and may be about to
    // create (services get that one injected as `ctx.fence`). The single
    // grandfathered occurrence IS the lexical half of `fence`.
    name: "startsWith('..' + path.sep)",
    home: 'lib/core/paths.js — isInside(parent, child) / fence(parent, child)',
    what: 'hand-rolled path containment',
    roots: ['lib', 'public', 'templates'],
    re: /startsWith\(\s*['"]\.\.['"]\s*\+\s*path\.sep/g,
    baseline: {
      'lib/core/paths.js': 1,
    },
  },
  {
    // Sending a signal to another process. There is exactly one legitimate
    // reason to reach for this in a general way — asking "is this pid alive"
    // (`kill(pid, 0)`), which is lib/core/portfiles.isPidAlive — and a short,
    // named list of places that deliberately deliver a SIGTERM.
    //
    // The pattern exists because ls.js re-declared the liveness probe three
    // lines under the import of the module that exports it, and the copy was
    // weaker (no numeric type guard, so a string pid coerced and could read as
    // alive). It then used that copy to gate a SIGTERM at whatever process held
    // a registry pid — a user-scope file that outlives every daemon. ls.js is at
    // zero now: the classification is lib/util/registry.rows() and the reaping is
    // lib/cli/reap.js, which stops a daemon by ASKING it (lib/cli/commands/stop)
    // and never signals a pid it has not heard answer for itself.
    //
    // The baselines below are counted as substrings, so the explanatory comments
    // in stop.js and restart.js (which quote the construct they replaced) are
    // included deliberately.
    name: 'process.kill(',
    home: 'lib/core/portfiles.js `isPidAlive` (liveness) · lib/cli/commands/stop.js (the one acknowledged-shutdown escalation)',
    what: 'probing or signalling another process',
    roots: ['lib'],
    re: /process\.kill\(/g,
    baseline: {
      // The one liveness predicate, `kill(pid, 0)`.
      'lib/core/portfiles.js': 1,
      // The stop engine: one SIGTERM escalation after an unacknowledged (or
      // wedged) shutdown request, plus the comment explaining why asking comes
      // first.
      'lib/cli/commands/stop.js': 2,
      // The hub bounce, and its CLI twin. These are the ONLY signal sites that
      // already gate on identity — they kill the pid /api/health reported, not a
      // pid read out of a file.
      'lib/util/hub.js': 1,
      'lib/cli/commands/hub.js': 1,
      // A comment quoting the hand-rolled kill restart dropped in favour of the
      // stop engine.
      'lib/cli/commands/restart.js': 1,
    },
  },
  {
    // Interactive terminal prompts. `init` needs to ask questions; `trust` and
    // `doctor` are the obvious next places one would grow. The thing that must
    // not happen is a SECOND prompt engine with its own idea of when to skip the
    // question — because the skip rule (no TTY / CI / --no-input / --yes) is the
    // only thing standing between this CLI and a process that blocks forever on
    // a closed stdin inside a hook or a pipeline.
    name: "require('node:readline",
    home: 'lib/cli/prompt.js (the one prompt engine)',
    what: 'interactive terminal prompts',
    roots: ['lib'],
    re: /require\(['"]node:readline/g,
    baseline: {
      'lib/cli/prompt.js': 1,
    },
  },
  {
    // The `--wc-*` token-key filter. It had three declarations on the host side
    // — theme.js's TOKEN_RE plus private copies in export.js and
    // routes/graph.js — each paired with its OWN strip set (`[{}<>;]`,
    // `[\n;{}<>]`, `[{}<]`), so the same token value came back different
    // depending on which copy cleared it, and the narrowest set was the one
    // baking tokens into a preview page. sanitizeTokens / tokenDecls in
    // lib/server/theme.js is the one home now.
    name: '/^--wc-[\\w-]+$/',
    home: 'lib/server/theme.js (TOKEN_RE + sanitizeTokens/tokenDecls)',
    what: 'the --wc-* design-token key filter',
    roots: ['lib'],
    re: /\^--wc-/g,
    baseline: {
      'lib/server/theme.js': 1,
      // Inside the export shell's BAKED inline script: that code runs in a
      // downloaded file with no server behind it, so it cannot require the
      // engine. The export's own server-side token path is on tokenDecls.
      'lib/server/export.js': 1,
    },
  },
  {
    // The tmp+rename idiom's fingerprint: a temp path carrying the pid. It
    // existed twice with two spellings — `${p}.${pid}.tmp` in lib/util/registry
    // and `${file}.tmp-${pid}` in lib/packs/store — which is exactly how the
    // three records that most needed it (graph node files, graph/_meta.json,
    // draft.json) ended up with no atomicity at all: there was no single thing
    // to adopt. Both spellings are matched, so reaching for either one now has
    // to come through here.
    name: 'a per-pid `.tmp` name (the tmp+rename idiom)',
    home: 'lib/core/fsjson.js — `writeJsonAtomic`',
    what: 'writing a durable record via a temp file + renameSync',
    roots: ['lib'],
    re: /\$\{process\.pid\}\.tmp|\.tmp-\$\{process\.pid\}/g,
    baseline: {
      'lib/core/fsjson.js': 1,
      // A DIFFERENT concept that happens to share the idiom, and it must not be
      // routed through the engine: symlinkAtomic swaps ~/.web-chat/current,
      // which is a symlink, not a JSON record — there is nothing to serialize
      // and the temp entry is created with symlinkSync. Same discipline, other
      // object.
      'lib/update/install-layout.js': 1,
    },
  },
  {
    // NOT a lib-wide ban: 8 of the ~35 writeFileSync sites in lib/ are
    // legitimately not JSON records (export HTML, capture sidecars,
    // component.html/seed.js/service.js, .gitignore, the empty disable markers),
    // so a lib-wide ceiling could never approach zero-outside-the-home the way
    // the contract at the top of this file promises.
    //
    // Scoped instead to the three files whose records the durable-JSON engine
    // was extracted FOR, each at a hard zero. Every writer in them — a graph
    // node file, graph/_meta.json, draft.json — is a durable record that a
    // crash mid-write used to be able to tear, and the reader of each one has a
    // recovery path that assumes it cannot happen twice. A new bare
    // writeFileSync here is the regression.
    name: 'writeFileSync( in the three durable-record files',
    home: 'lib/core/fsjson.js — `writeJsonAtomic`',
    what: 'writing a graph node, graph/_meta.json or draft.json',
    files: [
      'lib/server/graph.js',
      'lib/server/domain/turns.js',
      'lib/update/migrations/index.js',
    ],
    re: /writeFileSync\(/g,
    baseline: {},
  },
];

// ext === null collects every file (the NUL scan below needs .html/.json/.md too).
function walk(dir, acc, ext = '.js') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc, ext);
    else if (e.isFile() && (ext === null || e.name.endsWith(ext))) acc.push(p);
  }
  return acc;
}

function relPosix(abs) {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

// A pattern scans whole `roots`, or — when the construct has legitimate uses
// elsewhere in the tree and only a named set of files must stay at zero — an
// explicit `files` list. The two forms share the same ratchet below.
//
// `exts` defaults to .js. A pattern that also governs code living in .html (a
// component template's pane script, which is evaluated in the browser and so
// cannot import anything) says so explicitly — without it those files are simply
// invisible to the ratchet, which is how two hand-rolled escapers sat in
// templates/ unpoliced while the same construct was pinned everywhere else.
function census({ roots, files, re, exts = ['.js'] }) {
  const map = {};
  const targets = files
    ? files.map((f) => path.join(REPO_ROOT, f))
    : (roots || []).flatMap((r) => {
      const abs = path.join(REPO_ROOT, r);
      return fs.existsSync(abs) ? walk(abs, [], null).filter((f) => exts.some((e) => f.endsWith(e))) : [];
    });
  for (const f of targets) {
    if (files) assert.ok(fs.existsSync(f), `conventions: ${relPosix(f)} is listed in a pattern's \`files\` but does not exist — fix the list.`);
    const m = fs.readFileSync(f, 'utf8').match(re);
    if (m && m.length) map[relPosix(f)] = m.length;
  }
  return map;
}

for (const p of PATTERNS) {
  test(`conventions: \`${p.name}\` (${p.what}) is confined to its allowed home`, () => {
    const actual = census(p);

    // (a) tripwire — no new or grown occurrences.
    for (const [file, n] of Object.entries(actual)) {
      const allowed = p.baseline[file] || 0;
      assert.ok(
        n <= allowed,
        `${file} has ${n} \`${p.name}\` (baseline ${allowed}). This is a new/grown use of a banned construct — route it through ${p.home}. If it is genuinely unavoidable, raise the baseline in test/conventions.test.js with a justifying comment.`,
      );
    }

    // (b) ratchet — baseline must not be stale (a phase removed occurrences).
    for (const [file, n] of Object.entries(p.baseline)) {
      const cur = actual[file] || 0;
      assert.ok(
        cur >= n,
        `STALE baseline: ${file} now has ${cur} \`${p.name}\` but the baseline says ${n}. A consolidation removed occurrences — lower or remove this entry in test/conventions.test.js.`,
      );
    }
  });
}

// ── raw NUL bytes. A single 0x00 anywhere in a file makes git classify that file
// as binary for the rest of its life: `git diff`, `git log -p` and `git blame`
// all go silent on it, so changes land unreviewed and history is unreadable.
// lib/server/services.js did exactly this for the NUL that separates the three
// components of a service trust key — invisible in source, invisible in review.
// A NUL in a string is fine; it must be SPELLED as an escape (\0 or \u0000), which
// produces the identical byte while leaving the file text.
const NUL_ROOTS = ['lib', 'bin', 'public/app', 'templates'];

test('conventions: no source file carries a raw NUL byte (git would treat it as binary)', () => {
  const offenders = [];
  for (const r of NUL_ROOTS) {
    const abs = path.join(REPO_ROOT, r);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs, [], null)) {
      const buf = fs.readFileSync(f); // Buffer, not utf8 — a decode would hide the byte
      const at = buf.indexOf(0);
      if (at !== -1) offenders.push(`${relPosix(f)} (first at byte ${at})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `raw 0x00 byte(s) found — git will diff these files as binary. Spell the NUL as an escape (\\0 or \\u0000) instead; the string value is unchanged:\n  ${offenders.join('\n  ')}`,
  );
});

// ── the channel meta vocabulary is a locked, versioned contract. The wire only
// permits meta keys matching [A-Za-z0-9_] with string values;
// this tripwire asserts wakeEnvelope emits ONLY the declared vocabulary in that
// shape, and that sanitizeMeta enforces the charset/type on arbitrary input — so
// a drift in what the bridge would push fails the build.
const { wakeEnvelope, sanitizeMeta, META_KEYS } = require('../lib/channel/envelope');
const KEY_RE = /^[A-Za-z0-9_]+$/;

test('conventions: channel meta stays within the versioned vocabulary + wire shape', () => {
  // A batch exercising every meta-producing branch (single + mixed, capture +
  // signal, mount, ids, captures, note).
  const envelopes = [
    wakeEnvelope([{ id: 'q1', kind: 'capture', source: 'ext:tab-stream', capture_id: 'cap1', origin_mount: 'm1', summary: 's', seq: 3 }], { source: 'queue', seq: 7 }),
    wakeEnvelope([
      { id: 'q1', kind: 'capture', capture_id: 'cap1', summary: 'a', seq: 1 },
      { id: 'q2', kind: 'signal', origin_mount: 'm2', summary: 'b', seq: 2 },
    ], { source: 'queue', note: 'ctx' }),
    wakeEnvelope([], {}),
  ];
  for (const env of envelopes) {
    for (const [k, v] of Object.entries(env.meta)) {
      assert.ok(META_KEYS.includes(k), `meta key "${k}" is outside the versioned vocabulary ${JSON.stringify(META_KEYS)} — update CHANNELS meta contract + META_KEYS deliberately`);
      assert.ok(KEY_RE.test(k), `meta key "${k}" violates the [A-Za-z0-9_] wire charset`);
      assert.equal(typeof v, 'string', `meta value for "${k}" must be a string (got ${typeof v})`);
    }
  }
});

test('conventions: sanitizeMeta enforces the wire charset/type on arbitrary input', () => {
  const m = sanitizeMeta({ 'has-hyphen': 'v', 'spa ce': 'w', num: 42, bool: true, nul: null, empty: '', ok_1: 'x' });
  for (const [k, v] of Object.entries(m)) {
    assert.ok(KEY_RE.test(k), `sanitized key "${k}" must match [A-Za-z0-9_]`);
    assert.equal(typeof v, 'string', `sanitized value for "${k}" must be a string`);
  }
  assert.equal('has-hyphen' in m, false, 'raw hyphen key never survives');
  assert.equal(m.hashyphen, 'v', 'hyphen dropped from the key');
  assert.equal(m.num, '42', 'number coerced to string');
  assert.equal('nul' in m, false, 'nullish dropped');
  assert.equal('empty' in m, false, 'empty dropped');
});
