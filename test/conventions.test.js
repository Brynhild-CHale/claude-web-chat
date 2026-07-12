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
      'public/mount-runtime.js': 1,
    },
  },
];

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile() && e.name.endsWith('.js')) acc.push(p);
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
