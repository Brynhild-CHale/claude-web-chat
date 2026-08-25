// Where a pack comes from, resolved to something pinnable.
//
// A user pastes a repository URL. Two things have to come out of it: an
// addressable API base (to ask about releases and to resolve a ref to a commit)
// and a tarball URL. Everything downstream — fetch, plan, the provenance record
// — speaks in terms of the { owner, repo, sha } this module produces, so there
// is exactly one place that knows GitHub's URL shapes.
//
// The integrity anchor is the COMMIT SHA, never the tarball's digest. GitHub's
// `/archive/` tarballs are not byte-stable (the compression and the embedded
// mtimes have changed under them before), so a recorded tarball digest would
// spuriously fail to reproduce. A commit sha cannot be re-pointed; a release
// asset can be deleted and re-uploaded under the same tag. That asymmetry is why
// a release with no SHA256SUMS falls back to the sha-pinned archive rather than
// installing an unverified asset.

const { getJson, fetchLatestRelease, fetchReleaseByTag, shapeRelease, SUMS_ASSET } = require('../update/release');
const gh = require('./gh');

const SHA_RE = /^[0-9a-f]{40}$/i;
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

function bad(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  return e;
}

// Accepts, in rough order of how often a human types them:
//   https://github.com/owner/repo            (with or without .git, /tree/<ref>)
//   github.com/owner/repo
//   owner/repo
//   git@github.com:owner/repo.git
//   http://127.0.0.1:PORT/owner/repo         (a GitHub-API-shaped host — this is
//                                             what the tests drive, so the code
//                                             under test is the real code)
//
// Returns { origin, host, owner, repo, ref, apiBase, webUrl, isGithub }.
function parseSource(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw bad('a pack source URL is required');

  // An obviously-LOCAL source, refused before the GitHub shapes are tried.
  //
  // Without this, `/Users/me/src/acme-pack` fell through the host-detect regex
  // below (which cannot match a leading `/`), got prefixed to
  // `github.com//Users/me/src/acme-pack`, and the empty leading segment was
  // silently dropped — so the user was told "could not resolve 'HEAD' in
  // Users/me" and blamed for a ref or a permission on a repository they never
  // typed. There is no local-path source; saying so is the honest answer.
  if (/^(\/|\.\.?\/|~)/.test(raw) || /^file:\/\//i.test(raw)) {
    throw bad(`${raw} is a local path. \`pack install\`/\`pack get\` take a repository URL — there is no local-path source. To develop against a checkout, symlink it into .web-chat/components/ instead (see docs/component-packs.md §9).`);
  }

  // scp-style git remote
  const scp = raw.match(/^git@([^:]+):(.+)$/);
  let u;
  if (scp) {
    u = new URL(`https://${scp[1]}/${scp[2]}`);
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    try { u = new URL(raw); } catch { throw bad(`not a URL: ${raw}`); }
  } else if (raw.includes('/') && !raw.includes(' ')) {
    // `owner/repo` or `github.com/owner/repo`
    const withHost = /^[^/]+\.[^/]+\//.test(raw) ? raw : `github.com/${raw}`;
    try { u = new URL(`https://${withHost}`); } catch { throw bad(`not a URL: ${raw}`); }
  } else {
    throw bad(`not a pack source: ${raw} (expected a repository URL or owner/repo)`);
  }

  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length < 2) throw bad(`${raw} has no owner/repo — expected https://<host>/<owner>/<repo>`);
  const owner = segs[0];
  const repo = segs[1].replace(/\.git$/, '');
  if (!SLUG_RE.test(owner) || !SLUG_RE.test(repo)) throw bad(`${raw}: owner/repo contains characters that are not part of a repository name`);

  // …/tree/<ref>, …/commit/<sha> — a ref the user embedded in the URL.
  let ref = null;
  if ((segs[2] === 'tree' || segs[2] === 'commit') && segs[3]) ref = segs.slice(3).join('/');

  const isGithub = /(^|\.)github\.com$/.test(u.hostname);
  const origin = u.origin;
  // On github.com the API and the tarballs live on other hosts. Anywhere else we
  // assume a GitHub-API-shaped server at the same origin.
  const apiBase = isGithub
    ? `https://api.github.com/repos/${owner}/${repo}`
    : `${origin}/repos/${owner}/${repo}`;
  const webUrl = isGithub ? `https://github.com/${owner}/${repo}` : `${origin}/${owner}/${repo}`;

  return { origin, host: u.hostname, owner, repo, slug: `${owner}/${repo}`, ref, apiBase, webUrl, isGithub };
}

// The tarball for one commit. On github.com this is codeload DIRECTLY rather
// than github.com/…/archive/…, which 302s to codeload: that redirect crosses an
// origin, so an Authorization header for a private repo would be dropped
// (correctly — see release.httpGet) and the fetch would 404. Going straight to
// codeload keeps the credential on the one host it was minted for.
function archiveUrl(src, sha) {
  if (!SHA_RE.test(String(sha || ''))) throw bad(`refusing to build an archive URL for a non-commit ref: ${sha}`);
  return src.isGithub
    ? `https://codeload.github.com/${src.owner}/${src.repo}/tar.gz/${sha}`
    : `${src.origin}/${src.owner}/${src.repo}/archive/${sha}.tar.gz`;
}

// Resolve a branch / tag / short sha / HEAD to a full 40-char commit sha. This
// is the pin: everything a pack install records points at this, not at whatever
// the branch happens to be tomorrow.
async function resolveCommit(src, ref, opts = {}) {
  const want = String(ref || src.ref || 'HEAD');
  // Prefer `gh` when it is authenticated and this is actually GitHub: it is the
  // only transport that can see a PRIVATE pack repository, and it lifts the
  // anonymous 60-req/hour limit a couple of installs can exhaust. Same shape
  // either way, so nothing downstream branches on which one answered.
  const ghHost = gh.hostFor(src);
  const json = ghHost
    ? gh.api(`repos/${src.slug}/commits/${encodeURIComponent(want)}`, { hostname: ghHost })
    : await getJson(`${src.apiBase}/commits/${encodeURIComponent(want)}`, opts);
  const sha = json && (json.sha || (json.commit && json.commit.sha));
  if (!sha) throw bad(`could not resolve '${want}' in ${src.owner}/${src.repo} — is the ref right, and the repository readable?`);
  if (!SHA_RE.test(sha)) throw bad(`${src.owner}/${src.repo} returned a commit id that is not a sha: ${sha}`);
  return String(sha).toLowerCase();
}

// The release a pack install should consider: a named tag, or the latest.
// Returns null when there is none (GitHub 404s, which is the same thing).
async function findRelease(src, ref, opts = {}) {
  const o = { apiBase: src.apiBase, ...opts };
  try {
    const ghHost = gh.hostFor(src);
    if (ghHost) {
      // shapeRelease is release.js's own normalizer — reused rather than
      // reimplemented, so a gh-sourced release and an HTTP-sourced one are the
      // same object and pickPackAsset cannot tell them apart.
      const p = ref ? `repos/${src.slug}/releases/tags/${encodeURIComponent(ref)}` : `repos/${src.slug}/releases/latest`;
      return shapeRelease(gh.api(p, { hostname: ghHost }));
    }
    return ref ? await fetchReleaseByTag(ref, o) : await fetchLatestRelease(o);
  } catch {
    // A rate-limited or unreachable releases API must not sink the install —
    // the sha-pinned archive path is always available and is the stronger pin
    // anyway.
    return null;
  }
}

// The two assets a verified release install needs. Unlike the program's own
// release (whose tarball name the build script owns), a pack's asset name is
// whatever its author chose — so: an explicit `asset` name if the caller gave
// one, else the sole .tar.gz. Two unnamed tarballs is ambiguous, and guessing
// which one to run is not a thing this should do.
function pickPackAsset(release, asset) {
  const assets = (release && release.assets) || [];
  const tarballs = assets.filter((a) => a.name.endsWith('.tar.gz') || a.name.endsWith('.tgz'));
  const tarball = asset
    ? assets.find((a) => a.name === asset) || null
    : (tarballs.length === 1 ? tarballs[0] : null);
  const sums = assets.find((a) => a.name === SUMS_ASSET) || null;
  return { tarball, sums, candidates: tarballs.map((a) => a.name) };
}

module.exports = { parseSource, archiveUrl, resolveCommit, findRelease, pickPackAsset, SHA_RE };
