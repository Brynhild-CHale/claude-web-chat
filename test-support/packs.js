// Fixture pack repositories + a local stand-in for the GitHub API and codeload.
//
// Deliberately OUTSIDE test/ (see test-support/helpers.js for why) and not
// scanned by the conventions tripwire, so it may build tarballs and run raw
// http servers freely.
//
// The point of a real HTTP server rather than a mock: the code under test is
// then the actual fetch path — redirect following, the credential rule, the
// streaming cap, the checksum gate, `tar` — rather than a stub standing where it
// used to be. Tarballs are built with the SAME makeTar the release build uses,
// so the archives are genuine ustar.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { makeTar } = require('../scripts/build-release');

function tmpDir(prefix = 'wc-pack-fx-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const DEFAULT_HTML = (name) => `<style>.x{color:var(--wc-fg)}</style>
<div class="x" id="body">${name}</div>
<script>root.querySelector('#body').textContent = params.label || '${name}';</script>
`;

// Build a pack repository on disk. Returns its root directory.
//   components: [{ name, description, params_schema, html, seed, service, meta }]
function packFixture({
  name = 'acme-ops',
  version = '1.2.0',
  description = 'Acme service operations on the web-chat surface.',
  requires = null,
  components = [{ name: 'deploy-board' }],
  themes = [],
  skill = true,
  skillName = null,
  skillDescription = null,
  manifest: manifestOverride = null,
  extraFiles = {},
  dir = null,
} = {}) {
  const root = dir || tmpDir();
  const compNames = components.map((c) => c.name);
  const manifest = manifestOverride || {
    name,
    version,
    description,
    ...(requires ? { requires } : {}),
    components: compNames,
    ...(themes.length ? { themes: themes.map((t) => t.name) } : {}),
  };
  write(path.join(root, 'web-chat-pack.json'), JSON.stringify(manifest, null, 2) + '\n');
  write(path.join(root, 'README.md'), `# ${name}\n`);

  for (const c of components) {
    const cdir = path.join(root, 'components', c.name);
    write(path.join(cdir, 'component.html'), c.html != null ? c.html : DEFAULT_HTML(c.name));
    if (c.meta !== null) {
      write(path.join(cdir, 'meta.json'), JSON.stringify(c.meta || {
        name: c.name,
        description: c.description || `${c.name} — a pack component.`,
        params_schema: c.params_schema || {},
      }, null, 2) + '\n');
    }
    if (c.seed) write(path.join(cdir, 'seed.js'), c.seed);
    if (c.service) write(path.join(cdir, 'service.js'), c.service);
  }

  for (const t of themes) {
    write(path.join(root, 'themes', `${t.name}.json`), JSON.stringify(t.theme || { tokens: { '--wc-accent': '#c0ffee' } }, null, 2) + '\n');
  }

  if (skill) {
    write(path.join(root, 'SKILL.md'), `---
name: ${skillName || name}
description: ${skillDescription || `${description} Use when the user asks about deploys, incidents, or service health.`}
---

# ${name}

${compNames.map((c) => `## ${c}\n\n\`use_component({ name: '${c}', id: '${c}' })\`\n`).join('\n')}
`);
  }

  for (const [rel, content] of Object.entries(extraFiles)) write(path.join(root, rel), content);
  return root;
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(abs, base));
    else out.push({ rel: path.relative(base, abs).split(path.sep).join('/'), abs, mode: 0o644 });
  }
  return out;
}

// Tar a fixture directory under a single prefix, the way a GitHub archive does.
// `extraEntries` lets a test append a hostile member (a symlink, a `..` path)
// that fs cannot represent as a plain file.
function tarballOf(dir, prefix, extraEntries = []) {
  const entries = [{ name: `${prefix}/`, type: 'dir' }];
  for (const f of walkFiles(dir)) entries.push({ name: `${prefix}/${f.rel}`, type: 'file', mode: f.mode, source: f.abs });
  return zlib.gzipSync(makeTar([...entries, ...extraEntries]));
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sumsText(entries) {
  return entries.map(({ name, body }) => `${sha256(body)}  ${name}\n`).join('');
}

// A local stand-in for the two GitHub surfaces a pack install talks to:
// the REST API (commits, releases) and the archive download. Realistic in the
// two ways that matter — asset downloads go through a redirect hop, and the
// commit endpoint is what pins the install.
//
//   repos: { 'owner/repo': { commits: { HEAD: sha, 'v1.2.0': sha, … },
//                            archives: { <sha>: Buffer },
//                            release: { tag, assets: [{name, body}] } | null } }
//
// `state` is mutable so a test can drop the sums file or corrupt an asset
// between requests. `seen` records every request for header assertions.
async function fakeForge(t, state) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

    let m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/commits\/(.+)$/);
    if (m) {
      const repo = state.repos[`${m[1]}/${m[2]}`];
      const sha = repo && repo.commits && repo.commits[decodeURIComponent(m[3])];
      return sha ? json(200, { sha }) : json(404, { message: 'Not Found' });
    }

    m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/releases\/(latest|tags\/(.+))$/);
    if (m) {
      const repo = state.repos[`${m[1]}/${m[2]}`];
      const rel = repo && repo.release;
      if (!rel) return json(404, { message: 'Not Found' });
      if (m[4] && decodeURIComponent(m[4]) !== rel.tag) return json(404, { message: 'Not Found' });
      // Asset URLs are INDEX-based, like GitHub's real id-based ones — the
      // asset's `name` is metadata, not part of the path. That matters for the
      // test that ships a hostile asset name: embedding it in the URL would let
      // URL normalization eat the traversal before the code under test ever
      // saw it.
      return json(200, {
        tag_name: rel.tag,
        draft: Boolean(rel.draft),
        assets: (rel.assets || []).map((a, i) => ({ name: a.name, size: a.body.length, browser_download_url: `${base()}/dl/${m[1]}/${m[2]}/${i}` })),
      });
    }

    // One redirect hop, the way a real asset download goes to object storage.
    m = p.match(/^\/dl\/(.+)$/);
    if (m) { res.writeHead(302, { Location: `${base()}/obj/${m[1]}` }); return res.end(); }

    m = p.match(/^\/obj\/([^/]+)\/([^/]+)\/(.+)$/);
    if (m) {
      const repo = state.repos[`${m[1]}/${m[2]}`];
      const assets = (repo && repo.release && repo.release.assets) || [];
      const key = decodeURIComponent(m[3]);
      const asset = /^\d+$/.test(key) ? assets[Number(key)] : assets.find((a) => a.name === key);
      if (!asset) { res.writeHead(404); return res.end('no'); }
      res.writeHead(200, { 'Content-Length': asset.body.length });
      return res.end(asset.body);
    }

    m = p.match(/^\/([^/]+)\/([^/]+)\/archive\/([0-9a-f]{40})\.tar\.gz$/);
    if (m) {
      const repo = state.repos[`${m[1]}/${m[2]}`];
      const body = repo && repo.archives && repo.archives[m[3]];
      if (!body) { res.writeHead(404); return res.end('no'); }
      res.writeHead(200, { 'Content-Length': body.length });
      return res.end(body);
    }

    res.writeHead(404); res.end('no');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  const base = () => `http://127.0.0.1:${srv.address().port}`;
  return { base: base(), seen, url: (owner, repo) => `${base()}/${owner}/${repo}` };
}

// The common case: one repo, one commit, an archive for it, no release.
function repoWithArchive(dir, { prefix = 'pack-1', sha = 'a'.repeat(40), extraEntries = [] } = {}) {
  return {
    commits: { HEAD: sha, main: sha, [sha]: sha },
    archives: { [sha]: tarballOf(dir, prefix, extraEntries) },
    release: null,
  };
}

// The verified path: a release carrying the tarball and its SHA256SUMS.
function repoWithRelease(dir, { tag = 'v1.2.0', assetName = 'acme-ops-1.2.0.tar.gz', prefix = 'pack-1', sha = 'b'.repeat(40), sums = true } = {}) {
  const body = tarballOf(dir, prefix);
  const assets = [{ name: assetName, body }];
  if (sums) assets.push({ name: 'SHA256SUMS', body: Buffer.from(sumsText([{ name: assetName, body }])) });
  return {
    commits: { HEAD: sha, [tag]: sha, [sha]: sha },
    archives: { [sha]: tarballOf(dir, prefix) },
    release: { tag, assets },
  };
}

// ── a fake `gh` on PATH ─────────────────────────────────────────────────────
// lib/packs/gh.js shells out to the real binary, so the only honest way to test
// that path is to put a stand-in on PATH and let it run. The stub itself lives
// in test-support/fake-gh.js (a real file — generating a Node script from a JS
// template inside a heredoc is how you get a broken stub and a baffling failure).
//
// Returns { dir, calls(), setState() }. `calls()` is how a test proves the gh
// transport was actually taken — or, for the host-scoping tests, that it
// correctly was not.
//
// state = {
//   authed: bool,
//   repos: { 'owner/repo': { commits: {ref: sha}, tarballs: {sha: <file>},
//                            release: { tag, assets: [{name, file}] } | null } },
// }
function fakeGh(t, state) {
  const dir = tmpDir('wc-fakegh-');
  const statePath = path.join(dir, 'state.json');
  const callsPath = path.join(dir, 'calls.log');
  fs.writeFileSync(statePath, JSON.stringify(state));
  fs.writeFileSync(callsPath, '');

  // A shim named exactly `gh`, so PATH resolution finds it the way it would find
  // the real one.
  fs.writeFileSync(path.join(dir, 'gh'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fake-gh.js')}" "$@"\n`);
  fs.chmodSync(path.join(dir, 'gh'), 0o755);

  const prev = {
    PATH: process.env.PATH,
    NO_GH: process.env.WEB_CHAT_NO_GH,
    STATE: process.env.FAKE_GH_STATE,
    CALLS: process.env.FAKE_GH_CALLS,
  };
  process.env.PATH = `${dir}${path.delimiter}${prev.PATH}`;
  process.env.FAKE_GH_STATE = statePath;
  process.env.FAKE_GH_CALLS = callsPath;
  delete process.env.WEB_CHAT_NO_GH;
  // lib/packs/gh.js memoizes "is gh available"; a test that just changed PATH
  // has to say "look again".
  require('../lib/packs/gh').resetAvailability();

  t.after(() => {
    process.env.PATH = prev.PATH;
    for (const [k, v] of [['WEB_CHAT_NO_GH', prev.NO_GH], ['FAKE_GH_STATE', prev.STATE], ['FAKE_GH_CALLS', prev.CALLS]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    require('../lib/packs/gh').resetAvailability();
  });

  return {
    dir,
    calls: () => fs.readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    setState: (next) => fs.writeFileSync(statePath, JSON.stringify(next)),
  };
}

// Write a fixture pack's tarball to a real file, for the fake gh to serve.
function tarballFile(dir, prefix = 'pack-1') {
  const f = path.join(tmpDir('wc-ghtar-'), 'pack.tar.gz');
  fs.writeFileSync(f, tarballOf(dir, prefix));
  return f;
}

module.exports = {
  tmpDir, write, packFixture, tarballOf, walkFiles, fakeForge,
  repoWithArchive, repoWithRelease, sha256, sumsText, DEFAULT_HTML,
  fakeGh, tarballFile,
};
