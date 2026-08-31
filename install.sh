#!/bin/sh
# claude-web-chat installer — https://github.com/Brynhild-CHale/claude-web-chat
#
# Downloads the latest GitHub Release, verifies its SHA-256 checksum, unpacks it
# into ~/.web-chat/versions/<version>/ and links the three commands into
# ~/.local/bin. No npm, no registry, no sudo — nothing outside your home
# directory is touched, and re-running this is always safe.
#
#   ~/.web-chat/versions/<version>/  the release, self-contained (deps included)
#   ~/.web-chat/current      ->      versions/<version>  (rollback = symlink swap)
#   ~/.local/bin/claude-web-chat -> ~/.web-chat/current/bin/claude-web-chat.js
#
# It does nothing but what you see here — read it before piping it to a shell.
set -eu

REPO="${WEB_CHAT_REPO:-Brynhild-CHale/claude-web-chat}"
API="${WEB_CHAT_API_BASE:-https://api.github.com/repos/$REPO}"
# $HOME is the only knob: the version store and the bin dir both hang off it, and
# so does the CLI's own idea of where it lives (lib/core/paths.js). Keeping it
# that way means the installer cannot put the program somewhere the program does
# not look for itself.
WC_HOME="$HOME/.web-chat"
BIN_DIR="$HOME/.local/bin"
KEEP_VERSIONS=3
BINS="claude-web-chat claude-web-chat-mcp claude-web-chat-hook"

die() { echo "$@" >&2; exit 1; }

TMP=""
cleanup() { if [ -n "$TMP" ]; then rm -rf "$TMP"; fi; }
trap cleanup EXIT INT TERM

# 1. Require Node 22+.
command -v node >/dev/null 2>&1 || die "claude-web-chat needs Node.js (22 or newer), which isn't installed.
Get it from https://nodejs.org/ and run this again."
node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 22 ]; then
  die "claude-web-chat needs Node 22 or newer — you have $(node -v).
Node 18 and 20 are both past end-of-life, and one of this program's dependencies
(entities, via node-html-parser) is now ESM-only: without require(esm), which
landed in Node 22, the daemon cannot even start.

Note that your distro's package may well be older than this: Ubuntu 24.04 ships
Node 18, Debian 12 ships 18, Debian 13 ships 20. So 'apt install nodejs' is
probably not the answer. Any of these are:

  nvm     curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
          then: nvm install 22
  fnm     curl -fsSL https://fnm.vercel.app/install | bash
          then: fnm install 22
  distro  NodeSource packages — https://github.com/nodesource/distributions

Then run this again."
fi

# 2. Pick a downloader and a checksum tool. Both are needed; say which is missing.
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
  fetch_stdout() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
  fetch_stdout() { wget -qO- "$1"; }
else
  die "claude-web-chat's installer needs curl or wget, and neither is installed.
Install one and run this again, or download the release by hand from
  https://github.com/$REPO/releases/latest"
fi

if command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
else
  die "claude-web-chat's installer needs shasum or sha256sum to verify the download,
and neither is installed. Install one and run this again."
fi

command -v tar >/dev/null 2>&1 || die "claude-web-chat's installer needs tar, which isn't installed."

# 3. Resolve the latest release. GitHub 404s a repo with no published release,
#    which curl -f turns into a non-zero exit; say so plainly rather than dying
#    on an empty parse.
echo "Looking up the latest release of $REPO..."
TMP=$(mktemp -d "${TMPDIR:-/tmp}/claude-web-chat.XXXXXX")
if ! fetch_stdout "$API/releases/latest" > "$TMP/release.json" 2>/dev/null; then
  die "No published release found for $REPO (or GitHub is unreachable).
If you are installing from a checkout, use it directly:
  git clone https://github.com/$REPO.git && cd claude-web-chat && npm install"
fi

# Minimal JSON scraping — one field and the asset URLs. Newline-per-token first
# so the patterns cannot span fields.
tag=$(tr ',' '\n' < "$TMP/release.json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
[ -n "$tag" ] || die "Could not read a release tag from GitHub's response. Try again shortly, or
download the release by hand from https://github.com/$REPO/releases/latest"
version=${tag#v}

urls=$(tr ',' '\n' < "$TMP/release.json" | sed -n 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
tar_url=$(printf '%s\n' "$urls" | grep -E '\.tar\.gz$' | head -n1 || true)
sums_url=$(printf '%s\n' "$urls" | grep -E '/SHA256SUMS$' | head -n1 || true)
[ -n "$tar_url" ] || die "Release $tag has no .tar.gz asset — nothing to install."
[ -n "$sums_url" ] || die "Release $tag has no SHA256SUMS asset. Refusing to install an unverified download."

tar_name=$(basename "$tar_url")

# 4. Download both, then VERIFY before anything is unpacked. Everything so far
#    has happened in $TMP: a download that dies halfway leaves the existing
#    install completely untouched.
echo "Downloading $tar_name ($tag)..."
fetch "$tar_url" "$TMP/$tar_name" || die "Download failed. Your existing install (if any) is untouched."
fetch "$sums_url" "$TMP/SHA256SUMS" || die "Could not download SHA256SUMS. Refusing to install an unverified download."

expected=$(sed -n "s|^\([0-9a-fA-F]\{64\}\)[[:space:]][[:space:]]*[*]\{0,1\}$tar_name\$|\1|p" "$TMP/SHA256SUMS" | head -n1)
[ -n "$expected" ] || die "SHA256SUMS has no entry for $tar_name. Refusing to install an unverified download."
actual=$(sha256 "$TMP/$tar_name")
if [ "$actual" != "$expected" ]; then
  die "Checksum mismatch for $tar_name.
  expected $expected
  actual   $actual
Refusing to install. Your existing install (if any) is untouched."
fi
echo "Checksum verified."

# 5. Unpack into a staging dir, then move it into versions/<version>. The move is
#    the only destructive step, and it happens after a complete, verified unpack.
mkdir -p "$WC_HOME/versions"
staging="$TMP/unpacked"
mkdir -p "$staging"
tar -xzf "$TMP/$tar_name" --strip-components 1 -C "$staging"
[ -f "$staging/package.json" ] || die "The downloaded archive does not look like a claude-web-chat release."

dest="$WC_HOME/versions/$version"
rm -rf "$dest.incoming"
# mv across filesystems ($TMPDIR vs $HOME) can fail; fall back to a copy.
if ! mv "$staging" "$dest.incoming" 2>/dev/null; then
  mkdir -p "$dest.incoming"
  (cd "$staging" && tar -cf - .) | (cd "$dest.incoming" && tar -xf -)
fi
rm -rf "$dest"
mv "$dest.incoming" "$dest"

# 6. Point `current` at it. `ln -sfn` replaces the link where it stands; both
#    GNU and BSD ln accept -n, and with it neither follows an existing symlink.
#
#    What must NOT be used here is `mv`: it stat()s its destination, so a
#    `current` that points at a version DIRECTORY looks like a directory to it,
#    and the new link is moved INSIDE the old version instead of over it. That
#    is what this installer did on every re-run until the line below replaced
#    the `mv`: the new release unpacked, `current` (and therefore all three
#    bins, which resolve through it) stayed on the old one, and the installer
#    reported success.
#
#    The target is relative, so the whole ~/.web-chat tree stays movable.
if [ -d "$WC_HOME/current" ] && [ ! -L "$WC_HOME/current" ]; then
  rm -rf "$WC_HOME/current"
fi
rm -f "$WC_HOME/current.incoming"   # debris from an interrupted older install
#    And the link the `mv` above used to deposit INSIDE the old version
#    directory. It dangles there forever on any install upgraded through the
#    broken installer, and — worse than untidy — writing it bumped that
#    directory's mtime, which is what step 8 sorts on, so an older version can
#    outlive a newer rollback target. The glob is unquoted so it expands; with
#    no match `rm -f` is silent about the literal.
rm -f "$WC_HOME/versions/"*/current.incoming 2>/dev/null || true
ln -sfn "versions/$version" "$WC_HOME/current"

# 7. Link the three bins into ~/.local/bin — no sudo. These may use the rename
#    swap, and do: they point at FILES, so mv renames over them rather than into
#    them, and the command never briefly does not exist.
mkdir -p "$BIN_DIR"
for b in $BINS; do
  chmod +x "$WC_HOME/current/bin/$b.js" 2>/dev/null || true
  rm -f "$BIN_DIR/$b.incoming"
  ln -s "$WC_HOME/current/bin/$b.js" "$BIN_DIR/$b.incoming"
  mv -f "$BIN_DIR/$b.incoming" "$BIN_DIR/$b"
done

# 8. Prune old versions, keeping the newest few so a rollback stays a symlink
#    swap (`claude-web-chat update --to <version>`).
keep_from=$((KEEP_VERSIONS + 1))
for old in $(ls -1t "$WC_HOME/versions" 2>/dev/null | tail -n +$keep_from); do
  if [ "$old" != "$version" ]; then
    rm -rf "$WC_HOME/versions/$old"
  fi
done

echo ""
echo "Installed claude-web-chat v$version"
echo "  program   $WC_HOME/versions/$version"
echo "  commands  $BIN_DIR/claude-web-chat (+ -mcp, -hook)"
echo ""

# 9. PATH. No sudo and no shell-file edits: if the bin dir isn't on PATH, print
#    the exact line to add and carry on.
case ":${PATH}:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "$BIN_DIR is not on your PATH. Add this to your shell profile"
    echo "(~/.zshrc, ~/.bashrc, or ~/.profile), then open a new terminal:"
    echo ""
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    echo ""
    echo "Until then, run it by full path: $BIN_DIR/claude-web-chat"
    echo ""
    ;;
esac

echo "To wire it into a project:"
echo ""
echo "  cd your-project"
echo "  claude-web-chat init"
echo ""
echo "init walks you through setup, shows you what it is about to write, and leaves"
echo "a short tour on the surface. In a project that already has web-chat it checks"
echo "and tidies the install instead. Later: \`claude-web-chat update\`."
