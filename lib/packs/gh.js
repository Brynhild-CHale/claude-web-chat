// The ONE place this package shells out to `gh`.
//
// ── Why gh at all ───────────────────────────────────────────────────────────
// A component pack can live in a PRIVATE repository, and the plain HTTP path
// cannot reach one. It authenticates only if `GITHUB_TOKEN` happens to be
// exported, which for most people it is not — and even when it is, a bare PAT
// does not carry the SAML/SSO authorization an organization requires, which the
// credential `gh` already holds does.
//
// So: if `gh` is on PATH and authenticated, it is simply the better transport.
// It knows who the user is, it handles enterprise hosts, and it lifts the
// anonymous API rate limit (60 requests/hour/IP) that a couple of pack installs
// can exhaust. If it is absent or logged out, nothing changes — the HTTP path
// below it is unmodified and remains the fallback.
//
// ── Scope discipline ────────────────────────────────────────────────────────
// The same rule `release.githubAuth` follows: a credential goes to GitHub and
// nowhere else. `gh` is used ONLY when the pack's host is github.com (or an
// enterprise host the user has deliberately configured via GH_HOST). A pack URL
// pointing at an arbitrary server never causes the user's gh credential to be
// spent on it — which matters, because the URL is pasted by whoever asked for
// the install, and on the surface that can be a pane script.
//
// Set WEB_CHAT_NO_GH=1 to force the plain HTTP path.

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const GITHUB_HOSTS = /(^|\.)github\.com$/;

function fail(msg, extra = {}) {
  const e = new Error(msg);
  e.userFacing = true;
  Object.assign(e, extra);
  return e;
}

// Is `gh` present AND logged in? Memoized per process: the answer cannot change
// under us mid-install, and shelling out per API call would be silly.
//
// `gh auth token` rather than `gh auth status`: it reads the STORED credential
// and exits non-zero when there is none, without a network round-trip. stdout is
// ignored so the token is never captured into this process's memory — we only
// want the exit code.
let _available = null;
function available(env = process.env) {
  if (env.WEB_CHAT_NO_GH === '1') return false;
  if (_available !== null) return _available;
  try {
    const r = spawnSync('gh', ['auth', 'token'], { stdio: ['ignore', 'ignore', 'ignore'] });
    _available = !r.error && r.status === 0;
  } catch {
    _available = false;
  }
  return _available;
}

// Test seam: the availability answer is memoized, so a test that puts a fake gh
// on PATH needs a way to say "look again".
function resetAvailability() { _available = null; }

// Which hostname should `gh` be pointed at for this source, if any? Returns null
// when gh must NOT be used — an arbitrary host, or gh unavailable.
function hostFor(src, env = process.env) {
  if (!src || !available(env)) return null;
  if (src.isGithub) return 'github.com';
  // An enterprise host, but only one the user configured themselves.
  if (env.GH_HOST && src.host && env.GH_HOST === src.host) return src.host;
  return null;
}

function usableFor(src, env = process.env) {
  return hostFor(src, env) !== null;
}

// `gh api <path>` → parsed JSON.
//
// Mirrors release.getJson's contract exactly, so callers do not branch on which
// transport answered: a 404 is `null` ("no release published"), anything else
// throws with gh's own stderr attached — which is the whole point, because
// "you do not have access to this repository" is far more useful than a bare 404.
function api(apiPath, { hostname = 'github.com', maxBuffer = 16 * 1024 * 1024 } = {}) {
  const r = spawnSync('gh', ['api', apiPath, '--hostname', hostname], {
    encoding: 'utf8',
    maxBuffer,
  });
  if (r.error) throw fail(`could not run \`gh\`: ${r.error.message}`);
  if (r.status !== 0) {
    const err = `${r.stderr || ''}${r.stdout || ''}`;
    if (/HTTP 404|"status":\s*"404"|Not Found/i.test(err)) return null;
    throw fail(`gh api ${apiPath} failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw fail(`gh api ${apiPath} returned something that is not JSON: ${e.message}`);
  }
}

// Stream a `gh` subcommand's stdout to `dest`, with the SAME size cap semantics
// as release.download: enforced on the bytes actually seen, the child killed on
// overflow, and the partial file unlinked — so the two transports cannot differ
// on what "too big" means.
function streamToFile(args, dest, { maxBytes = 0 } = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    const out = fs.createWriteStream(part);
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let seen = 0;
    let settled = false;
    let stderr = '';
    // `pipe()` ends the destination when stdout ends, so the write stream can
    // already be CLOSED by the time the child's exit fires. Waiting for the two
    // independently — rather than attaching a close listener from inside the
    // exit handler — is what keeps this from hanging forever on the happy path.
    let fileClosed = false;
    let exitCode = null;

    const settle = (fn) => { if (settled) return; settled = true; fn(); };
    const abort = (err) => settle(() => {
      try { child.kill('SIGKILL'); } catch {}
      try { out.destroy(); } catch {}
      try { fs.unlinkSync(part); } catch {}
      reject(err);
    });
    const finish = () => {
      if (settled || !fileClosed || exitCode === null) return;
      if (exitCode !== 0) {
        return abort(fail(`gh ${args[0]} failed: ${stderr.trim() || `exit ${exitCode}`}`));
      }
      settle(() => {
        try {
          fs.renameSync(part, dest);
          resolve(dest);
        } catch (e) { reject(e); }
      });
    };

    child.on('error', (e) => abort(fail(`could not run \`gh\`: ${e.message}`)));
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.stdout.on('data', (chunk) => {
      if (!maxBytes) return;
      seen += chunk.length;
      if (seen <= maxBytes) return;
      abort(fail(`download exceeded ${maxBytes} bytes via gh — refusing`));
    });
    out.on('error', (e) => abort(e));
    child.stdout.pipe(out);

    out.on('close', () => { fileClosed = true; finish(); });
    child.on('close', (code) => { exitCode = code; finish(); });
  });
}

// The repository source archive for one commit, authenticated.
// `gh api repos/{slug}/tarball/{sha}` follows GitHub's redirect to codeload with
// the credential intact and writes the gzip to stdout.
function downloadTarball({ slug, sha, dest, hostname = 'github.com', maxBytes = 0 }) {
  return streamToFile(['api', `repos/${slug}/tarball/${sha}`, '--hostname', hostname], dest, { maxBytes });
}

// One named release asset, authenticated. `--output -` writes it to stdout, so
// this goes through the same capped stream as everything else rather than
// letting gh choose a filename on disk (a remote-supplied name must never
// decide a path — see safeAssetName in fetch.js).
function downloadAsset({ slug, tag, name, dest, hostname = 'github.com', maxBytes = 0 }) {
  return streamToFile(
    ['release', 'download', tag, '--repo', `${hostname}/${slug}`, '--pattern', name, '--output', '-'],
    dest,
    { maxBytes },
  );
}

module.exports = {
  available,
  resetAvailability,
  usableFor,
  hostFor,
  api,
  downloadTarball,
  downloadAsset,
  streamToFile,
  GITHUB_HOSTS,
};
