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
// NOT scanned, so the harness may use raw http/ws/fetch.

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

function census(roots, re) {
  const map = {};
  for (const r of roots) {
    const abs = path.join(REPO_ROOT, r);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs, [])) {
      const m = fs.readFileSync(f, 'utf8').match(re);
      if (m && m.length) map[relPosix(f)] = m.length;
    }
  }
  return map;
}

for (const p of PATTERNS) {
  test(`conventions: \`${p.name}\` (${p.what}) is confined to its allowed home`, () => {
    const actual = census(p.roots, p.re);

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
