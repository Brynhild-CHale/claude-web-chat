// Doc truth — the one home for "what the shipped docs claim about the code".
//
// Prose rots silently. `claude-web-chat watch` outlived its feature in the rules
// file; the `wait_for` MCP tool outlived its deletion in two extension READMEs
// the daemon serves live; CLAUDE.md still described a route `ctx` with keys the
// bus refactor removed. Every one of those is a claim a machine can check, and
// none of them was checked, because each check that did exist walked its own
// hand-written file list (`test/managed-templates.test.js`, `test/distribution
// .test.js`) and read its own hand-written truth source.
//
// This module holds BOTH halves once: `docFiles()` — the set of files a claim can
// ship in — and `truth` — the readers that say what the code actually contains.
// `test/doc-truth.test.js` is the only consumer that asserts over them; other
// suites may borrow a reader (managed-templates borrows `cliCommands`) so the
// commands map is never source-parsed twice.
//
// Three readers must parse source text rather than `require`:
//   - lib/cli/index.js's `commands` map — requiring it pulls in every command.
//   - lib/server/index.js's `ctx` literal — it exists only inside createServer,
//     and no test seam is needed to read it.
//   - test/conventions.test.js's PATTERNS — that file has no module.exports (it
//     is a test), so its pattern names are read the same way.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(REPO_ROOT, rel));

// ---------------------------------------------------------------------------
// The walked set.

// Every surface a doc claim can ship or be read from:
//   - CLAUDE.md / README.md — the repo's own front doors (CLAUDE.md is in
//     Claude's context from session start, so a wrong row there is acted on).
//   - docs/*.md — `claude-web-chat docs <name>` prints ANY file here verbatim,
//     to the user and to Claude, so every one of them is a shipped user doc.
//   - the managed templates and this repo's live copies of them — pushed into
//     every consumer project by `install`/`update`.
//   - extensions/**/*.md — the daemon's install page links these at runtime
//     (lib/server/routes/extensions.js), and `extensions/` is in package.json
//     `files`, so they ship in the release tarball.
//   - examples/*.js header comments — docs/driving-the-surface.md sends driver
//     authors here as "the canonical shape". Only the header block is walked:
//     the code below it is code, and a string in it is not a claim.
//
// CHANGELOG.md is deliberately excluded: it quotes historical WRONG states on
// purpose ("Documentation no longer hardcodes http://localhost:5173", "the
// `wait_for` MCP tool … removed"), so every extractor here would fire on it.
function docFiles() {
  const out = [];
  const push = (rel) => { if (exists(rel)) out.push({ rel, body: read(rel) }); };
  const dirMd = (dir) => {
    if (!exists(dir)) return;
    for (const f of fs.readdirSync(path.join(REPO_ROOT, dir)).sort()) {
      if (f.endsWith('.md')) push(`${dir}/${f}`);
    }
  };

  push('CLAUDE.md');
  push('README.md');
  dirMd('docs');
  dirMd('templates/rules');
  dirMd('templates/commands');
  dirMd('.claude/rules');
  dirMd('.claude/commands');

  for (const base of ['templates/skills', '.claude/skills']) {
    if (!exists(base)) continue;
    for (const d of fs.readdirSync(path.join(REPO_ROOT, base)).sort()) {
      dirMd(`${base}/${d}`);
    }
  }

  if (exists('extensions')) {
    for (const d of fs.readdirSync(path.join(REPO_ROOT, 'extensions')).sort()) {
      if (fs.statSync(path.join(REPO_ROOT, 'extensions', d)).isDirectory()) dirMd(`extensions/${d}`);
    }
  }

  if (exists('examples')) {
    for (const f of fs.readdirSync(path.join(REPO_ROOT, 'examples')).sort()) {
      if (f.endsWith('.js')) out.push({ rel: `examples/${f}`, body: headerComment(read(`examples/${f}`)) });
    }
  }

  return out;
}

// The leading `//` block of a script, with the comment markers stripped, so the
// same extractors run over it as over markdown.
function headerComment(src) {
  const lines = [];
  for (const line of src.split('\n')) {
    if (/^#!/.test(line)) continue;
    if (!/^\s*\/\//.test(line)) break;
    lines.push(line.replace(/^\s*\/\/ ?/, ''));
  }
  return lines.join('\n');
}

// A claim can wrap across lines (and across `//` markers in an example header),
// so context-sensitive extractors run over a flattened copy.
const flatten = (body) => body.replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------
// The truth readers.

// The subcommand names lib/cli/index.js actually registers. Source-parsed:
// requiring the module would load every command's dependencies.
function cliCommands() {
  const src = read('lib/cli/index.js');
  const block = src.match(/const commands = \{([\s\S]*?)\n\};/);
  if (!block) throw new Error('could not locate the commands map in lib/cli/index.js');
  const names = [...block[1].matchAll(/^\s{2}([a-z][a-z-]*):/gm)].map((m) => m[1]);
  if (names.length < 6) throw new Error('commands map parse looks wrong');
  return names;
}

// The registered MCP tools. Read as directory entries, not by requiring
// lib/mcp/index.js — that pulls in the MCP SDK.
function mcpTools() {
  return fs.readdirSync(path.join(REPO_ROOT, 'lib', 'mcp', 'tools'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.replace(/\.js$/, ''))
    .sort();
}

// The prose the MCP tools ship. CLAUDE.md calls these descriptions load-bearing
// because Claude picks and interprets a tool by reading one, so a wrong sentence
// here is acted on exactly like a wrong line in the rules file — same doc set,
// same claim checks. Required (not source-parsed): a tool module pulls in
// lib/mcp/client, which has no side effects at require time.
function toolDescriptions() {
  return mcpTools().map((name) => {
    const mod = require(path.join(REPO_ROOT, 'lib', 'mcp', 'tools', `${name}.js`));
    const parts = [mod.description || ''];
    const props = (mod.inputSchema && mod.inputSchema.properties) || {};
    for (const key of Object.keys(props)) {
      if (props[key] && props[key].description) parts.push(props[key].description);
    }
    return { rel: `lib/mcp/tools/${name}.js`, body: parts.join('\n\n') };
  });
}

// The keys the route ctx literal in lib/server/index.js actually carries — the
// contract CLAUDE.md tells a contributor to code a new route against.
function ctxKeys() {
  const src = read('lib/server/index.js');
  const block = src.match(/\n {2}const ctx = \{([\s\S]*?)\n {2}\};/);
  if (!block) throw new Error('could not locate the ctx literal in lib/server/index.js');
  const keys = [...block[1].matchAll(/^ {4}([A-Za-z_]\w*)\s*[:,]/gm)].map((m) => m[1]);
  if (keys.length < 5) throw new Error('ctx literal parse looks wrong');
  return keys;
}

// The banned-construct names test/conventions.test.js ratchets. That file is a
// test, so it has no module.exports — the names are regex-read from its source.
function patternNames() {
  const src = read('test/conventions.test.js');
  const names = [...src.matchAll(/^ {4}name: (['"])((?:\\.|(?!\1).)*)\1,$/gm)]
    .map((m) => m[2].replace(/\\(.)/g, '$1'));
  if (names.length < 4) throw new Error('conventions PATTERNS parse looks wrong');
  return names;
}

// Every `/api/…` literal mounted by the instance server or the hub.
function routePaths() {
  const files = [];
  for (const dir of ['lib/server/routes', 'lib/hub']) {
    for (const f of fs.readdirSync(path.join(REPO_ROOT, dir))) {
      if (f.endsWith('.js')) files.push(`${dir}/${f}`);
    }
  }
  files.push('lib/server/index.js');
  const routes = new Set();
  for (const rel of files) {
    for (const m of read(rel).matchAll(/['"`](\/api\/[A-Za-z0-9_:./-]*)['"`]/g)) routes.add(m[1]);
  }
  if (routes.size < 20) throw new Error('route literal scan looks wrong');
  return [...routes].sort();
}

// Does a cited path match a mounted route? Segment-wise, so a `:param` segment
// in the code matches a placeholder (`:ref`, `<ref>`, `{ref}`) or a concrete
// value in the doc. Without this, every doc that spells a parameter differently
// than the route file does would be a false failure.
function routeIsMounted(cited, routes) {
  const clean = (p) => p.replace(/\?.*$/, '').replace(/\/+$/, '');
  const docSegs = clean(cited).split('/');
  return routes.some((route) => {
    const segs = clean(route).split('/');
    if (segs.length !== docSegs.length) return false;
    return segs.every((s, i) => s.startsWith(':') || /^[<{:]/.test(docSegs[i]) || s === docSegs[i]);
  });
}

// ---------------------------------------------------------------------------
// The allowlist.
//
// One map, not the two ad-hoc ones this replaces (managed-templates' PLANNED and
// notInReadme). Every entry carries a reason, and every entry is checked in the
// INVERSE direction by the test: a permitted-unbuilt claim must still be unbuilt.
// That inversion is the point — PLANNED's `pack` entry survived the shipping of
// the pack tooling because nothing ever asserted it was still unbuilt, and a
// stale exemption silently widens the check it belongs to.
//
// `marker`, where given, additionally requires the citing doc to say out loud
// that the thing is not built, so a reader never mistakes a spec for something
// they can run.
const ALLOW = {
  // Tool names a doc may name even though no such tool exists.
  mcpTool: [
    {
      rel: 'docs/channels-dev.md',
      claim: 'wait_for',
      reason: 'named as the DELETED legacy wake primitive, in the sentence that says it is gone',
      marker: /`wait_for`[\s\S]{0,160}\*\*gone\*\*/,
    },
  ],
  // Routes a doc may cite even though nothing mounts them.
  route: [
    {
      rel: 'docs/capture-profiles-and-panes.md',
      claim: '/api/probe',
      reason: 'the in-page interaction slice is specified ahead of its implementation; the doc flags it',
      marker: /NOT BUILT/,
    },
  ],
  // CLI subcommands a doc may cite before they are registered.
  cliCommand: [],
  // Registered commands the README's command reference block may omit.
  readmeBlock: [
    { claim: 'start', reason: 'the foreground dev entry point, documented in CLAUDE.md instead' },
    { claim: 'hub', reason: 'extension plumbing; never typed by a user' },
    { claim: 'profile', reason: 'driven by the capture-profile skill, documented there' },
    { claim: 'pack', reason: 'has its own README section with the full `pack <verb>` reference' },
  ],
};

module.exports = {
  REPO_ROOT,
  read,
  exists,
  docFiles,
  headerComment,
  flatten,
  cliCommands,
  mcpTools,
  toolDescriptions,
  ctxKeys,
  patternNames,
  routePaths,
  routeIsMounted,
  ALLOW,
};
