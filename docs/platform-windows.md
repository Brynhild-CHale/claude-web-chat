# Windows — findings, and a test plan for real hardware

**Status: not natively supported. WSL2 is the supported path, and this document
is the evidence for that decision — offered so it can be checked, not so it can
be taken on trust.**

Everything here was produced by **static analysis from a macOS machine**. Nobody
has ever run this program on Windows; CI has never had a Windows leg. So each
item below is a **hypothesis with a way to check it**, and the point of this
branch is for someone sitting at a real Windows box to confirm, overturn, or
extend it.

Claims are marked **[obs]** (observed — code read, or a probe actually run on
macOS) or **[inf]** (reasoned inference about Win32 that could not be executed
here). Treat every **[inf]** as unproven.

> **Read this first.** Four of the findings below are **not Windows problems**.
> They reproduce on macOS and Linux today. They are flagged inline as
> **CROSS-PLATFORM** and they belong on `main`, not on this branch. Do not let
> them get filed away as somebody else's platform.

---

## The provisional decision

**Native Windows is not worth building. WSL2 is the answer — but two bugs have
to be fixed before that sentence is actually true.**

The reasoning is a stack, where each layer only matters if the one beneath it is
solved:

| Layer | State |
| --- | --- |
| An installer | None. `install.sh` is POSIX `sh`; a search for `.ps1`/`.cmd`/`.bat` finds nothing **[obs]** |
| A registry to install *from* | None. `package.json` is `"private": true` — GitHub Releases only **[obs]** |
| Activation | `~/.web-chat/current` is a symlink (`lib/update/install-layout.js:138`); Win32 needs Developer Mode or elevation **[inf]** |
| PATH entry | Three extensionless shebang files. PATHEXT cannot launch them; they would need `.cmd`/`.ps1` shims **[inf]** |
| Building a release | Exec bits vanish on Windows, changing the SHA256 the whole distribution model rests on **[obs]** |
| Running the suite | Needs `/bin/sh`, `shasum`, `symlinkSync`, and asserts POSIX mode bits **[obs]** |

That is weeks of work plus a permanent third CI leg, for a platform whose users
are one `wsl --install` away from the supported path.

The decision is also already ratcheted: `test/distribution.test.js:92-98` fails
the build if `install.sh` grows a Windows branch, and asserts the README says
WSL2 **[obs]**. Several findings below are *evidence for* that line rather than
against it.

**What would overturn this:** a Windows user for whom WSL2 is genuinely
unavailable (locked-down corporate image, no virtualisation), *and* a willingness
to carry the CI leg. Absent that, the effort is better spent on the two WSL2
bugs.

---

## What must be fixed for "Windows means WSL2" to be true

These two are the whole gap between the claim and reality.

### 1. `claude-web-chat launch` crashes on any Linux without `xdg-open` — including stock WSL2

`lib/cli/commands/open.js:21-30`

```js
try {
  const child = spawn(cmd, [...args, url], { stdio: 'ignore', detached: true });
  child.unref();
} catch (e) {
  console.error(`(could not launch browser: ${e.message})`);
```

`spawn` detects ENOENT in libuv synchronously but **emits it via
`process.nextTick`**, so this `try/catch` is unreachable and the failure surfaces
as an unhandled `'error'` event. Reproduced on Node v24.18.0 **[obs]**:
`"past try/catch"` prints, then `Unhandled 'error' event … ENOENT`, exit 1. No
`uncaughtException` handler exists anywhere — `bin/claude-web-chat.js` is two
lines and `lib/cli/index.js:90-108` has no try/catch **[obs]**.

Because `nextTick` outranks promise continuations, `launch.js`'s `await open()`
continuation is **never reached — `claude` is never spawned at all** **[obs]**.
`init.js:298` dies at step 5 of first-run onboarding, so the user never sees the
step-9 "/exit and reopen Claude Code" instructions.

Severity splits: **fatal for `launch`**, **degraded for `open`** (the daemon is
already detached and the URL was printed at `open.js:74` before the crash, so the
surface does work — the cost is exit 1 and a stack trace where a one-line hint
was intended).

Native Win32 is **unaffected** — `open.js:17` returns `cmd /c start ""`, and
`cmd.exe` is always on `%PATH%`. This reaches Windows *only* through WSL2, which
is the one Windows path the project endorses.

**Verify on a real box**
```sh
# In WSL2, or any container/minimal image:
command -v xdg-open || echo "absent — this is the failing configuration"
claude-web-chat launch          # expect: unhandled ENOENT, exit 1, claude never starts
claude-web-chat open            # expect: URL printed, then a stack trace, exit 1
```

**Likely fix** (~3 lines): attach an `'error'` listener instead of relying on the
catch, keep the `try/catch` for genuine synchronous throws, and print the URL as
the fallback. Then add a test that calls the **real** `launchBrowser` against an
absent binary — `test/extensions.test.js:310` injects a stub, so the real
function currently runs on no platform in no CI job **[obs]**.

### 2. The documented WSL2 fallback does not work

When `localhostForwarding` breaks — and it does: after sleep/resume, after long
uptime until `wsl --shutdown`, if disabled in `.wslconfig`, or under mirrored
mode with the Hyper-V firewall — **every WSL guide says "browse the distro's IP
from `hostname -I`"**. That needs `WEB_CHAT_HOST=0.0.0.0`.

But the WS origin gate ignores the bind address (`lib/core/cors.js:47`), so the
page then loads and sits at **"reconnecting…" forever** **[inf]**. The
`embed-helper` DNR rule (`extensions/.../rules.json:15`,
`initiatorDomains: ["localhost","127.0.0.1"]`) silently stops matching too
**[obs]**. Nothing anywhere documents this.

**Verify**
```sh
# WSL2, with the relay deliberately bypassed:
WEB_CHAT_HOST=0.0.0.0 claude-web-chat start --daemon
hostname -I                      # note the VM IP
# From Windows Chrome: http://<vm-ip>:5173
# expect: page loads, status pill stuck at "reconnecting…"
```

**Likely fix:** have `isLocalOrigin` follow the bind decision rather than
hardcoding localhost — or, at minimum, make `warnIfExposed` say plainly that
`WEB_CHAT_HOST` is currently non-functional for the browser.

---

## What actually works under WSL2 (verified by reading, needs confirming)

Two things that were *expected* to be broken and are not:

- **A Windows browser reaches the daemon on the happy path, by design rather than
  luck.** The daemon binds `127.0.0.1` (`lib/core/cors.js:19`); under default NAT
  networking with `localhostForwarding=true`, WSL2's relay proxies Windows
  `localhost:P` into the VM and connects to the VM's **loopback** **[inf]**.
  Docker's "you must bind 0.0.0.0" rule does not apply. No firewall prompt,
  because a loopback bind never raises one **[inf]**.
- **The Chrome extension's capture path crosses the boundary.** It posts to
  `http://localhost:5170` (`extensions/tab-stream/background.js:10`), riding the
  same relay to the hub. `lib/hub/index.js:71-97` mounts `setCors` plus explicit
  preflight handlers, and `setCors` (`cors.js:132`) reflects
  `isExtensionOrigin(origin)` unconditionally, so the `chrome-extension://`
  origin is allowed regardless of the hub's address **[obs]**. The endpoint is
  also a stored user option (`extensions/tab-stream/options.js:1`), not a code
  edit.

**Verify both**
```
1. wsl --shutdown, then reopen WSL2 (a clean relay)
2. claude-web-chat open       → does the surface load in Windows Chrome?
3. Load extensions/tab-stream unpacked in Windows Chrome
4. Capture a page             → does it appear in the surface's queue rail?
```

---

## Other Windows-native findings

Recorded for completeness. **Do not treat these as a backlog** — they are
evidence for the "not worth it" verdict, not a to-do list. Severity is as
assessed after adversarial review.

| # | Finding | Where | Note |
| --- | --- | --- | --- |
| 4 | The port walk only retries on `EADDRINUSE`; `EACCES` kills the daemon outright | `lib/server/index.js:307`, `lib/hub/index.js:148` | Cross-platform, but Windows raises `EACCES` far more often (reserved port ranges, Hyper-V) **[inf]** |
| 5 | The port walk is blind to a Windows-side port squatter | `lib/server/index.js:336-345` | WSL2-specific; no `--port` escape hatch exists |
| 6 | `doctor`'s hook-command regex rejects Windows paths **and truncates any path containing a space** | `lib/cli/commands/doctor.js:71` | **CROSS-PLATFORM** — the space bug fires on macOS now |
| 7 | A recycled PID gets signalled — `isPidAlive` answers "does a process exist", not "is it ours" | `lib/cli/commands/stop.js:92`, `ls.js:79` | **CROSS-PLATFORM**; add `root` to `/api/health` and gate on identity |
| 8 | `WEB_CHAT_HOST` is documented but the WS origin gate ignores it | `lib/core/cors.js:47` | See §2 above |
| 9 | The instance registry keys projects by raw path string, so `ls --reap`'s self-protection can miss | `lib/util/registry.js` | **CROSS-PLATFORM**; same root cause as the `samePath` issue |

### The extension install instructions are unfollowable under WSL2

`lib/server/routes/extensions.js:167` prints a `/home/you/...` path to a browser
running on Windows, where Chrome's folder picker reads it as `C:\home\you\...`
**[inf]**. The zip download offered on the next line is the working route — it
should lead.

---

## CROSS-PLATFORM findings that surfaced here

**These belong on `main`.** They were found while looking at Windows, but they
are live on macOS and Linux right now.

### `findProjectRoot`'s `$HOME` guard is a lexical compare and fails open

`lib/core/paths.js:47-62`. `dir` comes from `process.cwd()` via
`path.resolve`/`path.dirname`; `home` from `path.resolve(os.homedir())`. Neither
side is realpathed or case-folded.

**Reproduced on macOS [obs]**, two ways: with `HOME` set to a symlink, and with
`HOME` spelled in a different case on case-insensitive APFS. In both, a fresh
directory under `$HOME` resolves to `$HOME` instead of `null` — so
`claude-web-chat init` takes the *existing-install* branch (`init.js:615-617`),
**skips the first-run consent gate** (`init.js:243`), and configures the machine:
hooks in `~/.claude/settings.json` firing in every project, a `~/.mcp.json`, and
a daemon rooted at the home directory.

POSIX `getcwd` returns the *physical* path while `os.homedir()` returns `$HOME`
verbatim, so symlinked or automounted homes hit this on both supported platforms.
The safety net fails with it — `homeMarkerCollision` is the same lexical compare,
duplicated at `init.js:107-109` and `doctor.js:23-25`.

The existing test cannot catch it: `test-support/helpers.js:39-46` sets `HOME` to
the same `mkdtemp` string the test builds its paths from.

**Fix:** one `samePath(a, b)` in `lib/core/paths.js` — realpath both sides where
they exist, fall back to `path.resolve`, compare. Normalise for the *comparison
only*; `init.js:413` and `:608` compare resolved roots, so realpathing the return
value would change semantics. Back both `homeMarkerCollision` copies with it, and
add a test whose `HOME` spelling differs from the tree it builds.

### `ls --reap` is signal-only and discards other projects' uncommitted state

`lib/cli/commands/ls.js:79` sends `SIGTERM` with no HTTP ask — unlike
`stop.js:34-49`, which POSTs `/api/shutdown` first. `writeDraft` has exactly one
call site (`lib/server/index.js:153`, inside `gracefulShutdown`) and there is no
periodic flush **[obs]**, so everything uncommitted — mounts, store, comments,
captures, queue — is lost for every project reaped.

**Fix:** route `--reap` through the same `stop()` engine, which also removes the
second copy of the shutdown logic.

### The theme name regex admits case-fold collisions

`lib/server/routes/theme.js:10` — `/^[\w][\w .-]{0,63}$/` accepts uppercase.
**Reproduced on this Mac [obs]:** `save_theme 'Ocean'` then `'ocean'` overwrite
each other on case-insensitive APFS, leaving one dirent whose *body* says `ocean`
while `list()` reports the body's name — so the listing and the on-disk identity
disagree. Windows behaves identically; only case-sensitive Linux differs.

---

## The security question — answered

**No bypass.** A pack shipping `Git-Dashboard` or `GIT-DASHBOARD` is refused on
every platform, including case-insensitive ones.

`lib/packs/manifest.js:34` — `const NAME_RE = /^[a-z][a-z0-9-]*$/;` — is anchored,
has no `i` flag, and `[a-z]` is literal ASCII lowercase, so `G` (0x47) fails on
the first character. `validateManifest` runs the regex **first** and `continue`s
(`manifest.js:177-181`), so an uppercase name never reaches the `BUILTINS`
compare at all. Probed against the real exports **[obs]**:

```
"git-dashboard"   NAME_RE=true   reserved=true   → refused as built-in
"Git-Dashboard"   NAME_RE=false  reserved=false  → refused as not-kebab-case
"GIT-DASHBOARD"   NAME_RE=false  reserved=false  → refused as not-kebab-case
```

Traversal is blocked independently: `memberEscapes` (`lib/packs/fetch.js:79-83`)
normalises backslashes *before* splitting, then rejects `..` segments, a leading
`/`, and `/^[A-Za-z]:/` — so `..\..\x`, UNC `\\srv\share\x`, drive-relative `\x`
and `C:foo` are all refused **[obs]**.

**But the guard is load-bearing on the charset, not on the check that is
*documented* as the guard.** The comment at `builtins.js:5-13` explains that a
shadowing copy would win permanently because `seedBuiltins` only refreshes a
directory marked `builtin: true`. If anyone ever loosens `NAME_RE` to accept
uppercase, that protection stops holding on NTFS **and** APFS simultaneously.
Cheap hardening: make the reserved compare case-insensitive, matching the
precedent already set for themes at `lib/server/theme.js:12-18`.

### A real gap: Windows reserved device names

`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9` are all lowercase ASCII
and sail through `NAME_RE` **[obs]**. There is no platform guard anywhere in
`lib/packs/` **[obs]**. On Win32 these are devices in *every* directory **[inf]**.

The consequence is a **failed install, not an escape** — `bsdtar` cannot create
`components\nul\component.html`, so extraction fails into a temp stage dir before
`applyPlan`, and `validateManifest:186`'s `existsSync` is a second gate.

The theme path is looser and fails **silently**: `resources.js:97-102` writes
straight through to `path.join(dir, 'con.json')`, and `:94-96` explicitly says
"The caller owns name validation + reserved-name policy" — which the caller never
implements. On Windows that write is routed to the console device: `{ok:true}`,
nothing on disk, absent from `list_themes`, later a 404 from `apply_theme`
**[inf]**.

**One escalation that needs a Windows box:** does `fs.existsSync` on a device path
return true? Both theme read paths are guarded by `existsSync` inside `readTheme`
(`lib/server/theme.js:41-49`). If **true**, and the daemon has a console
attached, `readFileSync('CON')` would block on keyboard input and **hang the
daemon** — that would be fatal. If **false** (the expectation for a detached
daemon), it stays a harmless 404.

**Verify**
```js
// On Windows, in the repo:
node -e "console.log('existsSync CON =', require('fs').existsSync('CON'))"
node -e "console.log('existsSync nul.json =', require('fs').existsSync('nul.json'))"
```

**Fix (small, platform-independent):**
`const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;` beside each
`NAME_RE` — rejected at `theme.js:118`/`:149`, `components.js:18`, and
`manifest.js:249`. Refuse on **every** platform: a pack that installs on Linux
and cannot install on Windows is worse for the ecosystem than one refused
everywhere.

---

## Test plan for a real Windows machine

Work through this in order. Record the actual result next to each line.

### A. Confirm the native verdict (expected: blocked at step 1)

- [ ] `curl -fsSL .../install.sh | sh` in PowerShell → expect: no `sh`
- [ ] Same in Git Bash → expect: proceeds further; note where it first fails
- [ ] `node -e "require('fs').symlinkSync('a','b')"` without Developer Mode → expect `EPERM`
- [ ] Same **with** Developer Mode on → does it succeed? This decides whether the
      versions/current design is salvageable at all
- [ ] `tar --version` → is it bsdtar? Does `-xzf --strip-components 1 -C` work?
- [ ] `npm test` from a clone → how many of the 926 fail, and what are the top 3 causes?

### B. Confirm the WSL2 path (expected: works after the two fixes)

- [ ] `wsl --install`, then in the distro: `command -v xdg-open`
- [ ] `curl -fsSL .../install.sh | sh` → does it complete?
- [ ] `claude-web-chat init` in a project on the **Linux** filesystem (not `/mnt/c`)
- [ ] `claude-web-chat open` → does the surface load in **Windows** Chrome?
- [ ] Render something from Claude → does it appear?
- [ ] Load `extensions/tab-stream` in Windows Chrome; capture a page → queue rail?
- [ ] `claude-web-chat pack get <url>` → does a private pack fetch via `gh`?
- [ ] Spawn a service component → does `claude-web-chat trust --all` work?
- [ ] Sleep the machine, resume, retry step 4 → does the relay survive?
- [ ] `WEB_CHAT_HOST=0.0.0.0` + browse the VM IP → confirm the "reconnecting…" hang

### C. Confirm the security items

- [ ] `existsSync('CON')` (above) — the one that could hang a daemon
- [ ] A pack shipping a component named `nul` → expect a clean refusal or a clean
      extraction failure, never a half-install
- [ ] A pack shipping `Git-Dashboard` → expect refused as not-kebab-case

---

## Open questions

Genuinely undecidable without hardware:

1. Does `fs.existsSync` return `true` for a Windows device path? (Decides whether
   the theme gap is cosmetic or fatal.)
2. Does stock Ubuntu-on-WSL ship `xdg-utils` transitively via `wslu`? Settle with
   `command -v xdg-open` on a fresh import.
3. How does Claude Code execute a hook command on Windows — `cmd.exe` or `sh`?
   That decides whether `node "C:\Users\...\hook.js" turn-begin` survives, and
   whether emitting forward slashes is sufficient.
4. Does `%LOCALAPPDATA%\Microsoft\WindowsApps` (or similar) make a viable PATH
   target if native support is ever revisited?
