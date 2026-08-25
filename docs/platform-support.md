# Platform support

| Platform | Status | Verified by |
| --- | --- | --- |
| **macOS** (Apple silicon + Intel) | **Supported** | Developed on it; the full suite runs on `macos-latest` in CI on every push |
| **Linux** (Ubuntu/Debian family) | **Supported, with gaps in what CI can prove** | Full suite runs on `ubuntu-latest` in CI on every push — but CI is a headless container. See [`platform-linux.md`](platform-linux.md) on the `platform/linux` branch |
| **Windows** | **Via WSL2 only. No native support.** | Never run on Windows by anyone. See [`platform-windows.md`](platform-windows.md) on the `platform/windows` branch |

**Node 22 or newer**, on every platform. That floor is not a preference: one of
the four runtime dependencies (`node-html-parser`) requires an `entities` that is
ESM-only, and `require(esm)` landed in Node 22. Below it the daemon does not
start at all.

**Your distro's Node is probably too old.** Verified by running each image:

| | `apt` candidate `nodejs` | Meets the floor |
| --- | --- | --- |
| Ubuntu 24.04 LTS | 18.19.1 | no |
| Debian 12 | 18.20.4 | no |
| Debian 13 | 20.19.2 | no |
| Alpine 3.21+ | 22.x | yes |
| Fedora 42+ | 22+ | yes |

So `apt install nodejs` is not the route on the Debian family — use `nvm`, `fnm`,
or NodeSource. `install.sh` refuses with those three options named, rather than
sending you to nodejs.org for a tarball. Lowering the floor would not have
helped much: `>=20.19` would have admitted Debian 13 and nothing else.

---

## What "supported" means here

It means the platform is exercised by the full test suite on every push, and the
maintainer runs it daily. It does **not** mean bug-free — see *Known issues that
affect every platform* below, which is the honest part of this page.

## What "supported, with gaps" means for Linux

CI runs the whole suite on `ubuntu-latest` and it passes. That proves a great
deal about the daemon, the graph, the pack pipeline and the CLI.

It proves **nothing** about anything needing a desktop, because CI is a headless
container with no browser, no display server, no login shell and no `systemd`
session. Structurally uncovered: opening the surface, the Chrome extension and
the whole capture path, `install.sh` itself (CI never runs it), and every distro
that is not Ubuntu — notably Alpine, which is musl and BusyBox rather than glibc
and GNU.

The `platform/linux` branch carries a findings document and a test plan for
someone with real hardware.

## Why Windows is WSL2

There is no installer (`install.sh` is POSIX `sh`), no registry to install from
(`package.json` is `"private": true` — GitHub Releases only), the version layout
pivots on symlinks that need Developer Mode or elevation on Win32, and the three
PATH entries are extensionless shebang files that PATHEXT cannot launch. Each of
those is a prerequisite for the next mattering, so it is not one project but a
stack of them — plus a permanent third CI leg — for users who are one
`wsl --install` from the supported path.

`test/distribution.test.js` fails the build if `install.sh` grows a Windows
branch, so this is a ratcheted decision rather than an oversight.

Under WSL2 the surface loads in a Windows browser and the capture extension works
across the boundary, both by design rather than luck. The `platform/windows`
branch documents the two bugs that stand between that claim and reality, and how
to check them.

---

## Known issues that affect every platform

Surfaced by the Windows and Linux assessments. **These are not platform
problems** — they are live on macOS today, and they are listed here rather than
filed on a platform branch precisely so they do not get mistaken for someone
else's.

- **`findProjectRoot`'s `$HOME` guard is a lexical compare and can fail open.**
  `lib/core/paths.js`. Reproduced on macOS with `HOME` set to a symlink, and with
  a case-differing spelling on case-insensitive APFS: a fresh directory under
  `$HOME` resolves to `$HOME`, so `init` takes the existing-install branch, skips
  the first-run consent gate, and configures the whole machine. Needs a
  `samePath()` that realpaths both sides.
- **`ls --reap` is signal-only.** `lib/cli/commands/ls.js`. It `SIGTERM`s other
  projects' daemons without the `/api/shutdown` ask that `stop` makes, and
  `writeDraft` only runs inside `gracefulShutdown` — so every reaped project
  loses its uncommitted surface state.
- **PID liveness is not identity.** `stop.js` and `ls.js` ask "does a process with
  this pid exist", not "is it ours", so a recycled pid can be signalled. Wants
  `root` on `/api/health` and a gate on that.
- **`doctor`'s hook-command regex truncates any path containing a space.**
  `lib/cli/commands/doctor.js`.
- **The theme name regex admits case-fold collisions.**
  `lib/server/routes/theme.js` accepts uppercase, so `Ocean` and `ocean` overwrite
  each other on any case-insensitive filesystem — reproduced on macOS — leaving
  the listing and the on-disk identity disagreeing.
- **Windows-reserved device names pass the name gates.** `con`, `nul`, `com1` and
  friends are valid kebab-case, so a pack or theme can be named after one. Worth
  refusing on *every* platform: a pack that installs on Linux and cannot install
  on Windows is worse for the ecosystem than one refused everywhere.

## Reporting a platform problem

If you are on Linux or Windows, start from the findings document on the matching
branch — it is written as a test plan, and confirming or overturning an existing
hypothesis is more useful than a fresh report. Both documents mark every claim
**[obs]** (observed) or **[inf]** (inferred without hardware); the **[inf]** ones
are exactly where help is most valuable.
