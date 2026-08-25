// Getting a pack onto this machine, verified, before anything is decided about
// it.
//
// Two ways in, converging fast:
//
//   release  — a published release carrying SHA256SUMS. The tarball's digest is
//              checked against the sums file BEFORE a byte is unpacked, exactly
//              the way the program's own updater verifies itself.
//   archive  — the repository tarball for one resolved commit sha.
//
// They differ only in "how do I get a verified tarball". From stagePack onward
// there is one code path, and both record `source.sha`, so provenance has one
// shape whichever route was taken.
//
// A release with NO SHA256SUMS falls back to the sha-pinned archive rather than
// installing an unverified asset. An asset can be deleted and re-uploaded under
// the same tag; a commit sha cannot be re-pointed. The weaker-looking option is
// the stronger pin.
//
// ── `tar` is not the security boundary; the copier is. ──────────────────────
// Members are LISTED before extraction and refused on our terms (absolute path,
// any `..` segment, anything that is not a regular file or a directory) rather
// than on whichever behaviour the local tar happens to have — BSD tar errors on
// a `..` member, GNU tar has historically stripped it and carried on, and
// "refused" versus "silently renamed" is precisely the distinction that matters
// here. After extraction the staged tree is walked again: every member must
// still be a regular file or directory and must realpath INSIDE the stage, and
// modes are normalized to 0644/0755. Only files that survive both passes are
// ever copied anywhere.

const fs = require('fs');
const os = require('os');
const path = require('path');
const release = require('../update/release');
const { extractTarGz, rootOf, listTarGz } = require('../update/archive');
const { isInside } = require('../update/install-layout');
const { parseSource, archiveUrl, resolveCommit, findRelease, pickPackAsset } = require('./source');
const gh = require('./gh');

// A pack is components, a SKILL.md and maybe a theme or two. 64 MB is already
// wildly generous; the cap exists so a URL the user pasted cannot fill the disk.
const MAX_PACK_BYTES = 64 * 1024 * 1024;

function refuse(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  return e;
}

// ── the two transports ──────────────────────────────────────────────────────
// `gh` when it is authenticated and the host is really GitHub (the only way to
// reach a PRIVATE pack repository), plain HTTP otherwise. Both enforce the same
// byte cap, both write to the same place, and both hand back a file — so the
// flow below does not branch on which one ran.

function fetchAsset({ src, ghHost, rel, asset, dest, maxBytes }) {
  if (ghHost) {
    return gh.downloadAsset({ slug: src.slug, tag: rel.tag, name: asset.name, dest, hostname: ghHost, maxBytes });
  }
  return release.download(asset.url, dest, { maxBytes });
}

function fetchArchive({ src, ghHost, sha, dest, maxBytes }) {
  if (ghHost) {
    return gh.downloadTarball({ slug: src.slug, sha, dest, hostname: ghHost, maxBytes });
  }
  return release.download(archiveUrl(src, sha), dest, { maxBytes });
}

// A remote-supplied asset name, reduced to something that can only ever be a
// file inside the directory we choose. Never trusted as a path.
function safeAssetName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  if (!base || base === '.' || base === '..' || base.includes('/')) return 'pack.tar.gz';
  return base;
}

// Would this member escape the directory it is extracted into?
function memberEscapes(name) {
  const n = String(name || '').replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[A-Za-z]:/.test(n)) return true;
  return n.split('/').some((seg) => seg === '..');
}

// The pre-extraction gate. Refuses on our terms, with a message that names the
// member, so "this pack is refused" is never a mystery.
function assertSafeMembers(tarball) {
  let members;
  try { members = listTarGz(tarball); } catch (e) {
    throw refuse(`could not read the pack archive: ${e.message}`);
  }
  if (!members.length) throw refuse('the pack archive is empty');
  for (const m of members) {
    if (memberEscapes(m.name)) {
      throw refuse(`refusing this pack: the archive contains a member that escapes its own directory (${m.name})`);
    }
    if (m.type === 'link') {
      throw refuse(`refusing this pack: the archive contains a symlink or hard link (${m.name}). A pack is plain files.`);
    }
    if (m.type !== 'file' && m.type !== 'dir') {
      throw refuse(`refusing this pack: the archive contains something that is neither a file nor a directory (${m.name})`);
    }
  }
  return members;
}

// The post-extraction gate. Walks the staged tree, refuses anything that is not
// a regular file or directory (lstat, so a symlink is seen as a symlink and not
// followed), asserts every entry realpaths inside the stage, and normalizes
// modes. Returns the relative paths of every regular file, sorted.
function verifyTree(stage) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw refuse(`refusing this pack: ${path.relative(stage, abs)} is a symlink. A pack is plain files.`);
      }
      if (!entry.isDirectory() && !entry.isFile()) {
        throw refuse(`refusing this pack: ${path.relative(stage, abs)} is not a regular file or directory.`);
      }
      if (!isInside(stage, abs)) {
        throw refuse(`refusing this pack: ${path.relative(stage, abs)} resolves outside the staging directory.`);
      }
      if (entry.isDirectory()) {
        try { fs.chmodSync(abs, 0o755); } catch {}
        walk(abs);
      } else {
        try { fs.chmodSync(abs, 0o644); } catch {}
        files.push(path.relative(stage, abs).split(path.sep).join('/'));
      }
    }
  };
  walk(stage);
  if (!files.length) throw refuse('the pack archive contains no files');
  return files.sort();
}

// Download → list → extract → verify. `work` is the caller-owned temp dir; the
// tarball lands in work/dl and the tree in work/x, so anything that DID escape
// the extraction target lands in work/ where the escape check below sees it.
function stagePack(tarPath, work) {
  assertSafeMembers(tarPath);
  const target = path.join(work, 'x');
  extractTarGz(tarPath, target);
  // Belt and braces: nothing may have appeared in work/ other than the two
  // directories we made. If it did, a member escaped the extraction target and
  // the archive is refused whatever the listing said.
  const stray = fs.readdirSync(work).filter((n) => n !== 'dl' && n !== 'x');
  if (stray.length) {
    throw refuse(`refusing this pack: extracting it wrote outside its own directory (${stray.join(', ')})`);
  }
  const stage = rootOf(target);
  const files = verifyTree(stage);
  return { stage, files };
}

// The one entry point. Returns everything the rest of the pipeline needs to
// describe where this tree came from — plus `cleanup`, which the caller MUST
// call (the staged tree lives in a temp dir until it is installed or promoted
// into quarantine).
//
//   { stageDir, files, sha, via, sumsVerified, source, tarballSha256, cleanup }
//
// `tarballSha256` is recorded as an observed fact and is never compared against
// anything: GitHub archive tarballs are not byte-stable, so treating it as an
// integrity anchor would produce false alarms. The sha IS the anchor.
async function fetchPack({ url, ref = null, asset = null, tmpDir, log = () => {}, maxBytes = MAX_PACK_BYTES } = {}) {
  const src = parseSource(url);
  const wantRef = ref || src.ref || null;
  // Decided ONCE, here, so every request in this fetch uses one transport and
  // one identity. null means "plain HTTP" — gh absent, logged out, disabled, or
  // (deliberately) a host that is not GitHub.
  const ghHost = gh.hostFor(src);
  const work = fs.mkdtempSync(path.join(tmpDir || os.tmpdir(), 'wc-pack-'));
  const cleanup = () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} };
  fs.mkdirSync(path.join(work, 'dl'), { recursive: true });

  try {
    const rel = await findRelease(src, wantRef);
    const picked = rel ? pickPackAsset(rel, asset) : null;

    if (rel && picked && picked.tarball && picked.sums) {
      log(`  release ${rel.tag} — downloading ${picked.tarball.name}${ghHost ? ' (via gh)' : ''}…`);
      // The asset name is remote input. parseSource accepts any GitHub-API-shaped
      // host, so a hostile server can answer /releases/latest with
      // {"name": "../../../../.zshrc"} — and this path is where the body gets
      // written. basename() plus a guard, so the download cannot leave `work`,
      // which the whole stage-then-verify design assumes it never does.
      const assetFile = safeAssetName(picked.tarball.name);
      const tarPath = path.join(work, 'dl', assetFile);
      await fetchAsset({ src, ghHost, rel, asset: picked.tarball, dest: tarPath, maxBytes });

      // SHA256SUMS comes down the SAME transport — a private repo's sums file is
      // no more publicly readable than its tarball, and fetching the two
      // different ways is how you end up verifying one release against another's
      // checksums.
      const sumsPath = path.join(work, 'dl', 'SHA256SUMS');
      try {
        await fetchAsset({ src, ghHost, rel, asset: picked.sums, dest: sumsPath, maxBytes });
      } catch (e) {
        throw refuse(`could not fetch SHA256SUMS for ${rel.tag}: ${e.message}`);
      }
      // NB: the checksum is looked up by the asset's DECLARED name (that is what
      // SHA256SUMS lists), while the file lives under the sanitized one.
      const digest = release.verifyChecksum({
        file: tarPath, name: picked.tarball.name, sumsText: fs.readFileSync(sumsPath, 'utf8'),
      });
      log(`  checksum ok (sha256 ${digest.slice(0, 12)}…)`);
      // Even on the release path the provenance anchor is the commit the tag
      // points at, so both routes record the same shape.
      const sha = await resolveCommit(src, rel.tag);
      const { stage, files } = stagePack(tarPath, work);
      return {
        stageDir: stage, files, sha, via: 'release', sumsVerified: true, cleanup,
        tarballSha256: release.sha256File(tarPath),
        source: { url: src.webUrl, ref: rel.tag, sha, via: 'release', sums_verified: true, asset: picked.tarball.name, transport: ghHost ? 'gh' : 'https' },
      };
    }

    if (rel && picked && picked.tarball && !picked.sums) {
      log(`  release ${rel.tag} publishes no SHA256SUMS — falling back to the commit-pinned source archive`);
    } else if (rel && picked && !picked.tarball && picked.candidates.length > 1) {
      log(`  release ${rel.tag} has ${picked.candidates.length} tarballs and no --asset — using the commit-pinned source archive`);
    }

    const sha = await resolveCommit(src, wantRef);
    log(`  ${src.owner}/${src.repo} @ ${sha.slice(0, 7)} — downloading source archive${ghHost ? ' (via gh)' : ''}…`);
    const tarPath = path.join(work, 'dl', `${src.repo}-${sha.slice(0, 12)}.tar.gz`);
    await fetchArchive({ src, ghHost, sha, dest: tarPath, maxBytes });
    const { stage, files } = stagePack(tarPath, work);
    return {
      stageDir: stage, files, sha, via: 'archive', sumsVerified: false, cleanup,
      tarballSha256: release.sha256File(tarPath),
      source: { url: src.webUrl, ref: wantRef || 'HEAD', sha, via: 'archive', sums_verified: false, asset: null, transport: ghHost ? 'gh' : 'https' },
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

module.exports = { fetchPack, stagePack, verifyTree, assertSafeMembers, memberEscapes, safeAssetName, fetchAsset, fetchArchive, MAX_PACK_BYTES };
