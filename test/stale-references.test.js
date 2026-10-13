// Words that outlive the code they describe (U110, tranche 6's tidy-up of
// tranche 5). U73 deleted the phone's stand-in (ruling B1 (a)) and wired the
// phone modules into main.js's boot, and U107 made `stop` stop every server
// rooted at the project — but comments, test headers and stop's help row went
// on describing the old tree. Three checks:
//
//   (a) a dangling-module tripwire: every bare <name>.js that a file in public/
//       names (public/*.js, public/app/*.js, public/index.html — comments
//       included) is a file tracked somewhere in the repository, by basename.
//       "Bare" is the pattern's: a name preceded by a word character, '.' or
//       '-' is a fragment of a longer one (x.test.js's "test.js"), never a
//       module, so the pattern skips it — no list of exceptions.
//   (b) a one-off pin of the phrases this unit retired, matched after
//       whitespace is normalised (index.html split one across a line break).
//       U94b may drop this pin once tranche 6 is accepted.
//   (c) `claude-web-chat help`'s stop row says what stop does since U107.
//   (d) the shipped chrome describes no later build (U116, tranche 7): the
//       stand-ins of the 2026-10-02 ruling went once every real thing had
//       registered, so no tracked file under public/, lib/ or templates/ says
//       "under development" (any case), "later 0.8.5 build" or "until tranche
//       4", after whitespace is normalised. test/ is not scanned: its absence
//       pins quote the phrase.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SELF = 'test/stale-references.test.js';

function tracked(...specs) {
  const r = spawnSync('git', ['ls-files', '-z', '--', ...specs], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ls-files: ${r.stderr}`);
  return r.stdout.split('\0').filter(Boolean);
}

// A module name standing on its own: not the tail of a longer dotted or
// hyphenated name, and not running on into one (".json", ".jsx").
const BARE_JS = /(?<![\w.-])([A-Za-z_][\w-]*\.js)(?![\w-])/g;

test('(a) every bare <name>.js named in public/ is a tracked file somewhere in the repository', () => {
  const basenames = new Set(tracked().map((f) => path.posix.basename(f)));
  const scanned = tracked('public').filter((f) => /^public\/(?:app\/)?[^/]+\.js$/.test(f) || f === 'public/index.html');
  assert.ok(scanned.includes('public/index.html') && scanned.includes('public/app/main.js'),
    'precondition: the scan reaches index.html and public/app/');
  const dangling = [];
  for (const f of scanned) {
    const lines = fs.readFileSync(path.join(REPO, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(BARE_JS)) {
        if (!basenames.has(m[1])) dangling.push(`${f}:${i + 1} names ${m[1]}`);
      }
    });
  }
  assert.deepEqual(dangling, [], 'a name in public/ that no tracked file carries describes code that is gone');
});

test('(a) the pattern: bare names match, fragments of longer names do not', () => {
  const names = (s) => [...s.matchAll(BARE_JS)].map((m) => m[1]);
  assert.deepEqual(names("import { x } from './chat-sheet.js';"), ['chat-sheet.js']);
  assert.deepEqual(names('see public/app/main.js and tab-dock.js.'), ['main.js', 'tab-dock.js']);
  assert.deepEqual(names('test/chat-sheet.test.js'), [], 'x.test.js is not a module named test.js');
  assert.deepEqual(names('lib.min.js, fixture.json, view.jsx'), []);
});

// Retired by U110. U94b may drop this pin once tranche 6 is accepted.
const RETIRED = ['until U73 wires', 'the stand-in above', 'stand-in (U22c'];
// A line break and the comment marker (// or *) that opens the next line read
// as one space, and so does every other run of whitespace.
const normalise = (s) => s.replace(/\s*\n\s*(?:\/\/+|\*(?!\/))?/g, ' ').replace(/\s+/g, ' ');

test('(b) the retired phrases appear nowhere under public/ or test/', () => {
  assert.equal(normalise('(the\n         stand-in above)'), '(the stand-in above)');
  assert.equal(normalise('until U73\n// wires them'), 'until U73 wires them');
  const hits = [];
  for (const f of tracked('public', 'test')) {
    if (f === SELF) continue;
    const text = normalise(fs.readFileSync(path.join(REPO, f), 'utf8'));
    for (const p of RETIRED) if (text.includes(p)) hits.push(`${f}: "${p}"`);
  }
  assert.deepEqual(hits, []);
});

test('(c) help: stop\'s row says it stops every server rooted at the project', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-stale-'));
  try {
    const r = spawnSync(process.execPath, [path.join(REPO, 'bin/claude-web-chat.js'), 'help'],
      { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
    const row = r.stdout.split('\n').find((l) => /^ {2}stop\s/.test(l));
    assert.ok(row, 'help prints a stop row');
    assert.doesNotMatch(row, /the running server/, 'stop no longer means one server');
    assert.match(row, /every one rooted here|every server rooted/, `stop's row: ${row}`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// U116: what a later build would bring is no longer on the page.
const LATER_BUILD = ['under development', 'later 0.8.5 build', 'until tranche 4'];

test('(d) no tracked file under public/, lib/ or templates/ describes a later build', () => {
  assert.equal(normalise('is under\n// Development').toLowerCase(), 'is under development');
  const files = tracked('public', 'lib', 'templates');
  assert.ok(files.includes('public/app/chat-bar.js') && files.includes('lib/server/mirror/index.js')
    && files.some((f) => f.startsWith('templates/')), 'precondition: the scan reaches public/, lib/ and templates/');
  const hits = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(REPO, f));
    if (buf.includes(0)) continue;   // an image or a font: no prose to say it
    const text = normalise(buf.toString('utf8')).toLowerCase();
    for (const p of LATER_BUILD) if (text.includes(p)) hits.push(`${f}: "${p}"`);
  }
  assert.deepEqual(hits, [], 'a fallback says what is true in this build, never what a later one brings');
});
