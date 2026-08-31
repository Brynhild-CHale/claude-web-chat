// Doc truth — every claim a shipped doc makes that a machine can check.
//
// The docs are not decoration. `claude-web-chat docs <name>` prints any file in
// docs/ verbatim to the user AND to Claude; the daemon's install page links the
// extension READMEs; the managed templates are pushed into every consumer
// project; CLAUDE.md is in Claude's context from session start. A wrong sentence
// in any of them is acted on, and prose has no compiler — `claude-web-chat
// watch` outlived the feature it named, the `wait_for` tool outlived its own
// deletion in three places, and CLAUDE.md documented a route `ctx` with two keys
// the bus refactor had removed.
//
// So: one file, one walked doc set (test-support/doc-truth.js `docFiles()`), one
// reader per truth source, and one allowlist that is itself asserted in the
// inverse direction. Only claim classes with MEASURED signal live here — a check
// that fires on nothing but false positives is worse than no check, because
// every entry its allowlist grows is a place this test has been weakened.
// Deliberately NOT here: a generic `lib/…` path-token extractor (21 false
// positives, 0 true ones — the doc defects that recur are stale identifiers
// BESIDE correct paths, which no existence check can see).

const test = require('node:test');
const assert = require('node:assert');

const {
  read,
  docFiles,
  flatten,
  cliCommands,
  mcpTools,
  toolDescriptions,
  ctxKeys,
  patternNames,
  routePaths,
  routeIsMounted,
  ALLOW,
} = require('../test-support/doc-truth');

const DOCS = docFiles();
const allowFor = (kind, rel, claim) =>
  (ALLOW[kind] || []).find((e) => e.rel === rel && e.claim === claim);

test('the doc set covers every surface a claim ships on', () => {
  const rels = DOCS.map((d) => d.rel);
  for (const needed of [
    'CLAUDE.md',
    'README.md',
    'docs/extending.md',
    'templates/rules/web-chat.md',
    '.claude/rules/web-chat.md',
    'extensions/tab-stream/README.md',
    'examples/run-tests.js',
  ]) {
    assert.ok(rels.includes(needed), `docFiles() no longer walks ${needed}`);
  }
  assert.ok(!rels.includes('CHANGELOG.md'), 'the CHANGELOG quotes historical wrong states on purpose');
});

// ---------------------------------------------------------------------------
// MCP tools.

// A snake_case name in backticks is usually a store key, not a tool — so this
// fires only where the surrounding words present it AS a tool ("the `x` tool",
// "call `x`", "Claude can `x`"). Measured: 4 true hits (all `wait_for`), zero
// false ones. Broadening it to every backticked snake_case token would drag in
// 26 store keys and turn this into an allowlist.
const TOOL = '([a-z][a-z0-9]*(?:_[a-z0-9]+)+)';
const TOOL_CUES = [
  new RegExp('`' + TOOL + '`\\s+(?:MCP\\s+)?tool', 'g'),
  new RegExp('(?:MCP )?tools?\\s+`' + TOOL + '`', 'g'),
  new RegExp('Claude\\s+(?:can|to|will|should|must|may)(?:\\s+(?:also|then|just|now))?\\s+`' + TOOL + '`', 'g'),
  new RegExp('(?:call|calls|calling|invoke|invokes)\\s+`' + TOOL + '`', 'g'),
];

test('every MCP tool a doc tells someone to call is registered', () => {
  const tools = new Set(mcpTools());
  for (const { rel, body } of DOCS) {
    const flat = flatten(body);
    for (const re of TOOL_CUES) {
      for (const m of flat.matchAll(re)) {
        const name = m[1];
        if (tools.has(name)) continue;
        const allowed = allowFor('mcpTool', rel, name);
        assert.ok(allowed, `${rel} presents \`${name}\` as an MCP tool, but lib/mcp/tools/${name}.js does not exist`);
        if (allowed.marker) {
          assert.ok(allowed.marker.test(flat),
            `${rel} may name the unavailable tool \`${name}\` only where it says so (${allowed.reason})`);
        }
      }
    }
  }
});

test('the rules files list exactly the registered MCP tools', () => {
  const tools = mcpTools();
  const listing = DOCS.filter((d) => /rules\/web-chat\.md$/.test(d.rel));
  assert.ok(listing.length >= 1, 'the rules file should be in the doc set');
  for (const { rel, body } of listing) {
    const line = flatten(body).match(/\*\*MCP tools\*\*[^:]*:([^.]+)\./);
    assert.ok(line, `${rel} no longer carries the "**MCP tools**: …" listing Claude reads at session start`);
    const named = [...line[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort();
    assert.deepEqual(named, tools, `${rel}'s tool listing has drifted from lib/mcp/tools/`);
  }
});

test('every "<n> MCP tools" count in the docs equals the number registered', () => {
  const n = mcpTools().length;
  let found = 0;
  for (const { rel, body } of DOCS) {
    for (const m of flatten(body).matchAll(/(\d+) MCP tools/g)) {
      found++;
      assert.equal(Number(m[1]), n, `${rel} says "${m[1]} MCP tools"; lib/mcp/tools/ holds ${n}`);
    }
  }
  assert.ok(found >= 3, 'the tool count is stated in several docs — the extractor should still find them');
});

// ---------------------------------------------------------------------------
// HTTP routes.

test('every /api/ route a doc cites is mounted', () => {
  const routes = routePaths();
  for (const { rel, body } of DOCS) {
    // Require at least one segment after /api/ so prose like "contains no
    // `/api/`" is not read as a citation.
    for (const m of body.matchAll(/\/api\/[A-Za-z0-9_:<>{}./-]*[A-Za-z0-9_>}]/g)) {
      const cited = m[0].replace(/[.,)\]]+$/, '');
      if (routeIsMounted(cited, routes)) continue;
      const allowed = allowFor('route', rel, cited);
      assert.ok(allowed, `${rel} cites \`${cited}\`, which no route file mounts`);
      if (allowed.marker) {
        assert.ok(allowed.marker.test(flatten(body)),
          `${rel} may cite the unbuilt \`${cited}\` only where it says so (${allowed.reason})`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// CLI commands.
//
// Prose may DISCUSS a command that no longer exists, but not as a live
// backticked instruction — that is how `claude-web-chat watch` outlived the
// feature it named. A command that is designed but not yet built may be cited
// (the pack format was specified ahead of its tooling on purpose), but only via
// an ALLOW entry, and the inverse test below fails the moment it ships.

test('every `claude-web-chat <sub>` cited in a doc is a real CLI command', () => {
  const known = new Set([...cliCommands(), 'help']);
  for (const { rel, body } of DOCS) {
    for (const m of body.matchAll(/`claude-web-chat ([a-z][a-z-]*)/g)) {
      if (known.has(m[1])) continue;
      const allowed = allowFor('cliCommand', rel, m[1]);
      assert.ok(allowed, `${rel} cites \`claude-web-chat ${m[1]}\`, which is not a registered command`);
      if (allowed.marker) {
        assert.ok(allowed.marker.test(flatten(body)),
          `${rel} may cite the unbuilt \`${m[1]}\` only where it says so (${allowed.reason})`);
      }
    }
  }
});

test('every `claude-web-chat docs <name>` cited in a doc resolves to a bundled doc', () => {
  const bundled = new Set(DOCS.filter((d) => d.rel.startsWith('docs/')).map((d) => d.rel.slice(5, -3)));
  let cited = 0;
  for (const { rel, body } of DOCS) {
    for (const m of body.matchAll(/claude-web-chat docs ([a-z0-9-]+)/g)) {
      cited++;
      assert.ok(bundled.has(m[1]), `${rel} cites \`claude-web-chat docs ${m[1]}\` but docs/${m[1]}.md does not exist`);
    }
  }
  assert.ok(cited >= 3, 'the rules point Claude at the contract docs by name — those citations went missing');
});

// The other direction: a command the user is expected to reach for has to be
// discoverable somewhere other than `--help`. `trust` — the ONLY way to approve
// a component's service — and `ls` both shipped documented nowhere at all.
test('the README command reference matches the CLI, in both directions', () => {
  const readme = read('README.md');
  const block = readme.match(/```\n(open {2,}[\s\S]*?)```/);
  assert.ok(block, 'README no longer carries the plain command-reference block');
  const listed = [];
  for (const line of block[1].split('\n')) {
    // `open`, `stop | restart`, `trust [name]`, `ls [--reap]` — a name, optional
    // alternatives, an optional argument placeholder, then the description.
    const m = line.match(/^([a-z][a-z-]*(?: \| [a-z][a-z-]*)*)(?: \[[^\]]*\])?\s{2,}\S/);
    if (m) listed.push(...m[1].split(' | '));
  }

  const known = cliCommands();
  const seen = new Set();
  for (const name of listed) {
    assert.ok(known.includes(name), `the README command block lists \`${name}\`, which the CLI does not register`);
    assert.ok(!seen.has(name), `the README command block lists \`${name}\` twice — one of the two rows is stale`);
    seen.add(name);
  }

  const exempt = new Map(ALLOW.readmeBlock.map((e) => [e.claim, e.reason]));
  for (const name of known) {
    if (exempt.has(name)) continue;
    assert.ok(seen.has(name), `\`claude-web-chat ${name}\` is missing from the README command block`);
  }
  for (const [name, reason] of exempt) {
    assert.ok(known.includes(name), `README exemption for \`${name}\` (${reason}) names a command the CLI no longer has`);
    assert.ok(!seen.has(name), `\`${name}\` is in the README command block now — drop its exemption (${reason})`);
  }
});

// ---------------------------------------------------------------------------
// The inverse of every allowlist: a permitted-unbuilt claim must still be
// unbuilt. Without this the map rots exactly as PLANNED did — `pack` stayed
// listed as an unbuilt command for the whole life of the shipped pack tooling,
// which silently exempted its doc from the check it was supposed to be under.

test('nothing on the allowlist has quietly shipped', () => {
  const tools = new Set(mcpTools());
  for (const e of ALLOW.mcpTool) {
    assert.ok(!tools.has(e.claim),
      `\`${e.claim}\` is a registered MCP tool now — drop its allowlist entry (${e.reason})`);
  }
  const routes = routePaths();
  for (const e of ALLOW.route) {
    assert.ok(!routeIsMounted(e.claim, routes),
      `\`${e.claim}\` is mounted now — drop its allowlist entry (${e.reason})`);
  }
  const known = new Set(cliCommands());
  for (const e of ALLOW.cliCommand) {
    assert.ok(!known.has(e.claim),
      `\`claude-web-chat ${e.claim}\` is registered now — drop its allowlist entry (${e.reason})`);
  }
});

// ---------------------------------------------------------------------------
// The per-project port.

test('no shipped doc hardcodes localhost:5173', () => {
  for (const { rel, body } of DOCS) {
    assert.ok(
      !/localhost:5173/.test(body),
      `${rel} hardcodes localhost:5173 — the port is per-project and walks upward, so that URL is wrong for ` +
      'every project after the first. Say `claude-web-chat open` (or `status`) instead.'
    );
  }
});

// ---------------------------------------------------------------------------
// The route ctx.

test('CLAUDE.md describes the ctx that route files actually receive', () => {
  const body = read('CLAUDE.md');
  const m = body.match(/`ctx = \{([^}]*)\}`/);
  assert.ok(m, 'CLAUDE.md no longer states the route ctx shape — it is the contract a new route is coded against');
  const documented = m[1].split(',').map((s) => s.trim().replace(/`/g, '')).filter(Boolean).sort();
  assert.deepEqual(documented, ctxKeys().slice().sort(),
    'CLAUDE.md\'s route ctx has drifted from the literal in lib/server/index.js');
});

// ---------------------------------------------------------------------------
// The conventions tripwire table.

test('docs/extending.md\'s tripwire table lists every construct the ratchet bans', () => {
  const body = read('docs/extending.md');
  const table = body.match(/\| Construct \| Allowed home \|[\s\S]*?\n\n/);
  assert.ok(table, 'docs/extending.md no longer carries the tripwire table');
  // The row's key is the first backticked span of its Construct cell; the
  // pattern's is its `name`. Both carry a trailing human gloss ("(the lookup-map
  // spelling)", "map") that is not part of the construct, so they are compared
  // punctuation-free and by containment rather than by equality.
  const rows = table[0].split('\n').filter((l) => l.startsWith('| `'))
    .map((l) => l.split('|')[1].match(/`([^`]+)`/)[1]);
  const norm = (s) => s.toLowerCase().replace(/[\s'"`…()]/g, '');
  const matches = (a, b) => a === b || a.includes(b) || b.includes(a);

  for (const name of patternNames()) {
    assert.ok(rows.some((r) => matches(norm(name), norm(r))),
      `test/conventions.test.js bans \`${name}\` but the tripwire table in docs/extending.md has no row for it — ` +
      'a reviewer consults that table to say "that construct is banned"');
  }
  for (const row of rows) {
    assert.ok(patternNames().some((n) => matches(norm(n), norm(row))),
      `the tripwire table lists \`${row}\`, which is not a pattern in test/conventions.test.js`);
  }
});

// ---------------------------------------------------------------------------
// The engines tables.
//
// There are two on purpose: docs/extending.md's is the full contributor
// reference, and CLAUDE.md's is the short version Claude has in context from
// session start — deleting it in favour of a pointer would remove the one-engine
// rule's row set from what the agent knows before it writes anything. Keeping
// both is only safe if the short one cannot say something the long one doesn't.

function engineTable(rel, header) {
  const body = read(rel);
  const i = body.indexOf(header);
  assert.ok(i >= 0, `${rel} no longer carries its engines table (looked for "${header}")`);
  const rows = [];
  for (const line of body.slice(i).split('\n').slice(2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length >= 2) rows.push({ need: cells[0], use: cells[1] });
  }
  assert.ok(rows.length >= 10, `${rel}'s engines table lost most of its rows`);
  return rows;
}

// A backticked token in a "Use" cell is either a module (a path) or a name that
// module must export. Symbols and call signatures are stripped; `core/x` is the
// same module as `lib/core/x`.
function useCell(cell) {
  const modules = [];
  const symbols = [];
  for (const m of cell.matchAll(/`([^`]+)`/g)) {
    const raw = m[1].replace(/\(.*$/, '').replace(/[,;]$/, '').trim();
    if (!raw || raw.startsWith('/') || raw.startsWith('-')) continue;
    if (raw.includes('/')) {
      let mod = raw.replace(/\/\*?$/, '').replace(/\.js$/, '');
      const dot = mod.lastIndexOf('.');
      if (dot > mod.lastIndexOf('/')) { symbols.push(mod.slice(dot + 1)); mod = mod.slice(0, dot); }
      if (!/^(lib|public|test-support|examples)\//.test(mod)) mod = `lib/${mod}`;
      modules.push(mod);
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) {
      symbols.push(raw);
    }
  }
  return { modules, symbols };
}

function moduleSources(mod) {
  const fs = require('fs');
  const path = require('path');
  const { REPO_ROOT } = require('../test-support/doc-truth');
  const abs = path.join(REPO_ROOT, mod);
  if (fs.existsSync(`${abs}.js`)) return [fs.readFileSync(`${abs}.js`, 'utf8')];
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    return fs.readdirSync(abs).filter((f) => f.endsWith('.js'))
      .map((f) => fs.readFileSync(path.join(abs, f), 'utf8'));
  }
  return null;
}

for (const [rel, header] of [
  ['CLAUDE.md', '| Need to… | Use | Never |'],
  ['docs/extending.md', '| You need to… | Use | Never |'],
]) {
  test(`every engine ${rel}'s table names exists`, () => {
    for (const row of engineTable(rel, header)) {
      const { modules, symbols } = useCell(row.use);
      assert.ok(modules.length, `${rel}: the row "${row.need}" names no engine module`);
      const sources = [];
      for (const mod of modules) {
        const src = moduleSources(mod);
        assert.ok(src, `${rel}: the row "${row.need}" points at \`${mod}\`, which does not exist`);
        sources.push(...src);
      }
      for (const sym of symbols) {
        assert.ok(sources.some((s) => new RegExp(`\\b${sym}\\b`).test(s)),
          `${rel}: the row "${row.need}" names \`${sym}\`, which none of ${modules.join(', ')} defines`);
      }
    }
  });
}

test('CLAUDE.md\'s engines table is a subset of docs/extending.md\'s', () => {
  const full = new Set();
  for (const row of engineTable('docs/extending.md', '| You need to… | Use | Never |')) {
    for (const mod of useCell(row.use).modules) full.add(mod);
  }
  for (const row of engineTable('CLAUDE.md', '| Need to… | Use | Never |')) {
    for (const mod of useCell(row.use).modules) {
      assert.ok(full.has(mod),
        `CLAUDE.md's engines table sends a contributor to \`${mod}\`, which docs/extending.md's table never mentions — ` +
        'the short in-context copy may not say something the full reference does not');
    }
  }
});

// ---------------------------------------------------------------------------
// The turn lifecycle.
//
// Since fold-forward, a turn that leaves the surface byte-identical to the
// active node commits NO node — it accumulates on `pendingFolded` and rides onto
// the next node that does commit. Both the rules file (which tells Claude it may
// point the user at "the node from that turn") and CLAUDE.md's lifecycle
// paragraph described the pre-fold behaviour for two releases. Checked in both
// directions: if `skipTurn` ever leaves domain/turns.js, this test says so
// rather than silently permitting the old prose back.

test('the turn-lifecycle prose says a no-change turn commits no node', () => {
  const turns = read('lib/server/domain/turns.js');
  assert.ok(/function skipTurn\(/.test(turns) && /function applyFolded\(/.test(turns),
    'lib/server/domain/turns.js no longer implements the no-change skip — the doc sentences this test guards ' +
    'were written against skipTurn/applyFolded, so re-read them before dropping this assertion');

  for (const rel of ['CLAUDE.md', '.claude/rules/web-chat.md', 'templates/rules/web-chat.md']) {
    const flat = flatten(read(rel));
    assert.ok(/\bStop\b/.test(flat) || /turn-end/.test(flat),
      `${rel} no longer describes the Stop hook — it is where the commit rule is stated`);
    assert.ok(/folded_count|pending_folded|folds onto|commits nothing/.test(flat),
      `${rel} describes the turn commit but never the no-change skip: a chat-only turn commits nothing, so telling ` +
      'Claude (or a contributor) that every turn produces a node promises a node that will not exist');
  }
});

// A stored node id really is `n<seq>` (n5, n11) and a label really is dotted
// (n1.0, n1.1.0), so a bare `n11` in prose is an instruction to quote an id the
// user cannot see — which is the confusion labels were introduced to end. The
// rules file said both things, four lines apart. Measured over the whole doc
// set: 2 true hits (both on the stale line), 0 false ones — every other `n<d>`
// token in the docs is the leading segment of a label.
test('no doc tells anyone to reference a graph node by its stored id', () => {
  for (const { rel, body } of DOCS) {
    for (const m of body.matchAll(/\bn\d+\b(?![.\dx])/g)) {
      const near = body.slice(Math.max(0, m.index - 80), m.index + 40).replace(/\s+/g, ' ');
      assert.fail(
        `${rel} names the node id \`${m[0]}\` (…${near}…). Nodes are referenced by the hierarchical LABEL the ` +
        'graph viewer shows (n1.4, n2.0); the stored id is opaque and the user never sees it');
    }
  }
});

// ---------------------------------------------------------------------------
// Pane scripts and the shadow root.
//
// Only document *queries* fail inside a shadow root. The wholesale ban that
// stood in the rules file, `render`'s description and the pack checklist also
// forbade `document.createElement` — which is how every shipped pane builds DOM
// from data, and the alternative the pack doc's own §4 warns against is
// `innerHTML` with interpolation, the bug class it says already shipped once.
// So: a prohibition of `document` in the shipped prose has to name the queries.
test('the shadow-root rule bans document QUERIES, not document.createElement', () => {
  const fs = require('fs');
  const path = require('path');
  const { REPO_ROOT } = require('../test-support/doc-truth');
  // The other direction: the ban is only wrong because the sanctioned API is in
  // use. If no shipped pane builds DOM this way, re-read the rule before this.
  const panes = fs.readdirSync(path.join(REPO_ROOT, 'templates/components'))
    .map((d) => path.join(REPO_ROOT, 'templates/components', d, 'component.html'))
    .filter((f) => fs.existsSync(f));
  assert.ok(panes.some((f) => /document\.createElement/.test(fs.readFileSync(f, 'utf8'))),
    'no shipped pane uses document.createElement any more — re-check the guidance this test protects');

  for (const { rel, body } of [...DOCS, ...toolDescriptions()]) {
    const flat = flatten(body);
    for (const m of flat.matchAll(/(?:never|no)\s+(?:\*\*)?`document([^`]*)`(.{0,80})/gi)) {
      assert.ok(/quer|getElementById/i.test(m[1] + m[2]),
        `${rel} forbids \`document${m[1]}\` without saying it is the QUERIES that break ("${m[0].trim()}"). ` +
        'document.createElement/createTextNode work fine in a pane and are the safe way to build DOM from data');
    }
  }
});

// ---------------------------------------------------------------------------
// Where consent lives.
//
// The location of trusted.json is a security property, not a detail: a
// project-local file let a hostile repo ship its own pre-approval, so the record
// moved to the user tier. The doc that explains that move kept a Code map row
// naming the removed location — the one row a maintainer scans for where consent
// lives, pointing at the path the fix deleted.
test('no doc places the service trust store inside the project', () => {
  const { projectPaths, userPaths } = require('../lib/core/paths');
  const { REPO_ROOT } = require('../test-support/doc-truth');
  assert.match(userPaths().trustedServices, /\/\.web-chat\/services\/trusted\.json$/,
    'userPaths().trustedServices has moved — re-read every doc this test guards before changing it');
  const project = Object.values(projectPaths(REPO_ROOT)).filter((v) => typeof v === 'string');
  assert.ok(!project.some((v) => v.endsWith('trusted.json')),
    'projectPaths now names a trusted.json — consent is back inside the project, which is the vulnerability the ' +
    'user-tier move closed; this test and the docs it guards both need rewriting');

  // A project-relative `.web-chat/services/` is only wrong where the doc is
  // talking about CONSENT — the dir itself still exists in a project. So the
  // window around each mention decides, and the one legitimate hit (the sentence
  // describing the vulnerability the move closed) is on the allowlist.
  for (const { rel, body } of [...DOCS, ...toolDescriptions()]) {
    const flat = flatten(body);
    for (const m of flat.matchAll(/(?<!~\/)`?\.web-chat\/services\/(trusted\.json)?/g)) {
      const near = flat.slice(Math.max(0, m.index - 120), m.index + 120);
      if (!/trust|consent|approv/i.test(near)) continue;
      // The allowance is per-OCCURRENCE, not per-file: its marker has to match
      // this mention's own window, or one exempt sentence would exempt the
      // whole document (which is how the stale Code map row survived beside the
      // Trust section that contradicts it).
      const allowed = allowFor('trustStore', rel, '.web-chat/services/trusted.json');
      assert.ok(allowed && allowed.marker.test(near),
        `${rel} points at a project-relative \`.web-chat/services/\` for the trust store (…${near.trim()}…); ` +
        'consent lives at `~/.web-chat/services/trusted.json` (userPaths().trustedServices) precisely so a ' +
        'repository cannot ship its own approval' +
        (allowed ? ` — the only exempt mention is the one that ${allowed.reason}` : ''));
    }
  }
});

// ---------------------------------------------------------------------------
// Identifiers a consolidation retired.
//
// The recurring doc defect is not a wrong path — it is the right path beside a
// name the refactor deleted, which no existence check sees. A driver author sent
// to `pushEvent` finds nothing and hand-pairs the broadcast the bus exists to
// replace. Each entry is checked in BOTH directions: still undeclared in `lib/`,
// still unnamed in the docs. A name that comes back fails as a stale entry
// rather than silently exempting itself.
const RETIRED = [
  { name: 'pushEvent', now: 'lib/core/bus.js — `bus.emit({ event, ws })`, the one ring + WS pairing' },
];

test('no shipped doc names an identifier a consolidation retired', () => {
  const fs = require('fs');
  const path = require('path');
  const { REPO_ROOT } = require('../test-support/doc-truth');
  const sources = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) sources.push(fs.readFileSync(p, 'utf8'));
    }
  })(path.join(REPO_ROOT, 'lib'));

  for (const { name, now } of RETIRED) {
    // Declared, not merely mentioned: the engines that replaced these names say
    // so in their own comments, and a comment is not a re-introduction.
    const declared = new RegExp(`(?:function|const|let|var)\\s+${name}\\b|\\b${name}\\s*[:(]\\s*(?:function|\\()`);
    assert.ok(!sources.some((s) => declared.test(s)),
      `\`${name}\` is declared under lib/ again — drop its RETIRED entry (it was replaced by ${now})`);
    for (const { rel, body } of [...DOCS, ...toolDescriptions()]) {
      assert.ok(!new RegExp('`' + name + '`').test(body),
        `${rel} names \`${name}\`, which nothing under lib/ defines any more. The engine is ${now}`);
    }
  }
});
