#!/usr/bin/env node
// A stand-in for the `gh` binary, for test/pack-gh.test.js.
//
// lib/packs/gh.js shells out to the real thing, so the only honest way to test
// that path is to put this on PATH and let the real spawn happen. It is a real
// file rather than a generated string because the escaping of a Node script
// inside a JS template inside a shell heredoc is exactly the kind of thing that
// silently produces a broken stub and a confusing test failure.
//
// Its fixture data comes from FAKE_GH_STATE (a JSON file), and it appends every
// invocation's argv to FAKE_GH_CALLS — which is how a test proves the gh
// transport was taken, or (for host scoping) that it deliberately was not.

const fs = require('fs');

const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(argv) + '\n');

function notFound() {
  process.stderr.write('gh: Not Found (HTTP 404)\n');
  process.exit(1);
}
function emit(buf) {
  process.stdout.write(buf);
  process.exit(0);
}

// `gh auth token` — exits non-zero when there is no stored credential.
if (argv[0] === 'auth') process.exit(state.authed === false ? 1 : 0);

if (argv[0] === 'api') {
  const p = argv[1] || '';

  let m = p.match(/^repos\/([^/]+)\/([^/]+)\/commits\/(.+)$/);
  if (m) {
    const repo = state.repos[`${m[1]}/${m[2]}`];
    const sha = repo && repo.commits && repo.commits[decodeURIComponent(m[3])];
    return sha ? emit(JSON.stringify({ sha })) : notFound();
  }

  m = p.match(/^repos\/([^/]+)\/([^/]+)\/releases\/(latest|tags\/(.+))$/);
  if (m) {
    const repo = state.repos[`${m[1]}/${m[2]}`];
    const rel = repo && repo.release;
    if (!rel) return notFound();
    if (m[4] && decodeURIComponent(m[4]) !== rel.tag) return notFound();
    return emit(JSON.stringify({
      tag_name: rel.tag,
      draft: false,
      assets: (rel.assets || []).map((a) => ({
        name: a.name,
        size: fs.statSync(a.file).size,
        // Deliberately unreachable: if the code ever falls back to the HTTP
        // download for a gh-sourced release, the test fails loudly instead of
        // quietly working.
        browser_download_url: `https://example.invalid/SHOULD-NOT-BE-FETCHED/${a.name}`,
      })),
    }));
  }

  m = p.match(/^repos\/([^/]+)\/([^/]+)\/tarball\/(.+)$/);
  if (m) {
    const repo = state.repos[`${m[1]}/${m[2]}`];
    const file = repo && repo.tarballs && repo.tarballs[m[3]];
    return file ? emit(fs.readFileSync(file)) : notFound();
  }

  return notFound();
}

if (argv[0] === 'release' && argv[1] === 'download') {
  const tag = argv[2];
  const slug = String(argv[argv.indexOf('--repo') + 1] || '').split('/').slice(-2).join('/');
  const pattern = argv[argv.indexOf('--pattern') + 1];
  const rel = state.repos[slug] && state.repos[slug].release;
  if (!rel || rel.tag !== tag) return notFound();
  const asset = (rel.assets || []).find((a) => a.name === pattern);
  return asset ? emit(fs.readFileSync(asset.file)) : notFound();
}

process.stderr.write(`fake gh: unhandled ${JSON.stringify(argv)}\n`);
process.exit(1);
